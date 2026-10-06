// Tavernworks Sound Bytes: every sound is synthesized live with the Web
// Audio API, so there are no audio files to host, license or load. Shared by
// the Sound Bytes page (soundboard + preview) and the OBS overlay.
//
//   SoundBytes.list           [{ id, name, icon, blurb, line }]
//   SoundBytes.get(id)        one entry, or undefined
//   SoundBytes.play(id, vol)  plays it (vol 0..1); resolves with its length in seconds
//
// `line` is the chat text the suggested GuildScribe command posts after the
// 🔊 tag; {user} is filled in by GuildScribe. `cmd` is the suggested
// !command name when it can't simply be the sound's id.
(function () {
  let ctx = null, master = null, noiseBuf = null;

  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      comp.connect(ctx.destination);
      master = ctx.createGain();
      master.connect(comp);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // An attack/decay envelope on a fresh gain node.
  function env(out, t, dur, peak, attack = 0.01) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    return g;
  }

  // One oscillator, optionally sliding from freq to to.
  function tone(out, { type = "sine", freq, to, t = 0, dur = 0.3, gain = 0.3, attack = 0.01, vibrato = 0, detune = 0 }) {
    const start = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(freq, start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, start + dur);
    if (vibrato) {
      const lfo = ctx.createOscillator(), depth = ctx.createGain();
      lfo.frequency.value = vibrato;
      depth.gain.value = freq * 0.03;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(start);
      lfo.stop(start + dur);
    }
    o.connect(env(out, start, dur, gain, attack));
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  // A burst of filtered white noise, optionally sweeping the filter.
  function noise(out, { t = 0, dur = 0.2, gain = 0.3, type = "bandpass", freq = 2000, to, q = 1, attack = 0.005 }) {
    const start = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, start);
    if (to) f.frequency.exponentialRampToValueAtTime(to, start + dur);
    src.connect(f).connect(env(out, start, dur, gain, attack));
    src.start(start, Math.random());
    src.stop(start + dur + 0.05);
  }

  function lowpass(out, freq) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = freq;
    f.connect(out);
    return f;
  }

  function drive(out, amount) {
    const ws = ctx.createWaveShaper(), n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / n) * 2 - 1; curve[i] = Math.tanh(x * amount); }
    ws.curve = curve;
    ws.connect(out);
    return ws;
  }

  const N = (semis) => 261.63 * Math.pow(2, semis / 12); // semitones from middle C

  const SOUNDS = [
    {
      id: "nat20", name: "Natural 20", icon: "🌟",
      blurb: "A brass fanfare fit for a crit.",
      line: "{user} rolled a NATURAL 20! The bards are already writing the song.",
      len: 1.9,
      play(out) {
        const brass = lowpass(out, 2600);
        [[0, 0, 0.14], [7, 0.15, 0.14], [12, 0.3, 0.14], [16, 0.45, 1.3]].forEach(([s, t, dur]) => {
          tone(brass, { type: "sawtooth", freq: N(s), t, dur, gain: 0.22, attack: 0.03, vibrato: dur > 1 ? 5.5 : 0 });
          tone(brass, { type: "sawtooth", freq: N(s - 12), t, dur, gain: 0.12, attack: 0.03, detune: 6 });
        });
        [0, 4, 7].forEach((s) => tone(out, { type: "triangle", freq: N(s + 12), t: 0.45, dur: 1.3, gain: 0.08, attack: 0.05 }));
        noise(out, { t: 0.45, dur: 1.2, gain: 0.05, type: "highpass", freq: 7000 });
      },
    },
    {
      id: "nat1", name: "Natural 1", icon: "💀",
      blurb: "The sad trombone of critical failure.",
      line: "{user} rolled a natural 1. The dice gods turn away in shame.",
      len: 2.2,
      play(out) {
        const horn = lowpass(out, 1400);
        [[N(-2), 0, 0.42], [N(-3), 0.45, 0.42], [N(-4), 0.9, 0.42]].forEach(([freq, t, dur]) =>
          tone(horn, { type: "sawtooth", freq, t, dur, gain: 0.3, attack: 0.04 }));
        tone(horn, { type: "sawtooth", freq: N(-5), to: N(-7), t: 1.35, dur: 0.85, gain: 0.3, attack: 0.04, vibrato: 7 });
      },
    },
    {
      id: "dice", name: "Dice Roll", icon: "🎲",
      blurb: "A handful of dice rattling across the table.",
      line: "{user} shakes the dice cup and lets them fly...",
      len: 1.0,
      play(out) {
        let t = 0;
        for (let i = 0; i < 14; i++) {
          t += 0.025 + Math.random() * (0.03 + i * 0.006);
          noise(out, { t, dur: 0.03 + Math.random() * 0.03, gain: 0.5 - i * 0.025, freq: 2500 + Math.random() * 3000, q: 4 });
          tone(out, { type: "triangle", freq: 900 + Math.random() * 900, t, dur: 0.04, gain: 0.08 });
        }
      },
    },
    {
      id: "sword", name: "Sword Clash", icon: "⚔️",
      blurb: "Steel on steel, ringing out.",
      line: "⚔️ Steel rings out! {user} crosses blades with destiny.",
      len: 1.4,
      play(out) {
        noise(out, { dur: 0.12, gain: 0.6, type: "highpass", freq: 3000, attack: 0.001 });
        [2310, 3170, 4420, 5980, 7230].forEach((freq, i) =>
          tone(out, { freq, to: freq * 0.995, dur: 1.3 - i * 0.18, gain: 0.12 - i * 0.015, attack: 0.002 }));
        noise(out, { t: 0.05, dur: 0.6, gain: 0.08, freq: 6000, q: 8 });
      },
    },
    {
      id: "coins", name: "Coin Purse", icon: "🪙",
      blurb: "Gold spilling onto the bar.",
      line: "🪙 {user} empties a jingling purse onto the bar. Drinks are on them!",
      len: 1.1,
      play(out) {
        let t = 0;
        for (let i = 0; i < 9; i++) {
          t += 0.04 + Math.random() * 0.08;
          const f = 2600 + Math.random() * 1800;
          tone(out, { freq: f, t, dur: 0.25, gain: 0.12, attack: 0.002 });
          tone(out, { freq: f * 1.5, t, dur: 0.2, gain: 0.08, attack: 0.002 });
          tone(out, { freq: f * 2.76, t, dur: 0.12, gain: 0.04, attack: 0.002 });
        }
      },
    },
    {
      id: "ding", name: "Level Up", icon: "⬆️",
      blurb: "A chiptune climb to the next level.",
      line: "⬆️ {user} feels stronger. LEVEL UP!",
      len: 1.2,
      play(out) {
        [0, 4, 7, 12, 16, 19, 24].forEach((s, i) =>
          tone(out, { type: "square", freq: N(s + 12), t: i * 0.07, dur: 0.12, gain: 0.08, attack: 0.003 }));
        [12, 16, 19, 24].forEach((s) => tone(out, { type: "square", freq: N(s + 12), t: 0.5, dur: 0.65, gain: 0.05, attack: 0.003, vibrato: 6 }));
      },
    },
    {
      // Not !fireball: "fireball" anywhere in chat is also a spell word in
      // GuildScribe's Endless Delve idle game.
      id: "fireball", cmd: "kaboom", name: "Fireball", icon: "🔥",
      blurb: "A roaring whoosh and a big boom.",
      line: "🔥 {user} casts FIREBALL! Everyone make a Dex save.",
      len: 2.0,
      play(out) {
        noise(out, { dur: 0.7, gain: 0.35, type: "lowpass", freq: 300, to: 3500, attack: 0.5 });
        const boom = drive(out, 3);
        tone(boom, { freq: 110, to: 32, t: 0.65, dur: 1.2, gain: 0.7, attack: 0.005 });
        noise(out, { t: 0.65, dur: 1.3, gain: 0.5, type: "lowpass", freq: 2500, to: 150, attack: 0.005 });
      },
    },
    {
      id: "heal", name: "Healing Light", icon: "✨",
      blurb: "A shimmering cleric's blessing.",
      line: "✨ A warm light washes over {user}. Hit points restored!",
      len: 2.0,
      play(out) {
        [0, 4, 7, 11, 14, 19, 23, 26].forEach((s, i) => {
          tone(out, { freq: N(s + 12), t: i * 0.09, dur: 1.2, gain: 0.07, attack: 0.04 });
          tone(out, { freq: N(s + 12), t: i * 0.09, dur: 1.2, gain: 0.05, attack: 0.04, detune: 9 });
        });
        noise(out, { dur: 1.9, gain: 0.04, type: "highpass", freq: 8000, attack: 0.6 });
      },
    },
    {
      id: "drumroll", name: "Drumroll", icon: "🥁",
      blurb: "Building suspense, then a cymbal crash.",
      line: "🥁 {user} calls for a drumroll... the moment of truth!",
      len: 3.0,
      play(out) {
        for (let i = 0; i < 34; i++) {
          const t = i * 0.055;
          noise(out, { t, dur: 0.06, gain: 0.08 + (i / 34) * 0.3, freq: 1800, q: 0.8 });
          tone(out, { type: "triangle", freq: 190, to: 120, t, dur: 0.05, gain: 0.05 + (i / 34) * 0.12 });
        }
        noise(out, { t: 1.9, dur: 1.1, gain: 0.45, type: "highpass", freq: 5000, attack: 0.002 });
        tone(out, { freq: 90, to: 50, t: 1.9, dur: 0.4, gain: 0.5, attack: 0.002 });
      },
    },
    {
      id: "roar", name: "Dragon Roar", icon: "🐉",
      blurb: "Something big just woke up.",
      line: "🐉 {user} woke the dragon. Roll initiative!",
      len: 2.4,
      play(out) {
        const growl = drive(lowpass(out, 1200), 4);
        tone(growl, { type: "sawtooth", freq: 140, to: 55, dur: 2.2, gain: 0.35, attack: 0.25, vibrato: 18 });
        tone(growl, { type: "sawtooth", freq: 147, to: 58, dur: 2.2, gain: 0.25, attack: 0.25, vibrato: 23 });
        noise(out, { dur: 2.2, gain: 0.3, freq: 700, to: 250, q: 1.5, attack: 0.3 });
      },
    },
    {
      id: "bell", name: "Tavern Bell", icon: "🔔",
      blurb: "Last call! Or first call. Who's counting?",
      line: "🔔 {user} rings the tavern bell. A round for the house!",
      len: 2.8,
      play(out) {
        [[1, 0.25], [2.0, 0.15], [2.76, 0.12], [5.4, 0.07], [8.93, 0.04]].forEach(([m, g]) => {
          tone(out, { freq: 523 * m, dur: 2.7, gain: g, attack: 0.002 });
          tone(out, { freq: 523 * m, t: 0.45, dur: 2.3, gain: g * 0.7, attack: 0.002 });
        });
      },
    },
  ];

  const byId = Object.fromEntries(SOUNDS.map((s) => [s.id, s]));

  window.SoundBytes = {
    list: SOUNDS.map(({ id, cmd, name, icon, blurb, line, len }) => ({ id, cmd: cmd || id, name, icon, blurb, line, len })),
    get: (id) => byId[String(id).toLowerCase()],
    play(id, volume = 0.7) {
      const s = byId[String(id).toLowerCase()];
      if (!s) return Promise.resolve(0);
      audio();
      const out = ctx.createGain();
      out.gain.value = Math.max(0, Math.min(1, volume));
      out.connect(master);
      s.play(out);
      setTimeout(() => out.disconnect(), (s.len + 1) * 1000);
      return Promise.resolve(s.len);
    },
  };
})();
