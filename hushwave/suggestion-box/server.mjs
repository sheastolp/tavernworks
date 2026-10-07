#!/usr/bin/env node
// Hushwave suggestion box: a tiny server that keeps suggestions on this
// machine, in one JSON file. Anyone can drop a suggestion in; reading them
// takes the one admin password. It also keeps the homepage's tip jar links,
// which anyone can read and only the admin can change. And it stores
// TwitchBotSandbox projects (tavernworks.dev/bot-sandbox/app/) for anyone
// who signs in with Google, each account separately, with automatic backups.
//
//   node server.mjs set-password   set (or change) the admin password
//   node server.mjs                run the server (default port 8790)
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const DATA_DIR = process.env.SUGGEST_DATA_DIR || path.join(os.homedir(), ".local/share/hushwave-suggestions");
const DB_FILE = path.join(DATA_DIR, "suggestions.json");
const AUTH_FILE = path.join(DATA_DIR, "admin.json");
const TIPS_FILE = path.join(DATA_DIR, "tips.json");
const PORT = Number(process.env.SUGGEST_PORT || 8790);
const ORIGINS = (process.env.SUGGEST_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
const KINDS = ["Feature idea", "New sound", "Bug report", "Something else"];
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_STORED = 5000;
// TwitchBotSandbox: anyone can sign in with Google. Set this to the OAuth
// Client ID from Google Cloud (the same one as bot-sandbox/app/config.js on
// the site), or set SANDBOX_GOOGLE_CLIENT_ID in the service's environment.
const GOOGLE_CLIENT_ID = process.env.SANDBOX_GOOGLE_CLIENT_ID || "";
const SANDBOX_DIR = path.join(DATA_DIR, "sandbox");
const USERS_DIR = path.join(SANDBOX_DIR, "users");
const LEGACY_FILE = path.join(SANDBOX_DIR, "state.json"); // the admin's projects from before Google sign-in
const LEGACY_BACKUPS = path.join(SANDBOX_DIR, "backups");
const KEY_FILE = path.join(SANDBOX_DIR, "secrets.key");
const AUTO_BACKUP_MS = 3600 * 1000; // at most one automatic backup an hour
const MAX_BACKUPS = 30; // per account
const MAX_SANDBOX_BODY = 4 * 1024 * 1024;
const MAX_USERS = Number(process.env.SANDBOX_MAX_USERS || 500);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(USERS_DIR, { recursive: true, mode: 0o700 });

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, data) => {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");

// ── set-password ──
if (process.argv[2] === "set-password") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => { process.stdout.write(q); const { value } = await lines.next(); return value ?? ""; };
  const pw = await ask("New admin password (12+ characters): ");
  const again = await ask("Again: ");
  rl.close();
  if (pw !== again) { console.error("Those didn't match. Nothing changed."); process.exit(1); }
  if (pw.length < 12) { console.error("Too short. Use at least 12 characters."); process.exit(1); }
  const salt = crypto.randomBytes(16).toString("hex");
  // A new secret also signs out every existing session.
  writeJson(AUTH_FILE, { salt, hash: hashPassword(pw, salt), secret: crypto.randomBytes(32).toString("hex") });
  console.log(`Saved to ${AUTH_FILE}. Restart the server if it's running.`);
  process.exit(0);
}

const auth = readJson(AUTH_FILE, null);
if (!auth) { console.error("No admin password yet. Run: node server.mjs set-password"); process.exit(1); }
let suggestions = readJson(DB_FILE, []);
const save = () => writeJson(DB_FILE, suggestions);
let tips = readJson(TIPS_FILE, { urls: {} });

// ── TwitchBotSandbox storage, one folder per Google account ──
// users/<id>/state.json holds the current projects, UI prefs and the
// account's GitHub/Val Town tokens (encrypted with secrets.key). rev goes up
// on every project save so two open tabs can't silently overwrite each other.
// Backups are copies of projects + prefs, never the tokens.
const BACKUP_ID = /^[0-9TZ-]+-(auto|manual|restore|import)$/;
const USER_ID = /^[0-9a-f]{32}$/;

