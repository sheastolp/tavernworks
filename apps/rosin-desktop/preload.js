// Runs before tavernworks.dev/rosin/ loads in the desktop window.
const { ipcRenderer, webFrame } = require("electron");

// Electron has no speech-to-text service behind the browser's recogniser (it always fails with "network"),
// so take it away before the page looks. The page then records and asks the laptop's Whisper instead.
webFrame.executeJavaScript(`try { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; } catch (e) {}`);

// Tell the page it is in the Windows app, so Rosin fits its replies to it (also ?device=windows-app).
webFrame.executeJavaScript(`window.RosinDevice = "windows-app";`);

window.addEventListener("DOMContentLoaded", async () => {
  document.documentElement.classList.add("rosin-desktop");
  document.getElementById("badge")?.remove();
  // No "Click to wake" screen: the app may play sound without a click.
  const wake = document.getElementById("wake");
  if (wake) { wake.remove(); webFrame.executeJavaScript(`window.Rosin && window.Rosin.audio && window.Rosin.audio()`); }

  // A small bar in the top corner: menu, pin on top, show or hide the controls, hide to the tray.
  const bar = document.createElement("div");
  bar.id = "desk-bar";
  const btn = (label, title, what) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", () => { ipcRenderer.send("rosin-desktop", what); setTimeout(sync, 150); });
    bar.append(b); return b;
  };
  btn("☰", "Rosin menu", "menu");
  const pin = btn("📌", "Always on top", "pin");
  const ctl = btn("▾", "Show or hide the controls", "compact");
  btn("–", "Hide Rosin (still in the tray, Ctrl+Alt+R)", "hide");
  document.body.append(bar);
  async function sync() {
    const s = await ipcRenderer.invoke("rosin-desktop-state");
    if (!s) return;
    pin.setAttribute("aria-pressed", String(s.onTop));
    ctl.textContent = s.compact ? "▴" : "▾";
  }
  sync();
});
