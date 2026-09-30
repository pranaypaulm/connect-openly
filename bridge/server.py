#!/usr/bin/env python3
"""Connect Openly — local bridge server (Firefox-first).

Any CLI AI agent (opencode, claude code, gemini, custom scripts) controls the
browser through this server over plain HTTP on 127.0.0.1. No API keys, no
dependencies — stdlib only.

How it works (HTTP polling, no native-messaging install friction):
  1. Run this server:            python3 server.py [--port 4973]
  2. Load connect-openly/firefox-extension in Firefox (about:debugging).
  3. The extension polls GET /pending every ~800ms, executes tool calls
     against browser tabs, and POSTs results to /result.
  4. CLI agents POST tool calls to /call and block until the browser answers
     (long-poll synchronously, default 90s timeout).

Endpoints:
  GET  /health          -> { ok, browser_connected, queue_len }
  GET  /tools           -> tool definitions (mirrors the reference extension)
  GET  /pending         -> browser poll: { jobs: [{id, tool, args}] } (clears queue)
  POST /call            -> agent: {tool, args, timeout?} -> waits -> {id, ok, result|error}
  POST /result          -> browser: {id, result?, error?} -> {ok: true}

Porting note (Chrome later): only the *extension side* changes
(chrome.debugger CDP calls instead of synthetic DOM events). This bridge
protocol stays identical, so CLI agents keep working unchanged.
"""

import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = "connect-openly"
VERSION = "0.1.2"

# Tool surface exposed to CLI agents. Mirrors the gist's toolset, minus the
# Chrome-CDP-only / account extras that make no sense for a generic bridge
# (gif_creator, shortcuts_*, update_plan, turn_answer_start, MCP group tools).
# `computer` covers click/type/key/scroll/screenshot/hover/drag/zoom.
TOOLS = [
    {"name": "tabs_context", "description": "List all open tabs (id, url, title, active). No args."},
    {"name": "tabs_create", "description": "Create a new tab. Args: {url?}."},
    {"name": "navigate", "description": "Navigate a tab. Args: {tabId, url} where url can be an http(s) URL or 'back'/'forward'."},
    {"name": "read_page", "description": "Accessibility-tree snapshot of a tab. Args: {tabId, filter?: 'interactive'|'all', depth?: n (default 15), ref_id?: 'ref_5', max_chars?: n}."},
    {"name": "get_page_text", "description": "Article-prioritised text of a tab. Args: {tabId, max_chars?}."},
    {"name": "form_input", "description": "Set a form element by ref from read_page. Args: {tabId, ref, value}."},
    {"name": "find", "description": "Substring search over page elements (the CLI agent's own LLM does semantic matching). Args: {tabId, query}. Returns up to 20 matches with refs + coordinates."},
    {"name": "javascript_tool", "description": "Execute JS in the page context, last expression returned. Args: {tabId, code}."},
    {"name": "computer", "description": "Mouse/keyboard/screenshot. Args: {tabId, action, coordinate?: [x,y], text?: str, scroll_direction?: 'up'|'down'|'left'|'right', scroll_amount?: 1-10, start_coordinate?: [x,y], region?: [x0,y0,x1,y1], ref?: 'ref_1'}. Actions: left_click, right_click, double_click, hover, type, key, screenshot, scroll, left_click_drag, zoom."},
    {"name": "read_console_messages", "description": "Console messages captured in the tab. Args: {tabId, onlyErrors?, pattern?, limit?, clear?}."},
    {"name": "read_network_requests", "description": "HTTP requests observed for the tab (via webRequest). Args: {tabId, urlPattern?, limit?, clear?}."},
    {"name": "resize_window", "description": "Resize the window containing a tab. Args: {tabId, width, height}."},
]

TOOL_NAMES = {t["name"] for t in TOOLS}

_lock = threading.Lock()
_queue: list = []          # jobs waiting for the browser: [{id, tool, args}]
_waiters: dict = {}        # id -> {"event": Event, "result": ..., "error": ...}
_last_browser_poll = 0.0


class Handler(BaseHTTPRequestHandler):
    server_version = f"{NAME}/{VERSION}"

    def log_message(self, fmt, *args):  # quieter logs
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}")

    # -- helpers ---------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"__parse_error__": True}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # -- routes ----------------------------------------------------------
    def do_GET(self):
        global _last_browser_poll
        if self.path == "/" or self.path.startswith("/health"):
            connected = (time.time() - _last_browser_poll) < 5.0
            with _lock:
                qlen = len(_queue)
            self._json({"ok": True, "name": NAME, "version": VERSION,
                        "browser_connected": connected, "queue_len": qlen})
        elif self.path.startswith("/tools"):
            self._json({"tools": TOOLS})
        elif self.path.startswith("/pending"):
            with _lock:
                jobs = list(_queue)
                _queue.clear()
                _last_browser_poll = time.time()
            self._json({"jobs": jobs})
        else:
            self._json({"ok": False, "error": "unknown route. Try /health, /tools, /pending, /call, /result."}, 404)

    def do_POST(self):
        if self.path.startswith("/call"):
            body = self._read_json()
            if "__parse_error__" in body:
                self._json({"ok": False, "error": "invalid JSON body"}, 400)
                return
            tool = body.get("tool")
            args = body.get("args") or {}
            try:
                timeout = float(body.get("timeout", 90))
            except (TypeError, ValueError):
                timeout = 90.0
            timeout = min(max(timeout, 5.0), 300.0)
            if tool not in TOOL_NAMES:
                self._json({"ok": False,
                            "error": f"unknown tool '{tool}'. Valid: {sorted(TOOL_NAMES)}"}, 400)
                return
            job_id = uuid.uuid4().hex[:12]
            event = threading.Event()
            entry = {"event": event, "result": None, "error": None}
            with _lock:
                _queue.append({"id": job_id, "tool": tool, "args": args})
                _waiters[job_id] = entry
            print(f"  queued {job_id} {tool} {json.dumps(args)[:160]}")
            got = event.wait(timeout)
            with _lock:
                _waiters.pop(job_id, None)
            if not got:
                self._json({"id": job_id, "ok": False,
                            "error": "timeout waiting for browser. Is the Firefox extension loaded and polling?"}, 504)
                return
            if entry["error"] is not None:
                self._json({"id": job_id, "ok": False, "error": entry["error"]})
            else:
                self._json({"id": job_id, "ok": True, "result": entry["result"]})
        elif self.path.startswith("/result"):
            body = self._read_json()
            job_id = body.get("id")
            with _lock:
                entry = _waiters.get(job_id)
                if entry is not None:
                    entry["result"] = body.get("result")
                    entry["error"] = body.get("error")
                    entry["event"].set()
            if entry is None:
                self._json({"ok": False, "error": f"unknown job id '{job_id}'"}, 404)
            else:
                self._json({"ok": True})
        else:
            self._json({"ok": False, "error": "unknown route. Try /health, /tools, /pending, /call, /result."}, 404)


def main():
    ap = argparse.ArgumentParser(description="Connect Openly bridge: lets any CLI AI agent control Firefox over HTTP.")
    ap.add_argument("--port", type=int, default=4973)
    ap.add_argument("--host", default="127.0.0.1", help="Keep as 127.0.0.1 (localhost only by design).")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"connect-openly bridge v{VERSION} on http://{args.host}:{args.port}")
    print("  1) load firefox-extension/ in Firefox (about:debugging -> Load Temporary Add-on)")
    print("  2) point any CLI agent at  POST http://127.0.0.1:%d/call" % args.port)
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
