#!/usr/bin/env node
// Local AI gate: a tiny server on the FX705 that lets the browser chat
// (tavernworks.dev/local-ai/chat/) reach Ollama and the web search server
// from anywhere, through Tailscale Funnel, so visitors don't need Tailscale.
// Anyone can reach a funnel address, and Ollama's own API can also download,
// copy and delete models, so the funnel points here instead, and this only
// lets the chat through.
//
//   GET  /health          { ok, ollama, search }
//   GET  /api/tags        the installed models (names and sizes only), plus "pool", the AI Pool
//   POST /api/chat        { model, messages, tools?, options? }  ->  Ollama's NDJSON stream
//                         model "pool" goes to the AI Pool's brain (llama-server on :8090), turned
//                         into the same NDJSON; if the pool is off or fails, an Ollama model answers
//                         instead and the stream starts with a { note } line saying so
//   POST /api/transcribe  audio (webm, ogg, mp4, wav)  ->  { text }, from the Whisper server (speaches)
//   GET  /api/voices      the laptop's natural voices (Kokoro, through speaches), and whether they're ready
//   POST /api/speak       { text, voice, speed }  ->  mp3 of Rosin saying it, from the same speaches server
//   GET  /search?q=…&n=5  passed to the web search server
//   GET  /fetch?url=…     passed to the web search server
//   GET  /api/reply?id=…&from=N   the rest of a reply the browser lost hold of
//   POST /api/stop?id=…           stop that reply
//
// Everything but /health needs the laptop's key in an X-Gate-Key header, so
// only Sheamus's own devices can use it. The key is read at start from the
// systemd credential "gate-key" (see README.md), or GATE_KEY_FILE, or GATE_KEY.
// With no key set up, the gate turns every chat away.
//
//   node server.mjs       run the gate (default port 8793)
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";

