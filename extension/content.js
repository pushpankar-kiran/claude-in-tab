// content.js — runs in every page. Reads the DOM and performs actions
// (click / type / scroll) on request from the background service worker.
//
// Interactive elements get a numbered "ref" so Claude can refer to them
// stably. A snapshot returns that numbered list plus visible page text.

(() => {
  // Guard against double-injection.
  if (window.__claudeInTabInstalled) return;
  window.__claudeInTabInstalled = true;

  let refMap = new Map(); // ref number -> Element

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=checkbox]",
    "[role=radio]",
    "[onclick]",
    "[contenteditable=true]",
    "summary"
  ].join(",");

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function labelFor(el) {
    const tag = el.tagName.toLowerCase();
    let text =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("value") ||
      (el.innerText || "").trim();

    if (!text && el.labels && el.labels.length) {
      text = el.labels[0].innerText.trim();
    }
    text = (text || "").replace(/\s+/g, " ").slice(0, 120);

    let descriptor = tag;
    if (tag === "input") descriptor = `input[${el.type || "text"}]`;
    if (el.id) descriptor += `#${el.id}`;
    return `${descriptor} "${text}"`;
  }

  // Build a fresh numbered snapshot of interactive elements + page text.
  function snapshot() {
    refMap = new Map();
    const els = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
      isVisible
    );

    const lines = [];
    let ref = 0;
    for (const el of els) {
      ref += 1;
      refMap.set(ref, el);
      el.setAttribute("data-claude-ref", String(ref));
      lines.push(`[${ref}] ${labelFor(el)}`);
      if (ref >= 400) break; // safety cap
    }

    const mainText = extractText();

    return {
      url: location.href,
      title: document.title,
      elements: lines.join("\n"),
      text: mainText
    };
  }

  function extractText() {
    const main =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.body;
    let text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > 8000) text = text.slice(0, 8000) + "\n…[truncated]";
    return text;
  }

  function resolveRef(ref) {
    let el = refMap.get(Number(ref));
    if (el && document.contains(el)) return el;
    // Fallback: look up by attribute (survives minor DOM changes).
    el = document.querySelector(`[data-claude-ref="${ref}"]`);
    return el && document.contains(el) ? el : null;
  }

  function flash(el) {
    const prev = el.style.outline;
    el.style.outline = "2px solid #cccccc";
    setTimeout(() => (el.style.outline = prev), 600);
  }

  function doClick(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `No element with ref ${ref}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flash(el);
    el.click();
    return { ok: true, result: `Clicked [${ref}] ${labelFor(el)}` };
  }

  function doType({ ref, text, submit }) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `No element with ref ${ref}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flash(el);
    el.focus();

    if (el.isContentEditable) {
      el.textContent = text;
    } else {
      // Use native setter so frameworks (React etc.) register the change.
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    if (submit) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
      if (el.form) el.form.requestSubmit?.();
    }
    return { ok: true, result: `Typed into [${ref}]${submit ? " and submitted" : ""}` };
  }

  function doScroll(direction) {
    const amount = Math.round(window.innerHeight * 0.85);
    window.scrollBy({ top: direction === "up" ? -amount : amount, behavior: "instant" });
    return { ok: true, result: `Scrolled ${direction}` };
  }

  // ---- Floating panel (injected iframe in a Shadow DOM) --------------------

  let panelHost = null; // the shadow host element, once created

  // ---- Floating launcher button (FAB) --------------------------------------
  let launchHost = null;
  let launcherDismissed = false;

  // ---- Theme: match the page's light/dark unless overridden in settings ----
  let themeSetting = "auto";     // auto | light | dark
  let effectiveTheme = "light";

  function parseColor(str) {
    const m = str && str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((s) => parseFloat(s));
    if (p.length >= 4 && p[3] === 0) return null; // fully transparent
    return { r: p[0], g: p[1], b: p[2] };
  }
  function detectPageTheme() {
    let c = parseColor(getComputedStyle(document.body || document.documentElement).backgroundColor);
    if (!c) c = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    if (!c) return (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return lum < 0.5 ? "dark" : "light";
  }
  function computeEffective() {
    return themeSetting === "auto" ? detectPageTheme() : themeSetting;
  }
  function applyThemeAll() {
    effectiveTheme = computeEffective();
    if (launchHost && launchHost._wrap) launchHost._wrap.dataset.theme = effectiveTheme;
    if (selHost && selHost._tb) selHost._tb.dataset.theme = effectiveTheme;
    const frame = panelHost && panelHost.shadowRoot.querySelector(".cit-frame");
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ cit: "theme", theme: effectiveTheme }, "*");
  }
  chrome.storage.local.get("theme", ({ theme }) => { themeSetting = theme || "auto"; applyThemeAll(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) { themeSetting = changes.theme.newValue || "auto"; applyThemeAll(); }
  });

  function buildLauncher() {
    if (launchHost) return;
    launchHost = document.createElement("div");
    launchHost.id = "claude-in-tab-launcher";
    launchHost.style.all = "initial";
    const sh = launchHost.attachShadow({ mode: "open" });
    sh.innerHTML = `
      <style>
        .wrap { position: fixed; bottom: 20px; right: 20px; width: 46px; height: 46px; z-index: 2147483646;
          font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
        .wrap.hidden { display: none; }
        .fab { position: absolute; inset: 0; border-radius: 50%; background: #fff; border: 1px solid #e2e2e2;
          box-shadow: 0 4px 16px rgba(0,0,0,.18); cursor: grab; display: flex; align-items: center;
          justify-content: center; color: #2b2b2b; transition: box-shadow .12s; }
        .fab:hover { box-shadow: 0 6px 20px rgba(0,0,0,.24); }
        .fab:active { cursor: grabbing; }
        .fab .logo { font-size: 20px; line-height: 1; }
        .lclose { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%;
          background: #2b2b2b; color: #fff; border: none; font-size: 10px; cursor: pointer; display: none;
          align-items: center; justify-content: center; line-height: 1; padding: 0; }
        .wrap:hover .lclose { display: flex; }
        .tip { position: absolute; right: 56px; top: 11px; background: #2b2b2b; color: #fff; font-size: 12px;
          padding: 5px 9px; border-radius: 8px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .12s; }
        .wrap:hover .tip { opacity: 1; }
        .wrap[data-theme="dark"] .fab { background: #2a2a2a; border-color: #4a4a4a; color: #ececec; }
        .wrap[data-theme="dark"] .lclose { background: #ececec; color: #1e1e1e; }
        .wrap[data-theme="dark"] .tip { background: #ececec; color: #1e1e1e; }
      </style>
      <div class="wrap" id="wrap">
        <div class="tip">Ask Claude · Ctrl+Shift+K</div>
        <button class="lclose" id="lclose" title="Hide">✕</button>
        <div class="fab" id="fab"><span class="logo">✳</span></div>
      </div>`;
    (document.documentElement || document.body).appendChild(launchHost);
    const wrap = sh.getElementById("wrap");
    const fab = sh.getElementById("fab");
    launchHost._wrap = wrap;
    wrap.dataset.theme = effectiveTheme;

    // Restore a saved position (clamped to the current viewport).
    chrome.storage.local.get("fabPos", ({ fabPos }) => {
      if (!fabPos) return;
      const left = Math.max(4, Math.min(window.innerWidth - 50, fabPos.left));
      const top = Math.max(4, Math.min(window.innerHeight - 50, fabPos.top));
      wrap.style.left = left + "px"; wrap.style.top = top + "px";
      wrap.style.right = "auto"; wrap.style.bottom = "auto";
    });

    // Drag to reposition. Pointer capture makes it work over iframes and pages
    // that intercept mouse events. A click that doesn't move opens the panel.
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, justDragged = false;
    fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      try { fab.setPointerCapture(e.pointerId); } catch (_) {}
      const r = wrap.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    fab.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        moved = true; // first real movement: switch to left/top anchoring
        wrap.style.right = "auto"; wrap.style.bottom = "auto";
      }
      if (!moved) return;
      const nl = Math.max(4, Math.min(window.innerWidth - 50, ox + dx));
      const nt = Math.max(4, Math.min(window.innerHeight - 50, oy + dy));
      wrap.style.left = nl + "px"; wrap.style.top = nt + "px";
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        const r = wrap.getBoundingClientRect();
        chrome.storage.local.set({ fabPos: { left: r.left, top: r.top } });
        justDragged = true;
        setTimeout(() => (justDragged = false), 60);
      }
    };
    fab.addEventListener("pointerup", endDrag);
    fab.addEventListener("pointercancel", endDrag);
    fab.addEventListener("click", () => { if (!justDragged) openPanel(); });
    sh.getElementById("lclose").addEventListener("click", (e) => { e.stopPropagation(); launcherDismissed = true; hideLauncher(); });
  }
  function showLauncher() {
    if (launcherDismissed) return;
    if (!launchHost) buildLauncher();
    launchHost._wrap.classList.remove("hidden");
    clampLauncher();
  }
  function hideLauncher() { if (launchHost) launchHost._wrap.classList.add("hidden"); }

  // Keep the launcher fully inside the viewport (e.g. after a window resize).
  function clampLauncher() {
    if (!launchHost) return;
    const wrap = launchHost._wrap;
    if (!wrap.style.left) return; // still anchored bottom-right by CSS — always in view
    const w = 46, h = 46, m = 4;
    const left = Math.max(m, Math.min(window.innerWidth - w - m, parseFloat(wrap.style.left) || 0));
    const top = Math.max(m, Math.min(window.innerHeight - h - m, parseFloat(wrap.style.top) || 0));
    wrap.style.left = left + "px"; wrap.style.top = top + "px";
    wrap.style.right = "auto"; wrap.style.bottom = "auto";
  }
  window.addEventListener("resize", clampLauncher);

  function togglePanel() {
    // If the user dismissed the launcher, the toolbar icon brings it back
    // (rather than opening the panel).
    if (launcherDismissed && (!panelHost || panelHost.shadowRoot.querySelector(".cit-root").style.display === "none")) {
      launcherDismissed = false;
      showLauncher();
      return;
    }
    if (panelHost) {
      const root = panelHost.shadowRoot.querySelector(".cit-root");
      if (root.style.display === "none") {
        resetToCorner(root); // always reappear at the bottom-right
        root.style.display = "flex";
        hideLauncher();
        setTimeout(applyThemeAll, 0); // re-sync theme to the current page
      } else {
        root.style.display = "none";
        showLauncher();
      }
      return;
    }
    buildPanel();
    hideLauncher();
  }

  // Ensure the panel exists and is visible (used by the context menu).
  function openPanel() {
    if (!panelHost) {
      buildPanel();
    } else {
      const root = panelHost.shadowRoot.querySelector(".cit-root");
      resetToCorner(root);
      root.style.display = "flex";
    }
    hideLauncher();
    setTimeout(applyThemeAll, 60); // re-sync theme to the current page
    // Nudge the panel to pull any pending quick-prompt (already-open case;
    // a freshly built panel pulls it itself on load).
    const frame = panelHost && panelHost.shadowRoot.querySelector(".cit-frame");
    if (frame) {
      setTimeout(() => {
        if (frame.contentWindow) frame.contentWindow.postMessage({ cit: "pull_pending" }, "*");
      }, 60);
    }
  }

  // Anchor the widget to its default bottom-right position, full size.
  function resetToCorner(root) {
    root.classList.remove("cit-collapsed");
    root.style.left = "auto";
    root.style.top = "auto";
    root.style.right = "20px";
    root.style.bottom = "20px";
  }

  function buildPanel() {
    panelHost = document.createElement("div");
    panelHost.id = "claude-in-tab-host";
    // Isolate from the page's own styles.
    panelHost.style.all = "initial";
    const shadow = panelHost.attachShadow({ mode: "open" });
    const frameUrl = chrome.runtime.getURL("sidepanel.html") + "?theme=" + computeEffective();

    shadow.innerHTML = `
      <style>
        .cit-root {
          position: fixed; bottom: 20px; right: 20px;
          width: 340px; height: 560px; max-height: 85vh;
          display: flex; flex-direction: column;
          background: #ffffff; border: 1px solid #e2e2e2;
          border-radius: 12px; overflow: hidden;
          box-shadow: 0 12px 40px rgba(0,0,0,.18);
          z-index: 2147483647;
          font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
        }
        .cit-bar {
          flex: 0 0 auto; height: 30px; cursor: move; user-select: none;
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 6px 0 10px; background: #f5f5f5; color: #2b2b2b;
          border-bottom: 1px solid #e2e2e2;
        }
        .cit-grip { font-size: 12px; font-weight: 600; letter-spacing: .3px; }
        .cit-actions { display: flex; gap: 2px; }
        .cit-bar button {
          background: transparent; border: none; color: #2b2b2b; cursor: pointer;
          font-size: 15px; width: 24px; height: 22px; border-radius: 5px;
          line-height: 1; padding: 0;
        }
        .cit-bar button:hover { background: rgba(0,0,0,.06); }
        .cit-frame { flex: 1 1 auto; width: 100%; border: 0; background: #ffffff; }
        .cit-root.cit-collapsed { width: 170px; height: 30px; }
        .cit-root.cit-collapsed .cit-frame { display: none; }
      </style>
      <div class="cit-root">
        <div class="cit-bar">
          <span class="cit-grip">⠿ Claude</span>
          <span class="cit-actions">
            <button class="cit-min" title="Minimize">–</button>
            <button class="cit-close" title="Close">✕</button>
          </span>
        </div>
        <iframe class="cit-frame" src="${frameUrl}"
                allow="clipboard-read; clipboard-write"></iframe>
      </div>`;

    (document.documentElement || document.body).appendChild(panelHost);

    const root = shadow.querySelector(".cit-root");
    const bar = shadow.querySelector(".cit-bar");
    const frame = shadow.querySelector(".cit-frame");

    shadow.querySelector(".cit-close").onclick = () => { root.style.display = "none"; showLauncher(); };
    shadow.querySelector(".cit-min").onclick = () => {
      const collapsing = !root.classList.contains("cit-collapsed");
      root.classList.toggle("cit-collapsed");
      if (collapsing) {
        // Snap the minimized bar back to the bottom-right corner.
        root.style.left = "auto";
        root.style.top = "auto";
        root.style.right = "20px";
        root.style.bottom = "20px";
      }
    };

    enableDrag(root, bar, frame);
  }

  // Drag the panel by its title bar. The iframe swallows mouse events, so we
  // disable its pointer events while dragging and switch to left/top anchoring.
  function enableDrag(root, handle, frame) {
    let sx, sy, sl, st, dragging = false;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      root.style.left = rect.left + "px";
      root.style.top = rect.top + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
      sx = e.clientX; sy = e.clientY; sl = rect.left; st = rect.top;
      frame.style.pointerEvents = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      let nl = sl + (e.clientX - sx);
      let nt = st + (e.clientY - sy);
      nl = Math.max(4, Math.min(window.innerWidth - 60, nl));
      nt = Math.max(4, Math.min(window.innerHeight - 34, nt));
      root.style.left = nl + "px";
      root.style.top = nt + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      frame.style.pointerEvents = "auto";
    });
  }

  // When the user selects text on the page, hand it to the panel's input box.
  function pushSelectionToPanel() {
    if (!panelHost) return;
    const root = panelHost.shadowRoot.querySelector(".cit-root");
    if (!root || root.style.display === "none" || root.classList.contains("cit-collapsed")) return;
    const sel = ((window.getSelection && window.getSelection().toString()) || "").trim();
    if (!sel) return;
    const frame = panelHost.shadowRoot.querySelector(".cit-frame");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ cit: "selection", text: sel }, "*");
    }
  }
  // Floating selection toolbar (like MaxAI/Monica) — appears near selected text.
  let selHost = null;
  function ensureSelToolbar() {
    if (selHost) return selHost;
    selHost = document.createElement("div");
    selHost.id = "claude-in-tab-seltb";
    selHost.style.all = "initial";
    const sh = selHost.attachShadow({ mode: "open" });
    sh.innerHTML = `
      <style>
        .tb { position: fixed; z-index: 2147483647; display: none; gap: 1px; padding: 4px;
          background: #fff; border: 1px solid #e2e2e2; border-radius: 10px;
          box-shadow: 0 6px 22px rgba(0,0,0,.17); font-family: -apple-system, system-ui, sans-serif; }
        .tb.show { display: flex; align-items: center; }
        .tb button { border: none; background: none; color: #2b2b2b; font-size: 12px;
          padding: 5px 9px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
        .tb button:hover { background: #f2f2f2; }
        .tb .brand { font-size: 12px; padding: 0 4px 0 6px; color: #8a8a8a; }
        .tb .sep { width: 1px; align-self: stretch; background: #ececec; margin: 3px 2px; }
        .tb[data-theme="dark"] { background: #262626; border-color: #4a4a4a; box-shadow: 0 6px 22px rgba(0,0,0,.55); }
        .tb[data-theme="dark"] button { color: #ececec; }
        .tb[data-theme="dark"] button:hover { background: #363636; }
        .tb[data-theme="dark"] .brand { color: #9a9a9a; }
        .tb[data-theme="dark"] .sep { background: #3a3a3a; }
      </style>
      <div class="tb" id="tb">
        <span class="brand">✳</span>
        <button data-a="explain">Explain</button>
        <button data-a="translate">Translate</button>
        <button data-a="summarize">Summarize</button>
        <span class="sep"></span>
        <button data-a="ask">Ask…</button>
      </div>`;
    (document.documentElement || document.body).appendChild(selHost);
    const tb = sh.getElementById("tb");
    tb.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
    tb.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const text = ((window.getSelection && window.getSelection().toString()) || "").trim();
      if (text) chrome.runtime.sendMessage({ type: "selection_action", action: b.dataset.a, text });
      hideSelToolbar();
      const s = window.getSelection && window.getSelection();
      if (s) s.removeAllRanges();
    });
    selHost._tb = tb;
    tb.dataset.theme = effectiveTheme;
    return selHost;
  }
  function showSelToolbar() {
    const sel = window.getSelection && window.getSelection();
    const text = ((sel && sel.toString()) || "").trim();
    if (!text || text.length < 2) { hideSelToolbar(); return; }
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const tb = ensureSelToolbar()._tb;
    tb.classList.add("show");
    const tw = tb.offsetWidth, th = tb.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(6, Math.min(window.innerWidth - tw - 6, left));
    let top = rect.top - th - 8;
    if (top < 6) top = rect.bottom + 8;
    tb.style.left = left + "px";
    tb.style.top = top + "px";
  }
  function hideSelToolbar() { if (selHost && selHost._tb) selHost._tb.classList.remove("show"); }

  document.addEventListener("mouseup", () => setTimeout(() => { pushSelectionToPanel(); showSelToolbar(); }, 10));
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") setTimeout(() => { pushSelectionToPanel(); showSelToolbar(); }, 10);
  });
  document.addEventListener("mousedown", (e) => { if (!selHost || !selHost.contains(e.target)) hideSelToolbar(); });
  document.addEventListener("scroll", hideSelToolbar, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.action) {
        case "snapshot":
          sendResponse({ ok: true, ...snapshot() });
          break;
        case "click":
          sendResponse(doClick(msg.ref));
          break;
        case "type":
          sendResponse(doType(msg));
          break;
        case "scroll":
          sendResponse(doScroll(msg.direction));
          break;
        case "toggle_panel":
          togglePanel();
          sendResponse({ ok: true });
          break;
        case "open_panel":
          openPanel();
          sendResponse({ ok: true });
          break;
        case "ping":
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown action ${msg.action}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return true; // keep channel open for async
  });

  // Show the floating launcher button on load.
  showLauncher();
})();
