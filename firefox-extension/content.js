/* Connect Openly — Firefox content script.
 * Builds the accessibility tree (read_page), executes DOM-level computer
 * actions (Firefox has no CDP Input.dispatchMouseEvent, so we use synthetic
 * DOM events + tabs.captureVisibleTab for screenshots), captures console.
 * No external dependencies. Chrome port later: same message protocol works. */
(function () {
  if (window.__connectOpenlyLoaded) return;
  window.__connectOpenlyLoaded = true;

  const B = (typeof browser !== "undefined") ? browser : chrome;

  /* ---- console capture ---- */
  const consoleBuffer = [];
  const MAX_CONSOLE = 300;
  function stringify(v) {
    try { return typeof v === "string" ? v : JSON.stringify(v); }
    catch (e) { return String(v); }
  }
  ["log", "warn", "error", "info", "debug"].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      try {
        consoleBuffer.push({ level, message: a.map(stringify).join(" "), url: location.href, time: new Date().toISOString() });
        if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
      } catch (e) {}
      return orig(...a);
    };
  });
  window.addEventListener("error", (e) => {
    consoleBuffer.push({ level: "error", message: "Uncaught: " + (e.message || e.error), url: location.href, time: new Date().toISOString() });
  });

  /* ---- element refs ---- */
  let refCounter = 0;
  const elementMap = {}; // ref_N -> element

  function roleFor(el) {
    if (el.getAttribute && el.getAttribute("role")) return el.getAttribute("role");
    const t = (el.tagName || "").toLowerCase();
    if (t === "a") return "link";
    if (t === "button") return "button";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (["submit", "button"].includes(ty)) return "button";
      if (["password", "email", "search", "tel", "url", "number"].includes(ty)) return "textbox";
      return "textbox";
    }
    if (t === "textarea") return "textbox";
    if (t === "select") return "combobox";
    if (t === "img") return "image";
    if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(t)) return "heading";
    return t || "generic";
  }

  function nameFor(el) {
    const cand = [el.getAttribute && el.getAttribute("aria-label"), el.getAttribute && el.getAttribute("placeholder"),
      el.getAttribute && el.getAttribute("title"), el.getAttribute && el.getAttribute("alt")];
    for (const c of cand) if (c && c.trim()) return c.trim().slice(0, 120);
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim().slice(0, 120);
    const t = (el.textContent || "").trim().replace(/\s+/g, " ");
    return t.slice(0, 120);
  }

  function isInteractive(el) {
    const t = (el.tagName || "").toLowerCase();
    return ["a", "button", "input", "textarea", "select", "option"].includes(t) ||
      el.isContentEditable || (el.getAttribute && (el.hasAttribute("onclick") || el.getAttribute("role")));
  }

  function registerRef(el) {
    for (const k in elementMap) if (elementMap[k] === el) return k;
    refCounter += 1;
    const id = "ref_" + refCounter;
    elementMap[id] = el;
    return id;
  }

  window.__generateAccessibilityTree = function (filter = "interactive", depth = 15, maxChars = 50000, refId = null) {
    let root = document.body || document.documentElement;
    if (refId && elementMap[refId]) root = elementMap[refId];
    const lines = [];
    function walk(node, d) {
      if (d > depth) return;
      if (node.nodeType !== 1) return;
      const el = node;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) return;
      const st = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const hidden = st && (st.width === 0 && st.height === 0);
      if (filter === "interactive" && !isInteractive(el) && d > 0) {
        // still descend — interactive children may exist below
      } else if (filter === "all" || isInteractive(el) || d === 0) {
        const ref = registerRef(el);
        const name = nameFor(el);
        let line = "  ".repeat(Math.min(d, 15)) + roleFor(el) + (name ? ' "' + name + '"' : "") + " [" + ref + "]";
        if (el.tagName === "A" && el.getAttribute("href")) line += ' href="' + el.getAttribute("href").slice(0, 120) + '"';
        if (el.tagName === "INPUT") line += ' type="' + (el.type || "text") + '"';
        if (el.tagName === "OPTION") line += (el.selected ? " (selected)" : "") + ' value="' + (el.value || "").slice(0, 80) + '"';
        if (hidden) line += " (hidden)";
        lines.push(line);
        if (el.tagName === "SELECT") {
          [...el.options].forEach((o) => {
            const oref = registerRef(o);
            lines.push("  ".repeat(Math.min(d + 1, 15)) + 'option "' + (o.text || "").slice(0, 80) + '"' + (o.selected ? " (selected)" : "") + " [" + oref + "]");
          });
        }
      }
      for (const child of el.children) {
        walk(child, d + 1);
        if (lines.join("\n").length > maxChars) return;
      }
    };
    walk(root, 0);
    let out = lines.join("\n");
    if (out.length > maxChars) {
      out = out.slice(0, maxChars) + "\n...[truncated — narrow with smaller depth or a ref_id]";
    }
    return out;
  };

  /* ---- computer actions (synthetic DOM events) ---- */
  function mouse(el, type, x, y, button = 0) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button }));
  }

  function clickAt(x, y, button = 0) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, error: "no element at " + x + "," + y };
    mouse(el, "mousemove", x, y);
    mouse(el, "mousedown", x, y, button);
    mouse(el, "mouseup", x, y, button);
    if (button === 0) mouse(el, "click", x, y);
    else el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }));
    return { ok: true };
  }

  function clickRef(ref, button = 0) {
    const el = elementMap[ref];
    if (!el || !el.isConnected) return { ok: false, error: "unknown/disconnected ref " + ref + " — re-run read_page" };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    return clickAt(x, y, button);
  }

  function typeText(text, ref, coord) {
    let target = null;
    if (ref && elementMap[ref]) target = elementMap[ref];
    else if (coord) target = document.elementFromPoint(coord[0], coord[1]);
    if (!target || !/INPUT|TEXTAREA/.test(target.tagName || "") && !target.isContentEditable) {
      target = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    }
    if (!target) return { ok: false, error: "no text target — click a field first or pass ref" };
    target.focus();
    let done = false;
    try { done = document.execCommand("insertText", false, text); } catch (e) {}
    if (!done) {
      if (target.isContentEditable) target.textContent += text;
      else target.value = (target.value || "") + text;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function pressKey(text) {
    // space-separated keys, '+' chords, e.g. "Control+l Enter"
    const target = document.activeElement || document.body;
    for (const combo of text.split(" ")) {
      const parts = combo.split("+");
      const key = parts[parts.length - 1];
      const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
      const init = { bubbles: true, cancelable: true, key,
        ctrlKey: mods.includes("control") || mods.includes("ctrl"),
        shiftKey: mods.includes("shift"), altKey: mods.includes("alt"),
        metaKey: mods.includes("meta") || mods.includes("cmd") };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keypress", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    }
    return { ok: true };
  }

  function scrollBy(dir, amt, ref, coord) {
    const px = (amt || 3) * 100;
    const d = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[dir || "down"] || [0, px];
    let el = null;
    if (ref && elementMap[ref]) el = elementMap[ref];
    else if (coord) el = document.elementFromPoint(coord[0], coord[1]);
    if (el && el.scrollHeight > el.clientHeight) el.scrollBy(d[0], d[1]);
    else window.scrollBy(d[0], d[1]);
    return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  /* ---- access indicator: glow border + pill + animated tab title ----
     Mirrors Claude-in-Chrome's "agent is working here" signal (orange frame
     + tab-group status). Shown while a bridge job touches this tab, removed
     when the job finishes (brief checkmark first). Pure overlay: no layout
     shift, pointer-events none, so it can never break the page. */
  const ActiveIndicator = (() => {
    const GLOW_ID = "__connect-openly-glow";
    const PILL_ID = "__connect-openly-pill";
    const STYLE_ID = "__connect-openly-style";
    const FRAMES = ["◐", "◓", "◑", "◒"];
    let timer = null, frame = 0, origTitle = null, restoreTimer = null;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent =
        "@keyframes __coPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }" +
        "#" + GLOW_ID + " { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;" +
        " border: 3px solid rgba(249,115,22,0.95); border-radius: 8px;" +
        " box-shadow: inset 0 0 28px rgba(249,115,22,0.35), 0 0 22px rgba(249,115,22,0.45);" +
        " animation: __coPulse 1.6s ease-in-out infinite; }" +
        "#" + PILL_ID + " { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);" +
        " z-index: 2147483647; pointer-events: none; font: 13px system-ui, sans-serif;" +
        " color: #fff; background: rgba(20,20,20,0.88); border: 1px solid rgba(249,115,22,0.8);" +
        " border-radius: 999px; padding: 7px 14px; animation: __coPulse 1.6s ease-in-out infinite; }" +
        "@keyframes __coClick { 0% { transform: scale(0.4); opacity: 1; } 100% { transform: scale(1.7); opacity: 0; } }" +
        ".__co-click { position: fixed; z-index: 2147483647; pointer-events: none;" +
        " width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;" +
        " border: 3px solid rgba(249,115,22,0.95);" +
        " background: radial-gradient(circle, rgba(249,115,22,1) 0 3px, transparent 4px);" +
        " animation: __coClick 0.9s ease-out forwards; }";
      (document.head || document.documentElement).appendChild(st);
    }

    function show() {
      ensureStyle();
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
      if (origTitle === null) origTitle = document.title;
      if (!document.getElementById(GLOW_ID)) {
        const g = document.createElement("div");
        g.id = GLOW_ID;
        document.documentElement.appendChild(g);
      }
      if (!document.getElementById(PILL_ID)) {
        const p = document.createElement("div");
        p.id = PILL_ID;
        p.textContent = "● Connect Openly is controlling this tab…";
        document.documentElement.appendChild(p);
      }
      if (!timer) {
        timer = setInterval(() => {
          frame = (frame + 1) % FRAMES.length;
          try { document.title = FRAMES[frame] + " Connect Openly · " + origTitle; } catch (e) {}
        }, 250);
      }
    }

    function hide(success) {
      if (timer) { clearInterval(timer); timer = null; }
      const g = document.getElementById(GLOW_ID); if (g) g.remove();
      const p = document.getElementById(PILL_ID); if (p) p.remove();
      if (origTitle !== null) {
        try { document.title = (success === false ? "⚠ " : "✅ ") + origTitle; } catch (e) {}
        const saved = origTitle;
        origTitle = null;
        restoreTimer = setTimeout(() => {
          try { if (document.title !== saved) document.title = saved; } catch (e) {}
          restoreTimer = null;
        }, 4000);
      }
    }

    return { show, hide };
  })();

  /* ---- click marker: visible ripple wherever the agent acts ----
     A pulsing orange ring (+ dot) appears at the exact click/type point so
     a watching human sees what the agent is doing, live. Pure overlay,
     pointer-events none, auto-removes after ~1s. */
  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }

  function actionPoint(msg) {
    if (msg && msg.ref && elementMap[msg.ref] && elementMap[msg.ref].isConnected) {
      return centerOf(elementMap[msg.ref]);
    }
    if (msg && msg.coordinate) return msg.coordinate;
    if (msg && msg.startCoordinate) return msg.startCoordinate;
    const a = document.activeElement;
    if (a && a !== document.body && a.getBoundingClientRect) return centerOf(a);
    return null;
  }

  function showClickMarker(x, y) {
    try {
      if (typeof x !== "number" || typeof y !== "number") return;
      const m = document.createElement("div");
      m.className = "__co-click";
      m.style.left = x + "px";
      m.style.top = y + "px";
      document.documentElement.appendChild(m);
      setTimeout(() => m.remove(), 1000);
    } catch (e) {}
  }

  /* ---- message handling ---- */
  B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "PING": sendResponse({ ok: true, url: location.href }); break;
          case "READ_PAGE":
            sendResponse({ ok: true, tree: window.__generateAccessibilityTree(msg.filter || "interactive", msg.depth || 15, msg.maxChars || 50000, msg.refId || null) });
            break;
          case "PAGE_TEXT": {
            const sels = ["article", "main", '[role="main"]', ".content", "#content"];
            let best = null;
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el && el.textContent && (!best || el.textContent.length > best.textContent.length)) best = el;
            }
            const src = best || document.body;
            let text = "Title: " + document.title + "\nURL: " + location.href + "\n---\n" + (src.innerText || src.textContent || "");
            const max = msg.maxChars || 50000;
            if (text.length > max) text = text.slice(0, max) + "\n...[truncated]";
            sendResponse({ ok: true, text });
            break;
          }
          case "FORM_INPUT": {
            const el = elementMap[msg.ref];
            if (!el || !el.isConnected) { sendResponse({ ok: false, error: "unknown ref " + msg.ref }); break; }
            if (location.hostname !== new URL(sender.url || location.href).hostname && sender.url) {
              // sender check kept minimal; background also verifies domain
            }
            el.scrollIntoView({ block: "center" });
            try { const __c = centerOf(el); showClickMarker(__c[0], __c[1]); } catch (e) {}
            const v = msg.value, tag = el.tagName;
            if (tag === "SELECT") {
              let matched = false;
              for (const o of el.options) {
                if (o.value === String(v) || o.text === String(v)) { el.value = o.value; matched = true; break; }
              }
              if (!matched) { sendResponse({ ok: false, error: "no such option: " + v }); break; }
            } else if (el.type === "checkbox") el.checked = !!v;
            else if (el.type === "radio") el.checked = true;
            else if (el.type === "number" || el.type === "range") el.value = Number(v);
            else el.value = v;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            sendResponse({ ok: true });
            break;
          }
          case "FIND": {
            const q = (msg.query || "").toLowerCase();
            const out = [];
            const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
            let n;
            while ((n = walker.nextNode()) && out.length < 20) {
              if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.tagName)) continue;
              const hay = (roleFor(n) + " " + nameFor(n) + " " + (n.textContent || "").slice(0, 200)).toLowerCase();
              if (q && hay.includes(q)) {
                const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { x: 0, y: 0 };
                out.push({ ref: registerRef(n), role: roleFor(n), name: nameFor(n).slice(0, 80), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
              }
            }
            sendResponse({ ok: true, matches: out });
            break;
          }
          case "JS_EXEC": {
            // eslint-disable-next-line no-eval
            const val = eval(msg.code);
            let text;
            try { text = typeof val === "string" ? val : JSON.stringify(val); }
            catch (e) { text = String(val); }
            sendResponse({ ok: true, value: text });
            break;
          }
          case "COMPUTER": {
            const a = msg.computerAction;
            // marker first: human sees WHERE before the action lands
            const __pt = actionPoint(msg);
            if (__pt) showClickMarker(__pt[0], __pt[1]);
            if (a === "left_click_drag" && msg.coordinate) showClickMarker(msg.coordinate[0], msg.coordinate[1]);
            let r;
            if (a === "left_click") r = msg.ref ? clickRef(msg.ref) : clickAt(msg.coordinate[0], msg.coordinate[1]);
            else if (a === "right_click") r = msg.ref ? clickRef(msg.ref, 2) : clickAt(msg.coordinate[0], msg.coordinate[1], 2);
            else if (a === "double_click") {
              r = msg.ref ? clickRef(msg.ref) : clickAt(msg.coordinate[0], msg.coordinate[1]);
              const r2 = msg.ref ? clickRef(msg.ref) : clickAt(msg.coordinate[0], msg.coordinate[1]);
              r = r.ok && r2.ok ? { ok: true } : { ok: false, error: "double click partially failed" };
            } else if (a === "hover") {
              const el = msg.ref && elementMap[msg.ref] ? elementMap[msg.ref] : document.elementFromPoint(msg.coordinate[0], msg.coordinate[1]);
              if (el) { const r0 = el.getBoundingClientRect(); mouse(el, "mousemove", r0.x + r0.width / 2, r0.y + r0.height / 2); r = { ok: true }; }
              else r = { ok: false, error: "hover: no element" };
            } else if (a === "type") r = typeText(msg.text || "", msg.ref, msg.coordinate);
            else if (a === "key") r = pressKey(msg.text || "");
            else if (a === "scroll" || a === "scroll_to") {
              if (a === "scroll_to" && msg.ref && elementMap[msg.ref]) { elementMap[msg.ref].scrollIntoView({ block: "center" }); r = { ok: true }; }
              else r = scrollBy(msg.scrollDirection, msg.scrollAmount, msg.ref, msg.coordinate);
            } else if (a === "left_click_drag") {
              const [x1, y1] = msg.startCoordinate, [x2, y2] = msg.coordinate;
              const el = document.elementFromPoint(x1, y1) || document.body;
              mouse(el, "mousemove", x1, y1); mouse(el, "mousedown", x1, y1);
              mouse(el, "mousemove", x2, y2); mouse(el, "mouseup", x2, y2);
              r = { ok: true };
            } else if (a === "zoom") {
              r = { ok: true, region: msg.region, note: "re-screenshot then crop client-side (see CLI screenshot --crop)" };
            } else if (a === "wait") r = { ok: true };
            else r = { ok: false, error: "unknown computer action: " + a };
            sendResponse(r.ok ? { ok: true, detail: r } : r);
            break;
          }
          case "CROP_IMAGE": {
            // background captured full-tab PNG -> crop here to region
            const img = new Image();
            img.onload = () => {
              const [x0, y0, x1, y1] = msg.region;
              const sx = img.width / window.innerWidth, sy = img.height / window.innerHeight;
              const c = document.createElement("canvas");
              c.width = Math.max(1, Math.round((x1 - x0) * sx)); c.height = Math.max(1, Math.round((y1 - y0) * sy));
              c.getContext("2d").drawImage(img, x0 * sx, y0 * sy, c.width, c.height, 0, 0, c.width, c.height);
              sendResponse({ ok: true, dataUrl: c.toDataURL("image/png") });
            };
            img.onerror = () => sendResponse({ ok: false, error: "crop failed" });
            img.src = msg.dataUrl;
            return; // async — sendResponse later
          }
          case "READ_CONSOLE": {
            let items = consoleBuffer.slice();
            if (msg.onlyErrors) items = items.filter((m) => m.level === "error");
            if (msg.pattern) { try { const re = new RegExp(msg.pattern); items = items.filter((m) => re.test(m.message)); } catch (e) {} }
            items = items.slice(-(msg.limit || 100));
            if (msg.clear) consoleBuffer.length = 0;
            sendResponse({ ok: true, messages: items });
            break;
          }
          case "VIEWPORT":
            sendResponse({ ok: true, width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1, url: location.href });
            break;
          case "SHOW_ACTIVE":
            ActiveIndicator.show();
            sendResponse({ ok: true });
            break;
          case "HIDE_ACTIVE":
            ActiveIndicator.hide(msg.ok !== false);
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ ok: false, error: "unknown content message: " + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // async response
  });
})();
