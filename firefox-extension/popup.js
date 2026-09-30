/* Connect Openly popup: bridge health + quick manual checks. */
const B = (typeof browser !== "undefined") ? browser : chrome;
const BRIDGE = "http://127.0.0.1:4973";
const out = document.getElementById("out");
const dot = document.getElementById("dot");
const status = document.getElementById("status");
const srv = document.getElementById("srv");

async function nativeCall(cmd) {
  try {
    return await B.runtime.sendNativeMessage("connect_openly", { cmd });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // "No such native application" = one-time install missing. Anything else
    // is a real error — surface it verbatim instead of hiding it.
    return { ok: false, error: msg, needsInstall: msg.includes("No such native application") };
  }
}

async function refreshServer() {
  const st = await nativeCall("status");
  if (st.needsInstall) {
    srv.textContent = "server: native host not installed — run once: bash connect-openly/native-host/install_host.sh";
    return;
  }
  let extra = "";
  try {
    const h = await (await fetch(BRIDGE + "/health")).json();
    extra = h.browser_connected ? ", extension polling ✓" : ", extension not polling yet";
  } catch (e) { extra = ", bridge HTTP unreachable"; }
  srv.textContent = "server: " + (st.running ? ("RUNNING" + (st.pid ? " (pid " + st.pid + ")" : "") + extra) : "stopped");
}

document.getElementById("bStart").onclick = async () => {
  srv.textContent = "server: starting…";
  const r = await nativeCall("start");
  if (r.error && !r.running) { srv.textContent = "server: START FAILED — " + r.error + (r.needsInstall ? " (fix: bash connect-openly/native-host/install_host.sh, then Reload the extension)" : ""); return; }
  await new Promise((res) => setTimeout(res, 500));
  await refreshServer(); await health();
};

document.getElementById("bStop").onclick = async () => {
  srv.textContent = "server: stopping…";
  const r = await nativeCall("stop");
  if (r.needsInstall) { srv.textContent = "server: native host not installed — nothing to stop."; return; }
  srv.textContent = "server: " + (r.running ? ("still running — " + (r.note || "")) : "stopped.") + (r.note && !r.running ? " " + r.note : "");
  await health();
};

async function health() {
  try {
    const r = await fetch(BRIDGE + "/health");
    const j = await r.json();
    dot.className = j.browser_connected ? "" : "";
    dot.classList.toggle("on", true);
    status.textContent = j.browser_connected
      ? "bridge connected (background polling OK)"
      : "bridge reachable, extension not yet seen — background will poll within 1s";
  } catch (e) {
    dot.classList.remove("on");
    status.textContent = "bridge NOT running — start: python3 ../bridge/server.py";
  }
}

document.getElementById("bTabs").onclick = async () => {
  const tabs = await B.tabs.query({});
  out.textContent = JSON.stringify(tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title })), null, 1);
};

document.getElementById("bShot").onclick = async () => {
  const [tab] = await B.tabs.query({ active: true, currentWindow: true });
  const url = await B.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  out.textContent = "captured " + url.length + " chars dataUrl (tab " + tab.id + ")";
};

health();
setInterval(health, 2000);
refreshServer();
setInterval(refreshServer, 3000);
