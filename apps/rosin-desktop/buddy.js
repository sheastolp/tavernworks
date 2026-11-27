// Just Rosin on the desktop (buddy.html). Only Rosin itself takes the mouse: everywhere else, clicks reach the
// desktop. Click Rosin to open the app, drag Rosin to move it. The bubble shows what Rosin says while it talks.
"use strict";
const api = window.rosinBuddy;
const img = document.getElementById("rosin");
const bubble = document.getElementById("bubble");
const FACES = ["normal", "happy", "laugh", "surprise", "anger", "confused", "stoned"];

// ---------- what Rosin is doing, from the app window ----------
let lastWords = "", hideTimer = null, face = "normal";
function tailOf(t, max) {
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max), sp = cut.indexOf(" ");
  return "…" + (sp > 0 && sp < 25 ? cut.slice(sp + 1) : cut);
}
api.onState((s) => {
  s = s || {};
  const f = s.thinking ? "stoned" : (FACES.includes(s.face) ? s.face : "normal");
  if (f !== face) { face = f; img.src = `assets/faces/${f}.webp`; }
  const words = String(s.subs || "").replace(/\s+/g, " ").trim();
  const talking = (s.talking || s.busy) && !s.thinking && !s.listening && !s.heard && words;
  if (talking) {
    clearTimeout(hideTimer); hideTimer = null;
    if (words !== lastWords) { lastWords = words; bubble.textContent = tailOf(words, 220); }
    bubble.classList.add("on");
  } else if (bubble.classList.contains("on") && !hideTimer) {
    // Linger a moment after the last word, then go.
    hideTimer = setTimeout(() => { hideTimer = null; lastWords = ""; bubble.classList.remove("on"); }, 1500);
  }
});

// ---------- the mouse: only on Rosin ----------
let over = false, press = null;
function onRosin(x, y) {
  const r = img.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.5, rx = r.width * 0.44, ry = r.height * 0.46;
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}
function setOver(o) {
  if (o === over) return;
  over = o;
  document.documentElement.classList.toggle("hover", o);
  document.body.style.cursor = o ? "pointer" : "";
  api.send(o ? "over" : "out");
}
window.addEventListener("mousemove", (e) => { if (!press) setOver(onRosin(e.clientX, e.clientY)); });
document.addEventListener("mouseleave", () => { if (!press) setOver(false); });
window.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (e.button !== 0 || !onRosin(e.clientX, e.clientY)) return;
  press = { x: e.screenX, y: e.screenY, moved: false };
  try { document.documentElement.setPointerCapture(e.pointerId); } catch {}
  api.send("drag-start");
});
window.addEventListener("pointermove", (e) => {
  if (!press) return;
  const dx = e.screenX - press.x, dy = e.screenY - press.y;
  if (!press.moved && Math.abs(dx) + Math.abs(dy) > 5) press.moved = true;
  if (press.moved) api.drag(dx, dy);
});
window.addEventListener("pointerup", (e) => {
  if (!press) return;
  const p = press; press = null;
  api.send(p.moved ? "drag-end" : "open");
  setOver(onRosin(e.clientX, e.clientY));
});
window.addEventListener("contextmenu", (e) => { e.preventDefault(); if (onRosin(e.clientX, e.clientY)) api.send("menu"); });
