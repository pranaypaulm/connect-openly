/* Connect Openly — Firefox background script.
 * Polls the local bridge (http://127.0.0.1:4973/pending), executes tool calls
 * against tabs (background APIs + content-script messages), POSTs results.
 * Firefox-first (browser.* promises). Chrome port: swap captureVisibleTab +
 * synthetic events for chrome.debugger CDP attach/Input.dispatchMouseEvent;
 * the bridge protocol is unchanged. */
const B = (typeof browser !== "undefined") ? browser : chrome;
const BRIDGE = "http://127.0.0.1:4973";
const POLL_MS = 250; // localhost polling is cheap; 800ms added a full step of lag to every agent action

/* network log for read_network_requests (webRequest, last 500) */
const netLog = [];
try {
  B.webRequest.onCompleted.addListener((d) => {
    netLog.push({ tabId: d.tabId, url: d.url.slice(0, 500), method: d.method, statusCode: d.statusCode, type: d.type, time: new Date().toISOString() });
    if (netLog.length > 500) netLog.splice(0, netLog.length - 500);
  }, { urls: ["<all_urls>"] });
} catch (e) { console.warn("webRequest unavailable:", e); }

let activeJobs = 0;

async function refreshBadge() {
  try {
    if (activeJobs > 0) {
      B.browserAction.setBadgeText({ text: "●" });
      B.browserAction.setBadgeBackgroundColor({ color: "#f97316" });
      B.browserAction.setTitle({ title: "Connect Openly: controlling " + activeJobs + " tab(s)…" });
    } else {
      B.browserAction.setBadgeText({ text: "" });
      B.browserAction.setTitle({ title: "Connect Openly: connected to bridge" });
    }
  } catch (e) {}
}

/* Show the in-page "AI is working here" frame on the touched tab.
 * Best-effort: never fails the job (system pages have no content script). */
async function setTabActive(tabId, on, ok) {
  if (tabId == null) return;
  try {
    await B.tabs.sendMessage(tabId, on ? { type: "SHOW_ACTIVE" } : { type: "HIDE_ACTIVE", ok });
  } catch (e) {}
}

async function sendToTab(tabId, msg) {
  try {
    return await B.tabs.sendMessage(tabId, msg);
  } catch (e) {
    throw new Error("tab " + tabId + " unreachable (" + (e.message || e) + ") — system pages like about:config have no content script; use navigate first");
  }
}

async function tabsContext() {
  const tabs = await B.tabs.query({});
  return tabs.map((t) => ({ tabId: t.id, url: t.url || "", title: t.title || "", active: !!t.active, windowId: t.windowId }));
}

async function doScreenshot(tabId, region) {
  const tab = await B.tabs.get(tabId);
  await B.tabs.update(tabId, { active: true });
  await B.windows.update(tab.windowId, { focused: true });
  await new Promise((r) => setTimeout(r, 250)); // let compositor settle
  let dataUrl = await B.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  let vp = {};
  try { vp = await sendToTab(tabId, { type: "VIEWPORT" }); } catch (e) {}
  if (region) {
    // crop via content-script canvas (maps CSS px -> image px with DPR)
    const cropped = await sendToTab(tabId, { type: "CROP_IMAGE", dataUrl, region });
    if (cropped && cropped.ok) dataUrl = cropped.dataUrl;
  }
  return { image: dataUrl, width: vp.width, height: vp.height, devicePixelRatio: vp.devicePixelRatio, url: vp.url };
}

