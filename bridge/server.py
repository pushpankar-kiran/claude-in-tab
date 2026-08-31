"""
Local bridge for the "Claude in Tab" Chrome extension.

Runs on your Claude *subscription* (no API credits) via claude-agent-sdk.

Endpoints (all localhost only):
  GET  /health           -> {ok, cli}
  POST /session/new      -> {sid}          create a warm, reusable agent session
  POST /session/step     -> {text}         send one message, get the next action
  POST /session/close    -> {ok}           tear a session down
  POST /research         -> {text}         one-shot answer using web search
  POST /complete         -> {text}         stateless one-shot (fallback)

Start it with run-bridge.bat. Leave the window open while you use the extension.
"""

import asyncio
import glob
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from claude_agent_sdk import (
    query,
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    TextBlock,
    ResultMessage,
)

HOST = "127.0.0.1"
PORT = 8765
SESSION_IDLE_SECS = 900  # close sessions idle longer than 15 min

# Prefer the subscription OAuth login over any (credit-less) API key env var.
_removed_auth = [k for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
                 if os.environ.pop(k, None) is not None]

BLOCKED_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
                 "Glob", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite"]

RESEARCH_SYSTEM = (
    "You are a helpful research assistant with web access. Use web search to find "
    "current, accurate information, then answer concisely in Markdown. End with a "
    "short 'Sources:' list of the links you used."
)

CWD = os.path.dirname(os.path.abspath(__file__))


def find_cli():
    appdata = os.environ.get("APPDATA", "")
    local = os.environ.get("LOCALAPPDATA", "")
    pkg = "Claude_pzs8sxrjxfjjc"
    bases = [
        os.path.join(local, "Packages", pkg, "LocalCache", "Roaming", "Claude", "claude-code"),
        os.path.join(appdata, "Claude", "claude-code"),
    ]

    def ver_key(p):
        parts = re.findall(r"\d+", os.path.basename(os.path.dirname(p)))
        return tuple(int(x) for x in parts) if parts else (0,)

    for base in bases:
        cands = glob.glob(os.path.join(base, "*", "claude.exe"))
        if cands:
            return sorted(cands, key=ver_key)[-1]
    return None


CLI_PATH = find_cli()

# ---- Persistent asyncio loop (keeps warm CLI sessions alive) ----------------

LOOP = asyncio.new_event_loop()
threading.Thread(target=lambda: (asyncio.set_event_loop(LOOP), LOOP.run_forever()), daemon=True).start()


def run_coro(coro, timeout=240):
    return asyncio.run_coroutine_threadsafe(coro, LOOP).result(timeout)


SESSIONS = {}          # sid -> {"client": ClaudeSDKClient, "ts": float}
SLOCK = threading.Lock()


def _base_opts(system, model, effort, **extra):
    kw = dict(
        system_prompt=system,
        model=model or "sonnet",
        permission_mode="bypassPermissions",
        cwd=CWD,
    )
    if CLI_PATH:
        kw["cli_path"] = CLI_PATH
    if effort:
        kw["effort"] = effort
    kw.update(extra)
    return ClaudeAgentOptions(**kw)


async def _collect(source):
    parts, result_text, is_err = [], "", False
    try:
        async for m in source:
            if isinstance(m, AssistantMessage):
                for b in m.content:
                    if isinstance(b, TextBlock):
                        parts.append(b.text)
            elif isinstance(m, ResultMessage):
                result_text = getattr(m, "result", "") or ""
                is_err = bool(getattr(m, "is_error", False))
    except Exception as e:
        detail = "".join(parts).strip() or result_text.strip()
        raise RuntimeError(detail or str(e))
    out = "".join(parts).strip()
    if is_err and not out:
        raise RuntimeError(result_text.strip() or "unknown error result")
    return out or result_text.strip()


# ---- Session lifecycle ------------------------------------------------------

async def _session_new(system, model, effort):
    opts = _base_opts(system, model, effort, allowed_tools=[], disallowed_tools=BLOCKED_TOOLS)
    client = ClaudeSDKClient(options=opts)
    await client.connect()
    return client


