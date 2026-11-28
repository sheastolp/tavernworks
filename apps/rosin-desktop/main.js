// Rosin for Windows: Rosin alone on the desktop, with no box, talking in speech bubbles (buddy.html). Clicks
// pass through everywhere except on Rosin: click Rosin to open the app, drag Rosin to move it. The app is a
// normal, solid, resizable window with the full tavernworks.dev/rosin/ page and its controls; closing or
// minimising it, Esc, or the ▾ button goes back to just Rosin. The page in the app window is Rosin's brain and
// keeps running while hidden: Rosin speaks up on its own now and then. Tray icon and hotkeys too.
//
// The stream window ("Rosin – Stream", tray → Stream window for OBS, or ⋯ → Stream window): Rosin alone, with no
// buttons, menus or cards, for OBS Window Capture. It copies the app window as it goes (rosin/rosin-mirror.js), so
// the app can stay open with its menus while the stream shows only Rosin. Background: the dark grove, or green for
// OBS's Chroma Key. It keeps drawing while other windows cover it; minimising it would stop OBS seeing it.
//
// Hotkeys (anywhere in Windows):
//   Ctrl+Alt+R   show or hide Rosin
//   Ctrl+Alt+T   talk to Rosin (starts listening; press again to send)
//   Ctrl+Alt+Y   type to Rosin (opens the app and puts the cursor in the text box)
//
// The laptop key is entered once under ⋯ → Laptop key, the same as in a browser, and stays in this app's
// own storage on this PC.

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, session, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const HOST = "tavernworks.dev";
const START_URL = `https://${HOST}/rosin/?app=desktop&device=windows-app`;   // device: so Rosin fits its replies to the Windows app
const SIZES = { Small: [460, 700], Medium: [540, 820], Large: [680, 940] };
const MIN = [440, 620];        // room for the whole page: Rosin, the status line, the text box and every button
const BUDDY = [250, 340];      // just Rosin, with room above it for the speech bubble

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Windows: Chromium stops drawing a window it thinks is covered, which freezes it in OBS's Window Capture.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// ---------- settings, kept in %APPDATA%\Rosin\desktop.json ----------
const settingsFile = () => path.join(app.getPath("userData"), "desktop.json");
let settings = { onTop: false, buddy: true, size: "Medium", appBounds: null, buddyPos: null,
  stream: false, streamBg: "grove", streamSubs: true, streamBounds: null };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch {}
  delete settings.bounds; delete settings.buddyBounds;   // from 1.0.2's single see-through window
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {} }, 400);
}

let win = null;      // the app: the Rosin page, Rosin's brain
let buddy = null;    // just Rosin on the desktop
let streamWin = null; // Rosin alone for OBS (rosin-mirror.js)
let tray = null;
let quitting = false;
let hidden = false;  // "Hide Rosin": both windows away, still in the tray

const isRosinUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === HOST; } catch { return false; } };
// Spotify's sign-in (rosin/rosin-spotify.js) opens in Rosin's window, so it comes back to Rosin and not to a browser.
const isSpotifySignIn = (u) => { try { const x = new URL(u); return x.protocol === "https:" && (x.hostname === "spotify.com" || x.hostname.endsWith(".spotify.com")); } catch { return false; } };

const isRosinSpotifyAuthorize = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === "accounts.spotify.com" && /\/authorize\/?$/.test(x.pathname) && (x.searchParams.get("state") || "").startsWith("rosinw-"); } catch { return false; } };

