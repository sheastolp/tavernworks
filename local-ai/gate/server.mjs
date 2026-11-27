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
//                         (images on a message reach the pool when it has its vision file, see pool-eyes.sh)
//                         model "pool" goes to the AI Pool's brain (llama-server on :8090), turned
//                         into the same NDJSON; if the pool is off or fails, an Ollama model answers
//                         instead and the stream starts with a { note } line saying so
//   POST /api/transcribe  audio (webm, ogg, mp4, wav)  ->  { text }, from the Whisper server (speaches)
//   GET  /api/voices      the laptop's natural voices (Kokoro, through speaches), and whether they're ready
//   POST /api/speak       { text, voice, speed }  ->  mp3 of Rosin saying it, from the same speaches server
//   GET  /search?q=…&n=5  passed to the web search server
//   GET  /fetch?url=…     passed to the web search server
//   GET  /api/ics?url=…   a calendar's iCal feed (https or webcal), for Rosin's mood compass; browsers can't read most
//                         feeds themselves (no CORS), so the gate fetches it. Only public https hosts, at most 3 MB.
//   GET  /api/self        Rosin's changes: drafts in progress, its pull requests in every repo the GitHub token reaches,
//                         and those repos (needs a GitHub token)
//   POST /api/self/draft   { request, context?, from?, repo? }: a model here drafts the change (in `repo`, or the repo the
//                          request names, else Rosin's own), the gate checks it and opens a pull request. Workflows,
//                          secrets, settings and the gate itself are never touched. /approve, /reject, /undo, /diff take
//                          { repo, pr }; /retry and /dismiss take { id }; /repos lists the repos. Nothing merges until /approve.
//   POST /api/google/…   Rosin and Sheamus's Google (set up with `node server.mjs google-setup`, see README.md):
//                        status, gmail/search, gmail/read, calendar/events, drive/search, drive/read answer straight
//                        away; prepare { kind: send|reply|change|event, … } only keeps the exact action and returns it
//                        with an id, and confirm { id, as } runs it (the page calls that only when Sheamus taps).
//   GET  /api/video/status  whether AI video making is connected (GATE_VIDEO_URL), and why not
//   POST /api/video/make    { prompt, seconds?, width?, height? }  ->  the finished video, from the video backend that
//                           GATE_VIDEO_URL names (meant for the AI Pool split; off until it's set)
//   GET  /api/reply?id=…&from=N   the rest of a reply the browser lost hold of
//   POST /api/stop?id=…           stop that reply
//
// Everything but /health needs the laptop's key in an X-Gate-Key header, so
// only Sheamus's own devices can use it. The key is read at start from the
// systemd credential "gate-key" (see README.md), or GATE_KEY_FILE, or GATE_KEY.
// With no key set up, the gate turns every chat away.
//
//   node server.mjs       run the gate (default port 8793)
//   node server.mjs google-setup   sign in to Google once and keep the refresh token on the laptop
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import vm from "node:vm";

const PORT = Number(process.env.GATE_PORT || 8793);
const HOST = process.env.GATE_HOST || "127.0.0.1";
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const SEARCH = (process.env.SEARCH_URL || "http://127.0.0.1:8791").replace(/\/$/, "");
// Speech to text for Rosin when the browser can't do it: an OpenAI-style Whisper server (speaches, see
// bot-host/README.md), port 8000 on this laptop by default.
const WHISPER = (process.env.WHISPER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "").replace(/\/v1$/, "");
const WHISPER_MODEL = process.env.WHISPER_MODEL || "Systran/faster-distil-whisper-small.en";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "en";
const WHISPER_PROMPT = process.env.WHISPER_PROMPT || "Hey Rosin, it's Sheamus. Stoned Sheamus, Tavernworks, Twitch, OBS, Legion Go, GuildScribe.";
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
// Making new videos with AI: a slot for the AI Pool split (the GTX 1650 alone can't run a video model).
// GATE_VIDEO_URL is the backend's address. It answers GET /health, and POST /generate with JSON
// { prompt, seconds, width, height } -> the video itself (video/mp4 or video/webm), or JSON { error }.
// Unset (or anything but an http(s) address): not connected, and the app says it needs the pool split.
const VIDEO_URL = /^https?:\/\//.test(String(process.env.GATE_VIDEO_URL || "").trim()) ? String(process.env.GATE_VIDEO_URL).trim().replace(/\/+$/, "") : "";
const VIDEO_WAIT_MS = Number(process.env.GATE_VIDEO_WAIT_MS || 20 * 60000);   // a video model can take many minutes
const MAX_VIDEO_OUT = 200 * 1024 * 1024;
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
const VIDEO_PER_IP = { n: 6, ms: 10 * 60 * 1000 };    // AI videos made (once the AI Pool split has a video backend)

// The chat's two web tools. A page's own version of these is never used: the model gets these, and,
// once Google is set up here, Rosin's Google tools (see pickTools). Nothing else goes through.
const WEB_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web with DuckDuckGo. Returns titles, links and short snippets of the top results.", parameters: { type: "object", properties: { query: { type: "string", description: "What to search for, worded like you'd type it into a search engine" } }, required: ["query"] } } },
  { type: "function", function: { name: "fetch_page", description: "Read a web page as plain text. Use it on a link from web_search when the snippets don't hold the answer.", parameters: { type: "object", properties: { url: { type: "string", description: "The page's full http(s) address" } }, required: ["url"] } } },
];

// Rosin's Google tools (rosin/rosin-google.js) come from the page and go to the model when Google is set up here.
// They only ask; the page runs them through /api/google, where nothing sends or changes without Sheamus's tap.
const GOOGLE_TOOL_NAMES = new Set(["gmail_search", "gmail_read", "email_write", "email_change", "calendar_list", "calendar_add", "drive_search", "drive_read"]);
function pickTools(asked) {
  const names = asked.map((t) => String(t?.function?.name || ""));
  const out = WEB_TOOLS.filter((t) => names.includes(t.function.name));
  for (const t of asked) {
    const f = t?.function, name = String(f?.name || "");
    if (!GOOGLE_TOOL_NAMES.has(name) || !GOOGLE || out.some((x) => x.function.name === name)) continue;
    const params = f.parameters && typeof f.parameters === "object" && f.parameters.type === "object" ? f.parameters : null;
    if (!params || JSON.stringify(params).length > 2000) continue;
    out.push({ type: "function", function: { name, description: String(f.description || "").slice(0, 400), parameters: params } });
  }
  return out.length ? out : WEB_TOOLS;   // older pages ask with other names: they get the web tools, as before
}

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
  let file = poolCache.s?.file || "", vision = !!poolCache.s?.vision;
  if (state === "up") {
    const j = await fetch(base + "/v1/models", { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).catch(() => null);
    file = String(j?.data?.[0]?.id || file).replace(/^.*[\\/]/, "");
    // Eyes: llama-server started with --mmproj (a vision projector) says so in /props, and in /v1/models on newer builds.
    const props = await fetch(base + "/props", { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).catch(() => null);
    vision = !!(props?.modalities?.vision || (j?.models || []).some((m) => (m.capabilities || []).includes("multimodal")));
  } else if (state === "off") vision = false;
  const name = file.replace(/\.gguf$/i, "");
  // Quant suffix off first (".Q4_K_M", "-Q4_K_M"), then an "org_" prefix: Qwen2.5-14B-Instruct-abliterated, Qwen3-14B-abliterated.
  const short = name.replace(/[-_.](I?Q\d\w*|F16|BF16|F32)$/i, "").replace(/^[A-Za-z0-9-]+?_(?=[A-Za-z])/, "");
  const params = (name.match(/(?:^|[-_.])(\d+(?:\.\d+)?)B(?![a-z])/i) || [])[1];
  poolCache = { at: Date.now(), s: { base, state, file, vision, label: short || "the pool's model", params: params ? params + "B" : "" } };
  return poolCache.s;
}
// The Ollama model that answers when the pool can't.
async function poolFallback() {
  const names = (await models()).map((m) => m.name).filter((n) => !/embed|bge|nomic/i.test(n));
  if (POOL_FALLBACK && names.includes(POOL_FALLBACK)) return POOL_FALLBACK;
  for (const re of [/^qwen3(?!.*(instruct|coder))/i, /qwen3/i, /gemma3/i, /llama3/i]) { const hit = names.find((n) => re.test(n)); if (hit) return hit; }
  return names[0] || null;
}
// What kind of picture a base64 image is, from its first bytes (the pages send JPEG, but a pasted PNG can come through).
function imageType(b64) {
  return b64.startsWith("/9j/") ? "image/jpeg" : b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("UklGR") ? "image/webp" : b64.startsWith("R0lGOD") ? "image/gif" : "image/jpeg";
}
// Ollama's chat body, in the OpenAI shape llama-server takes. Images go as image_url parts when the pool has eyes
// (plan() leaves them out when it doesn't).
function toOpenAI(o) {
  let n = 0; const open = [];
  const messages = o.messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      const tool_calls = m.tool_calls.map((t) => { const id = "call_" + n++; open.push(id); const a = t.function.arguments; return { id, type: "function", function: { name: t.function.name, arguments: typeof a === "string" ? a : JSON.stringify(a ?? {}) } }; });
      return { role: "assistant", content: m.content || "", tool_calls };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: open.shift() || "call_" + n++, content: m.content };
    if (m.images?.length) return { role: m.role, content: [
      ...m.images.map((b) => ({ type: "image_url", image_url: { url: `data:${imageType(b)};base64,${b}` } })),
      { type: "text", text: m.content || "" },
    ] };
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
  if (Array.isArray(b.tools) && b.tools.length) out.tools = pickTools(b.tools);
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
    const b = { ...body, model: name, messages: body.messages.map(({ images, ...m }) => m) };   // most stand-ins have no eyes
    if (/^qwen3(?!.*(instruct|coder))/i.test(name)) b.think = false;   // the pool doesn't think out loud, so its stand-in doesn't either
    return { kind: "ollama", body: b, note: `The AI Pool ${why || "isn't answering"}, so ${name} answered instead.` };
  };
  if (!p || p.state !== "up") return [() => backup(p?.state === "loading" ? "is still loading its model" : "is off")];
  // A pool started without its vision file can't take images (llama-server turns the whole chat away), so they stay behind.
  const poolBody = p.vision ? body : { ...body, messages: body.messages.map(({ images, ...m }) => m) };
  const note = images && !p.vision ? "The AI Pool can't see images yet, so it only read the text. Steps: tavernworks.dev/local-ai/#eyes" : "";
  return [{ kind: "pool", base: p.base, body: poolBody, note }, backup];
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
  // Names Whisper would otherwise mishear ("Rosen", "Shamus"); a prompt like this steers its spelling.
  form.append("prompt", WHISPER_PROMPT);
  form.append("response_format", "json");
  const r = await fetch(WHISPER + "/v1/audio/transcriptions", { method: "POST", body: form, signal: AbortSignal.timeout(90000) }).catch(() => null);
  if (!r) throw fail(502, "The laptop's Whisper server isn't answering. Its setup is on tavernworks.dev/local-ai/.");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(502, "The laptop's Whisper server said: " + String(j.detail || j.error?.message || j.error || r.status).slice(0, 200));
  return send(res, 200, { text: String(j.text || "").trim() }, origin);
}

