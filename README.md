# Claude in Tab

> An AI assistant sidebar for Chrome that can **read and act on any web page** — powered by your **Claude subscription** through a small local bridge (no API key, no credits).

![manifest](https://img.shields.io/badge/manifest-v3-blue) ![platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green)

A circular **launcher button** floats in the bottom-right of every page (like Merlin) — click
it, the toolbar icon, or **Ctrl+Shift+K** to pop up a small **floating chat window** in the
bottom-right corner of any Chrome tab. The launcher hides while the panel is open and returns
when you close it; hover it for a ✕ to dismiss it for the current page. Claude can **read** the page and **act** on it — click, type,
scroll, navigate — running an agentic loop against your active tab.

It runs on your **Claude subscription** (no API credits) via a tiny **local bridge**
you start with a double-click. No API key anywhere.

## Requirements
- **Windows** with the **Claude desktop app** installed (the bridge uses its bundled
  Claude Code CLI for authentication) and an **active Claude subscription** (Pro/Max).
- **Python 3.10+** (3.13 recommended) to run the local bridge.
- **Google Chrome** (or a Chromium browser that supports MV3 extensions).

> macOS/Linux aren't supported out of the box — the bridge's CLI-discovery paths are
> Windows-specific — but PRs to generalize them are welcome.

## Layout
```
claude-chrome-extension/
  extension/   ← load THIS in Chrome (~60 KB)
  bridge/      ← the local subscription server (Python venv, not loaded by Chrome)
```

## Pieces
| File | Role |
|------|------|
| `extension/manifest.json` | MV3 config, permissions, icon action + shortcut |
| `extension/background.js` | Toggles the panel; runs one page action (read/click/type/scroll/navigate) on request |
| `extension/content.js` | Reads the DOM, performs actions, injects the floating panel + launcher button |
| `extension/sidepanel.html/.css/.js` | The chat UI **and** the agent loop (talks to the bridge) |
| `bridge/server.py` | Local HTTP server that runs `claude-agent-sdk` on your subscription |
| `bridge/run-bridge.bat` | Double-click to start the bridge (uses the local `.venv`) |
| `bridge/login.bat` | Double-click to (re)sign in to your Claude subscription |
| `bridge/setup-venv.bat` | One-time: builds the local `.venv` from `requirements.txt` |
| `bridge/requirements.txt` | Pinned Python dependencies |
| `bridge/.venv/` | Local Python environment — **all** Python deps live here |

**Self-contained:** every Python dependency lives in `bridge/.venv`, not your global
Python. The only external piece is `claude.exe` (your installed Claude app's CLI, which
provides subscription auth and auto-updates) — the bridge finds it automatically.

## How it fits together
```
Floating panel (agent loop)
   ├── POST http://localhost:8765/complete ──► bridge (claude-agent-sdk, your subscription)
   └── run_tool ──► background.js ──► content.js  (click / type / read the page)
```

## One-time setup
1. **Clone this repository.**
2. **Build the bridge environment:** double-click **`bridge/setup-venv.bat`** (needs Python
   3.10+ and internet the first time). It creates a local `bridge/.venv` with the dependencies.
3. **Sign in with your own Claude account** — see [Authentication](#authentication) below.
4. **Load the extension:**
   - Open **chrome://extensions**, turn on **Developer mode** (top-right).
   - **Load unpacked** → select the **`extension`** subfolder of this repository.
     ⚠️ Point Chrome at `extension/`, **not** the whole repo folder — `bridge/` holds the Python
     environment and shouldn't be part of the loaded extension.
   - Pin it (🧩 → pin "Claude in Tab").

## Authentication
**This project ships no credentials, and none are needed from the authors.** It uses **your own
Claude subscription**, authenticated on **your machine**:

1. Make sure the **Claude desktop app** is installed (it provides the Claude Code CLI the bridge
   drives) and you have an active subscription.
2. Run **`bridge/login.bat`** once. A browser opens — sign in to **your** Claude account and pick
   "Claude account with subscription".
3. That stores an auto-refreshing OAuth token locally at
   `%USERPROFILE%\.claude\.credentials.json` — **on your computer only**. It is never committed to
   this repo, sent to the extension's authors, or shared with anyone.

Notes:
- **No API key is required.** If you happen to have an `ANTHROPIC_API_KEY` environment variable
  set, the bridge deliberately ignores it so your subscription login is used.
- The login lasts a few weeks; when the bridge reports "authentication expired", just run
  `bridge/login.bat` again.
- To sign out, run `claude auth logout` (from the Claude CLI) or delete
  `%USERPROFILE%\.claude\.credentials.json`.

## Using it (each session)
1. **Start the bridge:** double-click **`bridge/run-bridge.bat`**. Leave the window open.
   - First time (or after ~a few weeks) it may say **authentication expired** — double-click
     **`bridge/login.bat`**, sign in through the browser, then start `run-bridge.bat` again.
2. Open any normal web page, click the extension icon (or **Ctrl+Shift+K**).
3. The header dot should be **●** (bridge connected). If it's **○**, the bridge isn't running.
4. Type a task, e.g.:
   - "Summarize this page."
   - "Find the search box, type 'wireless headphones', and search."
   - "Fill the newsletter email with test@example.com but don't submit."

Close the bridge window (or Ctrl+C) when you're done — the extension goes offline until you start it again.

## Features
- **Agentic page control** — read the page, click, type, scroll, navigate in a loop.
- **Web-search mode** — toggle **Search** in the composer to answer from a live web search
  (with sources) instead of acting on the page.
- **Fast warm sessions** — each conversation keeps one warm CLI session, so steps after the
  first are ~3× quicker (≈1.7s vs ≈4.7s) than cold-starting the model every step.
- **Polished chat UI** — markdown-rendered replies (bold, lists, code), assistant avatars,
  animated typing dots, hover-to-copy on any reply, and a welcome screen with suggestion cards.
- **Approval gate** — before an irreversible action (submit / send / delete / buy), the panel
  pauses and asks you to Approve or Skip. Toggle it in Settings (on by default).
- **In-page selection toolbar** — highlight text on the page and a small popup appears with
  Explain / Translate / Summarize / Ask (like Monica/MaxAI).
- **Quick actions** — Summarize / Key points / Explain / Translate / TL;DR (act on the current
  selection if there is one, else the whole page).
- **Right-click menu** — "Ask Claude about \"…\"" on a selection, "Summarize this page" anywhere.
- **Conversation history** — chats auto-save; open the clock icon to reload or delete past ones.
- **Composer** — rounded input with model + per-message effort pills and a send button.
- **Custom persona** — free-text instructions in Settings, applied to every reply.

## Settings (⚙)
- **Model:** Sonnet (default), Opus, or Haiku. On the **Pro** plan, **Sonnet** is the reliable
  pick; Opus may be limited by your subscription.
- **Custom instructions (persona):** appended to Claude's system prompt on every message.
- **Effort** (selector next to the input): low → max — how hard Claude thinks per step. Ignored on Haiku.

## Notes & limits
- **Where it works:** normal `http(s)` pages. Chrome blocks extension scripts on `chrome://`
  pages, the Web Store, and the PDF viewer (you'll get a quick × badge on the icon there).
- **Cost:** none in API dollars — it uses your subscription and counts against its usual limits.
- **Safety:** the agent can click/type on the page. It only acts on the tab you point it at, it
  narrates each step, and it's told to avoid credentials and confirm before irreversible actions.
  Watch it on sensitive/logged-in tabs; a malicious page could try to mislead it (prompt injection).
- **Each turn** the panel asks the bridge for the next JSON action, runs it, and repeats (max 14
  steps/turn). A warm session keeps the CLI alive so steps after the first are quick.

## Privacy
Page content and your messages go only to a local bridge on your machine, which forwards them to
Anthropic under your subscription. Nothing is sent to the extension's authors or any third party;
there is no analytics or tracking. See [`extension/PRIVACY.md`](extension/PRIVACY.md).

## Disclaimer
This is an **unofficial, community project** and is not affiliated with or endorsed by Anthropic.
It drives the Claude Code CLI using your personal subscription; you are responsible for using it in
accordance with [Anthropic's Usage Policies and Terms](https://www.anthropic.com/legal). Because
the agent can click and type on pages, use it carefully on sensitive or logged-in sites. Provided
"as is", without warranty.

## Contributing
Issues and pull requests are welcome — especially macOS/Linux CLI-discovery support, tests, and UI
polish. Please keep the extension dependency-free (no bundled frameworks) and the bridge limited to
the Python standard library plus `claude-agent-sdk`.

## License
[MIT](LICENSE) © 2026 Claude in Tab contributors.
