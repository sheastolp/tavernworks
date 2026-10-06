#!/usr/bin/env node
// Hushwave suggestion box: a tiny server that keeps suggestions on this
// machine, in one JSON file. Anyone can drop a suggestion in; reading them
// takes the one admin password. It also keeps the homepage's tip jar links,
// which anyone can read and only the admin can change, and a support desk:
// anyone can open a ticket and follow it with the key they get back, and the
// admin answers, triages and closes them.
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
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const PORT = Number(process.env.SUGGEST_PORT || 8790);
const ORIGINS = (process.env.SUGGEST_ORIGINS || "https://tavernworks.dev").split(",").map((s) => s.trim()).filter(Boolean);
const KINDS = ["Feature idea", "New sound", "Bug report", "Something else"];
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_STORED = 5000;
const TICKET_CATEGORIES = ["Bot problem", "Hushwave", "TwitchBotSandbox", "Local AI", "Bug report", "Something else"]; // keep in step with /support/
const TICKET_STATUSES = ["open", "pending", "resolved", "closed"]; // pending = waiting on the person who opened it
const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"];
const MAX_TICKET_MESSAGES = 200;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

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
let tickets = readJson(TICKETS_FILE, []);
const saveTickets = () => writeJson(TICKETS_FILE, tickets);

// ── sessions: "<expiry>.<hmac>", signed with the secret in admin.json ──
const sign = (exp) => crypto.createHmac("sha256", auth.secret).update(String(exp)).digest("hex");
const newToken = () => { const exp = Date.now() + SESSION_MS; return `${exp}.${sign(exp)}`; };
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
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameHex = (a, b) => { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const cleanEmail = (s) => { const e = clean(s, 120).toLowerCase(); return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e) ? e : ""; };