const PORT = Number(process.env.GATE_PORT || 8793);
const HOST = process.env.GATE_HOST || "127.0.0.1";
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const SEARCH = (process.env.SEARCH_URL || "http://127.0.0.1:8791").replace(/\/$/, "");
// Speech to text for Rosin when the browser can't do it: an OpenAI-style Whisper server (speaches, see
// bot-host/README.md), port 8000 on this laptop by default.
const WHISPER = (process.env.WHISPER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "").replace(/\/v1$/, "");
const WHISPER_MODEL = process.env.WHISPER_MODEL || "Systran/faster-distil-whisper-small.en";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "en";
const MAX_AUDIO = 12 * 1024 * 1024;   // about 10 minutes of phone audio
// Text to speech for Rosin's natural voices: the same speaches server, with the Kokoro model downloaded into it.
const TTS = (process.env.TTS_URL || WHISPER).replace(/\/+$/, "").replace(/\/v1$/, "");
const TTS_MODEL = process.env.TTS_MODEL || "speaches-ai/Kokoro-82M-v1.0-ONNX";
// Kokoro's English voices (a = American, b = British; f = female, m = male).
const TTS_VOICES = ["am_michael", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_onyx", "am_puck", "am_santa",
  "bm_george", "bm_lewis", "bm_daniel", "bm_fable",
  "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova", "af_river", "af_alloy", "af_aoede", "af_jessica", "af_kore",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily"];
const MAX_SPEAK_CHARS = 1000;
const ORIGINS = (process.env.GATE_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
// Only these models, if set (comma-separated). Otherwise every installed model.
const ONLY = (process.env.GATE_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
// The AI Pool's brain (pool/m1 on tavernworks: llama-server, solo or split, on this laptop's tailnet
// address, port 8090). GATE_POOL_URL sets it, "off" turns the pool option off; otherwise it's found
// from `tailscale ip -4`. GATE_POOL_FALLBACK names the Ollama model that answers when the pool can't.
const POOL_SETTING = String(process.env.GATE_POOL_URL || "").trim();
const POOL_FALLBACK = String(process.env.GATE_POOL_FALLBACK || "").trim();
const POOL_WAIT_MS = 300000;          // how long the pool may take to start answering before Ollama steps in (a 14B on the CPU is slow over a long first prompt)

const MAX_BODY = 32 * 1024 * 1024;   // bytes per chat request (images ride along as base64)
const MAX_MESSAGES = 200;
const MAX_TEXT = 1_200_000;           // characters of text across the whole conversation
const MAX_IMAGES = 8;                 // images across the whole conversation
const MAX_IMAGE = 8 * 1024 * 1024;    // characters of base64 per image
const MAX_CTX = Number(process.env.GATE_MAX_CTX || 32768);
const MAX_REPLY_TOKENS = 4096;
const MAX_WAITING = 4;                // the GPU writes one reply at a time; past this many, say busy
// The key. Never logged or sent anywhere; only compared.
function loadKey() {
  const files = [process.env.CREDENTIALS_DIRECTORY && join(process.env.CREDENTIALS_DIRECTORY, "gate-key"), process.env.GATE_KEY_FILE].filter(Boolean);
  for (const f of files) { try { const k = readFileSync(f, "utf8").trim(); if (k) return k; } catch {} }
  return String(process.env.GATE_KEY || "").trim();
}
const KEY = loadKey();
const KEY_HASH = KEY ? createHash("sha256").update(KEY).digest() : null;
function keyOk(req) {
  const given = String(req.headers["x-gate-key"] || "").trim();
  if (!KEY_HASH || !given) return false;
  return timingSafeEqual(createHash("sha256").update(given).digest(), KEY_HASH);
}
const BAD_KEY_PER_IP = { n: 20, ms: 10 * 60 * 1000 };

const CHAT_PER_IP = { n: 60, ms: 10 * 60 * 1000 };
const CHAT_ALL = { n: 400, ms: 10 * 60 * 1000 };
const SEARCH_PER_IP = { n: 120, ms: 10 * 60 * 1000 };
const HEAR_PER_IP = { n: 120, ms: 10 * 60 * 1000 };
const SPEAK_PER_IP = { n: 600, ms: 10 * 60 * 1000 };   // one request per sentence Rosin says

// The chat's two web tools. Whatever tools a request asks for, the model
// only ever gets these.
const WEB_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web with DuckDuckGo. Returns titles, links and short snippets of the top results.", parameters: { type: "object", properties: { query: { type: "string", description: "What to search for, worded like you'd type it into a search engine" } }, required: ["query"] } } },
  { type: "function", function: { name: "fetch_page", description: "Read a web page as plain text. Use it on a link from web_search when the snippets don't hold the answer.", parameters: { type: "object", properties: { url: { type: "string", description: "The page's full http(s) address" } }, required: ["url"] } } },
];

// ── Small helpers ──
const fail = (status, message) => Object.assign(new Error(message), { status });
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
function cors(origin) {
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-gate-key, x-reply-id", "access-control-max-age": "600" } : {};
}
function send(res, status, body, origin) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "Origin", ...cors(origin) });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw fail(413, "That's too much to send at once. Attach fewer or smaller files.");
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw fail(400, "Bad JSON"); }
}

