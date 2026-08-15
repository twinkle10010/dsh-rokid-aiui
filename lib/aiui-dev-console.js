import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve, basename, dirname, relative, sep } from "node:path";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const name = "aiui-dev-console";
const inject = ["webServer", "subprocess"];
const MAX_FILE_BYTES = 1048576;
const MAX_TREE_ITEMS = 3e3;
const MAX_TREE_DEPTH = 6;
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
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : void 0;
      json(res, { ok: false, error: message, stack });
    }
  };
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
function apply(ctx, config = {}) {
  const workspaceRoot = config.workspaceRoot ?? process.env.AIUI_WORKSPACE ?? process.cwd();
  const projectFile = config.projectFile ?? join(workspaceRoot, ".aiui", "current-project.json");
  const aixCwd = config.aixCwd ?? workspaceRoot;
  const aixCli = config.aixCli ?? resolveAixCli();
  const presetLabel = config.presetLabel ?? "AIUI \u5F00\u53D1\u6A21\u5F0F";
  const presetId = config.presetId ?? "aiui-dev";
  let devHandle = null;
  let devUrl = null;
  let devProject = null;
  let ensurePromise = null;
  function previewUrlFrom(text) {
    const match = /https?:\/\/127\.0\.0\.1:\d+\//.exec(text);
    return match ? match[0] : null;
  }
  async function waitForPreviewUrl(handle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
      const url = previewUrlFrom(text);
      if (url) return url;
      await new Promise((resolve2) => setTimeout(resolve2, 200));
    }
    return null;
  }
  async function stopDevServer() {
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
  async function ensureDevServer(projectPath) {
    if (devUrl !== null && devProject === projectPath) return { running: true, url: devUrl };
    await stopDevServer();
    if (!aixCli) return { running: false, error: "aix CLI not found: @yodaos-pkg/aix-cli is a dependency of this bundle" };
    const nodePath = await ctx.subprocess.resolveExecutable("node");
    const handle = ctx.subprocess.spawn({
      argv: [nodePath, aixCli, "preview", projectPath, "--dev"],
      cwd: aixCwd,
      stdio: { stdin: "ignore", stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 5e3
    });
    devHandle = handle;
    devProject = projectPath;
    const url = await waitForPreviewUrl(handle, 1e4);
    if (url !== null) {
      devUrl = url;
      return { running: true, url };
    }
    const errText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    await stopDevServer();
    return { running: false, error: errText || "aix preview --dev did not report a URL in time" };
  }
  ctx.effect(() => () => {
    void stopDevServer();
  }, "aiui-dev-console: stop preview dev server");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-preview",
    handler: safeHandler(async (_req, res) => {
      const project = await readProjectInfo(projectFile);
      if (!project) {
        await stopDevServer();
        json(res, { ok: true, running: false, url: null });
        return;
      }
      if (!ensurePromise) ensurePromise = ensureDevServer(project.path).finally(() => {
        ensurePromise = null;
      });
      const result = await ensurePromise;
      json(res, { ok: true, running: result.running, url: result.url ?? null, error: result.error });
    })
  }), "aiui-dev-console: /api/aiui-preview");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project",
    handler: safeHandler(async (_req, res) => {
      json(res, { ok: true, project: await readProjectInfo(projectFile) });
    })
  }), "aiui-dev-console: /api/aiui-project");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-projects",
    handler: safeHandler(async (_req, res) => {
      const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
      const projects = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
        const marker = await stat(join(workspaceRoot, entry.name, "app.json")).catch(() => null);
        if (marker && marker.isFile()) projects.push({ name: entry.name, path: join(workspaceRoot, entry.name) });
      }
      json(res, { ok: true, projects });
    })
  }), "aiui-dev-console: /api/aiui-projects");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project-select",
    handler: safeHandler(async (req, res) => {
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
          await writeFile(projectFile, JSON.stringify({ name: basename(projectRoot), path: projectRoot, at: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
          json(res, { ok: true, name: basename(projectRoot), path: projectRoot, note });
        } catch (error) {
          json(res, { ok: false, error: String(error.message || error) });
        }
      });
    })
  }), "aiui-dev-console: /api/aiui-project-select");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/aiui-project-tree",
    handler: safeHandler(async (_req, res) => {
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
    handler: safeHandler(async (req, res) => {
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
      const ext = target.slice(target.lastIndexOf(".")).toLowerCase();
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
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => html.replace(
      "</body>",
      `<script>${buildInjectedScript(presetLabel, presetId)}</script></body>`
    )),
    "aiui-dev-console: index tap"
  );
}
function buildInjectedScript(presetLabel, presetId) {
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
    /* project panel (right) \u2014 theme-aligned colors */
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
    /* source viewer \u2014 theme-aligned colors */
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
      launcher.title = previewReady ? '\u8FDB\u5165 AIUI \u5F00\u53D1\u6A21\u5F0F\uFF08\u53EF\u62D6\u52A8\uFF09' : '\u9884\u89C8\u670D\u52A1\u542F\u52A8\u4E2D\u2026'
      var dot = el('span', 'dsh-aiui-dot')
      launcher.appendChild(dot)
      launcher.appendChild(document.createTextNode('AIUI \u5F00\u53D1\u6A21\u5F0F'))
      launcher.addEventListener('pointerdown', function (e) {
        pendingClick = function () { mode = 'console'; panelOpen = true; renderPreviewConsole() }
        startDrag(e, 'launcher')
      })
      root.appendChild(launcher)
    } else {
      consoleBtn = el('div', 'dsh-aiui-console-btn', baseLauncherStyle() + (panelOpen ? 'border-color:#40ff5e;background:rgba(64,255,94,.14);box-shadow:0 0 0 3px rgba(64,255,94,.18), 0 8px 28px rgba(64,255,94,.3);' : '') + dim)
      consoleBtn.title = previewReady ? (panelOpen ? '\u6536\u8D77 Preview\uFF08\u53EF\u62D6\u52A8\uFF09' : '\u6253\u5F00 Preview\uFF08\u53EF\u62D6\u52A8\uFF09') : '\u9884\u89C8\u670D\u52A1\u542F\u52A8\u4E2D\uFF0C\u8BF7\u7A0D\u5019\u2026'
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
      title.appendChild(document.createTextNode('AIUI \u5F00\u53D1\u63A7\u5236\u53F0'))
      head.appendChild(title)
      var actions = el('span', 'dsh-aiui-panel-actions')
      actions.addEventListener('pointerdown', function (e) { e.stopPropagation() })
      var open = el('a', 'dsh-aiui-open')
      open.href = PREVIEW_URL || 'about:blank'; open.target = '_blank'; open.rel = 'noreferrer'; open.textContent = '\u65B0\u7A97\u53E3 \u2197'
      actions.appendChild(open)
      var close = el('button', 'dsh-aiui-close')
      close.type = 'button'; close.textContent = '\u2715'
      close.addEventListener('click', function () { panelOpen = false; renderPreviewConsole() })
      actions.appendChild(close)
      head.appendChild(actions)
      head.addEventListener('pointerdown', function (e) { pendingClick = null; startDrag(e, 'panel') })
      panel.appendChild(head)
      var frame = el('iframe', 'dsh-aiui-frame')
      frame.src = PREVIEW_URL || 'about:blank'; frame.title = 'AIUI Preview'
      panel.appendChild(frame)
      var foot = el('div', 'dsh-aiui-foot')
      foot.textContent = 'Ink \u6D4F\u89C8\u5668\u8FD0\u884C\u65F6 \xB7 \u89C6\u53E3 480\xD7352 \xB7 \u56FE\u6807\u4E0E\u7A97\u53E3\u5747\u53EF\u62D6\u52A8'
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
    title.textContent = 'AIUI \u9879\u76EE'
    head.appendChild(title)
    var refresh = el('button', 'dsh-aiui-proj-btn')
    refresh.type = 'button'; refresh.textContent = '\u21BB'
    refresh.title = '\u5237\u65B0\u76EE\u5F55\u6811'
    refresh.addEventListener('click', function () { loadProjectTree(true) })
    head.appendChild(refresh)
    var selectBtn = el('button', 'dsh-aiui-proj-btn')
    selectBtn.type = 'button'
    selectBtn.textContent = '\u9009\u62E9\u9879\u76EE'
    selectBtn.title = '\u9009\u62E9/\u5207\u6362 AIUI \u9879\u76EE'
    selectBtn.addEventListener('click', function () { showProjectDialog(true) })
    head.appendChild(selectBtn)
    var toggle = el('button', 'dsh-aiui-proj-toggle')
    toggle.type = 'button'
    toggle.textContent = '\xBB'
    toggle.title = '\u6536\u8D77\u76EE\u5F55\u6811'
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
    restore.title = '\u5C55\u5F00\u76EE\u5F55\u6811'
    var arrow = document.createElement('span')
    arrow.textContent = '\u25C0'
    var label = document.createElement('span')
    label.textContent = '\u9879\u76EE'
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
    if (first) projBody.innerHTML = '<div id="dsh-aiui-proj-note">\u6B63\u5728\u8BFB\u53D6\u9879\u76EE\u2026</div>'
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
        if (projBody) projBody.innerHTML = '<div id="dsh-aiui-proj-note">\u76EE\u5F55\u6811\u52A0\u8F7D\u5931\u8D25\uFF1A' + treeResp.error + '</div>'
      } else { renderProjectPicker(); showProjectDialog(false) }
    }).catch(function () {
      if (projBody) projBody.innerHTML = '<div id="dsh-aiui-proj-note">\u76EE\u5F55\u6811\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u70B9\u51FB \u21BB \u91CD\u8BD5\u6216\u91CD\u65B0\u9009\u62E9\u9879\u76EE</div>'
    })
  }

  /* project picker dialog \u2014 appears automatically when no project is set */
  var dialogTried = false
  function showProjectDialog(force) {
    if (dialogTried && !force) return
    dialogTried = true
    if (root.querySelector('#dsh-aiui-dlg')) return
    var dlg = el('div', 'dsh-aiui-dlg')
    var card = el('div', 'dsh-aiui-dlg-card')
    var title = document.createElement('h3')
    title.id = 'dsh-aiui-dlg-title'
    title.textContent = '\u9009\u62E9 AIUI \u9879\u76EE'
    var sub = document.createElement('div')
    sub.id = 'dsh-aiui-dlg-sub'
    sub.textContent = '\u70B9\u51FB"\u6D4F\u89C8\u6587\u4EF6\u5939\u2026"\u6253\u5F00\u7CFB\u7EDF\u76EE\u5F55\u9009\u62E9\u5668\uFF08\u6240\u9009\u76EE\u5F55\u9700\u5305\u542B app.json\uFF09\uFF0C\u6216\u4ECE\u4E0B\u65B9\u5019\u9009\u9879\u76EE\u4E2D\u9009\u62E9\uFF1A'
    var browse = el('button', 'dsh-aiui-dlg-btn')
    browse.type = 'button'
    browse.className = 'primary dsh-aiui-dlg-browse'
    browse.textContent = '\u{1F4C1} \u6D4F\u89C8\u6587\u4EF6\u5939\u2026'
    var sep = document.createElement('div')
    sep.id = 'dsh-aiui-dlg-sep'
    sep.textContent = '\u6216\u9009\u62E9\u5DF2\u53D1\u73B0\u7684\u9879\u76EE'
    var list = el('div', 'dsh-aiui-dlg-list')
    list.textContent = '\u6B63\u5728\u626B\u63CF\u5019\u9009\u9879\u76EE\u2026'
    var err = document.createElement('div')
    err.id = 'dsh-aiui-dlg-err'
    var actions = el('div', 'dsh-aiui-dlg-actions')
    var cancel = el('button', 'dsh-aiui-dlg-btn')
    cancel.type = 'button'; cancel.textContent = '\u53D6\u6D88'
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
          if (sel && sel.checked) detail = '\uFF08\u6240\u9009\uFF1A' + sel.received + '\uFF5C\u68C0\u67E5\uFF1A' + sel.checked + '\uFF09'
          setErr('\u9009\u62E9\u5931\u8D25\uFF1A' + ((sel && sel.error) || '\u672A\u77E5\u9519\u8BEF') + detail)
        }
      }).catch(function () { setErr('\u9009\u62E9\u5931\u8D25\uFF1A\u7F51\u7EDC\u9519\u8BEF') })
    }
    browse.addEventListener('click', function () {
      setErr('')
      browse.disabled = true
      browse.textContent = '\u6B63\u5728\u6253\u5F00\u7CFB\u7EDF\u6587\u4EF6\u5939\u9009\u62E9\u5668\u2026'
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
          else setErr('\u672A\u9009\u62E9\u6587\u4EF6\u5939\uFF08\u5DF2\u53D6\u6D88\uFF09')
        } else {
          setErr('\u7CFB\u7EDF\u6587\u4EF6\u5939\u9009\u62E9\u5668\u8FD4\u56DE\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u6216\u4ECE\u4E0B\u65B9\u5019\u9009\u9879\u76EE\u4E2D\u9009\u62E9')
        }
      }).catch(function () { setErr('\u7CFB\u7EDF\u6587\u4EF6\u5939\u9009\u62E9\u5668\u4E0D\u53EF\u7528\uFF0C\u8BF7\u4ECE\u4E0B\u65B9\u5019\u9009\u9879\u76EE\u4E2D\u9009\u62E9') })
        .finally(function () { browse.disabled = false; browse.textContent = '\u{1F4C1} \u6D4F\u89C8\u6587\u4EF6\u5939\u2026' })
    })
    fetch('/api/aiui-projects').then(function (r) { return r.json() }).then(function (resp) {
      list.innerHTML = ''
      if (resp && resp.ok && resp.projects && resp.projects.length) {
        resp.projects.forEach(function (p) {
          var b = el('button', 'dsh-aiui-dlg-item')
          b.type = 'button'
          var ic = document.createElement('span')
          ic.className = 'dsh-aiui-dlg-ic'
          ic.textContent = '\u{1F4C1}'
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
        none.textContent = '\uFF08\u672A\u53D1\u73B0 AIUI \u9879\u76EE\uFF0C\u8BF7\u5728\u4E0A\u65B9\u8F93\u5165\u9879\u76EE\u8DEF\u5F84\uFF09'
        list.appendChild(none)
      }
    }).catch(function () {
      list.innerHTML = ''
      var none = document.createElement('div')
      none.id = 'dsh-aiui-proj-note'
      none.textContent = '\uFF08\u9879\u76EE\u626B\u63CF\u5931\u8D25\uFF0C\u8BF7\u5728\u4E0A\u65B9\u8F93\u5165\u9879\u76EE\u8DEF\u5F84\uFF09'
      list.appendChild(none)
    })
  }

  function renderProjectPicker() {
    if (!projBody) return
    projBody.innerHTML = ''
    var note = el('div', 'dsh-aiui-proj-note')
    note.textContent = '\u5C1A\u672A\u9009\u62E9\u9879\u76EE\u3002\u5728\u5BF9\u8BDD\u4E2D\u544A\u8BC9\u52A9\u624B\u8981\u5F00\u53D1\u7684 AIUI \u9879\u76EE\uFF0C\u6216\u4ECE\u4E0B\u65B9\u9009\u62E9\uFF1A'
    projBody.appendChild(note)
    fetch('/api/aiui-projects').then(function (r) { return r.json() }).then(function (resp) {
      if (!resp || !resp.ok || !resp.projects || !resp.projects.length) {
        var none = el('div', 'dsh-aiui-proj-note')
        none.textContent = '\uFF08\u5DE5\u4F5C\u533A\u672A\u53D1\u73B0\u542B app.json \u7684 AIUI \u9879\u76EE\uFF09'
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
              projBody.innerHTML = '<div id="dsh-aiui-proj-note">\u9009\u62E9\u5931\u8D25\uFF1A' + ((sel && sel.error) || '\u672A\u77E5\u9519\u8BEF') + '</div>'
              setTimeout(function () { loadProjectTree(true) }, 800)
            }
          }).catch(function () {
            projBody.innerHTML = '<div id="dsh-aiui-proj-note">\u9009\u62E9\u5931\u8D25\uFF1A\u7F51\u7EDC\u9519\u8BEF</div>'
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
      empty.textContent = '\uFF08\u9879\u76EE\u76EE\u5F55\u4E3A\u7A7A\u6216\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6587\u4EF6\uFF09'
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
        arrow.textContent = '\u25B8'
        var ic = document.createElement('span')
        ic.className = 'dsh-aiui-ic'
        ic.textContent = '\u25A3'
        var name = document.createElement('span')
        name.textContent = node.name
        dirRow.appendChild(arrow); dirRow.appendChild(ic); dirRow.appendChild(name)
        var childUl = document.createElement('ul')
        childUl.style.display = 'none'
        if (node.children && node.children.length) appendNodes(childUl, node.children)
        dirRow.addEventListener('click', function () {
          var open = childUl.style.display !== 'none'
          childUl.style.display = open ? 'none' : 'block'
          arrow.textContent = open ? '\u25B8' : '\u25BE'
        })
        li.appendChild(dirRow); li.appendChild(childUl)
      } else {
        var fileRow = document.createElement('div')
        fileRow.className = 'dsh-aiui-file'
        var ic2 = document.createElement('span')
        ic2.className = 'dsh-aiui-ic'
        ic2.textContent = '\u25C8'
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
      close.type = 'button'; close.textContent = '\u2715'
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
    if (srcPre) srcPre.textContent = '\u52A0\u8F7D\u4E2D\u2026'
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
          if (srcPre) { srcPre.style.display = 'block'; srcPre.textContent = '\u65E0\u6CD5\u8BFB\u53D6\uFF1A' + ((resp && resp.error) || '\u672A\u77E5\u9519\u8BEF') }
        }
      })
      .catch(function () { if (srcPre) srcPre.textContent = '\u7F51\u7EDC\u9519\u8BEF' })
  }

  /* ---- presence gate: the aiui-dev hero chip AND the running session ---- */
  // Tracks the exact surface ('off' | 'hero' | 'session'), not just a boolean
  // "is anything shown": the hero\u2192session handoff must re-run the mount branch,
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
`;
}
export {
  apply,
  inject,
  name
};
