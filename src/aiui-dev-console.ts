/**
 * AIUI Dev Console — a publishable host plugin for the DeepSeek Harness.
 *
 * Provides, ONLY while the session's agent preset label matches `presetLabel`:
 *   1. bottom-left launcher + draggable preview window (a live `aix preview
 *      --dev` server — watches the project and hot-reloads over WebSocket);
 *   2. right-side project file tree + source viewer — the injected browser
 *      script fetches the project, its tree and file contents from host
 *      routes below, so "点击文件查看源码" works without any client bundle.
 *
 * Presence gate: the script watches the session header actions slot
 * (`conversation.session.header.actions`), where ui-agent-preset renders the
 * session's preset label; only when it equals the configured `presetLabel`
 * (default "AIUI 开发模式") is any UI shown.
 *
 * Every `/api/aiui-*` route passes the composition's `connection` trust fence
 * first (`requestRejection`): the Host/Origin check defeats DNS rebinding and
 * the login-token cookie gates each caller, so a random page in the operator's
 * browser can neither read project files nor spawn the preview server.
 *
 * The browser half lives in `client/injected.js` (ordinary JavaScript, read
 * once at activation and injected into the index tap), not in a host-side
 * template literal.
 *
 * Configuration (the bundle row's `config`): `workspaceRoot` (directory to
 * scan for AIUI projects), `projectFile` (where the chosen project marker is
 * stored), `aixCli` (override the resolved @yodaos-pkg/aix-cli path), `aixCwd`
 * (spawn cwd for the dev server), `scanDepth`, `previewStartTimeoutMs`, and
 * `legacyPresetSync`. All optional; defaults derive from the invoking
 * directory.
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, basename, dirname, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

const require = createRequire(import.meta.url)

export const name = 'aiui-dev-console'

export const inject = ['webServer', 'subprocess', 'connection']

/* ── bundled agent preset (legacy, opt-in) ──────────────────────────────── */

/**
 * The Harness home: `$DSH_HOME` when set (non-blank), else `~/.dsh`.
 *
 * Mirrors `@deepseek-ai/dsh-home-paths#resolveDshHome()` (same precedence, same
 * blank-value rule) without importing a harness-internal package, so the plugin
 * resolves the home identically to the running dsh process.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

/** The root where the `agent-presets` service discovers user-authored presets. */
export function userPresetDir(): string {
  return join(resolveDshHome(), '.agent-presets')
}

/** The bundled preset directory shipped inside this package (`<pkg>/preset`). */
export function bundledPresetDir(): string {
  return fileURLToPath(new URL('../preset/', import.meta.url))
}

/** Marker file naming the bundle version that last installed the preset. */
const PRESET_MARKER = '.dsh-bundle-version'

/** Recursively copy files that are missing or differ; never deletes extra files. */
async function copyTree(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true })
  let copied = 0
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(src, entry.name)
    const target = join(dest, entry.name)
    if (entry.isDirectory()) {
      copied += await copyTree(source, target)
    } else if (entry.isFile()) {
      const [sourceBuf, targetBuf] = await Promise.all([
        readFile(source),
        readFile(target).catch(() => null),
      ])
      if (targetBuf === null || !sourceBuf.equals(targetBuf)) {
        await writeFile(target, sourceBuf)
        copied += 1
      }
    }
  }
  return copied
}

/** Result of {@link syncBundledPreset}. */
export interface PresetSyncResult {
  /** The user-root directory the preset lives in. */
  dir: string
  /** Whether files were (re)written this call. */
  installed: boolean
  /** Number of files written. */
  copied: number
  /** Set when the sync failed; the plugin logs it and carries on. */
  error?: string
}

/**
 * Install the bundled `aiui-dev` preset into the **legacy** user preset root
 * (`$DSH_HOME/.agent-presets/aiui-dev`, the `preset.yml` + `agent.cordis.yml`
 * directory format).
 *
 * The current Harness no longer reads that directory: agent presets are
 * declaration rows carried by a bundle patch, which is what the sibling
 * `dsh-aiui-preset` bundle provides. This sync therefore stays available only
 * behind `legacyPresetSync: true`, for an older Harness that still scans the
 * user root. It never rejects: an unreadable/unwritable home degrades to a log
 * line, not a failed boot.
 */
