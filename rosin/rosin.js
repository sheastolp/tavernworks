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
 */
(() => {
  const q = new URLSearchParams(location.search);
  const OBS = q.get("obs") === "1";
  const WEB_DEMO = window.ROSIN_DEMO === true;
  const DEMO = WEB_DEMO || q.get("demo") === "1";
  const IMG_EXT = window.ROSIN_IMG_EXT || "png";
  const MUTE = q.get("mute") === "1";
  const SMALL_TOUCH = matchMedia("(pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 500px)").matches;
  const LITE = q.get("lite") === "1" || (q.get("lite") !== "0" && !OBS && SMALL_TOUCH);
  const body = document.body;
  body.classList.add(OBS ? "obs" : "preview");
  if (LITE) body.classList.add("lite");
  if (matchMedia("(any-pointer: coarse)").matches) body.classList.add("touch");
  if (q.get("subs") === "1" || (!OBS && (SMALL_TOUCH || WEB_DEMO) && q.get("subs") !== "0")) body.classList.add("subs");

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
  rig.style.transformOrigin = rosin.style.transformOrigin = `${pct(E.cx, L.W)} ${pct(E.cy, L.H)}`;
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
  function fit() {
    const ctrlH = body.classList.contains("preview") && !body.classList.contains("hide-ui") ? controls.offsetHeight + 8 : 0;
    root.style.setProperty("--ctrl-h", ctrlH + "px");
    const w = stage.clientWidth, h = stage.clientHeight - ctrlH;
    const height = Math.max(120, Math.min(h * 0.94, w * 0.96 * L.H / L.W));
    rosin.style.height = height + "px"; rosin.style.width = (height * L.W / L.H) + "px";
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

  let smooth = 0, shown = -1;
  (function tick() {
    let v = 0;
    if (analyser && speaking && currentSrc) {
      analyser.getFloatTimeDomainData(buf);
      let s = 0; for (const x of buf) s += x * x;
      v = Math.min(1, Math.sqrt(s / buf.length) * 5);
    }
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
    if (DEMO) { demoReply(); } else { send({ type: "text-input", text }); }
    box.value = "";
    if (SMALL_TOUCH) box.blur();     // drop the phone keyboard so Rosin is visible again
  });

  // ---------- push-to-talk (mouse, touch, pen, or Space) ----------
  // The speech recogniser wants 16 kHz mono floats. Phones often refuse a 16 kHz mic context,
  // so record at the device rate and downsample here.
  let mic = null;   // {ctx, stream, node, src}
  let micWanted = false;
  async function micStart() {
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
  micBtn.addEventListener("pointercancel", micStop);
  micBtn.addEventListener("lostpointercapture", micStop);
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
  toggle("btn-faces", "faces");
  toggle("btn-more", "more");
  document.getElementById("btn-blink").addEventListener("click", () => blink());

  const subsBox = document.getElementById("opt-subs");
  subsBox.checked = body.classList.contains("subs");
  subsBox.addEventListener("change", () => body.classList.toggle("subs", subsBox.checked));
  const demoBox = document.getElementById("opt-demo");
  demoBox.checked = DEMO;
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
    if (e.target.tagName === "INPUT" || e.target === micBtn) return;   // the talk button handles its own keys
    if (e.code === "Space" && !e.repeat && !WEB_DEMO) { e.preventDefault(); micStart(); }
    const n = parseInt(e.key, 10); if (n >= 1 && n <= 7) setExpression(n - 1);
    if (e.key === "b" || e.key === "B") blink();
  });
  window.addEventListener("keyup", e => { if (e.code === "Space" && micWanted) micStop(); });

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
        parts.push({ x: b.left + b.width * 0.56 + (Math.random() - 0.5) * r, y: b.top + b.height * (0.62 + Math.random() * 0.12),
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
})();