// A Spotify sign-in that ended in a web browser (Spotify's "Continue with Google", say) comes back as
// rosin://spotify-callback?code=…&state=… (rosin/rosin-spotify.js handBack), and Rosin's page, which holds the
// sign-in's key, finishes it. Only code, state and error are passed on.
function registerLink() {
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE;   // the portable .exe, not the copy it runs from
    if (exe) app.setAsDefaultProtocolClient("rosin", exe, []);
    else if (!process.defaultApp) app.setAsDefaultProtocolClient("rosin");
  } catch {}
}
function spotifyCallbackUrl(argv) {
  const raw = (argv || []).find((a) => typeof a === "string" && a.toLowerCase().startsWith("rosin://spotify-callback"));
  if (!raw) return "";
  try {
    const q = new URL(raw).searchParams, state = q.get("state") || "";
    if (!/^rosin[aw]-[A-Za-z0-9_-]{8,64}$/.test(state)) return "";
    const out = new URL(START_URL);
    out.searchParams.set("state", state);
    for (const k of ["code", "error"]) if (q.get(k)) out.searchParams.set(k, q.get(k));
    return out.href;
  } catch { return ""; }
}
function finishSpotify(argv) {
  const url = spotifyCallbackUrl(argv);
  if (!url || !win || win.isDestroyed()) return false;
  win.loadURL(url);
  openApp();
  return true;
}

function onScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x + 60 > a.x && b.y + 30 > a.y && b.x + 60 < a.x + a.width && b.y + 30 < a.y + a.height);
}

function buddyBounds() {
  const p = settings.buddyPos;
  const b = p && { x: p.x, y: p.y, width: BUDDY[0], height: BUDDY[1] };
  if (onScreen(b)) return b;
  const a = screen.getPrimaryDisplay().workArea;
  return { width: BUDDY[0], height: BUDDY[1], x: a.x + a.width - BUDDY[0] - 16, y: a.y + a.height - BUDDY[1] - 8 };
}
/** Where the app opens: where it was last, else next to just-Rosin's spot, always fully on the screen. */
function appBounds() {
  const saved = settings.appBounds;
  if (saved && onScreen(saved) && saved.width >= MIN[0] && saved.height >= MIN[1]) return saved;
  const [w0, h0] = SIZES[settings.size] || SIZES.Medium;
  const b = buddyBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const w = Math.min(w0, a.width), h = Math.min(h0, a.height);
  const x = Math.min(Math.max(b.x + b.width - w, a.x), a.x + a.width - w);
  const y = Math.min(Math.max(b.y + b.height - h, a.y), a.y + a.height - h);
  return { x, y, width: w, height: h };
}

const icon = () => path.join(__dirname, "assets", "tray@2x.png");