// ── Making videos (the AI Pool split's job, once it has a video backend) ──
const VIDEO_OFF = "Making videos with AI needs the AI Pool split. No video backend is connected yet.";
async function videoStatus() {
  if (!VIDEO_URL) return { ready: false, connected: false, why: VIDEO_OFF };
  const r = await fetch(VIDEO_URL + "/health", { signal: AbortSignal.timeout(4000) }).catch(() => null);
  return r && r.ok ? { ready: true, connected: true } : { ready: false, connected: true, why: "The video backend is set up but isn't answering right now." };
}
async function videoMake(req, res, origin) {
  if (!VIDEO_URL) throw fail(503, VIDEO_OFF);
  const b = await readJson(req);
  const prompt = String(b.prompt || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!prompt) throw fail(400, "Say what the video should show.");
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  const body = { prompt, seconds: clamp(b.seconds, 1, 20, 4), width: clamp(b.width, 256, 1280, 720), height: clamp(b.height, 256, 1280, 1280) };
  const r = await fetch(VIDEO_URL + "/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(VIDEO_WAIT_MS) }).catch(() => null);
  if (!r) throw fail(502, "The video backend didn't answer.");
  const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!r.ok || !/^video\/(mp4|webm)$/.test(type)) {
    const j = await r.json().catch(() => ({}));
    throw fail(502, "The video backend said: " + String(j.error || j.detail || r.status).slice(0, 200));
  }
  if (Number(r.headers.get("content-length") || 0) > MAX_VIDEO_OUT) throw fail(502, "The video backend's video is over 200 MB.");
  const chunks = []; let size = 0;
  for await (const c of r.body) { size += c.length; if (size > MAX_VIDEO_OUT) throw fail(502, "The video backend's video is over 200 MB."); chunks.push(c); }
  const out = Buffer.concat(chunks);
  res.writeHead(200, { "content-type": type, "content-length": out.length, "cache-control": "no-store", vary: "Origin", ...cors(origin) });
  res.end(out);
}

