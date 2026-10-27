#!/usr/bin/env node
// Local AI web search: a tiny server on the laptop that lets the browser chat
// (tavernworks.dev/local-ai/chat/) search the web with DuckDuckGo and read
// pages. The browser can't call DuckDuckGo itself (it doesn't allow other
// sites in), so the chat asks this server instead. No API key needed.
//
//   GET /health                 { ok, engine }
//   GET /search?q=…&n=5         { query, results: [{ title, url, snippet }] }
//   GET /fetch?url=…            { url, title, text }   the page as plain text
//
//   node server.mjs             run the server (default port 8791)
//   node server.mjs "query"     search once from the terminal, to test it
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.SEARCH_PORT || 8791);
const HOST = process.env.SEARCH_HOST || "127.0.0.1";
const ORIGINS = (process.env.SEARCH_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const MAX_RESULTS = 10;
const MAX_TEXT = 12000;               // characters of page text handed back
const MAX_PAGE = 3 * 1024 * 1024;     // bytes downloaded per page, at most
const CACHE_MS = 15 * 60 * 1000;
const GAP_MS = 1200;                  // space out DuckDuckGo requests so it doesn't start refusing

// ── Small helpers ──
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s) => String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
  if (ENTITIES[e] != null) return ENTITIES[e];
  if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
  if (/^#\d/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
  return m;
});
const strip = (html) => decode(String(html).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

const cache = new Map();
function cached(key, make) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}
let lastDdg = 0;
async function ddgTurn() {
  const wait = lastDdg + GAP_MS - Date.now();
  lastDdg = Math.max(Date.now(), lastDdg + GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ── DuckDuckGo ──
// Result links come wrapped as //duckduckgo.com/l/?uddg=<real url>.
function realUrl(href) {
  href = decode(href);
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    if (/duckduckgo\.com$/.test(u.hostname) && u.pathname === "/l/" && u.searchParams.get("uddg")) return u.searchParams.get("uddg");
    if (/duckduckgo\.com$/.test(u.hostname)) return null;   // ads and DuckDuckGo's own links
    return u.href;
  } catch { return null; }
}
// html.duckduckgo.com: each result is a div.result with a.result__a (title)
// and .result__snippet.
export function parseHtml(page) {
  const out = [];
  for (const block of page.split(/<div[^>]+class="[^"]*?\bresult\b/).slice(1)) {
    if (/^[^>]*result--ad/.test(block)) continue;
    const a = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = realUrl(a[1]);
    if (!url) continue;
    const sn = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    out.push({ title: strip(a[2]), url, snippet: sn ? strip(sn[1]) : "" });
  }
  return out;
}
// lite.duckduckgo.com: a table, with a.result-link followed by td.result-snippet.
export function parseLite(page) {
  const out = [];
  const re = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]*class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(page))) {
    if (m[5] != null) { if (out.length && !out[out.length - 1].snippet) out[out.length - 1].snippet = strip(m[5]); continue; }
    const url = realUrl(m[1] || m[3]);
    if (url) out.push({ title: strip(m[2] || m[4]), url, snippet: "" });
  }
  return out;
}
async function ddg(endpoint, query, parse) {
  await ddgTurn();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html", "Accept-Language": "en-US,en;q=0.8" },
    body: new URLSearchParams({ q: query, kl: process.env.SEARCH_REGION || "wt-wt" }),
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  const page = await res.text();
  // A 202 or a page with "anomaly" in it is DuckDuckGo deciding we're a bot.
  if (res.status === 202 || /anomaly-modal|class="anomaly/.test(page)) throw new Error("DuckDuckGo is asking for a captcha (too many searches). Wait a few minutes and try again.");
  if (!res.ok) throw new Error(`DuckDuckGo answered HTTP ${res.status}`);
  return { results: parse(page), empty: /No results\.|no-results/i.test(page) };
}
async function search(query, n) {
  let first;
  try {
    const r = await ddg("https://html.duckduckgo.com/html/", query, parseHtml);
    if (r.results.length || r.empty) return r.results.slice(0, n);
  } catch (e) { first = e; }
  // The lite page is plainer and sometimes answers when the other one won't.
  try {
    const r = await ddg("https://lite.duckduckgo.com/lite/", query, parseLite);
    return r.results.slice(0, n);
  } catch (e) { throw first || e; }
}

// ── Reading a page ──
// Only public addresses: this server sits on the laptop, so it must not be
// usable to poke at the home network or the tailnet.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}
async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error("That isn't a valid web address."), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("Only http and https pages can be read."), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) throw Object.assign(new Error(`Couldn't find ${host}.`), { status: 502 });
  if (ips.some(privateIp) || /\.(local|internal|ts\.net)$|^localhost$/i.test(host)) throw Object.assign(new Error("That address is on a private network, so it can't be read."), { status: 403 });
  return u;
}
export function pageText(html) {
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  let body = (html.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || html;
  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|dd|dt)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body).split("\n").map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text };
}
async function readPage(raw) {
  let url = await checkUrl(raw);
  let res;
  for (let hops = 0; ; hops++) {   // follow redirects by hand so each hop gets checked
    res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && hops < 5) { url = await checkUrl(new URL(loc, url).href); continue; }
    break;
  }
  if (!res.ok) throw Object.assign(new Error(`The page answered HTTP ${res.status}.`), { status: 502 });
  const type = res.headers.get("content-type") || "";
  if (!/text\/|html|xml|json/.test(type)) throw Object.assign(new Error(`That's a ${type.split(";")[0] || "binary"} file, not a page that can be read as text.`), { status: 415 });
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
    if (size > MAX_PAGE) { reader.cancel().catch(() => {}); break; }
  }
  const raw2 = new TextDecoder().decode(Buffer.concat(chunks));
  const { title, text } = /html|xml/.test(type) ? pageText(raw2) : { title: "", text: raw2 };
  return { url: res.url || url.href, title, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n…(cut off)" : text };
}

