/* rosin-ear.js: which microphone Rosin hears, and listening for its name (load after rosin-web.js).
 *
 *   - ⋯ → Microphone picks the mic on this device. On Windows, pick the same mic OBS uses: Windows lets OBS and Rosin
 *     both use one mic at once, so Rosin hears exactly what the stream hears. No virtual cable, no OBS WebSocket.
 *     The pick stays on this device (a phone's mics aren't a PC's).
 *   - ⋯ → "Listen for “Rosin”": Rosin keeps the mic open and acts when you say its name, e.g. "Rosin, what's the
 *     weather", or "Rosin" then the rest. What you say between is sent to the laptop's Whisper to be written down and
 *     dropped straight away unless it starts with Rosin's name; nothing is kept. Spoken commands that happen at once:
 *       "Rosin, stop" / "be quiet"           stops talking
 *       "Rosin, hush" / "quiet for an hour"  no speaking up on its own for an hour (still answers you)
 *       "Rosin, stop/start answering chat"   Twitch chat on or off
 *       "Rosin, read the last chat"          reads out and answers the last chat line
 *       "Rosin, look happy" (angry, surprised, confused, stoned, laugh, normal)
 *       music: "Rosin, pause", "skip", "play …" (rosin-spotify.js's instant commands)
 *     Anything else goes to Rosin as if you'd said it with 🎙 Talk.
 *     It pauses while Rosin talks, so Rosin doesn't hear itself.
 * Push to talk is still 🎙 Talk, holding Space, or Ctrl+Alt+T anywhere in Windows (the Windows app).
 */
