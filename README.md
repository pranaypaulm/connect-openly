# Connect Openly 🦊

**Any CLI AI agent can control Firefox.** A Firefox-first port of the ideas in [Claude-for-Chrome extension internals](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b) (agentic loop, accessibility tree + refs, computer actions, tab groups, console/network readers) — reworked so the *agent lives in your terminal* (opencode, Claude Code, Gemini, anything that can POST HTTP) instead of in a side panel.

Chrome port later: only `firefox-extension/background.js` + `content.js` change (CDP `chrome.debugger` instead of synthetic DOM events). **The bridge protocol below stays identical**, so CLI agents keep working.

## Architecture

```
CLI AI agent (opencode / claude / curl / python)
        │  POST 127.0.0.1:4973/call {"tool","args"}   (blocks ≤90s)
        ▼
bridge/server.py  (stdlib only, localhost-only, no deps)
        │  GET /pending (extension polls 800ms) / POST /result
        ▼
Firefox extension (background.js + content.js)
  background: tabs/navigate/screenshot(captureVisibleTab)/webRequest log
  content:    a11y tree + ref map, synthetic click/type/key/scroll,
              form_input, JS exec, console capture, image crop
```

Firefox differences from the Chrome reference (honest, not hidden):
- **No CDP `Input.dispatchMouseEvent`** in Firefox → clicks/typing are synthetic DOM events (work on real pages, not on `about:*`/PDF viewer; `navigage`-only there, same rule as the gist's system pages).
- **No nested inner-LLM `find`** → `find` is substring search; *your* agent's LLM does the semantic matching (better for a generic bridge).
- **No OAuth/API-key side panel** → there is no side panel; the agent is your CLI tool. No Anthropic SDK in the browser.
- Permissions: localhost bridge is pre-trusted (like the gist's `skip_all_permission_checks` mode). Internet origins get nothing — the server binds `127.0.0.1`.

## Quick start (3 min)

```bash
# 1) one-time setup: enables the extension's Start/Stop buttons + auto-start
bash connect-openly/native-host/install_host.sh

# 2) extension (Firefox)
# about:debugging → This Firefox → Load Temporary Add-on →
#   pick connect-openly/firefox-extension/manifest.json
# The bridge now starts itself in the background on browser launch.
# Manual control: click the toolbar icon → ▶ Start server / ■ Stop server.

# 3) drive it from any terminal
python3 cli/connect_openly.py health
python3 cli/connect_openly.py tabs
python3 cli/connect_openly.py read <tabId>
python3 cli/connect_openly.py nav <tabId> example.com
python3 cli/connect_openly.py screenshot <tabId> -o shot.png
```

## Use from an AI agent

Paste this into your agent's instructions, or run `python3 cli/connect_openly.py agent-guide`:

```
Browser control via POST http://127.0.0.1:4973/call
{"tool","args"} -> {"ok","result"}. Workflow: tabs_context -> read_page ->
act (form_input/computer) -> verify (screenshot/get_page_text/console/network).
```

- **opencode**: add a shell tool or `curl -s -X POST localhost:4973/call -d '{"tool":"tabs_context","args":{}}'`.
- **curl**: same endpoint, any tool from `GET /tools`.
- Screenshots come back as `data:image/png;base64,…` + viewport dims — view the image, then click with `computer {tabId, action:left_click, coordinate:[x,y]}`.

## Tools (12)

`tabs_context, tabs_create, navigate, read_page, get_page_text, form_input, find, javascript_tool, computer (left/right/double click, hover, type, key, scroll, scroll_to, drag, screenshot, zoom, wait), read_console_messages, read_network_requests, resize_window`

## "AI is working here" indicator

Like Claude-in-Chrome's debugging banner + tab-group glow, every job that touches a tab shows, for the duration of the job:

- **orange glow frame** around the page + a `● Connect Openly is controlling this tab…` pill (pure overlay, `pointer-events: none` — can never break the page),
- **animated tab title** (`◐/◓/◑/◒ Connect Openly · …`),
- **orange `●` badge** on the toolbar icon while any job is active.

When the job finishes the frame/pill vanish, the title flashes `✅` for 4s, then everything returns to normal (`⚠` if the job errored). Tab jobs on `about:*` pages skip the frame (no content script) but still set the badge. (Chrome's native *"started debugging this browser"* banner and tab-group pills have no Firefox API equivalent — title + frame + badge is the faithful port.)

## Repo layout

```
connect-openly/
  firefox-extension/  manifest.json (MV2/gecko) background.js content.js popup.*
  bridge/server.py    ThreadingHTTPServer, /health /tools /pending /call /result
  cli/connect_openly.py  stdlib CLI: health tools tabs read text nav js screenshot click type call agent-guide
```

## Verify without Firefox

```bash
python3 -m py_compile bridge/server.py cli/connect_openly.py
node --check firefox-extension/background.js && node --check firefox-extension/content.js && node --check firefox-extension/popup.js
python3 - <<'EOF'
import json; json.load(open('firefox-extension/manifest.json')); print("manifest OK")
EOF
python3 bridge/server.py & sleep 1
curl -s localhost:4973/health; curl -s localhost:4973/tools | head -c 200; kill %1
```

## Roadmap → Chrome
1. Copy `firefox-extension/` → `chrome-extension/`, manifest V3 + `chrome.debugger` CDP actions.
2. Keep `/pending /call /result` identical → CLI agents unchanged.
3. Optional: record/replay shortcuts, plan-approval mode (from the gist) as bridge-side policy.
