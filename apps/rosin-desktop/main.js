// Rosin for Windows: tavernworks.dev/rosin/ in a floating, frameless, see-through window that stays on top,
// with a tray icon and a few hotkeys. Rosin keeps talking while the window is hidden or behind other windows.
//
// Hotkeys (anywhere in Windows):
//   Ctrl+Alt+R   show or hide Rosin
//   Ctrl+Alt+T   talk to Rosin (starts listening; press again to send)
//   Ctrl+Alt+Y   type to Rosin (shows Rosin and puts the cursor in the text box)
//
// The laptop key is entered once under ⋯ → Laptop key, the same as in a browser, and stays in this app's
// own storage on this PC.

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, session, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const HOST = "tavernworks.dev";
const START_URL = `https://${HOST}/rosin/?app=desktop&device=windows-app`;   // device: so Rosin fits its replies to the Windows app
const SIZES = { Small: [300, 440], Medium: [400, 600], Large: [560, 820] };

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- settings, kept in %APPDATA%\Rosin\desktop.json ----------
const settingsFile = () => path.join(app.getPath("userData"), "desktop.json");
let settings = { onTop: true, compact: false, size: "Medium", bounds: null };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch {}
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {} }, 400);
}

let win = null;
let tray = null;
let quitting = false;

const isRosinUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === HOST; } catch { return false; } };

function onScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x + 60 > a.x && b.y + 30 > a.y && b.x + 60 < a.x + a.width && b.y + 30 < a.y + a.height);
}

function createWindow() {
  const [w, h] = SIZES[settings.size] || SIZES.Medium;
  const b = onScreen(settings.bounds) ? settings.bounds : null;
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: b ? b.width : w,
    height: b ? b.height : h,
    x: b ? b.x : area.x + area.width - w - 24,
    y: b ? b.y : area.y + area.height - h - 24,
    minWidth: 220, minHeight: 300,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: settings.onTop,
    resizable: true,
    show: false,
    title: "Rosin",
    icon: path.join(__dirname, "assets", "tray@2x.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      partition: "persist:rosin",
      backgroundThrottling: false,          // keep answering while hidden or behind other windows
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: false,
    },
  });
  if (settings.onTop) win.setAlwaysOnTop(true, "floating");

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (!isRosinUrl(url)) shell.openExternal(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (!isRosinUrl(url)) { e.preventDefault(); shell.openExternal(url); } });
  wc.on("dom-ready", () => {
    wc.insertCSS(fs.readFileSync(path.join(__dirname, "desktop.css"), "utf8"));
    applyCompact();
  });
  wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;   // -3 is an aborted load, not a failure
    const html = `<body style="margin:0;background:rgba(13,19,11,.92);color:#f3dcc0;font:15px/1.5 system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center;-webkit-app-region:drag;border-radius:18px">
      <div style="padding:20px"><p style="font-size:18px;margin:0 0 6px">Rosin can't load right now.</p>
      <p style="opacity:.75;margin:0 0 16px">Check this PC's internet. It tries again by itself.<br><small>${String(desc).replace(/</g, "&lt;")}</small></p></div></body>`;
    wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(START_URL); }, 15000);
  });

  win.once("ready-to-show", () => win.show());
  const remember = () => { if (!win.isMinimized()) { settings.bounds = win.getBounds(); saveSettings(); } };
  win.on("moved", remember);
  win.on("resized", remember);
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); refreshTray(); } });
  win.on("show", refreshTray);
  win.on("hide", refreshTray);

  win.loadURL(START_URL);
}

function page(js) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(js, true).catch(() => {});
}

function applyCompact() {
  page(`document.body.classList.toggle("hide-ui", ${!!settings.compact}); window.Rosin && window.Rosin.fit && window.Rosin.fit(); true`);
}

function showRosin(focus = true) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (focus) win.focus();
}
function toggleRosin() { if (win.isVisible() && !win.isMinimized()) win.hide(); else showRosin(); }

function talk() {
  showRosin(false);
  page(`window.RosinBrain && window.RosinBrain.micStart(); true`);
}
function typeToRosin() {
  if (settings.compact) { settings.compact = false; saveSettings(); applyCompact(); }
  showRosin(true);
  page(`(() => { const b = document.getElementById("say-text"); if (b) b.focus(); return true; })()`);
  refreshTray();
}

function setSize(name) {
  const [w, h] = SIZES[name];
  const b = win.getBounds();
  settings.size = name;
  win.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });   // keep the bottom-right corner put
  settings.bounds = win.getBounds();
  saveSettings(); refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const startup = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? "Hide Rosin\tCtrl+Alt+R" : "Show Rosin\tCtrl+Alt+R", click: toggleRosin },
    { label: "Talk to Rosin\tCtrl+Alt+T", click: talk },
    { label: "Type to Rosin\tCtrl+Alt+Y", click: typeToRosin },
    { type: "separator" },
    { label: "Always on top", type: "checkbox", checked: settings.onTop, click: (m) => {
        settings.onTop = m.checked; win.setAlwaysOnTop(m.checked, "floating"); saveSettings(); } },
    { label: "Hide the controls (just Rosin)", type: "checkbox", checked: settings.compact, click: (m) => {
        settings.compact = m.checked; saveSettings(); applyCompact(); } },
    { label: "Size", submenu: Object.keys(SIZES).map((n) => ({ label: n, type: "radio", checked: settings.size === n, click: () => setSize(n) })) },
    { label: "Start with Windows", type: "checkbox", checked: startup, click: (m) => {
        app.setLoginItemSettings({ openAtLogin: m.checked }); refreshTray(); } },
    { type: "separator" },
    { label: "Reload Rosin", click: () => win.loadURL(START_URL) },
    { label: "Open in browser", click: () => shell.openExternal(`https://${HOST}/rosin/`) },
    { type: "separator" },
    { label: "Quit Rosin", click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- what the page's little window bar asks for (preload.js) ----------
ipcMain.on("rosin-desktop", (e, what) => {
  if (!win || e.sender !== win.webContents) return;
  if (what === "hide") win.hide();
  else if (what === "pin") { settings.onTop = !settings.onTop; win.setAlwaysOnTop(settings.onTop, "floating"); saveSettings(); refreshTray(); }
  else if (what === "compact") { settings.compact = !settings.compact; saveSettings(); applyCompact(); refreshTray(); }
  else if (what === "menu") tray && tray.popUpContextMenu();
});
ipcMain.handle("rosin-desktop-state", (e) => (win && e.sender === win.webContents ? { onTop: settings.onTop, compact: settings.compact } : null));

app.on("second-instance", () => showRosin());

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

  createWindow();

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

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});   // lives in the tray until Quit
