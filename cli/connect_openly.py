#!/usr/bin/env python3
"""connect-openly CLI — control Firefox from any terminal / AI agent.

Examples:
  python3 connect_openly.py health
  python3 connect_openly.py tools
  python3 connect_openly.py tabs
  python3 connect_openly.py read 12
  python3 connect_openly.py nav 12 https://example.com
  python3 connect_openly.py screenshot 12 -o shot.png
  python3 connect_openly.py js 12 "document.title"
  python3 connect_openly.py click 12 640 420
  python3 connect_openly.py type 12 "hello" --ref ref_3
  python3 connect_openly.py call computer '{"tabId": 12, "action": "scroll", "scroll_direction": "down"}'
  python3 connect_openly.py agent-guide   # paste into your agent's system prompt

Environment: CONNECT_OPENLY_BRIDGE=http://127.0.0.1:4973 (override --bridge).
Stdlib only.
"""
import argparse, base64, json, os, sys, urllib.request, urllib.error

BRIDGE = os.environ.get("CONNECT_OPENLY_BRIDGE", "http://127.0.0.1:4973")

def http(method, path, body=None, timeout=100):
    req = urllib.request.Request(BRIDGE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return {"http_error": e.code, **json.loads(e.read().decode())}
        except Exception: return {"http_error": e.code, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"bridge unreachable at {BRIDGE}: {e}. Start it: python3 bridge/server.py"}

def call(tool, args, timeout=90):
    return http("POST", "/call", {"tool": tool, "args": args, "timeout": timeout}, timeout=timeout + 10)

AGENT_GUIDE = """Connect Openly — browser control for CLI AI agents (Firefox).
Bridge: POST {BRIDGE}/call {"tool": ..., "args": {...}, "timeout": 90} -> {"ok": true, "result": ...}

Workflow: tabs_context -> navigate/read_page -> act -> verify.
1. tabs_context {} -> pick tabId.
2. read_page {tabId, filter: "interactive"} -> refs (ref_1...) + coordinates.
3. Act: form_input {tabId, ref, value} for forms (reliable) or computer {tabId, action: left_click|type|key|scroll|screenshot, ...}.
4. computer screenshot returns {image: data:image/png;base64,..., width, height} — view it, map coordinates.
5. Coordinate clicks: computer {tabId, action: left_click, coordinate: [x, y]}. Typing: {action: type, text: ...} after clicking the field. Keys: {action: key, text: "Enter"}.
6. Read results: get_page_text {tabId}, read_console_messages {tabId}, read_network_requests {tabId}.
7. JS escape hatch: javascript_tool {tabId, code}.
Notes: refs expire on navigation (re-run read_page). about:* pages support navigate only. localhost-only bridge = trusted; still avoid typing secrets.
"""

def main():
    global BRIDGE
    ap = argparse.ArgumentParser(description="Control Firefox via connect-openly bridge.")
    ap.add_argument("--bridge", default=BRIDGE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("health"); sub.add_parser("tools"); sub.add_parser("tabs"); sub.add_parser("agent-guide")
    p = sub.add_parser("call"); p.add_argument("tool"); p.add_argument("args_json", nargs="?", default="{}"); p.add_argument("--timeout", type=float, default=90)
    p = sub.add_parser("read"); p.add_argument("tabId", type=int); p.add_argument("--filter", default="interactive"); p.add_argument("--timeout", type=float, default=90)
    p = sub.add_parser("text"); p.add_argument("tabId", type=int); p.add_argument("--timeout", type=float, default=90)
    p = sub.add_parser("nav"); p.add_argument("tabId", type=int); p.add_argument("url"); p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("js"); p.add_argument("tabId", type=int); p.add_argument("code"); p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("screenshot"); p.add_argument("tabId", type=int); p.add_argument("-o", "--out", default="shot.png"); p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("click"); p.add_argument("tabId", type=int); p.add_argument("x", type=int); p.add_argument("y", type=int); p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("type"); p.add_argument("tabId", type=int); p.add_argument("text"); p.add_argument("--ref", default=None); p.add_argument("--timeout", type=float, default=60)
    a = ap.parse_args()
    BRIDGE = a.bridge.rstrip("/")

    if a.cmd == "health": print(json.dumps(http("GET", "/health"), indent=1))
    elif a.cmd == "tools": print(json.dumps(http("GET", "/tools"), indent=1))
    elif a.cmd == "agent-guide": print(AGENT_GUIDE.replace("{BRIDGE}", BRIDGE))
    elif a.cmd == "tabs":
        r = call("tabs_context", {}, a.timeout if hasattr(a, "timeout") else 60); print(json.dumps(r, indent=1))
    elif a.cmd == "call": print(json.dumps(call(a.tool, json.loads(a.args_json), a.timeout), indent=1)[:20000])
    elif a.cmd == "read": print(json.dumps(call("read_page", {"tabId": a.tabId, "filter": a.filter}, a.timeout), indent=1)[:20000])
    elif a.cmd == "text": print(json.dumps(call("get_page_text", {"tabId": a.tabId}, a.timeout), indent=1)[:20000])
    elif a.cmd == "nav": print(json.dumps(call("navigate", {"tabId": a.tabId, "url": a.url}, a.timeout), indent=1))
    elif a.cmd == "js": print(json.dumps(call("javascript_tool", {"tabId": a.tabId, "code": a.code}, a.timeout), indent=1)[:20000])
    elif a.cmd == "screenshot":
        r = call("computer", {"tabId": a.tabId, "action": "screenshot"}, a.timeout)
        try:
            img = r["result"]["image"]; data = base64.b64decode(img.split(",", 1)[1])
            open(a.out, "wb").write(data)
            print(f"saved {a.out} ({len(data)} bytes) {r['result'].get('width')}x{r['result'].get('height')}")
        except Exception as e: print(json.dumps(r, indent=1)[:4000]); sys.exit(1)
    elif a.cmd == "click": print(json.dumps(call("computer", {"tabId": a.tabId, "action": "left_click", "coordinate": [a.x, a.y]}, a.timeout), indent=1))
    elif a.cmd == "type":
        args = {"tabId": a.tabId, "action": "type", "text": a.text}
        if a.ref: args["ref"] = a.ref
        print(json.dumps(call("computer", args, a.timeout), indent=1))

if __name__ == "__main__":
    main()
