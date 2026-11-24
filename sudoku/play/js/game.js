(() => {
  const ROWS = 'ABCDEFGHI';
  const params = new URLSearchParams(location.search);
  const cfg = {
    channel: (params.get('channel') || '').trim(),
    difficulty: (params.get('difficulty') || '').toLowerCase(), // 1-20 (or legacy easy/medium/hard/rotate)
    mode: (params.get('mode') || '').toLowerCase(), // auto (adapts to chat), fixed, or rotate (1 -> 20)
    variant: (params.get('variant') || 'mix').toLowerCase(), // classic, diagonal, windoku, centerdot, asterisk, or mix
    prefix: params.get('prefix') || '',
    hintAfter: num(params.get('hint'), 60), // seconds with no progress before a free cell is revealed (0 = off)
    cooldown: num(params.get('cooldown'), 3), // seconds a player waits after a wrong guess
    hintCooldown: num(params.get('hintcd'), 60), // seconds between chat !hint requests (shared by everyone)
    nextIn: num(params.get('next'), 45), // seconds between puzzles
    maxPerMsg: num(params.get('max'), 3), // moves accepted from a single chat message
    demo: params.get('demo') === '1',
    test: params.get('test') === '1',
    transparent: params.get('bg') === 'transparent',
    notes: params.get('notes') !== '0', // viewers can pencil in notes, e.g. B7?35
    frame: params.get('frame') === '1', // fills the Sudoku window of GuildScribe's full stream theme
    // One player in a browser: click/tap and type, no Twitch, no OBS. The offline zip's index.html sets SUDOKU_SOLO_ONLY.
    solo: params.get('solo') === '1' || window.SUDOKU_SOLO_ONLY === true,
    theme: (params.get('theme') || '').toLowerCase(), // starting colours if none chosen yet: indigo (the parchment board, default) or tavernworks
    window: params.get('window') !== '0', // media-player style window around the game
    embed: params.get('embed') === '1', // the demo inside tavernworks.dev/sudoku: the page around it explains how to play
  };
  if (cfg.solo) {
    // Solo play never touches Twitch, the control page or the theme's web font, so it works fully offline.
    cfg.channel = ''; cfg.demo = false; cfg.test = false; cfg.frame = false; cfg.prefix = ''; cfg.notes = true;
    cfg.window = false; // the stream window's menus drive the stream controls; solo has its own pad
    if (!params.has('hint')) cfg.hintAfter = 0; // no free hints unless asked for
    if (!params.has('cooldown')) cfg.cooldown = 0;
  }
  // Colours: the parchment board by default (stored as 'indigo', the name the control page uses for it).
  // View > Theme (here or on the control page) picks one and both pages remember it; ?theme= in the
  // link only sets the starting theme. GuildScribe's frame layout keeps its own look.
  const LS_THEME = 'numbersonstream.theme';
  let theme = (() => { try { return localStorage.getItem(LS_THEME); } catch { return null; } })() || cfg.theme;
  function applyTheme(t) {
    theme = t === 'tavernworks' ? 'tavernworks' : 'indigo';
    document.body.classList.toggle('tw', theme === 'tavernworks' && !cfg.frame);
  }
  applyTheme(theme);
  window.addEventListener('storage', (e) => { if (e.key === LS_THEME && e.newValue) applyTheme(e.newValue); });
  try {
    const logo = document.querySelector('.tw-logo');
    if (logo) document.getElementById('favicon').href = 'data:image/svg+xml,' + encodeURIComponent(logo.outerHTML.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'));
  } catch {}

  const POINTS = { correct: 10, unit: 5, finish: 10, wrong: -2 };
  const MAX = Sudoku.MAX_LEVEL;
  const MODES = ['auto', 'fixed', 'rotate'];
  // A channel-less demo (e.g. the preview on tavernworks.dev/sudoku) keeps its
  // own storage, so it never touches a real game's scores or the control page.
  const SANDBOX = cfg.demo && !cfg.channel;
  // Solo play keeps its own storage too, so it never mixes with the stream's scores or puzzle.
  const NS = cfg.solo ? 'numbersonstream.solo.' : SANDBOX ? 'numbersonstream.demo.' : 'numbersonstream.';
  const LS_ALL = NS + 'alltime';
  const LS_CUR = NS + 'current';
  const LS_CMD = NS + 'cmd';
  const LS_STATUS = NS + 'status';
  const LS_HEARTBEAT = NS + 'heartbeat';
  const LS_SETTINGS = NS + 'settings';
  const LS_PAUSED = NS + 'paused';
  const LS_RECORDS = NS + 'records'; // solo: puzzles solved and best times per level

  function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- Setup screen (no channel given) ----------
  if (!cfg.channel && !cfg.demo && !cfg.solo) {
    document.body.classList.add('setup-mode');
    const form = $('#setup-form');
    const out = $('#setup-url');
    const update = () => {
      const fd = new FormData(form);
      const u = new URL(location.href.split('?')[0]);
      for (const [k, v] of fd.entries()) if (v !== '') u.searchParams.set(k, v);
      if (!fd.get('bg')) u.searchParams.delete('bg');
      const look = fd.get('look') || '';
      u.searchParams.delete('look');
      if (look === 'plain') u.searchParams.set('window', '0');

      if (fd.get('notes')) u.searchParams.delete('notes'); else u.searchParams.set('notes', '0');
      const lv = +form.difficulty.value, mode = fd.get('mode');
      $('#setup-level-lbl').textContent = mode === 'auto' ? 'Starting difficulty:' : 'Difficulty:';
      $('#setup-level').textContent = mode === 'rotate' ? `Cycles 1 → ${MAX}` : `${lv} · ${Sudoku.LEVELS[lv].name}`;
      form.difficulty.disabled = mode === 'rotate';
      if (mode === 'rotate') u.searchParams.delete('difficulty');
      out.value = u.toString();
    };
    form.addEventListener('input', update);
    form.addEventListener('submit', (e) => { e.preventDefault(); update(); location.href = out.value; });
    $('#setup-copy').addEventListener('click', () => { update(); out.select(); navigator.clipboard?.writeText(out.value); });
    $('#setup-demo').addEventListener('click', () => { location.search = '?demo=1'; });
    $('#setup-solo').addEventListener('click', () => { location.search = '?solo=1'; });
    update();
    return;
  }

  if (cfg.transparent) document.body.classList.add('transparent');
  if (cfg.window && !cfg.frame) document.body.classList.add('windowed');
  if (!cfg.solo && !cfg.frame) document.body.classList.add('stream'); // the overlay; stacks on a phone
  if (cfg.embed) document.body.classList.add('embed');
  if (cfg.frame) {
    // Parchment-and-wood look with the theme's fonts (Cinzel headings); the board keeps its plain, high-contrast digits.
    document.body.classList.add('framed');
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&display=swap';
    document.head.append(font);
  }

  // ---------- State ----------
  let state = null; // { puzzle, solution, grid, owners, scores, level, variant, tech, mixIndex, round, startedAt, lastProgress }
  let allTime = store.get(LS_ALL, {});
  const cooldowns = new Map();
  let roundOver = false;
  let nextTimer = null;
  let nextElapsed = 0; // seconds the solved screen has been up (not counting time stopped)

  // ---------- Start / stop ----------
  // Stopped = chat moves and notes are ignored, and every timer (puzzle clock,
  // hint countdown, end-screen countdown) is frozen. Survives a page reload.
  let { paused = false, at: pausedAt = 0 } = store.get(LS_PAUSED, {}) || {};
  function setPaused(on) {
    if (on === paused) return;
    if (on) {
      paused = true; pausedAt = Date.now();
    } else {
      const gap = Date.now() - pausedAt;
      paused = false;
      // Shift the clocks forward so time spent stopped doesn't count.
      if (state) {
        const now = Date.now();
        state.startedAt = Math.min(state.startedAt + gap, now);
        state.lastProgress = Math.min(state.lastProgress + gap, now);
        save();
      }
    }
    store.set(LS_PAUSED, { paused, at: pausedAt });
    document.body.classList.toggle('paused', paused);
    feed({ type: 'system', text: paused ? 'Game paused' : 'Game on' });
  }

  // Live settings for upcoming puzzles. Start from the URL; the control page and
  // mod commands can change them. Saved overrides only apply while the URL is unchanged.
  // mode: 'auto' = next level follows how well chat answered, 'fixed', or 'rotate' = 1, 2 ... MAX, 1 ...
  const urlSig = `${cfg.mode}|${cfg.difficulty}|${cfg.variant}`;
  let urlChanged = false;
  const settings = (() => {
    const s = store.get(LS_SETTINGS, null);
    if (s && s.urlSig === urlSig && MODES.includes(s.mode)) return s;
    urlChanged = !!s;
    const legacyRotate = cfg.difficulty === 'rotate';
    const mode = MODES.includes(cfg.mode) ? cfg.mode : legacyRotate ? 'rotate' : cfg.difficulty ? 'fixed' : 'auto';
    const level = cfg.difficulty && !legacyRotate ? Sudoku.toLevel(cfg.difficulty) : 7;
    return { urlSig, mode, level, variant: validVariant(cfg.variant) ? cfg.variant : 'mix' };
  })();
  function validVariant(v) { return v === 'mix' || !!Sudoku.VARIANTS[v]; }
  function saveSettings() { store.set(LS_SETTINGS, settings); }
  // How long the solved screen shows: the control page / mods can override next=.
  const SOLVED_MIN = 3, SOLVED_MAX = 600;
  function clampSolved(n) { return Math.min(SOLVED_MAX, Math.max(SOLVED_MIN, Math.round(n))); }
  settings.urlNextIn = cfg.nextIn; // lets the control page show the URL default
  function solvedSecs() { return Number.isFinite(settings.nextIn) ? clampSolved(settings.nextIn) : cfg.nextIn; }
  function setSolvedTime(arg) {
    const a = String(arg).trim().toLowerCase();
    if (a === 'default' || a === 'reset') delete settings.nextIn;
    else {
      const n = parseFloat(a);
      if (!Number.isFinite(n)) return;
      settings.nextIn = clampSolved(n);
    }
    saveSettings();
    feed({ type: 'system', text: `Solved screen now shows for ${solvedSecs()}s` });
    if (roundOver) updateNextCountdown(); // apply to the screen showing right now
  }
  // Automatic hints (a free cell after a while with no progress): the control page and
  // "!sudoku autohints on|off" can switch them. Unset = follow the URL's hint= value.
  const HINT_DEFAULT = 60;
  settings.urlHintAfter = cfg.hintAfter; // lets the control page show the URL default
  function hintSecs() {
    if (settings.autoHints === false) return 0;
    if (settings.autoHints === true) return cfg.hintAfter > 0 ? cfg.hintAfter : HINT_DEFAULT;
    return cfg.hintAfter;
  }
  function setAutoHints(arg) {
    const a = String(arg).trim().toLowerCase();
    const wasOn = hintSecs() > 0;
    if (a === 'on' || a === '1' || a === 'true') settings.autoHints = true;
    else if (a === 'off' || a === '0' || a === 'false') settings.autoHints = false;
    else if (a === 'toggle' || a === '') settings.autoHints = !wasOn;
    else if (a === 'default' || a === 'reset') delete settings.autoHints;
    else return;
    saveSettings();
    const on = hintSecs() > 0;
    if (on && !wasOn && state) { state.lastProgress = Date.now(); save(); } // start a fresh countdown
    feed({ type: 'system', text: on ? `Automatic hints on (every ${hintSecs()}s without progress)` : 'Automatic hints off' });
    tick();
  }
  saveSettings();

  // Old saves stored 'easy'/'medium'/'hard'; map them onto the 1-20 scale.
  function levelOf(s) { return s ? Sudoku.toLevel(s.level ?? s.difficulty) : 0; }

  function nextLevel() {
    // A custom puzzle doesn't move the cycle: carry on from the level before it.
    if (settings.mode === 'rotate') return (levelOf(state && state.custom ? { level: state.baseLevel } : state) % MAX) + 1;
    return settings.level; // fixed, or auto (updated after every puzzle)
  }

  // ---------- Adaptive difficulty ----------
  // Judges chat on the puzzle just played: how many answers were right, and how
  // many cells had to be given away as hints. Returns the level change and why.
  function adaptiveStep(st, solved) {
    const answers = st.correct + st.wrong;
    const acc = answers ? st.correct / answers : 1;
    const hintShare = st.toFill ? st.hints / st.toFill : 0;
    const pct = `${Math.round(acc * 100)}% right`;
    const hints = st.hints ? `${st.hints} hint${st.hints === 1 ? '' : 's'}` : 'no hints';
    if (!solved) return { delta: -1, why: 'puzzle skipped' };
    if (!answers) return { delta: 0, why: 'no answers from chat' };
    let delta = 0;
    if (acc >= 0.9 && st.hints === 0) delta = 2;
    else if (acc >= 0.75 && hintShare <= 0.1) delta = 1;
    else if (acc < 0.5 || hintShare > 0.3) delta = -2;
    else if (acc < 0.65 || hintShare > 0.15) delta = -1;
    return { delta, why: `${pct}, ${hints}` };
  }

  function applyAdaptive(solved) {
    if (settings.mode !== 'auto' || !state || !state.stats || state.custom) return null; // custom puzzles don't count
    // A level picked by the streamer during this puzzle wins over the automatic step.
    if ((settings.setAt || 0) > state.startedAt) return null;
    const step = adaptiveStep(state.stats, solved);
    const from = state.level;
    settings.level = Math.min(MAX, Math.max(1, from + step.delta));
    saveSettings();
    return { ...step, from, to: settings.level };
  }

  function nextVariant() {
    if (settings.variant !== 'mix') return settings.variant;
    const order = Sudoku.VARIANT_ORDER;
    const at = state && Number.isInteger(state.mixIndex) ? state.mixIndex : -1;
    return { variant: order[(at + 1) % order.length], mixIndex: (at + 1) % order.length };
  }

  // "7", "diagonal", "diagonal 7", "hard windoku" ... -> { level, variant }
  function parseNewArgs(arg) {
    const out = {};
    for (const w of String(arg || '').toLowerCase().split(/\s+/).filter(Boolean)) {
      if (Sudoku.VARIANTS[w]) out.variant = w;
      else if (/^\d+$/.test(w) || ['easy', 'medium', 'hard', 'expert'].includes(w)) out.level = Sudoku.toLevel(w);
    }
    return out;
  }

  // ---------- Custom puzzles ----------
  // Sent from the control page as JSON { puzzle, variant, name, when: 'now' | 'next' },
  // or typed by a mod: "!sudoku custom [next] [diagonal] <81 digits, 0 or . for blanks>".
  if (!Array.isArray(settings.queue)) settings.queue = [];
  function readCustom(arg) {
    const a = String(arg || '').trim();
    if (a.startsWith('{')) { try { return JSON.parse(a); } catch { return null; } }
    const out = { when: 'now', variant: 'classic', puzzle: '' };
    for (const w of a.split(/\s+/).filter(Boolean)) {
      const lw = w.toLowerCase();
      if (lw === 'next' || lw === 'queue') out.when = 'next';
      else if (lw === 'now') out.when = 'now';
      else if (Sudoku.VARIANTS[lw] && !out.puzzle) out.variant = lw;
      else out.puzzle += w;
    }
    return out;
  }
  function checkCustom(c) {
    if (!c || typeof c !== 'object') return { error: 'Custom puzzle not understood' };
    const variant = Sudoku.VARIANTS[c.variant] ? c.variant : 'classic';
    const grid = Sudoku.parse(c.puzzle);
    if (!grid) return { error: 'Custom puzzle needs 81 cells (1-9, with 0 or . for blanks)' };
    const a = Sudoku.analyze(grid, variant);
    if (!a.ok) return { error: `Custom puzzle not used: ${a.error}` };
    const name = String(c.name || '').trim().slice(0, 40);
    return { puzzle: Sudoku.stringify(grid), variant, name, a };
  }
  function customLabel(c) { return c.name ? `"${c.name}"` : 'custom puzzle'; }
  function runCustom(arg) {
    const raw = readCustom(arg);
    const c = checkCustom(raw);
    if (c.error) { feed({ type: 'system', text: c.error }); return; }
    if (raw.when === 'next') {
      settings.queue.push({ puzzle: c.puzzle, variant: c.variant, name: c.name, id: raw.id || String(Date.now()) });
      saveSettings();
      feed({ type: 'system', text: `Queued ${customLabel(c)} (${settings.queue.length} waiting)` });
    } else newRound({ custom: c, skip: true });
  }

  function newRound(opts = {}) {
    // Skipping an unsolved puzzle in adaptive mode counts as "too hard".
    if (opts.skip && !roundOver && state && state.stats && !opts.level) {
      const a = applyAdaptive(false);
      if (a && a.to !== a.from) feed({ type: 'system', text: `Puzzle skipped: difficulty down to ${a.to}` });
    }
    clearInterval(nextTimer);
    roundOver = false;
    $('#overlay').classList.remove('show');
    // Queued custom puzzles go first, unless a specific level or type was asked for.
    let custom = opts.custom || null;
    while (!custom && !opts.level && !opts.variant && settings.queue.length) {
      const c = checkCustom(settings.queue.shift());
      saveSettings();
      if (c.error) feed({ type: 'system', text: c.error }); else custom = c;
    }
    const baseLevel = state ? (state.custom ? state.baseLevel : state.level) : undefined;
    let p, mixIndex = state ? state.mixIndex : undefined;
    if (custom) {
      p = { puzzle: custom.a.puzzle, solution: custom.a.solution, level: custom.a.level, variant: custom.variant, tech: custom.a.tech };
    } else {
      const level = opts.level || nextLevel();
      let variant = opts.variant;
      if (!variant) {
        const v = nextVariant();
        if (typeof v === 'string') variant = v; else ({ variant, mixIndex } = v);
      }
      p = Sudoku.generate(level, variant);
    }
    state = {
      puzzle: p.puzzle, solution: p.solution,
      grid: p.puzzle.slice(),
      notes: new Array(81).fill(0), // pencil marks: bit v set = note v
      example: -1, // empty cell that always shows its real notes as an on-screen example
      owners: new Array(81).fill(null),
      scores: {},
      level: p.level,
      variant: p.variant,
      tech: p.tech,
      mixIndex,
      custom: custom ? { name: custom.name } : null,
      baseLevel,
      stats: { correct: 0, wrong: 0, hints: 0, toFill: p.puzzle.filter((v) => !v).length },
      round: (state ? state.round : 0) + 1,
      startedAt: Date.now(),
      lastProgress: Date.now(),
    };
    if (paused) { pausedAt = Date.now(); store.set(LS_PAUSED, { paused, at: pausedAt }); }
    pickExample();
    save();
    renderAll();
    const geo = Sudoku.geometry(state.variant);
    const label = state.custom
      ? `${state.custom.name ? `custom puzzle "${state.custom.name}"` : 'custom puzzle'}${geo.key === 'classic' ? '' : ` (${geo.name})`}, about level ${state.level}`
      : `${geo.key === 'classic' ? '' : geo.name + ' '}puzzle (level ${state.level} · ${Sudoku.LEVELS[state.level].name})`;
    feed({ type: 'system', text: cfg.solo ? `Fresh ${label}. Pick a cell, then a number.` : `Fresh ${label} on the board. Type a cell and a number, like B7 4 or B74` });
    if (geo.rule) feed({ type: 'system', text: `Twist: ${geo.rule}` });
  }

  function save() { store.set(LS_CUR, state); store.set(LS_ALL, allTime); }

  // ---------- Colors ----------
  function hashHue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
  function readableColor(hex, name) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `hsl(${hashHue(name)} 80% 68%)`;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return `hsl(${Math.round(h)} ${Math.round(Math.max(s, 0.55) * 100)}% ${Math.round(Math.min(Math.max(l, 0.62), 0.8) * 100)}%)`;
  }

  // Player colors are bright for the dark side panel; on the light board use a
  // darker shade of the same hue so numbers stay high-contrast.
  function inkFor(color) {
    const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(color || '');
    if (!m) return color;
    const h = +m[1];
    const l = h >= 40 && h <= 190 ? 30 : 38; // yellows/greens need to be darker to read on white
    return `hsl(${h} ${Math.min(+m[2], 90)}% ${l}%)`;
  }

  // ---------- Chat parsing ----------
  // Accepts "B7 4", "b7=4", "B74", "!B7 4" and several moves per message.
  const MOVE_RE = /(?:^|[^A-Za-z0-9])([A-Ia-i])([1-9])\s*[=:\-]?\s*([1-9])(?![0-9])/g;

  // Notes: "B7?35" pencils in 3 and 5, "B7?-3" rubs out 3, "B7?x" (or "B7?0") clears the cell.
  // Several cells at once: "A1A3?678", "A1 A3?678" or "A1,A3?678" pencils 6, 7 and 8 into A1 and A3.
  const NOTE_RE = /(?:^|[^A-Za-z0-9])([A-Ia-i][1-9](?:[\s,]*[A-Ia-i][1-9])*)\s*\?\s*(-?)\s*([1-9](?:[\s,]*[1-9]){0,8}|[0xX])(?![0-9A-Za-z])/g;
  const NOTE_CELLS_MAX = 9; // cells per note group, e.g. a whole row

  function stripPrefix(text) {
    const t = text.trim();
    if (!cfg.prefix) return t;
    return t.toLowerCase().startsWith(cfg.prefix.toLowerCase()) ? t.slice(cfg.prefix.length) : null;
  }

  function parseNotes(text) {
    const t = stripPrefix(text);
    if (t === null || !cfg.notes) return [];
    const out = [];
    let groups = 0;
    for (const m of t.matchAll(NOTE_RE)) {
      const clear = /^[0x]$/i.test(m[3]);
      const mask = clear ? 0 : [...m[3].replace(/[^1-9]/g, '')].reduce((a, d) => a | (1 << +d), 0);
      const op = clear ? 'clear' : m[2] ? 'remove' : 'add';
      const cells = [...new Set([...m[1].matchAll(/([A-Ia-i])([1-9])/g)].map((c) => ROWS.indexOf(c[1].toUpperCase()) * 9 + (+c[2] - 1)))];
      for (const index of cells.slice(0, NOTE_CELLS_MAX)) out.push({ index, op, mask });
      if (++groups >= cfg.maxPerMsg) break;
    }
    return out;
  }

  function parseMoves(text) {
    const t = stripPrefix(text);
    if (t === null) return [];
    const moves = [];
    for (const m of t.matchAll(MOVE_RE)) {
      moves.push({ index: ROWS.indexOf(m[1].toUpperCase()) * 9 + (+m[2] - 1), value: +m[3], label: m[1].toUpperCase() + m[2] });
      if (moves.length >= cfg.maxPerMsg) break;
    }
    return moves;
  }

  function handleChat(msg) {
    const text = msg.text.trim();
    if (/^!sudoku\b/i.test(text)) return handleCommand(msg, text);
    if (roundOver || !state || paused) return;
    if (/^!hint$/i.test(text)) return chatHint(msg);
    const notes = parseNotes(text);
    if (notes.length) applyNotes(notes);
    const moves = parseMoves(text);
    if (!moves.length) { if (notes.length) save(); return; }
    const now = Date.now();
    if ((cooldowns.get(msg.user) || 0) > now) return;
    const player = { user: msg.user, name: msg.displayName, color: readableColor(msg.color, msg.user) };
    for (const mv of moves) {
      if (state.grid[mv.index]) continue; // already filled (given or solved)
      if (state.solution[mv.index] === mv.value) {
        correct(player, mv);
        if (roundOver) break;
      } else {
        wrong(player, mv);
        cooldowns.set(msg.user, now + cfg.cooldown * 1000);
        break;
      }
    }
    save();
  }

  function handleCommand(msg, text) {
    const [, sub = '', ...rest] = text.toLowerCase().split(/\s+/);
    const arg = rest.join(' ');
    if (sub === 'score' || sub === 'rank') return; // reserved; scores are always on screen
    if (!(msg.isMod || msg.isBroadcaster)) return;
    runCommand(sub, arg);
  }

  // Shared by mod chat commands, hotkeys and the control page.
  function runCommand(sub, arg) {
    if (sub === 'new' || sub === 'skip') newRound({ ...parseNewArgs(arg), skip: true });
    else if (sub === 'level' || sub === 'difficulty' || sub === 'mode') {
      // "12", "auto", "auto 8", "adaptive", "rotate", "fixed 10"
      const words = String(arg).trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return;
      let mode = null, level = null;
      for (const w of words) {
        if (w === 'auto' || w === 'adaptive') mode = 'auto';
        else if (w === 'rotate' || w === 'cycle') mode = 'rotate';
        else if (w === 'fixed') mode = 'fixed';
        else if (/^\d+$/.test(w) || ['easy', 'medium', 'hard', 'expert'].includes(w)) level = Sudoku.toLevel(w);
      }
      if (!mode && level === null) return;
      settings.mode = mode || (sub === 'mode' ? settings.mode : 'fixed');
      if (level !== null) settings.level = level;
      settings.setAt = Date.now();
      saveSettings();
      const name = `${settings.level} · ${Sudoku.LEVELS[settings.level].name}`;
      feed({ type: 'system', text: settings.mode === 'rotate' ? `Difficulty will cycle 1 → ${MAX}` : settings.mode === 'auto' ? `Adaptive difficulty on, next puzzle level ${name}` : `Next puzzles: level ${name}` });
    } else if (sub === 'variant') {
      const a = String(arg).trim().toLowerCase();
      if (!validVariant(a)) return;
      settings.variant = a;
      saveSettings();
      feed({ type: 'system', text: a === 'mix' ? 'Variants will mix it up' : `Next puzzles: ${Sudoku.VARIANTS[a].name}` });
    }
    else if (sub === 'stop' || sub === 'pause') setPaused(true);
    else if (sub === 'start' || sub === 'resume') setPaused(false);
    else if (sub === 'custom') runCustom(arg);
    else if (sub === 'clearqueue') { settings.queue = []; saveSettings(); feed({ type: 'system', text: 'Custom puzzle queue cleared' }); }
    else if (sub === 'unqueue') {
      const before = settings.queue.length;
      settings.queue = settings.queue.filter((q) => q.id !== String(arg).trim());
      if (settings.queue.length !== before) saveSettings();
    }
    else if (sub === 'hint') giveHint();
    else if (sub === 'solvedtime') setSolvedTime(arg);
    else if (sub === 'autohints' || sub === 'hints') setAutoHints(arg);
    else if (sub === 'resetscores') { allTime = {}; save(); renderBoards(); feed({ type: 'system', text: 'All-time scores reset' }); }
    else if (sub === 'clearnotes') { clearAllNotes(); feed({ type: 'system', text: 'All notes cleared' }); }
    else if (sub === 'resetround') {
      if (state) { state.scores = {}; save(); renderBoards(); feed({ type: 'system', text: 'Scores for this puzzle reset' }); }
    }
  }

  // ---------- Notes ----------
  // Shared by the whole chat; never scored or checked, just a scratchpad.
  function applyNotes(list) {
    for (const n of list) {
      if (state.grid[n.index] || n.index === state.example) continue; // the example cell's notes are automatic
      const before = state.notes[n.index];
      if (n.op === 'clear') state.notes[n.index] = 0;
      else if (n.op === 'remove') state.notes[n.index] &= ~n.mask;
      else state.notes[n.index] |= n.mask;
      if (state.notes[n.index] !== before) renderCell(n.index, 'noted');
    }
  }

  // When a cell is filled: wipe its notes and rub that number out of every cell it now rules out.
  function cleanNotes(i) {
    const v = state.grid[i];
    state.notes[i] = 0;
    for (const p of Sudoku.geometry(state.variant).peers[i]) {
      if (state.notes[p] & (1 << v)) { state.notes[p] &= ~(1 << v); renderCell(p); }
    }
  }

  // ---------- Notes example ----------
  // One empty cell always shows its real notes (every number that can still go
  // there), and the How to play panel shows the exact chat command for it.
  const digitsOf = (mask) => [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => mask & (1 << d));
  const cellLabel = (i) => ROWS[Sudoku.row(i)] + (Sudoku.col(i) + 1);

  function candidates(i) {
    let used = 0;
    for (const p of Sudoku.geometry(state.variant).peers[i]) used |= 1 << state.grid[p];
    return 0x3fe & ~used;
  }

  // Keep the current example while it's empty; otherwise pick a new one,
  // preferring 2-3 candidates so the example is short and easy to read.
  function pickExample() {
    if (!cfg.notes || cfg.solo) { state.example = -1; return; } // the example teaches chat; a solo player doesn't need it
    if (state.example >= 0 && !state.grid[state.example]) return;
    const empty = state.grid.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (!empty.length) { state.example = -1; return; }
    const nice = empty.filter((i) => { const k = digitsOf(candidates(i)).length; return k >= 2 && k <= 3; });
    const pool = nice.length ? nice : empty;
    state.example = pool[Math.floor(Math.random() * pool.length)];
    state.notes[state.example] = 0;
  }

  function renderExample() {
    const i = state.example;
    $('#note-ex').hidden = i < 0;
    if (i < 0) return;
    const ds = digitsOf(candidates(i));
    const lbl = cellLabel(i);
    $('#note-ex-cmd').textContent = `${cfg.prefix}${lbl}?${ds.join('')}`;
    $('#note-ex-what').textContent = ds.length === 1 ? `pencils in ${ds[0]}` : `pencils in ${ds.slice(0, -1).join(', ')} & ${ds[ds.length - 1]}`;
    $('#note-ex-cell').textContent = lbl;
  }

  // After any cell is filled: the example's notes may shrink, or the example
  // itself was filled and moves to another empty cell.
  function refreshExample() {
    const old = state.example;
    pickExample();
    if (old >= 0 && old !== state.example) renderCell(old);
    if (state.example >= 0) renderCell(state.example);
    renderExample();
  }

  function clearAllNotes() {
    if (!state) return;
    state.notes = new Array(81).fill(0);
    cells.forEach((_, i) => renderCell(i));
    save();
  }

  // ---------- Scoring ----------
  function addPoints(player, pts) {
    const r = (state.scores[player.user] ||= { name: player.name, color: player.color, points: 0, cells: 0 });
    const a = (allTime[player.user] ||= { name: player.name, color: player.color, points: 0, cells: 0, wins: 0 });
    r.name = a.name = player.name; r.color = a.color = player.color;
    r.points = Math.max(0, r.points + pts);
    a.points = Math.max(0, a.points + pts);
    if (pts > 0 && pts >= POINTS.correct) { r.cells++; a.cells++; }
  }

  // Regions (rows, columns, boxes and variant regions) through cell i that are now full.
  function fullUnits(i) {
    const geo = Sudoku.geometry(state.variant);
    return geo.cellUnits[i].map((u) => geo.units[u]).filter((u) => u.cells.every((j) => state.grid[j]));
  }
  function completedUnits(i) { return fullUnits(i).map((u) => u.label); }

  function correct(player, mv) {
    state.grid[mv.index] = mv.value;
    state.owners[mv.index] = { name: player.name, color: player.color };
    state.lastProgress = Date.now();
    cleanNotes(mv.index);
    refreshExample();
    if (state.stats) state.stats.correct++;
    let pts = POINTS.correct;
    const units = completedUnits(mv.index);
    pts += units.length * POINTS.unit;
    const finished = state.grid.every(Boolean);
    if (finished) pts += POINTS.finish;
    addPoints(player, pts);
    renderCell(mv.index, 'pop');
    if (units.length) flashUnits(mv.index, units.length);
    feed({ type: 'good', player, text: `${mv.label} = ${mv.value}`, pts, extra: units.length ? `completed ${units.join(' + ')}` : '' });
    renderBoards();
    if (finished) endRound();
  }

  function wrong(player, mv) {
    addPoints(player, POINTS.wrong);
    if (state.stats) state.stats.wrong++;
    const cell = cells[mv.index];
    cell.num.textContent = mv.value;
    cell.el.classList.remove('wrong'); void cell.el.offsetWidth; cell.el.classList.add('wrong');
    setTimeout(() => { cell.el.classList.remove('wrong'); renderCell(mv.index); }, 900);
    feed({ type: 'bad', player, text: `${mv.label} ≠ ${mv.value}`, pts: POINTS.wrong });
    renderBoards();
  }

  // askedBy: who used !hint in chat, if anyone. prefer: a cell to reveal (solo play's selected cell); otherwise a random empty one.
  function giveHint(askedBy, prefer) {
    if (roundOver || !state) return false;
    const empty = state.grid.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (!empty.length) return false;
    const i = Number.isInteger(prefer) && prefer >= 0 && !state.grid[prefer] ? prefer : empty[Math.floor(Math.random() * empty.length)];
    state.grid[i] = state.solution[i];
    state.owners[i] = { hint: true };
    state.lastProgress = Date.now();
    if (state.stats) state.stats.hints++;
    cleanNotes(i);
    refreshExample();
    renderCell(i, 'pop');
    feed({ type: 'system', text: `${askedBy ? `${askedBy} used !hint: ` : 'Hint: '}${ROWS[Sudoku.row(i)]}${Sudoku.col(i) + 1} = ${state.solution[i]}` });
    save();
    if (state.grid.every(Boolean)) endRound();
    return true;
  }

  // "!hint" from anyone in chat reveals a cell, then nobody can use it again for
  // cfg.hintCooldown seconds. Asking during the cooldown gets one "ready in" reply per cooldown.
  let chatHintReadyAt = 0, chatHintNagged = false;
  function chatHint(msg) {
    const now = Date.now();
    if (now < chatHintReadyAt) {
      if (!chatHintNagged) {
        chatHintNagged = true;
        feed({ type: 'system', text: `!hint is ready again in ${Math.ceil((chatHintReadyAt - now) / 1000)}s` });
      }
      return;
    }
    if (giveHint(msg.displayName || msg.user)) {
      chatHintReadyAt = now + Math.max(0, cfg.hintCooldown) * 1000;
      chatHintNagged = false;
    }
  }

  function ranked(obj) { return Object.entries(obj).map(([user, s]) => ({ user, ...s })).sort((a, b) => b.points - a.points || b.cells - a.cells); }

  function endRound() {
    roundOver = true;
    const adapt = applyAdaptive(true);
    const top = ranked(state.scores);
    if (top[0]) allTime[top[0].user].wins = (allTime[top[0].user].wins || 0) + 1;
    save();
    renderBoards();
    const secs = Math.round((Date.now() - state.startedAt) / 1000);
    const geo = Sudoku.geometry(state.variant);
    const what = state.custom ? `${state.custom.name || 'Custom puzzle'}${geo.key === 'classic' ? '' : ` · ${geo.name}`}` : `${geo.name} · level ${state.level}`;
    $('#ov-time').textContent = `${what} · solved in ${fmtTime(secs)} by ${top.length} player${top.length === 1 ? '' : 's'}`;
    const list = $('#ov-list'); list.replaceChildren();
    top.slice(0, 5).forEach((p, idx) => list.append(row(idx + 1, p.name, p.color, `${p.points} pts · ${p.cells} cells`)));
    $('#ov-mvp').textContent = top[0] ? top[0].name : 'Nobody. The hints finished it.';
    $('#ov-mvp').style.color = top[0] ? top[0].color : '';
    const nl = nextLevel();
    const arrow = adapt ? (adapt.delta > 0 ? `▲ up ${adapt.delta}` : adapt.delta < 0 ? `▼ down ${-adapt.delta}` : '● same') : '';
    const q = settings.queue[0];
    $('#ov-adapt').textContent = q ? `Next: ${q.name ? `"${q.name}"` : 'a custom puzzle'}` : `Next: level ${nl} · ${Sudoku.LEVELS[nl].name}` + (adapt ? ` · ${arrow} (${adapt.why})` : '');
    $('#ov-adapt').dataset.dir = adapt ? Math.sign(adapt.delta) : 0;
    if (adapt) feed({ type: 'system', text: `${cfg.solo ? 'You' : 'Chat'} got ${adapt.why}: next puzzle level ${nl}` });
    if (cfg.solo) { soloSolved(secs); $('#overlay').classList.add('show'); return; } // waits for "Next puzzle", no countdown
    $('#overlay').classList.add('show');
    nextElapsed = 0;
    updateNextCountdown();
    nextTimer = setInterval(() => {
      if (paused) return;
      nextElapsed++;
      updateNextCountdown();
    }, 1000);
  }

  function updateNextCountdown() {
    const left = solvedSecs() - nextElapsed;
    $('#ov-next').textContent = Math.max(0, left);
    if (left <= 0) newRound();
  }

  // ---------- Rendering ----------
  const cells = [];
  function buildBoard() {
    const board = $('#board');
    const corner = document.createElement('div'); corner.className = 'lbl'; board.append(corner);
    for (let c = 1; c <= 9; c++) { const l = document.createElement('div'); l.className = 'lbl col'; l.textContent = c; board.append(l); }
    for (let r = 0; r < 9; r++) {
      const l = document.createElement('div'); l.className = 'lbl row'; l.textContent = ROWS[r]; board.append(l);
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        const el = document.createElement('div');
        el.className = 'cell';
        if (c % 3 === 2 && c < 8) el.classList.add('br');
        if (r % 3 === 2 && r < 8) el.classList.add('bb');
        const numEl = document.createElement('span'); numEl.className = 'num';
        const who = document.createElement('span'); who.className = 'who';
        const coord = document.createElement('span'); coord.className = 'coord'; coord.textContent = ROWS[r] + (c + 1);
        const notesEl = document.createElement('div'); notesEl.className = 'notes';
        for (let d = 1; d <= 9; d++) { const s = document.createElement('span'); s.textContent = d; notesEl.append(s); }
        el.append(coord, notesEl, numEl, who);
        board.append(el);
        cells.push({ el, num: numEl, who, notes: notesEl });
      }
    }
  }

  function renderCell(i, anim) {
    const { el, num: n, who } = cells[i];
    const v = state.grid[i];
    const owner = state.owners[i];
    el.classList.toggle('given', !!state.puzzle[i]);
    el.classList.toggle('empty', !v);
    el.classList.toggle('hint', !!(owner && owner.hint));
    el.classList.toggle('claimed', !!(owner && !owner.hint));
    n.textContent = v || '';
    n.style.color = owner && !owner.hint ? inkFor(owner.color) : '';
    who.textContent = owner ? (owner.hint ? 'hint' : owner.name) : '';
    who.style.color = owner && !owner.hint ? inkFor(owner.color) : '';
    const isExample = !v && i === state.example;
    const mask = v ? 0 : isExample ? candidates(i) : (state.notes && state.notes[i]) || 0;
    el.classList.toggle('example', isExample);
    el.classList.toggle('has-notes', !!mask);
    [...cells[i].notes.children].forEach((s, k) => s.classList.toggle('on', !!(mask & (1 << (k + 1)))));
    if (anim) { el.classList.remove(anim); void el.offsetWidth; el.classList.add(anim); }
  }

  function flashUnits(i, count) {
    const hits = fullUnits(i).flatMap((u) => u.cells);
    for (const j of new Set(hits)) { const el = cells[j].el; el.classList.remove('unit'); void el.offsetWidth; el.classList.add('unit'); }
  }

  function row(rank, name, color, detail) {
    const li = document.createElement('li');
    const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = rank;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name; nm.style.color = color;
    const dt = document.createElement('span'); dt.className = 'dt'; dt.textContent = detail;
    li.append(rk, nm, dt);
    return li;
  }

  function renderBoards() {
    const r = $('#round-list'); r.replaceChildren();
    const rr = ranked(state.scores).slice(0, 5);
    rr.forEach((p, i) => r.append(row(i + 1, p.name, p.color, `${p.points}`)));
    if (!rr.length) r.append(Object.assign(document.createElement('li'), { className: 'empty-li', textContent: 'No points yet' }));
    const a = $('#all-list'); a.replaceChildren();
    const aa = ranked(allTime).slice(0, 5);
    aa.forEach((p, i) => a.append(row(i + 1, p.name, p.color, `${p.points}${p.wins ? ` · ${p.wins} ${p.wins === 1 ? 'win' : 'wins'}` : ''}`)));
    if (!aa.length) a.append(Object.assign(document.createElement('li'), { className: 'empty-li', textContent: '—' }));
  }

  function tier(level) { return level <= 6 ? 'easy' : level <= 11 ? 'medium' : level <= 16 ? 'hard' : 'expert'; }

  function renderAll() {
    const geo = Sudoku.geometry(state.variant);
    cells.forEach(({ el }) => el.classList.remove('x-diag', 'x-win', 'x-dot', 'x-star'));
    for (const u of geo.extra) for (const c of u.cells) cells[c].el.classList.add(u.cls);
    $('#board').dataset.variant = geo.key;
    cells.forEach((_, i) => renderCell(i));
    renderExample();
    $('#round-no').textContent = `Puzzle #${state.round}`;
    $('#difficulty').textContent = state.custom ? `★ ${state.custom.name || 'Custom'} · ~Lv ${state.level}` : `Lv ${state.level} · ${Sudoku.LEVELS[state.level].name}`;
    $('#difficulty').dataset.level = state.custom ? 'custom' : tier(state.level);
    $('#variant').textContent = geo.name;
    $('#variant').hidden = geo.key === 'classic';
    $('#rule').textContent = geo.rule;
    $('#rule').hidden = !geo.rule;
    renderBoards();
  }

  function feed(item) {
    const ul = $('#feed');
    const li = document.createElement('li');
    li.className = item.type;
    if (item.player) {
      const nm = document.createElement('b'); nm.textContent = item.player.name; nm.style.color = item.player.color;
      li.append(nm, ' ');
    }
    const t = document.createElement('span'); t.textContent = item.text; li.append(t);
    if (item.pts) { const p = document.createElement('em'); p.textContent = (item.pts > 0 ? ' +' : ' ') + item.pts; li.append(p); }
    if (item.extra) { const x = document.createElement('small'); x.textContent = ' ' + item.extra; li.append(x); }
    ul.prepend(li);
    while (ul.children.length > 8) ul.lastChild.remove();
  }

  function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

  // ---------- Window frame (title bar + menu bar buttons) ----------
  function renderWindow() {
    if (!state || !document.body.classList.contains('windowed')) return;
    const geo = Sudoku.geometry(state.variant);
    const what = state.custom ? `★ ${state.custom.name || 'Custom puzzle'}` : `Lv ${state.level} ${Sudoku.LEVELS[state.level].name}`;
    $('#gw-title').textContent = `Puzzle #${state.round} - ${what}${geo.key === 'classic' ? '' : ` (${geo.name})`} - Sudoku on Stream - Tavernworks`;
    $('.gw-tools [data-act=stop]').disabled = paused;
    const play = $('#gw-play'), want = paused ? 'play' : 'pause';
    if (play.dataset.showing !== want) {
      play.dataset.showing = want;
      play.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${want === 'play' ? 'M7 4.5v15l13-7.5z' : 'M6 4h4.5v16H6zM13.5 4H18v16h-4.5z'}"/></svg>`;
    }
  }

  let lastFrac = 1;
  function tick() {
    renderWindow();
    if (!state || paused) return;
    if (!roundOver) {
      const secs = Math.floor((Date.now() - state.startedAt) / 1000);
      $('#timer').textContent = fmtTime(secs);
      const filled = state.grid.filter(Boolean).length;
      const bar = $('#progress-bar');
      $('#remaining').textContent = `${81 - filled} left`;
      const hintAfter = hintSecs();
      if (hintAfter > 0) {
        // The bar is a countdown to the next free hint: full after a correct answer, empty when it drops.
        const idle = (Date.now() - state.lastProgress) / 1000;
        const frac = Math.max(0, Math.min(1, 1 - idle / hintAfter));
        const left = Math.ceil(hintAfter - idle);
        const refill = frac > lastFrac + 0.02; // jumped back up: snap rather than slide
        bar.classList.toggle('snap', refill);
        bar.style.width = `${frac * 100}%`;
        bar.dataset.level = frac > 0.5 ? 'ok' : frac > 0.2 ? 'low' : 'urgent';
        lastFrac = frac;
        $('#hint-in').textContent = left > 0 ? `hint in ${left}s` : '';
        if (left <= 0) giveHint();
      } else {
        bar.style.width = `${(filled / 81) * 100}%`;
        delete bar.dataset.level;
        $('#hint-in').textContent = '';
      }
    }
    if (cfg.solo) soloRender();
  }

  // ---------- Status ----------
  function setStatus(s, detail) {
    store.set(LS_STATUS, { text: statusText(s, detail), state: s });
    const el = $('#status');
    el.dataset.state = s;
    el.textContent = statusText(s, detail);
  }
  function statusText(s, detail) {
    return s === 'connected' ? `● reading #${detail}` : s === 'connecting' ? '○ connecting…' : s === 'demo' ? '● demo mode' : s === 'solo' ? '● solo play' : `○ disconnected — ${detail || ''}`;
  }

  // ---------- Control page link ----------
  // control.html sends commands through localStorage (storage event) and a
  // BroadcastChannel; both reach every page of the same origin in OBS.
  const seenCmds = new Set();
  function onControl(c) {
    if (!c || !c.id || seenCmds.has(c.id) || Date.now() - c.t > 10000) return;
    seenCmds.add(c.id);
    if (c.cmd === 'chat') handleChat({ user: 'streamer', displayName: c.name || 'Streamer', color: '#FFD700', isBroadcaster: true, isMod: true, text: String(c.arg || '') });
    else runCommand(c.cmd, c.arg || '');
  }
  if (!cfg.solo) {
    window.addEventListener('storage', (e) => { if (e.key === LS_CMD && e.newValue) { try { onControl(JSON.parse(e.newValue)); } catch {} } });
    if (!SANDBOX) try {
      new BroadcastChannel('numbersonstream').onmessage = (e) => {
        if (e.data && e.data.theme && !e.data.id) applyTheme(e.data.theme); else onControl(e.data);
      };
    } catch {}
    setInterval(() => store.set(LS_HEARTBEAT, Date.now()), 1000);
  }

  // ---------- Solo play (?solo=1) ----------
  // One player at the keyboard, mouse or touchscreen. Moves go through the same
  // rules as chat moves (checked against the solution, notes, hints, adaptive level).
  const SOLO_PLAYER = { user: 'you', displayName: 'You', color: '#3d7fd0' };
  let sel = -1; // selected cell
  let noteMode = false;
  const padBtns = [];

  function soloInit() {
    document.body.classList.add('solo');
    $('#solo').hidden = false;
    $('#solo-next').hidden = false;
    setStatus('solo');
    $('#pc-sub').textContent = 'The board is hidden. Press P or tap here to carry on.';
    $('#paused-card').addEventListener('click', () => setPaused(false));
    $('#ov-again').addEventListener('click', () => newRound());

    cells.forEach(({ el }, i) => el.addEventListener('click', () => { sel = i; soloRender(); }));
    for (let d = 1; d <= 9; d++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pad-d';
      const n = document.createElement('span'); n.textContent = d;
      const left = document.createElement('small');
      b.append(n, left);
      b.addEventListener('click', () => soloInput(d));
      $('#pad').append(b);
      padBtns.push({ b, left });
    }
    $('#pad-notes').addEventListener('click', () => { noteMode = !noteMode; soloRender(); });
    $('#pad-erase').addEventListener('click', soloErase);
    $('#pad-hint').addEventListener('click', () => { giveHint(null, sel); soloRender(); });
    $('#solo-pause').addEventListener('click', () => setPaused(!paused));

    // A finished-looking puzzle shouldn't vanish on one stray click.
    const fresh = $('#solo-new');
    let armed = null;
    fresh.addEventListener('click', () => {
      const played = state && state.stats && (state.stats.correct || state.stats.wrong || state.stats.hints);
      if (played && !armed && !roundOver) {
        fresh.textContent = 'Drop this one? Click again';
        armed = setTimeout(() => { armed = null; fresh.textContent = 'New puzzle'; }, 3000);
        return;
      }
      clearTimeout(armed); armed = null; fresh.textContent = 'New puzzle';
      newRound({ skip: true });
    });

    const lvl = $('#solo-level');
    lvl.append(new Option('Adaptive', 'auto'), new Option(`Cycle 1 → ${MAX}`, 'rotate'));
    for (let l = 1; l <= MAX; l++) lvl.append(new Option(`${l} · ${Sudoku.LEVELS[l].name}`, String(l)));
    lvl.addEventListener('change', () => {
      const v = lvl.value;
      runCommand('level', v === 'auto' ? `auto ${settings.level}` : v === 'rotate' ? 'rotate' : `fixed ${v}`);
      lvl.blur();
    });
    const vr = $('#solo-variant');
    vr.value = settings.variant;
    vr.addEventListener('change', () => { runCommand('variant', vr.value); vr.blur(); });
  }

  function soloInput(d) {
    if (sel < 0 || roundOver || paused || !state || state.grid[sel]) return;
    const label = cellLabel(sel);
    const has = state.notes[sel] & (1 << d);
    handleChat({ ...SOLO_PLAYER, text: noteMode ? `${label}?${has ? '-' : ''}${d}` : `${label} ${d}` });
    soloRender();
  }

  function soloErase() {
    if (sel < 0 || roundOver || paused || !state || state.grid[sel]) return;
    handleChat({ ...SOLO_PLAYER, text: `${cellLabel(sel)}?x` });
    soloRender();
  }

  function soloKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (roundOver) {
      if ((k === 'Enter' || k === ' ') && e.target.tagName !== 'BUTTON') { e.preventDefault(); newRound(); } // a focused button handles its own Enter
      return;
    }
    if (k === 'p' || k === 'P' || (paused && (k === 'Enter' || k === ' '))) { e.preventDefault(); setPaused(!paused); return; }
    if (paused) return;
    const shifted = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (/^[1-9]$/.test(k)) soloInput(+k);
    else if (shifted && e.shiftKey) { const was = noteMode; noteMode = true; soloInput(+shifted[1]); noteMode = was; }
    else if (k === 'Backspace' || k === 'Delete' || k === '0') soloErase();
    else if (k === 'n' || k === 'N') noteMode = !noteMode;
    else if (k === 'h' || k === 'H') giveHint(null, sel);
    else if (k === 'Escape') sel = -1;
    else if (k.startsWith('Arrow')) {
      if (sel < 0) sel = 40;
      else {
        let r = Sudoku.row(sel), c = Sudoku.col(sel);
        if (k === 'ArrowUp') r = (r + 8) % 9; else if (k === 'ArrowDown') r = (r + 1) % 9;
        else if (k === 'ArrowLeft') c = (c + 8) % 9; else if (k === 'ArrowRight') c = (c + 1) % 9;
        sel = r * 9 + c;
      }
    } else return;
    e.preventDefault();
    soloRender();
  }

  // Highlights, number pad and stats. Cheap, so it simply runs with every tick too.
  function soloRender() {
    if (!state) return;
    const v = sel >= 0 ? state.grid[sel] : 0;
    const peers = sel >= 0 ? new Set(Sudoku.geometry(state.variant).peers[sel]) : null;
    cells.forEach(({ el }, i) => {
      el.classList.toggle('sel', i === sel);
      el.classList.toggle('peer', !!peers && peers.has(i));
      el.classList.toggle('same', !!v && i !== sel && state.grid[i] === v);
    });
    const placed = new Array(10).fill(0);
    for (const x of state.grid) placed[x]++;
    padBtns.forEach(({ b, left }, k) => {
      const d = k + 1, n = 9 - placed[d];
      left.textContent = n > 0 ? n : '✓';
      b.classList.toggle('done', n <= 0);
      b.classList.toggle('noted', noteMode && sel >= 0 && !state.grid[sel] && !!(state.notes[sel] & (1 << d)));
    });
    const nb = $('#pad-notes');
    nb.classList.toggle('on', noteMode);
    nb.setAttribute('aria-pressed', noteMode);
    nb.lastElementChild.textContent = noteMode ? 'on' : 'off';
    $('#pad').classList.toggle('notes-on', noteMode);
    $('#solo-pause').textContent = paused ? 'Resume' : 'Pause';
    const st = state.stats || { wrong: 0, hints: 0 };
    $('#solo-mistakes').textContent = st.wrong;
    $('#solo-hints').textContent = st.hints;
    const rec = store.get(LS_RECORDS, { solved: 0, best: {} });
    const best = rec.best[state.level];
    $('#solo-best').textContent = best ? fmtTime(best) : '—';
    $('#solo-solved').textContent = rec.solved;
    const lvl = $('#solo-level');
    if (document.activeElement !== lvl) lvl.value = settings.mode === 'fixed' ? String(settings.level) : settings.mode;
    lvl.options[0].text = `Adaptive (now ${settings.level})`;
  }

  // Solved screen for one player: time, mistakes, hints and the best time at this level.
  // A best time only counts with no hints.
  function soloSolved(secs) {
    const rec = store.get(LS_RECORDS, { solved: 0, best: {} });
    const st = state.stats || { wrong: 0, hints: 0 };
    rec.solved = (rec.solved || 0) + 1;
    const prev = rec.best[state.level];
    const newBest = !st.hints && (!prev || secs < prev);
    if (newBest) rec.best[state.level] = secs;
    store.set(LS_RECORDS, rec);
    const geo = Sudoku.geometry(state.variant);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    $('#ov-time').textContent = `${geo.name} · level ${state.level} · ${fmtTime(secs)}`;
    $('#ov-solo').textContent = `${plural(st.wrong, 'mistake')} · ${plural(st.hints, 'hint')}` +
      (newBest ? ' · New best for this level!' : prev ? ` · Best here: ${fmtTime(prev)}` : '');
    sel = -1;
    soloRender();
    setTimeout(() => $('#ov-again').focus(), 50);
  }

  // ---------- Boot ----------
  document.body.classList.toggle('paused', paused);
  buildBoard();
  $('#how-prefix').textContent = cfg.prefix;
  $('#gw-ex').textContent = `${cfg.prefix}B7 4`;
  $('#how-prefix2').textContent = cfg.prefix;
  $('#how-prefix3').textContent = cfg.prefix;
  { const s = Math.max(0, cfg.hintCooldown); $('#how-hintcd').textContent = s === 60 ? 'once a minute' : s ? `once every ${s}s` : 'any time'; }
  document.querySelectorAll('.how-prefix-n').forEach((e) => { e.textContent = cfg.prefix; });
  $('#how-notes').hidden = !cfg.notes;
  const saved = store.get(LS_CUR, null);
  if (saved && saved.solution && saved.grid && !saved.grid.every(Boolean) && !urlChanged) {
    state = saved;
    state.level = levelOf(saved);
    state.variant = Sudoku.VARIANTS[saved.variant] ? saved.variant : 'classic';
    if (!Array.isArray(state.notes)) state.notes = new Array(81).fill(0);
    if (typeof state.example !== 'number') state.example = -1;
    pickExample();
    if (!state.stats) state.stats = { correct: 0, wrong: 0, hints: 0, toFill: state.puzzle.filter((v) => !v).length };
    state.lastProgress = Date.now();
    renderAll();
    feed({ type: 'system', text: 'Picked up where we left off' });
  } else {
    if (saved) state = { ...saved, level: levelOf(saved) }; // keep round counter/rotation position
    newRound();
  }
  if (cfg.solo) soloInit();
  setInterval(tick, 250);
  tick();

  // ---------- Window menus and player buttons (work like the control page's) ----------
  const menubar = $('#gw-menubar');
  function closeMenus() { menubar.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
  function markMenus() {
    const tick = (b, on) => { b.querySelector('.ic').textContent = on ? '✓' : ''; };
    menubar.querySelectorAll('[data-act=variant]').forEach((b) => tick(b, b.dataset.arg === settings.variant));
    menubar.querySelectorAll('[data-act=mode]').forEach((b) => tick(b, b.dataset.arg === settings.mode));
    menubar.querySelectorAll('[data-act=theme]').forEach((b) => tick(b, b.dataset.arg === theme));
    tick(menubar.querySelector('[data-act=testchat]'), !$('#test-input').hidden);
    tick(menubar.querySelector('[data-act=autohints]'), hintSecs() > 0);
    menubar.querySelector('[data-act=start]').disabled = !paused;
    menubar.querySelector('[data-act=stop]').disabled = paused;
    menubar.querySelector('[data-act=harder]').disabled = settings.mode === 'rotate' || settings.level >= MAX;
    menubar.querySelector('[data-act=easier]').disabled = settings.mode === 'rotate' || settings.level <= 1;
    $('#gm-level').textContent = settings.mode === 'rotate' ? '' : `· next: ${settings.level} ${Sudoku.LEVELS[settings.level].name}`;
  }
  function setTheme(t) {
    applyTheme(t);
    try { localStorage.setItem(LS_THEME, theme); } catch {}
    if (!SANDBOX) try { new BroadcastChannel('numbersonstream').postMessage({ theme }); } catch {}
  }
  function stepLevel(d) {
    const lv = Math.min(MAX, Math.max(1, settings.level + d));
    runCommand('level', `${settings.mode === 'auto' ? 'auto' : 'fixed'} ${lv}`);
  }
  const ACTIONS = {
    start: () => setPaused(false), stop: () => setPaused(true), playpause: () => setPaused(!paused),
    new: () => newRound({ skip: true }), hint: () => giveHint(), clearnotes: () => runCommand('clearnotes', ''),
    autohints: () => setAutoHints('toggle'),
    variant: (a) => runCommand('variant', a),
    mode: (a) => runCommand('mode', a === 'fixed' ? `fixed ${settings.level}` : a),
    harder: () => stepLevel(1), easier: () => stepLevel(-1),
    resetround: () => runCommand('resetround', ''), resetscores: () => runCommand('resetscores', ''),
    testchat: () => { const box = $('#test-input'); box.hidden = !box.hidden; if (!box.hidden) box.focus(); },
    theme: (a) => setTheme(a),
    href: (a) => window.open(a, '_blank', 'noopener'),
    control: () => window.open('control.html', '_blank'),
  };
  menubar.querySelectorAll('.menu').forEach((m) => {
    const top = m.querySelector('.top');
    top.addEventListener('click', (e) => { e.stopPropagation(); const was = m.classList.contains('open'); closeMenus(); if (!was) { markMenus(); m.classList.add('open'); } });
    top.addEventListener('mouseenter', () => { if (menubar.querySelector('.menu.open') && !m.classList.contains('open')) { closeMenus(); markMenus(); m.classList.add('open'); } });
  });
  document.querySelectorAll('#gwin [data-act]').forEach((b) => {
    let armTimer = null; const label = b.lastChild && b.lastChild.nodeType === 3 ? b.lastChild : null, original = label && label.textContent;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.hasAttribute('data-confirm') && !b.classList.contains('armed')) {
        b.classList.add('armed'); label.textContent = 'Click again to confirm';
        armTimer = setTimeout(() => { b.classList.remove('armed'); label.textContent = original; }, 3000);
        return;
      }
      if (armTimer) { clearTimeout(armTimer); b.classList.remove('armed'); label.textContent = original; }
      closeMenus();
      ACTIONS[b.dataset.act](b.dataset.arg);
      renderWindow();
    });
  });
  document.addEventListener('click', closeMenus);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
    if (e.altKey && !e.ctrlKey && !e.metaKey && document.body.classList.contains('windowed')) {
      const m = [...menubar.querySelectorAll('.menu')].find((x) => x.querySelector('u').textContent.toLowerCase() === e.key.toLowerCase());
      if (m) { e.preventDefault(); closeMenus(); markMenus(); m.classList.add('open'); }
      return;
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (cfg.solo) return soloKey(e);
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'n' || e.key === 'N') newRound({ skip: true });
    if (e.key === 'h' || e.key === 'H') giveHint();
    if (e.key === 'p' || e.key === 'P') setPaused(!paused);
  });

  if (cfg.channel) {
    TwitchChat.connect(cfg.channel, { onMessage: handleChat, onStatus: setStatus });
  }

  if (cfg.demo) {
    if (!cfg.channel) setStatus('demo');
    const bots = ['PixelPanda', 'grid_wizard', 'NineLives', 'boxbuster', 'Quokka42', 'ZenSolver', 'kettlecorn', 'MossyRock'];
    const colors = ['#FF4500', '#1E90FF', '#9ACD32', '#DAA520', '#8A2BE2', '#00FF7F', '#FF69B4', ''];
    setInterval(() => {
      if (roundOver || paused) return;
      const k = Math.floor(Math.random() * bots.length);
      const empty = state.grid.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      if (!empty.length) return;
      const i = empty[Math.floor(Math.random() * empty.length)];
      if (cfg.notes && Math.random() < 0.3) {
        const other = ((state.solution[i] + Math.floor(Math.random() * 8)) % 9) + 1;
        const ds = Math.random() < 0.5 ? `${state.solution[i]}${other}` : `${other}${state.solution[i]}`;
        handleChat({ user: bots[k].toLowerCase(), displayName: bots[k], color: colors[k], text: `${cfg.prefix}${ROWS[Sudoku.row(i)]}${Sudoku.col(i) + 1}?${ds}` });
        return;
      }
      const good = Math.random() < 0.75;
      const v = good ? state.solution[i] : ((state.solution[i] + Math.floor(Math.random() * 8)) % 9) + 1;
      const variants = [`${ROWS[Sudoku.row(i)]}${Sudoku.col(i) + 1} ${v}`, `${ROWS[Sudoku.row(i)].toLowerCase()}${Sudoku.col(i) + 1}=${v}`, `ok ${ROWS[Sudoku.row(i)]}${Sudoku.col(i) + 1} ${v} i think`];
      handleChat({ user: bots[k].toLowerCase(), displayName: bots[k], color: colors[k], text: cfg.prefix + variants[Math.floor(Math.random() * variants.length)] });
    }, 900);
  }

  {
    // Test box: shown with ?test=1, or from the window's Chat menu.
    const box = $('#test-input');
    box.hidden = !cfg.test;
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !box.value.trim()) return;
      handleChat({ user: 'streamer', displayName: 'Streamer', color: '#FFD700', isBroadcaster: true, isMod: true, text: box.value });
      box.value = '';
    });
  }

  window.__sudokuOnStream = { handleChat, get state() { return state; }, get paused() { return paused; }, setPaused, parseMoves, parseNotes, newRound, giveHint };
})();
