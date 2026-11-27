// Rosin for Windows: Rosin alone on the desktop, with no box, talking in speech bubbles. Clicks pass through
// everywhere except on Rosin: click Rosin to open the app (the full tavernworks.dev/rosin/ page with its
// controls), drag Rosin to move it. Esc, the ▾ button or clicking away goes back to just Rosin. Rosin speaks
// up on its own now and then, and keeps going while hidden or behind other windows. Tray icon and hotkeys too.
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
const SIZES = { Small: [300, 440], Medium: [400, 600], Large: [560, 820] };

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- settings, kept in %APPDATA%\Rosin\desktop.json ----------
const settingsFile = () => path.join(app.getPath("userData"), "desktop.json");
let settings = { onTop: true, buddy: true, size: "Medium", bounds: null, buddyBounds: null };
const BUDDY = [260, 460];   // just Rosin: about 9:16, with room above Rosin for the speech bubble
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

function buddyBounds() {
  if (onScreen(settings.buddyBounds)) return settings.buddyBounds;
  const a = screen.getPrimaryDisplay().workArea;
  return { width: BUDDY[0], height: BUDDY[1], x: a.x + a.width - BUDDY[0] - 16, y: a.y + a.height - BUDDY[1] - 8 };
}
/** The app opens over just-Rosin's spot, bottom-right corners lined up, kept on the screen. */
function appBounds() {
  const [w0, h0] = SIZES[settings.size] || SIZES.Medium;
  const w = settings.bounds?.width || w0, h = settings.bounds?.height || h0;
  const b = buddyBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(b.x + b.width - w, a.x), a.x + a.width - w);
  const y = Math.min(Math.max(b.y + b.height - h, a.y), a.y + a.height - h);
  return { x, y, width: w, height: h };
}

function createWindow() {
  const b = settings.buddy ? buddyBounds() : appBounds();
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 180, minHeight: 300,
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
    applyMode(false);
  });
  wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;   // -3 is an aborted load, not a failure
    const html = `<body style="margin:0;background:rgba(13,19,11,.92);color:#f3dcc0;font:15px/1.5 system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center;-webkit-app-region:drag;border-radius:18px">
      <div style="padding:20px"><p style="font-size:18px;margin:0 0 6px">Rosin can't load right now.</p>
      <p style="opacity:.75;margin:0 0 16px">Check this PC's internet. It tries again by itself.<br><small>${String(desc).replace(/</g, "&lt;")}</small></p></div></body>`;
    wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(START_URL); }, 15000);
  });

  win.once("ready-to-show", () => win.showInactive());
  const remember = () => {
    if (win.isMinimized() || moving) return;
    if (settings.buddy) settings.buddyBounds = win.getBounds(); else settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on("moved", remember);
  win.on("resized", remember);
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); refreshTray(); } });
  win.on("show", refreshTray);
  // Clicking away from the app (with nothing typed and not listening) goes back to just Rosin.
  win.on("blur", () => {
    if (settings.buddy) return;
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.isFocused() || settings.buddy) return;
      page(`(() => { const b = document.getElementById("say-text"); const m = document.getElementById("mic");
                     return !(b && b.value.trim()) && !(m && m.classList.contains("live")); })()`)
        .then((ok) => { if (ok && !win.isFocused()) setBuddy(true); });
    }, 600);
  });
  win.on("hide", refreshTray);

  win.loadURL(START_URL);
}

function page(js) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(js, true).catch(() => {});
}

// ---------- just Rosin, or the app ----------
let moving = false;
function applyMode(focus) {
  if (!win || win.isDestroyed()) return;
  const b = !!settings.buddy;
  win.webContents.send("rosin-mode", b);
  page(`document.documentElement.classList.toggle("buddy", ${b}); document.body.classList.toggle("hide-ui", ${b});
        window.Rosin && window.Rosin.fit && window.Rosin.fit(); true`);
  win.setIgnoreMouseEvents(b, { forward: true });   // just Rosin: clicks go through, except on Rosin (see "over")
  win.setResizable(!b);
  moving = true;
  win.setBounds(b ? buddyBounds() : appBounds());
  moving = false;
  if (!b && focus) { win.show(); win.focus(); }
  setTimeout(() => page(`window.Rosin && window.Rosin.fit && window.Rosin.fit(); true`), 60);
  refreshTray();
}
function setBuddy(on, focus = true) {
  if (!!settings.buddy === !!on) { if (!on && focus) { win.show(); win.focus(); } return; }
  settings.buddy = !!on; saveSettings(); applyMode(focus);
}
function openApp() {
  setBuddy(false);
  page(`(() => { const b = document.getElementById("say-text"); if (b) b.focus(); return true; })()`);
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
  showRosin(true);
  openApp();
}

function setSize(name) {
  settings.size = name;
  settings.bounds = null;   // the app opens at this size next time
  if (!settings.buddy) { moving = true; win.setBounds(appBounds()); moving = false; settings.bounds = win.getBounds(); }
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
    { label: "Open the app\tCtrl+Alt+Y", click: () => { showRosin(true); openApp(); } },
    { label: "Just Rosin on the desktop", type: "checkbox", checked: !!settings.buddy, click: (m) => { showRosin(false); setBuddy(m.checked); } },
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

// ---------- what the page's little window bar asks for (preload.js) ----------
ipcMain.on("rosin-desktop", (e, what) => {
  if (!win || e.sender !== win.webContents) return;
  if (what === "hide") win.hide();
  else if (what === "pin") { settings.onTop = !settings.onTop; win.setAlwaysOnTop(settings.onTop, "floating"); saveSettings(); refreshTray(); }
  else if (what === "buddy") setBuddy(true);
  else if (what === "open") openApp();
  else if (what === "menu") tray && tray.popUpContextMenu();
  else if (what === "ready") { win.webContents.send("rosin-mode", !!settings.buddy); greetSoon(); }
  // just Rosin: take the mouse only while it's over Rosin, so clicks everywhere else reach the desktop
  else if (what === "over") { if (settings.buddy) win.setIgnoreMouseEvents(false); }
  else if (what === "out") { if (settings.buddy) win.setIgnoreMouseEvents(true, { forward: true }); }
  else if (what === "drag-start") dragFrom = win.getPosition();
  else if (what === "drag-end") { dragFrom = null; settings.buddyBounds = win.getBounds(); saveSettings(); }
});
let dragFrom = null;
ipcMain.on("rosin-desktop-drag", (e, dx, dy) => {
  if (!win || e.sender !== win.webContents || !dragFrom || !settings.buddy) return;
  win.setPosition(Math.round(dragFrom[0] + dx), Math.round(dragFrom[1] + dy));
});
ipcMain.handle("rosin-desktop-state", (e) => (win && e.sender === win.webContents ? { onTop: settings.onTop, buddy: settings.buddy } : null));

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
