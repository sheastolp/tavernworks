#!/usr/bin/env node
// Wake in Verrowen narrator gate: a tiny server on the laptop that lets the
// game page (tavernworks.dev/verrowen/) reach Ollama over Tailscale Funnel
// without opening Ollama itself to the internet. Anyone can reach a funnel
// address, and Ollama's own API can also download, copy and delete models,
// so the funnel points here instead, and this only lets the game through.
//
//   GET  /health     { ok, model, ollama }
//   POST /narrate    { messages: [{ role, content }] }  ->  { text }
//   POST /save       { playerId, playerName, characterName, seed, messages, profile }  ->  { ok }
//
//   node server.mjs           run the server (default port 8792)
//   node server.mjs list      list the saved characters, newest first
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.VERROWEN_PORT || 8792);
const HOST = process.env.VERROWEN_HOST || "127.0.0.1";
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.VERROWEN_MODEL || "gemma3:4b";
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
  if (origin) Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
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
    updated: new Date().toISOString(),
  };
  await fs.mkdir(SAVE_DIR, { recursive: true });
  const file = path.join(SAVE_DIR, id + ".json");
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
    console.log(`${r.updated.slice(0, 16).replace("T", " ")}  ${r.playerName || "(no name)"} as ${r.characterName || "(unnamed)"}  ${turns} turns  ${r.profile ? "WRAPPED UP" : "in progress"}`);
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
    if (req.method !== "POST" || !["/narrate", "/save"].includes(url.pathname)) return send(res, 404, { error: "Not here" }, origin);
    // Browsers on other sites are turned away; scripts without an Origin header still hit the rate limits.
    if (req.headers.origin && !origin) return send(res, 403, { error: "This site isn't allowed to use the narrator" }, null);
    const body = await readJson(req);
    if (url.pathname === "/save") {
      if (!allowed("save:" + clientIp(req), { n: 120, ms: PER_IP.ms })) return send(res, 429, { error: "Too many saves" }, origin);
      await save(body);
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
else server.listen(PORT, HOST, () => console.log(`Wake in Verrowen narrator on http://${HOST}:${PORT}, model ${MODEL}, saves in ${SAVE_DIR}`));
