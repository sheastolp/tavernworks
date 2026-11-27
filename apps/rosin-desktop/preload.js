// Runs before tavernworks.dev/rosin/ loads in the desktop window.
//
// Two modes (main.js switches between them):
//   just Rosin   Rosin alone on the desktop, no box. Clicks pass straight through to whatever is underneath,
//                except on Rosin itself: click Rosin to open the app, drag Rosin to move it. What Rosin says
//                shows in a speech bubble above it while it talks.
//   the app      the full Rosin page with its controls, for talking and typing to Rosin. Esc, the ▾ button,
//                or clicking away (with nothing typed) goes back to just Rosin.
const { ipcRenderer, webFrame } = require("electron");

// Electron has no speech-to-text service behind the browser's recogniser (it always fails with "network"),
// so take it away before the page looks. The page then records and asks the laptop's Whisper instead.
webFrame.executeJavaScript(`try { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; } catch (e) {}`);

// Tell the page it is in the Windows app, so Rosin fits its replies to it (also ?device=windows-app).
webFrame.executeJavaScript(`window.RosinDevice = "windows-app";`);

let buddy = false;
ipcRenderer.on("rosin-mode", (_e, on) => {
  buddy = !!on;
  document.documentElement.classList.toggle("buddy", buddy);
  if (!buddy) { over = false; document.documentElement.classList.remove("buddy-hover"); }
});

// ---------- just Rosin: only Rosin itself takes the mouse ----------
let over = false, press = null;
function onRosin(x, y) {
  const r = document.getElementById("rosin")?.getBoundingClientRect();
  if (!r || !r.width) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.46, rx = r.width * 0.44, ry = r.height * 0.48;
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}
function setOver(o) {
  if (o === over) return;
  over = o;
  document.documentElement.classList.toggle("buddy-hover", o);
  ipcRenderer.send("rosin-desktop", o ? "over" : "out");
}
window.addEventListener("mousemove", (e) => { if (buddy && !press) setOver(onRosin(e.clientX, e.clientY)); }, true);
window.addEventListener("mouseleave", () => { if (buddy && !press) setOver(false); }, true);
window.addEventListener("pointerdown", (e) => {
  if (!buddy) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.button !== 0 || !onRosin(e.clientX, e.clientY)) return;
  press = { x: e.screenX, y: e.screenY, moved: false, id: e.pointerId };
  try { document.documentElement.setPointerCapture(e.pointerId); } catch {}
  ipcRenderer.send("rosin-desktop", "drag-start");
}, true);
window.addEventListener("pointermove", (e) => {
  if (!buddy || !press) return;
  const dx = e.screenX - press.x, dy = e.screenY - press.y;
  if (!press.moved && Math.abs(dx) + Math.abs(dy) > 5) press.moved = true;
  if (press.moved) ipcRenderer.send("rosin-desktop-drag", dx, dy);
}, true);
window.addEventListener("pointerup", (e) => {
  if (!buddy || !press) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const p = press; press = null;
  ipcRenderer.send("rosin-desktop", p.moved ? "drag-end" : "open");
  setOver(onRosin(e.clientX, e.clientY));
}, true);
for (const t of ["click", "dblclick", "contextmenu", "mousedown", "mouseup"]) {
  window.addEventListener(t, (e) => { if (buddy) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
}
window.addEventListener("keydown", (e) => {
  if (!buddy && e.key === "Escape" && !document.querySelector(".tray:not([hidden])")) ipcRenderer.send("rosin-desktop", "buddy");
}, true);

window.addEventListener("DOMContentLoaded", async () => {
  document.documentElement.classList.add("rosin-desktop");
  document.getElementById("badge")?.remove();
  // No "Click to wake" screen: the app may play sound without a click.
  const wake = document.getElementById("wake");
  if (wake) { wake.remove(); webFrame.executeJavaScript(`window.Rosin && window.Rosin.audio && window.Rosin.audio()`); }
  // Mark the page while Rosin talks, so the speech bubble shows only then.
  webFrame.executeJavaScript(`(() => {
    const R = window.Rosin; if (!R || R.__desk) return; R.__desk = true;
    const t = R.talking;
    R.talking = function (on) { document.documentElement.classList.toggle("rosin-talking", !!on); return t.apply(this, arguments); };
  })()`);

  // A small bar in the top corner of the app: menu, pin on top, back to just Rosin, hide to the tray.
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
  btn("▾", "Just Rosin on the desktop (Esc)", "buddy");
  btn("–", "Hide Rosin (still in the tray, Ctrl+Alt+R)", "hide");
  document.body.append(bar);
  async function sync() {
    const s = await ipcRenderer.invoke("rosin-desktop-state");
    if (!s) return;
    pin.setAttribute("aria-pressed", String(s.onTop));
  }
  sync();
  ipcRenderer.send("rosin-desktop", "ready");
});
