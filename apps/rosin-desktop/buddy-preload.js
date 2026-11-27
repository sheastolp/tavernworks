// Preload for buddy.html (just Rosin on the desktop): a small, fixed set of messages to the app, nothing else.
const { contextBridge, ipcRenderer } = require("electron");

const ASKS = new Set(["over", "out", "drag-start", "drag-end", "open", "menu"]);
contextBridge.exposeInMainWorld("rosinBuddy", {
  send: (what) => { if (ASKS.has(what)) ipcRenderer.send("rosin-buddy", what); },
  drag: (dx, dy) => ipcRenderer.send("rosin-buddy-drag", Number(dx) || 0, Number(dy) || 0),
  onState: (fn) => {
    ipcRenderer.on("rosin-state", (_e, s) => { try { fn(s); } catch {} });
    ipcRenderer.send("rosin-buddy", "ready");
  },
});
