// Rosin for Windows: Rosin alone on the desktop, with no box, talking in speech bubbles (buddy.html). Clicks
// pass through everywhere except on Rosin: click Rosin to open the app, drag Rosin to move it. The app is a
// normal, solid, resizable window with the full tavernworks.dev/rosin/ page and its controls; closing or
// minimising it, Esc, or the ▾ button goes back to just Rosin. The page in the app window is Rosin's brain and
// keeps running while hidden: Rosin speaks up on its own now and then. Tray icon and hotkeys too.
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

// ---------- settings, kept in %APPDATA%\Rosin\desktop.json ----------
const settingsFile = () => path.join(app.getPath("userData"), "desktop.json");
let settings = { onTop: false, buddy: true, size: "Medium", appBounds: null, buddyPos: null };
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
let tray = null;
let quitting = false;
let hidden = false;  // "Hide Rosin": both windows away, still in the tray

const isRosinUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === HOST; } catch { return false; } };

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
  wc.setWindowOpenHandler(({ url }) => { if (!isRosinUrl(url)) shell.openExternal(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (!isRosinUrl(url)) { e.preventDefault(); shell.openExternal(url); } });
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
}

function page(js) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(js, true).catch(() => {});
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
    { label: "App size", submenu: Object.keys(SIZES).map((n) => ({ label: n, type: "radio", checked: settings.size === n, click: () => setSize(n) })) },
    { label: "Start with Windows", type: "checkbox", checked: startup, click: (m) => {
        app.setLoginItemSettings({ openAtLogin: m.checked }); refreshTray(); } },
    { type: "separator" },
    { label: "Reload Rosin", click: () => win.loadURL(START_URL) },
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
  else if (what === "menu") tray && tray.popUpContextMenu();
  else if (what === "ready") greetSoon();
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

// ---------- just Rosin: the mouse ----------
let dragFrom = null;
ipcMain.on("rosin-buddy", (e, what) => {
  if (!buddy || e.sender !== buddy.webContents) return;
  if (what === "ready") buddy.webContents.send("rosin-state", lastState);
  // take the mouse only while it's over Rosin, so clicks everywhere else reach the desktop
  else if (what === "over") buddy.setIgnoreMouseEvents(false);
  else if (what === "out") buddy.setIgnoreMouseEvents(true, { forward: true });
  else if (what === "drag-start") dragFrom = buddy.getPosition();
  else if (what === "drag-end") { dragFrom = null; const [x, y] = buddy.getPosition(); settings.buddyPos = { x, y }; saveSettings(); }
  else if (what === "open") openApp();
  else if (what === "menu") tray && tray.popUpContextMenu();
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

app.on("second-instance", () => openApp());   // opening Rosin again opens the app

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

  createWindows();

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
    openApp(); await wait(3000); await save(win, "2-app");
    win.setBounds({ ...win.getBounds(), width: MIN[0], height: MIN[1] }); await wait(1500); await save(win, "3-app-smallest");
    await page(`document.getElementById("btn-more") && document.getElementById("btn-more").click(); true`);
    await wait(1000); await save(win, "4-app-more");
    console.log("ROSIN-SHOTS-DONE", JSON.stringify({ app: win.getBounds(), buddy: buddy.getBounds(), buddyMode: settings.buddy }));
  } catch (err) { console.log("ROSIN-SHOTS-FAILED", String(err)); }
  quitting = true; app.quit();
}, 25000));

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});   // lives in the tray until Quit