export async function syncBundledPreset(version: string): Promise<PresetSyncResult> {
  const dir = join(userPresetDir(), 'aiui-dev')
  try {
    const markerPath = join(dir, PRESET_MARKER)
    let marker: string | null = null
    try {
      marker = (await readFile(markerPath, 'utf-8')).trim()
    } catch {
      /* absent marker: first install or pre-0.2.0 manual copy */
    }
    if (marker === version) return { dir, installed: false, copied: 0 }
    const copied = await copyTree(bundledPresetDir(), dir)
    await writeFile(markerPath, version + '\n', 'utf-8')
    return { dir, installed: true, copied }
  } catch (error) {
    return { dir, installed: false, copied: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ── host-side project/file serving ─────────────────────────────────────── */

const MAX_FILE_BYTES = 1048576 // 1 MiB
const MAX_TREE_ITEMS = 3000
const MAX_TREE_DEPTH = 6
/** Directories visited by one project scan (bounds a cold recursive sweep). */
const MAX_SCAN_DIRS = 400
/** After a failed start, do not respawn the preview server before this delay. */
const RETRY_COOLDOWN_MS = 30000
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'lib', '.dsh', '.agent-presets', 'sessions',
  'storages', 'profiles', 'aiui-preview', 'aix-tool', 'scratch-plugin', '.cache',
  '.next', 'out', 'build', 'coverage',
])
const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json(res: ServerResponse, value: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** Wrap a route handler so a crash answers JSON with the real error instead of a bare 400. */
function safeHandler(handler: RouteHandler): RouteHandler {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) { res.end(); return }
      json(res, { ok: false, error: messageOf(error), stack: error instanceof Error ? error.stack : undefined })
    }
  }
}

/** The browser trust fence owned by the composition's `connection` service. */
interface ConnectionLike {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The `connection` service, typed locally so this package needs no client dependency. */
function connectionOf(ctx: Context): ConnectionLike | undefined {
  try {
    return Reflect.get(ctx, 'connection') as ConnectionLike | undefined
  } catch {
    return undefined
  }
}

/**
 * One API route: method check, then the connection trust fence, then the body.
 * Order matters — an unauthenticated caller must not reach a handler that
 * reads the project tree, writes the marker, or spawns a process.
 */
function apiRoute(
  method: 'GET' | 'POST',
  connection: ConnectionLike | undefined,
  handler: RouteHandler,
): RouteHandler {
  return safeHandler(async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== method) {
      res.statusCode = 405
      res.setHeader('Allow', method)
      json(res, { ok: false, error: `method not allowed; use ${method}` })
      return
    }
    if (connection !== undefined) {
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        res.statusCode = rejection
        json(res, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
    }
    await handler(req, res)
  })
}

/** Resolve the @yodaos-pkg/aix-cli entry (dist/cli.js) from this package's own dependencies. */
function resolveAixCli(): string | null {
  try {
    return require.resolve('@yodaos-pkg/aix-cli')
  } catch {
    return null
  }
}

async function readProjectInfo(projectFile: string): Promise<{ name: string; path: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(projectFile, 'utf-8'))
    if (parsed && typeof parsed.path === 'string') return { name: String(parsed.name || basename(parsed.path)), path: parsed.path }
    return null
  } catch {
    return null
  }
}

interface TreeNode { name: string; path: string; type: 'dir' | 'file' }
type TreeEntry = TreeNode & { children?: TreeEntry[] }