// ── Models ──
// The installed list, asked of Ollama at most every 30 seconds.
let tagCache = { at: 0, models: [] };
async function models() {
  if (Date.now() - tagCache.at < 30000) return tagCache.models;
  const r = await fetch(OLLAMA + "/api/tags", { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r || !r.ok) throw fail(502, "Ollama isn't answering on the laptop");
  const j = await r.json().catch(() => ({}));
  const list = (j.models || [])
    .filter((m) => !ONLY.length || ONLY.includes(m.name))
    .map((m) => ({ name: m.name, size: m.size, details: { parameter_size: m.details?.parameter_size } }));
  tagCache = { at: Date.now(), models: list };
  return list;
}

// ── The AI Pool ──
let poolBase = null, poolLookedAt = 0;
function poolUrl() {
  if (/^(off|no|false|0)$/i.test(POOL_SETTING)) return null;
  if (POOL_SETTING) return POOL_SETTING.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!poolBase && Date.now() - poolLookedAt > 60000) {
    poolLookedAt = Date.now();
    try {
      const ip = execFileSync("tailscale", ["ip", "-4"], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0].trim();
      if (/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) poolBase = `http://${ip}:8090`;
    } catch {}
  }
  return poolBase;
}
// What the pool's brain is doing: "up", "loading" (llama-server answers 503 while it loads) or "off".
let poolCache = { at: 0, s: null };
async function pool(fresh = false) {
  const base = poolUrl();
  if (!base) return null;
  if (!fresh && poolCache.s && Date.now() - poolCache.at < 10000) return poolCache.s;
  const h = await fetch(base + "/health", { signal: AbortSignal.timeout(2500) }).catch(() => null);
  const state = !h ? "off" : h.ok ? "up" : h.status === 503 ? "loading" : "off";
  let file = poolCache.s?.file || "";
  if (state === "up") {
    const j = await fetch(base + "/v1/models", { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).catch(() => null);
    file = String(j?.data?.[0]?.id || file).replace(/^.*[\\/]/, "");
  }
  const name = file.replace(/\.gguf$/i, "");
  // Quant suffix off first (".Q4_K_M", "-Q4_K_M"), then an "org_" prefix: Qwen2.5-14B-Instruct-abliterated, Qwen3-14B-abliterated.
  const short = name.replace(/[-_.](I?Q\d\w*|F16|BF16|F32)$/i, "").replace(/^[A-Za-z0-9-]+?_(?=[A-Za-z])/, "");
  const params = (name.match(/(?:^|[-_.])(\d+(?:\.\d+)?)B(?![a-z])/i) || [])[1];
  poolCache = { at: Date.now(), s: { base, state, file, label: short || "the pool's model", params: params ? params + "B" : "" } };
  return poolCache.s;
}
// The Ollama model that answers when the pool can't.
async function poolFallback() {
  const names = (await models()).map((m) => m.name).filter((n) => !/embed|bge|nomic/i.test(n));
  if (POOL_FALLBACK && names.includes(POOL_FALLBACK)) return POOL_FALLBACK;
  for (const re of [/^qwen3(?!.*(instruct|coder))/i, /qwen3/i, /gemma3/i, /llama3/i]) { const hit = names.find((n) => re.test(n)); if (hit) return hit; }
  return names[0] || null;
}
// Ollama's chat body, in the OpenAI shape llama-server takes. The pool has no eyes, so images stay behind.
function toOpenAI(o) {
  let n = 0; const open = [];
  const messages = o.messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      const tool_calls = m.tool_calls.map((t) => { const id = "call_" + n++; open.push(id); const a = t.function.arguments; return { id, type: "function", function: { name: t.function.name, arguments: typeof a === "string" ? a : JSON.stringify(a ?? {}) } }; });
      return { role: "assistant", content: m.content || "", tool_calls };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: open.shift() || "call_" + n++, content: m.content };
    return { role: m.role, content: m.content };
  });
  // cache_prompt: llama-server reuses the part of the prompt it read last time (Rosin keeps its prompt's start the same).
  const out = { model: "pool", messages, stream: true, max_tokens: MAX_REPLY_TOKENS, cache_prompt: true };
  const opt = o.options || {};
  if (opt.temperature !== undefined) out.temperature = opt.temperature;
  if (opt.repeat_penalty !== undefined) out.repeat_penalty = opt.repeat_penalty;   // llama-server takes it as is
  if (opt.stop) out.stop = opt.stop;
  if (o.tools) out.tools = o.tools;
  return out;
}

