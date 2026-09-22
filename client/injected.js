/**
 * AIUI Dev Console — browser-side script injected into the Harness index page.
 *
 * Lives in its own file (not a host-side template literal) so it can be edited,
 * linted and syntax-checked as ordinary JavaScript; the host reads it once at
 * activation and substitutes the two quoted placeholder tokens below with the
 * JSON encoding of the configured preset label and id.
 *
 * Everything is plain DOM: no framework, no client bundle, no runtime build.
 */
(function () {
  var KEY = 'dsh-aiui-dev-console'
  if (document.getElementById(KEY)) return

  var PREVIEW_URL = null   // set from /api/aiui-preview (the `aix preview --dev` URL)
  var PREVIEW_ERROR = null // last reported start failure, shown instead of a blank frame
  var PRESET_TEXT = "__AIUI_PRESET_LABEL__"
  var PRESET_ID = "__AIUI_PRESET_ID__"
  var HEADER_SLOT = 'conversation.session.header.actions'
  var HEARTBEAT_MS = 5000

  var CSS = '' +
    '#dsh-aiui-dev-console{position:fixed;inset:0;pointer-events:none;z-index:9500;}' +
    /* preview console */
    '#dsh-aiui-launcher{pointer-events:auto;position:fixed;left:16px;bottom:16px;display:flex;align-items:center;gap:8px;' +
    'padding:8px 14px;border-radius:999px;border:1px solid rgba(64,255,94,.55);background:rgba(0,0,0,.82);color:#40ff5e;' +
    'font-size:13px;font-weight:600;cursor:grab;user-select:none;touch-action:none;box-shadow:0 6px 24px rgba(0,0,0,.45);' +
    'font-family:inherit;line-height:1.4;}' +
    '#dsh-aiui-launcher.dsh-aiui-err{border-color:rgba(248,113,113,.75);color:#fca5a5;}' +
    '#dsh-aiui-console-btn{pointer-events:auto;position:fixed;left:16px;bottom:16px;width:46px;height:46px;border-radius:12px;' +
    'border:1px solid rgba(64,255,94,.5);background:rgba(0,0,0,.85);color:#40ff5e;cursor:grab;user-select:none;touch-action:none;' +
    'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 24px rgba(0,0,0,.45);font-family:inherit;}' +
    '#dsh-aiui-console-btn:hover{border-color:#40ff5e;box-shadow:0 8px 28px rgba(64,255,94,.3)}' +
    '#dsh-aiui-console-btn.dsh-aiui-err{border-color:rgba(248,113,113,.75);color:#fca5a5;}' +
    '#dsh-aiui-terminal{font-family:Consolas,Menlo,monospace;font-size:15px;font-weight:700;letter-spacing:-1px;pointer-events:none;}' +
    '#dsh-aiui-dot{width:8px;height:8px;border-radius:50%;background:#40ff5e;box-shadow:0 0 8px #40ff5e;animation:dshAiuiPulse 2s infinite;}' +
    '#dsh-aiui-dot.dsh-aiui-err{background:#f87171;box-shadow:0 0 8px #f87171;}' +
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
    '#dsh-aiui-open.dsh-aiui-off{opacity:.4;pointer-events:none;}' +
    '#dsh-aiui-close{background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);border:1px solid var(--dsw-alias-border-l2);' +
    'color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;line-height:1;padding:4px 9px;border-radius:8px;font-family:inherit;}' +
    '#dsh-aiui-close:hover{color:#fff;background:rgba(220,38,38,.8);border-color:rgba(220,38,38,.8)}' +
    '#dsh-aiui-frame{width:100%;height:620px;border:none;display:block;background:#fff;}' +
    '#dsh-aiui-frame-ph{width:100%;height:620px;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;' +
    'color:rgba(232,255,233,.75);font-size:13px;line-height:1.7;background:rgba(0,0,0,.35);text-align:center;padding:24px;box-sizing:border-box;}' +
    '#dsh-aiui-frame-ph code{font-family:Consolas,Menlo,monospace;font-size:12px;color:#fca5a5;word-break:break-all;max-width:80%;}' +
    '#dsh-aiui-foot{display:flex;align-items:center;gap:10px;font-size:11px;opacity:.75;padding:6px 14px;border-top:1px solid rgba(64,255,94,.15);color:rgba(232,255,233,.7);}' +
    '#dsh-aiui-foot-retry{color:#40ff5e;cursor:pointer;text-decoration:underline;}' +
    '#dsh-aiui-foot-err{color:#fca5a5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}' +
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
    '#dsh-aiui-proj-pick-sub{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
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
    '#dsh-aiui-dlg-item .dsh-aiui-dlg-txt{display:flex;flex-direction:column;overflow:hidden;}' +
    '#dsh-aiui-dlg-item .dsh-aiui-dlg-txt small{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
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

  /* ---- preview console ---- */
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
    var errCls = (!previewReady && PREVIEW_ERROR) ? ' dsh-aiui-err' : ''
    if (mode === 'off') {
      launcher = el('div', 'dsh-aiui-launcher', baseLauncherStyle() + dim)
      if (errCls) launcher.className = errCls.trim()
      launcher.title = previewReady
        ? '进入 AIUI 开发模式（可拖动）'
        : (PREVIEW_ERROR ? '预览启动失败：' + PREVIEW_ERROR + '（点击查看/重试）' : '预览服务启动中…')
      var dot = el('span', 'dsh-aiui-dot')
      if (errCls) dot.className = 'dsh-aiui-err'
      launcher.appendChild(dot)
      launcher.appendChild(document.createTextNode('AIUI 开发模式'))
      launcher.addEventListener('pointerdown', function (e) {
        pendingClick = function () {
          mode = 'console'; panelOpen = true; renderPreviewConsole()
          if (!previewReady) ensurePreviewReady(true)
        }
        startDrag(e, 'launcher')
      })
      root.appendChild(launcher)
    } else {
      consoleBtn = el('div', 'dsh-aiui-console-btn', baseLauncherStyle() + (panelOpen ? 'border-color:#40ff5e;background:rgba(64,255,94,.14);box-shadow:0 0 0 3px rgba(64,255,94,.18), 0 8px 28px rgba(64,255,94,.3);' : '') + dim)
      if (errCls) consoleBtn.className = errCls.trim()
      consoleBtn.title = previewReady
        ? (panelOpen ? '收起 Preview（可拖动）' : '打开 Preview（可拖动）')
        : (PREVIEW_ERROR ? '预览启动失败（点击重试）' : '预览服务启动中，请稍候…')
      var term = el('span', 'dsh-aiui-terminal')
      term.textContent = '>_'
      consoleBtn.appendChild(term)
      consoleBtn.addEventListener('pointerdown', function (e) {
        pendingClick = function () {
          if (previewReady) { panelOpen = !panelOpen; renderPreviewConsole() }
          else { panelOpen = true; renderPreviewConsole(); ensurePreviewReady(true) }
        }
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
      if (!previewReady) open.className = 'dsh-aiui-off'
      actions.appendChild(open)
      var close = el('button', 'dsh-aiui-close')
      close.type = 'button'; close.textContent = '✕'
      close.addEventListener('click', function () { panelOpen = false; renderPreviewConsole() })
      actions.appendChild(close)
      head.appendChild(actions)
      head.addEventListener('pointerdown', function (e) { pendingClick = null; startDrag(e, 'panel') })
      panel.appendChild(head)
      if (previewReady) {
        var frame = el('iframe', 'dsh-aiui-frame')
        frame.src = PREVIEW_URL; frame.title = 'AIUI Preview'
        panel.appendChild(frame)
      } else {
        // No blank white frame: state the reason and offer an explicit retry.
        var placeholder = el('div', 'dsh-aiui-frame-ph')
        var line = document.createElement('div')
        line.textContent = PREVIEW_ERROR ? '预览服务启动失败' : '正在启动 aix preview --dev …'
        placeholder.appendChild(line)
        if (PREVIEW_ERROR) {
          var code = document.createElement('code')
          code.textContent = PREVIEW_ERROR
          placeholder.appendChild(code)
          var retryBtn = document.createElement('button')
          retryBtn.type = 'button'; retryBtn.className = 'dsh-aiui-dlg-btn'
          retryBtn.textContent = '重试'
          retryBtn.addEventListener('click', function () { ensurePreviewReady(true) })
          placeholder.appendChild(retryBtn)
        }
        panel.appendChild(placeholder)
      }
      var foot = el('div', 'dsh-aiui-foot')
      if (previewReady) {
        foot.textContent = 'Ink 浏览器运行时 · 视口 480×352 · 图标与窗口均可拖动'
      } else if (PREVIEW_ERROR) {
        var footErr = el('span', 'dsh-aiui-foot-err')
        footErr.textContent = PREVIEW_ERROR
        foot.appendChild(footErr)
        var footRetry = el('span', 'dsh-aiui-foot-retry')
        footRetry.textContent = '重试'
        footRetry.addEventListener('click', function () { ensurePreviewReady(true) })
        foot.appendChild(footRetry)
      } else {
        foot.textContent = '预览服务启动中…'
      }
      panel.appendChild(foot)
      root.appendChild(panel)
    }
  }

  /* Ensure the live preview dev server is running; remember its URL / error. */
  function ensurePreviewReady(force) {
    fetch('/api/aiui-preview' + (force ? '?retry=1' : '')).then(function (r) { return r.json() }).then(function (resp) {
      var url = (resp && resp.ok && resp.running && typeof resp.url === 'string') ? resp.url : null
      var err = (resp && typeof resp.error === 'string' && resp.error) ? resp.error : null
      var ready = url !== null
      var changed = url !== PREVIEW_URL || ready !== previewReady || err !== PREVIEW_ERROR
      PREVIEW_URL = url
      PREVIEW_ERROR = err
      previewReady = ready
      if (changed && gateState !== 'off') renderPreviewConsole()
    }).catch(function () {
      if (gateState !== 'off') {
        previewReady = false
        if (PREVIEW_ERROR !== '无法连接 Harness 主机（/api/aiui-preview 请求失败）') {
          PREVIEW_ERROR = '无法连接 Harness 主机（/api/aiui-preview 请求失败）'
          renderPreviewConsole()
        }
      }
    })
  }

  /* Heartbeat: the dev server can die mid-session, so keep the state fresh
     instead of trusting the one-shot answer from when the console mounted. */
  function startHeartbeat() {
    if (startHeartbeat.started) return
    startHeartbeat.started = true
    setInterval(function () {
      if (gateState !== 'off') ensurePreviewReady(false)
    }, HEARTBEAT_MS)
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
      else if (treeResp && treeResp.error && treeResp.error !== 'no project') {
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
          ensurePreviewReady(true)
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
      // Drives the harness' own native OS directory chooser. The Remote is
      // directoryPicker/pick (namespace directoryPicker, verb pick); its
      // payload requires a plain-object args field, and it resolves to the
      // chosen path string, or null when the operator cancels.
      fetch('/api/directoryPicker/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'aiui-pick-' + Date.now(),
          method: 'directoryPicker/pick',
          payload: { args: {} },
        }),
      }).then(function (r) { return r.json() }).then(function (resp) {
        var result = resp && resp.result
        if (!result || result.ok !== true) {
          setErr('系统文件夹选择器返回失败，请重试或从下方候选项目中选择')
          return
        }
        // The Remote resolves to the bare path (null on cancel); accept a
        // { path } object too so either wire shape keeps working.
        var value = result.value
        var path = typeof value === 'string' ? value : (value && value.path)
        if (path) pick(path)
        else setErr('未选择文件夹（已取消）')
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
          var txt = document.createElement('span')
          txt.className = 'dsh-aiui-dlg-txt'
          var nm = document.createElement('span')
          nm.textContent = p.name
          txt.appendChild(nm)
          if (p.rel && p.rel !== p.name) {
            var sub2 = document.createElement('small')
            sub2.textContent = p.rel
            txt.appendChild(sub2)
          }
          b.appendChild(ic); b.appendChild(txt)
          b.title = p.path
          b.addEventListener('click', function () { pick(p.path) })
          list.appendChild(b)
        })
      } else {
        var none = document.createElement('div')
        none.id = 'dsh-aiui-proj-note'
        none.textContent = '（未发现 AIUI 项目，请用上方「浏览文件夹…」选择）'
        list.appendChild(none)
      }
    }).catch(function () {
      list.innerHTML = ''
      var none = document.createElement('div')
      none.id = 'dsh-aiui-proj-note'
      none.textContent = '（项目扫描失败，请用上方「浏览文件夹…」选择）'
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
        var nm = document.createElement('span')
        nm.textContent = p.name
        btn.appendChild(nm)
        if (p.rel && p.rel !== p.name) {
          var sub3 = document.createElement('span')
          sub3.id = 'dsh-aiui-proj-pick-sub'
          sub3.textContent = p.rel
          btn.appendChild(sub3)
        }
        btn.title = p.path
        btn.addEventListener('click', function () {
          fetch('/api/aiui-project-select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p.path }),
          }).then(function (r) { return r.json() }).then(function (sel) {
            if (sel && sel.ok) { loadProjectTree(true); ensurePreviewReady(true) }
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
    ensurePreviewReady(false)
    startHeartbeat()
  }

  sync()
  setTimeout(sync, 300)
  setTimeout(sync, 1200)
  new MutationObserver(function () {
    try { sync() } catch (e) { console.warn('[aiui-dev-console] observer err', e) }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })

  console.log('[aiui-dev-console] injected; aiui-dev sessions only')
})()