function createWindows() {
  const b = appBounds();
  win = new BrowserWindow({
    ...b,
    minWidth: MIN[0], minHeight: MIN[1],
    show: false,
    backgroundColor: "#0d130b",
    autoHideMenuBar: true,
    alwaysOnTop: settings.onTop,
    title: "Rosin",
    icon: icon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      partition: "persist:rosin",
      backgroundThrottling: false,          // keep answering and chatting while hidden or behind other windows
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);

  const wc = win.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} RosinApp/Windows Rosin/${app.getVersion()}`);   // the version, shown at the bottom of ⋯
  wc.setWindowOpenHandler(({ url }) => { if (!isRosinUrl(url)) shell.openExternal(url); return { action: "deny" }; });
  // Rosin's Spotify sign-in runs in the PC's own browser, so "Continue with Google" works; Spotify's answer comes back
  // through rosin://spotify-callback (finishSpotify below).
  wc.on("will-navigate", (e, url) => {
    if (isRosinSpotifyAuthorize(url)) { e.preventDefault(); shell.openExternal(url); return; }
    if (!isRosinUrl(url) && !isSpotifySignIn(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  wc.on("dom-ready", () => wc.insertCSS(fs.readFileSync(path.join(__dirname, "desktop.css"), "utf8")));
  wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;   // -3 is an aborted load, not a failure
    const html = `<body style="margin:0;background:#0d130b;color:#f3dcc0;font:15px/1.5 system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center">
      <div style="padding:20px"><p style="font-size:18px;margin:0 0 6px">Rosin can't load right now.</p>
      <p style="opacity:.75;margin:0 0 16px">Check this PC's internet. It tries again by itself.<br><small>${String(desc).replace(/</g, "&lt;")}</small></p></div></body>`;
    wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(START_URL); }, 15000);
  });

  const remember = () => {
    if (win.isMinimized() || win.isMaximized() || !win.isVisible()) return;
    settings.appBounds = win.getBounds(); saveSettings();
  };
  win.on("moved", remember);
  win.on("resized", remember);
  // Closing or minimising the app goes back to just Rosin; Rosin keeps running (Quit is in the tray).
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); setBuddy(true); } });
  win.on("minimize", () => { if (!quitting) setTimeout(() => setBuddy(true), 0); });
  win.on("show", refreshTray);
  win.on("hide", refreshTray);
  win.loadURL(START_URL);

  // ---------- just Rosin ----------
  buddy = new BrowserWindow({
    ...buddyBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    focusable: false,          // clicking Rosin never takes the focus from what you're doing
    alwaysOnTop: true,
    show: false,
    title: "Rosin",
    icon: icon(),
    webPreferences: {
      preload: path.join(__dirname, "buddy-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  buddy.setAlwaysOnTop(true, "floating");
  buddy.setIgnoreMouseEvents(true, { forward: true });   // clicks go through, except on Rosin (see "over")
  buddy.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  buddy.webContents.on("will-navigate", (e) => e.preventDefault());
  buddy.on("close", (e) => { if (!quitting) { e.preventDefault(); buddy.hide(); } });
  buddy.loadFile(path.join(__dirname, "buddy.html"));
  buddy.once("ready-to-show", () => applyMode(false));
  buddy.on("move", aimEye);
  buddy.on("show", aimEye);
  for (const ev of ["display-metrics-changed", "display-added", "display-removed"]) screen.on(ev, aimEye);
}

/** Just Rosin's eye looks toward the middle of the screen it's on (buddy.js turns it). */
function aimEye() {
  if (!buddy || buddy.isDestroyed()) return;
  const b = buddy.getBounds(), a = screen.getDisplayMatching(b).workArea;
  // Rosin is 150 px square at the bottom middle of its window; the eye is a little right of and below its centre.
  const ex = b.x + b.width / 2 + 0.0748 * 150, ey = b.y + b.height - 6 - 150 + 0.5736 * 150;
  let x = (a.x + a.width / 2 - ex) / (a.width / 2), y = (a.y + a.height / 2 - ey) / (a.height / 2);
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  buddy.webContents.send("rosin-gaze", { x, y });
}

function page(js) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(js, true).catch(() => {});
}

// ---------- the stream window, for OBS ----------
const STREAM = [540, 720];
function streamUrl() {
  const u = new URL(START_URL);
  u.searchParams.set("view", "stream");
  if (settings.streamBg === "green") u.searchParams.set("bg", "green");
  if (!settings.streamSubs) u.searchParams.set("subs", "0");
  return u.href;
}
function streamBounds() {
  const s = settings.streamBounds;
  if (s && onScreen(s) && s.width >= 240 && s.height >= 300) return s;
  const a = screen.getPrimaryDisplay().workArea;
  return { width: STREAM[0], height: STREAM[1], x: a.x + 40, y: a.y + 40 };
}
function openStream(show = true) {
  if (streamWin && !streamWin.isDestroyed()) {
    if (show) { if (streamWin.isMinimized()) streamWin.restore(); streamWin.showInactive(); }
    return;
  }
  streamWin = new BrowserWindow({
    ...streamBounds(), minWidth: 240, minHeight: 300, show: false,
    title: "Rosin – Stream", icon: icon(), autoHideMenuBar: true,
    backgroundColor: settings.streamBg === "green" ? "#00b140" : "#0d130b",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: "persist:rosin",
      backgroundThrottling: false, spellcheck: false },
  });
  streamWin.setMenuBarVisibility(false);
  const wc = streamWin.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} RosinApp/Windows Rosin/${app.getVersion()}`);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, url) => { if (!isRosinUrl(url)) e.preventDefault(); });
  wc.on("page-title-updated", (e) => e.preventDefault());   // OBS finds it by this title
  wc.on("did-fail-load", (_e, code, _d, _u, isMain) => { if (isMain && code !== -3) setTimeout(() => { if (streamWin && !streamWin.isDestroyed()) streamWin.loadURL(streamUrl()); }, 15000); });
  const remember = () => { if (!streamWin.isMinimized() && streamWin.isVisible()) { settings.streamBounds = streamWin.getBounds(); saveSettings(); } };
  streamWin.on("moved", remember); streamWin.on("resized", remember);
  streamWin.on("close", (e) => { if (!quitting) { e.preventDefault(); streamWin.hide(); settings.stream = false; saveSettings(); refreshTray(); } });
  streamWin.once("ready-to-show", () => { if (settings.stream) streamWin.showInactive(); });
  streamWin.loadURL(streamUrl());
}
function setStream(on) {
  settings.stream = !!on; saveSettings();
  if (on) openStream(true); else if (streamWin && !streamWin.isDestroyed()) streamWin.hide();
  refreshTray();
}
function restyleStream() {
  saveSettings();
  if (streamWin && !streamWin.isDestroyed()) { streamWin.setBackgroundColor(settings.streamBg === "green" ? "#00b140" : "#0d130b"); streamWin.loadURL(streamUrl()); }
  refreshTray();
}

// ---------- just Rosin, or the app ----------
function applyMode(focus) {
  if (!win || !buddy || win.isDestroyed() || buddy.isDestroyed()) return;
  if (hidden) { win.hide(); buddy.hide(); refreshTray(); return; }
  if (settings.buddy) {
    win.hide();
    buddy.setBounds(buddyBounds());
    buddy.showInactive();
  } else {
    buddy.hide();
    if (win.isMinimized()) win.restore();
    if (focus) { win.show(); win.focus(); } else win.showInactive();
  }
  refreshTray();
}
function setBuddy(on, focus = true) {
  hidden = false;
  settings.buddy = !!on; saveSettings(); applyMode(focus);
}
function openApp() {
  setBuddy(false);
  page(`(() => { const b = document.getElementById("say-text"); if (b) b.focus(); return true; })()`);
}

const rosinShowing = () => !hidden && ((settings.buddy ? buddy : win)?.isVisible() || false);
function showRosin(focus = true) { hidden = false; applyMode(focus); }
function toggleRosin() { if (rosinShowing()) { hidden = true; applyMode(false); } else showRosin(); }

function talk() {
  if (!rosinShowing()) showRosin(false);
  page(`window.RosinBrain && window.RosinBrain.micStart(); true`);
}
function typeToRosin() { openApp(); }

function setSize(name) {
  settings.size = name;
  settings.appBounds = null;   // the app opens at this size
  const b = appBounds();
  win.setBounds(b);
  settings.appBounds = b;
  saveSettings(); refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const startup = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: rosinShowing() ? "Hide Rosin\tCtrl+Alt+R" : "Show Rosin\tCtrl+Alt+R", click: toggleRosin },
    { label: "Talk to Rosin\tCtrl+Alt+T", click: talk },
    { label: "Type to Rosin\tCtrl+Alt+Y", click: typeToRosin },
    { type: "separator" },
    { label: "Keep the app on top", type: "checkbox", checked: settings.onTop, click: (m) => {
        settings.onTop = m.checked; win.setAlwaysOnTop(m.checked, "floating"); saveSettings(); } },
    { label: "Open the app\tCtrl+Alt+Y", click: openApp },
    { label: "Just Rosin on the desktop", type: "checkbox", checked: !!settings.buddy, click: (m) => setBuddy(m.checked) },
    { type: "separator" },
    { label: "Stream window for OBS", type: "checkbox", checked: !!settings.stream, click: (m) => setStream(m.checked) },
    { label: "Stream background", submenu: [
        { label: "Dark grove", type: "radio", checked: settings.streamBg !== "green", click: () => { settings.streamBg = "grove"; restyleStream(); } },
        { label: "Green (for Chroma Key)", type: "radio", checked: settings.streamBg === "green", click: () => { settings.streamBg = "green"; restyleStream(); } },
      ] },
    { label: "Subtitles in the stream window", type: "checkbox", checked: settings.streamSubs !== false, click: (m) => { settings.streamSubs = m.checked; restyleStream(); } },
    { type: "separator" },
    { label: "App size", submenu: Object.keys(SIZES).map((n) => ({ label: n, type: "radio", checked: settings.size === n, click: () => setSize(n) })) },
    { label: "Start with Windows", type: "checkbox", checked: startup, click: (m) => {
        app.setLoginItemSettings({ openAtLogin: m.checked }); refreshTray(); } },
    { type: "separator" },
    { label: "Reload Rosin", click: () => { win.loadURL(START_URL); if (streamWin && !streamWin.isDestroyed()) streamWin.loadURL(streamUrl()); } },
    { label: "Open in browser", click: () => shell.openExternal(`https://${HOST}/rosin/`) },
    { type: "separator" },
    { label: "Quit Rosin", click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- what the app window's little bar asks for (preload.js) ----------
ipcMain.on("rosin-desktop", (e, what) => {
  if (!win || e.sender !== win.webContents) return;
  if (what === "pin") { settings.onTop = !settings.onTop; win.setAlwaysOnTop(settings.onTop, "floating"); saveSettings(); refreshTray(); }
  else if (what === "buddy") setBuddy(true);
  else if (what === "menu") buddyMenu();
  else if (what === "ready") greetSoon();
  else if (what === "stream") setStream(true);
});
ipcMain.handle("rosin-desktop-state", (e) => (win && e.sender === win.webContents ? { onTop: settings.onTop, buddy: settings.buddy } : null));

// What Rosin is doing (face, words, talking), from the page to just-Rosin on the desktop.
let lastState = {};
ipcMain.on("rosin-state", (e, s) => {
  if (!win || e.sender !== win.webContents || !s || typeof s !== "object") return;
  lastState = {
    face: String(s.face || "normal").slice(0, 20), subs: String(s.subs || "").slice(-600),
    talking: !!s.talking, thinking: !!s.thinking, busy: !!s.busy, listening: !!s.listening, heard: !!s.heard,
  };
  if (buddy && !buddy.isDestroyed()) buddy.webContents.send("rosin-state", lastState);
});

// ---------- just Rosin: right-click ----------
function buddyMenu() {
  Menu.buildFromTemplate([
    { label: "Open the app", click: openApp },
    { label: "Talk to Rosin", click: talk },
    { type: "separator" },
    { label: "Close Rosin (bring it back from the tray icon or Ctrl+Alt+R)", click: () => { hidden = true; applyMode(false); } },
    { label: "Quit Rosin", click: () => { quitting = true; app.quit(); } },
  ]).popup({ window: buddy });
}

// ---------- just Rosin: the mouse ----------
let dragFrom = null;
ipcMain.on("rosin-buddy", (e, what) => {
  if (!buddy || e.sender !== buddy.webContents) return;
  if (what === "ready") { buddy.webContents.send("rosin-state", lastState); aimEye(); }
  // take the mouse only while it's over Rosin, so clicks everywhere else reach the desktop
  else if (what === "over") buddy.setIgnoreMouseEvents(false);
  else if (what === "out") buddy.setIgnoreMouseEvents(true, { forward: true });
  else if (what === "drag-start") dragFrom = buddy.getPosition();
  else if (what === "drag-end") { dragFrom = null; const [x, y] = buddy.getPosition(); settings.buddyPos = { x, y }; saveSettings(); }
  else if (what === "open") openApp();
  else if (what === "menu") buddyMenu();
});
ipcMain.on("rosin-buddy-drag", (e, dx, dy) => {
  if (!buddy || e.sender !== buddy.webContents || !dragFrom) return;
  buddy.setPosition(Math.round(dragFrom[0] + dx), Math.round(dragFrom[1] + dy));
});

// ---------- Rosin speaks up by itself soon after starting, instead of waiting minutes ----------
let greeted = false;
function greetSoon() {
  if (greeted) return;
  let tries = 0;
  const check = () => {
    if (greeted || !win || win.isDestroyed()) return;
    page(`(document.getElementById("status")?.textContent || "").startsWith("Ready")`).then((ready) => {
      if (ready) {
        greeted = true;
        setTimeout(() => page(`window.RosinBrain && window.RosinBrain.settings.chatter && window.RosinBrain.chatterNow(); true`), 12000);
      } else if (++tries < 120) setTimeout(check, 5000);
    });
  };
  setTimeout(check, 3000);
}

app.on("second-instance", (_e, argv) => { if (!finishSpotify(argv)) openApp(); });   // opening Rosin again opens the app

app.whenReady().then(() => {
  app.setAppUserModelId("dev.tavernworks.rosin");
  loadSettings();

  // Only tavernworks.dev gets the microphone (for talking to Rosin), and nothing else is granted.
  const ses = session.fromPartition("persist:rosin");
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = isRosinUrl(details.requestingUrl || wc.getURL()) && (permission === "media" || permission === "speaker-selection");
    cb(ok && (!details.mediaTypes || details.mediaTypes.every((t) => t === "audio")));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) =>
    (permission === "media" || permission === "speaker-selection") && isRosinUrl(origin));

  registerLink();
  createWindows();
  if (settings.stream) openStream(true);
  finishSpotify(process.argv);   // started by the link itself

  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(__dirname, "assets", "tray@2x.png")) });
  tray = new Tray(icon);
  tray.setToolTip("Rosin");
  tray.on("click", toggleRosin);
  refreshTray();

  globalShortcut.register("CommandOrControl+Alt+R", toggleRosin);
  globalShortcut.register("CommandOrControl+Alt+T", talk);
  globalShortcut.register("CommandOrControl+Alt+Y", typeToRosin);
});

