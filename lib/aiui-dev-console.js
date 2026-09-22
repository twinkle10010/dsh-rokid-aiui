import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, resolve, basename, dirname, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
const require2 = createRequire(import.meta.url);
const name = "aiui-dev-console";
const inject = ["webServer", "subprocess", "connection"];
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  return resolve(fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh"));
}
function userPresetDir() {
  return join(resolveDshHome(), ".agent-presets");
}
function bundledPresetDir() {
  return fileURLToPath(new URL("../preset/", import.meta.url));
}
const PRESET_MARKER = ".dsh-bundle-version";
async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  let copied = 0;
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(src, entry.name);
    const target = join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += await copyTree(source, target);
    } else if (entry.isFile()) {
      const [sourceBuf, targetBuf] = await Promise.all([
        readFile(source),
        readFile(target).catch(() => null)
      ]);
      if (targetBuf === null || !sourceBuf.equals(targetBuf)) {
        await writeFile(target, sourceBuf);
        copied += 1;
      }
    }
  }
  return copied;
}
async function syncBundledPreset(version) {
  const dir = join(userPresetDir(), "aiui-dev");
  try {
    const markerPath = join(dir, PRESET_MARKER);
    let marker = null;
    try {
      marker = (await readFile(markerPath, "utf-8")).trim();
    } catch {
    }
    if (marker === version) return { dir, installed: false, copied: 0 };
    const copied = await copyTree(bundledPresetDir(), dir);
    await writeFile(markerPath, version + "\n", "utf-8");
    return { dir, installed: true, copied };
  } catch (error) {
    return { dir, installed: false, copied: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
const MAX_FILE_BYTES = 1048576;
const MAX_TREE_ITEMS = 3e3;
const MAX_TREE_DEPTH = 6;
const MAX_SCAN_DIRS = 400;
const RETRY_COOLDOWN_MS = 3e4;
const IGNORED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "lib",
  ".dsh",
  ".agent-presets",
  "sessions",
  "storages",
  "profiles",
  "aiui-preview",
  "aix-tool",
  "scratch-plugin",
  ".cache",
  ".next",
  "out",
  "build",
  "coverage"
]);
const IMAGE_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp"
};
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function json(res, value) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}
function safeHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, { ok: false, error: messageOf(error), stack: error instanceof Error ? error.stack : void 0 });
    }
  };
}
function connectionOf(ctx) {
  try {
    return Reflect.get(ctx, "connection");
  } catch {
    return void 0;
  }
}
function apiRoute(method, connection, handler) {
  return safeHandler(async (req, res) => {
    if ((req.method ?? "GET").toUpperCase() !== method) {
      res.statusCode = 405;
      res.setHeader("Allow", method);
      json(res, { ok: false, error: `method not allowed; use ${method}` });
      return;
    }
    if (connection !== void 0) {
      const rejection = connection.requestRejection({ headers: req.headers });
      if (rejection !== void 0) {
        res.statusCode = rejection;
        json(res, { ok: false, error: rejection === 401 ? "unauthorized" : "forbidden" });
        return;
      }
    }
    await handler(req, res);
  });
}
function resolveAixCli() {
  try {
    return require2.resolve("@yodaos-pkg/aix-cli");
  } catch {
    return null;
  }
}
async function readProjectInfo(projectFile) {
  try {
    const parsed = JSON.parse(await readFile(projectFile, "utf-8"));
    if (parsed && typeof parsed.path === "string") return { name: String(parsed.name || basename(parsed.path)), path: parsed.path };
    return null;
  } catch {
    return null;
  }
}
async function buildTree(projectRoot, dir, depth, budget) {
  if (depth > MAX_TREE_DEPTH || budget.n <= 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (budget.n <= 0) break;
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    const rel = relative(projectRoot, full).split(sep).join("/");
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      budget.n -= 1;
      const children = await buildTree(projectRoot, full, depth + 1, budget);
      out.push({ name: entry.name, path: rel, type: "dir", children });
    } else if (entry.isFile()) {
      budget.n -= 1;
      out.push({ name: entry.name, path: rel, type: "file" });
    }
  }
  return out;
}
async function discoverProjects(root, maxDepth) {
  const found = [];
  const budget = { dirs: MAX_SCAN_DIRS };
  async function walk(dir, depth) {
    if (depth > maxDepth || budget.dirs <= 0) return;
    const marker = await stat(join(dir, "app.json")).catch(() => null);
    if (marker !== null && marker.isFile()) {
      const rel = relative(root, dir).split(sep).join("/");
      found.push({ name: basename(dir), path: dir, rel: rel === "" ? basename(dir) : rel });
      return;
    }
    if (depth === maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (budget.dirs <= 0) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      budget.dirs -= 1;
      await walk(join(dir, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}
const Config = z.object({
  workspaceRoot: z.string().description("Directory scanned for AIUI projects (directories containing app.json); defaults to $AIUI_WORKSPACE, then the invoking directory."),
  projectFile: z.string().description("Marker file recording the chosen project; defaults to <workspaceRoot>/.aiui/current-project.json."),
  aixCli: z.string().description("Override the resolved @yodaos-pkg/aix-cli entry (dist/cli.js)."),
  aixCwd: z.string().description("Working directory for the `aix preview` child process; defaults to workspaceRoot."),
  presetLabel: z.string().description("Agent-preset display label that activates the console UI."),
  presetId: z.string().description("Agent-preset id that also activates the console UI."),
  scanDepth: z.number().min(0).max(8).description("Directory levels below workspaceRoot scanned for projects (default 3)."),
  previewStartTimeoutMs: z.number().min(1e3).max(12e4).description("How long to wait for `aix preview --dev` to print its URL (default 15000 ms)."),
  legacyPresetSync: z.boolean().description("Also sync the bundled preset into the legacy $DSH_HOME/.agent-presets root (default false; the current Harness reads preset declaration rows instead).")
});
const CLIENT_SCRIPT_URL = new URL("../client/injected.js", import.meta.url);
async function loadClientScript(presetLabel, presetId) {
  const template = await readFile(fileURLToPath(CLIENT_SCRIPT_URL), "utf-8");
  const script = template.replace('"__AIUI_PRESET_LABEL__"', JSON.stringify(presetLabel)).replace('"__AIUI_PRESET_ID__"', JSON.stringify(presetId));
  return script.replace(/<\/script/gi, "<\\/script");
}
async function apply(ctx, config = {}) {
  const workspaceRoot = config.workspaceRoot ?? process.env.AIUI_WORKSPACE ?? process.cwd();
  const projectFile = config.projectFile ?? join(workspaceRoot, ".aiui", "current-project.json");
  const aixCwd = config.aixCwd ?? workspaceRoot;
  const aixCli = config.aixCli ?? resolveAixCli();
  const presetLabel = config.presetLabel ?? "AIUI \u5F00\u53D1\u6A21\u5F0F";
  const presetId = config.presetId ?? "aiui-dev";
  const scanDepth = config.scanDepth ?? 3;
  const previewStartTimeoutMs = config.previewStartTimeoutMs ?? 15e3;
  const connection = connectionOf(ctx);
  if (connection === void 0) {
    ctx.logger.warn("dsh-rokid-aiui: the `connection` service is missing \u2014 /api/aiui-* routes stay unfenced");
  }
  if (config.legacyPresetSync === true) {
    const presetSync = await syncBundledPreset(require2("../package.json").version);
    if (presetSync.error !== void 0) {
      ctx.logger.warn(`dsh-rokid-aiui: could not sync the bundled legacy preset (${presetSync.error})`);
    } else if (presetSync.installed) {
      ctx.logger.info(`dsh-rokid-aiui: synced legacy agent preset "aiui-dev" (${presetSync.copied} files) \u2192 ${presetSync.dir}`);
    }
  } else {
    ctx.logger.info('dsh-rokid-aiui: legacy preset sync is off; the "AIUI \u5F00\u53D1\u6A21\u5F0F" preset comes from the dsh-aiui-preset bundle');
  }
  let devHandle = null;
  let devUrl = null;
  let devProject = null;
  let devError = null;
  let devErrorAt = 0;
  let devErrorProject = null;
  let ensurePromise = null;
  function recordDevError(projectPath, message) {
    devError = message;
    devErrorAt = Date.now();
    devErrorProject = projectPath;
  }
  function clearDevError() {
    devError = null;
    devErrorAt = 0;
    devErrorProject = null;
  }
  function previewUrlFrom(text) {
    const match = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?/.exec(text);
    return match ? match[0] : null;
  }
  function collectedText(handle, stream) {
    const reader = handle.collected[stream];
    return reader ? reader.readFrom(0).text : "";
  }
  async function waitForPreviewUrl(handle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = previewUrlFrom(collectedText(handle, "stdout")) ?? previewUrlFrom(collectedText(handle, "stderr"));
      if (url !== null) return url;
      if (devHandle !== handle) return null;
      await new Promise((resolve2) => setTimeout(resolve2, 200));
    }
    return null;
  }
  function stopDevServer() {
    const handle = devHandle;
    devHandle = null;
    devUrl = null;
    devProject = null;
    if (handle) {
      try {
        handle.terminate();
      } catch {
      }
    }
  }
  function watchPreviewExit(handle, projectPath) {
    void handle.done.then((outcome) => {
      if (devHandle !== handle) return;
      devHandle = null;
      devUrl = null;
      devProject = null;
      const reason = outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit code ${outcome.exitCode}`;
      recordDevError(projectPath, `aix preview \u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF08${reason}\uFF09`);
    }).catch((error) => {
      if (devHandle !== handle) return;
      devHandle = null;
      devUrl = null;
      devProject = null;
      recordDevError(projectPath, `aix preview \u8FDB\u7A0B\u5F02\u5E38\uFF1A${messageOf(error)}`);
    });
  }
  async function ensureDevServer(projectPath, force) {
    if (devUrl !== null && devProject === projectPath) {
      return { running: true, url: devUrl, error: null, project: projectPath };
    }
    if (devErrorProject !== null && devErrorProject !== projectPath) clearDevError();
    if (!force && devError !== null && devErrorProject === projectPath && Date.now() < devErrorAt + RETRY_COOLDOWN_MS) {
      return { running: false, url: null, error: devError, project: projectPath };
    }
    await stopDevServer();
    if (aixCli === null) {
      recordDevError(projectPath, "aix CLI \u672A\u627E\u5230\uFF1A@yodaos-pkg/aix-cli \u662F\u672C bundle \u7684\u4F9D\u8D56");
      return { running: false, url: null, error: devError, project: projectPath };
    }
    let nodePath;
    try {
      nodePath = await ctx.subprocess.resolveExecutable("node");
    } catch (error) {
      recordDevError(projectPath, `\u65E0\u6CD5\u89E3\u6790 node \u53EF\u6267\u884C\u6587\u4EF6\uFF1A${messageOf(error)}`);
      return { running: false, url: null, error: devError, project: projectPath };
    }
    let handle;
    try {
      handle = ctx.subprocess.spawn({
        argv: [nodePath, aixCli, "preview", projectPath, "--dev"],
        cwd: aixCwd,
        stdio: { stdin: "ignore", stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 5e3
      });
    } catch (error) {
      recordDevError(projectPath, `\u65E0\u6CD5\u542F\u52A8 aix preview\uFF1A${messageOf(error)}`);
      return { running: false, url: null, error: devError, project: projectPath };
    }
    clearDevError();
    devHandle = handle;
    devProject = projectPath;
    watchPreviewExit(handle, projectPath);
    const url = await waitForPreviewUrl(handle, previewStartTimeoutMs);
    if (url !== null && devHandle === handle) {
      devUrl = url;
      clearDevError();
      return { running: true, url, error: null, project: projectPath };
    }
    if (devHandle !== handle) return { running: false, url: null, error: devError, project: projectPath };
    const errText = collectedText(handle, "stderr").trim() || collectedText(handle, "stdout").trim();
    await stopDevServer();
    recordDevError(projectPath, errText ? errText.split(/\r?\n/).slice(-6).join("\n") : `aix preview --dev \u672A\u5728 ${previewStartTimeoutMs}ms \u5185\u8F93\u51FA\u9884\u89C8\u5730\u5740`);
    return { running: false, url: null, error: devError, project: projectPath };
  }
  ctx.effect(() => () => {
    stopDevServer();
  }, "aiui-dev-console: stop preview dev server");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-preview",
    handler: apiRoute("GET", connection, async (req, res) => {
      const force = new URL(req.url ?? "/", "http://localhost").searchParams.get("retry") === "1";
      const project = await readProjectInfo(projectFile);
      if (!project) {
        stopDevServer();
        json(res, { ok: true, running: false, url: null, error: null, project: null });
        return;
      }
      if (!ensurePromise) ensurePromise = ensureDevServer(project.path, force).finally(() => {
        ensurePromise = null;
      });
      const status = await ensurePromise;
      json(res, { ok: true, running: status.running, url: status.url, error: status.error, project: status.project });
    })
  }), "aiui-dev-console: /api/aiui-preview");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project",
    handler: apiRoute("GET", connection, async (_req, res) => {
      json(res, { ok: true, project: await readProjectInfo(projectFile) });
    })
  }), "aiui-dev-console: /api/aiui-project");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-projects",
    handler: apiRoute("GET", connection, async (_req, res) => {
      const projects = await discoverProjects(workspaceRoot, scanDepth);
      json(res, { ok: true, workspaceRoot, projects });
    })
  }), "aiui-dev-console: /api/aiui-projects");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project-select",
    handler: apiRoute("POST", connection, async (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const raw = String(payload.path || "").trim().replace(/^["']|["']$/g, "");
          const root = resolve(raw);
          let projectRoot = root;
          let marker = await stat(join(projectRoot, "app.json")).catch(() => null);
          let note = "";
          if (!marker || !marker.isFile()) {
            const children = await readdir(projectRoot, { withFileTypes: true }).catch(() => []);
            const candidates = [];
            for (const entry of children) {
              if (!entry.isDirectory()) continue;
              const m = await stat(join(projectRoot, entry.name, "app.json")).catch(() => null);
              if (m && m.isFile()) candidates.push(entry.name);
            }
            if (candidates.length === 1) {
              projectRoot = join(projectRoot, candidates[0]);
              marker = await stat(join(projectRoot, "app.json")).catch(() => null);
              note = "\uFF08\u6240\u9009\u76EE\u5F55\u65E0 app.json\uFF0C\u5DF2\u81EA\u52A8\u5B9A\u4F4D\u5230\u5B50\u76EE\u5F55\uFF09";
            }
          }
          if (!marker || !marker.isFile()) {
            const parent = dirname(projectRoot);
            const parentMarker = await stat(join(parent, "app.json")).catch(() => null);
            if (parentMarker && parentMarker.isFile()) {
              projectRoot = parent;
              marker = parentMarker;
              note = "\uFF08\u6240\u9009\u76EE\u5F55\u65E0 app.json\uFF0C\u5DF2\u81EA\u52A8\u5B9A\u4F4D\u5230\u7236\u76EE\u5F55\uFF09";
            }
          }
          if (!marker || !marker.isFile()) {
            json(res, { ok: false, error: "\u4E0D\u662F AIUI \u9879\u76EE\uFF08\u7F3A\u5C11 app.json\uFF09", received: raw, checked: join(root, "app.json") });
            return;
          }
          await mkdir(dirname(projectFile), { recursive: true });
          await writeFile(projectFile, JSON.stringify({ name: basename(projectRoot), path: projectRoot, at: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
          if (devProject !== null && devProject !== projectRoot) stopDevServer();
          json(res, { ok: true, name: basename(projectRoot), path: projectRoot, note });
        } catch (error) {
          json(res, { ok: false, error: messageOf(error) });
        }
      });
    })
  }), "aiui-dev-console: /api/aiui-project-select");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project-tree",
    handler: apiRoute("GET", connection, async (_req, res) => {
      const project = await readProjectInfo(projectFile);
      if (!project) {
        json(res, { ok: false, error: "no project selected" });
        return;
      }
      const tree = await buildTree(project.path, project.path, 0, { n: MAX_TREE_ITEMS });
      json(res, { ok: true, name: project.name, path: project.path, tree });
    })
  }), "aiui-dev-console: /api/aiui-project-tree");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project-file",
    handler: apiRoute("GET", connection, async (req, res) => {
      const project = await readProjectInfo(projectFile);
      if (!project) {
        json(res, { ok: false, error: "no project selected" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = String(url.searchParams.get("path") || "");
      const root = resolve(project.path);
      const target = resolve(root, rel);
      if (target !== root && !target.startsWith(root + sep)) {
        json(res, { ok: false, error: "invalid path" });
        return;
      }
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        json(res, { ok: false, error: "not a file" });
        return;
      }
      if (info.size > MAX_FILE_BYTES) {
        json(res, { ok: false, error: "file too large (>1 MiB)" });
        return;
      }
      const buf = await readFile(target).catch(() => null);
      if (buf === null) {
        json(res, { ok: false, error: "unreadable" });
        return;
      }
      const dot = target.lastIndexOf(".");
      const ext = dot > target.lastIndexOf(sep) ? target.slice(dot).toLowerCase() : "";
      const mime = IMAGE_EXT[ext];
      if (mime !== void 0) {
        json(res, { ok: true, path: rel, kind: "image", mime, dataUrl: "data:" + mime + ";base64," + buf.toString("base64") });
        return;
      }
      if (buf.includes(0)) {
        json(res, { ok: false, error: "binary file\uFF0C\u65E0\u6CD5\u9884\u89C8" });
        return;
      }
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        try {
          content = new TextDecoder("gbk").decode(buf);
        } catch {
          content = buf.toString("utf-8");
        }
      }
      json(res, { ok: true, path: rel, kind: "text", content });
    })
  }), "aiui-dev-console: /api/aiui-project-file");
  try {
    const clientScript = await loadClientScript(presetLabel, presetId);
    ctx.effect(
      () => ctx.webServer.tapIndex((html) => html.replace("</body>", `<script>${clientScript}</script></body>`)),
      "aiui-dev-console: index tap"
    );
  } catch (error) {
    ctx.logger.warn(`dsh-rokid-aiui: could not read client/injected.js (${messageOf(error)}) \u2014 the console UI stays unmounted`);
  }
}
export {
  Config,
  apply,
  bundledPresetDir,
  discoverProjects,
  inject,
  name,
  resolveDshHome,
  syncBundledPreset,
  userPresetDir
};
