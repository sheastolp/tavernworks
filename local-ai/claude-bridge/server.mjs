#!/usr/bin/env node
// Claude Code bridge: lets the browser chat (tavernworks.dev/local-ai/chat/)
// use Claude Code on the laptop. Each message runs `claude -p` in a work
// folder and streams its output back; the chat keeps the session going
// across messages.
//
//   GET  /health   { ok, claude, version, cwd, mode, disallowed }
//   POST /chat     { prompt, session_id?, model? }  →  Claude Code's stream-json lines
//
// Every request needs the token (Authorization: Bearer …), and only the
// websites in CLAUDE_BRIDGE_ORIGINS may call it from a browser.
//
//   node server.mjs           run the bridge (default port 8792)
//   node server.mjs token     print the token (made on first run)
//
// No dependencies, Node 18 or newer. See README.md for the full setup.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8792);
const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const ORIGINS = (process.env.CLAUDE_BRIDGE_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
const CLAUDE = process.env.CLAUDE_BRIDGE_CLAUDE || "claude";
const CWD = process.env.CLAUDE_BRIDGE_CWD || path.join(os.homedir(), "workspace");
// What Claude Code may do without asking (no one is there to ask): by
// default read and edit files in the work folder and search the web, but
// not run commands.
const MODE = process.env.CLAUDE_BRIDGE_MODE || "acceptEdits";
const DISALLOWED = (process.env.CLAUDE_BRIDGE_DISALLOW ?? "Bash").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.CLAUDE_BRIDGE_TIMEOUT_S || 600) * 1000;
const MAX_JOBS = Number(process.env.CLAUDE_BRIDGE_MAX_JOBS || 2);
const MAX_BODY = 8 * 1024 * 1024;
const TOKEN_FILE = process.env.CLAUDE_BRIDGE_TOKEN_FILE || path.join(os.homedir(), ".config/claude-bridge/token");

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 24) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
if (process.argv[2] === "token") {
  console.log(TOKEN);
  process.exit(0);
}
fs.mkdirSync(CWD, { recursive: true });

const sameToken = (given) => {
  const a = Buffer.from(String(given || "")), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// `claude --version`, checked at most once a minute.
let version = { at: 0, value: null };
function claudeVersion() {
  if (Date.now() - version.at < 60_000) return Promise.resolve(version.value);
  return new Promise((resolve) => {
    execFile(CLAUDE, ["--version"], { timeout: 15_000 }, (err, out) => {
      version = { at: Date.now(), value: err ? null : String(out).trim() };
      resolve(version.value);
    });
  });
}

function headers(req, extra = {}) {
  const h = { "Cache-Control": "no-store", Vary: "Origin", ...extra };
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    // Chrome asks before a public website may call a private-network address.
    h["Access-Control-Allow-Private-Network"] = "true";
  }
  return h;
}
function json(req, res, status, body) {
  res.writeHead(status, headers(req, { "Content-Type": "application/json; charset=utf-8" }));
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("That message is too big."), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let jobs = 0;
async function chat(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return json(req, res, e.status || 400, { error: e.status ? e.message : "The request wasn't valid JSON." }); }
  const prompt = String(body.prompt || "").trim();
  const session = String(body.session_id || "");
  const model = String(body.model || "");
  if (!prompt) return json(req, res, 400, { error: "The message is empty." });
  if (session && !/^[0-9a-f-]{36}$/i.test(session)) return json(req, res, 400, { error: "That session ID isn't valid." });
  if (model && !/^[a-z0-9][a-z0-9.\-]{0,63}$/i.test(model)) return json(req, res, 400, { error: "That model name isn't valid." });
  if (jobs >= MAX_JOBS) return json(req, res, 429, { error: `Claude Code is already busy with ${jobs} message${jobs === 1 ? "" : "s"}. Try again when ${jobs === 1 ? "it's" : "they're"} done.` });

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", MODE];
  if (DISALLOWED.length) args.push("--disallowedTools", DISALLOWED.join(","));
  if (session) args.push("--resume", session);
  if (model) args.push("--model", model);

  jobs++;
  res.writeHead(200, headers(req, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" }));
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
  // The prompt goes in on stdin: attached files can be far longer than a
  // command-line argument may be.
  const child = spawn(CLAUDE, args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let stderr = "", sawResult = false, buf = "";
  const timer = setTimeout(() => { send({ type: "bridge_error", error: `Claude Code took longer than ${TIMEOUT_MS / 60000} minutes, so it was stopped.` }); child.kill("SIGTERM"); }, TIMEOUT_MS);
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (/^\{"type":"result"/.test(line)) sawResult = true;
      if (!res.writableEnded) res.write(line + "\n");
    }
  });
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  child.on("error", (e) => {
    send({ type: "bridge_error", error: e.code === "ENOENT" ? `Can't find the ${CLAUDE} command on the laptop.` : e.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    jobs--;
    if (buf.trim() && !res.writableEnded) res.write(buf.trim() + "\n");
    if (code && !sawResult) {
      const why = stderr.trim().split("\n").filter(Boolean).pop() || `Claude Code stopped (exit code ${code}).`;
      console.warn(`claude exited ${code}: ${stderr.trim()}`);
      send({ type: "bridge_error", error: /log ?in|authenticat|api key/i.test(stderr) ? "Claude Code isn't logged in on the laptop. See the bridge's README." : why });
    }
    res.end();
  });
  // The chat's Stop button closes the connection: stop Claude Code too.
  res.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ORIGINS.includes(origin)) return json(req, res, 403, { error: `This bridge doesn't allow ${origin}. Add it to CLAUDE_BRIDGE_ORIGINS.` });
  if (req.method === "OPTIONS") return json(req, res, 204);
  const url = new URL(req.url, "http://localhost");
  if (!sameToken((req.headers.authorization || "").replace(/^Bearer\s+/i, ""))) return json(req, res, 401, { error: "Wrong or missing token." });
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      const v = await claudeVersion();
      return json(req, res, 200, { ok: true, claude: !!v, version: v, cwd: CWD, mode: MODE, disallowed: DISALLOWED });
    }
    if (url.pathname === "/chat" && req.method === "POST") return await chat(req, res);
    return json(req, res, 404, { error: "Not found." });
  } catch (e) {
    console.warn(e);
    if (!res.headersSent) json(req, res, 500, { error: e.message || "Something went wrong." });
    else res.end();
  }
});
server.listen(PORT, HOST, () => console.log(`Claude Code bridge on http://${HOST}:${PORT}, working in ${CWD} (allowing ${ORIGINS.join(", ")})`));