/** Build a file tree whose `path` fields are all relative to the project root. */
async function buildTree(projectRoot: string, dir: string, depth: number, budget: { n: number }): Promise<TreeEntry[]> {
  if (depth > MAX_TREE_DEPTH || budget.n <= 0) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: TreeEntry[] = []
  for (const entry of entries) {
    if (budget.n <= 0) break
    if (entry.name.startsWith('.')) continue
    // Symlinks/junctions can cycle back into the tree (Windows junctions
    // report isDirectory() true); skipping them keeps recursion bounded.
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    const rel = relative(projectRoot, full).split(sep).join('/')
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      budget.n -= 1
      const children = await buildTree(projectRoot, full, depth + 1, budget)
      out.push({ name: entry.name, path: rel, type: 'dir', children })
    } else if (entry.isFile()) {
      budget.n -= 1
      out.push({ name: entry.name, path: rel, type: 'file' })
    }
  }
  return out
}

/** One AIUI project found under the workspace root. */
export interface DiscoveredProject {
  /** Folder name. */
  name: string
  /** Absolute project root (the directory holding `app.json`). */
  path: string
  /** Path relative to the workspace root, `/`-separated; equals `name` at the top level. */
  rel: string
}

/**
 * Find AIUI projects (directories holding `app.json`) under `root`, up to
 * `maxDepth` levels deep.
 *
 * One level was not enough: a common layout keeps projects inside a grouping
 * folder (`<root>/<group>/<project>/app.json`). A directory that is itself a
 * project ends that branch — a project never contains another one — and the
 * sweep is bounded by MAX_SCAN_DIRS so a huge workspace cannot stall boot.
 *
 * Exported for diagnostics: the sweep answers `/api/aiui-projects`, and its
 * depth/branch rules are worth checking directly.
 */
export async function discoverProjects(root: string, maxDepth: number): Promise<DiscoveredProject[]> {
  const found: DiscoveredProject[] = []
  const budget = { dirs: MAX_SCAN_DIRS }
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || budget.dirs <= 0) return
    const marker = await stat(join(dir, 'app.json')).catch(() => null)
    if (marker !== null && marker.isFile()) {
      const rel = relative(root, dir).split(sep).join('/')
      found.push({ name: basename(dir), path: dir, rel: rel === '' ? basename(dir) : rel })
      return
    }
    if (depth === maxDepth) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (budget.dirs <= 0) break
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      budget.dirs -= 1
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => a.rel.localeCompare(b.rel))
}

/* ── configuration ──────────────────────────────────────────────────────── */

/** Bundle-row configuration. */
export interface AiuiDevConsoleConfig {
  /** Directory to scan for AIUI projects (dirs containing app.json). */
  workspaceRoot?: string
  /** Path of the marker file storing the chosen project. */
  projectFile?: string
  /** Override the resolved @yodaos-pkg/aix-cli entry path. */
  aixCli?: string
  /** Working directory for spawning the preview dev server. */
  aixCwd?: string
  /** Agent-preset display label that activates the console UI. */
  presetLabel?: string
  /** Agent-preset id that activates the console UI (matched as a fallback). */
  presetId?: string
  /** How many directory levels below `workspaceRoot` are scanned for projects. */
  scanDepth?: number
  /** Deadline for `aix preview --dev` to print its URL before the start fails. */
  previewStartTimeoutMs?: number
  /** Also sync the bundled preset into the legacy `$DSH_HOME/.agent-presets` root. */
  legacyPresetSync?: boolean
}

/**
 * Every field is optional by design: the row activates with no config at all
 * and resolves each default at runtime, and a partial override (only
 * `workspaceRoot`, say) must never fail validation.
 */
export const Config: z<AiuiDevConsoleConfig> = z.object({
  workspaceRoot: z.string().description('Directory scanned for AIUI projects (directories containing app.json); defaults to $AIUI_WORKSPACE, then the invoking directory.'),
  projectFile: z.string().description('Marker file recording the chosen project; defaults to <workspaceRoot>/.aiui/current-project.json.'),
  aixCli: z.string().description('Override the resolved @yodaos-pkg/aix-cli entry (dist/cli.js).'),
  aixCwd: z.string().description('Working directory for the `aix preview` child process; defaults to workspaceRoot.'),
  presetLabel: z.string().description('Agent-preset display label that activates the console UI.'),
  presetId: z.string().description('Agent-preset id that also activates the console UI.'),
  scanDepth: z.number().min(0).max(8).description('Directory levels below workspaceRoot scanned for projects (default 3).'),
  previewStartTimeoutMs: z.number().min(1000).max(120000).description('How long to wait for `aix preview --dev` to print its URL (default 15000 ms).'),
  legacyPresetSync: z.boolean().description('Also sync the bundled preset into the legacy $DSH_HOME/.agent-presets root (default false; the current Harness reads preset declaration rows instead).'),
})

