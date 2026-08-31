// background.js — service worker.
// Two jobs now:
//   1. Toggle the floating panel when the toolbar icon is clicked.
//   2. Execute a single page action (read/click/type/scroll/navigate) on the
//      active tab when the panel asks. The agent loop itself lives in the panel
//      (sidepanel.js), which talks to the local bridge on your subscription.

// ---- Active tab + content-script messaging ---------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function sendToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (e) {
    // Inject the content script if it isn't there yet, then retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (e2) {
      return { ok: false, error: `Cannot reach page: ${e2.message}. (Chrome blocks scripts on chrome:// pages, the Web Store, and PDF viewers.)` };
    }
  }
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve();
      } catch {
        return resolve();
      }
      if (Date.now() - start > timeout) return resolve();
      setTimeout(check, 300);
    };
    setTimeout(check, 400);
  });
}

// Run one tool against the active tab; returns a plain-text result string.
async function runTool(tool, input, tab) {
  switch (tool) {
    case "read_page": {
      const r = await sendToTab(tab.id, { action: "snapshot" });
      if (!r || !r.ok) return `read_page failed: ${r && r.error}`;
      return `TITLE: ${r.title}\nURL: ${r.url}\n\nINTERACTIVE ELEMENTS:\n${r.elements || "(none found)"}\n\nPAGE TEXT:\n${r.text}`;
    }
    case "click": {
      const r = await sendToTab(tab.id, { action: "click", ref: input.ref });
      return r.ok ? r.result : `click failed: ${r.error}`;
    }
    case "type_text": {
      const r = await sendToTab(tab.id, {
        action: "type", ref: input.ref, text: input.text, submit: !!input.submit
      });
      return r.ok ? r.result : `type_text failed: ${r.error}`;
    }
    case "scroll": {
      const r = await sendToTab(tab.id, { action: "scroll", direction: input.direction });
      return r.ok ? r.result : `scroll failed: ${r.error}`;
    }
    case "navigate": {
      await chrome.tabs.update(tab.id, { url: input.url });
      await waitForLoad(tab.id);
      return `Navigated to ${input.url}`;
    }
    default:
      return `Unknown tool: ${tool}`;
  }
}

// ---- Right-click context menu ----------------------------------------------

// A prompt waiting to be picked up by the panel once it's open.
// Shape: { text: string, autosend: boolean } or null.
let pendingPrompt = null;

// Prompt templates for selection actions (mirror of the panel's QUICK map).
const SEL_PROMPTS = {
  explain:   (s) => `Explain the following clearly:\n\n${s}`,
  translate: (s) => `Translate the following to English:\n\n${s}`,
  summarize: (s) => `Summarize the following:\n\n${s}`,
  ask:       (s) => `About this selection:\n\n"${s}"\n\n`
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "cit-ask-selection", title: "Ask Claude about \"%s\"", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "cit-summarize-page", title: "Summarize this page with Claude", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === "cit-ask-selection") {
    const sel = (info.selectionText || "").trim();
    pendingPrompt = sel ? { context: sel } : null;
  } else if (info.menuItemId === "cit-summarize-page") {
    pendingPrompt = { text: "Summarize this page concisely.", autosend: true };
  } else {
    return;
  }
  await sendToTab(tab.id, { action: "open_panel" });
});

// ---- Toolbar icon toggles the floating panel -------------------------------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const r = await sendToTab(tab.id, { action: "toggle_panel" });
  if (r && r.ok === false) {
    chrome.action.setBadgeText({ tabId: tab.id, text: "×" });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#999999" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 2000);
  }
});

// ---- Panel asks us to run a page action ------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "get_pending") {
    sendResponse({ pending: pendingPrompt });
    pendingPrompt = null;
    return false;
  }
  if (msg && msg.type === "selection_action") {
    // From the in-page selection toolbar: build a prompt and open the panel.
    const build = SEL_PROMPTS[msg.action];
    const sel = (msg.text || "").trim();
    if (sel && (build || msg.action === "ask")) {
      pendingPrompt = msg.action === "ask"
        ? { context: sel }                                  // attach as a chip
        : { text: build(sel), autosend: true };             // explain/translate/summarize
      (async () => {
        const tab = await getActiveTab();
        if (tab) await sendToTab(tab.id, { action: "open_panel" });
      })();
    }
    return false;
  }
  if (msg && msg.type === "run_tool") {
    (async () => {
      const tab = await getActiveTab();
      if (!tab) {
        sendResponse({ ok: false, result: "No active tab found." });
        return;
      }
      const result = await runTool(msg.tool, msg.input || {}, tab);
      sendResponse({ ok: true, result });
    })();
    return true; // async response
  }
  return false;
});
