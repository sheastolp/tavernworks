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
//   POST /admin/review-item (owner's token) { source, title, body, about, key, decided, loreLine, chatId }
//                        ->  { ok, sha, url, updated }   files an item in working-notes.md on the review
//                        branch: source "lore-keeper" (default), "codex" or "verrowen"
//   GET  /admin/inbox    (owner's token)  ->  { items }   what others sent in, waiting for the owner
//   POST /admin/inbox    (owner's token) { id, action: "file" | "accept" | "dismiss", title?, body? }  ->  { ok, sha? }
//                        "file" files it as a Pitch, "accept" as Your idea
//   POST /admin/accept-pitch (owner's token) { file, line }  ->  { ok, sha, url }   turns one (Pitch)
//                        in working-notes.md, resources.md or bestiary.md into (Your idea), on the review branch
//   POST /admin/reject-pitch (owner's token) { file, line }  ->  { ok, sha, url }   removes one (Pitch)
//                        from working-notes.md, resources.md or bestiary.md on the review branch: a heading with
//                        its whole section, or a single bullet line
//   POST /admin/lore-catchup (owner's token) {}  ->  { base, head, sections, cut, lines }   a draft of the
//                        lore.md lines the decided notes gained since the last catch-up (by the model)
//   POST /admin/lore-catchup/apply (owner's token) { head, lines }  ->  { ok, sha, url, added }   adds them
//                        to lore.md on the review branch and remembers head as the new catch-up point
//   POST /suggest    { source, title, body, about, key, name }  ->  { ok, queued }
//                    anyone: waits in the inbox above until the owner files it (always as a pitch)
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
// Filing things for review: each one becomes a section at the end of
// working-notes.md on the review branch, under a heading for where it came
// from, so it waits under "Waiting for you" until the owner publishes it.
//   lore-keeper  a write-up or chat from the Orrery Explorer's lore-keeper
//   codex        a note from the Verrowen Codex (decided notes the narrator
//                should know also get a CODEX: line in lore.md)
//   verrowen     a character wrapped up in Wake in Verrowen
// An item with a `key` (a Codex note's id, a character's id) replaces the
// section filed under the same key before, so sending again updates it.
const NOTES = "working-notes.md", LORE = "lore.md";
const SOURCES = {
  "lore-keeper": { head: "## From the lore-keeper", intro: "Pitches the owner filed from lore-keeper chats on the Orrery Explorer. Nothing here is decided until it's marked **Your idea**.", from: "From a lore-keeper chat", msg: "Lore-keeper pitch" },
  codex: { head: "## From the Codex", intro: "Notes sent in from the Verrowen Codex. Ones the owner decided are marked **Your idea**; the rest are pitches.", from: "From the Verrowen Codex", msg: "Codex note" },
  verrowen: { head: "## From Wake in Verrowen", intro: "Characters made in Wake in Verrowen and sent in for review. Nothing here is decided until it's marked **Your idea**.", from: "From a Wake in Verrowen story", msg: "Wake in Verrowen character" },
};
const oneLine = (v, n) => str(v, n).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
function reviewItem(b, { owner }) {
  const source = SOURCES[b.source] ? b.source : "lore-keeper";
  const title = oneLine(b.title, 120).replace(/#+/g, "").trim();
  const body = str(b.body, 12000).replace(/\r\n/g, "\n").replace(/<!--|-->/g, "").trim();
  if (!title || !body) throw Object.assign(new Error("The item needs a title and some text"), { status: 400 });
  const key = /^[A-Za-z0-9:_-]{1,100}$/.test(String(b.key || "")) ? source + ":" + b.key : "";
  // Only the owner decides: anything sent in by someone else is a pitch.
  const decided = owner && b.decided === true;
  const loreLine = decided && source === "codex" ? oneLine(b.loreLine, 1500) : "";
  return { source, title, body, key, decided, loreLine, about: oneLine(b.about, 200), name: oneLine(b.name, 60), chatId: str(b.chatId, 80) };
}
// Read a file on the review branch, change it, write it back as one commit.
// A 409 means it changed in between: read it again once.
async function editOnReview(file, change, message) {
  for (let tries = 0; tries < 2; tries++) {
    const cur = await gh("/contents/" + file + "?ref=" + CLONE);
    if (!cur.ok) throw Object.assign(new Error(`GitHub couldn't read ${file} on the review branch (${cur.status})`), { status: 502 });
    const before = Buffer.from(cur.j.content || "", "base64").toString("utf8");
    const after = change(before);
    if (after === before) return null;
    const put = await gh("/contents/" + file, { method: "PUT", body: JSON.stringify({ message, content: Buffer.from(after, "utf8").toString("base64"), sha: cur.j.sha, branch: CLONE }) });
    if (put.ok) return put.j.commit;
    if (put.status !== 409) throw Object.assign(new Error(`GitHub refused the commit (${put.status}): ${put.j.message || ""}`), { status: 502 });
  }
  throw Object.assign(new Error(`${file} kept changing on the review branch. Try again.`), { status: 502 });
}
async function fileReviewItem(it) {
  const src = SOURCES[it.source];
  const day = new Date().toISOString().slice(0, 10);
  const mark = it.key ? `<!-- review-key: ${it.key} -->\n` : "";
  const byline = [src.from + ", " + day, it.name ? "sent by " + it.name : "", it.about].filter(Boolean).join(" · ");
  const section = `### ${it.title} (${it.decided ? "Your idea" : "Pitch"})\n\n${mark}_${byline}._\n\n${it.body}\n`;
  let updated = false;
  const commit = await editOnReview(NOTES, (text) => {
    text = text.replace(/\s+$/, "");
    if (it.key) {
      // The section filed under this key before, up to the next heading.
      const at = text.indexOf(`<!-- review-key: ${it.key} -->`);
      if (at >= 0) {
        const s0 = text.lastIndexOf("\n### ", at), rest = text.slice(at);
        const next = rest.search(/\n#{2,3} /);
        if (s0 >= 0) { updated = true; return (text.slice(0, s0 + 1) + section.trimEnd() + (next >= 0 ? "\n" + rest.slice(next) : "")).replace(/\s+$/, "") + "\n"; }
      }
    }
    if (!text.includes("\n" + src.head + "\n")) text += `\n\n${src.head}\n\n${src.intro}`;
    else {
      // Add it at the end of its own heading's part, which may not be last.
      const h = text.indexOf("\n" + src.head + "\n") + 1, rest = text.slice(h + src.head.length);
      const next = rest.search(/\n## /);
      if (next >= 0) { const cut = h + src.head.length + next; return text.slice(0, cut).replace(/\s+$/, "") + "\n\n" + section + text.slice(cut) + "\n"; }
    }
    return text + "\n\n" + section;
  }, `${src.msg}: ${it.title}${updated ? " (updated)" : ""}`);
  // A decided Codex note the narrator should know: its line in lore.md too,
  // replacing the line from an earlier send of the same note.
  let lore = null;
  if (it.loreLine) {
    const line = "CODEX: " + it.loreLine;
    const same = (l) => l.startsWith("CODEX: " + it.title + " (") || l.startsWith("CODEX: " + it.title + ".") || l === "CODEX: " + it.title;
    lore = await editOnReview(LORE, (text) => {
      const lines = text.replace(/\s+$/, "").split("\n");
      const i = lines.findIndex(same);
      if (i >= 0) lines[i] = line;
      else { let last = -1; lines.forEach((l, n) => { if (l.startsWith("CODEX: ")) last = n; }); lines.splice(last >= 0 ? last + 1 : lines.length, 0, line); }
      return lines.join("\n") + "\n";
    }, `Codex note for the narrator: ${it.title}`);
  }
  const top = lore || commit;
  if (!top) return { sha: "", url: "", unchanged: true };
  if (it.source === "lore-keeper" && it.chatId) {
    const rec = await readLorekeeper();
    if (rec && rec.id === it.chatId) {
      rec.filed = { at: new Date().toISOString(), title: it.title, sha: top.sha };
      await fs.writeFile(LK_FILE() + ".tmp", JSON.stringify(rec, null, 2));
      await fs.rename(LK_FILE() + ".tmp", LK_FILE());
    }
  }
  return { sha: top.sha, url: top.html_url, updated };
}

// Accepting a pitch as it is: the one line holding "(Pitch)" (a heading like
// "### Elwen Cole (Pitch)" or a bullet like "- **Name ideas (Pitch):** …")
// gets "(Your idea)" instead, as one commit on the review branch. Nothing
// else in the file changes, so it waits for the owner's publish like the rest.
const PITCH_FILES = [NOTES, "resources.md", "bestiary.md"];
async function acceptPitch(b) {
  const file = String(b.file || ""), want = String(b.line || "").replace(/\r/g, "");
  if (!PITCH_FILES.includes(file)) throw Object.assign(new Error("Pitches can only be accepted in " + PITCH_FILES.join(" or ")), { status: 400 });
  if (!want.includes("(Pitch)") || want.includes("\n") || want.length > 2000) throw Object.assign(new Error("That isn't a pitch line"), { status: 400 });
  const name = want.replace(/^[#\s>*-]+/, "").split("(Pitch)")[0].replace(/[*_]/g, "").trim().slice(0, 80) || "a pitch";
  let found = false;
  const commit = await editOnReview(file, (text) => {
    const lines = text.split("\n"), i = lines.indexOf(want);
    if (i < 0) return text;
    found = true; lines[i] = want.replace("(Pitch)", "(Your idea)");
    return lines.join("\n");
  }, `Accept pitch as is: ${name}`);
  if (!found) throw Object.assign(new Error("That pitch isn't on the review branch any more. Check again to reload the list."), { status: 409 });
  return { sha: commit.sha, url: commit.html_url, name };
}

// Rejecting a pitch: the one line holding "(Pitch)" comes out of the file, as
// one commit on the review branch. A heading takes its whole section with it
// (up to the next heading at the same level or above); a bullet goes alone.
// Like everything on review, it isn't final until the owner publishes, and
// Throw it all away brings it back.
async function rejectPitch(b) {
  const file = String(b.file || ""), want = String(b.line || "").replace(/\r/g, "");
  if (!PITCH_FILES.includes(file)) throw Object.assign(new Error("Pitches can only be rejected in " + PITCH_FILES.join(" or ")), { status: 400 });
  if (!want.includes("(Pitch)") || want.includes("\n") || want.length > 2000) throw Object.assign(new Error("That isn't a pitch line"), { status: 400 });
  const name = want.replace(/^[#\s>*-]+/, "").split("(Pitch)")[0].replace(/[*_]/g, "").trim().slice(0, 80) || "a pitch";
  let found = false;
  const commit = await editOnReview(file, (text) => {
    const lines = text.split("\n"), i = lines.indexOf(want);
    if (i < 0) return text;
    found = true;
    const h = want.match(/^(#{1,6})\s/);
    let end = i + 1;
    if (h) { const stop = new RegExp("^#{1," + h[1].length + "}\\s"); while (end < lines.length && !stop.test(lines[end])) end++; }
    lines.splice(i, end - i);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
  }, `Reject pitch: ${name}`);
  if (!found) throw Object.assign(new Error("That pitch isn't on the review branch any more. Check again to reload the list."), { status: 409 });
  return { sha: commit.sha, url: commit.html_url, name };
}

// ── Lore catch-up ──
// lore.md is the condensed, decided canon the Wake in Verrowen narrator
// reads. The catch-up compares the decided sections of the notes now (on the
// review branch) with how they stood at the last catch-up, asks the model for
// only the LORE lines that are missing, and hands the owner a draft. Nothing
// changes until the owner adds the (edited) lines, as one commit on review.
// The last catch-up is remembered in lore.md's second line, which the game
// never sends to the narrator: "<!-- caught up to review@<sha> -->".
const CANON_FILES = [NOTES, "resources.md", "universe.md", "bestiary.md"];
const CAUGHT_UP = /<!-- caught up to review@([0-9a-f]{7,40}) -->/;
const MAX_CHANGES = 20000;
// Decided sections only: tagged (Your idea), or untagged under nothing but
// (Your idea). Pitches, open directions, DM lore and the inboxes stay out, and
// so do inline "(Pitch)" lines and "Still open" bullets inside a decided one.
function decidedSections(file, text) {
  const out = new Map(), stack = [];
  let cur = null;
  const flush = () => {
    if (!cur || !cur.decided) return;
    const body = cur.lines.filter((l) => !/\((Pitch|Not decided yet)\)/.test(l) && !/^\s*[-*]\s+\*\*(Still open|Open|Undecided)\b/i.test(l))
      .join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (body) out.set(cur.key, body);
  };
  for (const l of String(text || "").replace(/\r/g, "").split("\n")) {
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (!h) { if (cur) cur.lines.push(l); continue; }
    flush();
    const lvl = h[1].length, m = h[2].match(/\((Your idea|Pitch|Not decided yet|DM lore)[^)]*\)\s*$/);
    while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
    stack.push({ lvl, name: h[2].replace(/\s*\((Your idea|Pitch|Not decided yet|DM lore)[^)]*\)\s*$/, "").trim(), tag: m ? m[1] : "" });
    const tag = (stack.slice().reverse().find((s) => s.tag) || {}).tag || "";
    const names = stack.map((s) => s.name);
    cur = { key: file + " › " + names.slice(1).join(" › "), lines: [],
      decided: lvl > 1 && (tag === "" || tag === "Your idea") && !names.some((n) => /open questions|still being developed|to fill in|^from (the |wake)|^maps\b/i.test(n)) };
  }
  flush();
  return out;
}
async function fileAt(file, ref) {
  const r = await gh("/contents/" + file + "?ref=" + ref);
  if (r.status === 404) return "";
  if (!r.ok) throw Object.assign(new Error(`GitHub couldn't read ${file} (${r.status})`), { status: 502 });
  return Buffer.from(r.j.content || "", "base64").toString("utf8");
}
async function loreCatchupDraft() {
  const head = await headOf(CLONE), lore = await fileAt(LORE, head);
  let base = (lore.match(CAUGHT_UP) || [])[1];
  if (!base) {
    const c = await gh("/commits?sha=" + head + "&path=" + LORE + "&per_page=1");
    base = c.ok && c.j[0] && c.j[0].sha;
  }
  if (!base) throw Object.assign(new Error("Couldn't tell when lore.md was last caught up"), { status: 502 });
  const changed = [];
  for (const f of CANON_FILES) {
    const [was, now] = await Promise.all([fileAt(f, base), fileAt(f, head)]);
    const before = decidedSections(f, was);
    for (const [key, body] of decidedSections(f, now)) if (before.get(key) !== body) changed.push({ key, body });
  }
  if (!changed.length) return { base, head, sections: [], lines: "" };
  let text = "", used = [], cut = false;
  for (const s of changed) {
    const part = `### ${s.key}\n${s.body}\n\n`;
    if (text.length + part.length > MAX_CHANGES) { cut = true; continue; }
    text += part; used.push(s.key);
  }
  const ask = `You keep lore.md, the short, decided canon the narrator of a roleplay game reads. Below are the current LORE and the DECIDED CHANGES made to the universe's notes since it was last caught up.

Write ONLY what LORE is missing: facts in the changes that LORE doesn't already state, or states differently (then write the corrected fact). One line per topic, each starting with an UPPERCASE label like LORE's (STOUTWELL:, LIFE:, MAGIC:, ITEMS:, RESOURCES:, PEOPLE:, BEYOND:, OTHER WORLDS:) or a short new label. Plain, compact sentences. No markdown, no bullets, no commentary. Never add ideas that are still open, or anything not in the changes. If LORE already has everything, reply exactly: NOTHING NEW

LORE:
${lore.replace(/^# .*\n+.*\n+/, "").trim()}

DECIDED CHANGES:
${text.trim()}`;
  const reply = await narrate([{ role: "user", content: ask }]);
  const lines = /^\s*NOTHING NEW\s*$/i.test(reply) ? "" : reply.replace(/\*+/g, "").split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim())
    .filter((l) => /^[A-Z][A-Z0-9 '&/-]{1,40}:\s+\S/.test(l)).join("\n");
  return { base, head, sections: used, cut, lines };
}
async function loreCatchupApply(b) {
  const head = String(b.head || "");
  if (!/^[0-9a-f]{40}$/.test(head)) throw Object.assign(new Error("Make a new draft first"), { status: 400 });
  const add = String(b.lines || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (add.join("\n").length > 12000) throw Object.assign(new Error("That's too much to add in one go"), { status: 400 });
  const commit = await editOnReview(LORE, (text) => {
    const lines = text.replace(/\s+$/, "").split("\n");
    const mark = `<!-- caught up to review@${head} -->`;
    // The marker rides on the line under the title, which the game drops before the narrator reads it.
    let at = lines.findIndex((l) => CAUGHT_UP.test(l));
    if (at < 0) { at = lines.findIndex((l, i) => i > 0 && l.trim()); if (at < 0) at = lines.push("") - 1; lines[at] = (lines[at] + " " + mark).trim(); }
    else lines[at] = lines[at].replace(CAUGHT_UP, mark);
    return lines.concat(add).join("\n") + "\n";
  }, add.length ? `Lore catch-up: ${add.length} line${add.length > 1 ? "s" : ""} for the narrator` : "Lore catch-up: nothing new");
  return { sha: commit ? commit.sha : "", url: commit ? commit.html_url : "", added: add.length };
}

// ── Sent in for review ──
// Anyone can send a Codex note or a character for review, but only the
// owner puts things on the review branch. What others send waits here, on
// the laptop, until the owner files it or turns it down on the review page.
const INBOX = () => path.join(SAVE_DIR, "review-inbox");
const MAX_INBOX = 200;
async function inboxList() {
  let files = [];
  try { files = (await fs.readdir(INBOX())).filter((f) => f.endsWith(".json")); } catch { }
  const items = [];
  for (const f of files) { try { items.push(JSON.parse(await fs.readFile(path.join(INBOX(), f), "utf8"))); } catch { } }
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
async function inboxAdd(it) {
  const now = await inboxList();
  if (now.length >= MAX_INBOX) throw Object.assign(new Error("The review queue is full. Try again after the owner has been through it."), { status: 503 });
  // The same note or character sent again replaces what's waiting.
  const old = it.key && now.find((x) => x.key === it.key);
  const rec = { ...it, id: old ? old.id : crypto.randomBytes(9).toString("base64url"), at: new Date().toISOString() };
  await fs.mkdir(INBOX(), { recursive: true });
  const file = path.join(INBOX(), rec.id + ".json");
  await fs.writeFile(file + ".tmp", JSON.stringify(rec, null, 2));
  await fs.rename(file + ".tmp", file);
  return rec.id;
}
const inboxFile = (id) => /^[A-Za-z0-9_-]{6,40}$/.test(String(id || "")) ? path.join(INBOX(), id + ".json") : null;

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
        const it = reviewItem(await readJson(req), { owner: true });
        const r = await fileReviewItem(it);
        console.log(new Date().toISOString(), it.source, "item filed on review:", it.title, r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "GET" && url.pathname === "/admin/inbox") return send(res, 200, { items: await inboxList() }, origin);
      if (req.method === "POST" && url.pathname === "/admin/inbox") {
        const b = await readJson(req), file = inboxFile(b.id);
        let rec = null; try { rec = file && JSON.parse(await fs.readFile(file, "utf8")); } catch { }
        if (!rec) return send(res, 404, { error: "That item isn't waiting any more" }, origin);
        if (b.action === "dismiss") { await fs.rm(file, { force: true }); return send(res, 200, { ok: true }, origin); }
        if (b.action !== "file" && b.action !== "accept") return send(res, 400, { error: "file, accept or dismiss" }, origin);
        // The owner may have edited the title and text. "file" keeps it a
        // pitch; "accept" is the owner deciding it, so it goes in as Your idea.
        const accept = b.action === "accept";
        const it = reviewItem({ ...rec, title: b.title ?? rec.title, body: b.body ?? rec.body, key: String(rec.key || "").split(":").slice(1).join(":"), decided: accept, loreLine: "" }, { owner: accept });
        const r = await fileReviewItem(it);
        await fs.rm(file, { force: true });
        console.log(new Date().toISOString(), "sent-in", it.source, "item filed on review:", it.title, r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "POST" && url.pathname === "/admin/accept-pitch") {
        const r = await acceptPitch(await readJson(req));
        console.log(new Date().toISOString(), "pitch accepted on review:", r.name, r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "POST" && url.pathname === "/admin/reject-pitch") {
        const r = await rejectPitch(await readJson(req));
        console.log(new Date().toISOString(), "pitch rejected on review:", r.name, r.sha);
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "POST" && url.pathname === "/admin/lore-catchup") {
        const r = await loreCatchupDraft();
        console.log(new Date().toISOString(), "lore catch-up drafted:", r.sections.length, "changed sections");
        return send(res, 200, { ok: true, ...r }, origin);
      }
      if (req.method === "POST" && url.pathname === "/admin/lore-catchup/apply") {
        const r = await loreCatchupApply(await readJson(req));
        console.log(new Date().toISOString(), "lore caught up on review:", r.added, "lines", r.sha);
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
    if (req.method !== "POST" || !["/narrate", "/save", "/suggest"].includes(url.pathname)) return send(res, 404, { error: "Not here" }, origin);
    const body = await readJson(req);
    if (url.pathname === "/suggest") {
      if (!allowed("suggest:" + clientIp(req), { n: 20, ms: PER_IP.ms })) return send(res, 429, { error: "That's a lot sent at once. Wait a few minutes." }, origin);
      const it = reviewItem(body, { owner: false });
      await inboxAdd(it);
      console.log(new Date().toISOString(), "sent in for review:", it.source, it.title);
      return send(res, 200, { ok: true, queued: true }, origin);
    }
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