if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
const secretsKey = fs.readFileSync(KEY_FILE);
const encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", secretsKey, iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
};
const decrypt = (blob) => {
  try {
    const [iv, tag, body] = String(blob).split(".").map((p) => Buffer.from(p, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", secretsKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch { return ""; }
};

// A stable folder name for a Google account (its "sub"), without putting
// the raw id on disk.
const userIdFor = (googleSub) => crypto.createHash("sha256").update("tbs:" + googleSub).digest("hex").slice(0, 32);
const userDir = (uid) => path.join(USERS_DIR, uid);
const stateFile = (uid) => path.join(userDir(uid), "state.json");
const backupDir = (uid) => path.join(userDir(uid), "backups");
const emptyState = () => ({ rev: 0, projects: null, prefs: {}, secrets: {}, updated: null });
const loadState = (uid) => readJson(stateFile(uid), emptyState());
const saveState = (uid, state) => writeJson(stateFile(uid), state);

function ensureUser(uid, profile) {
  if (!fs.existsSync(userDir(uid))) {
    if (fs.readdirSync(USERS_DIR).length >= MAX_USERS) return false;
    fs.mkdirSync(backupDir(uid), { recursive: true, mode: 0o700 });
    saveState(uid, emptyState());
  }
  writeJson(path.join(userDir(uid), "profile.json"), { ...profile, lastSignIn: new Date().toISOString() });
  return true;
}

function listBackups(uid) {
  const dir = backupDir(uid);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && BACKUP_ID.test(f.slice(0, -5)))
    .sort().reverse()
    .map((f) => {
      const b = readJson(path.join(dir, f), {});
      return { id: f.slice(0, -5), at: b.at, kind: b.kind, projects: Object.keys(b.projects || {}).length, size: fs.statSync(path.join(dir, f)).size };
    });
}

function writeBackup(uid, kind, projects, prefs) {
  if (!projects || typeof projects !== "object") return null;
  const dir = backupDir(uid);
  const at = new Date().toISOString();
  const id = at.replace(/[:.]/g, "-") + "-" + kind;
  writeJson(path.join(dir, id + ".json"), { at, kind, projects, prefs: prefs || {} });
  fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(MAX_BACKUPS)
    .forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
  return id;
}

function maybeAutoBackup(uid, state) {
  const last = listBackups(uid).find((b) => b.kind === "auto");
  if (!last || Date.now() - Date.parse(last.at) > AUTO_BACKUP_MS) writeBackup(uid, "auto", state.projects, state.prefs);
}

// Projects saved with the old admin-password sign-in go to the admin's
// Google account, the first time they sign in with Google from a browser
// that's still logged in as admin.
function claimLegacy(uid) {
  if (!fs.existsSync(LEGACY_FILE)) return false;
  const legacy = readJson(LEGACY_FILE, null);
  const state = loadState(uid);
  if (legacy && legacy.projects) {
    if (state.projects) writeBackup(uid, "import", legacy.projects, legacy.prefs);
    else { state.projects = legacy.projects; state.prefs = legacy.prefs || {}; state.rev++; }
  }
  for (const [name, token] of Object.entries((legacy && legacy.secrets) || {})) {
    if (!state.secrets[name] && token) state.secrets[name] = encrypt(token);
  }
  saveState(uid, state);
  if (fs.existsSync(LEGACY_BACKUPS)) {
    for (const f of fs.readdirSync(LEGACY_BACKUPS)) fs.renameSync(path.join(LEGACY_BACKUPS, f), path.join(backupDir(uid), f));
    fs.rmSync(LEGACY_BACKUPS, { recursive: true, force: true });
  }
  fs.rmSync(LEGACY_FILE, { force: true });
  return true;
}

// A project map from the browser: { id: { label, runtime, files: [{ id, name, content }], history, ... } }.
const validProjects = (p) => p && typeof p === "object" && !Array.isArray(p) &&
  Object.values(p).every((proj) => proj && typeof proj === "object" && typeof proj.label === "string" && Array.isArray(proj.files));

// ── Google sign-in: verify the ID token Google gives the browser ──
let googleKeys = { keys: [], until: 0 };
async function googleKey(kid) {
  if (Date.now() > googleKeys.until || !googleKeys.keys.some((k) => k.kid === kid)) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!r.ok) throw new Error("Couldn't fetch Google's signing keys.");
    const maxAge = Number((/max-age=(\d+)/.exec(r.headers.get("cache-control") || "") || [])[1] || 3600);
    googleKeys = { keys: (await r.json()).keys || [], until: Date.now() + maxAge * 1000 };
  }
  const jwk = googleKeys.keys.find((k) => k.kid === kid);
  return jwk && crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function verifyGoogleToken(idToken) {
  const [h, p, sig] = String(idToken || "").split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.alg !== "RS256") return null;
  const key = await googleKey(header.kid);
  if (!key || !crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), key, Buffer.from(sig, "base64url"))) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const now = Date.now() / 1000;
  if (claims.aud !== GOOGLE_CLIENT_ID) return null;
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") return null;
  if (!(claims.exp > now) || !claims.sub) return null;
  return claims;
}

