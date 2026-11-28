/* rosin-mirror.js: the stream view, Rosin with nothing else on screen (load after the other rosin-*.js files).
 *
 * For OBS Window Capture: a second window (the Windows app's "Rosin – Stream", or ?view=stream in another browser
 * window) shows only Rosin, no buttons, menus or cards, on a plain background. It doesn't think or listen itself: the
 * normal Rosin window does all that and this one copies Rosin's face, talking, subtitles, mood and music colour from it
 * as they happen (BroadcastChannel, same browser and same site, nothing leaves the device).
 *
 * URL (stream view only): ?bg=grove (the usual dark grove, default) or ?bg=green (pure green for OBS's Chroma Key),
 * ?subs=0 hides the subtitles.
 */
(() => {
  const R = window.Rosin;
  if (!R || typeof BroadcastChannel !== "function") return;
  const ch = new BroadcastChannel("rosin-mirror");
  const root = document.documentElement, body = document.body;

  if (!window.ROSIN_MIRROR) {
    // ---------- the normal window: tell any stream view what Rosin is doing ----------
    const last = {};
    const send = (m, a) => { try { ch.postMessage({ m, a }); } catch {} };
    for (const m of ["setExpression", "blink", "talking", "setMood", "thinking", "subs"]) {
      const f = R[m];
      if (typeof f !== "function") continue;
      R[m] = function (...a) { const r = f.apply(this, a); a = a.map((x) => (typeof x === "number" || typeof x === "string" || typeof x === "boolean" || x == null ? x : String(x))); if (m !== "blink") last[m] = a; send(m, a); return r; };
    }
    // Lip movement: rosin.js turns pulse() into the mouth's glow. Pulses come fast while Rosin talks, so at most 30 a second.
    const pulse = R.pulse; let pulseAt = 0, pulseMax = 0;
    if (typeof pulse === "function") R.pulse = function (v = 1) {
      const r = pulse.call(this, v); pulseMax = Math.max(pulseMax, v);
      const now = performance.now(); if (now - pulseAt > 33) { pulseAt = now; send("pulse", [pulseMax]); pulseMax = 0; }
      return r;
    };
    const song = () => ({ song: root.style.getPropertyValue("--song"), on: root.style.getPropertyValue("--song-on"),
      playing: root.classList.contains("song-playing"), liked: root.classList.contains("song-liked") });
    let lastSong = "";
    new MutationObserver(() => { const s = song(), k = JSON.stringify(s); if (k !== lastSong) { lastSong = k; send("song", [s]); } })
      .observe(root, { attributes: true, attributeFilter: ["style", "class"] });
    ch.onmessage = (e) => {
      if (e.data?.m !== "hello") return;
      send("snap", [{ face: R.expression, mood: R.mood, thinking: document.getElementById("rosin")?.classList.contains("thinking"),
        subs: document.getElementById("subs")?.textContent || "", talking: last.talking?.[0] || false, song: song() }]);
    };
    // ⋯ → Stream window: the Windows app opens its own (tray → Stream window for OBS does the same); a PC browser opens
    // a second browser window. Not on phones, where OBS can't capture a window anyway.
    const inDesk = /RosinApp\/Windows/.test(navigator.userAgent);
    const open = () => {
      if (inDesk) window.postMessage({ __rosinDesk: "stream" }, location.origin);
      else window.open(location.pathname + "?view=stream", "rosin-stream", "popup,width=540,height=720");
    };
    const quick = document.querySelector("#more .quick");
    const phone = matchMedia("(pointer: coarse) and (max-width: 900px)").matches || /Android|iPhone|iPad/.test(navigator.userAgent);
    if (quick && !R.OBS && !phone) {
      const b = document.createElement("button"); b.type = "button"; b.id = "btn-stream"; b.textContent = "Stream window";
      b.title = "Rosin alone, with no menus, for OBS Window Capture"; b.setAttribute("aria-label", b.title);
      // An older Windows app can't open one yet (it has no desk-stream).
      if (inDesk) { b.hidden = true; addEventListener("DOMContentLoaded", () => { b.hidden = !root.classList.contains("desk-stream"); }); setTimeout(() => { b.hidden = !root.classList.contains("desk-stream"); }, 1500); }
      b.addEventListener("click", () => { document.getElementById("more").hidden = true; document.getElementById("btn-more")?.setAttribute("aria-expanded", "false"); open(); });
      quick.append(b);
    }
    window.RosinMirror = { open };
    return;
  }

  // ---------- the stream view ----------
  const q = new URLSearchParams(location.search);
  body.classList.add("mirror");
  root.classList.add("mirror");
  if (q.get("bg") === "green") body.classList.add("mirror-green");
  if (q.get("subs") === "0") body.classList.remove("subs"); else body.classList.add("subs");
  document.title = "Rosin – Stream";
  document.getElementById("wake")?.remove();
  document.getElementById("badge")?.remove();
  addGems();
  const lit = (s) => {
    if (!s) return;
    if (s.song) root.style.setProperty("--song", s.song); else root.style.removeProperty("--song");
    root.style.setProperty("--song-on", s.on || "0");
    root.classList.toggle("song-playing", !!s.playing); root.classList.toggle("song-liked", !!s.liked);
  };
  let heard = 0;
  ch.onmessage = (e) => {
    const { m, a } = e.data || {};
    heard = Date.now(); body.classList.remove("mirror-alone");
    if (m === "snap") {
      const s = a[0] || {};
      if (s.face) R.setExpression(s.face, 0);
      if (typeof s.mood === "number") R.setMood?.(s.mood, true);
      R.thinking(!!s.thinking); R.subs(s.subs); R.talking(!!s.talking); lit(s.song);
    } else if (m === "song") lit(a[0]);
    else if (m === "pulse") R.pulse(a[0]);
    else if (["setExpression", "blink", "talking", "setMood", "thinking", "subs"].includes(m) && typeof R[m] === "function") R[m](...(a || []));
  };
  const hello = () => { try { ch.postMessage({ m: "hello" }); } catch {} };
  hello();
  // The main window may open after this one, or reload: say hello again until it answers.
  setInterval(() => { if (Date.now() - heard > 8000) { hello(); if (Date.now() - heard > 20000) body.classList.add("mirror-alone"); } }, 4000);

  function addGems() {   // the crystals that glow with the music (rosin-spotify.js adds them in the normal window)
    for (const side of ["l", "r"]) {
      const part = document.querySelector(`#rig .part[data-part="antenna-${side}"]`);
      if (!part || part.querySelector(".gem")) continue;
      for (const cls of ["gem", "gem-glow"]) {
        const g = document.createElement("div"); g.className = `${cls} ${cls}-${side}`; g.setAttribute("aria-hidden", "true");
        g.style.transformOrigin = part.querySelector("img")?.style.transformOrigin || "";
        part.append(g);
      }
    }
  }
})();
