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
 * Configuration (the bundle row's `config`): `workspaceRoot` (directory to
 * scan for AIUI projects), `projectFile` (where the chosen project marker is
 * stored), `aixCli` (override the resolved @yodaos-pkg/aix-cli path), `aixCwd`
 * (spawn cwd for the dev server). All optional; defaults derive from the
 * invoking directory.
 *
 * Pure DOM script (no framework, no client bundle, no runtime build).
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, basename, dirname, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

const require = createRequire(import.meta.url)

export const name = 'aiui-dev-console'

export const inject = ['webServer', 'subprocess']

/* ── host-side project/file serving ─────────────────────────────────────── */

const MAX_FILE_BYTES = 1048576 // 1 MiB
const MAX_TREE_ITEMS = 3000
const MAX_TREE_DEPTH = 6
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

function json(res: { setHeader: (k: string, v: string) => void; end: (s: string) => void }, value: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

/** Wrap a route handler so a crash answers JSON with the real error instead of a bare 400. */
function safeHandler(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      json(res, { ok: false, error: message, stack })
    }
  }
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
}

/** Compose the plugin: host routes + index tap injecting the console script. */
export function apply(ctx: Context, config: AiuiDevConsoleConfig = {}): void {
  const workspaceRoot = config.workspaceRoot ?? process.env.AIUI_WORKSPACE ?? process.cwd()
  const projectFile = config.projectFile ?? join(workspaceRoot, '.aiui', 'current-project.json')
  const aixCwd = config.aixCwd ?? workspaceRoot
  const aixCli = config.aixCli ?? resolveAixCli()
  const presetLabel = config.presetLabel ?? 'AIUI 开发模式'
  const presetId = config.presetId ?? 'aiui-dev'

  // ── live preview dev server (official `aix preview --dev`) ──────────────
  // Runs `aix preview --dev <project>` for the current project. That server
  // watches the project directory and hot-reloads the browser over WebSocket,
  // so no static snapshot export is needed. Its port is chosen by aix at
  // random, so we parse the URL from stdout and hand it to the browser.
  let devHandle: ReturnType<typeof ctx.subprocess.spawn> | null = null
  let devUrl: string | null = null
  let devProject: string | null = null
  let ensurePromise: Promise<{ running: boolean; url?: string; error?: string }> | null = null

  function previewUrlFrom(text: string): string | null {
    const match = /https?:\/\/127\.0\.0\.1:\d+\//.exec(text)
    return match ? match[0] : null
  }

  async function waitForPreviewUrl(handle: ReturnType<typeof ctx.subprocess.spawn>, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const text = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const url = previewUrlFrom(text)
      if (url) return url
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return null
  }

  async function stopDevServer(): Promise<void> {
    const handle = devHandle
    devHandle = null
    devUrl = null
    devProject = null
    if (handle) { try { handle.terminate() } catch { /* already gone */ } }
  }

  async function ensureDevServer(projectPath: string): Promise<{ running: boolean; url?: string; error?: string }> {
    if (devUrl !== null && devProject === projectPath) return { running: true, url: devUrl }
    await stopDevServer()
    if (!aixCli) return { running: false, error: 'aix CLI not found: @yodaos-pkg/aix-cli is a dependency of this bundle' }
    const nodePath = await ctx.subprocess.resolveExecutable('node')
    const handle = ctx.subprocess.spawn({
      argv: [nodePath, aixCli, 'preview', projectPath, '--dev'],
      cwd: aixCwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 5000,
    })
    devHandle = handle
    devProject = projectPath
    const url = await waitForPreviewUrl(handle, 10000)
    if (url !== null) {
      devUrl = url
      return { running: true, url }
    }
    const errText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    await stopDevServer()
    return { running: false, error: errText || 'aix preview --dev did not report a URL in time' }
  }

  // Stop the dev server when the plugin is disposed.
  ctx.effect(() => () => { void stopDevServer() }, 'aiui-dev-console: stop preview dev server')

  // GET /api/aiui-preview — ensure the live preview server is running for the
  // current project and return its URL (running:false when no project is set).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-preview',
    handler: safeHandler(async (_req, res) => {
      const project = await readProjectInfo(projectFile)
      if (!project) {
        await stopDevServer()
        json(res, { ok: true, running: false, url: null })
        return
      }
      if (!ensurePromise) ensurePromise = ensureDevServer(project.path).finally(() => { ensurePromise = null })
      const result = await ensurePromise
      json(res, { ok: true, running: result.running, url: result.url ?? null, error: result.error })
    }),
  }), 'aiui-dev-console: /api/aiui-preview')

  // GET /api/aiui-project — the current project (from current-project.json).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project',
    handler: safeHandler(async (_req, res) => {
      json(res, { ok: true, project: await readProjectInfo(projectFile) })
    }),
  }), 'aiui-dev-console: /api/aiui-project')

  // GET /api/aiui-projects — AIUI projects discovered under the workspace.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-projects',
    handler: safeHandler(async (_req, res) => {
      const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => [])
      const projects: { name: string; path: string }[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue
        const marker = await stat(join(workspaceRoot, entry.name, 'app.json')).catch(() => null)
        if (marker && marker.isFile()) projects.push({ name: entry.name, path: join(workspaceRoot, entry.name) })
      }
      json(res, { ok: true, projects })
    }),
  }), 'aiui-dev-console: /api/aiui-projects')

  // POST /api/aiui-project-select — pick a project (must contain app.json).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project-select',
    handler: safeHandler(async (req, res) => {
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
          await writeFile(projectFile, JSON.stringify({ name: basename(projectRoot), path: projectRoot, at: new Date().toISOString() }), 'utf-8')
          json(res, { ok: true, name: basename(projectRoot), path: projectRoot, note })
        } catch (error) {
          json(res, { ok: false, error: String((error as Error).message || error) })
        }
      })
    }),
  }), 'aiui-dev-console: /api/aiui-project-select')

  // GET /api/aiui-project-tree — recursive file tree of the current project.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/aiui-project-tree',
    handler: safeHandler(async (_req, res) => {
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
    handler: safeHandler(async (req, res) => {
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
      const ext = target.slice(target.lastIndexOf('.')).toLowerCase()
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
  ctx.effect(
    () => ctx.webServer.tapIndex(html => html.replace(
      '</body>',
      `<script>${buildInjectedScript(presetLabel, presetId)}</script></body>`,
    )),
    'aiui-dev-console: index tap',
  )
}

/* ── browser-side injected script ───────────────────────────────────────── */

function buildInjectedScript(presetLabel: string, presetId: string): string {
  return `
(function () {
  var KEY = 'dsh-aiui-dev-console'
  if (document.getElementById(KEY)) return

  var PREVIEW_URL = null // set from /api/aiui-preview (the aix preview --dev URL)
  var PRESET_TEXT = ${JSON.stringify(presetLabel)}
  var PRESET_ID = ${JSON.stringify(presetId)}
  var HEADER_SLOT = 'conversation.session.header.actions'

  var CSS = '' +
    '#dsh-aiui-dev-console{position:fixed;inset:0;pointer-events:none;z-index:9500;}' +
    /* preview console */
    '#dsh-aiui-launcher{pointer-events:auto;position:fixed;left:16px;bottom:16px;display:flex;align-items:center;gap:8px;' +
    'padding:8px 14px;border-radius:999px;border:1px solid rgba(64,255,94,.55);background:rgba(0,0,0,.82);color:#40ff5e;' +
    'font-size:13px;font-weight:600;cursor:grab;user-select:none;touch-action:none;box-shadow:0 6px 24px rgba(0,0,0,.45);' +
    'font-family:inherit;line-height:1.4;}' +
    '#dsh-aiui-console-btn{pointer-events:auto;position:fixed;left:16px;bottom:16px;width:46px;height:46px;border-radius:12px;' +
    'border:1px solid rgba(64,255,94,.5);background:rgba(0,0,0,.85);color:#40ff5e;cursor:grab;user-select:none;touch-action:none;' +
    'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 24px rgba(0,0,0,.45);font-family:inherit;}' +
    '#dsh-aiui-console-btn:hover{border-color:#40ff5e;box-shadow:0 8px 28px rgba(64,255,94,.3)}' +
    '#dsh-aiui-terminal{font-family:Consolas,Menlo,monospace;font-size:15px;font-weight:700;letter-spacing:-1px;pointer-events:none;}' +
    '#dsh-aiui-dot{width:8px;height:8px;border-radius:50%;background:#40ff5e;box-shadow:0 0 8px #40ff5e;animation:dshAiuiPulse 2s infinite;}' +
    '@keyframes dshAiuiPulse{0%,100%{opacity:1}50%{opacity:.35}}' +
    '#dsh-aiui-panel{pointer-events:auto;position:fixed;width:1200px;max-height:88vh;display:flex;flex-direction:column;' +
    'border-radius:14px;border:1px solid rgba(64,255,94,.4);background:rgba(10,12,10,.96);' +
    'box-shadow:0 18px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(64,255,94,.12);overflow:hidden;color:#e8ffe9;font-family:inherit;}' +
    '#dsh-aiui-panel-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px 9px 14px;' +
    'cursor:grab;user-select:none;touch-action:none;border-bottom:1px solid rgba(64,255,94,.22);' +
    'background:linear-gradient(180deg, rgba(64,255,94,.10), rgba(64,255,94,.04));}' +
    '#dsh-aiui-panel-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#40ff5e;pointer-events:none;}' +
    '#dsh-aiui-panel-dot{width:7px;height:7px;border-radius:50%;background:#40ff5e;box-shadow:0 0 6px #40ff5e;}' +
    '#dsh-aiui-panel-actions{display:flex;align-items:center;gap:10px;pointer-events:auto;}' +
    '#dsh-aiui-open{color:rgba(64,255,94,.8);font-size:12px;text-decoration:none;cursor:pointer;}' +
    '#dsh-aiui-close{background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);border:1px solid var(--dsw-alias-border-l2);' +
    'color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;line-height:1;padding:4px 9px;border-radius:8px;font-family:inherit;}' +
    '#dsh-aiui-close:hover{color:#fff;background:rgba(220,38,38,.8);border-color:rgba(220,38,38,.8)}' +
    '#dsh-aiui-frame{width:100%;height:620px;border:none;display:block;background:#fff;}' +
    '#dsh-aiui-foot{font-size:11px;opacity:.6;padding:6px 14px;border-top:1px solid rgba(64,255,94,.15);color:rgba(232,255,233,.7);}' +
    /* project panel (right) — theme-aligned colors */
    '#dsh-aiui-proj{pointer-events:auto;position:fixed;right:0;top:0;bottom:0;width:280px;display:flex;flex-direction:column;' +
    'background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-family:inherit;z-index:1;}' +
    '#dsh-aiui-proj-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);' +
    'font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}' +
    '#dsh-aiui-proj-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#dsh-aiui-proj-btn{background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;cursor:pointer;' +
    'font-size:11px;padding:2px 7px;font-family:inherit;}' +
    '#dsh-aiui-proj-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)}' +
    '#dsh-aiui-proj-toggle{background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;' +
    'font-size:12px;padding:2px 8px;font-family:inherit;line-height:1.3;}' +
    '#dsh-aiui-proj-toggle:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)}' +
    '#dsh-aiui-proj-restore{pointer-events:auto;position:fixed;right:0;top:0;bottom:0;width:26px;display:flex;align-items:center;justify-content:center;' +
    'background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:pointer;' +
    'font-size:11px;writing-mode:vertical-rl;text-align:center;user-select:none;font-family:inherit;z-index:1;gap:6px;}' +
    '#dsh-aiui-proj-restore:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}' +
    '#dsh-aiui-proj-body{flex:1;overflow:auto;padding:8px 6px 20px;}' +
    '#dsh-aiui-proj-note{font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px 12px;line-height:1.6;}' +
    '#dsh-aiui-proj-pick{display:block;width:100%;text-align:left;background:none;border:none;color:var(--dsw-alias-label-primary);font-size:12px;' +
    'padding:6px 10px;cursor:pointer;border-radius:6px;font-family:inherit;}' +
    '#dsh-aiui-proj-pick:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);color:var(--dsw-alias-brand-primary);}' +
    '#dsh-aiui-tree{margin:0;padding:0;list-style:none;font-size:12px;}' +
    '#dsh-aiui-tree ul{margin:0;padding:0 0 0 14px;list-style:none;}' +
    '#dsh-aiui-tree li{line-height:1.8;}' +
    '#dsh-aiui-tree .dsh-aiui-dir{cursor:pointer;display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-primary);padding:1px 6px;border-radius:5px;}' +
    '#dsh-aiui-tree .dsh-aiui-dir:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)}' +
    '#dsh-aiui-tree .dsh-aiui-file{cursor:pointer;display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);' +
    'padding:1px 6px;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#dsh-aiui-tree .dsh-aiui-file:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);color:var(--dsw-alias-label-primary)}' +
    '#dsh-aiui-tree .dsh-aiui-arrow{width:12px;flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;}' +
    '#dsh-aiui-tree .dsh-aiui-ic{flex:none;width:14px;text-align:center;}' +
    /* source viewer — theme-aligned colors */
    '#dsh-aiui-src{pointer-events:auto;position:fixed;display:flex;flex-direction:column;width:720px;max-width:60vw;' +
    'max-height:80vh;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);overflow:hidden;' +
    'color:var(--dsw-alias-label-primary);font-family:inherit;box-shadow:0 18px 60px rgba(0,0,0,.45);}' +
    '#dsh-aiui-src-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;cursor:grab;' +
    'user-select:none;touch-action:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}' +
    '#dsh-aiui-src-path{flex:1;font-size:12px;color:var(--dsw-alias-label-primary);font-family:Consolas,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#dsh-aiui-src-pre{margin:0;padding:14px;overflow:auto;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.6;' +
    'color:var(--dsw-alias-label-primary);white-space:pre;tab-size:2;flex:1;min-height:0;}' +
    '#dsh-aiui-src-img{flex:1;display:none;width:100%;min-height:0;object-fit:contain;padding:10px;box-sizing:border-box;' +
    'background:var(--dsw-alias-bg-base);}' +
    /* project picker dialog */
    '#dsh-aiui-dlg{pointer-events:auto;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.5);z-index:9600;font-family:inherit;}' +
    '#dsh-aiui-dlg-card{width:520px;max-width:92vw;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);' +
    'border-radius:16px;padding:22px;box-shadow:0 24px 70px rgba(0,0,0,.55);color:var(--dsw-alias-label-primary);}' +
    '#dsh-aiui-dlg-title{font-size:16px;font-weight:600;margin:0 0 6px;}' +
    '#dsh-aiui-dlg-sub{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0 0 16px;}' +
    '#dsh-aiui-dlg-list{display:flex;flex-direction:column;gap:8px;max-height:300px;overflow:auto;margin:14px 0 4px;}' +
    '#dsh-aiui-dlg-item{display:flex;align-items:center;gap:10px;text-align:left;background:none;border:1px solid var(--dsw-alias-border-l1);' +
    'color:var(--dsw-alias-label-primary);border-radius:10px;padding:10px 12px;cursor:pointer;font-size:13px;font-family:inherit;' +
    'transition:border-color .12s ease, background-color .12s ease;}' +
    '#dsh-aiui-dlg-item:hover{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);}' +
    '#dsh-aiui-dlg-item .dsh-aiui-dlg-ic{flex:none;font-size:15px;}' +
    '#dsh-aiui-dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}' +
    '#dsh-aiui-dlg-btn{background:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);' +
    'border-radius:10px;padding:8px 18px;cursor:pointer;font-size:13px;font-family:inherit;transition:border-color .12s ease, color .12s ease;}' +
    '#dsh-aiui-dlg-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}' +
    '#dsh-aiui-dlg-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600;}' +
    '#dsh-aiui-dlg-browse{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:13px 16px;font-size:14px;font-weight:600;' +
    'border-radius:12px;letter-spacing:.3px;box-shadow:0 4px 18px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);}' +
    '#dsh-aiui-dlg-browse:disabled{opacity:.6;cursor:default;}' +
    '#dsh-aiui-dlg-sep{display:flex;align-items:center;gap:10px;margin:16px 0 4px;font-size:12px;color:var(--dsw-alias-label-secondary);}' +
    '#dsh-aiui-dlg-sep::before,#dsh-aiui-dlg-sep::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1);}' +
    '#dsh-aiui-dlg-err{display:none;font-size:12.5px;color:var(--dsw-alias-state-error-primary);margin:10px 0 0;line-height:1.5;}'

  function el(tag, id, styleText) {
    var n = document.createElement(tag)
    n.id = id
    if (styleText) n.setAttribute('style', styleText)
    return n
  }

  var root = el('div', KEY)
  var style = document.createElement('style')
  style.textContent = CSS

  /* ---- preview console (unchanged behaviour) ---- */
  var launcher = null, consoleBtn = null, panel = null
  var mode = 'off', panelOpen = false, launcherPos = null, panelPos = null, drag = null
  var previewReady = false // the aix preview --dev server is up and its URL is known

  function baseLauncherStyle() {
    return launcherPos ? 'left:' + launcherPos.x + 'px;top:' + launcherPos.y + 'px;bottom:auto;' : 'left:16px;bottom:16px;'
  }
  function ensurePanelPos() {
    if (panelPos) return
    var x = 160, y = 48
    try { if (document.documentElement) x = Math.max(16, Math.round((document.documentElement.clientWidth - 1200) / 2)) } catch (e) {}
    panelPos = { x: x, y: y }
  }
  function clampToViewport(x, y, w, h) {
    var vw = 1280, vh = 720
    try { if (document.documentElement) { vw = document.documentElement.clientWidth; vh = document.documentElement.clientHeight } } catch (e) {}
    return { x: Math.max(4, Math.min(x, vw - (w || 46) - 4)), y: Math.max(4, Math.min(y, vh - (h || 46) - 4)) }
  }
  var dragEl = null
  var pendingClick = null
  function startDrag(e, target) {
    if (e.button !== 0) return
    var rect = e.currentTarget.getBoundingClientRect()
    dragEl = e.currentTarget
    drag = { target: target, px: e.clientX, py: e.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height, moved: false }
    if (dragEl.setPointerCapture) { try { dragEl.setPointerCapture(e.pointerId) } catch (err) {} }
    // Document-level tracking: dragging must follow the pointer even if the
    // capture or the element's own move events misbehave.
    document.addEventListener('pointermove', docMove, true)
    document.addEventListener('pointerup', docUp, true)
    document.addEventListener('pointercancel', docUp, true)
  }
  function docMove(e) {
    if (!drag) return
    var dx = e.clientX - drag.px, dy = e.clientY - drag.py
    var moved = drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4
    if (!moved) return
    if (drag.target === 'panel') {
      panelPos = { x: drag.x + dx, y: drag.y + dy }
      if (panel) { panel.style.left = panelPos.x + 'px'; panel.style.top = panelPos.y + 'px' }
    } else if (drag.target === 'launcher') {
      launcherPos = clampToViewport(drag.x + dx, drag.y + dy, drag.w, drag.h)
      var b = launcher || consoleBtn
      if (b) { b.style.left = launcherPos.x + 'px'; b.style.top = launcherPos.y + 'px'; b.style.bottom = 'auto' }
    } else if (drag.target === 'src') {
      srcPos = { x: drag.x + dx, y: drag.y + dy }
      if (srcWin) { srcWin.style.left = srcPos.x + 'px'; srcWin.style.top = srcPos.y + 'px' }
    }
    if (!drag.moved) drag.moved = true
  }
  function docUp(e) {
    document.removeEventListener('pointermove', docMove, true)
    document.removeEventListener('pointerup', docUp, true)
    document.removeEventListener('pointercancel', docUp, true)
    var wasMoved = drag ? drag.moved : true
    var action = pendingClick
    pendingClick = null
    if (dragEl && dragEl.releasePointerCapture) { try { dragEl.releasePointerCapture(e.pointerId) } catch (err) {} }
    dragEl = null
    drag = null
    if (!wasMoved && action) action()
  }

  function renderPreviewConsole() {
    if (root.querySelector('#dsh-aiui-launcher')) root.querySelector('#dsh-aiui-launcher').remove()
    if (root.querySelector('#dsh-aiui-console-btn')) root.querySelector('#dsh-aiui-console-btn').remove()
    var dim = previewReady ? '' : 'filter:grayscale(1);opacity:.6;'
    if (mode === 'off') {
      launcher = el('div', 'dsh-aiui-launcher', baseLauncherStyle() + dim)
      launcher.title = previewReady ? '进入 AIUI 开发模式（可拖动）' : '预览服务启动中…'
      var dot = el('span', 'dsh-aiui-dot')
      launcher.appendChild(dot)
      launcher.appendChild(document.createTextNode('AIUI 开发模式'))
      launcher.addEventListener('pointerdown', function (e) {
        pendingClick = function () { mode = 'console'; panelOpen = true; renderPreviewConsole() }
        startDrag(e, 'launcher')
      })
      root.appendChild(launcher)
    } else {
      consoleBtn = el('div', 'dsh-aiui-console-btn', baseLauncherStyle() + (panelOpen ? 'border-color:#40ff5e;background:rgba(64,255,94,.14);box-shadow:0 0 0 3px rgba(64,255,94,.18), 0 8px 28px rgba(64,255,94,.3);' : '') + dim)
      consoleBtn.title = previewReady ? (panelOpen ? '收起 Preview（可拖动）' : '打开 Preview（可拖动）') : '预览服务启动中，请稍候…'
      var term = el('span', 'dsh-aiui-terminal')
      term.textContent = '>_'
      consoleBtn.appendChild(term)
      consoleBtn.addEventListener('pointerdown', function (e) {
        pendingClick = function () { if (previewReady) { panelOpen = !panelOpen; renderPreviewConsole() } }
        startDrag(e, 'launcher')
      })
      root.appendChild(consoleBtn)
    }
    if (panel) { panel.remove(); panel = null }
    if (mode === 'console' && panelOpen) {
      ensurePanelPos()
      panel = el('div', 'dsh-aiui-panel', 'left:' + panelPos.x + 'px;top:' + panelPos.y + 'px;')
      var head = el('div', 'dsh-aiui-panel-head')
      var title = el('span', 'dsh-aiui-panel-title')
      var pd = el('span', 'dsh-aiui-panel-dot')
      title.appendChild(pd)
      title.appendChild(document.createTextNode('AIUI 开发控制台'))
      head.appendChild(title)
      var actions = el('span', 'dsh-aiui-panel-actions')
      actions.addEventListener('pointerdown', function (e) { e.stopPropagation() })
      var open = el('a', 'dsh-aiui-open')
      open.href = PREVIEW_URL || 'about:blank'; open.target = '_blank'; open.rel = 'noreferrer'; open.textContent = '新窗口 ↗'
      actions.appendChild(open)
      var close = el('button', 'dsh-aiui-close')
      close.type = 'button'; close.textContent = '✕'
      close.addEventListener('click', function () { panelOpen = false; renderPreviewConsole() })
      actions.appendChild(close)
      head.appendChild(actions)
      head.addEventListener('pointerdown', function (e) { pendingClick = null; startDrag(e, 'panel') })
      panel.appendChild(head)
      var frame = el('iframe', 'dsh-aiui-frame')
      frame.src = PREVIEW_URL || 'about:blank'; frame.title = 'AIUI Preview'
      panel.appendChild(frame)
      var foot = el('div', 'dsh-aiui-foot')
      foot.textContent = 'Ink 浏览器运行时 · 视口 480×352 · 图标与窗口均可拖动'
      panel.appendChild(foot)
      root.appendChild(panel)
    }
  }

  /* Ensure the live preview dev server is running; remember its URL. */
  function ensurePreviewReady() {
    fetch('/api/aiui-preview').then(function (r) { return r.json() }).then(function (resp) {
      var url = (resp && resp.ok && resp.running && typeof resp.url === 'string') ? resp.url : null
      var ready = url !== null
      var changed = url !== PREVIEW_URL || ready !== previewReady
      PREVIEW_URL = url
      previewReady = ready
      if (changed && gateState !== 'off') renderPreviewConsole()
      if (!ready && gateState !== 'off') setTimeout(ensurePreviewReady, 1500)
    }).catch(function () { if (gateState !== 'off') setTimeout(ensurePreviewReady, 1500) })
  }

  /* ---- project panel + source viewer ---- */
  var projPanel = null, projBody = null, srcWin = null, srcPos = null, srcPath = null, srcPre = null, srcImg = null

  function showProjectPanel() {
    if (projPanel) return
    projPanel = el('div', 'dsh-aiui-proj')
    var head = el('div', 'dsh-aiui-proj-head')
    var title = el('span', 'dsh-aiui-proj-title')
    title.textContent = 'AIUI 项目'
    head.appendChild(title)
    var refresh = el('button', 'dsh-aiui-proj-btn')
    refresh.type = 'button'; refresh.textContent = '↻'
    refresh.title = '刷新目录树'
    refresh.addEventListener('click', function () { loadProjectTree(true) })
    head.appendChild(refresh)
    var selectBtn = el('button', 'dsh-aiui-proj-btn')
    selectBtn.type = 'button'
    selectBtn.textContent = '选择项目'
    selectBtn.title = '选择/切换 AIUI 项目'
    selectBtn.addEventListener('click', function () { showProjectDialog(true) })
    head.appendChild(selectBtn)
    var toggle = el('button', 'dsh-aiui-proj-toggle')
    toggle.type = 'button'
    toggle.textContent = '»'
    toggle.title = '收起目录树'
    toggle.addEventListener('click', function () { collapseProjectPanel() })
    head.appendChild(toggle)
    projPanel.appendChild(head)
    projBody = el('div', 'dsh-aiui-proj-body')
    projPanel.appendChild(projBody)
    root.appendChild(projPanel)
    loadProjectTree(true)
  }

  var projCollapsed = false
  function collapseProjectPanel() {
    projCollapsed = true
    if (projPanel) projPanel.style.display = 'none'
    if (root.querySelector('#dsh-aiui-proj-restore')) return
    var restore = el('div', 'dsh-aiui-proj-restore')
    restore.title = '展开目录树'
    var arrow = document.createElement('span')
    arrow.textContent = '◀'
    var label = document.createElement('span')
    label.textContent = '项目'
    restore.appendChild(arrow); restore.appendChild(label)
    restore.addEventListener('click', function () { restoreProjectPanel() })
    root.appendChild(restore)
  }
  function restoreProjectPanel() {
    projCollapsed = false
    var restore = root.querySelector('#dsh-aiui-proj-restore')
    if (restore) restore.remove()
    if (projPanel) projPanel.style.display = 'flex'
  }

  function loadProjectTree(first) {
    if (!projBody) return
    if (first) projBody.innerHTML = '<div id="dsh-aiui-proj-note">正在读取项目…</div>'
    fetch('/api/aiui-project').then(function (r) { return r.json() }).then(function (info) {
      if (info && info.ok && info.project) {
        var head = projPanel ? projPanel.querySelector('#dsh-aiui-proj-title') : null
        if (head) head.textContent = info.project.name
        return fetch('/api/aiui-project-tree').then(function (r) { return r.json() })
      }
      return Promise.resolve({ ok: false, error: 'no project' })
    }).then(function (treeResp) {
      if (treeResp && treeResp.ok && treeResp.tree) renderTree(treeResp.tree)
      else if (treeResp && treeResp.error) {
        if (projBody) projBody.innerHTML = '<div id="dsh-aiui-proj-note">目录树加载失败：' + treeResp.error + '</div>'
      } else { renderProjectPicker(); showProjectDialog(false) }
    }).catch(function () {
      if (projBody) projBody.innerHTML = '<div id="dsh-aiui-proj-note">目录树加载失败，请点击 ↻ 重试或重新选择项目</div>'
    })
  }

  /* project picker dialog — appears automatically when no project is set */
  var dialogTried = false
  function showProjectDialog(force) {
    if (dialogTried && !force) return
    dialogTried = true
    if (root.querySelector('#dsh-aiui-dlg')) return
    var dlg = el('div', 'dsh-aiui-dlg')
    var card = el('div', 'dsh-aiui-dlg-card')
    var title = document.createElement('h3')
    title.id = 'dsh-aiui-dlg-title'
    title.textContent = '选择 AIUI 项目'
    var sub = document.createElement('div')
    sub.id = 'dsh-aiui-dlg-sub'
    sub.textContent = '点击"浏览文件夹…"打开系统目录选择器（所选目录需包含 app.json），或从下方候选项目中选择：'
    var browse = el('button', 'dsh-aiui-dlg-btn')
    browse.type = 'button'
    browse.className = 'primary dsh-aiui-dlg-browse'
    browse.textContent = '📁 浏览文件夹…'
    var sep = document.createElement('div')
    sep.id = 'dsh-aiui-dlg-sep'
    sep.textContent = '或选择已发现的项目'
    var list = el('div', 'dsh-aiui-dlg-list')
    list.textContent = '正在扫描候选项目…'
    var err = document.createElement('div')
    err.id = 'dsh-aiui-dlg-err'
    var actions = el('div', 'dsh-aiui-dlg-actions')
    var cancel = el('button', 'dsh-aiui-dlg-btn')
    cancel.type = 'button'; cancel.textContent = '取消'
    actions.appendChild(cancel)
    card.appendChild(title); card.appendChild(sub); card.appendChild(browse)
    card.appendChild(sep); card.appendChild(list); card.appendChild(err); card.appendChild(actions)
    dlg.appendChild(card)
    root.appendChild(dlg)

    function setErr(msg) {
      err.textContent = msg || ''
      err.style.display = msg ? 'block' : 'none'
    }
    function close() {
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg)
    }
    cancel.addEventListener('click', close)
    function pick(path) {
      setErr('')
      fetch('/api/aiui-project-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path }),
      }).then(function (r) { return r.json() }).then(function (sel) {
        if (sel && sel.ok) {
          close()
          // Ensure the panel exists (hero-stage picks have none yet) and shows the tree right away.
          if (!projPanel) showProjectPanel()
          else loadProjectTree(true)
          if (sel.note) console.log('[aiui-dev-console] project note:', sel.note)
          ensurePreviewReady()
        }
        else {
          var detail = ''
          if (sel && sel.checked) detail = '（所选：' + sel.received + '｜检查：' + sel.checked + '）'
          setErr('选择失败：' + ((sel && sel.error) || '未知错误') + detail)
        }
      }).catch(function () { setErr('选择失败：网络错误') })
    }
    browse.addEventListener('click', function () {
      setErr('')
      browse.disabled = true
      browse.textContent = '正在打开系统文件夹选择器…'
      // Drives the harness' own native OS directory chooser (host.pickDirectory).
      fetch('/api/host.pickDirectory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'aiui-pick-' + Date.now(),
          method: 'host.pickDirectory',
          payload: {},
        }),
      }).then(function (r) { return r.json() }).then(function (resp) {
        var result = resp && resp.result
        if (result && result.ok) {
          var path = result.value && result.value.path
          if (path) pick(path)
          else setErr('未选择文件夹（已取消）')
        } else {
          setErr('系统文件夹选择器返回失败，请重试或从下方候选项目中选择')
        }
      }).catch(function () { setErr('系统文件夹选择器不可用，请从下方候选项目中选择') })
        .finally(function () { browse.disabled = false; browse.textContent = '📁 浏览文件夹…' })
    })
    fetch('/api/aiui-projects').then(function (r) { return r.json() }).then(function (resp) {
      list.innerHTML = ''
      if (resp && resp.ok && resp.projects && resp.projects.length) {
        resp.projects.forEach(function (p) {
          var b = el('button', 'dsh-aiui-dlg-item')
          b.type = 'button'
          var ic = document.createElement('span')
          ic.className = 'dsh-aiui-dlg-ic'
          ic.textContent = '📁'
          var name = document.createElement('span')
          name.textContent = p.name
          b.appendChild(ic); b.appendChild(name)
          b.title = p.path
          b.addEventListener('click', function () { pick(p.path) })
          list.appendChild(b)
        })
      } else {
        var none = document.createElement('div')
        none.id = 'dsh-aiui-proj-note'
        none.textContent = '（未发现 AIUI 项目，请在上方输入项目路径）'
        list.appendChild(none)
      }
    }).catch(function () {
      list.innerHTML = ''
      var none = document.createElement('div')
      none.id = 'dsh-aiui-proj-note'
      none.textContent = '（项目扫描失败，请在上方输入项目路径）'
      list.appendChild(none)
    })
  }

  function renderProjectPicker() {
    if (!projBody) return
    projBody.innerHTML = ''
    var note = el('div', 'dsh-aiui-proj-note')
    note.textContent = '尚未选择项目。在对话中告诉助手要开发的 AIUI 项目，或从下方选择：'
    projBody.appendChild(note)
    fetch('/api/aiui-projects').then(function (r) { return r.json() }).then(function (resp) {
      if (!resp || !resp.ok || !resp.projects || !resp.projects.length) {
        var none = el('div', 'dsh-aiui-proj-note')
        none.textContent = '（工作区未发现含 app.json 的 AIUI 项目）'
        projBody.appendChild(none)
        return
      }
      resp.projects.forEach(function (p) {
        var btn = el('button', 'dsh-aiui-proj-pick')
        btn.type = 'button'
        btn.textContent = p.name
        btn.title = p.path
        btn.addEventListener('click', function () {
          fetch('/api/aiui-project-select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p.path }),
          }).then(function (r) { return r.json() }).then(function (sel) {
            if (sel && sel.ok) { loadProjectTree(true); ensurePreviewReady() }
            else {
              projBody.innerHTML = '<div id="dsh-aiui-proj-note">选择失败：' + ((sel && sel.error) || '未知错误') + '</div>'
              setTimeout(function () { loadProjectTree(true) }, 800)
            }
          }).catch(function () {
            projBody.innerHTML = '<div id="dsh-aiui-proj-note">选择失败：网络错误</div>'
            setTimeout(function () { loadProjectTree(true) }, 800)
          })
        })
        projBody.appendChild(btn)
      })
    }).catch(function () {})
  }

  function renderTree(nodes) {
    if (!projBody) return
    projBody.innerHTML = ''
    if (!nodes || !nodes.length) {
      var empty = el('div', 'dsh-aiui-proj-note')
      empty.textContent = '（项目目录为空或没有可显示的文件）'
      projBody.appendChild(empty)
      return
    }
    var ul = el('ul', 'dsh-aiui-tree')
    appendNodes(ul, nodes)
    projBody.appendChild(ul)
  }

  function appendNodes(ul, nodes) {
    nodes.forEach(function (node) {
      var li = document.createElement('li')
      if (node.type === 'dir') {
        var dirRow = document.createElement('div')
        dirRow.className = 'dsh-aiui-dir'
        var arrow = document.createElement('span')
        arrow.className = 'dsh-aiui-arrow'
        arrow.textContent = '▸'
        var ic = document.createElement('span')
        ic.className = 'dsh-aiui-ic'
        ic.textContent = '▣'
        var name = document.createElement('span')
        name.textContent = node.name
        dirRow.appendChild(arrow); dirRow.appendChild(ic); dirRow.appendChild(name)
        var childUl = document.createElement('ul')
        childUl.style.display = 'none'
        if (node.children && node.children.length) appendNodes(childUl, node.children)
        dirRow.addEventListener('click', function () {
          var open = childUl.style.display !== 'none'
          childUl.style.display = open ? 'none' : 'block'
          arrow.textContent = open ? '▸' : '▾'
        })
        li.appendChild(dirRow); li.appendChild(childUl)
      } else {
        var fileRow = document.createElement('div')
        fileRow.className = 'dsh-aiui-file'
        var ic2 = document.createElement('span')
        ic2.className = 'dsh-aiui-ic'
        ic2.textContent = '◈'
        var name2 = document.createElement('span')
        name2.textContent = node.name
        fileRow.appendChild(ic2); fileRow.appendChild(name2)
        fileRow.addEventListener('click', function () { openSource(node.path, node.name) })
        li.appendChild(fileRow)
      }
      ul.appendChild(li)
    })
  }

  function openSource(relPath, name) {
    if (!srcWin) {
      srcWin = el('div', 'dsh-aiui-src', 'right:310px;top:60px;left:auto;')
      var head = el('div', 'dsh-aiui-src-head')
      head.addEventListener('pointerdown', function (e) { pendingClick = null; startDrag(e, 'src') })
      srcPath = el('span', 'dsh-aiui-src-path')
      head.appendChild(srcPath)
      var actions = el('span', 'dsh-aiui-panel-actions')
      actions.addEventListener('pointerdown', function (e) { e.stopPropagation() })
      var close = el('button', 'dsh-aiui-close')
      close.type = 'button'; close.textContent = '✕'
      close.addEventListener('click', function () { if (srcWin) { srcWin.remove(); srcWin = null } })
      actions.appendChild(close)
      head.appendChild(actions)
      srcWin.appendChild(head)
      srcPre = document.createElement('pre')
      srcPre.id = 'dsh-aiui-src-pre'
      srcWin.appendChild(srcPre)
      srcImg = document.createElement('img')
      srcImg.id = 'dsh-aiui-src-img'
      srcWin.appendChild(srcImg)
      root.appendChild(srcWin)
    }
    if (srcPath) srcPath.textContent = relPath
    if (srcPre) srcPre.textContent = '加载中…'
    if (srcImg) { srcImg.src = ''; srcImg.style.display = 'none' }
    fetch('/api/aiui-project-file?path=' + encodeURIComponent(relPath))
      .then(function (r) { return r.json() })
      .then(function (resp) {
        if (resp && resp.ok) {
          if (resp.kind === 'image' && srcImg) {
            srcImg.src = resp.dataUrl
            srcImg.style.display = 'block'
            if (srcPre) srcPre.style.display = 'none'
          } else {
            if (srcImg) srcImg.style.display = 'none'
            if (srcPre) { srcPre.style.display = 'block'; srcPre.textContent = resp.content }
          }
        } else {
          if (srcImg) srcImg.style.display = 'none'
          if (srcPre) { srcPre.style.display = 'block'; srcPre.textContent = '无法读取：' + ((resp && resp.error) || '未知错误') }
        }
      })
      .catch(function () { if (srcPre) srcPre.textContent = '网络错误' })
  }

  /* ---- presence gate: the aiui-dev hero chip AND the running session ---- */
  // Tracks the exact surface ('off' | 'hero' | 'session'), not just a boolean
  // "is anything shown": the hero→session handoff must re-run the mount branch,
  // otherwise a plain boolean would early-return and leave the console unmounted.
  var gateState = 'off'
  function presetMatches(node) {
    var text = node ? (node.textContent || '') : ''
    return text.indexOf(PRESET_TEXT) >= 0 || text.indexOf(PRESET_ID) >= 0
  }
  function sync() {
    var header = document.querySelector('[data-slot="' + HEADER_SLOT + '"]')
    var hero = document.querySelector('[data-slot="conversation.hero.agentPreset"]')
    var inSession = presetMatches(header)
    var inHero = !inSession && presetMatches(hero)
    var next = inSession ? 'session' : (inHero ? 'hero' : 'off')
    if (next === gateState) return
    gateState = next
    if (next === 'off') {
      if (root.parentNode) root.parentNode.removeChild(root)
      return
    }
    // Both the hero chip and a running session mount the full console: the
    // launcher/preview button plus the right-side project tree. The tree
    // surfaces the project picker on its own when no project is set yet.
    if (!style.parentNode) document.head.appendChild(style)
    if (!root.parentNode) document.body.appendChild(root)
    renderPreviewConsole()
    showProjectPanel()
    // Make sure the preview static server (:8765) is running so clicking the
    // icon opens a working preview.
    ensurePreviewReady()
  }

  sync()
  setTimeout(sync, 300)
  setTimeout(sync, 1200)
  new MutationObserver(function () {
    try { sync() } catch (e) { console.warn('[aiui-dev-console] observer err', e) }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })

  console.log('[aiui-dev-console] injected; aiui-dev sessions only')
})()
`
}