// ── sessions: "<expiry>.<hmac>", signed with the secret in admin.json ──
const sign = (exp) => crypto.createHmac("sha256", auth.secret).update(String(exp)).digest("hex");
const newToken = () => { const exp = Date.now() + SESSION_MS; return `${exp}.${sign(exp)}`; };
// Sandbox sessions: "u.<userId>.<expiry>.<hmac>".
const signUser = (uid, exp) => crypto.createHmac("sha256", auth.secret).update(`u.${uid}.${exp}`).digest("hex");
const newUserToken = (uid) => { const exp = Date.now() + SESSION_MS; return { token: `u.${uid}.${exp}.${signUser(uid, exp)}`, expires: exp }; };
const userFromToken = (t) => {
  const [u, uid, exp, mac] = String(t || "").split(".");
  if (u !== "u" || !USER_ID.test(uid || "") || !exp || !mac || Number(exp) < Date.now()) return null;
  const want = Buffer.from(signUser(uid, exp)), got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got) && fs.existsSync(userDir(uid)) ? uid : null;
};
const validToken = (t) => {
  const [exp, mac] = String(t || "").split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp)), got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};

// ── simple per-IP rate limits ──
const hits = new Map();
const limited = (key, max, windowMs) => {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
};
setInterval(() => hits.clear(), 3600 * 1000).unref();