// ── Checking a chat request ──
async function cleanChat(b) {
  const model = String(b.model || "");
  if (model === "pool" ? !poolUrl() : !(await models()).some((m) => m.name === model)) throw fail(400, `There's no model called ${model || "(none)"} here.`);
  if (!Array.isArray(b.messages) || !b.messages.length) throw fail(400, "No messages");
  if (b.messages.length > MAX_MESSAGES) throw fail(413, "This chat is too long. Start a new chat.");
  let text = 0, images = 0;
  const messages = b.messages.map((m) => {
    const role = m && ["system", "user", "assistant", "tool"].includes(m.role) ? m.role : null;
    if (!role || typeof m.content !== "string") throw fail(400, "Bad message");
    text += m.content.length;
    const out = { role, content: m.content };
    if (role === "tool" && typeof m.tool_name === "string") out.tool_name = m.tool_name.slice(0, 40);
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      out.tool_calls = m.tool_calls.slice(0, 8).map((t) => ({ function: { name: String(t?.function?.name || "").slice(0, 40), arguments: t?.function?.arguments ?? {} } }));
      text += JSON.stringify(out.tool_calls).length;
    }
    if (Array.isArray(m.images) && m.images.length) {
      out.images = m.images.map((img) => {
        if (typeof img !== "string" || img.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(img)) throw fail(400, "Bad image");
        return img;
      });
      images += out.images.length;
    }
    return out;
  });
  if (text > MAX_TEXT) throw fail(413, "This chat has too much text in it. Attach fewer files, or start a new chat.");
  if (images > MAX_IMAGES) throw fail(413, `Up to ${MAX_IMAGES} images per chat. Start a new chat for more.`);
  const numCtx = Math.round(Number(b.options?.num_ctx) || 0);
  const options = { num_predict: MAX_REPLY_TOKENS };
  if (numCtx) options.num_ctx = Math.min(Math.max(numCtx, 2048), MAX_CTX);
  // A few sampling settings the pages may set, kept within sane bounds.
  const num = (v, lo, hi) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, +v)) : undefined);
  const temperature = num(b.options?.temperature, 0, 1.5), repeat = num(b.options?.repeat_penalty, 1, 1.5);
  if (temperature !== undefined) options.temperature = temperature;
  if (repeat !== undefined) options.repeat_penalty = repeat;
  if (Array.isArray(b.options?.stop)) {
    const stop = b.options.stop.filter((x) => typeof x === "string" && x && x.length <= 40).slice(0, 6);
    if (stop.length) options.stop = stop;
  }
  const out = { model, messages, stream: true, keep_alive: "30m", options };
  // Qwen3 thinks out loud by default and can spend the whole turn on it, which reads as no answer at all.
  if (/^qwen3(?!.*(instruct|coder))/i.test(model)) out.think = false;
  if (Array.isArray(b.tools) && b.tools.length) out.tools = WEB_TOOLS;
  return out;
}

// ── Chatting ──
// A chat that sends an X-Reply-Id keeps going on the laptop even if the browser
// drops off (a phone locking, a tab being put to sleep, Wi-Fi blinking). Every
// line of the reply is kept here for 10 minutes after it ends, and
// GET /api/reply?id=…&from=N sends the rest from line N, then follows it live.
// POST /api/stop?id=… stops it. Without an id, hanging up stops the reply, as before.
const REPLIES = new Map();          // id -> { lines, done, stop, listeners, at }
const KEEP_REPLY_MS = 10 * 60 * 1000;
const MAX_REPLIES = 50;
const replyId = (v) => (/^[A-Za-z0-9_-]{8,64}$/.test(String(v || "")) ? String(v) : null);
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of REPLIES) if (r.done && now - r.at > KEEP_REPLY_MS) REPLIES.delete(id);
}, 60000).unref();

