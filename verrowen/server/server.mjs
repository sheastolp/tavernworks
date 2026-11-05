#!/usr/bin/env node
// Wake in Verrowen narrator gate: a tiny server on the laptop that lets the
// game page (tavernworks.dev/verrowen/) reach Ollama over Tailscale Funnel
// without opening Ollama itself to the internet. Anyone can reach a funnel
// address, and Ollama's own API can also download, copy and delete models,
// so the funnel points here instead, and this only lets the game through.
//
//   GET  /health     { ok, model, ollama }
//   GET  /admin/models   (owner's token)  { model, models: [names] }
//   POST /admin/model    (owner's token)  { model }  ->  { ok, model }   the narrator for everyone
//   POST /narrate    { messages: [{ role, content }] }  ->  { text }
//   POST /save       { playerId, playerName, characterName, seed, messages, profile, purpose, character }  ->  { ok }
//   POST /delete     { playerId, what: "chat" | "character" }  ->  { ok }   the player's own story file
//
//   node server.mjs           run the server (default port 8792)
//   node server.mjs list      list the saved characters, newest first
//   node server.mjs token     print the owner's token for changing the model
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.VERROWEN_PORT || 8792);
const HOST = process.env.VERROWEN_HOST || "127.0.0.1";
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.VERROWEN_MODEL || "gemma3:4b";
const ORIGINS = (process.env.VERROWEN_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
const SAVE_DIR = process.env.VERROWEN_SAVE_DIR || process.env.STATE_DIRECTORY || path.resolve("verrowen-saves");

const MAX_BODY = 256 * 1024;        // bytes per request
const MAX_MESSAGES = 60;
const MAX_FIRST = 24000;            // the first message carries the rules and the lore
const MAX_MSG = 4000;               // every other message
const MAX_REPLY_TOKENS = 700;       // a turn is 120 to 220 words; a profile is a bit longer
const PER_IP = { n: 40, ms: 10 * 60 * 1000 };   // narrate calls per address per 10 minutes
const ALL = { n: 240, ms: 10 * 60 * 1000 };     // narrate calls from everyone per 10 minutes
const MAX_WAITING = 4;              // the GPU writes one reply at a time; past this many, say busy

// ── The narrator model ──
// The owner can switch it from the game page with their token. The choice
// is kept in the save folder (as .txt, so `list` skips it).
const MODEL_FILE = () => path.join(SAVE_DIR, "narrator-model.txt");
const TOKEN_FILE = () => path.join(SAVE_DIR, "owner-token.txt");
let MODEL = DEFAULT_MODEL;
try { MODEL = (await fs.readFile(MODEL_FILE(), "utf8")).trim() || DEFAULT_MODEL; } catch { }
async function ownerToken() {
  try { const t = (await fs.readFile(TOKEN_FILE(), "utf8")).trim(); if (t) return t; } catch { }
  const t = crypto.randomBytes(24).toString("base64url");
  await fs.mkdir(SAVE_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE(), t + "\n", { mode: 0o600 });
  return t;
}
// Only the running server makes the token, so the file belongs to its user.
const SERVING = !["list", "token"].includes(process.argv[2]);
const TOKEN = SERVING ? await ownerToken() : await fs.readFile(TOKEN_FILE(), "utf8").then((t) => t.trim(), () => "");
function isOwner(req) {
  const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
async function installed() {
  const r = await fetch(OLLAMA + "/api/tags", { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r || !r.ok) throw Object.assign(new Error("Ollama isn't answering on the laptop"), { status: 502 });
  return ((await r.json().catch(() => ({}))).models || []).map((m) => m.name);
}

// ── Small helpers ──
const hits = new Map();
function allowed(key, rule) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < rule.ms);
  if (list.length >= rule.n) { hits.set(key, list); return false; }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return true;
}
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "?";
}
function send(res, status, body, origin) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "Origin" };
  if (origin) Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "600" });
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("That story is too long to send"), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Bad JSON"), { status: 400 }); }
}
const str = (v, n) => String(v ?? "").slice(0, n);
function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length) throw Object.assign(new Error("No messages"), { status: 400 });
  return list.slice(-MAX_MESSAGES).map((m, i) => {
    const role = m && ["system", "user", "assistant"].includes(m.role) ? m.role : null;
    if (!role || typeof m.content !== "string") throw Object.assign(new Error("Bad message"), { status: 400 });
    return { role, content: m.content.slice(0, i === 0 ? MAX_FIRST : MAX_MSG) };
  });
}
// Thinking models may put their reasoning first as <think>…</think>.
const stripThinking = (t) => String(t || "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim();

// ── Narrating ──
let waiting = 0;
async function narrate(messages) {
  if (waiting >= MAX_WAITING) throw Object.assign(new Error("The narrator is busy with other players. Try again in a minute."), { status: 503 });
  waiting++;
  try {
    const r = await fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, stream: false, keep_alive: "30m", options: { num_predict: MAX_REPLY_TOKENS, num_ctx: 8192, temperature: 0.9 } }),
      signal: AbortSignal.timeout(180000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error ? `Ollama: ${j.error}` : `Ollama answered ${r.status}`), { status: 502 });
    const text = stripThinking(j?.message?.content);
    if (!text) throw Object.assign(new Error("The narrator returned nothing"), { status: 502 });
    return text;
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error(e.name === "TimeoutError" ? "The narrator took too long" : "Ollama isn't answering on the laptop"), { status: 502 });
  } finally { waiting--; }
}