// ── Calendar feeds (Rosin's mood compass) ──
const MAX_ICS = 3 * 1024 * 1024;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.ts\.net|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[|::1)/i;
async function icsFeed(url, res, origin) {
  let target;
  try { target = new URL(String(url.searchParams.get("url") || "").trim().replace(/^webcal:/i, "https:")); } catch { throw fail(400, "That isn't a calendar link."); }
  const okHost = (u) => u.protocol === "https:" && !PRIVATE_HOST.test(u.hostname) && !/^[\d.]+$/.test(u.hostname);
  // A public name can still point at the home network or the tailnet, so check where it really goes.
  const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd]|fe[89ab]|::ffff:(127|10|192\.168|169\.254)\.)/i;
  const okAddress = async (host) => {
    const all = await lookup(host, { all: true }).catch(() => []);
    return all.length > 0 && all.every((a) => !PRIVATE_IP.test(a.address));
  };
  let r = null;
  for (let hop = 0; hop < 4; hop++) {   // follows redirects by hand, so none can lead to the laptop's own network
    if (!okHost(target) || !(await okAddress(target.hostname))) throw fail(400, "Use the calendar's https (or webcal) link.");
    r = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(20000), headers: { accept: "text/calendar, */*" } }).catch(() => null);
    if (!r) throw fail(502, "Couldn't reach that calendar.");
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { target = new URL(r.headers.get("location"), target); continue; }
    break;
  }
  if (!r.ok) throw fail(502, `The calendar answered ${r.status}. Check the link.`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_ICS) throw fail(413, "That calendar is too big.");
  const chunks = []; let size = 0;
  for await (const c of r.body) { size += c.length; if (size > MAX_ICS) throw fail(413, "That calendar is too big."); chunks.push(c); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw fail(422, "That link isn't an iCal calendar. Use the iCal (.ics) address.");
  res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", vary: "Origin", ...cors(origin) });
  res.end(text);
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

// ── Rosin changing its own app, and Sheamus's other repos ──
// Rosin (or the Changes panel under ⋯) asks for a change in plain words. A model on this laptop drafts it as small
// search-and-replace edits, the gate checks them, and opens a pull request on GitHub, in Rosin's own repo or any other
// repo the laptop's token can reach. Nothing merges until Sheamus taps Approve in Rosin. Undo puts the files back as they
// were before that change. Workflows, secrets, settings and signing files are never touched. The GitHub token lives only
// on this laptop (systemd credential "github-token").
const SELF_REPO = String(process.env.SELF_UPDATE_REPO || "sheastolp/tavernworks").trim();   // Rosin's own app
const SELF_MODEL = String(process.env.SELF_UPDATE_MODEL || "").trim();   // an Ollama model to draft with when the pool is off
const SELF_PREFIX = "rosin-self/";
const SELF_PATH = /^rosin\/[a-z0-9][a-z0-9-]*\.(js|css|html)$/;       // Rosin's own page files
const SELF_PER_HOUR = { n: 12, ms: 60 * 60 * 1000 };
const SELF_ACTIONS = { n: 60, ms: 10 * 60 * 1000 };
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
// A token pasted over SSH can pick up extra characters: the terminal's bracketed-paste codes (ESC[200~ ... ESC[201~,
// sometimes saved as a literal "^[[200~"), quotes, "Bearer ", spaces or line ends. Keep just the token itself.
function cleanToken(raw) {
  const s = String(raw || ""), bare = s.replace(/\x1b\[[0-9;]*[~A-Za-z]|\^\[\[[0-9;]*~|\[20[01]~/g, " ");
  const found = /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/.exec(bare);
  const k = found ? found[0] : bare.replace(/^\s*(bearer|token)\s+/i, "").replace(/["'`\s\x00-\x1f\x7f]/g, "");
  return { token: k, extra: Math.max(0, s.trim().length - k.length) };
}
function loadGithubToken() {
  const files = [process.env.CREDENTIALS_DIRECTORY && join(process.env.CREDENTIALS_DIRECTORY, "github-token"), process.env.GITHUB_TOKEN_FILE].filter(Boolean);
  let raw = "";
  for (const f of files) { try { raw = readFileSync(f, "utf8"); if (raw.trim()) break; } catch {} }
  if (!raw.trim()) raw = String(process.env.GITHUB_TOKEN || "");
  const { token, extra } = cleanToken(raw);
  const shape = !token ? "none" : /^(github_pat_|gh[pousr]_)/.test(token) ? "ok" : "odd";
  if (extra) console.error(new Date().toISOString(), `github-token: removed ${extra} stray character(s) around the token (paste codes, quotes or spaces).`);
  if (shape === "odd") console.error(new Date().toISOString(), "github-token: this doesn't look like a GitHub token (they start with github_pat_ or ghp_).");
  return { token, extra, shape };
}
const GH_LOADED = loadGithubToken(), GH_TOKEN = GH_LOADED.token;
const NO_TOKEN = "Changes aren't set up on the laptop yet (no GitHub token). Steps: tavernworks.dev/local-ai/#changes";

// One call to GitHub's API. `path` starting with "/repos/" or "/user" or "/search" is used as is.
async function ghApi(path, opt = {}, repo = "") {
  if (!GH_TOKEN) throw fail(503, NO_TOKEN);
  const r = await fetch("https://api.github.com" + path, {
    method: opt.method || "GET", body: opt.body ? JSON.stringify(opt.body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { authorization: "Bearer " + GH_TOKEN, accept: opt.accept || "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "rosin-local-ai-gate", ...(opt.body ? { "content-type": "application/json" } : {}) },
  }).catch(() => null);
  if (!r) throw fail(502, "Couldn't reach GitHub from the laptop.");
  if (opt.raw && r.ok) return r.text();
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    if (opt.okStatus?.includes(r.status)) return null;
    const odd = GH_LOADED.shape === "odd" ? " The saved token doesn't start with github_pat_ or ghp_, so it was probably saved wrong" : "";
    const why = r.status === 401 ? `GitHub doesn't recognise the laptop's token (401: wrong, expired or revoked).${odd || ". The laptop reads the token only when the gate starts, so after fixing the file run: systemctl restart local-ai-gate"}`
      : r.status === 404 ? `the token can't see ${repo || "that"} (404). Add that repo to the token on GitHub`
      : r.status === 403 ? (/rate limit/i.test(j.message || "") ? "too many requests for now (403 rate limit). Try again in a bit" : `the token isn't allowed to do that${repo ? " in " + repo : ""} (403). Give it Contents and Pull requests: Read and write`)
      : String(j.message || r.status).slice(0, 200);
    throw Object.assign(fail(502, "GitHub said no: " + why + "."), { ghStatus: r.status });
  }
  return j;
}
// The same, inside one repo.
const ghr = (repo, path, opt = {}) => ghApi(`/repos/${repo}${path}`, opt, repo);
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
async function fileAt(repo, path, ref) {
  const j = await ghr(repo, `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { okStatus: [404] });
  return j && !Array.isArray(j) ? { text: b64(j.content || ""), sha: j.sha } : null;
}
// One commit with every file at once (null deletes a file); moves `branch` to it, making the branch if asked.
async function commitFiles(repo, parent, files, message, branch, create) {
  const base = await ghr(repo, `/git/commits/${parent}`);
  const tree = await ghr(repo, "/git/trees", { method: "POST", body: { base_tree: base.tree.sha, tree: Object.entries(files).map(([path, text]) => (text === null ? { path, mode: "100644", type: "blob", sha: null } : { path, mode: "100644", type: "blob", content: text })) } });
  const c = await ghr(repo, "/git/commits", { method: "POST", body: { message, tree: tree.sha, parents: [parent] } });
  if (create) await ghr(repo, "/git/refs", { method: "POST", body: { ref: "refs/heads/" + branch, sha: c.sha } });
  else await ghr(repo, `/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: c.sha, force: false } });
  return c.sha;
}

// ── Which repos, and which files in them ──
// The repos the token can push to, newest first (a fine-grained token lists only the repos it was given).
let repoCache = { at: 0, list: null };
async function repoList() {
  if (repoCache.list && Date.now() - repoCache.at < 10 * 60000) return repoCache.list;
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const j = await ghApi(`/user/repos?per_page=100&sort=pushed&page=${page}`);
    all.push(...j);
    if (j.length < 100) break;
  }
  const list = all.filter((r) => !r.archived && !r.disabled && r.permissions?.push !== false && REPO_NAME.test(r.full_name || ""))
    .map((r) => ({ full: r.full_name, name: r.name, desc: String(r.description || "").slice(0, 160), branch: r.default_branch || "main", lang: r.language || "" }));
  if (!list.some((r) => r.full === SELF_REPO)) list.unshift({ full: SELF_REPO, name: SELF_REPO.split("/")[1], desc: "Rosin's own app and tavernworks.dev", branch: "main", lang: "" });
  repoCache = { at: Date.now(), list };
  return list;
}
async function repoInfo(full) {
  const r = (await repoList()).find((x) => x.full.toLowerCase() === String(full).toLowerCase());
  if (!r) throw fail(403, "The laptop's GitHub token can't reach that repo. Add it to the token on GitHub.");
  return r;
}
// Files a change may never touch, in any repo: CI and workflows, anything hidden (.env, .github, .vscode), secrets
// and keys, signing, settings and build configs, and (in Rosin's repo) the laptop gate and its key code.
const NEVER = [
  /(^|\/)\./,                                                   // .github/, .env, .gitignore, .vscode/ and other dotfiles
  /secret|credential|password|passwd|token|apikey|api[-_]key|private[-_]?key/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|gpg|asc|kdbx)$/i,
  /(^|\/)(settings|config|configuration|appsettings|local\.properties|gradle\.properties|google-services|GoogleService-Info)(\.[\w.]+)?$/i,
  /\.(ya?ml|toml|ini|cfg|conf|properties|plist|gradle|gradle\.kts|lock|env)$/i,
  /(^|\/)(package(-lock)?\.json|tsconfig[\w.-]*\.json|manifest\.json|composer\.json|Cargo\.toml|Dockerfile|Makefile|CODEOWNERS|wrangler\.\w+|_headers|_redirects|AndroidManifest\.xml|tauri\.conf\.json|vercel\.json|netlify\.toml)$/i,
  /\.config\.\w+$/i,
  /(^|\/)(node_modules|vendor|dist|build|out|target|\.git)\//i,
];
const NEVER_IN_SELF = [/^local-ai\/gate\//, /(^|\/)gate-key\.js$/, /(^|\/)pwa-sw[\w-]*\.js$/];
const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|css|scss|less|html?|md|markdown|txt|json|py|kt|java|swift|rs|go|rb|php|sh|bash|lua|cs|c|h|cpp|hpp|svg|xml|sql|r|dart|astro)$/i;
function editable(repo, path) {
  if (!path || path.length > 200 || path.includes("..") || !TEXT_EXT.test(path)) return false;
  if (NEVER.some((re) => re.test(path))) return false;
  if (repo === SELF_REPO && NEVER_IN_SELF.some((re) => re.test(path))) return false;
  return true;
}
// Which repo a request means: one it names (or the one picked in the panel), else Rosin's own app.
const REPO_SKIP = new Set("bot bots app apps the and web site page tool tools test demo main api new old my repo code".split(" "));
function inferRepo(text, repos) {
  const low = " " + String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const flat = low.replace(/ /g, "");
  const scored = repos.map((r) => {
    const name = r.name.toLowerCase(), parts = name.split(/[^a-z0-9]+/).filter((p) => p.length >= 4 && !REPO_SKIP.has(p));
    let s = 0;
    if (flat.includes(name.replace(/[^a-z0-9]/g, "")) && name.replace(/[^a-z0-9]/g, "").length >= 4) s += 10;
    for (const p of parts) if (low.includes(" " + p + " ") || low.includes(" " + p)) s += 3;
    return { r, s };
  }).filter((x) => x.s >= 3).sort((a, b) => b.s - a.s);
  if (!scored.length) return { repo: repos.find((r) => r.full === SELF_REPO) || repos[0], guessed: true };
  if (scored[1] && scored[1].s === scored[0].s) return { ask: scored.filter((x) => x.s === scored[0].s).slice(0, 4).map((x) => x.r.name) };
  return { repo: scored[0].r };
}

// ── What the model sees ──
const STOP = new Set("the and for with that this you your can could would should make made want please add put get have has its it's into from them then than when what which also just like more less some any all out are was were but not too very rosin app repo change code file".split(" "));
const ALSO = { button: ["btn", "button"], buttons: ["btn", "button"], colour: ["color"], color: ["color", "#"], bigger: ["font-size", "size"], smaller: ["font-size", "size"], font: ["font"], menu: ["more", "tray", "menu"], settings: ["field", "check", "more", "setting"], voice: ["voice", "speak"], mic: ["mic", "ear"], talk: ["mic"], chat: ["log", "say", "chat"], eye: ["eye"], smoke: ["smoke"], glow: ["glow"], mood: ["mood"], ear: ["antenna", "sway"], ears: ["antenna", "sway"], horn: ["antenna"], antenna: ["antenna", "sway"], antennae: ["antenna", "sway"], wiggle: ["sway"], movement: ["sway", "@keyframes", "animation"], move: ["sway", "animation"], bubble: ["subs"], subtitles: ["subs"], compass: ["compass"], call: ["call"], hint: ["hint"], status: ["status"], command: ["command", "cmd"], commands: ["command", "cmd"] };
function wordsOf(want) {
  const words = new Set();
  for (const w of String(want).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []) if (!STOP.has(w)) { words.add(w.replace(/s$/, "")); for (const x of ALSO[w] || []) words.add(x); }
  return words;
}
function outline(path, text) {
  const names = [];
  text.split("\n").forEach((l, i) => {
    const m = /^\s*(?:export\s+)?(?:async\s+)?(?:function|def|fun|class)\s+(\w+)|^\s*\/\/ -{3,}\s*(.+?)\s*-{3,}|^\s*\/\* -{3,}\s*(.+?)\s*-{3,}|^(#[\w-]+)\s*[,{]|^#{1,3}\s+(.+)$/.exec(l);
    if (m) names.push(`${m[1] || m[2] || m[3] || m[4] || m[5]} (${i + 1})`);
  });
  return `${path}: ${text.split("\n").length} lines${names.length ? ". " + names.slice(0, 80).join(", ") : ""}`;
}
// Code goes to the model with line numbers ("120| …"), so it can name the lines to change instead of having to copy
// them exactly, which a small local model often gets slightly wrong. `shown` records which lines it saw: an edit may
// only touch those. `best` is the line that matches the request best, for the one-part fallback.
const numbered = (lines, a, b) => lines.slice(a, b + 1).map((l, k) => `${a + k + 1}| ${l}`).join("\n");
function pickContext(files, want, whole = [], budget = 11000) {
  const words = wordsOf(want);
  const parts = [], shown = {};
  let used = 0, best = null;
  for (const w of whole) if (files[w] && used + files[w].length < budget) {
    const lines = files[w].split("\n");
    parts.push(`=== ${w} (whole file, lines 1-${lines.length}) ===\n${numbered(lines, 0, lines.length - 1)}`);
    shown[w] = [[1, lines.length]]; used += files[w].length;
  }
  const spots = [];
  for (const [path, text] of Object.entries(files)) {
    text.split("\n").forEach((l, i) => { const low = l.toLowerCase(); let s = 0; for (const w of words) if (low.includes(w)) s += w.length > 4 ? 2 : 1; if (s) spots.push({ path, i, s }); });
  }
  spots.sort((a, b) => b.s - a.s);
  if (spots.length) best = { path: spots[0].path, i: spots[0].i };
  // Each file's best spot first, so one file full of long lines can't crowd out the others.
  const firsts = new Set();
  for (const sp of spots) if (!firsts.has(sp.path)) { firsts.add(sp.path); sp.first = true; }
  spots.sort((a, b) => (b.first ? 1 : 0) - (a.first ? 1 : 0) || b.s - a.s);
  const ranges = {};
  for (const sp of spots) {
    if (whole.includes(sp.path)) continue;
    const list = (ranges[sp.path] ||= []);
    if (list.some(([a, b]) => sp.i >= a && sp.i <= b)) continue;
    const lines = files[sp.path].split("\n");
    let a = Math.max(0, sp.i - 18), b = Math.min(lines.length - 1, sp.i + 18);
    let size = lines.slice(a, b + 1).join("\n").length;
    if (size > 3500) { a = Math.max(0, sp.i - 5); b = Math.min(lines.length - 1, sp.i + 5); size = lines.slice(a, b + 1).join("\n").length; }   // long lines: a narrower window
    if (used + size > budget) continue;
    list.push([a, b]); used += size;
    if (used > budget - 400) break;
  }
  // Nothing matched: show the smallest files whole, so the model has something real to work from.
  if (!spots.length) for (const [path, text] of Object.entries(files).filter(([p]) => !whole.includes(p)).sort((a, b) => a[1].length - b[1].length)) {
    if (used + text.length > budget) continue;
    ranges[path] = [[0, text.split("\n").length - 1]]; used += text.length;
  }
  for (const [path, list] of Object.entries(ranges)) {
    if (!list.length) continue;
    const lines = files[path].split("\n");
    list.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of list) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
    for (const [a, b] of merged) { parts.push(`=== ${path}, lines ${a + 1}-${b + 1} ===\n${numbered(lines, a, b)}`); (shown[path] ||= []).push([a + 1, b + 1]); }
  }
  return { outline: Object.entries(files).map(([p, t]) => outline(p, t)).join("\n"), code: parts.join("\n\n"), shown, best };
}
// Reads the files a change in `repo` may need: Rosin's page files for Rosin, otherwise the editable files whose paths
// best match the request (and the README), up to about 200 KB.
async function loadFiles(repo, head, want) {
  if (repo.full === SELF_REPO) {
    const tree = await ghr(repo.full, `/git/trees/${head}?recursive=1`);
    const paths = (tree.tree || []).filter((t) => t.type === "blob" && editable(repo.full, t.path) && t.size < 400000);
    const words = wordsOf(want);
    // A request about another part of the site (sudoku, the pool, GuildScribe's page) goes to that folder; else Rosin.
    const top = new Map();
    for (const t of paths) { const dir = t.path.split("/")[0].toLowerCase(); if (t.path.includes("/")) for (const w of words) if (w.length >= 4 && dir.includes(w)) top.set(dir, (top.get(dir) || 0) + 1); }
    const other = [...top.entries()].filter(([d]) => d !== "rosin").sort((a, b) => b[1] - a[1])[0];
    if (!other) {
      const files = {};
      for (const t of paths) if (SELF_PATH.test(t.path)) files[t.path] = (await fileAt(repo.full, t.path, head)).text;
      return { files, whole: ["rosin/index.html"], rosin: true, all: paths.map((t) => t.path) };
    }
    return pickFiles(repo, head, paths.filter((t) => t.path.toLowerCase().startsWith(other[0] + "/")), want, paths);
  }
  const tree = await ghr(repo.full, `/git/trees/${head}?recursive=1`);
  const paths = (tree.tree || []).filter((t) => t.type === "blob" && editable(repo.full, t.path) && t.size < 400000);
  if (!paths.length) throw new Error(`${repo.name} has no files Rosin can change (only code and text files, never workflows, secrets or settings).`);
  return pickFiles(repo, head, paths, want, paths);
}
async function pickFiles(repo, head, paths, want, all) {
  const words = [...wordsOf(want)];
  const score = (p) => { const low = p.toLowerCase(); let s = 0; for (const w of words) if (low.includes(w)) s += 3; if (/readme\.md$/i.test(p)) s += 1; s -= p.split("/").length * 0.1; return s; };
  const ranked = paths.slice().sort((a, b) => score(b.path) - score(a.path) || a.size - b.size);
  const files = {};
  let total = 0;
  for (const t of ranked) {
    if (Object.keys(files).length >= 12 || total + t.size > 200000) continue;
    const f = await fileAt(repo.full, t.path, head);
    if (!f) continue;
    files[t.path] = f.text; total += f.text.length;
  }
  return { files, whole: [], rosin: false, all: all.map((t) => t.path) };
}

const DRAFT_FORMAT = [
  "Answer in exactly this format and nothing else:",
  "TITLE: a short title, under 60 characters",
  "SUMMARY: one or two plain sentences for Sheamus saying what will change",
  "FILE: <path exactly as shown>",
  "LINES: <first>-<last>",
  "<<<<<<< NEW",
  "the new lines that take the place of those lines, without line numbers",
  ">>>>>>> END",
  "LINES are the numbers shown at the left of the code (\"120| \"). Give the full new text of every line in that range, changed or not. To add lines without replacing any, write AFTER: <line number> instead of LINES. To delete lines, leave NEW empty.",
  "Repeat FILE, LINES and NEW for every edit. Use only line numbers from the code shown below, and keep the change as small as it can be.",
  "(A SEARCH/REPLACE block also works: <<<<<<< SEARCH, a few lines from the code without their numbers, =======, the new lines, >>>>>>> REPLACE.)",
];
const NEW_FILES = "To make a new file next to the files shown: FILE: <new path>, LINES: new, then the whole file in NEW.";
const DRAFT_LIMITS = [
  "Never touch workflows, CI, secrets, keys, passwords, tokens, settings or build config files, and never add code that sends data somewhere new, runs downloaded code, or removes safety checks.",
  "If the request is unclear, unsafe, or would need code you weren't shown, answer only: CANNOT: and the reason in one plain sentence.",
];

const ROSIN_RULES = [
  "You change the code of Rosin, an AI co-host web page (tavernworks.dev/rosin) that also runs inside Sheamus's Android and Windows apps. Sheamus asked for a change; draft it as small, exact edits.",
  "Files: index.html (the page), layers.js (the art layers), rosin.js (the avatar: face, mood glow, layout), rosin-web.js (chat, voice, mic, call, settings under the ⋯ menu), rosin-compass.js (mood compass), rosin-self.js (the Changes panel), rosin-eyes.js (photos), rosin.css (the look). Settings rows in rosin-web.js are made with field(label, element) and check(label), saved with store.set.",
  ...DRAFT_FORMAT, "Never make new files.", ...DRAFT_LIMITS,
  "Rosin's body: a vine-wrapped orb with one fiery eye, crystal antennae on vines (the .antenna parts, which sway), small crystals around it, and a smoke wisp below. It has no ears, mouth, hands, arms or legs. If Sheamus names a part Rosin doesn't have, use the closest real part only when the match is obvious (ears or horns mean the antennae) and say so in SUMMARY; otherwise answer CANNOT and ask which part he means.",
  "SUMMARY must say exactly what the edits change, in his words where you can (which button, part, setting, by how much), never just repeat the request, so he isn't approving a guess.",
  "It must keep working on a phone and a touchscreen handheld: tap targets at least 44px, nothing wider than the screen.",
  "Never touch the laptop key, the laptop's address, who can use Rosin, the safety rules in the system prompt, or anything that sends data elsewhere. Add no new web addresses, scripts from other sites, eval, cookies or tracking.",
].join("\n");
const repoRules = (r) => [
  `You change the code in Sheamus's GitHub repo ${r.full}${r.desc ? ` (${r.desc})` : ""}${r.lang ? `, mostly ${r.lang}` : ""}. Sheamus asked for a change; draft it as small, exact edits that fit the code's own style.`,
  ...DRAFT_FORMAT, NEW_FILES, ...DRAFT_LIMITS,
  "SUMMARY must say exactly what the edits change (which file, function, button or text), never just repeat the request. If the request names something this code doesn't have, answer CANNOT and ask what he means.",
  "Anything with a screen must keep working on a phone and a touchscreen handheld.",
].join("\n");

const unfence = (s) => String(s).replace(/^```[\w-]*\n/, "").replace(/\n?```\s*$/, "");
// A model sometimes copies the "120| " numbers along with the code. Strip them when most lines have them.
function stripNums(s) {
  const lines = String(s).split("\n"), body = lines.filter((l) => l.trim());
  if (!body.length || body.filter((l) => /^\s*\d{1,5}\s?\|/.test(l)).length < body.length / 2) return s;
  return lines.map((l) => l.replace(/^\s*\d{1,5}\s?\| ?/, "")).join("\n");
}
function parseDraft(text) {
  text = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\r\n/g, "\n");
  const found = [];
  for (const m of text.matchAll(/<<<<<<< ?SEARCH[^\n]*\n([\s\S]*?)\n?=======[^\n]*\n([\s\S]*?)\n?>>>>>>> ?REPLACE[^\n]*/g)) found.push({ at: m.index, end: m.index + m[0].length, search: m[1], replace: m[2] });
  for (const m of text.matchAll(/<<<<<<< ?NEW[^\n]*\n([\s\S]*?)\n?>>>>>>> ?END[^\n]*/g)) found.push({ at: m.index, end: m.index + m[0].length, body: m[1] });
  const cannot = /^\s*CANNOT:\s*(.+)$/mi.exec(text);
  if (!found.length) return cannot ? { cannot: cannot[1].trim().slice(0, 300) } : { error: "No edits in the answer: use FILE, LINES and a NEW block." };
  found.sort((a, b) => a.at - b.at);
  let prevEnd = 0, lastPath = "";
  const edits = found.map((f) => {
    const head = text.slice(prevEnd, f.at), paths = [...text.slice(0, f.at).matchAll(/FILE:\s*\**`?(?:\.\/)?([\w./-]+)`?/g)];
    prevEnd = f.end;
    const path = paths.length ? paths[paths.length - 1][1] : lastPath;
    lastPath = path;
    if (f.body == null) return { path, kind: "search", search: stripNums(unfence(f.search)), replace: stripNums(unfence(f.replace)) };
    const ln = /\b(LINES?|AFTER)\s*:?\s*\**\s*(new|\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?/i.exec(head);
    const range = !ln ? null : /new/i.test(ln[2]) ? { isNew: true }
      : { after: /after/i.test(ln[1]), a: +ln[2], b: ln[3] ? +ln[3] : +ln[2] };
    const body = stripNums(unfence(f.body));
    return { path, kind: "lines", range, text: body };
  });
  const title = (/^\s*\**TITLE:?\**\s*(.+)$/mi.exec(text)?.[1] || "").trim().slice(0, 80);
  const summary = (/^\s*\**SUMMARY:?\**\s*(.+)$/mi.exec(text)?.[1] || "").trim().slice(0, 500);
  return { title, summary, edits };
}

// Loose line matching for SEARCH blocks: spaces, quotes and blank lines don't count, and a close match is accepted
// when it is clearly the best one among the lines the model was shown.
const normLine = (l) => String(l).trim().replace(/[‘’`]/g, "'").replace(/[“”"]/g, "'").replace(/\s+/g, " ").replace(/\s*([{}()[\];,:=<>+*/|&!?-])\s*/g, "$1");
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let both = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2), n = grams.get(g); if (n) { both++; grams.set(g, n - 1); } }
  return (2 * both) / (a.length + b.length - 2);
}
const inShown = (ranges, a, b) => !ranges || ranges.some(([x, y]) => a >= x && b <= y);
function findLines(text, search, shownRanges, where, path) {
  const lines = text.split("\n");
  const want = search.split("\n").map(normLine).filter(Boolean);
  if (!want.length) throw new Error(`${where}: SEARCH is empty. Give LINES instead.`);
  const nb = [];
  lines.forEach((l, i) => { const n = normLine(l); if (n) nb.push({ i, n }); });
  const hits = [], scored = [];
  for (let k = 0; k + want.length <= nb.length; k++) {
    if (want.every((w, j) => nb[k + j].n === w)) { hits.push(k); continue; }
    if (hits.length) continue;
    if (!inShown(shownRanges, nb[k].i + 1, nb[k + want.length - 1].i + 1)) continue;
    let sum = 0, worst = 1;
    for (let j = 0; j < want.length; j++) { const s = dice(want[j], nb[k + j].n); sum += s; if (s < worst) worst = s; }
    scored.push({ k, s: sum / want.length, worst });
  }
  if (hits.length > 1) throw new Error(`${where}: SEARCH matches more than one place. Give LINES instead.`);
  let k = hits[0];
  if (k == null) {
    scored.sort((x, y) => y.s - x.s);
    const [top, next] = scored;
    if (top && top.s >= 0.82 && top.worst >= 0.5 && (!next || next.s < top.s - 0.05)) k = top.k;
    else {
      const near = top && top.s >= 0.35 ? nb[top.k].i : -1;
      const hint = near >= 0 ? ` The closest lines in ${path} are ${near + 1}-${nb[top.k + want.length - 1].i + 1}:\n${numbered(lines, near, Math.min(nb[top.k + want.length - 1].i, near + 11))}` : "";
      throw new Error(`${where}: SEARCH doesn't match the file. Give LINES instead.${hint}`);
    }
  }
  return { start: nb[k].i, end: nb[k + want.length - 1].i + 1 };
}

// `ctx`: { repo, files, rosin, all, shown } — rosin: only Rosin's page files; all: every path in the repo (for new
// files); shown: the line ranges the model saw, per file (an edit may only touch those).
function applyEdits(ctx, edits) {
  const { files } = ctx, out = {};
  const sig = (s) => s.trim().length > 3 && /[A-Za-z0-9]/.test(s);
  const lineEdits = {}, searchEdits = [];
  edits.forEach((e, n) => {
    const where = `Edit ${n + 1} (${e.path || "no file named"})`;
    const known = e.path in files;
    if (ctx.rosin ? !SELF_PATH.test(e.path) || !known : !editable(ctx.repo, e.path)) throw new Error(`${where}: that file can't be changed here. Use one of the files shown, exactly as named.`);
    const makesNew = e.kind === "lines" ? e.range?.isNew : !e.search.trim();
    if (!known) {   // a new file: next to files that exist, and not one that's already there
      if (!makesNew) throw new Error(`${where}: that file isn't one shown. Use a file shown, exactly as named.`);
      if (ctx.all.includes(e.path)) throw new Error(`${where}: that file exists but wasn't shown, so it can't be changed blind.`);
      if (e.path in out) throw new Error(`${where}: that new file is made twice.`);
      out[e.path] = e.kind === "lines" ? e.text : e.replace; return;
    }
    if (makesNew) throw new Error(`${where}: that file already exists. Give LINES from the code shown.`);
    if (e.kind === "search") { searchEdits.push({ e, where }); return; }
    if (!e.range) throw new Error(`${where}: LINES is missing. Give the numbers shown at the left of the code, like LINES: 120-124.`);
    (lineEdits[e.path] ||= []).push({ e, where });
  });
  for (const [path, list] of Object.entries(lineEdits)) {
    const lines = files[path].split("\n"), shown = ctx.shown?.[path];
    const spans = list.map(({ e, where }) => {
      const { a, b, after } = e.range;
      if (after ? a < 0 || a > lines.length : a < 1 || b > lines.length || a > b) throw new Error(`${where}: lines ${a}${after ? "" : "-" + b} are outside the file (it has ${lines.length}).`);
      if (!(after ? inShown(shown, Math.max(a, 1), Math.max(a, 1)) || inShown(shown, a + 1, a + 1) : inShown(shown, a, b))) throw new Error(`${where}: lines ${a}${after ? "" : "-" + b} weren't all shown. Use line numbers from the code shown.`);
      return { e, where, a, b, after, from: after ? a + 0.5 : a, to: after ? a + 0.5 : b };
    }).sort((x, y) => y.from - x.from);
    for (let i = 1; i < spans.length; i++) if (spans[i].to >= spans[i - 1].from) throw new Error(`${spans[i].where}: its lines overlap another edit. Give each part once.`);
    for (const s of spans) {
      const nl = s.e.text === "" ? [] : s.e.text.split("\n");
      if (s.after) {
        if (nl.length && s.a >= 1 && sig(nl[0]) && nl[0].trim() === lines[s.a - 1].trim()) nl.shift();   // repeated the line it goes after
        lines.splice(s.a, 0, ...nl);
      } else {
        // The model often repeats the line just before or after the range: drop those copies.
        if (nl.length && s.a >= 2 && sig(nl[0]) && nl[0].trim() === lines[s.a - 2].trim() && nl[0].trim() !== lines[s.a - 1].trim()) nl.shift();
        if (nl.length && s.b < lines.length && sig(nl[nl.length - 1]) && nl[nl.length - 1].trim() === lines[s.b].trim() && nl[nl.length - 1].trim() !== lines[s.b - 1].trim()) nl.pop();
        lines.splice(s.a - 1, s.b - s.a + 1, ...nl);
      }
    }
    out[path] = lines.join("\n");
  }
  for (const { e, where } of searchEdits) {
    const t = out[e.path] ?? files[e.path];
    const first = t.indexOf(e.search);
    if (first !== -1 && t.indexOf(e.search, first + 1) === -1) { out[e.path] = t.slice(0, first) + e.replace + t.slice(first + e.search.length); continue; }
    // Line numbers have moved if a LINES edit already changed this file, so the shown ranges no longer apply.
    const { start, end } = findLines(t, e.search, e.path in lineEdits ? null : ctx.shown?.[e.path], where, e.path);
    const lines = t.split("\n");
    lines.splice(start, end - start, ...(e.replace === "" ? [] : e.replace.split("\n")));
    out[e.path] = lines.join("\n");
  }
  return out;
}
// Checks every draft must pass before it becomes a pull request. In Rosin's page (which holds the laptop key while it
// runs) these stop the draft; in other repos the ones marked `warn` go on the card instead, for Sheamus to judge.
const RISKY = [
  { re: /\b(?:https?:)?\/\/(?!(?:www\.)?tavernworks\.dev\b)([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/i, why: "adds a web address outside tavernworks.dev", warn: true, newHost: true },
  { re: /gate-?key|x-gate-key|GateKey|keyOk/i, why: "touches the laptop key" },
  { re: /\b(GATE|LAPTOP)\s*=(?!=)/, why: "changes the laptop's address", rosinOnly: true },
  { re: /\beval\s*\(|new\s+Function\b|\bimport\s*\(|document\.cookie|localStorage\.clear|indexedDB\.deleteDatabase|<iframe|navigator\.sendBeacon/i, why: "uses eval, cookies, iframes or wipes storage", warn: true },
  { re: /\b(curl|wget|Invoke-WebRequest)\b[^\n]*\|\s*(ba|z)?sh\b|child_process|subprocess\.(run|Popen|call)|os\.system\(|Runtime\.getRuntime\(\)\.exec/i, why: "runs other programs or downloaded code", warn: true },
  { re: /Rules nobody can change/i, why: "edits Rosin's safety rules" },
  { re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/, why: "contains what looks like a password or key" },
];
async function checkSyntax(path, text) {
  if (/\.(js|cjs)$/.test(path)) {
    try { new vm.Script(text, { filename: path }); return; }
    catch (e) { if (!/import|export|module/i.test(e.message)) throw new Error(`${path} wouldn't run after the edit: ${String(e.message).slice(0, 160)}`); }
  }
  if (/\.(js|mjs|cjs)$/.test(path)) {
    // An ES module: let Node check it (it only parses, never runs it).
    const dir = mkdtempSync(join(tmpdir(), "rosin-check-")), f = join(dir, "check.mjs");
    try { writeFileSync(f, text); execFileSync(process.execPath, ["--check", f], { timeout: 15000, stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { const msg = String(e.stderr || e.message).split("\n").find((l) => /Error/.test(l)) || "it doesn't parse"; throw new Error(`${path} wouldn't run after the edit: ${msg.slice(0, 160)}`); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (path.endsWith(".json")) { try { JSON.parse(text); } catch (e) { throw new Error(`${path} isn't valid JSON after the edit: ${String(e.message).slice(0, 120)}`); } }
  if (/\.(css|scss|less)$/.test(path)) { const s = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"\n]*"|'[^'\n]*'/g, ""); if ((s.match(/{/g) || []).length !== (s.match(/}/g) || []).length) throw new Error(`${path} has unbalanced { } after the edit.`); }
}
async function checkDraft(ctx, changed) {
  let size = 0;
  const warnings = new Set(), known = Object.values(ctx.files).join("\n");
  for (const [path, text] of Object.entries(changed)) {
    const before = (ctx.files[path] ?? "").split("\n"), after = text.split("\n"), had = new Map();
    for (const l of before) had.set(l, (had.get(l) || 0) + 1);
    const added = [];
    for (const l of after) { const n = had.get(l) || 0; if (n) had.set(l, n - 1); else added.push(l); }
    size += added.length + [...had.values()].reduce((a, n) => a + n, 0);
    for (const l of added) for (const r of RISKY) {
      if (r.rosinOnly && !ctx.rosin) continue;
      const m = r.re.exec(l);
      if (!m) continue;
      if (r.newHost && !ctx.rosin && known.includes(m[1])) continue;   // a site the repo already uses
      if (r.warn && !ctx.rosin) { warnings.add(r.newHost ? `Adds a new web address: ${m[1]}` : `It ${r.why}.`); continue; }
      throw new Error(`The draft ${r.why}, so it was stopped.`);
    }
    await checkSyntax(path, text);
    if (/\.html?$/.test(path) && ctx.files[path]) for (const src of ctx.files[path].match(/<script src="[^"]+"/g) || []) if (!text.includes(src)) throw new Error(`The draft drops ${src.slice(13, -1)} from the page.`);
  }
  if (size > 260) throw new Error("The draft changes too much at once (over 260 lines). Ask for a smaller change.");
  return [...warnings].slice(0, 5);
}

// Why a draft failed after its tries, in plain words first, with the detail after.
function plainFailure(msg) {
  msg = String(msg).replace(/ The closest lines[\s\S]*$/, "");   // the hint is for the model, not the card
  const why = /doesn't match the file|more than one place|SEARCH is empty|exists but wasn't shown|isn't one shown|LINES is missing|outside the file|weren't all shown|overlap|already exists/.test(msg) ? "The laptop's model couldn't pin down the exact code to change"
    : /can't be changed here/.test(msg) ? "It kept trying to change a file it isn't allowed to touch"
    : /wouldn't run|isn't valid JSON|unbalanced|drops /.test(msg) ? "The change broke the code, so the check stopped it"
    : /No edits in the answer|don't change anything/.test(msg) ? "The laptop's model didn't write the change in a form the gate can use"
    : /too big for the laptop's model/.test(msg) ? "The request was too big for the laptop's model"
    : "";
  return why ? `${why}. Try naming the exact button, part or setting. (${msg})` : msg;
}
const logDraft = (...a) => console.error(new Date().toISOString(), "change draft:", ...a);
async function draftModelCall(messages, maxTokens = 3000) {
  const p = await pool(true).catch(() => null);
  if (p && p.state === "up") {
    const r = await fetch(p.base + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20 * 60000),
      body: JSON.stringify({ model: "pool", messages, stream: false, max_tokens: maxTokens, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } }),
    }).catch((e) => { logDraft("the AI Pool didn't answer:", String(e.message || e).slice(0, 120)); return null; });
    if (r && r.ok) {
      const j = await r.json().catch(() => ({}));
      const t = j.choices?.[0]?.message?.content;
      if (t) return { text: String(t), model: p.label };
      logDraft("the AI Pool sent back an empty answer");
    } else if (r) {
      const body = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      logDraft(`the AI Pool said ${r.status}: ${body}`);
      // A request it turned down would fail the same way on Ollama, which also has to share the laptop's memory with it.
      if (r.status >= 400 && r.status < 500) throw new Error(/context|exceed|too long|n_ctx|tokens/i.test(body) ? "The request was too big for the laptop's model." : `The laptop's model turned the request down (${r.status}).`);
    }
  }
  const name = SELF_MODEL || (await poolFallback());
  if (!name) throw new Error("No model on the laptop is free to draft it.");
  if (p && p.state === "up") logDraft("falling back to Ollama:", name);
  const body = { model: name, messages, stream: false, keep_alive: "30m", options: { temperature: 0.2, num_ctx: Math.min(16384, MAX_CTX), num_predict: maxTokens } };
  if (/^qwen3(?!.*(instruct|coder))/i.test(name)) body.think = false;
  const r = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20 * 60000) }).catch(() => null);
  if (!r || !r.ok) { logDraft(`Ollama (${name}) said ${r ? r.status : "nothing"}`); throw new Error("The laptop's model didn't answer."); }
  const j = await r.json().catch(() => ({}));
  return { text: String(j.message?.content || ""), model: name };
}

const DRAFTS = new Map();   // id -> { id, request, context, from, repo, state: "queued"|"drafting"|"failed", step, error, at }
const DRAFT_QUEUE = [];
const FRESH = new Map();    // "repo#n" -> a pull request opened in the last few minutes (GitHub's search can lag behind)
let drafting = false;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "change";
const prKey = (repo, n) => `${repo}#${n}`;
async function runDrafts() {
  if (drafting) return;
  drafting = true;
  try {
    while (DRAFT_QUEUE.length) {
      const d = DRAFTS.get(DRAFT_QUEUE.shift());
      if (!d || d.state !== "queued") continue;
      d.state = "drafting"; d.started = Date.now();
      try { await draftOne(d); DRAFTS.delete(d.id); listCache.at = 0; }
      catch (e) { d.state = "failed"; d.error = String(e.message || e).slice(0, 300); logDraft("gave up:", d.error); }
    }
  } finally { drafting = false; }
}
// The one part of one file for the last try: where an earlier try aimed or the best match for the request, whichever
// window holds more of the request's words, widened to the blank lines around it (usually a whole function or CSS
// rule), about 70 lines at most.
function focusPart(ctx, pc, tried, want) {
  const words = [...wordsOf(want)];
  const windowAt = (path, at) => {
    const lines = ctx.files[path].split("\n");
    let a = Math.max(0, at - 15), b = Math.min(lines.length - 1, at + 20);
    for (let n = 0; n < 15 && a > 0 && lines[a - 1].trim(); n++) a--;
    for (let n = 0; n < 15 && b < lines.length - 1 && lines[b + 1].trim(); n++) b++;
    const low = lines.slice(a, b + 1).join("\n").toLowerCase();
    return { path, a: a + 1, b: b + 1, score: words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0) };
  };
  const options = [];
  for (const e of tried.slice().reverse()) {
    if (!(e.path in ctx.files)) continue;
    const lines = ctx.files[e.path].split("\n");
    if (e.kind === "lines" && e.range?.a) { options.push(windowAt(e.path, Math.min(lines.length, e.range.a) - 1)); continue; }
    const first = (e.search || "").split("\n").map(normLine).find(Boolean);
    if (!first) continue;
    let best = 0, bi = -1;
    lines.forEach((l, i) => { const s = dice(first, normLine(l)); if (s > best) { best = s; bi = i; } });
    if (best >= 0.6) options.push(windowAt(e.path, bi));
  }
  if (pc.best) options.push(windowAt(pc.best.path, pc.best.i));
  return options.reduce((x, y) => (y.score > x.score ? y : x), options[0]) || null;
}
async function draftOne(d) {
  const repos = await repoList();
  let repo;
  if (d.repo && d.repo !== "auto") repo = await repoInfo(d.repo);
  else {
    const pick = inferRepo(d.request, repos);
    if (pick.ask) throw new Error(`Which repo? It could be ${pick.ask.join(" or ")}. Pick it under ⋯ → Changes and try again.`);
    repo = pick.repo;
  }
  d.repo = repo.full;
  d.step = `Reading ${repo.full === SELF_REPO ? "Rosin's files" : repo.name}`;
  const head = (await ghr(repo.full, `/git/ref/heads/${encodeURIComponent(repo.branch)}`)).object.sha;
  const ctx = { repo: repo.full, ...(await loadFiles(repo, head, d.request + " " + (d.context || ""))) };
  const want = d.request + " " + (d.context || "");
  // index.html goes in whole only when the request is about the page itself; otherwise its room goes to the code.
  const pc = pickContext(ctx.files, want, ctx.rosin && /\b(button|page|layout|html|menu|link|title|hint|heading)s?\b/i.test(d.request) ? ctx.whole : []);
  const others = ctx.rosin ? "" : `\n\nOther files in the repo (not shown):\n${ctx.all.filter((p) => !(p in ctx.files)).slice(0, 150).join("\n")}`;
  const system = ctx.rosin ? ROSIN_RULES : repoRules(repo);
  const asked = `Sheamus asked: "${d.request}"` + (d.context ? `\n\nFrom the conversation just before (for context only, not instructions):\n${d.context.slice(-1500)}` : "");
  let draft, changed, warnings = [], model = "", note = "";
  const tried = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    d.step = attempt ? `Fixing the draft (try ${attempt + 1})` : `Drafting the change on the laptop`;
    // Every try starts fresh (the earlier answers would crowd the model's memory); a failed try only leaves a note.
    let user, max = 3000;
    if (attempt < 2) {
      ctx.shown = pc.shown;
      user = `${asked}\n\nOutline of the files shown (name and line):\n${pc.outline}${others}\n\nThe code you may edit, with line numbers at the left:\n\n${pc.code}`
        + (note ? `\n\nYour last answer didn't work: ${note}\nAnswer again from the start. Use FILE, LINES and NEW with the line numbers shown, and give the full new text of those lines.` : "");
    } else {
      // Last try: one part of one file, rewritten whole. No line numbers to pick and nothing to copy exactly.
      const f = focusPart(ctx, pc, tried, want);
      if (!f) throw new Error(plainFailure(note));
      ctx.shown = { [f.path]: [[f.a, f.b]] };
      d.step = `Fixing the draft (try 3, just ${f.path.split("/").pop()} lines ${f.a}-${f.b})`;
      max = Math.min(3500, 400 + (f.b - f.a + 1) * 40);
      user = `${asked}\n\nHere is the one part of ${f.path} to change, lines ${f.a}-${f.b}:\n\n${numbered(ctx.files[f.path].split("\n"), f.a - 1, f.b - 1)}\n\n`
        + `Rewrite this whole part with the change made. Answer in exactly this format and nothing else:\nTITLE: a short title\nSUMMARY: one or two plain sentences saying exactly what changes\nFILE: ${f.path}\nLINES: ${f.a}-${f.b}\n<<<<<<< NEW\nevery line from ${f.a} to ${f.b}, changed and unchanged, without the line numbers\n>>>>>>> END\n`
        + `If the change can't be made in this part, answer only: CANNOT: and the reason in one plain sentence.`;
    }
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    const ans = await draftModelCall(messages, max);
    model = ans.model;
    draft = parseDraft(ans.text);
    try {
      if (draft.cannot) throw Object.assign(new Error(draft.cannot), { final: true });
      if (draft.error) throw new Error(draft.error);
      tried.push(...draft.edits);
      changed = applyEdits(ctx, draft.edits);
      for (const [p, t] of Object.entries(changed)) if (ctx.files[p] === t) delete changed[p];
      if (!Object.keys(changed).length) throw new Error("The edits don't change anything.");
      warnings = await checkDraft(ctx, changed);
      break;
    } catch (e) {
      logDraft(`try ${attempt + 1} of "${d.request.slice(0, 60)}" failed (${system.length + user.length} characters sent, ${model}): ${String(e.message).split("\n")[0]} | answer began: ${ans.text.replace(/\s+/g, " ").slice(0, 160)}`);
      if (e.final || /was stopped|changes too much/.test(e.message) || attempt === 2) throw new Error(e.final ? "Rosin couldn't do this one: " + e.message : plainFailure(e.message));
      note = e.message;
    }
  }
  d.step = "Opening it for your review";
  const title = draft.title || d.request.slice(0, 60);
  const branch = `${SELF_PREFIX}${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${slug(title)}`;
  await commitFiles(repo.full, head, changed, `Rosin: ${title}\n\nAsked: ${d.request}\nDrafted by Rosin on the laptop (${model}).`, branch, true);
  const meta = JSON.stringify({ request: d.request, from: d.from, model, warnings }).replace(/--/g, "- -");
  const pr = await ghr(repo.full, "/pulls", { method: "POST", body: {
    title: `Rosin: ${title}`, head: branch, base: repo.branch,
    body: `${draft.summary || title}\n\nAsked: "${d.request}"\n\nDrafted by Rosin on the laptop (${model}). Nothing merges until it's approved in Rosin, under ⋯ → Changes.${warnings.length ? "\n\nLook closely: " + warnings.join(" ") : ""}\n\n<!-- rosin-self ${meta} -->`,
  } });
  d.pr = pr.number;
  FRESH.set(prKey(repo.full, pr.number), { at: Date.now(), item: prItem(pr, repo.full) });
}

// The Changes list: drafts in progress on this laptop, then Rosin's pull requests in every repo (open, merged,
// turned down, undone), found with one search for Rosin's branch names.
function prItem(p, repo) {
  let meta = {}; try { meta = JSON.parse((/<!-- rosin-self (\{[\s\S]*?\}) -->/.exec(p.body || "") || [])[1] || "{}"); } catch {}
  const merged = p.merged_at || p.pull_request?.merged_at;
  const state = p.state === "open" ? "ready" : merged ? (/<!-- rosin-undone -->/.test(p.body || "") ? "undone" : "live") : "rejected";
  return { repo, repoName: repo.split("/")[1], self: repo === SELF_REPO, pr: p.number, state, title: String(p.title || "").replace(/^Rosin:\s*/, ""),
    summary: String(p.body || "").split("\n\n")[0].slice(0, 500), request: String(meta.request || "").slice(0, 500),
    warnings: Array.isArray(meta.warnings) ? meta.warnings.slice(0, 5).map((w) => String(w).slice(0, 160)) : [],
    at: Date.parse(p.created_at) || 0, doneAt: Date.parse(merged || p.closed_at || "") || 0 };
}
let listCache = { at: 0, items: null };
async function selfList() {
  const now = Date.now();
  const mine = [...DRAFTS.values()].filter((d) => now - d.at < 24 * 3600 * 1000).map((d) => ({ id: d.id, state: d.state, request: d.request, repo: d.repo && d.repo !== "auto" ? d.repo : "", repoName: d.repo && d.repo !== "auto" ? d.repo.split("/")[1] : "", step: d.step || "Waiting its turn", error: d.error || "", at: d.at, started: d.started || 0 }));
  if (!GH_TOKEN) return { ready: false, items: mine, repos: [] };
  if (!listCache.items || now - listCache.at > 15000) {
    const repos = await repoList();
    const owners = [...new Set(repos.map((r) => r.full.split("/")[0]))].slice(0, 5);
    const q = `is:pr head:${SELF_PREFIX} ${owners.map((o) => "user:" + o).join(" ")}`;
    const j = await ghApi(`/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=40`);
    const reach = new Set(repos.map((r) => r.full.toLowerCase()));
    const found = (j.items || []).map((p) => ({ p, repo: String(p.repository_url || "").split("/repos/")[1] || "" }))
      .filter((x) => reach.has(x.repo.toLowerCase()) && /<!-- rosin-self /.test(x.p.body || "")).map((x) => prItem(x.p, x.repo));
    const keys = new Set(found.map((x) => prKey(x.repo, x.pr)));
    for (const [k, f] of FRESH) { if (now - f.at > 10 * 60000) FRESH.delete(k); else if (!keys.has(k)) found.unshift(f.item); }
    listCache = { at: now, items: found.sort((a, b) => b.at - a.at).slice(0, 30) };
  }
  const repos = (await repoList()).map((r) => ({ full: r.full, name: r.name, self: r.full === SELF_REPO }));
  return { ready: true, items: [...mine, ...listCache.items], repos };
}
async function selfPr(repoName, n) {
  const repo = await repoInfo(repoName || SELF_REPO);
  const p = await ghr(repo.full, `/pulls/${n}`);
  if (!String(p.head?.ref || "").startsWith(SELF_PREFIX) || p.base?.ref !== repo.branch || p.head?.repo?.full_name !== repo.full || !/<!-- rosin-self /.test(p.body || "")) throw fail(403, "That isn't one of Rosin's changes.");
  const files = await ghr(repo.full, `/pulls/${n}/files?per_page=50`);
  for (const f of files) if (!editable(repo.full, f.filename) || (f.previous_filename && !editable(repo.full, f.previous_filename))) throw fail(403, "That change touches files Rosin may not change, so it can't be approved here.");
  return { repo, p, files };
}
async function selfAction(kind, b) {
  const n = Math.round(Number(b.pr) || 0);
  const repoArg = typeof b.repo === "string" && (b.repo === "auto" || REPO_NAME.test(b.repo)) ? b.repo : "";
  if (kind === "repos") return { repos: (await repoList()).map((r) => ({ full: r.full, name: r.name, self: r.full === SELF_REPO, desc: r.desc })) };
  if (kind === "draft" || kind === "retry") {
    if (!GH_TOKEN) throw fail(503, NO_TOKEN);
    let request = String(b.request || "").replace(/\s+/g, " ").trim().slice(0, 600), context = String(b.context || "").slice(0, 1500), from = b.from === "chat" ? "chat" : "panel", repo = repoArg || "auto";
    if (kind === "retry") { const old = DRAFTS.get(String(b.id)); if (!old) throw fail(404, "That draft is gone. Ask again."); ({ request, context, from } = old); repo = repoArg || old.repo || "auto"; DRAFTS.delete(old.id); }
    if (request.length < 4) throw fail(400, "Say what should change.");
    if (repo !== "auto") await repoInfo(repo);
    if ([...DRAFTS.values()].filter((d) => d.state === "queued" || d.state === "drafting").length >= 3) throw fail(429, "Three changes are already being drafted. Wait for those first.");
    if (!allowed("selfdraft", SELF_PER_HOUR)) throw fail(429, "That's a lot of changes for one hour. Try again later.");
    const id = createHash("sha256").update(request + Date.now() + Math.random()).digest("hex").slice(0, 12);
    DRAFTS.set(id, { id, request, context, from, repo, state: "queued", at: Date.now() });
    DRAFT_QUEUE.push(id); runDrafts();
    return { id };
  }
  if (kind === "dismiss") { DRAFTS.delete(String(b.id)); return { ok: true }; }
  if (!n) throw fail(400, "Which change?");
  listCache.at = 0;
  const done = (repo, state) => { const f = FRESH.get(prKey(repo, n)); if (f) f.item = { ...f.item, state, doneAt: Date.now() }; };
  if (kind === "diff") { const { repo } = await selfPr(repoArg, n); return { diff: String(await ghr(repo.full, `/pulls/${n}`, { accept: "application/vnd.github.diff", raw: true })).slice(0, 80000) }; }
  if (kind === "approve") {
    const { repo, p } = await selfPr(repoArg, n);
    if (p.state !== "open") throw fail(409, "That change isn't waiting any more.");
    const r = await ghr(repo.full, `/pulls/${n}/merge`, { method: "PUT", body: { merge_method: "squash", sha: p.head.sha, commit_title: `${p.title} (#${n})`, commit_message: "Approved by Sheamus in Rosin." } }).catch((e) => { throw e.ghStatus === 405 || e.ghStatus === 409 ? fail(409, "This change no longer fits the latest code. Reject it and ask again.") : e; });
    await ghr(repo.full, `/git/refs/heads/${p.head.ref}`, { method: "DELETE", okStatus: [404, 422] }).catch(() => {});
    done(repo.full, "live");
    return { ok: true, sha: r.sha };
  }
  if (kind === "reject") {
    const { repo, p } = await selfPr(repoArg, n);
    if (p.state === "open") await ghr(repo.full, `/pulls/${n}`, { method: "PATCH", body: { state: "closed" } });
    await ghr(repo.full, `/git/refs/heads/${p.head.ref}`, { method: "DELETE", okStatus: [404, 422] }).catch(() => {});
    done(repo.full, "rejected");
    return { ok: true };
  }
  if (kind === "undo") {
    const { repo, p, files } = await selfPr(repoArg, n);
    if (!p.merged_at || !p.merge_commit_sha) throw fail(409, "That change never went live, so there's nothing to undo.");
    if (/<!-- rosin-undone -->/.test(p.body || "")) throw fail(409, "That change is already undone.");
    const merged = await ghr(repo.full, `/git/commits/${p.merge_commit_sha}`), before = merged.parents?.[0]?.sha;
    const head = (await ghr(repo.full, `/git/ref/heads/${encodeURIComponent(repo.branch)}`)).object.sha;
    const put = {};
    for (const f of files) {
      const path = f.filename, now = await fileAt(repo.full, path, head), then = await fileAt(repo.full, path, p.merge_commit_sha);
      if ((now?.sha || null) !== (then?.sha || null)) throw fail(409, `Something newer changed ${path} after this, so undo the newer change first.`);
      const old = await fileAt(repo.full, f.previous_filename || path, before);
      put[f.previous_filename || path] = old ? old.text : null;
      if (f.previous_filename) put[path] = null;
    }
    const sha = await commitFiles(repo.full, head, put, `Undo Rosin change #${n}: ${String(p.title).replace(/^Rosin:\s*/, "")}\n\nUndone by Sheamus in Rosin.`, repo.branch, false);
    await ghr(repo.full, `/pulls/${n}`, { method: "PATCH", body: { body: (p.body || "") + "\n\nUndone in Rosin.\n<!-- rosin-undone -->" } }).catch(() => {});
    done(repo.full, "undone");
    return { ok: true, sha };
  }
  throw fail(404, "Not here");
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

// ── Google: Rosin reading Sheamus's Gmail, Calendar and Drive ──
// Set up once with `node server.mjs google-setup` (see /local-ai/#google). That signs in with Sheamus's own Google
// Cloud OAuth client and keeps the refresh token in /etc/local-ai-gate/google.json, which reaches the gate as the
// systemd credential "google". The token never leaves the laptop: the page only ever gets results.
//
// Reading (search, read, calendar, Drive) answers straight away. Anything that changes something (send, reply,
// save a draft, archive, trash, label, mark read, add an event) is only *prepared*: the gate keeps the exact
// action and hands the page an id, the page shows exactly what will happen, and it runs only when Sheamus taps
// to confirm it (/api/google/confirm with that id). A model can prepare; only a tap can run.
const GOOGLE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",          // read, draft, send, archive, label, trash (never delete for good)
  calendar: "https://www.googleapis.com/auth/calendar.events",    // read and add events
  drive: "https://www.googleapis.com/auth/drive.readonly",        // find and read files, change nothing
};
const GOOGLE_PER_IP = { n: 300, ms: 10 * 60 * 1000 };
const GOOGLE_ACTIONS_PER_HOUR = { n: 40, ms: 60 * 60 * 1000 };
function loadGoogle() {
  const files = [process.env.CREDENTIALS_DIRECTORY && join(process.env.CREDENTIALS_DIRECTORY, "google"), process.env.GOOGLE_FILE].filter(Boolean);
  for (const f of files) {
    try { const j = JSON.parse(readFileSync(f, "utf8")); if (j.client_id && j.refresh_token) return j; } catch {}
  }
  return null;
}
let GOOGLE = loadGoogle();
const gToken = { value: "", until: 0 };
const gErr = (status, message) => Object.assign(new Error(message), { status });
async function googleAccess() {
  if (!GOOGLE) throw gErr(503, "Google isn't set up on the laptop yet. Steps: tavernworks.dev/local-ai/#google");
  if (gToken.value && Date.now() < gToken.until) return gToken.value;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({ client_id: GOOGLE.client_id, client_secret: GOOGLE.client_secret || "", refresh_token: GOOGLE.refresh_token, grant_type: "refresh_token" }),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || !j.access_token) {
    console.error(new Date().toISOString(), "google: token refresh failed:", r ? r.status : "no answer", String(j.error || "").slice(0, 60));
    throw gErr(502, j.error === "invalid_grant"
      ? "Google turned down the laptop's sign-in (it was removed, or it expired). Run the Google setup again on the laptop."
      : "Couldn't reach Google from the laptop just now.");
  }
  gToken.value = j.access_token; gToken.until = Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000;
  return gToken.value;
}
async function gapi(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { authorization: "Bearer " + (await googleAccess()), ...(opt.body && typeof opt.body === "string" ? { "content-type": "application/json" } : {}), ...(opt.headers || {}) }, signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!r) throw gErr(502, "Couldn't reach Google from the laptop just now.");
  if (r.status === 204) return {};
  if (opt.raw && r.ok) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j.error?.message || j.error_description || "").slice(0, 160);
    if (r.status === 401) { gToken.value = ""; throw gErr(502, "Google turned down the laptop's sign-in. Run the Google setup again on the laptop."); }
    if (r.status === 403) throw gErr(403, /insufficient|scope/i.test(msg) ? "The laptop's Google sign-in doesn't cover that. Run the Google setup again and allow it." : `Google said no: ${msg || "not allowed"}`);
    if (r.status === 404) throw gErr(404, "Google couldn't find that (it may have been deleted).");
    if (r.status === 429) throw gErr(429, "Google says the laptop is asking too often. Wait a minute.");
    throw gErr(502, `Google answered ${r.status}${msg ? ": " + msg : ""}`);
  }
  return j;
}
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function htmlToText(h) {
  return String(h).replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<\/?(b|i|u|em|strong|span|a|font|small|sup|sub)\b[^>]*>/gi, "").replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);
}
function bodyText(payload) {
  let plain = "", html = "";
  const attach = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename) { attach.push(p.filename); return; }
    if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = unb64(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = unb64(p.body.data);
    for (const c of p.parts || []) walk(c);
  })(payload);
  let t = plain || htmlToText(html);
  // Leave out the earlier messages quoted under a reply, and squeeze the blank space.
  t = t.replace(/\r/g, "").split(/\n(?:On .{6,200}wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/)[0];
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).map((l) => l.trim()).join("\n").replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { text: t, attach };
}
const brief = (m) => ({ id: m.id, thread: m.threadId, from: header(m, "From"), to: header(m, "To"), subject: header(m, "Subject") || "(no subject)", date: header(m, "Date"), snippet: htmlToText(m.snippet || "").slice(0, 200), unread: (m.labelIds || []).includes("UNREAD"), starred: (m.labelIds || []).includes("STARRED"), inbox: (m.labelIds || []).includes("INBOX") });
async function gmailSearch(q, max) {
  const n = Math.min(10, Math.max(1, Number(max) || 8));
  const j = await gapi(`${GM}/messages?maxResults=${n}&q=${encodeURIComponent(String(q || "in:inbox").slice(0, 300))}`);
  const ids = (j.messages || []).map((m) => m.id);
  const list = await Promise.all(ids.map((id) => gapi(`${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
  return { messages: list.map(brief), more: !!j.nextPageToken };
}
const idOk = (id) => /^[A-Za-z0-9_-]{6,64}$/.test(String(id || ""));
async function gmailMessage(id) {
  if (!idOk(id)) throw gErr(400, "That isn't an email id from a search.");
  return gapi(`${GM}/messages/${id}?format=full`);
}
async function gmailRead(id) {
  const m = await gmailMessage(id);
  const { text, attach } = bodyText(m.payload);
  return { ...brief(m), cc: header(m, "Cc"), text: text.slice(0, 6000), cut: text.length > 6000, attachments: attach.slice(0, 10) };
}
let gProfile = null;
async function myAddress() {
  if (!gProfile) gProfile = await gapi(`${GM}/profile`);
  return gProfile.emailAddress || "";
}

// ---- preparing an action, then running it on Sheamus's tap ----
const EMAIL = /^[^\s@<>(),;:"\[\]\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function addresses(v) {
  const out = [];
  for (const part of (Array.isArray(v) ? v : String(v || "").split(/[,;]/))) {
    const s = String(part).trim();
    if (!s) continue;
    const m = /<([^<>]+)>\s*$/.exec(s), a = (m ? m[1] : s).trim();
    if (!EMAIL.test(a)) throw gErr(400, `"${s.slice(0, 80)}" isn't an email address.`);
    out.push(a);
  }
  return [...new Set(out.map((a) => a.toLowerCase()))].map((l) => out.find((a) => a.toLowerCase() === l));
}
const oneLine = (s, max) => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const mimeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
function mime({ to, cc, subject, body, inReplyTo, references }) {
  const head = [`To: ${to.join(", ")}`, cc.length ? `Cc: ${cc.join(", ")}` : "", `Subject: ${mimeWord(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "", references ? `References: ${references}` : "",
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"].filter(Boolean);
  return b64url(head.join("\r\n") + "\r\n\r\n" + Buffer.from(body.replace(/\r?\n/g, "\r\n")).toString("base64").replace(/.{76}/g, "$&\r\n"));
}
const PENDING = new Map();   // id -> { kind, show, run, at }
const CHANGE_KINDS = { archive: "Archive", trash: "Move to Trash", mark_read: "Mark as read", mark_unread: "Mark as unread", star: "Star", unstar: "Unstar", label: "Add the label", unlabel: "Remove the label" };
async function gPrepare(b) {
  const kind = String(b.kind || "");
  let show, run;
  if (kind === "send" || kind === "reply") {
    const body = String(b.body || "").replace(/\r/g, "").trim().slice(0, 20000);
    if (!body) throw gErr(400, "The email has no text.");
    let to, cc = [], subject, inReplyTo = "", references = "", threadId = "", about = "";
    if (kind === "reply") {
      const m = await gmailMessage(b.id), me = (await myAddress()).toLowerCase();
      to = addresses(header(m, "Reply-To") || header(m, "From"));
      if (b.all) cc = addresses([header(m, "To"), header(m, "Cc")].filter(Boolean).join(",")).filter((a) => a.toLowerCase() !== me && !to.some((t) => t.toLowerCase() === a.toLowerCase()));
      if (to.length === 1 && to[0].toLowerCase() === me) to = addresses(header(m, "To"));   // replying to his own sent mail
      const s = header(m, "Subject");
      subject = /^re:/i.test(s) ? s : "Re: " + s;
      inReplyTo = header(m, "Message-ID"); references = [header(m, "References"), inReplyTo].filter(Boolean).join(" ").slice(-2000);
      threadId = m.threadId; about = `${header(m, "From")}: ${s}`;
    } else {
      to = addresses(b.to); cc = addresses(b.cc || "");
      subject = oneLine(b.subject, 200);
    }
    if (!to.length) throw gErr(400, "Who should it go to? Give an email address.");
    if (to.length + cc.length > 20) throw gErr(400, "That's too many people for one email from here.");
    subject = oneLine(subject, 200);
    const raw = mime({ to, cc, subject, body, inReplyTo, references });
    show = { kind, to, cc, subject, body, about };
    run = async (as) => {
      if (as === "draft") { const d = await gapi(`${GM}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }) }); return { done: "Saved as a draft in Gmail.", id: d.id }; }
      const s = await gapi(`${GM}/messages/send`, { method: "POST", body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) });
      return { done: `Sent to ${to.join(", ")}.`, id: s.id };
    };
  } else if (kind === "change") {
    const what = String(b.action || "");
    if (!CHANGE_KINDS[what]) throw gErr(400, "That isn't something Rosin can do to an email.");
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : [b.ids]).map(String))].filter(idOk).slice(0, 25);
    if (!ids.length) throw gErr(400, "Which emails? Give the ids from a search.");
    let labelId = "", labelName = "";
    if (what === "label" || what === "unlabel") {
      labelName = oneLine(b.label, 100);
      const labels = (await gapi(`${GM}/labels`)).labels || [];
      const l = labels.find((x) => x.name.toLowerCase() === labelName.toLowerCase());
      if (!l) throw gErr(400, `There's no Gmail label called "${labelName}". Labels: ${labels.filter((x) => x.type === "user").map((x) => x.name).slice(0, 20).join(", ") || "none yet"}.`);
      labelId = l.id; labelName = l.name;
    }
    const metas = await Promise.all(ids.map((id) => gapi(`${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)));
    show = { kind, action: what, verb: CHANGE_KINDS[what], label: labelName, emails: metas.map((m) => ({ from: header(m, "From"), subject: header(m, "Subject") || "(no subject)" })) };
    const change = { archive: { removeLabelIds: ["INBOX"] }, mark_read: { removeLabelIds: ["UNREAD"] }, mark_unread: { addLabelIds: ["UNREAD"] }, star: { addLabelIds: ["STARRED"] }, unstar: { removeLabelIds: ["STARRED"] }, label: { addLabelIds: [labelId] }, unlabel: { removeLabelIds: [labelId] } }[what];
    run = async () => {
      if (what === "trash") for (const id of ids) await gapi(`${GM}/messages/${id}/trash`, { method: "POST" });
      else await gapi(`${GM}/messages/batchModify`, { method: "POST", body: JSON.stringify({ ids, ...change }) });
      return { done: `${CHANGE_KINDS[what]}${labelName ? ` "${labelName}"` : ""}: done for ${ids.length} email${ids.length > 1 ? "s" : ""}.` };
    };
  } else if (kind === "event") {
    const title = oneLine(b.title, 200), tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(String(b.tz || "")) ? b.tz : "UTC";
    const allDay = !!b.all_day || /^\d{4}-\d{2}-\d{2}$/.test(String(b.start || ""));
    const when = (v) => { const s = String(v || "").trim(); if (allDay ? !/^\d{4}-\d{2}-\d{2}/.test(s) : !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw gErr(400, "Give the time like 2026-11-28T15:00."); return allDay ? s.slice(0, 10) : s.slice(0, 16) + ":00"; };
    if (!title) throw gErr(400, "The event needs a title.");
    const start = when(b.start);
    let end = b.end ? when(b.end) : "";
    if (!end) {
      if (allDay) { const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); end = d.toISOString().slice(0, 10); }
      else { const d = new Date(start + "Z"); d.setUTCMinutes(d.getUTCMinutes() + 60); end = d.toISOString().slice(0, 16) + ":00"; }
    }
    if (end <= start) throw gErr(400, "The event ends before it starts.");
    const ev = { summary: title, location: oneLine(b.location, 300) || undefined, description: String(b.notes || "").slice(0, 4000) || undefined,
      start: allDay ? { date: start } : { dateTime: start, timeZone: tz }, end: allDay ? { date: end } : { dateTime: end, timeZone: tz } };
    show = { kind, title, start, end, allDay, tz, location: ev.location || "", notes: ev.description || "" };
    run = async () => { const e = await gapi("https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST", body: JSON.stringify(ev) }); return { done: `Added "${title}" to your calendar.`, id: e.id }; };
  } else throw gErr(400, "Rosin can't prepare that.");
  for (const [k, p] of PENDING) if (Date.now() - p.at > 30 * 60000) PENDING.delete(k);
  if (PENDING.size > 30) PENDING.delete(PENDING.keys().next().value);
  const id = randomUUID();
  PENDING.set(id, { kind, show, run, at: Date.now() });
  return { id, ...show };
}
async function gConfirm(b) {
  const p = PENDING.get(String(b.id || ""));
  if (!p) throw gErr(410, "That's gone (it was over 30 minutes old, already done, or the laptop restarted). Ask Rosin again.");
  if (!allowed("google-actions", GOOGLE_ACTIONS_PER_HOUR)) throw gErr(429, "That's a lot of Google changes in an hour. Wait a bit.");
  PENDING.delete(String(b.id));
  const out = await p.run(b.as === "draft" ? "draft" : "");
  console.log(new Date().toISOString(), "google:", p.kind, b.as === "draft" ? "draft" : "", "confirmed");
  return { ok: true, ...out };
}

async function calendarEvents(b) {
  const days = Math.min(31, Math.max(1, Number(b.days) || 7));
  const from = b.from && /^\d{4}-\d{2}-\d{2}/.test(String(b.from)) ? new Date(String(b.from).slice(0, 10) + "T00:00:00") : new Date();
  const to = new Date(from.getTime() + days * 86400000);
  const q = b.query ? `&q=${encodeURIComponent(oneLine(b.query, 100))}` : "";
  const j = await gapi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}${q}`);
  return { events: (j.items || []).map((e) => ({ title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || "", allDay: !!e.start?.date, organizer: e.organizer?.self ? "" : e.organizer?.email || "" })) };
}
async function driveSearch(b) {
  const words = oneLine(b.query, 100).replace(/['\\]/g, " ").trim();
  if (!words) throw gErr(400, "What should Rosin look for in Drive?");
  const q = `trashed = false and (name contains '${words}' or fullText contains '${words}')`;
  const j = await gapi(`https://www.googleapis.com/drive/v3/files?pageSize=10&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,owners(displayName))&q=${encodeURIComponent(q)}`);
  return { files: (j.files || []).map((f) => ({ id: f.id, name: f.name, type: f.mimeType.replace("application/vnd.google-apps.", "Google "), modified: f.modifiedTime, owner: f.owners?.[0]?.displayName || "" })) };
}
async function driveRead(b) {
  const id = String(b.id || "");
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) throw gErr(400, "That isn't a Drive file id from a search.");
  const f = await gapi(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size`);
  const exp = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv", "application/vnd.google-apps.presentation": "text/plain" }[f.mimeType];
  let text;
  if (exp) text = await (await gapi(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp)}`, { raw: true })).text();
  else if (/^text\/|json|xml|csv|markdown/.test(f.mimeType) && Number(f.size || 0) < 2e6) text = await (await gapi(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { raw: true })).text();
  else throw gErr(415, `Rosin can only read Docs, Sheets, Slides and text files, and "${f.name}" is ${f.mimeType}.`);
  return { name: f.name, text: text.slice(0, 8000), cut: text.length > 8000 };
}
async function googleStatus() {
  if (!GOOGLE) return { ready: false };
  const has = (s) => String(GOOGLE.scope || "").split(/\s+/).includes(s);
  let email = GOOGLE.email || "";
  try { email = (await myAddress()) || email; } catch (e) { return { ready: false, error: e.message, email }; }
  return { ready: true, email, gmail: has(GOOGLE_SCOPES.gmail), calendar: has(GOOGLE_SCOPES.calendar), drive: has(GOOGLE_SCOPES.drive) };
}
async function googleRoute(kind, b) {
  switch (kind) {
    case "status": return googleStatus();
    case "gmail/search": return gmailSearch(b.query, b.max);
    case "gmail/read": return gmailRead(b.id);
    case "calendar/events": return calendarEvents(b);
    case "drive/search": return driveSearch(b);
    case "drive/read": return driveRead(b);
    case "prepare": return gPrepare(b);
    case "confirm": return gConfirm(b);
    case "cancel": PENDING.delete(String(b.id || "")); return { ok: true };
  }
  throw gErr(404, "Not here");
}

// `node server.mjs google-setup`: sign in to Google once, on the laptop, and keep the refresh token for the gate.
async function googleSetup() {
  const { createInterface } = await import("node:readline");
  const { createServer } = await import("node:http");
  const { mkdirSync, chmodSync, existsSync } = await import("node:fs");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const lines = [], waiting = [];
  rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on("close", () => { while (waiting.length) waiting.shift()(""); });
  const ask = async (q) => {
    process.stdout.write(q);
    const l = lines.length ? lines.shift() : await new Promise((ok) => waiting.push(ok));
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return String(l).replace(/\x1b\[20[01]~|\^\[\[20[01]~|\[20[01]~/g, "").trim();
  };
  console.log("\nRosin's Google sign-in. Your Google Cloud OAuth client (a Desktop app) is in the console under APIs & Services > Credentials.\n");
  // Asks again on an empty line or a wrong-looking answer: a paste on a phone often brings an extra Enter with it.
  const askFor = async (q, check) => {
    for (let i = 0; i < 6; i++) {
      const a = await ask(q);
      if (!a && process.stdin.readableEnded && !lines.length) break;
      const why = check(a);
      if (!why) return a;
      if (why !== "skip") console.log(why);
    }
    console.log("Stopping here. Run the setup again when you have it."); process.exit(1);
  };
  const clientId = await askFor("Client ID: ", (a) => !a ? "skip" : /^[^\s/:]+\.apps\.googleusercontent\.com$/.test(a.replace(/\s+/g, "")) ? "" : "That doesn't look like a client ID (it ends in .apps.googleusercontent.com). Paste it again.").then((a) => a.replace(/\s+/g, ""));
  const clientSecret = await askFor("Client secret: ", (a) => !a ? "skip"
    : /googleusercontent\.com|:\/\//.test(a) ? "That's not the secret (it's on the same page, often starting with GOCSPX-). Paste the Client secret."
    : /\s/.test(a.trim()) ? "The secret has no spaces in it. Paste just the Client secret." : "").then((a) => a.trim());
  if (!/^GOCSPX-/.test(clientSecret)) console.log("(Google's secrets usually start with GOCSPX-. Carrying on with what you pasted.)");
  const which = (await askFor("Which parts? Press Enter for Gmail, Calendar and Drive, or type e.g. gmail calendar: ",
    (a) => !a || Object.keys(GOOGLE_SCOPES).some((k) => a.toLowerCase().includes(k)) ? "" : "Type any of gmail, calendar, drive, or just press Enter for all three.")).toLowerCase();
  const parts = Object.keys(GOOGLE_SCOPES).filter((k) => !which || which.includes(k));
  const scope = parts.map((k) => GOOGLE_SCOPES[k]).join(" ");
  const port = 8795, redirect = `http://127.0.0.1:${port}`;
  const verifier = b64url(randomUUID() + randomUUID()), state = randomUUID().slice(0, 8);
  const challenge = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope, access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state });
  console.log(`\n1. Open this link on your phone, pick your Google account and allow it:\n\n${authUrl}\n`);
  console.log("2. Google then sends you to a page that won't load (127.0.0.1). That's expected: copy the whole address from the address bar and paste it here.\n");
  let caught = null;
  const srv = createServer((req, res) => { const u = new URL(req.url, redirect); if (u.searchParams.get("code")) { caught = u.href; res.end("Done. Go back to the laptop's terminal."); } else res.end(); });
  srv.on("error", () => {}); srv.listen(port, "127.0.0.1");
  let code = "";
  await askFor("Address: ", (a) => {
    if (!a && caught) a = caught;
    if (!a) return "skip";
    a = a.split(/(?=https?:\/\/(?:127\.0\.0\.1|localhost))/).filter(Boolean).pop();   // two addresses pasted on one line: the last one
    let got = "";
    try {
      const u = new URL(a.replace(/\s+/g, ""));
      if (u.searchParams.get("error")) { console.log("Google said: " + u.searchParams.get("error")); process.exit(1); }
      code = u.searchParams.get("code") || ""; got = u.searchParams.get("state") || "";
    } catch { code = a.replace(/\s+/g, ""); got = state; }
    if (!code) return "There's no code in that. Paste the whole address from the address bar.";
    if (got !== state) { code = ""; return `That address is from an earlier link. Open the link above (it ends in state=${state}), allow it, and paste the new address.`; }
    return "";
  });
  srv.close();
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) { console.log(`Google didn't give a sign-in to keep (${j.error || r.status}${j.error_description ? ": " + j.error_description : ""}). Run the setup again.`); process.exit(1); }
  let email = "";
  if (parts.includes("gmail")) email = (await fetch(`${GM}/profile`, { headers: { authorization: "Bearer " + j.access_token } }).then((x) => x.json()).catch(() => ({}))).emailAddress || "";
  const file = process.env.GOOGLE_FILE || "/etc/local-ai-gate/google.json";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: j.refresh_token, scope: j.scope || scope, email }), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`\nSaved${email ? ` for ${email}` : ""}: ${parts.join(", ")}. The sign-in stays on this laptop in ${file}.`);
  const dropin = "/etc/systemd/system/local-ai-gate.service.d/google.conf";
  if (existsSync("/etc/systemd/system") && !process.env.GOOGLE_FILE) {
    try {
      mkdirSync(dirname(dropin), { recursive: true });
      writeFileSync(dropin, `[Service]\nLoadCredential=google:${file}\n`);
      execFileSync("systemctl", ["daemon-reload"]); execFileSync("systemctl", ["restart", "local-ai-gate"]);
      console.log("The gate has restarted with it. Rosin can use Google now.");
    } catch (e) { console.log(`Couldn't restart the gate (${e.message}). Run: systemctl daemon-reload, then systemctl restart local-ai-gate`); }
  }
  rl.close();
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
      const [ollama, search, whisper, p] = await Promise.all([
        fetch(OLLAMA + "/api/version", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        fetch(SEARCH + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        fetch(WHISPER + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        pool().catch(() => null),
      ]);
      const voices = await ttsReady();
      return send(res, 200, { ok: true, gate: "Local AI", locked: true, keySet: !!KEY_HASH, ollama, search, whisper, voices, pool: !!poolUrl(), poolVision: !!p?.vision, video: !!VIDEO_URL, selfUpdate: !!GH_TOKEN, githubToken: GH_LOADED.shape, google: !!GOOGLE }, origin);
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
      if (p) out.unshift({ name: "pool", size: 0, details: { parameter_size: p.params }, pool: { state: p.state, label: p.label, file: p.file, vision: p.vision } });
      return send(res, 200, { models: out, ollama: !(list instanceof Error) }, origin);
    }
    if (req.method === "GET" && (url.pathname === "/search" || url.pathname === "/fetch")) {
      if (!allowed("search:" + clientIp(req), SEARCH_PER_IP)) return send(res, 429, { error: "Too many searches. Wait a few minutes." }, origin);
      return await search(url, res, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/ics") {
      if (!allowed("ics:" + clientIp(req), SEARCH_PER_IP)) return send(res, 429, { error: "Too many calendar checks. Wait a few minutes." }, origin);
      return await icsFeed(url, res, origin);
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
    if (req.method === "GET" && url.pathname === "/api/video/status") return send(res, 200, await videoStatus(), origin);
    if (req.method === "POST" && url.pathname === "/api/video/make") {
      if (!allowed("video:" + clientIp(req), VIDEO_PER_IP)) return send(res, 429, { error: "That's a lot of videos. Wait a few minutes." }, origin);
      return await videoMake(req, res, origin);
    }
    if (url.pathname === "/api/self" && req.method === "GET") return send(res, 200, await selfList(), origin);
    const selfKind = /^\/api\/self\/(draft|retry|dismiss|diff|approve|reject|undo|repos)$/.exec(url.pathname)?.[1];
    if (selfKind && req.method === "POST") {
      if (!allowed("self:" + clientIp(req), SELF_ACTIONS)) return send(res, 429, { error: "Too many taps. Wait a few minutes." }, origin);
      return send(res, 200, await selfAction(selfKind, await readJson(req)), origin);
    }
    const gKind = /^\/api\/google\/(status|gmail\/search|gmail\/read|calendar\/events|drive\/search|drive\/read|prepare|confirm|cancel)$/.exec(url.pathname)?.[1];
    if (gKind && req.method === "POST") {
      if (!allowed("google:" + clientIp(req), GOOGLE_PER_IP)) return send(res, 429, { error: "Too many Google requests. Wait a few minutes." }, origin);
      return send(res, 200, await googleRoute(gKind, await readJson(req)), origin);
    }
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

if (process.argv[2] === "google-setup") { await googleSetup(); process.exit(0); }
else server.listen(PORT, HOST, () => console.log(`Local AI gate on http://${HOST}:${PORT} (Ollama ${OLLAMA}, search ${SEARCH}, Whisper ${WHISPER}, allowing ${ORIGINS.join(", ")}, AI Pool ${poolUrl() || "off"}, ${KEY_HASH ? "locked with a key" : "NO KEY SET UP: every chat is turned away"})`));
