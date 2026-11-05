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
//   POST /admin/publish  (owner's token)  {}  ->  { ok, sha, how }   puts the Review Clone (grand-orrery's
//                        review branch) live on main
//   POST /admin/discard  (owner's token)  {}  ->  { ok, sha }   throws away everything waiting on review
//   POST /admin/lorekeeper (owner's token) { chat }  ->  { ok, saved }   the owner's latest Orrery
//                        lore-keeper chat, kept for review; each save replaces the last
//   GET  /admin/lorekeeper (owner's token)  ->  { chat | null }
//   POST /admin/review-item (owner's token) { title, body, about, chatId }  ->  { ok, sha, url }   files a
//                        lore-keeper pitch in working-notes.md on the review branch
//   POST /narrate    { messages: [{ role, content }] }  ->  { text }
//   POST /save       { playerId, playerName, characterName, seed, messages, profile, purpose, character }  ->  { ok }
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
const MAX_REPLY_TOKENS = 700;
const MAX_CTX = Number(process.env.VERROWEN_MAX_CTX || 16384);   // the most context the GPU is asked to hold       // a turn is 120 to 220 words; a profile is a bit longer
const PER_IP = { n: 40, ms: 10 * 60 * 1000 };   // narrate calls per address per 10 minutes
const ALL = { n: 240, ms: 10 * 60 * 1000 };     // narrate calls from everyone per 10 minutes
const MAX_WAITING = 4;
// The Review Clone: every change to the universe lands on grand-orrery's
// review branch first. Only the owner, from /orrery/control/review/, puts it
// live on main. Needs a GitHub token that can write grand-orrery's contents.
const GH_REPO = process.env.ORRERY_REPO || "sheastolp/grand-orrery";
const GH_TOKEN = process.env.ORRERY_GITHUB_TOKEN || "";
const LIVE = "main", CLONE = "review";              // the GPU writes one reply at a time; past this many, say busy

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
// Either signal stops the request. (AbortSignal.any is Node 20.3+; this
// does the same on Node 18.)
function eitherSignal(a, b) {
  if (AbortSignal.any) return AbortSignal.any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
let waiting = 0;
// `left` fires when the browser hangs up (the player pressed Stop, or closed
// the page). Ollama stops generating when its request is cancelled, so the
// GPU is free at once for the next turn, such as a Resend.
async function narrate(messages, left) {
  if (waiting >= MAX_WAITING) throw Object.assign(new Error("The narrator is busy with other players. Try again in a minute."), { status: 503 });
  waiting++;
  try {
    // Small models sometimes get stuck saying the same token over and over,
    // and Ollama stops them with "token repeat limit reached". A repeat
    // penalty makes that rare; if it still happens, try once more with a
    // stronger penalty and a cooler temperature before giving up.
    // Room for the whole conversation plus the reply. A window too small
    // cuts the start of the prompt (the rules and the lore) off silently,
    // and a small model that loses its instructions is the one that loops.
    const chars = messages.reduce((n, m) => n + String(m.content || "").length, 0);
    const ctx = Math.min(MAX_CTX, Math.max(4096, Math.ceil((chars / 3 + MAX_REPLY_TOKENS + 256) / 1024) * 1024));
    const ask = (options) => fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, stream: false, keep_alive: "30m", options: { num_predict: MAX_REPLY_TOKENS, num_ctx: ctx, top_p: 0.9, repeat_last_n: 256, ...options } }),
      signal: left ? eitherSignal(AbortSignal.timeout(180000), left) : AbortSignal.timeout(180000),
    });
    let r = await ask({ temperature: 0.9, repeat_penalty: 1.15 });
    let j = await r.json().catch(() => ({}));
    if (!r.ok && /repeat/i.test(j.error || "")) {
      r = await ask({ temperature: 0.7, repeat_penalty: 1.3, presence_penalty: 0.5 });
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok) throw Object.assign(new Error(/repeat/i.test(j.error || "") ? "The AI model got stuck repeating itself, even on a second try. A bigger model (Change AI model) fixes this best" : j.error ? `Ollama: ${j.error}` : `Ollama answered ${r.status}`), { status: 502 });
    const text = stripThinking(j?.message?.content);
    if (!text) throw Object.assign(new Error("The narrator returned nothing"), { status: 502 });
    return text;
  } catch (e) {
    if (e.status) throw e;
    if (left?.aborted) throw Object.assign(new Error("The player stopped waiting"), { status: 499, quiet: true });
    throw Object.assign(new Error(e.name === "TimeoutError" ? "The narrator took too long" : "Ollama isn't answering on the laptop"), { status: 502 });
  } finally { waiting--; }
}

