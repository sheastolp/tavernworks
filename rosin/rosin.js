/* Rosin avatar page for Open-LLM-VTuber. Works on a PC, the Legion Go 2's touchscreen, a phone, and in OBS.
 *
 * Builds Rosin from the layers in img/ (positions in layers.js), animates the antennae, crystals, charms and eyelids,
 * connects to the server's proxy websocket (/proxy-ws), plays Rosin's voice, pulses the eye glow with the voice
 * volume, and switches expressions from the [tags] the AI puts in its replies.
 *
 * URL options (combine with &):
 *   ?obs=1        hide the controls, transparent background (for an OBS browser source)
 *   ?subs=1       show subtitles of what Rosin says
 *   ?demo=1       no server needed: fake talking and cycle expressions, to preview the look
 *   ?mute=1       don't play Rosin's voice here (a phone used as a remote while the PC or OBS plays it)
 *   ?lite=1 / ?lite=0   force the lighter effects on or off (they switch on by themselves on phones)
 *   ?ws=ws://host:12393/proxy-ws   server address if this page is not served by Open-LLM-VTuber
 *
 * Page settings (set before rosin.js loads, used by the public demo at tavernworks.dev/rosin/):
 *   window.ROSIN_DEMO = true      always demo, no server, no mic, no wake screen
 *   window.ROSIN_IMG_EXT = "webp" load img/*.webp instead of img/*.png
 *   window.ROSIN_WEB = true       a "brain" script (rosin-web.js on tavernworks.dev) talks for Rosin instead of
 *                                 Open-LLM-VTuber; it drives Rosin through window.Rosin (see the bottom of this file)
 */