// ── Terminal test ──
// (Only when run directly, so the parsers can be imported on their own.)
const main = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main && process.argv[2]) {
  try {
    const results = await search(process.argv.slice(2).join(" "), 5);
    if (!results.length) console.log("No results.");
    for (const r of results) console.log(`${r.title}\n  ${r.url}\n  ${r.snippet}\n`);
    process.exit(0);
  } catch (e) { console.error(e.message); process.exit(1); }
}

// ── Server ──
function send(req, res, status, body) {
  const origin = req.headers.origin;
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" };
  if (origin && ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    // Chrome asks before a public website may call a private-network address.
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ORIGINS.includes(origin)) return send(req, res, 403, { error: `This server doesn't allow ${origin}. Add it to SEARCH_ORIGINS.` });
  if (req.method === "OPTIONS") return send(req, res, 204);
  if (req.method !== "GET") return send(req, res, 405, { error: "Use GET." });
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/" || u.pathname === "/health") return send(req, res, 200, { ok: true, engine: "duckduckgo" });
    if (u.pathname === "/search") {
      const q = (u.searchParams.get("q") || "").trim().slice(0, 400);
      if (!q) return send(req, res, 400, { error: "Add a search, like /search?q=ollama." });
      const n = Math.min(MAX_RESULTS, Math.max(1, Number(u.searchParams.get("n")) || 5));
      const results = await cached("s:" + n + ":" + q.toLowerCase(), () => search(q, n));
      return send(req, res, 200, { query: q, results });
    }
    if (u.pathname === "/fetch") {
      const target = (u.searchParams.get("url") || "").trim();
      if (!target) return send(req, res, 400, { error: "Add a page, like /fetch?url=https://example.com." });
      return send(req, res, 200, await cached("f:" + target, () => readPage(target)));
    }
    return send(req, res, 404, { error: "Not found. Try /search?q=… or /fetch?url=…" });
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "Timed out waiting for the other site."
      : e.message === "fetch failed" ? `Couldn't connect to the other site (${e.cause?.code || e.cause?.message || "network error"}). Is the laptop online?`
      : e.message || "Something went wrong.";
    console.warn(`${u.pathname}: ${msg}`);
    return send(req, res, e.status || 502, { error: msg });
  }
});
if (main) server.listen(PORT, HOST, () => console.log(`Local AI web search on http://${HOST}:${PORT} (allowing ${ORIGINS.join(", ")})`));