// ── The Review Clone ──
async function gh(pathname, init = {}) {
  if (!GH_TOKEN) throw Object.assign(new Error("The laptop has no GitHub token yet (ORRERY_GITHUB_TOKEN). See the server README."), { status: 503 });
  const r = await fetch("https://api.github.com/repos/" + GH_REPO + pathname, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: "Bearer " + GH_TOKEN, "user-agent": "orrery-control", "x-github-api-version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
const headOf = async (branch) => {
  const r = await gh("/git/ref/heads/" + branch);
  if (!r.ok) throw Object.assign(new Error(`GitHub couldn't find the ${branch} branch (${r.status})`), { status: 502 });
  return r.j.object.sha;
};
// Fast-forward main to review when nothing else reached main in between,
// so the live history reads exactly like the reviewed one. Otherwise merge.
async function publish() {
  const sha = await headOf(CLONE);
  const ff = await gh("/git/refs/heads/" + LIVE, { method: "PATCH", body: JSON.stringify({ sha, force: false }) });
  if (ff.ok) return { sha, how: "fast-forward" };
  const m = await gh("/merges", { method: "POST", body: JSON.stringify({ base: LIVE, head: CLONE, commit_message: "Publish the Review Clone to the live Orrery" }) });
  if (m.status === 204) return { sha: await headOf(LIVE), how: "already live" };
  if (!m.ok) throw Object.assign(new Error(m.status === 409 ? "The review and live versions conflict. Fix it on GitHub, then publish again." : `GitHub refused the merge (${m.status}): ${m.j.message || ""}`), { status: 502 });
  // Bring review up to the merge too, so the next round of changes starts from what's live.
  await gh("/git/refs/heads/" + CLONE, { method: "PATCH", body: JSON.stringify({ sha: m.j.sha, force: false }) });
  return { sha: m.j.sha, how: "merge" };
}
async function discard() {
  const sha = await headOf(LIVE);
  const r = await gh("/git/refs/heads/" + CLONE, { method: "PATCH", body: JSON.stringify({ sha, force: true }) });
  if (!r.ok) throw Object.assign(new Error(`GitHub refused (${r.status}): ${r.j.message || ""}`), { status: 502 });
  return { sha };
}

// ── The owner's latest lore-keeper chat ──
// Saved after every message the owner sends and every reply, so the Review
// Clone page always shows the one most recent chat. Only one is kept.
const LK_FILE = () => path.join(SAVE_DIR, "lorekeeper-latest.json");
async function saveLorekeeper(b) {
  const c = b && typeof b.chat === "object" && b.chat ? b.chat : null;
  if (!c || !Array.isArray(c.messages)) throw Object.assign(new Error("missing chat"), { status: 400 });
  const rec = {
    id: str(c.id, 80), title: str(c.title, 120), mode: str(c.mode, 20), kind: str(c.kind, 40), idea: str(c.idea, 4000),
    target: c.target && typeof c.target === "object" ? { kind: str(c.target.kind, 20), id: str(c.target.id, 80), name: str(c.target.name, 120) } : null,
    messages: c.messages.slice(-200).map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", content: str(m?.content, 8000) })),
    writeup: str(c.writeup, 12000),
    saved: new Date().toISOString(),
  };
  const prev = await readLorekeeper();
  if (prev && prev.id === rec.id && prev.filed) rec.filed = prev.filed;   // the same chat keeps its "filed" mark
  await fs.mkdir(SAVE_DIR, { recursive: true });
  await fs.writeFile(LK_FILE() + ".tmp", JSON.stringify(rec, null, 2));
  await fs.rename(LK_FILE() + ".tmp", LK_FILE());
  return rec.saved;
}
async function readLorekeeper() {
  try { return JSON.parse(await fs.readFile(LK_FILE(), "utf8")); } catch { return null; }
}
// Turn the latest chat into a review item: the owner's edited draft becomes a
// Pitch section at the end of working-notes.md, committed to the review
// branch, so it waits under "Waiting for you" until it's published.
const NOTES = "working-notes.md", LK_HEAD = "## From the lore-keeper";
async function fileReviewItem(b) {
  const title = str(b.title, 120).replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ").trim();
  const body = str(b.body, 12000).replace(/\r\n/g, "\n").trim();
  if (!title || !body) throw Object.assign(new Error("The item needs a title and some text"), { status: 400 });
  const day = new Date().toISOString().slice(0, 10);
  const from = str(b.about, 200).replace(/[\r\n]+/g, " ").trim();
  const path_ = "/contents/" + NOTES;
  for (let tries = 0; tries < 2; tries++) {
    const cur = await gh(path_ + "?ref=" + CLONE);
    if (!cur.ok) throw Object.assign(new Error(`GitHub couldn't read ${NOTES} on the review branch (${cur.status})`), { status: 502 });
    let text = Buffer.from(cur.j.content || "", "base64").toString("utf8").replace(/\s+$/, "");
    if (!text.includes("\n" + LK_HEAD + "\n")) text += `\n\n${LK_HEAD}\n\nPitches the owner filed from lore-keeper chats on the Orrery Explorer. Nothing here is decided until it's marked **Your idea**.`;
    text += `\n\n### ${title} (Pitch)\n\n_From a lore-keeper chat, ${day}${from ? " · " + from : ""}._\n\n${body}\n`;
    const put = await gh(path_, { method: "PUT", body: JSON.stringify({ message: `Lore-keeper pitch: ${title}`, content: Buffer.from(text, "utf8").toString("base64"), sha: cur.j.sha, branch: CLONE }) });
    if (put.ok) {
      const rec = await readLorekeeper();
      if (rec && b.chatId && rec.id === str(b.chatId, 80)) {
        rec.filed = { at: new Date().toISOString(), title, sha: put.j.commit.sha };
        await fs.writeFile(LK_FILE() + ".tmp", JSON.stringify(rec, null, 2));
        await fs.rename(LK_FILE() + ".tmp", LK_FILE());
      }
      return { sha: put.j.commit.sha, url: put.j.commit.html_url };
    }
    if (put.status !== 409) throw Object.assign(new Error(`GitHub refused the commit (${put.status}): ${put.j.message || ""}`), { status: 502 });
    // 409: the file changed on review between the read and the write; read it again once.
  }
  throw Object.assign(new Error("working-notes.md kept changing on the review branch. Try again."), { status: 502 });
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
    // Browsers on other sites are turned away; scripts without an Origin header still hit the rate limits.
    if (req.headers.origin && !origin) return send(res, 403, { error: "This site isn't allowed to use the narrator" }, null);
    if (url.pathname.startsWith("/admin/")) {
      // Chat saves come after every turn, so they get a roomier limit of their own.
      const lk = url.pathname === "/admin/lorekeeper";
      if (!allowed((lk ? "lk:" : "admin:") + clientIp(req), { n: lk ? 240 : 30, ms: PER_IP.ms })) return send(res, 429, { error: "Too many tries. Wait a few minutes." }, origin);
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
      if (lk && req.method === "GET") return send(res, 200, { chat: await readLorekeeper() }, origin);
      if (lk && req.method === "POST") return send(res, 200, { ok: true, saved: await saveLorekeeper(await readJson(req)) }, origin);
      if (req.method === "POST" && url.pathname === "/admin/review-item") {
        const r = await fileReviewItem(await readJson(req));
        console.log(new Date().toISOString(), "lore-keeper pitch filed on review", r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "POST" && url.pathname === "/admin/publish") {
        const r = await publish();
        console.log(new Date().toISOString(), "Review Clone published", r.how, r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "POST" && url.pathname === "/admin/discard") {
        const r = await discard();
        console.log(new Date().toISOString(), "Review Clone discarded, back to", r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
    }
    if (req.method !== "POST" || !["/narrate", "/save"].includes(url.pathname)) return send(res, 404, { error: "Not here" }, origin);
    const body = await readJson(req);
    if (url.pathname === "/save") {
      if (!allowed("save:" + clientIp(req), { n: 120, ms: PER_IP.ms })) return send(res, 429, { error: "Too many saves" }, origin);
      await save(body);
      return send(res, 200, { ok: true }, origin);
    }
    if (!allowed("ip:" + clientIp(req), PER_IP)) return send(res, 429, { error: "You're going fast. Wait a few minutes, then try again." }, origin);
    if (!allowed("all", ALL)) return send(res, 429, { error: "The narrator has had a busy night. Try again in a few minutes." }, origin);
    // If the browser goes away before the reply is sent, stop the model.
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    const text = await narrate(cleanMessages(body.messages), gone.signal);
    return send(res, 200, { text }, origin);
  } catch (e) {
    if (e.quiet) { console.log(new Date().toISOString(), "stopped a reply: the player hung up"); return res.destroyed ? undefined : send(res, e.status, { error: e.message }, origin); }
    if (!e.status || e.status >= 500) console.error(new Date().toISOString(), e.message);
    return send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the laptop" }, origin);
  }
});

if (process.argv[2] === "list") await list();
else if (process.argv[2] === "token") console.log(TOKEN || `No token yet in ${SAVE_DIR}. Start the server once; it makes one.`);
else server.listen(PORT, HOST, () => console.log(`Wake in Verrowen narrator on http://${HOST}:${PORT}, model ${MODEL}, saves in ${SAVE_DIR}`));