let waiting = 0;
// `tries` is a list of { kind: "ollama" | "pool", body, note? }: the first that starts answering wins.
function startReply(tries, id) {
  const r = { lines: [], done: false, stop: new AbortController(), listeners: new Set(), at: Date.now() };
  if (id) {
    REPLIES.set(id, r);
    while (REPLIES.size > MAX_REPLIES) {
      const old = [...REPLIES].find(([, x]) => x.done) || REPLIES.entries().next().value;
      REPLIES.delete(old[0]);
    }
  }
  const push = (line) => { r.lines.push(line); for (const fn of r.listeners) fn(); };
  const finish = () => { r.done = true; r.at = Date.now(); for (const fn of r.listeners) fn(); };
  waiting++;
  r.ready = (async () => {
    let res, why = "", last = null;
    for (let i = 0; i < tries.length; i++) {
      const t = typeof tries[i] === "function" ? await tries[i](why) : tries[i];
      if (!t) continue;
      const isPool = t.kind === "pool";
      // The pool gets POOL_WAIT_MS to start answering (a big prompt on a split model is slow to read).
      const ac = new AbortController(), onStop = () => ac.abort();
      r.stop.signal.addEventListener("abort", onStop, { once: true });
      const timer = isPool ? setTimeout(() => ac.abort(), POOL_WAIT_MS) : null;
      try {
        res = isPool
          ? await fetch(t.base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toOpenAI(t.body)), signal: ac.signal })
          : await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t.body), signal: ac.signal });
      } catch (e) {
        res = null;
        if (r.stop.signal.aborted) { waiting--; finish(); return { status: 499 }; }
        why = isPool ? (ac.signal.aborted ? "took too long to start" : "isn't answering") : "";
        last = { status: 502, error: isPool ? "The AI Pool isn't answering." : "Ollama isn't answering on the laptop" };
        continue;
      } finally { clearTimeout(timer); }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        const msg = typeof j.error === "string" ? j.error : j.error?.message || "";
        why = isPool ? (/context|too long|exceed/i.test(msg) ? "can't fit this chat" : `answered ${res.status}`) : "";
        last = { status: res.status >= 400 && res.status < 500 ? res.status : 502, error: msg || `${isPool ? "The AI Pool" : "Ollama"} answered ${res.status}` };
        res = null; continue;
      }
      if (t.note) push(JSON.stringify({ note: t.note, model: t.body.model }));
      // From here the reply streams; pump it into r.lines whether or not anyone is listening.
      (isPool ? pumpPool : pumpOllama)(res, push, r.stop.signal).finally(() => { r.stop.signal.removeEventListener("abort", onStop); waiting--; finish(); });
      return { status: 200 };
    }
    waiting--; finish();
    return last || { status: 502, error: "Nothing on the laptop could answer." };
  })();
  return r;
}
async function* lines(res) {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of Readable.fromWeb(res.body)) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) yield line; }
  }
  const rest = (buf + dec.decode()).trim(); if (rest) yield rest;
}
async function pumpOllama(res, push, stop) {
  try { for await (const line of lines(res)) push(line); }
  catch { if (!stop.aborted) push(JSON.stringify({ error: "The laptop lost the reply partway through." })); }
}
// llama-server's OpenAI stream ("data: {...}" lines), turned into Ollama's NDJSON so the pages need nothing new.
async function pumpPool(res, push, stop) {
  const calls = [];
  let timings = null, ended = false;
  const msg = (m) => push(JSON.stringify({ model: "pool", message: { role: "assistant", content: "", ...m }, done: false }));
  try {
    for await (const raw of lines(res)) {
      const line = raw.replace(/^data:\s*/, "");
      if (!line || line.startsWith(":")) continue;
      if (line === "[DONE]") break;
      let c; try { c = JSON.parse(line); } catch { continue; }
      if (c.error) { push(JSON.stringify({ error: "The AI Pool: " + (c.error.message || c.error) })); ended = true; break; }
      if (c.timings) timings = c.timings;
      const d = c.choices?.[0]?.delta || {};
      if (d.reasoning_content) msg({ thinking: d.reasoning_content });
      if (d.content) msg({ content: d.content });
      for (const t of d.tool_calls || []) {
        const k = t.index ?? calls.length;
        calls[k] ||= { name: "", args: "" };
        if (t.function?.name) calls[k].name += t.function.name;
        if (t.function?.arguments) calls[k].args += t.function.arguments;
      }
    }
  } catch {
    if (!stop.aborted) { push(JSON.stringify({ error: "The AI Pool lost the reply partway through." })); ended = true; }
  }
  if (ended || stop.aborted) return;
  const tool_calls = calls.filter((t) => t && t.name).map((t) => { let a = {}; try { a = JSON.parse(t.args || "{}"); } catch {} return { function: { name: t.name, arguments: a } }; });
  if (tool_calls.length) msg({ tool_calls });
  const done = { model: "pool", message: { role: "assistant", content: "" }, done: true };
  if (timings?.predicted_n && timings?.predicted_ms) { done.eval_count = timings.predicted_n; done.eval_duration = Math.round(timings.predicted_ms * 1e6); }
  push(JSON.stringify(done));
}
// Sends a reply's lines from `from` on, and keeps following it until it's done or the browser hangs up.
function follow(r, from, req, res, origin, onHangUp) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", vary: "Origin", ...cors(origin) });
  let sent = Math.max(0, Math.min(from, r.lines.length));
  return new Promise((done) => {
    const pump = () => {
      while (sent < r.lines.length) res.write(r.lines[sent++] + "\n");
      if (r.done) { cleanup(); res.end(); done(); }
    };
    const cleanup = () => r.listeners.delete(pump);
    res.on("close", () => { cleanup(); if (!r.done && onHangUp) onHangUp(); done(); });
    r.listeners.add(pump);
    pump();
  });
}
async function chat(req, res, origin) {
  const body = await cleanChat(await readJson(req));
  const id = replyId(req.headers["x-reply-id"]);
  if (id && REPLIES.has(id)) throw fail(409, "That reply id is already in use.");
  if (waiting >= MAX_WAITING) throw fail(503, "The laptop is busy with other people's chats. Try again in a minute.");
  const r = startReply(await plan(body), id);
  const first = await r.ready;
  if (first.status !== 200) { if (id) REPLIES.delete(id); if (first.status === 499) return res.end(); throw fail(first.status, first.error); }
  // With an id the reply carries on if the browser leaves; without one, hanging up stops it.
  await follow(r, 0, req, res, origin, id ? null : () => r.stop.abort());
}
// Which backends to try, in order. For the pool: the pool if it's up, then an Ollama model with a note.
async function plan(body) {
  if (body.model !== "pool") return [{ kind: "ollama", body }];
  const p = await pool(true);
  const images = body.messages.some((m) => m.images?.length);
  const backup = async (why) => {
    const name = await poolFallback().catch(() => null);
    if (!name) return null;
    const b = { ...body, model: name };
    if (/^qwen3(?!.*(instruct|coder))/i.test(name)) b.think = false;   // the pool doesn't think out loud, so its stand-in doesn't either
    return { kind: "ollama", body: b, note: `The AI Pool ${why || "isn't answering"}, so ${name} answered instead.` };
  };
  if (!p || p.state !== "up") return [() => backup(p?.state === "loading" ? "is still loading its model" : "is off")];
  const poolBody = { ...body, messages: body.messages.map(({ images, ...m }) => m) };
  return [{ kind: "pool", base: p.base, body: poolBody, note: images ? "The AI Pool can't see images, so it only read the text." : "" }, backup];
}
async function resume(url, req, res, origin) {
  const r = REPLIES.get(replyId(url.searchParams.get("id")) || "");
  if (!r) throw fail(404, "The laptop doesn't have that reply any more.");
  await follow(r, Number(url.searchParams.get("from")) || 0, req, res, origin, null);
}
function stopReply(url, res, origin) {
  const r = REPLIES.get(replyId(url.searchParams.get("id")) || "");
  if (r && !r.done) r.stop.abort();
  return send(res, 200, { ok: true, stopped: !!r }, origin);
}