/* ── the browser half ───────────────────────────────────────────────────── */

/** The injectable browser script shipped beside the built host half. */
const CLIENT_SCRIPT_URL = new URL('../client/injected.js', import.meta.url)

/**
 * Read the browser script and substitute the two placeholder tokens with the
 * JSON encoding of the label and id.
 *
 * The script is ordinary JavaScript in its own file, so it is editable and
 * syntax-checkable without the backtick-escaping hazard of a host template
 * literal. Throws when the asset is missing; the caller degrades to
 * routes-only rather than failing activation.
 */
async function loadClientScript(presetLabel: string, presetId: string): Promise<string> {
  const template = await readFile(fileURLToPath(CLIENT_SCRIPT_URL), 'utf-8')
  const script = template
    .replace('"__AIUI_PRESET_LABEL__"', JSON.stringify(presetLabel))
    .replace('"__AIUI_PRESET_ID__"', JSON.stringify(presetId))
  // The script is injected inside a <script> element: an embedded end tag would
  // close it early.
  return script.replace(/<\/script/gi, '<\\/script')
}

/* ── composition ────────────────────────────────────────────────────────── */

interface PreviewStatus {
  running: boolean
  url: string | null
  error: string | null
  project: string | null
}

/** Compose the plugin: host routes + index tap injecting the console script. */
export async function apply(ctx: Context, config: AiuiDevConsoleConfig = {}): Promise<void> {
  const workspaceRoot = config.workspaceRoot ?? process.env.AIUI_WORKSPACE ?? process.cwd()
  const projectFile = config.projectFile ?? join(workspaceRoot, '.aiui', 'current-project.json')
  const aixCwd = config.aixCwd ?? workspaceRoot
  const aixCli = config.aixCli ?? resolveAixCli()
  const presetLabel = config.presetLabel ?? 'AIUI 开发模式'
  const presetId = config.presetId ?? 'aiui-dev'
  const scanDepth = config.scanDepth ?? 3
  const previewStartTimeoutMs = config.previewStartTimeoutMs ?? 15000
  const connection = connectionOf(ctx)

  if (connection === undefined) {
    ctx.logger.warn('dsh-rokid-aiui: the `connection` service is missing — /api/aiui-* routes stay unfenced')
  }

  // The current Harness reads preset declaration rows, not the legacy
  // $DSH_HOME/.agent-presets directory; the sibling `dsh-aiui-preset` bundle
  // carries the "AIUI 开发模式" row. The legacy sync is opt-in.
  if (config.legacyPresetSync === true) {
    const presetSync = await syncBundledPreset(require('../package.json').version)
    if (presetSync.error !== undefined) {
      ctx.logger.warn(`dsh-rokid-aiui: could not sync the bundled legacy preset (${presetSync.error})`)
    } else if (presetSync.installed) {
      ctx.logger.info(`dsh-rokid-aiui: synced legacy agent preset "aiui-dev" (${presetSync.copied} files) → ${presetSync.dir}`)
    }
  } else {
    ctx.logger.info('dsh-rokid-aiui: legacy preset sync is off; the "AIUI 开发模式" preset comes from the dsh-aiui-preset bundle')
  }

  // ── live preview dev server (official `aix preview --dev`) ──────────────
  // Runs `aix preview --dev <project>` for the current project. That server
  // watches the project directory and hot-reloads the browser over WebSocket,
  // so no static snapshot export is needed. Its port is chosen by aix at
  // random, so we parse the URL from its output and hand it to the browser.
  let devHandle: ReturnType<typeof ctx.subprocess.spawn> | null = null
  let devUrl: string | null = null
  let devProject: string | null = null
  // The failure record is keyed by project and outlives `stopDevServer()`
  // clearing devProject; without that key the cooldown below could never match
  // and a broken project would respawn the CLI on every heartbeat.
  let devError: string | null = null
  let devErrorAt = 0
  let devErrorProject: string | null = null
  let ensurePromise: Promise<PreviewStatus> | null = null

  function recordDevError(projectPath: string, message: string): void {
    devError = message
    devErrorAt = Date.now()
    devErrorProject = projectPath
  }

  function clearDevError(): void {
    devError = null
    devErrorAt = 0
    devErrorProject = null
  }

  function previewUrlFrom(text: string): string | null {
    const match = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?/.exec(text)
    return match ? match[0] : null
  }

  function collectedText(handle: ReturnType<typeof ctx.subprocess.spawn>, stream: 'stdout' | 'stderr'): string {
    const reader = handle.collected[stream]
    return reader ? reader.readFrom(0).text : ''
  }

  async function waitForPreviewUrl(handle: ReturnType<typeof ctx.subprocess.spawn>, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // aix prints the URL on stdout today; accept stderr too so a logging
      // change upstream cannot silently break the start.
      const url = previewUrlFrom(collectedText(handle, 'stdout')) ?? previewUrlFrom(collectedText(handle, 'stderr'))
      if (url !== null) return url
      if (devHandle !== handle) return null // stopped or superseded while waiting
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return null
  }

  /** Clear the preview state; `terminate()` is safe on an already-dead child. */
  function stopDevServer(): void {
    const handle = devHandle
    devHandle = null
    devUrl = null
    devProject = null
    if (handle) { try { handle.terminate() } catch { /* already gone */ } }
  }

  /**
   * Watch one preview child: a server that dies mid-session must invalidate the
   * cached URL, otherwise the console keeps pointing at a dead port. Identity
   * is checked so a superseded handle cannot clear the newer server's state.
   */
  function watchPreviewExit(handle: ReturnType<typeof ctx.subprocess.spawn>, projectPath: string): void {
    void handle.done.then((outcome) => {
      if (devHandle !== handle) return
      devHandle = null
      devUrl = null
      devProject = null
      const reason = outcome.exitCode === null ? `signal ${outcome.signal ?? 'unknown'}` : `exit code ${outcome.exitCode}`
      recordDevError(projectPath, `aix preview 进程已退出（${reason}）`)
    }).catch((error: unknown) => {
      if (devHandle !== handle) return
      devHandle = null
      devUrl = null
      devProject = null
      recordDevError(projectPath, `aix preview 进程异常：${messageOf(error)}`)
    })
  }

  async function ensureDevServer(projectPath: string, force: boolean): Promise<PreviewStatus> {
    if (devUrl !== null && devProject === projectPath) {
      return { running: true, url: devUrl, error: null, project: projectPath }
    }
    // A different project's failure says nothing about this one.
    if (devErrorProject !== null && devErrorProject !== projectPath) clearDevError()
    // A failed start keeps its diagnostic for a moment instead of respawning
    // the CLI on every heartbeat; an explicit retry bypasses the cooldown.
    if (!force && devError !== null && devErrorProject === projectPath && Date.now() < devErrorAt + RETRY_COOLDOWN_MS) {
      return { running: false, url: null, error: devError, project: projectPath }
    }
    await stopDevServer()
    if (aixCli === null) {
      recordDevError(projectPath, 'aix CLI 未找到：@yodaos-pkg/aix-cli 是本 bundle 的依赖')
      return { running: false, url: null, error: devError, project: projectPath }
    }
    let nodePath: string
    try {
      nodePath = await ctx.subprocess.resolveExecutable('node')
    } catch (error) {
      recordDevError(projectPath, `无法解析 node 可执行文件：${messageOf(error)}`)
      return { running: false, url: null, error: devError, project: projectPath }
    }
    let handle: ReturnType<typeof ctx.subprocess.spawn>
    try {
      handle = ctx.subprocess.spawn({
        argv: [nodePath, aixCli, 'preview', projectPath, '--dev'],
        cwd: aixCwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 5000,
      })
    } catch (error) {
      recordDevError(projectPath, `无法启动 aix preview：${messageOf(error)}`)
      return { running: false, url: null, error: devError, project: projectPath }
    }
    clearDevError()
    devHandle = handle
    devProject = projectPath
    watchPreviewExit(handle, projectPath)
    const url = await waitForPreviewUrl(handle, previewStartTimeoutMs)
    if (url !== null && devHandle === handle) {
      devUrl = url
      clearDevError()
      return { running: true, url, error: null, project: projectPath }
    }
    if (devHandle !== handle) return { running: false, url: null, error: devError, project: projectPath }
    const errText = collectedText(handle, 'stderr').trim() || collectedText(handle, 'stdout').trim()
    await stopDevServer()
    recordDevError(projectPath, errText
      ? errText.split(/\r?\n/).slice(-6).join('\n')
      : `aix preview --dev 未在 ${previewStartTimeoutMs}ms 内输出预览地址`)
    return { running: false, url: null, error: devError, project: projectPath }
  }

  // Stop the dev server when the plugin is disposed.
  ctx.effect(() => () => { stopDevServer() }, 'aiui-dev-console: stop preview dev server')

  // GET /api/aiui-preview[?retry=1] — ensure the live preview server is running
  // for the current project and return its URL, or the reason it failed.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-preview',
    handler: apiRoute('GET', connection, async (req, res) => {
      const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('retry') === '1'
      const project = await readProjectInfo(projectFile)
      if (!project) {
        stopDevServer()
        json(res, { ok: true, running: false, url: null, error: null, project: null })
        return
      }
      if (!ensurePromise) ensurePromise = ensureDevServer(project.path, force).finally(() => { ensurePromise = null })
      const status = await ensurePromise
      json(res, { ok: true, running: status.running, url: status.url, error: status.error, project: status.project })
    }),
  }), 'aiui-dev-console: /api/aiui-preview')

  // GET /api/aiui-project — the current project (from current-project.json).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project',
    handler: apiRoute('GET', connection, async (_req, res) => {
      json(res, { ok: true, project: await readProjectInfo(projectFile) })
    }),
  }), 'aiui-dev-console: /api/aiui-project')

  // GET /api/aiui-projects — AIUI projects discovered under the workspace.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-projects',
    handler: apiRoute('GET', connection, async (_req, res) => {
      const projects = await discoverProjects(workspaceRoot, scanDepth)
      json(res, { ok: true, workspaceRoot, projects })
    }),
  }), 'aiui-dev-console: /api/aiui-projects')

  // POST /api/aiui-project-select — pick a project (must contain app.json).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project-select',
    handler: apiRoute('POST', connection, async (req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += String(chunk) })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}')
          const raw = String(payload.path || '').trim().replace(/^["']|["']$/g, '')
          const root = resolve(raw)
          // Accept the picked folder itself; fall back to its single immediate
          // child that is itself an AIUI project, then to its parent when the
          // parent is an AIUI project (users often pick one level too deep).
          let projectRoot = root
          let marker = await stat(join(projectRoot, 'app.json')).catch(() => null)
          let note = ''
          if (!marker || !marker.isFile()) {
            const children = await readdir(projectRoot, { withFileTypes: true }).catch(() => [])
            const candidates: string[] = []
            for (const entry of children) {
              if (!entry.isDirectory()) continue
              const m = await stat(join(projectRoot, entry.name, 'app.json')).catch(() => null)
              if (m && m.isFile()) candidates.push(entry.name)
            }
            if (candidates.length === 1) {
              projectRoot = join(projectRoot, candidates[0])
              marker = await stat(join(projectRoot, 'app.json')).catch(() => null)
              note = '（所选目录无 app.json，已自动定位到子目录）'
            }
          }
          if (!marker || !marker.isFile()) {
            const parent = dirname(projectRoot)
            const parentMarker = await stat(join(parent, 'app.json')).catch(() => null)
            if (parentMarker && parentMarker.isFile()) {
              projectRoot = parent
              marker = parentMarker
              note = '（所选目录无 app.json，已自动定位到父目录）'
            }
          }
          if (!marker || !marker.isFile()) {
            json(res, { ok: false, error: '不是 AIUI 项目（缺少 app.json）', received: raw, checked: join(root, 'app.json') })
            return
          }
          // The marker lives at <workspaceRoot>/.aiui/current-project.json; that
          // directory usually does not exist yet, so create it first.
          await mkdir(dirname(projectFile), { recursive: true })
          await writeFile(projectFile, JSON.stringify({ name: basename(projectRoot), path: projectRoot, at: new Date().toISOString() }), 'utf-8')
          // Switching projects invalidates a server started for the old one.
          if (devProject !== null && devProject !== projectRoot) stopDevServer()
          json(res, { ok: true, name: basename(projectRoot), path: projectRoot, note })
        } catch (error) {
          json(res, { ok: false, error: messageOf(error) })
        }
      })
    }),
  }), 'aiui-dev-console: /api/aiui-project-select')

  // GET /api/aiui-project-tree — recursive file tree of the current project.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project-tree',
    handler: apiRoute('GET', connection, async (_req, res) => {
      const project = await readProjectInfo(projectFile)
      if (!project) { json(res, { ok: false, error: 'no project selected' }); return }
      const tree = await buildTree(project.path, project.path, 0, { n: MAX_TREE_ITEMS })
      json(res, { ok: true, name: project.name, path: project.path, tree })
    }),
  }), 'aiui-dev-console: /api/aiui-project-tree')

  // GET /api/aiui-project-file?path=<rel> — text content of one project file.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project-file',
    handler: apiRoute('GET', connection, async (req, res) => {
      const project = await readProjectInfo(projectFile)
      if (!project) { json(res, { ok: false, error: 'no project selected' }); return }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rel = String(url.searchParams.get('path') || '')
      const root = resolve(project.path)
      const target = resolve(root, rel)
      if (target !== root && !target.startsWith(root + sep)) {
        json(res, { ok: false, error: 'invalid path' })
        return
      }
      const info = await stat(target).catch(() => null)
      if (!info || !info.isFile()) { json(res, { ok: false, error: 'not a file' }); return }
      if (info.size > MAX_FILE_BYTES) {
        json(res, { ok: false, error: 'file too large (>1 MiB)' })
        return
      }
      const buf = await readFile(target).catch(() => null)
      if (buf === null) { json(res, { ok: false, error: 'unreadable' }); return }
      const dot = target.lastIndexOf('.')
      const ext = dot > target.lastIndexOf(sep) ? target.slice(dot).toLowerCase() : ''
      const mime = IMAGE_EXT[ext]
      if (mime !== undefined) {
        // Images open as an inline preview instead of being rejected.
        json(res, { ok: true, path: rel, kind: 'image', mime, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') })
        return
      }
      if (buf.includes(0)) { json(res, { ok: false, error: 'binary file，无法预览' }); return }
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        // Chinese-authored files are often GBK; fall back before giving up.
        try { content = new TextDecoder('gbk').decode(buf) } catch { content = buf.toString('utf-8') }
      }
      json(res, { ok: true, path: rel, kind: 'text', content })
    }),
  }), 'aiui-dev-console: /api/aiui-project-file')

  // Index tap: inject the browser script.
  try {
    const clientScript = await loadClientScript(presetLabel, presetId)
    ctx.effect(
      () => ctx.webServer.tapIndex(html => html.replace('</body>', `<script>${clientScript}</script></body>`)),
      'aiui-dev-console: index tap',
    )
  } catch (error) {
    ctx.logger.warn(`dsh-rokid-aiui: could not read client/injected.js (${messageOf(error)}) — the console UI stays unmounted`)
  }
}
