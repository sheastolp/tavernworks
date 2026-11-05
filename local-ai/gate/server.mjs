#!/usr/bin/env node
// Local AI gate: a tiny server on the FX705 that lets the browser chat
// (tavernworks.dev/local-ai/chat/) reach Ollama and the web search server
// from anywhere, through Tailscale Funnel, so visitors don't need Tailscale.
// Anyone can reach a funnel address, and Ollama's own API can also download,
// copy and delete models, so the funnel points here instead, and this only
// lets the chat through.
//
//   GET  /health          { ok, ollama, search }
//   GET  /api/tags        the installed models (names and sizes only)
//   POST /api/chat        { model, messages, tools?, options? }  ->  Ollama's NDJSON stream
//   GET  /search?q=…&n=5  passed to the web search server
//   GET  /fetch?url=…     passed to the web search server
//
//   node server.mjs       run the gate (default port 8793)
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import { Readable } from "node:stream";

const PORT = Number(process.env.GATE_PORT || 8793);
const HOST = process.env.GATE_HOST || "127.0.0.1";
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const SEARCH = (process.env.SEARCH_URL || "http://127.0.0.1:8791").replace(/\/$/, "");
const ORIGINS = (process.env.GATE_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
// Only these models, if set (comma-separated). Otherwise every installed model.
const ONLY = (process.env.GATE_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);

const MAX_BODY = 32 * 1024 * 1024;   // bytes per chat request (images ride along as base64)
const MAX_MESSAGES = 200;
const MAX_TEXT = 1_200_000;           // characters of text across the whole conversation
const MAX_IMAGES = 8;                 // images across the whole conversation
const MAX_IMAGE = 8 * 1024 * 1024;    // characters of base64 per image
const MAX_CTX = Number(process.env.GATE_MAX_CTX || 32768);
const MAX_REPLY_TOKENS = 4096;
const MAX_WAITING = 4;                // the GPU writes one reply at a time; past this many, say busy
const CHAT_PER_IP = { n: 60, ms: 10 * 60 * 1000 };
const CHAT_ALL = { n: 400, ms: 10 * 60 * 1000 };
const SEARCH_PER_IP = { n: 120, ms: 10 * 60 * 1000 };

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
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } : {};
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

// ── Checking a chat request ──
async function cleanChat(b) {
  const model = String(b.model || "");
  if (!(await models()).some((m) => m.name === model)) throw fail(400, `There's no model called ${model || "(none)"} here.`);
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
  const out = { model, messages, stream: true, keep_alive: "30m", options };
  if (Array.isArray(b.tools) && b.tools.length) out.tools = WEB_TOOLS;
  return out;
}

// ── Chatting ──
let waiting = 0;
async function chat(req, res, origin) {
  const body = await cleanChat(await readJson(req));
  if (waiting >= MAX_WAITING) throw fail(503, "The laptop is busy with other people's chats. Try again in a minute.");
  waiting++;
  const stop = new AbortController();
  res.on("close", () => stop.abort());   // the browser hung up or pressed stop
  try {
    let r;
    try {
      r = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: stop.signal });
    } catch (e) {
      if (stop.signal.aborted) return;
      throw fail(502, "Ollama isn't answering on the laptop");
    }
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      throw fail(r.status >= 400 && r.status < 500 ? r.status : 502, j.error || `Ollama answered ${r.status}`);
    }
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", vary: "Origin", ...cors(origin) });
    await new Promise((done) => {
      const s = Readable.fromWeb(r.body);
      s.on("error", () => { res.end(); done(); });
      s.on("end", done);
      res.on("close", done);
      s.pipe(res);
    });
  } finally { waiting--; }
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
      const [ollama, search] = await Promise.all([
        fetch(OLLAMA + "/api/version", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        fetch(SEARCH + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
      ]);
      return send(res, 200, { ok: true, gate: "Local AI", ollama, search }, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/tags") return send(res, 200, { models: await models() }, origin);
    if (req.method === "GET" && (url.pathname === "/search" || url.pathname === "/fetch")) {
      if (!allowed("search:" + clientIp(req), SEARCH_PER_IP)) return send(res, 429, { error: "Too many searches. Wait a few minutes." }, origin);
      return await search(url, res, origin);
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

server.listen(PORT, HOST, () => console.log(`Local AI gate on http://${HOST}:${PORT} (Ollama ${OLLAMA}, search ${SEARCH}, allowing ${ORIGINS.join(", ")})`));