// ── Speech to text ──
async function transcribe(req, res, origin) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = { "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" }[type];
  if (!ext) throw fail(415, "Send the recording as webm, ogg, mp4 or wav audio.");
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_AUDIO) throw fail(413, "That recording is too long. Keep it under a few minutes."); chunks.push(c); }
  if (size < 200) return send(res, 200, { text: "" }, origin);
  const form = new FormData();
  form.append("file", new Blob([Buffer.concat(chunks)], { type }), "speech." + ext);
  form.append("model", WHISPER_MODEL);
  if (WHISPER_LANGUAGE) form.append("language", WHISPER_LANGUAGE);
  form.append("response_format", "json");
  const r = await fetch(WHISPER + "/v1/audio/transcriptions", { method: "POST", body: form, signal: AbortSignal.timeout(90000) }).catch(() => null);
  if (!r) throw fail(502, "The laptop's Whisper server isn't answering. Its setup is on tavernworks.dev/local-ai/.");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(502, "The laptop's Whisper server said: " + String(j.detail || j.error?.message || j.error || r.status).slice(0, 200));
  return send(res, 200, { text: String(j.text || "").trim() }, origin);
}

// ── Text to speech ──
let ttsCache = { at: 0, ok: false };
async function ttsReady() {
  if (Date.now() - ttsCache.at < 60000) return ttsCache.ok;
  const j = await fetch(TTS + "/v1/models", { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : null), () => null);
  const ok = !!j && Array.isArray(j.data) && j.data.some((m) => m && m.id === TTS_MODEL);
  ttsCache = { at: Date.now(), ok };
  return ok;
}
async function speak(req, res, origin) {
  const b = await readJson(req);
  const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_SPEAK_CHARS);
  if (!text) throw fail(400, "Nothing to say.");
  const voice = TTS_VOICES.includes(b.voice) ? b.voice : TTS_VOICES[0];
  const speed = Math.min(2, Math.max(0.5, Number(b.speed) || 1));
  const r = await fetch(TTS + "/v1/audio/speech", {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: "mp3", speed }),
  }).catch(() => null);
  if (!r) { ttsCache.at = 0; throw fail(502, "The laptop's voice server isn't answering. Its setup is on tavernworks.dev/local-ai/#voices."); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    ttsCache.at = 0;
    throw fail(502, "The laptop's voice server said: " + String(j.detail || j.error?.message || j.error || r.status).slice(0, 200));
  }
  const audio = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length, "cache-control": "no-store", vary: "Origin", ...cors(origin) });
  res.end(audio);
}