async def _session_step(client, message):
    await client.query(message)
    return await _collect(client.receive_response())


async def _session_close(client):
    try:
        await client.disconnect()
    except Exception:
        pass


def sweep_idle():
    now = time.time()
    dead = []
    with SLOCK:
        for sid, s in list(SESSIONS.items()):
            if now - s["ts"] > SESSION_IDLE_SECS:
                dead.append((sid, s["client"]))
                del SESSIONS[sid]
    for sid, client in dead:
        try:
            run_coro(_session_close(client), timeout=30)
        except Exception:
            pass


# ---- One-shot flows ---------------------------------------------------------

async def run_complete(system, prompt, model, effort):
    opts = _base_opts(system, model, effort, allowed_tools=[],
                      disallowed_tools=BLOCKED_TOOLS, max_turns=6)
    return await _collect(query(prompt=prompt, options=opts))


async def run_research(system, prompt, model, effort):
    opts = _base_opts(system or RESEARCH_SYSTEM, model, effort,
                      allowed_tools=["WebSearch", "WebFetch"], max_turns=10)
    return await _collect(query(prompt=prompt, options=opts))


# ---- HTTP -------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("  " + (fmt % args) + "\n")

    def _origin_ok(self):
        # Only the extension (or local tools with no Origin) may use the bridge.
        # A web page's fetch always sends its http(s) Origin — reject those so a
        # malicious site can't drive Claude on the user's subscription.
        origin = self.headers.get("Origin", "")
        return origin == "" or origin.startswith("chrome-extension://")

    def _cors(self):
        origin = self.headers.get("Origin", "")
        allow = origin if origin.startswith("chrome-extension://") else "null"
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "cli": CLI_PATH})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._origin_ok():
            self._json(403, {"error": "forbidden origin"}); return
        try:
            data = self._body()
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        try:
            if self.path.startswith("/session/new"):
                sweep_idle()
                client = run_coro(_session_new(data.get("system", ""), data.get("model", "sonnet"), data.get("effort")))
                sid = secrets.token_hex(8)
                with SLOCK:
                    SESSIONS[sid] = {"client": client, "ts": time.time()}
                print(f"[session/new] {sid} model={data.get('model')}", flush=True)
                self._json(200, {"sid": sid})

            elif self.path.startswith("/session/step"):
                sid = data.get("sid")
                with SLOCK:
                    s = SESSIONS.get(sid)
                if not s:
                    self._json(410, {"error": "session expired"}); return
                s["ts"] = time.time()
                text = run_coro(_session_step(s["client"], data.get("message", "")))
                self._json(200, {"text": text})

            elif self.path.startswith("/session/close"):
                sid = data.get("sid")
                with SLOCK:
                    s = SESSIONS.pop(sid, None)
                if s:
                    run_coro(_session_close(s["client"]), timeout=30)
                self._json(200, {"ok": True})

            elif self.path.startswith("/research"):
                print("[research]", flush=True)
                text = run_coro(run_research(data.get("system", ""), data.get("prompt", ""), data.get("model", "sonnet"), data.get("effort")))
                self._json(200, {"text": text})

            elif self.path.startswith("/complete"):
                text = run_coro(run_complete(data.get("system", ""), data.get("prompt", ""), data.get("model", "sonnet"), data.get("effort")))
                self._json(200, {"text": text})

            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            print(f"[error] {self.path}: {e}", flush=True)
            self._json(500, {"error": str(e)})


def main():
    if not CLI_PATH:
        print("WARNING: could not find claude.exe; falling back to 'claude' on PATH.")
    else:
        print(f"Using Claude CLI: {CLI_PATH}")
    if _removed_auth:
        print(f"Ignoring {', '.join(_removed_auth)} for this process (using subscription login).")
    print(f"Claude-in-Tab bridge listening on http://{HOST}:{PORT}")
    print("Leave this window open while you use the extension. Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopping bridge.")


if __name__ == "__main__":
    main()