// ---------- for the automatic check on GitHub only: pictures of both windows, then quit ----------
if (process.env.ROSIN_SHOTS) app.whenReady().then(() => setTimeout(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const save = async (w, name) => fs.writeFileSync(path.join(process.env.ROSIN_SHOTS, name + ".png"), (await w.webContents.capturePage()).toPNG());
  try {
    buddy.webContents.send("rosin-state", { face: "happy", talking: true,
      subs: "Hey, it is me, Rosin. I sit on your desktop now, and this is my speech bubble." });
    await wait(1000); await save(buddy, "1-buddy");
    // Rosin facing the middle of the screen: up and to the left, then down and to the right.
    buddy.webContents.send("rosin-state", { face: "normal" });
    buddy.webContents.send("rosin-gaze", { x: -0.9, y: -0.4 }); await wait(1200); await save(buddy, "1b-buddy-up-left");
    buddy.webContents.send("rosin-gaze", { x: 0.9, y: 0.4 }); await wait(1200); await save(buddy, "1c-buddy-down-right");
    openApp(); await wait(3000); await save(win, "2-app");
    win.setBounds({ ...win.getBounds(), width: MIN[0], height: MIN[1] }); await wait(1500); await save(win, "3-app-smallest");
    await page(`document.getElementById("btn-more") && document.getElementById("btn-more").click(); true`);
    await wait(1000); await save(win, "4-app-more");
    setStream(true); await wait(6000);
    await page(`window.Rosin && (window.Rosin.setExpression("happy", 8000), window.Rosin.subs("This is the stream window. Only Rosin shows here."), window.Rosin.talking(true)); true`);
    await wait(1500); await save(streamWin, "5-stream");
    console.log("ROSIN-SHOTS-DONE", JSON.stringify({ app: win.getBounds(), buddy: buddy.getBounds(), buddyMode: settings.buddy, stream: streamWin && streamWin.getBounds() }));
  } catch (err) { console.log("ROSIN-SHOTS-FAILED", String(err)); }
  quitting = true; app.quit();
}, 25000));

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});   // lives in the tray until Quit