(() => {
  const q = new URLSearchParams(location.search);
  const OBS = q.get("obs") === "1";
  const WEB_DEMO = window.ROSIN_DEMO === true;
  const DEMO = WEB_DEMO || q.get("demo") === "1";
  const IMG_EXT = window.ROSIN_IMG_EXT || "png";
  const WEB = window.ROSIN_WEB === true && !DEMO;
  const brain = () => window.RosinBrain || {};
  const MUTE = q.get("mute") === "1";
  const SMALL_TOUCH = matchMedia("(pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 500px)").matches;
  const LITE = q.get("lite") === "1" || (q.get("lite") !== "0" && !OBS && SMALL_TOUCH);
  const body = document.body;
  body.classList.add(OBS ? "obs" : "preview");
  if (LITE) body.classList.add("lite");
  if (matchMedia("(any-pointer: coarse)").matches) body.classList.add("touch");
  if (q.get("subs") === "1" || (!OBS && (SMALL_TOUCH || WEB_DEMO || window.ROSIN_WEB === true) && q.get("subs") !== "0")) body.classList.add("subs");

  // Same order as the "rosin" emotionMap in model_dict.json (neutral 0 ... confused 6).
  const EXPRESSIONS = ["normal", "stoned", "happy", "laugh", "surprise", "anger", "confused"];
  const LABELS = ["Normal", "Stoned", "Happy", "Laugh", "Surprised", "Angry", "Confused"];
  const NAME_ALIASES = { neutral: "normal", joy: "happy", sleepy: "stoned", laughing: "laugh",
                         surprised: "surprise", angry: "anger", fear: "surprise", sadness: "stoned" };

  const rosin = document.getElementById("rosin");
  const stage = document.getElementById("stage");
  const controls = document.getElementById("controls");
  const statusEl = document.getElementById("status");
  const subsEl = document.getElementById("subs");
  const root = document.documentElement;

  // ---------- build Rosin from the layers (positions come from layers.js) ----------
  const L = window.ROSIN_LAYERS;
  const pct = (v, of) => (100 * v / of).toFixed(3) + "%";
  function place(el, x, y, w, h) {
    el.style.left = pct(x, L.W); el.style.top = pct(y, L.H); el.style.width = pct(w, L.W); el.style.height = pct(h, L.H);
  }
  rosin.style.aspectRatio = `${L.W} / ${L.H}`;
  const rig = document.getElementById("rig");
  for (const [name, b] of Object.entries(L.parts)) {
    const part = document.createElement("div");
    part.className = "part"; part.dataset.part = name; place(part, b.x, b.y, b.w, b.h);
    if (b.pivot) {
      const o = `${pct(b.pivot[0] - b.x, b.w)} ${pct(b.pivot[1] - b.y, b.h)}`;
      part.style.transformOrigin = o; part.dataset.origin = o;
    }
    const img = document.createElement("img"); img.src = `img/${name}.${IMG_EXT}`; img.alt = "";
    if (b.pivot) img.style.transformOrigin = part.dataset.origin;
    part.appendChild(img); rig.appendChild(part);
  }
  const E = L.eye;
  rig.style.transformOrigin = `${pct(E.cx, L.W)} ${pct(E.cy, L.H)}`;
  // Rosin is shown mirrored (#turn in rosin.css) so it faces left: its eye sits left of the middle, at W - cx.
  rosin.style.transformOrigin = `${pct(L.W - E.cx, L.W)} ${pct(E.cy, L.H)}`;
  place(document.getElementById("eye"), E.x, E.y, E.w, E.h);
  place(document.getElementById("lids"), E.cx - E.rx, E.cy - E.ry, 2 * E.rx, 2 * E.ry);
  const ge = document.getElementById("glow-eye");
  ge.style.left = pct(E.cx, L.W); ge.style.top = pct(E.cy, L.H); ge.style.width = pct(E.rx * 3, L.W); ge.style.height = pct(E.ry * 3, L.H);
  const gb = document.getElementById("glow-back");
  gb.style.left = pct(770, L.W); gb.style.top = pct(900, L.H);
  const eyeImgs = [...document.querySelectorAll("#eye img")];

  // ---------- expressions ----------
  // "normal" is the Main View's own eye; the others are overlays cut from the sheet's expression cards.
  let current = "normal";
  let revertTimer = null;
  function setExpression(name, holdMs = 6000) {
    if (typeof name === "number") name = EXPRESSIONS[name] ?? "normal";
    name = NAME_ALIASES[name] || name;
    if (!EXPRESSIONS.includes(name)) return;
    current = name; facesUpdate();
    eyeImgs.forEach(i => i.classList.toggle("on", i.dataset.exp === name));
    clearTimeout(revertTimer);
    if (name !== "normal" && holdMs > 0) revertTimer = setTimeout(() => setExpression("normal", 0), holdMs);
  }
  setExpression("normal", 0);

  // ---------- blinking: the lids close and open over the open-eyed faces ----------
  const OPEN_EYES = ["normal", "surprise", "anger", "confused"];
  let blinking = false;
  function blink(double = false) {
    if (blinking || !OPEN_EYES.includes(current)) return;
    blinking = true;
    const t0 = performance.now(), close = 70, hold = 40, open = 110, total = close + hold + open;
    (function step() {
      const t = performance.now() - t0;
      const v = t < close ? t / close : t < close + hold ? 1 : Math.max(0, 1 - (t - close - hold) / open);
      root.style.setProperty("--blink", v.toFixed(3));
      if (t < total) requestAnimationFrame(step);
      else { blinking = false; if (double) setTimeout(() => blink(false), 120); }
    })();
  }
  (function idleBlink() {
    setTimeout(() => { blink(Math.random() < 0.2); idleBlink(); }, 3000 + Math.random() * 6000);
  })();

  // ---------- fit Rosin to the screen, leaving room for the controls ----------
  function smokeShown() { return !!L.smoke && q.get("smoke") !== "0"; }
  function fit() {
    const ctrlH = body.classList.contains("preview") && !body.classList.contains("hide-ui") ? controls.offsetHeight + 8 : 0;
    root.style.setProperty("--ctrl-h", ctrlH + "px");
    // No space is kept for subtitles: they sit over the bottom of the smoke, just above the controls, and only
    // while there's a line to show. Rosin gets the room.
    root.style.setProperty("--subs-h", "0px");
    const w = stage.clientWidth, h = stage.clientHeight - ctrlH;
    // The smoke hangs below Rosin's box: fit Rosin and the smoke together, and centre the pair, not just Rosin.
    const FH = smokeShown() ? Math.max(L.H, L.smoke.showY + L.smoke.showH) : L.H;
    const height = Math.max(120, Math.min(h * 0.94 * L.H / FH, w * 0.96 * L.H / L.W));
    rosin.style.height = height + "px"; rosin.style.width = (height * L.W / L.H) + "px";
    rosin.style.marginBottom = (height * (FH - L.H) / L.H) + "px";
    // On a tall phone screen Rosin is as wide as it can be and there's height to spare: put most of it above the
    // antennae, so Rosin sits down near the controls instead of floating with a gap under the smoke.
    const spare = Math.max(0, h - height * FH / L.H);
    rosin.style.marginTop = (ctrlH ? spare * 0.7 : 0) + "px";   // OBS and hidden controls stay centred
  }
  addEventListener("resize", fit);
  addEventListener("orientationchange", () => setTimeout(fit, 250));
  if (window.ResizeObserver) new ResizeObserver(fit).observe(controls);
  fit();

  // ---------- audio playback + glow ----------
  let ctx = null, analyser = null, buf = null;
  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      if (!MUTE) analyser.connect(ctx.destination);
      buf = new Float32Array(analyser.fftSize);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  const queue = [];        // {audioBuffer, text, expressions}
  let speaking = false, synthDone = false, currentSrc = null, fakeVol = 0, thinkingFace = false, speakTimer = null;

  async function enqueue(msg) {
    const actx = audio();
    let audioBuffer = null;
    if (msg.audio) {
      const bytes = Uint8Array.from(atob(msg.audio), c => c.charCodeAt(0));
      try { audioBuffer = await actx.decodeAudioData(bytes.buffer); } catch (e) { console.warn("decode failed", e); }
    }
    queue.push({ audioBuffer, text: msg.display_text?.text || "", expressions: msg.actions?.expressions || [] });
    if (!speaking) playNext();
  }

  function playNext() {
    const item = queue.shift();
    if (!item) {
      speaking = false; fakeVol = 0;
      // A muted remote never reports playback, so it can't cut the speaking page short.
      if (synthDone) { synthDone = false; if (!MUTE) send({ type: "frontend-playback-complete" }); }
      return;
    }
    speaking = true;
    rosin.classList.remove("thinking");
    if (item.expressions.length) setExpression(item.expressions[0]);
    else if (thinkingFace) setExpression("normal", 0);
    thinkingFace = false;
    subsEl.textContent = item.text;
    if (!item.audioBuffer || MUTE) {
      // no sound here: pulse the glow for as long as the line lasts
      const ms = item.audioBuffer ? item.audioBuffer.duration * 1000 : Math.min(4000, 60 * item.text.length);
      wobble(ms); speakTimer = setTimeout(playNext, ms); return;
    }
    const src = ctx.createBufferSource();
    src.buffer = item.audioBuffer; src.connect(analyser);
    src.onended = () => { currentSrc = null; playNext(); };
    currentSrc = src; src.start();
  }

  function stopSpeaking() {
    queue.length = 0; synthDone = false; clearTimeout(speakTimer); fakeVol = 0;
    if (currentSrc) { currentSrc.onended = null; try { currentSrc.stop(); } catch {} currentSrc = null; }
    speaking = false;
  }

  function wobble(ms) {
    const t0 = performance.now();
    (function step() {
      const t = performance.now() - t0;
      fakeVol = t < ms ? 0.35 + 0.65 * Math.abs(Math.sin(t / 90)) * Math.random() : 0;
      if (t < ms) requestAnimationFrame(step);
    })();
  }

  // Mood, 0 calm to 1 fired up (0.5 is the old default): calm glows dim and breathes slowly, fired up glows bright and
  // flickers fast. Set by rosin-web.js (⋯ > Mood) or ?mood=0..100 (OBS has no menu).
  // setMood(m) glides there over a second or two (the automatic mood); setMood(m, true) jumps (the slider).
  let mood = 0.5, moodTo = 0.5, moodShown = "";
  function setMood(m, now) {
    m = Math.min(1, Math.max(0, Number(m))); if (!Number.isFinite(m)) return;
    moodTo = m; if (now) mood = m;
    const css = mood.toFixed(2); if (css !== moodShown) { moodShown = css; root.style.setProperty("--mood", css); }
  }
  if (q.get("mood") !== null && q.get("mood") !== "") setMood(Number(q.get("mood")) / 100, true);
  let smooth = 0, shown = -1, webTalk = false, webPulse = 0;
  (function tick() {
    let v = 0;
    if (analyser && speaking && currentSrc) {
      analyser.getFloatTimeDomainData(buf);
      let s = 0; for (const x of buf) s += x * x;
      v = Math.min(1, Math.sqrt(s / buf.length) * 5);
    }
    const t = performance.now();
    if (mood !== moodTo) {
      mood += (moodTo - mood) * 0.025; if (Math.abs(moodTo - mood) < 0.004) mood = moodTo;
      const css = mood.toFixed(2); if (css !== moodShown) { moodShown = css; root.style.setProperty("--mood", css); }
    }
    if (webTalk) v = Math.max(v, webPulse, 0.18 + 0.24 * mood + (0.4 + 0.3 * mood) * Math.abs(Math.sin(t / (135 - 80 * mood))) * (0.6 + 0.4 * Math.random()));
    else v = Math.max(v, (0.02 + 0.12 * mood) * (0.5 + 0.5 * Math.sin(t / (2600 - 1800 * mood))));   // a slow breath while quiet
    webPulse *= 0.9;
    v = Math.max(v, fakeVol);
    smooth += (v - smooth) * (v > smooth ? 0.5 : 0.12);  // fast attack, slow release
    if (smooth < 0.002) smooth = 0;
    const r = Math.round(smooth * 200) / 200;         // only restyle when it visibly changes (saves phone battery)
    if (r !== shown) { shown = r; root.style.setProperty("--glow", r.toFixed(3)); }
    requestAnimationFrame(tick);
  })();

  // ---------- server connection ----------
  let ws = null;
  const wsUrl = q.get("ws") || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host || "127.0.0.1:12393"}/proxy-ws`;
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function connect() {
    if (WEB) return;   // rosin-web.js talks to the AI
    if (DEMO) { statusEl.textContent = WEB_DEMO ? "Demo: the real Rosin talks on stream" : "demo mode (no server)"; return; }
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { statusEl.textContent = MUTE ? "connected (voice muted here)" : "connected"; };
    ws.onclose = () => { statusEl.textContent = "server not reachable, retrying…"; setTimeout(connect, 3000); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case "audio": enqueue(m); break;
        case "backend-synth-complete":
          synthDone = true;
          if (!speaking && queue.length === 0) { synthDone = false; if (!MUTE) send({ type: "frontend-playback-complete" }); }
          break;
        case "full-text":
          if (/thinking/i.test(m.text || "")) { rosin.classList.add("thinking"); setExpression("stoned", 0); thinkingFace = true; }
          break;
        case "interrupt-signal": stopSpeaking(); break;
      }
    };
  }
  connect();

  // ---------- typing ----------
  document.getElementById("say").addEventListener("submit", e => {
    e.preventDefault();
    const box = document.getElementById("say-text");
    const text = box.value.trim(); if (!text) return;
    audio();
    if (DEMO) { demoReply(); } else if (WEB) { brain().say?.(text); } else { send({ type: "text-input", text }); }
    box.value = "";
    if (SMALL_TOUCH) box.blur();     // drop the phone keyboard so Rosin is visible again
  });

  // ---------- push-to-talk (mouse, touch, pen, or Space) ----------
  // The speech recogniser wants 16 kHz mono floats. Phones often refuse a 16 kHz mic context,
  // so record at the device rate and downsample here.
  let mic = null;   // {ctx, stream, node, src}
  let micWanted = false;
  async function micStart() {
    if (WEB) { brain().micStart?.(); return; }
    if (mic || micWanted) return;
    micWanted = true;
    if (DEMO) { micBtn.classList.add("live"); statusEl.textContent = "demo mode: the mic only works with the server"; return; }
    audio();
    if (speaking) { stopSpeaking(); send({ type: "interrupt-signal", text: "" }); }
    if (!navigator.mediaDevices?.getUserMedia) {
      statusEl.textContent = "mic needs https on a phone (see the Tailscale steps), or type instead"; micWanted = false; return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (!micWanted) { stream.getTracks().forEach(t => t.stop()); return; }   // let go before the prompt finished
      const mctx = new (window.AudioContext || window.webkitAudioContext)();
      if (mctx.state === "suspended") await mctx.resume();
      const src = mctx.createMediaStreamSource(stream);
      const node = mctx.createScriptProcessor(4096, 1, 1);
      const ratio = mctx.sampleRate / 16000;
      let carry = 0;
      node.onaudioprocess = e => {
        const input = e.inputBuffer.getChannelData(0), out = [];
        let pos = carry;
        while (pos + ratio <= input.length) {                // average each window: cheap and alias-free enough for speech
          let sum = 0, n = 0;
          for (let i = Math.floor(pos); i < Math.floor(pos + ratio); i++) { sum += input[i]; n++; }
          out.push(n ? sum / n : 0); pos += ratio;
        }
        carry = pos - input.length;
        if (out.length) send({ type: "mic-audio-data", audio: out });
      };
      src.connect(node); node.connect(mctx.destination);
      mic = { ctx: mctx, stream, node, src };
      micBtn.classList.add("live"); micBtn.setAttribute("aria-pressed", "true");
      statusEl.textContent = "listening…";
    } catch (e) {
      micWanted = false;
      statusEl.textContent = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1"
        ? "mic blocked: allow the microphone for this page" : "mic needs https on a phone (see the Tailscale steps), or type instead";
    }
  }
  function micStop() {
    if (WEB) { brain().micStop?.(); return; }
    micWanted = false;
    micBtn.classList.remove("live"); micBtn.setAttribute("aria-pressed", "false");
    if (!mic) { if (DEMO) statusEl.textContent = "demo mode (no server)"; return; }
    mic.node.disconnect(); mic.src.disconnect(); mic.stream.getTracks().forEach(t => t.stop()); mic.ctx.close();
    mic = null;
    statusEl.textContent = MUTE ? "connected (voice muted here)" : "connected";
    send({ type: "mic-audio-end" });
  }
  const micBtn = document.getElementById("mic");
  micBtn.addEventListener("pointerdown", e => {
    e.preventDefault(); try { micBtn.setPointerCapture(e.pointerId); } catch {}
    micStart();
  });
  micBtn.addEventListener("pointerup", micStop);
  // On the website, a tap toggles listening, so a phone taking the touch away (pointercancel) mustn't end it.
  micBtn.addEventListener("pointercancel", () => { if (!WEB) micStop(); });
  micBtn.addEventListener("lostpointercapture", () => { if (!WEB) micStop(); });
  micBtn.addEventListener("contextmenu", e => e.preventDefault());   // long-press on phones
  micBtn.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); micStart(); } });
  micBtn.addEventListener("keyup", e => { if (e.key === "Enter" || e.key === " ") micStop(); });

  // ---------- buttons: faces, blink, menu ----------
  const facesEl = document.getElementById("faces");
  EXPRESSIONS.forEach((name, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.exp = name; b.textContent = LABELS[i];
    b.title = `${LABELS[i]} (key ${i + 1})`;
    b.addEventListener("click", () => setExpression(name));
    facesEl.appendChild(b);
  });
  function facesUpdate() {
    document.querySelectorAll("#faces button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.exp === current)));
  }
  facesUpdate();
  function toggle(btnId, panelId) {
    const btn = document.getElementById(btnId), panel = document.getElementById(panelId);
    btn.addEventListener("click", () => {
      const open = panel.hidden; panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); fit();
    });
  }
  const closeTray = (t) => { t.hidden = true; document.querySelector(`[aria-controls="${t.id}"]`)?.setAttribute("aria-expanded", "false"); };
  toggle("btn-faces", "faces");
  document.getElementById("btn-faces").addEventListener("click", () => {   // one tray at a time, like Compass and Changes
    const more = document.getElementById("more");
    if (!document.getElementById("faces").hidden && !more.hidden) { closeTray(more); fit(); }
  });
  // ⋯ with any other tray open (Faces, Changes, Compass, Chat) closes them all; otherwise it opens or closes the menu.
  document.getElementById("btn-more").addEventListener("click", () => {
    const more = document.getElementById("more");
    const others = [...document.querySelectorAll(".tray")].filter((t) => t !== more && !t.hidden);
    if (others.length) { others.forEach(closeTray); closeTray(more); }
    else { const open = more.hidden; more.hidden = !open; document.getElementById("btn-more").setAttribute("aria-expanded", String(open)); }
    fit();
  });
  document.getElementById("btn-blink").addEventListener("click", () => blink());

  const subsBox = document.getElementById("opt-subs");
  subsBox.checked = body.classList.contains("subs");
  subsBox.addEventListener("change", () => { body.classList.toggle("subs", subsBox.checked); fit(); });
  const demoBox = document.getElementById("opt-demo");
  demoBox.checked = DEMO;
  if (WEB) demoBox.closest("label").hidden = true;
  if (WEB_DEMO) {
    demoBox.closest("label").hidden = true; micBtn.hidden = true;
    const hint = document.querySelector("#controls .hint");
    if (hint) hint.innerHTML = "Keyboard: <b>1</b> to <b>7</b> faces · <b>B</b> blink";
  }
  demoBox.addEventListener("change", () => { q.set("demo", demoBox.checked ? "1" : "0"); location.search = q.toString(); });
  const fsBtn = document.getElementById("btn-full");
  if (!document.documentElement.requestFullscreen) fsBtn.hidden = true;   // iPhone Safari: use "Add to Home Screen"
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.getElementById("btn-hide").addEventListener("click", () => {
    body.classList.add("hide-ui"); statusEl.blur(); fit();
  });
  stage.addEventListener("click", () => { if (body.classList.contains("hide-ui")) { body.classList.remove("hide-ui"); fit(); } });

  // ---------- keyboard (PC and the Legion Go 2 with a keyboard) ----------
  window.addEventListener("keydown", e => {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;   // typing, menus and buttons (the talk button too) handle their own keys
    if (e.code === "Space" && !e.repeat && !WEB_DEMO) { e.preventDefault(); micStart(); }
    if (e.key === "Escape" && WEB) brain().stop?.();
    const n = parseInt(e.key, 10); if (n >= 1 && n <= 7) setExpression(n - 1);
    if (e.key === "b" || e.key === "B") blink();
  });
  window.addEventListener("keyup", e => { if (e.code === "Space" && (micWanted || WEB) && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) micStop(); });

  // Browsers only play sound after a tap or click. OBS doesn't need it.
  const wake = document.getElementById("wake");
  if (OBS || WEB_DEMO) wake.remove();
  else {
    wake.querySelector("span").textContent = body.classList.contains("touch") ? "Tap to wake Rosin" : "Click to wake Rosin";
    wake.addEventListener("click", () => { audio(); wake.remove(); });
  }

  // ---------- demo mode ----------
  const DEMO_REPLIES = [
    [1, "Mm. Deep thought. Give me a minute, my vines are buffering."],
    [3, "Ha! Tell that one to Sheamus, he needs the laugh."],
    [6, "I'd answer, but this is just my demo. The real me lives on Sheamus's PC."],
    [2, "Aw, thanks for saying hi. Come hang out in the grove sometime."],
    [4, "Whoa, you can type at me? Fancy."],
  ];
  let replyN = 0, lastReply = 0;
  function demoReply() {
    lastReply = Date.now();
    const [e, t] = DEMO_REPLIES[replyN++ % DEMO_REPLIES.length];
    setTimeout(() => { setExpression(e, 3500); demoSpeak(t); }, 500);
  }
  function demoSpeak(text) {
    const words = text.split(/\s+/).length;
    subsEl.textContent = text; speaking = true;
    const ms = 400 + words * 260; wobble(ms); setTimeout(() => { speaking = false; }, ms);
  }
  if (DEMO) {
    const lines = [
      [0, "Oh hey, chat. Rosin's awake. Mostly."],
      [1, "Sheamus, did you water me today, or just yourself?"],
      [2, "Ooh, a new follower! Welcome to the grove."],
      [3, "Ha! That play was so bad I almost closed my eye."],
      [4, "Wait, you actually won that fight?"],
      [5, "Who keeps spamming the bell? I can hear it, you know."],
      [6, "Hold on, which way is up for a floating orb?"],
    ];
    let i = 0;
    setInterval(() => { if (Date.now() - lastReply < 9000) return; const [e, t] = lines[i++ % lines.length]; setExpression(e, 3500); demoSpeak(t); }, 4500);
  }

  // ---------- what a brain script (rosin-web.js) can drive ----------
  window.Rosin = {
    OBS, MUTE, SMALL_TOUCH, LITE, params: q,
    setExpression, blink, fit, audio,
    talking(on) { webTalk = !!on; if (on) rosin.classList.remove("thinking"); },
    pulse(v = 1) { webPulse = Math.max(webPulse, v); },
    setMood, get mood() { return mood; },
    thinking(on) { rosin.classList.toggle("thinking", !!on); if (on) setExpression("stoned", 0); },
    subs(text) { subsEl.textContent = text || ""; },
    status(text, error) { statusEl.textContent = text; statusEl.classList.toggle("err", !!error); },
    micLive(on) { micBtn.classList.toggle("live", !!on); micBtn.setAttribute("aria-pressed", String(!!on)); },
    get expression() { return current; },
  };
  if (WEB) document.dispatchEvent(new Event("rosin-ready"));

  // ---------- embers (fewer on phones) ----------
  const cv = document.getElementById("embers"), g = cv.getContext("2d");
  const MAX_EMBERS = LITE ? 14 : 40;
  let W = 0, H = 0; const parts = [];
  function resize() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
  addEventListener("resize", resize); resize();
  (function emberLoop() {
    if (!document.hidden) {
      const glow = shown > 0 ? shown : 0;
      if (parts.length < MAX_EMBERS * (1 + glow * 1.5) && Math.random() < 0.5 + glow) {
        const b = rosin.getBoundingClientRect(), r = b.width * 0.55;
        parts.push({ x: b.left + b.width * 0.44 + (Math.random() - 0.5) * r, y: b.top + b.height * (0.62 + Math.random() * 0.12),
                     vx: (Math.random() - 0.5) * 0.4, vy: -0.3 - Math.random() * (0.6 + glow * 1.5),
                     life: 1, s: 1 + Math.random() * 2.5 });
      }
      g.clearRect(0, 0, W, H);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.x += p.vx + Math.sin((p.y + i) / 30) * 0.3; p.y += p.vy; p.life -= 0.006;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        g.fillStyle = `rgba(255, ${90 + 80 * p.life | 0}, 40, ${p.life * 0.8})`;
        g.beginPath(); g.arc(p.x, p.y, p.s, 0, 6.283); g.fill();
      }
    }
    requestAnimationFrame(emberLoop);
  })();

  // ---------- smoke: the sheet's own wisp under the orb, as its own layer ----------
  // The red smoke drawn under Rosin on the concept sheet (img/smoke.*), cut out and animated apart from Rosin:
  // it curls (a slow two-way ripple that travels up the wisp, so it looks like it's rising), drifts and breathes,
  // and now and then a small puff peels off it and floats up. It sits behind Rosin, under the orb, and nowhere else.
  // Rosin bobs above it instead of carrying it. At most 30 frames a second (24 on phones), paused while hidden.
  try { smoke(); } catch (e) { console.warn("Rosin's smoke couldn't start:", e); }   // smoke is decoration: never let it break the page
  function smoke() {
    if (!smokeShown()) return;
    const SM = L.smoke, FPS = LITE ? 24 : 30, DPR = Math.min(window.devicePixelRatio || 1, LITE ? 1.5 : 2);
    const c = document.createElement("canvas");
    c.className = "smoke"; c.setAttribute("aria-hidden", "true");
    stage.parentNode.insertBefore(c, stage);
    const g = c.getContext("2d");
    const off = document.createElement("canvas"), og = off.getContext("2d");   // first half of the warp
    const img = new Image();
    img.src = `img/smoke.${IMG_EXT}`;
    let seeds = [];    // spots on the wisp where puffs can peel off (fractions of the wisp's box) and their colour
    img.onload = () => {
      try {   // read the wisp once, small, to find where it's thick enough to shed a puff
        const k = document.createElement("canvas"); k.width = 85; k.height = 54;
        const kg = k.getContext("2d"); kg.drawImage(img, 0, 0, 85, 54);
        const d = kg.getImageData(0, 0, 85, 54).data;
        for (let y = 0; y < 54; y += 2) for (let x = 0; x < 85; x += 2) {
          const i = (y * 85 + x) * 4;
          if (d[i + 3] > 150) seeds.push({ x: x / 85, y: y / 54, rgb: `${d[i]},${d[i + 1]},${d[i + 2]}` });
        }
      } catch {}
      if (!seeds.length) seeds = [{ x: 0.2, y: 0.5, rgb: "190,50,30" }, { x: 0.9, y: 0.75, rgb: "200,70,30" }];
      size(); requestAnimationFrame(frame);
    };
    function size() { c.width = Math.ceil(innerWidth * DPR); c.height = Math.ceil(innerHeight * DPR); }
    addEventListener("resize", size);
    const puffs = [], MAXP = LITE ? 6 : 10;
    let last = performance.now(), acc = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000); last = now; acc += dt;
      if (document.hidden || acc < 1 / FPS) return;
      const step = acc; acc = 0;
      const t = now / 1000, glow = Math.max(0, +getComputedStyle(root).getPropertyValue("--glow") || 0);
      // Where the wisp goes: the sheet's spot under the orb, from the layout (not the float, so it moves on its own).
      const bw = rosin.offsetWidth * DPR, bh = rosin.offsetHeight * DPR;
      // Drawn lower and taller than on the sheet (showY, showH), so Rosin and the smoke stand closer to 9:16.
      const sy = SM.showY ?? SM.y, sh = SM.showH ?? SM.h;
      const x0 = rosin.offsetLeft * DPR + SM.x / L.W * bw, y0 = rosin.offsetTop * DPR + sy / L.H * bh;
      const w = SM.w / L.W * bw, h = sh / L.H * bh;
      g.clearRect(0, 0, c.width, c.height);
      if (w < 4 || h < 4) return;
      // 1. Ripple each row sideways: little at the top where it leaves the orb, more down the tail.
      //    Rows and columns sit on whole pixels and never overlap, so the soft edges don't stack into stripes.
      const pad = Math.ceil(w * 0.06), dw = Math.round(w), dh = Math.round(h * (1 + Math.sin(t * 0.7) * 0.025));
      const ow = dw + pad * 2, oh = dh + pad * 2;
      if (off.width !== ow || off.height !== oh) { off.width = ow; off.height = oh; } else og.clearRect(0, 0, ow, oh);
      const RH = LITE ? 4 : 3;
      for (let y = 0; y < dh; y += RH) {
        const hh = Math.min(RH, dh - y), yn = y / dh, amp = w * (0.008 + yn * 0.028);
        const dx = amp * Math.sin(yn * 7 + t * 1.25) + amp * 0.45 * Math.sin(yn * 15 + t * 2.1 + 1.3);
        og.drawImage(img, 0, yn * img.height, img.width, hh / dh * img.height, pad + dx, pad + y, dw, hh);
      }
      // 2. Ripple each column up and down, so the shape curls instead of just sliding.
      const CW = LITE ? 5 : 4;
      const sway = Math.sin(t * 0.23) * w * 0.012, bob = Math.sin(t * 0.31 + 1) * h * 0.012;
      const left = Math.round(x0 - pad + sway), top = y0 - pad + bob;
      g.save();
      g.globalAlpha = Math.min(1, 0.88 + Math.sin(t * 0.9) * 0.06 + glow * 0.12);
      for (let x = 0; x < ow; x += CW) {
        const ww = Math.min(CW, ow - x), xn = x / ow;
        const dy = h * 0.022 * Math.sin(xn * 6 - t * 0.9) + h * 0.01 * Math.sin(xn * 13 + t * 1.7);
        g.drawImage(off, x, 0, ww, oh, left + x, top + dy, ww, oh);
      }
      // 3. Now and then a puff peels off the wisp and floats up, curling, then fades.
      if (puffs.length < MAXP * (1 + glow) && Math.random() < step * (0.9 + glow * 2)) {
        const s = seeds[Math.floor(Math.random() * seeds.length)];
        puffs.push({ x: s.x, y: s.y, rgb: s.rgb, life: 0, max: 2.5 + Math.random() * 2.5, r: 0.03 + Math.random() * 0.035,
                     dir: Math.random() < 0.5 ? -1 : 1, seed: Math.random() * 9 });
      }
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i]; p.life += step;
        if (p.life >= p.max) { puffs.splice(i, 1); continue; }
        const k = p.life / p.max;
        const px = x0 + sway + p.x * w + p.dir * Math.sin(k * 3 + p.seed) * w * 0.05 * k;
        const py = y0 + bob + p.y * h - k * h * 0.45;
        const r = p.r * w * (0.7 + k * 1.3), a = Math.min(1, k / 0.2) * (1 - k) * 0.5;
        const gr = g.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, `rgba(${p.rgb},${a})`); gr.addColorStop(1, `rgba(${p.rgb},0)`);
        g.globalAlpha = 1; g.fillStyle = gr;
        g.beginPath(); g.ellipse(px, py, r, r * 0.6, p.dir * 0.5 + Math.sin(t + p.seed) * 0.3, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
  }
})();