(() => {
  const B = window.RosinBrain, H = B && B._hooks, R = window.Rosin;
  if (!H || !R || window.ROSIN_MIRROR) return;
  const OBS = !!R.OBS || H.device() === "obs";
  const store = H.store, SEC = 1000;
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia || OBS) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---------- ⋯ → Microphone ----------
  const micSel = document.createElement("select");
  const micField = H.field("Microphone", micSel);
  const namesBtn = el("button", "", "Show the microphones' names"); namesBtn.type = "button";
  const micNote = el("p", "voice-note");
  const [wakeChk, wakeBox] = H.check("Listen for “Rosin” (always on, say its name first)");
  const wakeNote = el("p", "voice-note");
  const wrap = el("div", "ear-box"); wrap.append(micField, namesBtn, micNote, wakeChk, wakeNote);
  H.more.append(wrap);

  async function fillMics() {
    let list = [];
    try { list = (await md.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch {}
    const want = store.get("mic.device", "");
    const named = list.some((d) => d.label);
    const opts = [new Option("Default (the system's microphone)", "")];
    list.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
      .forEach((d, i) => opts.push(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
    if (want && !opts.some((o) => o.value === want)) opts.push(new Option("The one picked before (not plugged in?)", want));
    micSel.replaceChildren(...opts); micSel.value = want;
    namesBtn.hidden = named || list.length === 0;
    micNote.textContent = want ? "Rosin hears this microphone on this device. Pick the same one as OBS's Mic/Aux to hear what the stream hears."
      : H.device() === "windows-app" || H.device() === "handheld" ? "To hear what OBS hears, pick the mic OBS uses (OBS → Settings → Audio → Mic/Auxiliary Audio)." : "";
    H.fit();
  }
  namesBtn.addEventListener("click", async () => {   // browsers only name mics once the page may use one
    try { const s = await md.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch {}
    fillMics();
  });
  micSel.addEventListener("change", () => { store.set("mic.device", micSel.value); fillMics(); if (wake.on) { stopWake(); startWake(); } });
  md.addEventListener?.("devicechange", fillMics);
  fillMics();

  // ---------- listening for Rosin's name ----------
  // Whisper writes "Rosin" a few ways.
  const NAME = /^(?:(?:hey|ok|okay|yo|oi)[\s,]+)?(?:rosin|rosen|rozin|rozen|rosie|roseanne?|rosanne?|raisin|resin|rossin)\b[\s,.!?:;-]*/i;
  const extraNames = () => String(store.get("ear.words", "") || "").split(/[\n,]+/).map((w) => w.trim()).filter((w) => w.length >= 3).slice(0, 10);
  function afterName(text) {
    const t = String(text || "").trim().replace(/^[\s"'“”.,!?-]+/, "");
    const m = NAME.exec(t);
    if (m) return t.slice(m[0].length).trim();
    for (const w of extraNames()) {
      const re = new RegExp("^(?:(?:hey|ok|okay)[\\s,]+)?" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b[\\s,.!?:;-]*", "i");
      const x = re.exec(t); if (x) return t.slice(x[0].length).trim();
    }
    return null;
  }
  const wake = { on: false, stream: null, ctx: null, floor: 0.01, followUntil: 0, sending: 0 };
  function wakeSay(text) { R.status(text); }
  async function startWake() {
    if (wake.on) return;
    wake.on = true; drawWake();
    const id = store.get("mic.device", "");
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      try { wake.stream = await md.getUserMedia({ audio: id ? { ...audio, deviceId: { exact: id } } : audio }); }
      catch (e) { if (id && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) wake.stream = await md.getUserMedia({ audio }); else throw e; }
    } catch (e) {
      wake.on = false; wakeBox.checked = false; store.set("mic.wake", false);
      wakeNote.textContent = e.name === "NotAllowedError" ? "The microphone is blocked. Allow it for tavernworks.dev, then tick this again." : "The microphone couldn't start.";
      drawWake(); return;
    }
    if (!wake.on) { wake.stream.getTracks().forEach((t) => t.stop()); return; }
    fillMics();
    // The mic's sound, kept as plain samples: half a second from before it got loud is kept too, so the start of
    // "Rosin" isn't cut off. A turn ends after 0.9 s of quiet (or 15 s) and goes to the laptop as a small WAV.
    const ctx = wake.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(wake.stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    const rate = ctx.sampleRate, chunkMs = (4096 / rate) * 1000, PRE = Math.ceil(500 / chunkMs);
    let pre = [], take = null, lastLoud = 0, started = 0;
    proc.onaudioprocess = (ev) => {
      if (!wake.on) return;
      const data = new Float32Array(ev.inputBuffer.getChannelData(0));
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length), now = Date.now();
      // Rosin talking or thinking, or a 🎙 Talk turn: don't listen, and drop anything half heard.
      if (H.busy()) { take = null; pre = []; return; }
      const loud = rms > Math.max(0.018, Math.min(0.07, wake.floor * 2.5));
      if (!take) {
        wake.floor = wake.floor * 0.97 + rms * 0.03;   // the room's own noise, slowly
        pre.push(data); if (pre.length > PRE) pre.shift();
        if (loud) { take = pre; pre = []; lastLoud = started = now; }
        return;
      }
      take.push(data);
      if (loud) lastLoud = now;
      if (now - lastLoud > 900 || now - started > 15000) {
        const parts = take; take = null;
        if (lastLoud - started > 250) heard(wav(parts, rate));
      }
    };
    if (!wake.resumer) wake.resumer = H.tick(2000, () => { if (wake.on && wake.ctx?.state === "suspended") wake.ctx.resume().catch(() => {}); });
    drawWake();
  }
  function wav(parts, rate) {   // mono 16 kHz 16-bit WAV: small to send, and all Whisper needs
    const n = parts.reduce((a, p) => a + p.length, 0), all = new Float32Array(n);
    let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const outRate = 16000, step = rate / outRate, len = Math.floor(n / step);
    const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      const x = i * step, j = Math.floor(x), f = x - j, s = all[j] + ((all[j + 1] ?? all[j]) - all[j]) * f;
      v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }
  function stopWake() {
    wake.on = false;
    wake.stream?.getTracks().forEach((t) => t.stop()); wake.stream = null;
    wake.ctx?.close().catch(() => {}); wake.ctx = null;
    drawWake();
  }
  async function heard(blob) {
    if (wake.sending > 2) return;   // the laptop is behind: let this one go
    wake.sending++;
    let text = "";
    try {
      const r = await fetch(H.GATE + "/api/transcribe", H.gopts({ method: "POST", headers: { "Content-Type": blob.type }, body: blob, signal: H.timeout(30 * SEC) }));
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { wakeNote.textContent = "The laptop key is missing or wrong (⋯ → Laptop key)."; return; }
      text = r.ok ? String(j.text || "").trim() : "";
    } catch { return; } finally { wake.sending--; }
    if (!text || /^\W*$/.test(text) || H.busy()) return;
    let rest = afterName(text);
    if (rest === null) {
      if (Date.now() < wake.followUntil) { wake.followUntil = 0; rest = text; }   // "Rosin." … "what time is it"
      else return;                                                               // not for Rosin: forget it
    }
    rest = rest.replace(/^[\s,.!?-]+/, "").trim();
    if (!rest) { wake.followUntil = Date.now() + 8 * SEC; R.setExpression?.("surprise", 1500); wakeSay("Yes? I'm listening…"); return; }
    command(rest);
  }

  const FACES = { happy: "happy", glad: "happy", smile: "happy", laugh: "laugh", laughing: "laugh", angry: "anger", mad: "anger", surprised: "surprise", shocked: "surprise",
    confused: "confused", stoned: "stoned", sleepy: "stoned", high: "stoned", normal: "normal", neutral: "normal" };
  function command(said) {
    const t = said.toLowerCase().replace(/[.!?,]+$/g, "").trim();
    if (/^(stop|stop talking|be quiet|shut up|shush|enough|that's enough|cancel)$/.test(t)) { B.stop(); wakeSay("Stopped"); return; }
    if (/^(hush|quiet|quiet down|hush for an hour|quiet for an hour|be quiet for an hour|go quiet|stop chatting)$/.test(t)) {
      const I = B.initiative?.settings;
      if (I) { I.hushUntil = Date.now() + 3600 * SEC; store.set("init.hushUntil", I.hushUntil); B.initiative.draw?.(); }
      H.heardFrom?.(); wakeSay("Hushed for an hour. Rosin still answers you."); return;
    }
    const chat = /^(stop|start|quit|pause|resume) (answering|reading|watching) (the )?(twitch )?chat$/.exec(t);
    if (chat) {
      const on = /start|resume/.test(chat[1]);
      if (on && !B.settings.channel) { wakeSay("Set the Twitch channel under ⋯ first."); return; }
      store.set("twitchOn", on); H.applySynced?.("twitchOn", on);
      wakeSay(on ? `Answering #${B.settings.channel} chat` : "Not answering chat now"); return;
    }
    if (/^(read|what did|what's) (out )?(the )?(last )?(chat|chat message|twitch chat)( say| said)?$/.test(t) || /^read (me )?the last chat( message)?$/.test(t)) {
      const m = H.twitchStatus?.().lastMsg;
      if (!m) { wakeSay("No chat messages yet."); return; }
      B.ask(`[Sheamus asked you to read out the last Twitch chat message and answer it] ${m.user}: ${m.text}`, { who: (B.settings.name || "Sheamus") });
      return;
    }
    const face = /^(look|be|make a|do a|show)( your)? (\w+)( face)?$/.exec(t);
    if (face && FACES[face[3]]) { R.setExpression(FACES[face[3]], 6000); return; }
    B.say(said);   // music and everything else: as if said with 🎙 Talk (instant commands like "pause" happen at once)
  }

  function drawWake() {
    wakeBox.checked = wake.on || store.get("mic.wake", false);
    if (!wake.on && !store.get("mic.wake", false)) { if (!/blocked|couldn't|key/.test(wakeNote.textContent)) wakeNote.textContent = "Uses the laptop's Whisper for everything you say while it's on, so leave it off when you don't need it."; }
    else if (wake.on) wakeNote.textContent = "Listening for “Rosin”. Say “Rosin, …” and the rest, or “Rosin” and wait for it. It doesn't listen while Rosin talks.";
    H.fit();
  }
  wakeBox.addEventListener("change", () => { store.set("mic.wake", wakeBox.checked); wakeNote.textContent = ""; if (wakeBox.checked) startWake(); else stopWake(); });
  // Browsers only open the mic after a tap: start on the first one if it was on last time. The apps can start at once.
  if (store.get("mic.wake", false)) {
    const inApp = /RosinApp|Electron/.test(navigator.userAgent) || /[?&]app=/.test(location.search);
    if (inApp) H.later(1500, startWake);
    else window.addEventListener("pointerdown", () => { if (store.get("mic.wake", false)) startWake(); }, { once: true, capture: true });
  }
  drawWake();
  B.ear = { start: startWake, stop: stopWake, listening: () => wake.on, afterName, command, mics: fillMics };
})();