async function execute(tool, args) {
  args = args || {};
  switch (tool) {
    case "tabs_context": return { tabs: await tabsContext() };
    case "tabs_create": {
      const t = await B.tabs.create(args.url ? { url: args.url } : {});
      return { tabId: t.id, url: t.url || "" };
    }
    case "navigate": {
      const { tabId, url } = args;
      if (!tabId || !url) throw new Error("navigate needs {tabId, url}");
      if (url === "back") { await B.tabs.goBack(tabId); return { ok: true }; }
      if (url === "forward") { await B.tabs.goForward(tabId); return { ok: true }; }
      const finalUrl = /^[a-z]+:\/\//i.test(url) ? url : "https://" + url;
      await B.tabs.update(tabId, { url: finalUrl });
      return { ok: true, url: finalUrl };
    }
    case "read_page":
      return sendToTab(args.tabId, { type: "READ_PAGE", filter: args.filter, depth: args.depth, maxChars: args.max_chars, refId: args.ref_id });
    case "get_page_text":
      return sendToTab(args.tabId, { type: "PAGE_TEXT", maxChars: args.max_chars });
    case "form_input": {
      // domain-stability check (mirrors gist's URL verification): verify tab still on same host as... best-effort
      return sendToTab(args.tabId, { type: "FORM_INPUT", ref: args.ref, value: args.value });
    }
    case "find":
      return sendToTab(args.tabId, { type: "FIND", query: args.query || "" });
    case "javascript_tool":
      if (!args.code) throw new Error("javascript_tool needs {tabId, code}");
      return sendToTab(args.tabId, { type: "JS_EXEC", code: args.code });
    case "computer": {
      const { tabId, action } = args;
      if (!tabId || !action) throw new Error("computer needs {tabId, action, ...}");
      if (action === "screenshot" || action === "zoom") return doScreenshot(tabId, action === "zoom" ? args.region : null);
      if (action === "wait") { await new Promise((r) => setTimeout(r, Math.min((args.duration || 1) * 1000, 10000))); return { ok: true }; }
      return sendToTab(tabId, {
        type: "COMPUTER", computerAction: action, coordinate: args.coordinate,
        text: args.text, scrollDirection: args.scroll_direction, scrollAmount: args.scroll_amount,
        startCoordinate: args.start_coordinate, region: args.region, ref: args.ref, modifiers: args.modifiers,
      });
    }
    case "read_console_messages":
      return sendToTab(args.tabId, { type: "READ_CONSOLE", onlyErrors: args.onlyErrors, pattern: args.pattern, limit: args.limit, clear: args.clear });
    case "read_network_requests": {
      let items = netLog.filter((r) => args.tabId == null || r.tabId === args.tabId);
      if (args.urlPattern) { try { const re = new RegExp(args.urlPattern); items = items.filter((r) => re.test(r.url)); } catch (e) {} }
      items = items.slice(-(args.limit || 100));
      if (args.clear) { for (let i = netLog.length - 1; i >= 0; i--) if (netLog[i].tabId === args.tabId) netLog.splice(i, 1); }
      return { requests: items };
    }
    case "resize_window": {
      const tab = await B.tabs.get(args.tabId);
      await B.windows.update(tab.windowId, { width: args.width, height: args.height });
      return { ok: true };
    }
    default: throw new Error("unknown tool: " + tool);
  }
}

async function pollOnce() {
  let jobs = [];
  try {
    const res = await fetch(BRIDGE + "/pending");
    if (!res.ok) throw new Error("HTTP " + res.status);
    jobs = (await res.json()).jobs || [];
    B.browserAction.setBadgeText({ text: "" });
  } catch (e) {
    B.browserAction.setBadgeText({ text: "!" });
    B.browserAction.setBadgeBackgroundColor({ color: "#c00" });
    B.browserAction.setTitle({ title: "Connect Openly: bridge not running (start bridge/server.py)" });
    return;
  }
  B.browserAction.setTitle({ title: "Connect Openly: connected to bridge" });
  for (const job of jobs) {
    const touchedTab = job.args && job.args.tabId != null ? job.args.tabId : null;
    activeJobs++;
    refreshBadge();
    await setTabActive(touchedTab, true);
    let payload, failed = false;
    try {
      const result = await execute(job.tool, job.args);
      payload = { id: job.id, result };
    } catch (e) {
      failed = true;
      payload = { id: job.id, error: String((e && e.message) || e) };
    }
    await setTabActive(touchedTab, false, !failed);
    activeJobs = Math.max(0, activeJobs - 1);
    refreshBadge();
    try {
      await fetch(BRIDGE + "/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch (e) { console.warn("result post failed:", e); }
  }
}

setInterval(pollOnce, POLL_MS);
pollOnce();

/* Auto-start the bridge in the background on browser launch (needs the
 * one-time native host: bash connect-openly/native-host/install_host.sh).
 * Silent by design — if already running or host missing, do nothing. */
(async function ensureBridge() {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const res = await fetch(BRIDGE + "/health");
    if (res.ok) return;
  } catch (e) {}
  try {
    await B.runtime.sendNativeMessage("connect_openly", { cmd: "start" });
  } catch (e) {}
})();
