# Privacy Policy — Claude in Tab

_Last updated: 2026-08-31_

Claude in Tab is a personal productivity extension. It is designed to keep your
data on your own machine.

## What the extension accesses
- **The content of the active tab** (visible text and interactive elements), and
  **text you select**, only when you invoke the assistant or a quick action.
- **What you type** into the extension's chat box.

## Where that data goes
- Page content and your messages are sent **only to a local bridge server running
  on your own computer** (`http://127.0.0.1:8765`). The bridge forwards them to
  **Anthropic** (`claude.ai` / Claude Code) using your existing Claude
  subscription, so Anthropic processes them under
  [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy).
- **No data is sent to the extension's authors or to any third-party server.**
- The extension contains **no analytics, tracking, or advertising**.

## What is stored, and where
- Your **settings** (model, effort, persona, safety toggle), **chat history**, and
  the **launcher position** are stored locally in `chrome.storage.local` on your
  device. They are never transmitted anywhere.
- The extension does **not** store passwords, payment details, or credentials, and
  its system prompt instructs the assistant not to enter them.

## Your control
- Clear chat history any time from the History panel ("clear all").
- Remove all stored data by removing the extension.
- The assistant asks for confirmation before irreversible actions (submit, send,
  delete, purchase); this can be toggled in Settings.

## Permissions and why they are needed
- **host access to all sites / `activeTab` / `scripting`** — to read and act on the
  page you point the assistant at. Used only on the tab you're working with.
- **`tabs`** — to find the active tab, navigate it, and detect when it finishes
  loading. The extension does not read your browsing history.
- **`storage`** — to save the settings/history described above, locally.
- **`contextMenus`** — to add the right-click "Ask Claude" / "Summarize" items.

Questions: open an issue in the project repository.