// ── Web search ──
async function search(url, res, origin) {
  const q = new URLSearchParams();
  if (url.pathname === "/search") {
    q.set("q", String(url.searchParams.get("q") || "").slice(0, 300));
    q.set("n", String(Math.min(10, Math.max(1, Number(url.searchParams.get("n")) || 5))));
  } else q.set("url", String(url.searchParams.get("url") || "").slice(0, 2000));
  const r = await fetch(`${SEARCH}${url.pathname}?${q}`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!r) throw fail(502, "The search server isn't answering on the laptop");
  const j = await r.json().catch(() => ({ error: "The search server sent back nonsense" }));
  return send(res, r.status, j, origin);
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  const origin = ORIGINS.includes(req.headers.origin) ? req.headers.origin : null;
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") return send(res, origin ? 204 : 403, {}, origin);
    // Browsers on other sites are turned away; scripts without an Origin header still hit the rate limits.
    if (req.headers.origin && !origin) return send(res, 403, { error: "This site isn't allowed to use the Local AI gate" }, null);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const [ollama, search, whisper] = await Promise.all([
        fetch(OLLAMA + "/api/version", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        fetch(SEARCH + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        fetch(WHISPER + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
      ]);
      const voices = await ttsReady();
      return send(res, 200, { ok: true, gate: "Local AI", locked: true, keySet: !!KEY_HASH, ollama, search, whisper, voices, pool: !!poolUrl() }, origin);
    }
    // Everything past here needs the key.
    if (!KEY_HASH) return send(res, 503, { error: "The laptop's gate has no key set up yet, so it's closed. See the gate's README to add one.", locked: true }, origin);
    const badKey = "badkey:" + clientIp(req);
    const recentBad = (hits.get(badKey) || []).filter((t) => Date.now() - t < BAD_KEY_PER_IP.ms).length;
    if (recentBad >= BAD_KEY_PER_IP.n) return send(res, 429, { error: "Too many wrong keys from here. Wait ten minutes.", locked: true }, origin);
    if (!keyOk(req)) {
      if (req.headers["x-gate-key"]) allowed(badKey, BAD_KEY_PER_IP);
      return send(res, 401, { error: req.headers["x-gate-key"] ? "That laptop key is wrong." : "This laptop is locked. Enter its key on this device.", locked: true }, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/tags") {
      const [list, p] = await Promise.all([models().catch((e) => e), pool()]);
      if (list instanceof Error && !p) throw list;
      const out = list instanceof Error ? [] : list.slice();
      // The pool is listed even when it's off, so a page that picked it keeps it; the gate falls back to Ollama.
      if (p) out.unshift({ name: "pool", size: 0, details: { parameter_size: p.params }, pool: { state: p.state, label: p.label, file: p.file } });
      return send(res, 200, { models: out, ollama: !(list instanceof Error) }, origin);
    }
    if (req.method === "GET" && (url.pathname === "/search" || url.pathname === "/fetch")) {
      if (!allowed("search:" + clientIp(req), SEARCH_PER_IP)) return send(res, 429, { error: "Too many searches. Wait a few minutes." }, origin);
      return await search(url, res, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/reply") return await resume(url, req, res, origin);
    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      if (!allowed("hear:" + clientIp(req), HEAR_PER_IP)) return send(res, 429, { error: "Too much talking at once. Wait a few minutes." }, origin);
      return await transcribe(req, res, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/voices") return send(res, 200, { ready: await ttsReady(), model: TTS_MODEL, voices: TTS_VOICES }, origin);
    if (req.method === "POST" && url.pathname === "/api/speak") {
      if (!allowed("speak:" + clientIp(req), SPEAK_PER_IP)) return send(res, 429, { error: "Rosin's been talking a lot. Wait a few minutes." }, origin);
      return await speak(req, res, origin);
    }
    if (req.method === "POST" && url.pathname === "/api/stop") return stopReply(url, res, origin);
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!allowed("chat:" + clientIp(req), CHAT_PER_IP)) return send(res, 429, { error: "You're going fast. Wait a few minutes, then try again." }, origin);
      if (!allowed("all", CHAT_ALL)) return send(res, 429, { error: "The laptop has had a busy night. Try again in a few minutes." }, origin);
      return await chat(req, res, origin);
    }
    return send(res, 404, { error: "Not here" }, origin);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(new Date().toISOString(), url.pathname, e.message);
    if (res.headersSent) return res.end();
    return send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the laptop" }, origin);
  }
});
server.requestTimeout = 0;   // long replies stream for minutes

server.listen(PORT, HOST, () => console.log(`Local AI gate on http://${HOST}:${PORT} (Ollama ${OLLAMA}, search ${SEARCH}, Whisper ${WHISPER}, allowing ${ORIGINS.join(", ")}, AI Pool ${poolUrl() || "off"}, ${KEY_HASH ? "locked with a key" : "NO KEY SET UP: every chat is turned away"})`));