// Behind Tailscale Funnel every request comes from localhost, so use the
// address Funnel appends (the last one; earlier ones can be faked).
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",").pop().trim();
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req, max = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return send(res, 204);
  if (origin && !ORIGINS.includes(origin)) return send(res, 403, { error: "This website isn't allowed. Check SUGGEST_ORIGINS." });

  const url = new URL(req.url, "http://x");
  const ip = clientIp(req);
  const isAdmin = () => validToken((req.headers.authorization || "").replace(/^Bearer /, ""));

  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

    // Anyone: drop a suggestion in the box.
    if (req.method === "POST" && url.pathname === "/suggest") {
      if (limited("s:" + ip, 5, 10 * 60 * 1000)) return send(res, 429, { error: "Easy, adventurer. Try again in a few minutes." });
      const b = await readBody(req);
      if (b.website) return send(res, 200, { ok: true }); // a bot filled the hidden field
      const message = clean(b.message, 1500);
      if (message.length < 5) return send(res, 400, { error: "Write a few words first." });
      suggestions.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        name: clean(b.name, 60) || "Anonymous",
        kind: KINDS.includes(b.kind) ? b.kind : "Something else",
        message,
        done: false,
      });
      suggestions = suggestions.slice(0, MAX_STORED);
      save();
      return send(res, 201, { ok: true });
    }

    // The one login.
    if (req.method === "POST" && url.pathname === "/login") {
      if (limited("l:" + ip, 5, 15 * 60 * 1000)) return send(res, 429, { error: "Too many tries. Wait 15 minutes." });
      const b = await readBody(req);
      const got = Buffer.from(hashPassword(String(b.password || ""), auth.salt), "hex");
      const want = Buffer.from(auth.hash, "hex");
      if (!crypto.timingSafeEqual(got, want)) return send(res, 401, { error: "Wrong password." });
      return send(res, 200, { token: newToken(), expires: Date.now() + SESSION_MS });
    }

    // Anyone: the tip jar links shown on the homepage.
    if (req.method === "GET" && url.pathname === "/tips") return send(res, 200, tips);

    // Admin only from here.
    if (req.method === "PUT" && url.pathname === "/tips") {
      if (!isAdmin()) return send(res, 401, { error: "Log in again." });
      const b = await readBody(req);
      const urls = {};
      for (const [key, value] of Object.entries(b.urls || {}).slice(0, 40)) {
        if (!/^[a-z0-9-]{1,30}$/.test(key)) continue;
        const link = clean(value, 300);
        if (link && !/^https:\/\/[^\s"'<>]+$/i.test(link)) return send(res, 400, { error: `The ${key} link has to start with https://` });
        urls[key] = link;
      }
      tips = { urls, updated: new Date().toISOString() };
      writeJson(TIPS_FILE, tips);
      return send(res, 200, tips);
    }

    // Anyone: sign in to the sandbox with a Google ID token.
    if (req.method === "POST" && url.pathname === "/sandbox/google") {
      if (!GOOGLE_CLIENT_ID) return send(res, 503, { error: "Google sign-in isn't set up on the server yet." });
      if (limited("g:" + ip, 20, 15 * 60 * 1000)) return send(res, 429, { error: "Too many sign-ins. Wait a few minutes." });
      const b = await readBody(req);
      let claims;
      try { claims = await verifyGoogleToken(b.credential); } catch { return send(res, 502, { error: "Couldn't check the sign-in with Google. Try again." }); }
      if (!claims) return send(res, 401, { error: "Google sign-in didn't check out. Try again." });
      const uid = userIdFor(claims.sub);
      const profile = { name: clean(claims.name, 100), email: clean(claims.email, 200), picture: clean(claims.picture, 500) };
      if (!ensureUser(uid, profile)) return send(res, 503, { error: "The sandbox is full right now. Your projects stay in this browser." });
      const claimed = validToken(b.adminToken) && claimLegacy(uid);
      return send(res, 200, { ...newUserToken(uid), user: profile, claimedLegacy: claimed });
    }

    if (url.pathname === "/sandbox" || url.pathname.startsWith("/sandbox/")) {
      const uid = userFromToken((req.headers.authorization || "").replace(/^Bearer /, ""));
      if (!uid) return send(res, 401, { error: "Sign in again." });
      if (req.method !== "GET" && limited("w:" + uid, 240, 10 * 60 * 1000)) return send(res, 429, { error: "Saving too fast. Wait a minute." });
      const parts = url.pathname.split("/").slice(2); // after "/sandbox"
      const state = loadState(uid);

      // Everything the app needs to start: projects, prefs and tokens.
      if (req.method === "GET" && !parts.length) {
        const secrets = {};
        for (const [name, blob] of Object.entries(state.secrets || {})) secrets[name] = decrypt(blob);
        const profile = readJson(path.join(userDir(uid), "profile.json"), {});
        return send(res, 200, { ...state, secrets, user: { name: profile.name, email: profile.email, picture: profile.picture } });
      }

      // Delete this account's projects, tokens and backups for good.
      if (req.method === "DELETE" && parts[0] === "account" && parts.length === 1) {
        fs.rmSync(userDir(uid), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }

      if (req.method === "PUT" && parts[0] === "projects" && parts.length === 1) {
        const b = await readBody(req, MAX_SANDBOX_BODY);
        if (!validProjects(b.projects)) return send(res, 400, { error: "That doesn't look like a set of sandbox projects." });
        if (b.rev !== state.rev) return send(res, 409, { error: "Changed in another tab or device. Reload to get the latest.", rev: state.rev });
        state.projects = b.projects;
        state.rev++;
        state.updated = new Date().toISOString();
        saveState(uid, state);
        maybeAutoBackup(uid, state);
        return send(res, 200, { rev: state.rev, updated: state.updated });
      }

      if (req.method === "PUT" && parts[0] === "prefs" && parts.length === 1) {
        const b = await readBody(req);
        state.prefs = b.prefs && typeof b.prefs === "object" ? b.prefs : {};
        saveState(uid, state);
        return send(res, 200, { ok: true });
      }

      if (req.method === "PUT" && parts[0] === "secrets" && /^(github|valtown)$/.test(parts[1] || "")) {
        const b = await readBody(req);
        const token = clean(b.token, 500);
        state.secrets = state.secrets || {};
        if (token) state.secrets[parts[1]] = encrypt(token);
        else delete state.secrets[parts[1]];
        saveState(uid, state);
        return send(res, 200, { ok: true });
      }

      if (parts[0] === "backups") {
        const id = parts[1];
        if (req.method === "GET" && !id) return send(res, 200, { backups: listBackups(uid) });
        // Back up now, or bring in projects from elsewhere (a file, or this
        // browser's old storage) as a backup without touching the current set.
        if (req.method === "POST" && !id) {
          const b = await readBody(req, MAX_SANDBOX_BODY);
          if (b.projects !== undefined) {
            if (!validProjects(b.projects)) return send(res, 400, { error: "That doesn't look like a set of sandbox projects." });
            return send(res, 201, { id: writeBackup(uid, "import", b.projects, b.prefs) });
          }
          if (!state.projects) return send(res, 400, { error: "Nothing to back up yet." });
          return send(res, 201, { id: writeBackup(uid, "manual", state.projects, state.prefs) });
        }
        if (!id || !BACKUP_ID.test(id)) return send(res, 404, { error: "Not found." });
        const file = path.join(backupDir(uid), id + ".json");
        const backup = readJson(file, null);
        if (!backup) return send(res, 404, { error: "Not found." });
        if (req.method === "GET" && parts.length === 2) return send(res, 200, backup);
        if (req.method === "DELETE" && parts.length === 2) { fs.rmSync(file, { force: true }); return send(res, 200, { ok: true }); }
        if (req.method === "POST" && parts[2] === "restore") {
          // Keep what's there now, so a restore can itself be undone.
          writeBackup(uid, "restore", state.projects, state.prefs);
          state.projects = backup.projects;
          state.prefs = backup.prefs || state.prefs;
          state.rev++;
          state.updated = new Date().toISOString();
          saveState(uid, state);
          return send(res, 200, { rev: state.rev });
        }
      }
      return send(res, 404, { error: "Not found." });
    }

    if (url.pathname === "/suggestions" || url.pathname.startsWith("/suggestions/")) {
      if (!isAdmin()) return send(res, 401, { error: "Log in again." });
      const id = url.pathname.split("/")[2];
      if (req.method === "GET" && !id) return send(res, 200, { suggestions });
      const item = suggestions.find((s) => s.id === id);
      if (!item) return send(res, 404, { error: "Not found." });
      if (req.method === "PATCH") {
        const b = await readBody(req);
        if (typeof b.done === "boolean") item.done = b.done;
        save();
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        suggestions = suggestions.filter((s) => s.id !== id);
        save();
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: "Not found." });
  } catch (e) {
    send(res, 400, { error: "Bad request." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Suggestion box listening on 127.0.0.1:${PORT}, storing in ${DATA_DIR}`);
  console.log(`Allowed sites: ${ORIGINS.join(", ")}`);
  console.log(GOOGLE_CLIENT_ID ? "Sandbox Google sign-in is on." : "Sandbox Google sign-in is off (no SANDBOX_GOOGLE_CLIENT_ID).");
});
