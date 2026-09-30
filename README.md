# Connect Openly 🦊 — Control Firefox from Any CLI AI Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Firefox](https://img.shields.io/badge/Firefox-109%2B-orange.svg)](firefox-extension/manifest.json)
[![Python](https://img.shields.io/badge/Python-3-stdlib_only-blue.svg)](bridge/server.py)
[![No dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen.svg)](bridge/server.py)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](https://github.com/pranaypaulhb/connect-openly/pulls)

**Give your terminal AI agent eyes and hands in the browser.** Connect Openly lets **opencode, Claude Code, Gemini CLI — anything that can POST HTTP** — drive Firefox: list tabs, read the accessibility tree, click, type, take screenshots, and pull console + network logs. **Stdlib only. Localhost only. No API keys. No vendor lock-in.**

Inspired by the [Claude-for-Chrome extension internals](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b) (agentic loop, accessibility tree + refs, computer actions, console/network readers) — reworked so the *agent lives in your terminal* instead of a side panel.

## Why this exists

CLI AI coding agents can write frontend code, fill forms, and call APIs — but they can't **see** the page, **click** through a flow, or **read** the console error their change just caused. That forces you to be the human screen-reader in the loop.

Connect Openly closes the loop: your agent builds the UI, screenshots it, clicks through it, reads the errors, and fixes them — autonomously.

## Real-world use cases

- **Frontend dev loop** — agent writes a component, screenshots the page, spots the broken layout, fixes the CSS, re-checks. No human in the middle.
- **Automated QA for web apps** — agent clicks through signup → checkout → payment flows, asserts results, and reports console/network failures.
- **Web research & scraping with vision** — navigate, read article-mode text, screenshot charts and dashboards your API can't reach.
- **Debugging production issues** — pull `read_console_messages` + `read_network_requests` straight into the agent that fixes the bug.
- **Form & workflow automation** — reliable ref-based `form_input` (dropdowns, checkboxes, radios) plus coordinate clicks from screenshots.
- **Accessibility checks** — the agent reasons over the real accessibility tree, not raw HTML soup.

## Features

- 🦊 **Firefox-first** — tabs, navigation, `captureVisibleTab` screenshots, `webRequest` logging
- 🌳 **Accessibility tree with stable refs** (`read_page`) — `form_input`, `find`, `scroll_to` target `ref_1…ref_N`
- 🖱️ **Computer actions** — click / right / double / hover / type / key chords / scroll / drag / zoom-region / wait
- 📸 **Screenshots + viewport geometry** returned as base64 — agent maps pixels to `computer` coordinates
- 🧪 **Console + network readers** with regex filter, limit, and clear
- 🟠 **"AI is working here" indicator** — orange glow frame + pill + animated tab title + toolbar badge while a job touches a tab (pure overlay, never breaks the page)
- 🔌 **Any agent, one HTTP endpoint** — `POST 127.0.0.1:4973/call {"tool","args"}` → `{"ok","result"}`; works with opencode, Claude Code, Gemini, curl, Python
- 📦 **Zero dependencies** — Python stdlib + vanilla JS only

## Quick start (3 min)

```bash
# 1) one-time setup: enables the extension's Start/Stop buttons + auto-start
bash native-host/install_host.sh

# 2) extension (Firefox)
# about:debugging → This Firefox → Load Temporary Add-on →
#   pick firefox-extension/manifest.json
# The bridge now starts itself on browser launch.
# Manual control: toolbar icon → ▶ Start server / ■ Stop server.

# 3) drive it from any terminal
python3 cli/connect_openly.py health
python3 cli/connect_openly.py tabs
python3 cli/connect_openly.py read <tabId>
python3 cli/connect_openly.py nav <tabId> example.com
python3 cli/connect_openly.py screenshot <tabId> -o shot.png
```

## Connect your AI agent

Paste this into your agent's instructions, or run `python3 cli/connect_openly.py agent-guide`:

```
Browser control via POST http://127.0.0.1:4973/call
{"tool","args"} -> {"ok","result"}. Workflow: tabs_context -> read_page ->
act (form_input/computer) -> verify (screenshot/get_page_text/console/network).
```

- **opencode** — add a shell tool or `curl -s -X POST localhost:4973/call -d '{"tool":"tabs_context","args":{}}'`
- **Claude Code** — same endpoint via a Skill or `Bash(curl …)`; screenshots return as viewable PNG data
- **curl / Python** — `GET /tools` lists all 12 tools with schemas
- Screenshots come back as `data:image/png;base64,…` + viewport dims — view the image, then click with `computer {tabId, action:left_click, coordinate:[x,y]}`

## Tools (12)

| Tool | What it does |
|---|---|
| `tabs_context` | List all open tabs (id, url, title, active) |
| `tabs_create` | Open a new tab |
| `navigate` | Go to URL, or `back` / `forward` |
| `read_page` | Accessibility-tree snapshot with refs (`filter`, `depth`, `ref_id`) |
| `get_page_text` | Article-prioritised page text |
| `form_input` | Set a form element by ref (select, checkbox, radio, text, number) |
| `find` | Substring search over elements → refs + coordinates (your LLM does semantic matching) |
| `javascript_tool` | Execute JS in page context, last expression returned |
| `computer` | Mouse/keyboard/screenshot: `left_click`, `right_click`, `double_click`, `hover`, `type`, `key`, `scroll`, `scroll_to`, `left_click_drag`, `screenshot`, `zoom`, `wait` |
| `read_console_messages` | Console capture (`onlyErrors`, `pattern`, `limit`, `clear`) |
| `read_network_requests` | webRequest log (`urlPattern`, `limit`, `clear`) |
| `resize_window` | Resize the window holding a tab |

## Architecture

```
CLI AI agent (opencode / Claude Code / Gemini / curl / python)
        │  POST 127.0.0.1:4973/call {"tool","args"}   (blocks ≤90s)
        ▼
bridge/server.py  (stdlib only, localhost-only, no deps)
        │  GET /pending (extension polls) / POST /result
        ▼
Firefox extension (background.js + content.js)
  background: tabs/navigate/screenshot(captureVisibleTab)/webRequest log
  content:    a11y tree + ref map, synthetic click/type/key/scroll,
              form_input, JS exec, console capture, image crop
```

Honest Firefox-vs-Chrome notes (not hidden):
- **No CDP `Input.dispatchMouseEvent`** in Firefox → clicks/typing are synthetic DOM events (work on real pages; `about:*`/PDF viewer support `navigate` only).
- **No nested inner-LLM `find`** → `find` is substring search; *your* agent's LLM does the semantic matching.
- **No OAuth/API-key side panel** → there is no side panel; the agent is your CLI tool.
- Localhost bridge is pre-trusted; internet origins get nothing — the server binds `127.0.0.1`.

## Verify without Firefox

```bash
python3 -m py_compile bridge/server.py cli/connect_openly.py
node --check firefox-extension/background.js && node --check firefox-extension/content.js && node --check firefox-extension/popup.js
python3 bridge/server.py & sleep 1
curl -s localhost:4973/health; kill %1
```

## Roadmap → Chrome

1. Copy `firefox-extension/` → `chrome-extension/`, manifest V3 + `chrome.debugger` CDP actions.
2. Keep `/pending /call /result` identical → CLI agents unchanged.
3. Optional: record/replay shortcuts, plan-approval mode as bridge-side policy.

## Contributing

PRs welcome — especially the Chrome port, new `computer` actions, and agent guides (opencode Skills, Claude Code plugins). Open an issue first for big changes.

⭐ **If this gave your agent eyes, star the repo** — it helps others find it.

## License

MIT — see [LICENSE](LICENSE).
