// Cosmetics: looks only. Nothing here can change puzzles, moves, scoring,
// timers or anything else about how the game plays.
//
// The default of every option is free. The other options come with the
// Cosmetics and Supporter tiers (see license.js). Anyone can preview them in the demo.
(() => {
  const CATALOG = {
    // Board and panel colours. Ignored with the GuildScribe layout (frame=1),
    // which has its own parchment look.
    theme: {
      label: 'Board theme',
      options: {
        classic: { name: 'Classic', free: true },
        neon: { name: 'Neon Arcade', dark: true },
        terminal: { name: 'Green Terminal', dark: true, font: 'VT323' },
        ocean: { name: 'Deep Ocean' },
        pastel: { name: 'Pastel Picnic' },
        ember: { name: 'Ember Forge', dark: true },
      },
    },
    // Plays over the "Solved!" screen.
    celebrate: {
      label: 'Solve celebration',
      options: {
        none: { name: 'None', free: true },
        confetti: { name: 'Confetti' },
        fireworks: { name: 'Fireworks' },
        coins: { name: 'Gold coin shower' },
      },
    },
    // The font of the big numbers on the board.
    digits: {
      label: 'Digit font',
      options: {
        standard: { name: 'Standard', free: true },
        hand: { name: 'Handwritten', font: 'Patrick Hand' },
        rounded: { name: 'Rounded', font: 'Fredoka:wght@600' },
        serif: { name: 'Storybook serif', font: 'Playfair Display:wght@700' },
        pixel: { name: 'Pixel', font: 'Press Start 2P' },
      },
    },
    // How chat's correct numbers look when they land.
    ink: {
      label: 'Digit style',
      options: {
        plain: { name: 'Plain (in the viewer\'s chat colour)', free: true },
        glow: { name: 'Glow' },
        stamp: { name: 'Stamp' },
      },
    },
  };
  const KINDS = Object.keys(CATALOG);
  const DEFAULTS = Object.fromEntries(KINDS.map((k) => [k, Object.keys(CATALOG[k].options).find((o) => CATALOG[k].options[o].free)]));

  // Turns raw URL values into known option IDs (unknown ones fall back to the default).
  function normalize(raw) {
    const out = {};
    for (const k of KINDS) {
      const v = String((raw && raw[k]) || '').toLowerCase();
      out[k] = CATALOG[k].options[v] ? v : DEFAULTS[k];
    }
    return out;
  }
  const isPaid = (kind, id) => !CATALOG[kind].options[id].free;
  const wantsPaid = (sel) => KINDS.some((k) => isPaid(k, sel[k]));
  // Keeps what's allowed: everything when unlocked, otherwise the free defaults.
  const allowed = (sel, unlocked) => Object.fromEntries(KINDS.map((k) => [k, unlocked || !isPaid(k, sel[k]) ? sel[k] : DEFAULTS[k]]));

  const loadedFonts = new Set();
  function loadFont(spec) {
    if (!spec || loadedFonts.has(spec)) return;
    loadedFonts.add(spec);
    const [family, axis] = spec.split(':');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}${axis ? ':' + axis : ''}&display=swap`;
    document.head.append(link);
  }

  // Puts a selection on the page: body classes plus any web fonts it needs.
  // `framed` = GuildScribe layout, which keeps its own colours.
  function apply(sel, { framed = false } = {}) {
    const body = document.body;
    [...body.classList].filter((c) => /^(theme|digits|ink)-/.test(c)).forEach((c) => body.classList.remove(c));
    const theme = framed ? 'classic' : sel.theme;
    if (theme !== 'classic') body.classList.add('theme-' + theme);
    body.classList.toggle('dark-board', !!CATALOG.theme.options[theme].dark);
    if (sel.digits !== 'standard') body.classList.add('digits-' + sel.digits);
    if (sel.ink !== 'plain') body.classList.add('ink-' + sel.ink);
    loadFont(CATALOG.theme.options[theme].font);
    loadFont(CATALOG.digits.options[sel.digits].font);
  }

  // ---------- Solve celebrations ----------
  // A full-screen canvas over the "Solved!" card for a few seconds.
  let running = null;
  function celebrate(kind, colors = []) {
    if (!kind || kind === 'none' || !CATALOG.celebrate.options[kind]) return;
    if (running) running.stop();
    const cv = document.createElement('canvas');
    cv.className = 'celebration';
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
    size();
    addEventListener('resize', size);
    const W = () => cv.width, H = () => cv.height;
    const palette = colors.filter(Boolean).concat(['#ffcf5c', '#8b93ff', '#4ade80', '#ff5c7a', '#5cd6ff', '#ff9f43']);
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const parts = [];
    const DURATION = kind === 'fireworks' ? 6500 : 5500;
    const start = performance.now();
    let last = start, spawnAcc = 0;

    const spawn = {
      confetti(n) {
        for (let i = 0; i < n; i++) parts.push({ x: rnd(0, W()), y: rnd(-H() * 0.2, -10), vx: rnd(-60, 60) * dpr, vy: rnd(120, 320) * dpr, r: rnd(0, 6.28), vr: rnd(-8, 8), w: rnd(6, 12) * dpr, h: rnd(10, 18) * dpr, c: pick(palette), life: 99 });
      },
      coins(n) {
        for (let i = 0; i < n; i++) parts.push({ x: rnd(0, W()), y: rnd(-H() * 0.3, -20), vx: rnd(-20, 20) * dpr, vy: rnd(200, 420) * dpr, r: rnd(0, 6.28), vr: rnd(3, 9), s: rnd(12, 22) * dpr, life: 99 });
      },
      burst() {
        const x = rnd(W() * 0.15, W() * 0.85), y = rnd(H() * 0.12, H() * 0.5), c = pick(palette), n = 70;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2, sp = rnd(160, 380) * dpr;
          parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, c, life: rnd(1.1, 1.8), max: 1.8, spark: true });
        }
      },
    };
    if (kind === 'confetti') spawn.confetti(160);
    if (kind === 'coins') spawn.coins(60);
    if (kind === 'fireworks') spawn.burst();

    let raf = 0;
    function frame(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now - start;
      const emitting = t < DURATION - 1800;
      if (emitting) {
        spawnAcc += dt;
        if (kind === 'confetti' && spawnAcc > 0.05) { spawn.confetti(6); spawnAcc = 0; }
        if (kind === 'coins' && spawnAcc > 0.08) { spawn.coins(3); spawnAcc = 0; }
        if (kind === 'fireworks' && spawnAcc > 0.55) { spawn.burst(); spawnAcc = 0; }
      }
      ctx.clearRect(0, 0, W(), H());
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.spark) {
          p.vx *= 0.985; p.vy = p.vy * 0.985 + 220 * dpr * dt; p.life -= dt;
        } else {
          p.vy += (kind === 'coins' ? 260 : 60) * dpr * dt; p.vx += Math.sin(t / 400 + i) * 8 * dpr * dt;
        }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.r !== undefined) p.r += p.vr * dt;
        if (p.life <= 0 || p.y > H() + 40) { parts.splice(i, 1); continue; }
        ctx.save();
        if (p.spark) {
          ctx.globalAlpha = Math.max(0, p.life / p.max);
          ctx.fillStyle = p.c;
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.6 * dpr, 0, 6.283); ctx.fill();
        } else if (kind === 'coins') {
          ctx.translate(p.x, p.y);
          ctx.scale(Math.abs(Math.cos(p.r)) * 0.9 + 0.1, 1);
          const g = ctx.createRadialGradient(-p.s * 0.3, -p.s * 0.3, p.s * 0.1, 0, 0, p.s);
          g.addColorStop(0, '#fff3b0'); g.addColorStop(0.5, '#f5c542'); g.addColorStop(1, '#a8740f');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(0, 0, p.s, 0, 6.283); ctx.fill();
          ctx.strokeStyle = 'rgba(120, 80, 10, 0.6)'; ctx.lineWidth = p.s * 0.12;
          ctx.beginPath(); ctx.arc(0, 0, p.s * 0.7, 0, 6.283); ctx.stroke();
        } else {
          ctx.translate(p.x, p.y); ctx.rotate(p.r);
          ctx.fillStyle = p.c;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 0.7)));
        }
        ctx.restore();
      }
      if (t < DURATION || parts.length) raf = requestAnimationFrame(frame);
      else stop();
    }
    function stop() {
      cancelAnimationFrame(raf);
      removeEventListener('resize', size);
      cv.remove();
      if (running && running.stop === stop) running = null;
    }
    running = { stop };
    raf = requestAnimationFrame(frame);
  }

  window.Cosmetics = { CATALOG, KINDS, DEFAULTS, normalize, isPaid, wantsPaid, allowed, apply, celebrate };
})();
