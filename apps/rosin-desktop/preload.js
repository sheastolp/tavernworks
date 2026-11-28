// Runs before tavernworks.dev/rosin/ loads in the Rosin app window (Rosin's brain).
//
// The app window is a normal, solid, resizable window with the full Rosin page and its controls. Closing or
// minimising it, Esc, or the ▾ button goes back to just Rosin on the desktop (buddy.html), and this page keeps
// running hidden: it does the thinking, the chatter and the talking, and tells the buddy what Rosin is doing.
const { ipcRenderer, webFrame } = require("electron");

// Electron has no speech-to-text service behind the browser's recogniser (it always fails with "network"),
// so take it away before the page looks. The page then records and asks the laptop's Whisper instead.
// The page also counts as showing while the window is hidden, so Rosin keeps chatting from the desktop.
webFrame.executeJavaScript(`try {
  window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" });
  window.RosinDevice = "windows-app";   // so Rosin fits its replies to the Windows app (also ?device=windows-app)
} catch (e) {}`);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector(".tray:not([hidden])")) ipcRenderer.send("rosin-desktop", "buddy");
}, true);

// ⋯ → Stream window (rosin-mirror.js): open the app's own stream window for OBS.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.__rosinDesk !== "stream") return;
  ipcRenderer.send("rosin-desktop", "stream");
});

// What Rosin is doing, posted by the page (below) and passed on to just-Rosin on the desktop.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.__rosinState !== true) return;
  ipcRenderer.send("rosin-state", e.data.state);
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("rosin-desktop", "in-app", "desk-stream");   // desk-stream: this app has the stream window
  // No "Click to wake" screen: the app may play sound without a click.
  const wake = document.getElementById("wake");
  if (wake) { wake.remove(); webFrame.executeJavaScript(`window.Rosin && window.Rosin.audio && window.Rosin.audio()`); }

  webFrame.executeJavaScript(`(() => {
    const R = window.Rosin; if (!R || R.__desk) return; R.__desk = true;
    const plain = (t) => String(t || "").replace(/\\[[^\\]]*\\]/g, " ").replace(/[*_\`#]+/g, "").replace(/\\s+/g, " ").trim();
    let talking = false, last = "";
    function post() {
      const subs = document.getElementById("subs");
      const state = {
        face: R.expression || "normal",
        subs: plain(subs && subs.textContent),
        heard: !!(subs && subs.classList.contains("listening")),
        talking: talking || !!(window.speechSynthesis && window.speechSynthesis.speaking),
        thinking: !!document.getElementById("rosin")?.classList.contains("thinking"),
        busy: document.getElementById("send")?.dataset.stop === "true",
        listening: !!document.getElementById("mic")?.classList.contains("live"),
      };
      const s = JSON.stringify(state);
      if (s !== last) { last = s; window.postMessage({ __rosinState: true, state }, location.origin); }
    }
    let queued = false;
    const soon = () => { if (!queued) { queued = true; Promise.resolve().then(() => { queued = false; post(); }); } };
    for (const k of ["talking", "subs", "thinking", "setExpression", "status", "micLive"]) {
      const f = R[k];
      if (typeof f !== "function") continue;
      R[k] = function (...a) { if (k === "talking") talking = !!a[0]; const r = f.apply(this, a); soon(); return r; };
    }
    const mo = new MutationObserver(soon);
    for (const id of ["subs", "rosin", "send", "mic"]) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { attributes: true, childList: true, characterData: true, subtree: id === "subs" });
    }
    if (window.KeepAwake && window.KeepAwake.ticker) window.KeepAwake.ticker(1000, post); else setInterval(post, 1000);
    post();
  })()`);

  // A small bar in the top corner of the app: menu, pin on top, back to just Rosin.
  const bar = document.createElement("div");
  bar.id = "desk-bar";
  const btn = (label, title, what) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", () => { ipcRenderer.send("rosin-desktop", what); setTimeout(sync, 150); });
    bar.append(b); return b;
  };
  btn("☰", "Rosin menu", "menu");
  const pin = btn("📌", "Keep the app on top", "pin");
  btn("▾", "Just Rosin on the desktop (Esc)", "buddy");
  document.body.append(bar);
  async function sync() {
    const s = await ipcRenderer.invoke("rosin-desktop-state");
    if (s) pin.setAttribute("aria-pressed", String(s.onTop));
  }
  sync();
  ipcRenderer.send("rosin-desktop", "ready");
});