// What each side gets to see of a ticket. Internal notes are admin only,
// and the access key is only ever stored as a hash.
const ticketView = (t, admin) => {
  const { keyHash, ...rest } = t;
  return admin ? rest : { ...rest, email: undefined, priority: undefined, tags: undefined, messages: t.messages.filter((m) => !m.internal) };
};
const ticketSummary = (t) => {
  const last = t.messages.filter((m) => !m.internal).at(-1);
  return {
    id: t.id, number: t.number, subject: t.subject, category: t.category, name: t.name, email: t.email,
    status: t.status, priority: t.priority, tags: t.tags, created: t.created, updated: t.updated,
    messageCount: t.messages.length, needsReply: !!last && last.from === "customer" && t.status !== "closed",
  };
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 16384) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Ticket-Key");
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

    // ── Support tickets ──
    // Anyone: open a ticket. The key in the reply is the only way back in, so
    // the page should show it (or keep it) for them.
    if (req.method === "POST" && url.pathname === "/tickets") {
      if (limited("t:" + ip, 3, 10 * 60 * 1000)) return send(res, 429, { error: "Easy, adventurer. Try again in a few minutes." });
      const b = await readBody(req);
      if (b.website) return send(res, 201, { ok: true }); // a bot filled the hidden field
      const subject = clean(b.subject, 120);
      const message = clean(b.message, 4000);
      if (subject.length < 3) return send(res, 400, { error: "Give it a short subject." });
      if (message.length < 10) return send(res, 400, { error: "Tell us a bit more about what's going on." });
      if (b.email && !cleanEmail(b.email)) return send(res, 400, { error: "That email doesn't look right." });
      const now = new Date().toISOString();
      const key = crypto.randomBytes(24).toString("base64url");
      const ticket = {
        id: crypto.randomUUID(),
        number: tickets.reduce((n, t) => Math.max(n, t.number || 0), 0) + 1,
        keyHash: sha256(key),
        created: now,
        updated: now,
        name: clean(b.name, 60) || "Anonymous",
        email: cleanEmail(b.email),
        category: TICKET_CATEGORIES.includes(b.category) ? b.category : "Something else",
        subject,
        status: "open",
        priority: "normal",
        tags: [],
        messages: [{ id: crypto.randomUUID(), at: now, from: "customer", text: message }],
      };
      tickets.unshift(ticket);
      tickets = tickets.slice(0, MAX_STORED);
      saveTickets();
      return send(res, 201, { id: ticket.id, number: ticket.number, key, status: ticket.status });
    }

    if (req.method === "GET" && url.pathname === "/tickets") {
      if (!isAdmin()) return send(res, 401, { error: "Log in again." });
      const status = url.searchParams.get("status");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const list = tickets
        .filter((t) => !status || t.status === status)
        .filter((t) => !q || [t.subject, t.name, t.email, String(t.number), ...t.messages.map((m) => m.text)].join("\n").toLowerCase().includes(q))
        .map(ticketSummary);
      const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, tickets.filter((t) => t.status === s).length]));
      return send(res, 200, { tickets: list, counts, categories: TICKET_CATEGORIES, statuses: TICKET_STATUSES, priorities: TICKET_PRIORITIES });
    }

    if (url.pathname.startsWith("/tickets/")) {
      const [, , id, sub, extra] = url.pathname.split("/");
      const ticket = tickets.find((t) => t.id === id || String(t.number) === id); // id or the short #number
      const admin = isAdmin();
      // The person who opened it proves it with their key. Wrong keys count
      // against a limit so they can't be guessed.
      let owner = false;
      if (!admin) {
        const key = String(req.headers["x-ticket-key"] || "");
        const misses = (hits.get("tk:" + ip) || []).filter((t) => Date.now() - t < 15 * 60 * 1000).length;
        if (misses >= 20) return send(res, 429, { error: "Too many tries. Wait 15 minutes." });
        owner = !!ticket && !!key && sameHex(sha256(key), ticket.keyHash);
        if (!owner) { limited("tk:" + ip, 20, 15 * 60 * 1000); return send(res, 404, { error: "No ticket with that number and key." }); }
      } else if (!ticket) return send(res, 404, { error: "Not found." });
      if (extra !== undefined) return send(res, 404, { error: "Not found." });

      if (req.method === "GET" && !sub) return send(res, 200, ticketView(ticket, admin));

      // Either side: add a reply. Admin replies wait on the customer; a
      // customer reply puts it back in the admin's queue, reopening it.
      if (req.method === "POST" && sub === "messages") {
        if (!admin && limited("tm:" + ip, 10, 10 * 60 * 1000)) return send(res, 429, { error: "Easy, adventurer. Try again in a few minutes." });
        const b = await readBody(req);
        const text = clean(b.message, 4000);
        if (text.length < 1) return send(res, 400, { error: "Write something first." });
        if (ticket.messages.length >= MAX_TICKET_MESSAGES) return send(res, 400, { error: "This ticket is full. Open a new one." });
        if (!admin && ticket.status === "closed") return send(res, 400, { error: "This ticket is closed. Open a new one." });
        const internal = admin && b.internal === true;
        const now = new Date().toISOString();
        ticket.messages.push({ id: crypto.randomUUID(), at: now, from: admin ? "admin" : "customer", text, ...(internal ? { internal: true } : {}) });
        if (!internal) {
          if (admin) ticket.status = TICKET_STATUSES.includes(b.status) ? b.status : "pending";
          else ticket.status = "open";
        }
        ticket.updated = now;
        saveTickets();
        return send(res, 201, ticketView(ticket, admin));
      }

      // Customer: mark their own ticket resolved.
      if (req.method === "POST" && sub === "resolve" && owner) {
        if (ticket.status !== "closed") ticket.status = "resolved";
        ticket.updated = new Date().toISOString();
        saveTickets();
        return send(res, 200, ticketView(ticket, false));
      }

      if (!admin || sub) return send(res, 404, { error: "Not found." });

      // Admin: triage.
      if (req.method === "PATCH") {
        const b = await readBody(req);
        if (b.status !== undefined) {
          if (!TICKET_STATUSES.includes(b.status)) return send(res, 400, { error: "Unknown status." });
          ticket.status = b.status;
        }
        if (b.priority !== undefined) {
          if (!TICKET_PRIORITIES.includes(b.priority)) return send(res, 400, { error: "Unknown priority." });
          ticket.priority = b.priority;
        }
        if (b.category !== undefined && TICKET_CATEGORIES.includes(b.category)) ticket.category = b.category;
        if (Array.isArray(b.tags)) ticket.tags = [...new Set(b.tags.map((t) => clean(t, 30).toLowerCase()).filter(Boolean))].slice(0, 10);
        ticket.updated = new Date().toISOString();
        saveTickets();
        return send(res, 200, ticketView(ticket, true));
      }
      if (req.method === "DELETE") {
        tickets = tickets.filter((t) => t !== ticket);
        saveTickets();
        return send(res, 200, { ok: true });
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
  console.log(`Suggestion box listening on 127.0.0.1:${PORT}, storing in ${DB_FILE}`);
  console.log(`Allowed sites: ${ORIGINS.join(", ")}`);
});