// ── Saving characters ──
// One file per player, rewritten after every turn, so stories that stop
// halfway are kept too.
async function save(b) {
  const id = str(b.playerId, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw Object.assign(new Error("missing playerId"), { status: 400 });
  const rec = {
    playerId: id,
    playerName: str(b.playerName, 60),
    characterName: str(b.characterName, 60),
    seed: b.seed && typeof b.seed === "object"
      ? { place: str(b.seed.place, 200), time: str(b.seed.time, 100), objects: (Array.isArray(b.seed.objects) ? b.seed.objects : []).slice(0, 5).map((o) => str(o, 200)), twist: str(b.seed.twist, 200) }
      : null,
    messages: (Array.isArray(b.messages) ? b.messages : []).slice(-80).map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", content: str(m?.content, MAX_MSG) })),
    profile: str(b.profile, 8000),
    purpose: b.purpose === "dnd" ? "dnd" : "story",
    character: b.character && typeof b.character === "object"
      ? { kind: str(b.character.kind, 20), label: str(b.character.label, 80), race: str(b.character.race, 40), description: str(b.character.description, 1200), profile: str(b.character.profile, 4000) }
      : null,
    updated: new Date().toISOString(),
  };
  await fs.mkdir(SAVE_DIR, { recursive: true });
  const file = path.join(SAVE_DIR, id + ".json");
  await fs.writeFile(file + ".tmp", JSON.stringify(rec, null, 2));
  await fs.rename(file + ".tmp", file);
}

// A player deletes their own finished character, or just its chat. The
// playerId is a random id only their browser knows, the same proof /save
// relies on. "chat" keeps the profile and drops the transcript; "character"
// removes the file. Deleting something already gone is fine.
async function remove(b) {
  const id = str(b.playerId, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw Object.assign(new Error("missing playerId"), { status: 400 });
  const what = b.what === "chat" ? "chat" : b.what === "character" ? "character" : "";
  if (!what) throw Object.assign(new Error('what must be "chat" or "character"'), { status: 400 });
  const file = path.join(SAVE_DIR, id + ".json");
  if (what === "character") {
    await fs.unlink(file).catch((e) => { if (e.code !== "ENOENT") throw e; });
    return;
  }
  let rec;
  try { rec = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  rec.messages = [];
  rec.seed = null;
  rec.chatDeleted = new Date().toISOString();
  rec.updated = rec.chatDeleted;
  await fs.writeFile(file + ".tmp", JSON.stringify(rec, null, 2));
  await fs.rename(file + ".tmp", file);
}

async function list() {
  let files = [];
  try { files = (await fs.readdir(SAVE_DIR)).filter((f) => f.endsWith(".json")); } catch { }
  const recs = [];
  for (const f of files) { try { recs.push(JSON.parse(await fs.readFile(path.join(SAVE_DIR, f), "utf8"))); } catch { } }
  recs.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  if (!recs.length) return console.log(`No saved characters in ${SAVE_DIR} yet.`);
  for (const r of recs) {
    const turns = r.messages.filter((m) => m.role === "user").length;
    console.log(`${r.updated.slice(0, 16).replace("T", " ")}  ${r.playerName || "(no name)"} as ${r.characterName || "(unnamed)"}  ${r.chatDeleted ? "chat deleted" : turns + " turns"}  ${r.profile ? "WRAPPED UP" : "in progress"}`);
    console.log(`  ${path.join(SAVE_DIR, r.playerId + ".json")}`);
  }
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  const origin = ORIGINS.includes(req.headers.origin) ? req.headers.origin : null;
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") return send(res, origin ? 204 : 403, {}, origin);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const up = await fetch(OLLAMA + "/api/version", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
      return send(res, 200, { ok: true, game: "Wake in Verrowen", model: MODEL, ollama: up }, origin);
    }
    // Browsers on other sites are turned away; scripts without an Origin header still hit the rate limits.
    if (req.headers.origin && !origin) return send(res, 403, { error: "This site isn't allowed to use the narrator" }, null);
    if (url.pathname.startsWith("/admin/")) {
      if (!allowed("admin:" + clientIp(req), { n: 30, ms: PER_IP.ms })) return send(res, 429, { error: "Too many tries. Wait a few minutes." }, origin);
      if (!isOwner(req)) return send(res, 401, { error: "That's not the owner's token" }, origin);
      if (req.method === "GET" && url.pathname === "/admin/models") return send(res, 200, { model: MODEL, models: await installed() }, origin);
      if (req.method === "POST" && url.pathname === "/admin/model") {
        const want = String((await readJson(req)).model || "");
        if (!(await installed()).includes(want)) return send(res, 400, { error: `${want || "That model"} isn't installed on the laptop` }, origin);
        MODEL = want;
        await fs.mkdir(SAVE_DIR, { recursive: true });
        await fs.writeFile(MODEL_FILE(), MODEL + "\n");
        console.log(new Date().toISOString(), "narrator model is now", MODEL);
        return send(res, 200, { ok: true, model: MODEL }, origin);
      }
    }
    if (req.method !== "POST" || !["/narrate", "/save", "/delete"].includes(url.pathname)) return send(res, 404, { error: "Not here" }, origin);
    const body = await readJson(req);
    if (url.pathname === "/save") {
      if (!allowed("save:" + clientIp(req), { n: 120, ms: PER_IP.ms })) return send(res, 429, { error: "Too many saves" }, origin);
      await save(body);
      return send(res, 200, { ok: true }, origin);
    }
    if (url.pathname === "/delete") {
      if (!allowed("delete:" + clientIp(req), { n: 60, ms: PER_IP.ms })) return send(res, 429, { error: "Too many deletes" }, origin);
      await remove(body);
      return send(res, 200, { ok: true }, origin);
    }
    if (!allowed("ip:" + clientIp(req), PER_IP)) return send(res, 429, { error: "You're going fast. Wait a few minutes, then try again." }, origin);
    if (!allowed("all", ALL)) return send(res, 429, { error: "The narrator has had a busy night. Try again in a few minutes." }, origin);
    const text = await narrate(cleanMessages(body.messages));
    return send(res, 200, { text }, origin);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(new Date().toISOString(), e.message);
    return send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the laptop" }, origin);
  }
});

if (process.argv[2] === "list") await list();
else if (process.argv[2] === "token") console.log(TOKEN || `No token yet in ${SAVE_DIR}. Start the server once; it makes one.`);
else server.listen(PORT, HOST, () => console.log(`Wake in Verrowen narrator on http://${HOST}:${PORT}, model ${MODEL}, saves in ${SAVE_DIR}`));
