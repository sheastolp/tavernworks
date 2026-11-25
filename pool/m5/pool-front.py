#!/usr/bin/env python3
# AI Pool — the public front door (M5a), served by the FX705 behind
# the pool.tavernworks.dev Cloudflare Tunnel.
#
# PUBLIC-SAFE ENDPOINTS ONLY. The M3 control page is a different
# service that stays on the tailnet and is never exposed here.
#
#   GET  /              small landing page (status summary + links)
#   GET  /status.json   pool status, proxied from the tailnet
#                       coordinator (short cache; a static fallback
#                       answers if the coordinator is unreachable)
#   GET  /downloads/    component list with sizes + SHA-256
#   GET  /downloads/<f> the files themselves, with HTTP Range so
#                       downloads resume (design rule: no component
#                       over 512 MB; versioned filenames)
#   POST /enroll        register a machine -> {id, key, pending}
#                       The key is shown ONCE; only its SHA-256 is
#                       stored. The operator approves or revokes
#                       from the tailnet control page.
#   GET  /enroll/<id>?key=...   poll enrollment status
#   GET  /relay        (M5b) WebSocket upgrade: an APPROVED worker
#                       dials out here (headers X-Enrollment-Id /
#                       X-Enrollment-Key); the front bridges the
#                       connection to a per-machine localhost port
#                       that llama-server can target with --rpc.
#                       Revoking the enrollment cuts the relay.
#
#   M6 accounts + shares:
#   GET  /register      signup page (the key is shown once)
#   POST /register      create an account -> {id, key, pending}
#   GET  /chat          web chat page (account key in the browser)
#   GET  /me            {name, status, balance} for a Bearer key
#   POST /link          link an enrollment to your account, so its
#                       machine earns shares for you
#   POST /v1/chat/completions  the API door (Bearer account key):
#                       one open FIFO queue, shares charged per
#                       token generated from the append-only ledger;
#                       prompts and replies are never logged
#   GET  /v1/models     model list for an approved key
#   GET  /shares.json   published rates + balances (pool stats)
#   GET  /queue.json    {inflight, waiting, paused}
#
#   M7 MCP, both ways:
#   POST /mcp           the pool as an MCP server (JSON-RPC 2.0,
#                       Bearer account key): pool_chat, pool_status,
#                       pool_models, pool_balance
#   chat opt-in         {"mcp_tools": true} on the API door offers
#                       the operator-registered MCP servers' tools
#                       to the pooled model; calls are executed and
#                       fed back for up to 3 rounds
#
# Python 3 standard library only. Binds localhost by default —
# cloudflared is the public face. Test hooks: POOL_DIR,
# POOL_FRONT_BIND, POOL_FRONT_PORT, POOL_COORD_URL.
import base64
import hashlib
import json
import os
import socket
import struct
import secrets
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
    CENTRAL = ZoneInfo("America/Chicago")
except Exception:  # no tzdata on the box: a fixed CST offset beats crashing
    from datetime import timezone as _tz, timedelta as _td
    CENTRAL = _tz(_td(hours=-6), "CST")


def now_central():
    return datetime.now(CENTRAL)
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HOME = os.path.expanduser("~")
if HOME == "~":
    HOME = "/root"
POOL_DIR = os.environ.get("POOL_DIR", os.path.join(HOME, "ai-pool"))
DOWNLOADS_DIR = os.path.join(POOL_DIR, "downloads")
ENROLL_PATH = os.path.join(POOL_DIR, "enrollments.json")
PORT = int(os.environ.get("POOL_FRONT_PORT", "8092"))
COORD_URL = os.environ.get("POOL_COORD_URL", "http://100.100.40.72:8091/status.json")
MAX_COMPONENT_MB = 512
RELAY_STATE_PATH = os.path.join(POOL_DIR, "relay-state.json")
RELAY_BASE_PORT = int(os.environ.get("POOL_RELAY_BASE_PORT", "51100"))
RELAY_PORTS_PATH = os.path.join(POOL_DIR, "relay-ports.json")
RELAY_PUBLIC_PATH = "/relay"
# Model pre-download (served at /model.json): where workers fetch the
# pool's current model from, so a split never has to push their
# slice over this machine's upload. Add a line to
# ~/ai-pool/model-sources.json for any other model, e.g.
#   {"My-Model.Q4_K_M.gguf": {"url": "https://huggingface.co/.../resolve/main/My-Model.Q4_K_M.gguf"}}
# The file name must be exactly the .gguf in ~/ai-pool, and the
# download must be that same file (workers check its size).
CURRENT_MODEL_PATH = os.path.join(POOL_DIR, "current-model.txt")
MODEL_SOURCES_PATH = os.path.join(POOL_DIR, "model-sources.json")
DEFAULT_MODEL = "Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf"
BUILTIN_MODEL_SOURCES = {
    # The pool's default (solo + split). Repo and exact file name as
    # pinned in M1-RUNBOOK.md; workers also check the size matches.
    "Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf": {
        "url": "https://huggingface.co/mradermacher/Qwen2.5-14B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf",
    },
    "huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf": {
        "url": "https://huggingface.co/bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF/resolve/main/huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf",
        "sha256": "d76889059a3bfab30bc565012a0184827ff2bdc10197f6babc24541b98451dbe",
    },
    "qwen2.5-1.5b-instruct-q4_k_m.gguf": {
        "url": "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    },
}
# The front pings every relayed worker this often, so the WebSocket
# never sits silent: a split's RPC link idles for minutes while the
# host loads other machines' layers, and both the worker's watchdog
# and Cloudflare's idle cut-off treat a silent socket as dead.
RELAY_PING_SEC = float(os.environ.get("POOL_RELAY_PING_SEC", "20"))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ACCOUNTS_PATH = os.path.join(POOL_DIR, "accounts.json")
LEDGER_PATH = os.path.join(POOL_DIR, "ledger.jsonl")
SHARES_CFG_PATH = os.path.join(POOL_DIR, "shares-config.json")
BRAIN_URL = os.environ.get("POOL_BRAIN_URL", "http://100.100.40.72:8090")
COORD_STATE_URL = os.environ.get(
    "POOL_COORD_STATE_URL", COORD_URL.rsplit("/", 1)[0] + "/api/state")
EARN_TICK_SEC = float(os.environ.get("POOL_EARN_TICK_SEC", "60"))
QUEUE_WAIT_SEC = float(os.environ.get("POOL_QUEUE_WAIT_SEC", "180"))
DEFAULT_SHARES = {
    "starter": 100.0,
    "earn_per_gb_hour": 1.0,
    "worked_multiplier": 3.0,
    "spend_per_1k_tokens": 10.0,
    "max_output_tokens": 1024,
    "max_context_chars": 48000,
    "public_max_inflight": 2,
    "public_paused": False,
}

_lock = threading.Lock()
_hash_cache = {}
_status_cache = {"at": 0, "data": None}


def now_iso():
    return datetime.now(CENTRAL).isoformat(timespec="seconds")


def sha256_file(path):
    st = os.stat(path)
    key = (path, st.st_size, int(st.st_mtime))
    if key in _hash_cache:
        return _hash_cache[key]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    _hash_cache[key] = h.hexdigest()
    return _hash_cache[key]


def components():
    out = []
    try:
        names = sorted(os.listdir(DOWNLOADS_DIR))
    except Exception:
        names = []
    for name in names:
        path = os.path.join(DOWNLOADS_DIR, name)
        if os.path.isfile(path):
            out.append({
                "name": name,
                "size_bytes": os.path.getsize(path),
                "sha256": sha256_file(path),
            })
    return out


def load_enrollments():
    try:
        with open(ENROLL_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("enrollments"), list):
            return data
    except Exception:
        pass
    return {"enrollments": []}


def save_enrollments(data):
    tmp = ENROLL_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, ENROLL_PATH)


def pool_status():
    if time.time() - _status_cache["at"] < 15 and _status_cache["data"]:
        return _status_cache["data"]
    try:
        with urllib.request.urlopen(COORD_URL, timeout=4) as r:
            data = json.loads(r.read().decode())
        _status_cache.update(at=time.time(), data=data)
        return data
    except Exception:
        return _status_cache["data"] or {
            "brain": "Status unavailable",
            "model": "—",
            "serving": "—",
            "split": "—",
            "enrollment": "Open — worker app available; operator approves each machine",
            "speed": "—",
            "updated": datetime.now(CENTRAL).strftime("%d %b %Y %H:%M %Z"),
        }


def create_enrollment(fields):
    name = str(fields.get("name") or "").strip()[:60]
    if not name:
        return 400, {"error": "a machine name is required"}
    try:
        offered = int(fields.get("offered_mb") or 0)
    except (TypeError, ValueError):
        return 400, {"error": "offered_mb must be a number of MB"}
    if offered < 512 or offered > 1048576:
        return 400, {"error": "offered_mb must be between 512 and 1048576"}
    key = secrets.token_urlsafe(24)
    rec = {
        "id": uuid.uuid4().hex,
        "name": name,
        "contact": str(fields.get("contact") or "")[:120],
        "offered_mb": offered,
        "gpu": str(fields.get("gpu") or "")[:80],
        "os": str(fields.get("os") or "")[:40],
        "key_hash": hashlib.sha256(key.encode()).hexdigest(),
        "status": "pending",
        "created": now_iso(),
        "decided": None,
    }
    with _lock:
        data = load_enrollments()
        data["enrollments"].append(rec)
        save_enrollments(data)
    return 201, {
        "id": rec["id"],
        "key": key,
        "status": "pending",
        "poll": "/enroll/" + rec["id"],
        "note": "Save the key now — it is shown once and cannot be recovered. "
                "The operator reviews enrollments by hand; poll until approved.",
    }


def enrollment_status(eid, key):
    data = load_enrollments()
    for rec in data["enrollments"]:
        if rec["id"] == eid:
            if not key or not secrets.compare_digest(
                    hashlib.sha256(key.encode()).hexdigest(), rec["key_hash"]):
                return 403, {"error": "bad key"}
            out = {"id": eid, "status": rec["status"], "name": rec["name"]}
            if rec["status"] == "approved":
                out["relay"] = RELAY_PUBLIC_PATH
                out["relay_note"] = ("Connect the worker to this pool address "
                                      "with a WebSocket upgrade on the relay "
                                      "path; it is bridged to a localhost "
                                      "port on the host.")
            return 200, out
    return 404, {"error": "no such enrollment"}

# ------------------------------------------------------------------
# M6 accounts + shares.
#
# Accounts: POST /register creates one (name + a personal key shown
# ONCE; only its SHA-256 is stored). The operator approves or revokes
# accounts from the tailnet control page; approval writes the starter
# balance into the ledger.
#
# Shares (DESIGN, decided 2026-11-15 — mining-pool style):
#   EARN  a relay-connected machine linked to an approved account
#         accrues offered-GB x hours x the base rate, times the
#         worked multiplier while its endpoint is in the live split.
#   SPEND a chat completion costs shares proportional to the tokens
#         generated, charged after a successful reply.
# The ledger (ledger.jsonl) is append-only; balances are a fold of
# it. Accounting records who / when / how many tokens — never prompt
# or reply text.
#
# The public doors share ONE open FIFO queue: at most
# public_max_inflight generations run at once. The operator's bots
# connect to the brain directly on the tailnet and never pass
# through here — that is their reserved lane.
# ------------------------------------------------------------------

import math
import urllib.error


def load_shares_cfg():
    cfg = dict(DEFAULT_SHARES)
    try:
        with open(SHARES_CFG_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update({k: v for k, v in data.items() if k in DEFAULT_SHARES})
    except Exception:
        pass
    return cfg


def load_accounts():
    try:
        with open(ACCOUNTS_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("accounts"), list):
            return data
    except Exception:
        pass
    return {"accounts": []}


def save_accounts(data):
    tmp = ACCOUNTS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, ACCOUNTS_PATH)


def create_account(fields):
    name = str(fields.get("name") or "").strip()[:60]
    if not name:
        return 400, {"error": "an account name is required"}
    with _lock:
        data = load_accounts()
        for rec in data["accounts"]:
            if rec["name"].lower() == name.lower() and rec["status"] != "revoked":
                return 409, {"error": "that name is taken — pick another"}
        key = secrets.token_urlsafe(24)
        rec = {
            "id": uuid.uuid4().hex,
            "name": name,
            "key_hash": hashlib.sha256(key.encode()).hexdigest(),
            "key_hint": key[-4:],
            "status": "pending",
            "created": now_iso(),
            "decided": None,
        }
        data["accounts"].append(rec)
        save_accounts(data)
    return 201, {"id": rec["id"], "key": key, "status": "pending",
                 "note": "Save the key now — it is shown once and cannot "
                         "be recovered. The operator approves accounts "
                         "by hand; the key works once approved."}


def account_for_key(key):
    if not key:
        return None
    digest = hashlib.sha256(key.encode()).hexdigest()
    for rec in load_accounts()["accounts"]:
        if secrets.compare_digest(digest, rec.get("key_hash", "")):
            return rec
    return None


def append_ledger(account_id, kind, shares, detail):
    line = json.dumps({"ts": now_iso(), "account": account_id, "kind": kind,
                       "shares": round(float(shares), 4),
                       "detail": str(detail)[:120]})
    with _lock:
        with open(LEDGER_PATH, "a") as f:
            f.write(line + "\n")


_ledger_cache = {"sig": None, "balances": {}}


def balances():
    try:
        st = os.stat(LEDGER_PATH)
        sig = (st.st_size, st.st_mtime_ns)
    except Exception:
        return {}
    if _ledger_cache["sig"] == sig:
        return _ledger_cache["balances"]
    out = {}
    try:
        with open(LEDGER_PATH) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    out[rec["account"]] = round(
                        out.get(rec["account"], 0.0) + float(rec["shares"]), 4)
                except Exception:
                    continue
    except Exception:
        pass
    _ledger_cache.update(sig=sig, balances=out)
    return out


def account_balance(account_id):
    return balances().get(account_id, 0.0)


class DoorQueue:
    # One open FIFO queue for the public doors. Tickets are served in
    # order; a waiter whose wait times out leaves a skip mark so the
    # queue behind it keeps moving.
    def __init__(self):
        self.cond = threading.Condition()
        self.inflight = 0
        self.waiting = 0
        self.next_ticket = 0
        self.serving = 0
        self.skipped = set()

    def _advance(self):
        while self.serving in self.skipped:
            self.skipped.discard(self.serving)
            self.serving += 1

    def acquire(self, max_inflight, timeout):
        deadline = time.time() + timeout
        with self.cond:
            ticket = self.next_ticket
            self.next_ticket += 1
            self.waiting += 1
            try:
                while True:
                    self._advance()
                    if ticket == self.serving and self.inflight < max_inflight:
                        self.serving += 1
                        self.inflight += 1
                        self.cond.notify_all()
                        return True
                    left = deadline - time.time()
                    if left <= 0:
                        self.skipped.add(ticket)
                        self._advance()
                        self.cond.notify_all()
                        return False
                    self.cond.wait(timeout=min(left, 1.0))
            finally:
                self.waiting -= 1

    def release(self):
        with self.cond:
            self.inflight = max(0, self.inflight - 1)
            self.cond.notify_all()

    def snapshot(self):
        with self.cond:
            return {"inflight": self.inflight, "waiting": self.waiting}


DOOR_QUEUE = DoorQueue()


def brain_request(method, path, body=None, timeout=30):
    req = urllib.request.Request(
        BRAIN_URL + path, data=body, method=method,
        headers={"Content-Type": "application/json",
                 "User-Agent": "pool-worker"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 502, json.dumps(
            {"error": "the pool brain is unreachable: " + str(e)}).encode()


def chat_completion(account, fields):
    cfg = load_shares_cfg()
    if cfg["public_paused"]:
        return 503, {"error": "public usage is paused by the operator"}
    if account["status"] != "approved":
        return 403, {"error": "account is " + account["status"] +
                              " — the operator approves accounts by hand"}
    messages = fields.get("messages")
    if not isinstance(messages, list) or not messages:
        return 400, {"error": "messages (a non-empty list) is required"}
    if fields.get("stream"):
        return 400, {"error": "streaming is not offered on the public "
                              "door yet — send stream:false"}
    chars = 0
    for m in messages:
        if isinstance(m, dict):
            chars += len(str(m.get("content") or ""))
    if chars > int(cfg["max_context_chars"]):
        return 413, {"error": "conversation too long for the public door (" +
                              str(chars) + " chars; cap " +
                              str(int(cfg["max_context_chars"])) + ")"}
    if account_balance(account["id"]) <= 0:
        return 402, {"error": "out of shares — contribute a machine to "
                              "earn more, or ask the operator for a gift"}
    body = dict(fields)
    try:
        want = int(fields.get("max_tokens") or 512)
    except (TypeError, ValueError):
        want = 512
    body["max_tokens"] = max(1, min(want, int(cfg["max_output_tokens"])))
    body["stream"] = False
    use_tools = bool(fields.get("mcp_tools"))
    body.pop("mcp_tools", None)
    tools, routes = [], {}
    if use_tools:
        body.pop("tools", None)
        tools, routes = mcp_aggregate_tools()
    if not DOOR_QUEUE.acquire(int(cfg["public_max_inflight"]), QUEUE_WAIT_SEC):
        return 429, {"error": "the queue did not move in time — try again "
                              "shortly", "queue": DOOR_QUEUE.snapshot()}
    total_tokens = 0
    data = None
    try:
        rounds = 0
        while True:
            rounds += 1
            send = dict(body)
            if tools:
                send["tools"] = tools
            status, raw = brain_request("POST", "/v1/chat/completions",
                                        json.dumps(send).encode(), timeout=300)
            if status != 200:
                return status, {"error": "the pool brain answered " + str(status),
                                "brain": raw.decode(errors="replace")[:300]}
            try:
                data = json.loads(raw.decode())
            except Exception:
                return 502, {"error": "the pool brain sent an unreadable reply"}
            usage = data.get("usage") or {}
            if isinstance(usage.get("completion_tokens"), int) and \
                    usage["completion_tokens"] > 0:
                total_tokens += usage["completion_tokens"]
            calls = []
            try:
                calls = data["choices"][0]["message"].get("tool_calls") or []
            except Exception:
                calls = []
            if not calls or rounds >= MCP_MAX_ROUNDS:
                break
            try:
                assistant_msg = data["choices"][0]["message"]
            except Exception:
                break
            new_messages = list(body["messages"]) + [assistant_msg]
            for call in calls:
                fn = call.get("function") or {}
                ns_name = fn.get("name") or ""
                try:
                    cargs = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    cargs = {}
                if ns_name in routes:
                    try:
                        text = mcp_call_tool(routes, ns_name, cargs)
                    except Exception as e:
                        text = "tool error: " + str(e)
                else:
                    text = "tool error: unknown tool " + ns_name
                new_messages.append({"role": "tool",
                                     "tool_call_id": call.get("id") or "",
                                     "content": text})
            body["messages"] = new_messages
    finally:
        DOOR_QUEUE.release()
    if total_tokens <= 0:
        try:
            content = data["choices"][0]["message"]["content"] or ""
        except Exception:
            content = ""
        total_tokens = max(1, len(content) // 4)
    if total_tokens > 0:
        cost = max(1, math.ceil(total_tokens / 1000.0 *
                                float(cfg["spend_per_1k_tokens"])))
        append_ledger(account["id"], "spend", -cost,
                      "chat " + str(total_tokens) + " tokens")
        data["pool"] = {"cost_shares": cost,
                        "balance": account_balance(account["id"])}
    return 200, data


def link_enrollment(account, fields):
    eid = str(fields.get("enrollment_id") or "")
    ekey = str(fields.get("enrollment_key") or "")
    if account["status"] != "approved":
        return 403, {"error": "account is " + account["status"]}
    with _lock:
        data = load_enrollments()
        for rec in data["enrollments"]:
            if rec["id"] == eid:
                if not ekey or not secrets.compare_digest(
                        hashlib.sha256(ekey.encode()).hexdigest(),
                        rec.get("key_hash", "")):
                    return 403, {"error": "bad enrollment key"}
                if rec["status"] != "approved":
                    return 409, {"error": "that enrollment is " + rec["status"]}
                rec["account_id"] = account["id"]
                save_enrollments(data)
                return 200, {"linked": eid, "machine": rec["name"],
                             "note": "the machine now earns shares for " +
                                     account["name"]}
    return 404, {"error": "no such enrollment"}


_state_cache2 = {"at": 0, "data": None}


def coord_state():
    if (time.time() - _state_cache2["at"] < 15 and
            _state_cache2["data"] is not None):
        return _state_cache2["data"]
    try:
        with urllib.request.urlopen(COORD_STATE_URL, timeout=4) as r:
            data = json.loads(r.read().decode())
        _state_cache2.update(at=time.time(), data=data)
        return data
    except Exception:
        return _state_cache2["data"] or {}


def earn_tick(hours):
    # Accrue shares for relay-connected machines linked to approved
    # accounts. Offered GB x hours x base rate, times the worked
    # multiplier while the machine's endpoint is in the live split.
    cfg = load_shares_cfg()
    try:
        with open(RELAY_STATE_PATH) as f:
            relay = json.load(f)
    except Exception:
        return
    machines = relay.get("machines") if isinstance(relay, dict) else None
    if not machines:
        return
    st = coord_state()
    rpc_list = str(st.get("rpc_list") or "")
    split_live = st.get("mode") == "split"
    enrollments = {r["id"]: r for r in load_enrollments()["enrollments"]}
    accounts = {a["id"]: a for a in load_accounts()["accounts"]}
    for m in machines:
        rec = enrollments.get(m.get("id") or "")
        if not rec or rec.get("status") != "approved":
            continue
        acct = accounts.get(rec.get("account_id") or "")
        if not acct or acct.get("status") != "approved":
            continue
        worked = bool(split_live and m.get("rpc") and m["rpc"] in rpc_list)
        mult = float(cfg["worked_multiplier"]) if worked else 1.0
        amount = round((float(rec.get("offered_mb") or 0) / 1024.0) *
                       float(cfg["earn_per_gb_hour"]) * float(hours) * mult, 4)
        if amount >= 0.0001:
            append_ledger(acct["id"], "earn", amount,
                          ("worked " if worked else "online ") +
                          str(rec.get("name")) + " " + str(round(hours, 3)) + "h")


def earn_loop():
    while True:
        time.sleep(EARN_TICK_SEC)
        try:
            earn_tick(EARN_TICK_SEC / 3600.0)
        except Exception:
            pass


def shares_public():
    cfg = load_shares_cfg()
    bals = balances()
    rows = []
    for a in load_accounts()["accounts"]:
        if a["status"] == "approved":
            rows.append({"name": a["name"], "balance": bals.get(a["id"], 0.0)})
    rows.sort(key=lambda r: -r["balance"])
    totals = {"earned": 0.0, "spent": 0.0}
    try:
        with open(LEDGER_PATH) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    if float(rec["shares"]) > 0:
                        totals["earned"] = round(
                            totals["earned"] + float(rec["shares"]), 4)
                    else:
                        totals["spent"] = round(
                            totals["spent"] - float(rec["shares"]), 4)
                except Exception:
                    continue
    except Exception:
        pass
    return {"rates": {"starter": cfg["starter"],
                      "earn_per_gb_hour": cfg["earn_per_gb_hour"],
                      "worked_multiplier": cfg["worked_multiplier"],
                      "spend_per_1k_tokens": cfg["spend_per_1k_tokens"]},
            "paused": bool(cfg["public_paused"]),
            "accounts": rows, "totals": totals, "updated": now_iso()}

CHAT_PAGE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Pool — Chat</title>
<style>
  body { background:#15100c; color:#e8ded0; font-family:Georgia, 'Times New Roman', serif; margin:0; }
  .wrap { max-width:760px; margin:0 auto; padding:24px 16px 48px; }
  h1 { color:#e0a84a; font-size:26px; margin:8px 0 4px; }
  a { color:#e0a84a; }
  .card { background:#241a13; border:1px solid #4a3826; border-radius:10px; padding:16px; margin:14px 0; }
  .muted { color:#b8a88f; font-size:14px; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; background:#15100c; color:#e8ded0; border:1px solid #4a3826; border-radius:6px; padding:9px; margin:4px 0 8px; }
  textarea { width:100%; box-sizing:border-box; background:#15100c; color:#e8ded0; border:1px solid #4a3826; border-radius:6px; padding:9px; min-height:64px; }
  button { background:#e0a84a; color:#15100c; border:0; border-radius:6px; padding:9px 18px; font-weight:bold; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .msg { margin:10px 0; padding:10px 12px; border-radius:8px; white-space:pre-wrap; word-wrap:break-word; }
  .user { background:#2e2115; border:1px solid #4a3826; }
  .assistant { background:#1d1712; border:1px solid #3a2d1e; }
  .who { color:#e0a84a; font-size:12px; text-transform:uppercase; letter-spacing:1px; }
  #status { min-height:20px; }
  .row { display:flex; gap:8px; } .row > * { flex:1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>AI Pool — Chat</h1>
  <p class="muted">Chat with the pooled model. Usage spends shares; contributing a machine earns them. <a href="/">Pool home</a> · <a href="/register">Get an account</a></p>

  <div class="card">
    <div class="who">Your account key</div>
    <input type="password" id="key" placeholder="Paste your account key">
    <div class="row">
      <button id="savekey" type="button">Save key</button>
      <button id="check" type="button">Check balance</button>
    </div>
    <p class="muted" id="account">No key saved yet. Keys are shown once, when the account is created.</p>
    <p class="muted">API door: POST /v1/chat/completions · MCP door: POST /mcp — same key, in an Authorization: Bearer header.</p>
  </div>

  <div class="card">
    <div id="log"></div>
    <p class="muted" id="status"></p>
    <textarea id="input" placeholder="Say something to the pooled model…"></textarea>
    <label class="muted" style="display:block;margin:6px 0"><input type="checkbox" id="usetools"> Let the model use registered tools (MCP)</label>
    <button id="send" type="button">Send</button>
  </div>

  <div class="card">
    <div class="who">Link a machine you enrolled</div>
    <p class="muted">Machines earn shares for the account they are linked to. When the operator approves your machine, the worker prints a personal link — open it and this form fills itself in. (The enrollment id and key also live in the worker's config file.)</p>
    <input type="text" id="linkid" placeholder="Enrollment id">
    <input type="password" id="linkkey" placeholder="Enrollment key">
    <button id="link" type="button">Link machine</button>
    <p class="muted" id="linkmsg"></p>
  </div>
</div>
<script>
"use strict";
var chatHistory = [];
function el(id) { return document.getElementById(id); }
function key() { return el("key").value.trim(); }
function headers() { return { "Content-Type": "application/json", "Authorization": "Bearer " + key() }; }
function showAccount(text) { el("account").textContent = text; }
function refreshBalance() {
  if (!key()) { showAccount("No key saved yet."); return; }
  fetch("/me", { headers: headers() }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { showAccount(res.j.error || "That key was not accepted."); return; }
      showAccount(res.j.name + " — status: " + res.j.status + " — balance: " + res.j.balance + " shares");
    }).catch(function () { showAccount("Could not reach the pool front door."); });
}
function persistKey(k) {
  try { localStorage.setItem("poolkey", k); } catch (e) {}
  try { sessionStorage.setItem("poolkey", k); } catch (e) {}
  try { history.replaceState(null, "", "#k=" + encodeURIComponent(k)); } catch (e) {}
}
function storedKey() {
  if (location.hash.indexOf("#k=") === 0) {
    try { return decodeURIComponent(location.hash.slice(3)); } catch (e) {}
  }
  try { var v = localStorage.getItem("poolkey"); if (v) return v; } catch (e) {}
  try { return sessionStorage.getItem("poolkey"); } catch (e) {}
  return "";
}
el("savekey").addEventListener("click", function () {
  if (!key()) { showAccount("Paste your account key into the box first — it is shown once on the register page, when the account is created."); return; }
  persistKey(key());
  showAccount("Key saved — checking…");
  refreshBalance();
});
el("check").addEventListener("click", refreshBalance);
var savedKey = storedKey();
if (savedKey) { el("key").value = savedKey; refreshBalance(); }
function linkFromFragment() {
  if (location.hash.indexOf("#link=") !== 0) { return; }
  var raw = location.hash.slice(6);
  var dot = raw.indexOf(".");
  if (dot < 1) { return; }
  try {
    el("linkid").value = decodeURIComponent(raw.slice(0, dot));
    el("linkkey").value = decodeURIComponent(raw.slice(dot + 1));
    el("linkmsg").textContent = "Your machine's details are filled in from its link — save your account key above, then click Link machine.";
    el("linkid").scrollIntoView();
  } catch (e) {}
}
linkFromFragment();
function addMsg(who, text) {
  var d = document.createElement("div");
  d.className = "msg " + who;
  var w = document.createElement("div");
  w.className = "who";
  w.textContent = who === "user" ? "You" : "Pool";
  var t = document.createElement("div");
  t.textContent = text;
  d.appendChild(w); d.appendChild(t);
  el("log").appendChild(d);
  window.scrollTo(0, document.body.scrollHeight);
}
el("send").addEventListener("click", function () {
  var text = el("input").value.trim();
  if (!text) { return; }
  if (!key()) { el("status").textContent = "Save your account key first."; return; }
  el("input").value = "";
  addMsg("user", text);
  chatHistory.push({ role: "user", content: text });
  el("send").disabled = true;
  el("status").textContent = "Sending…";
  var poller = setInterval(function () {
    fetch("/queue.json").then(function (r) { return r.json(); }).then(function (q) {
      if (q.paused) { el("status").textContent = "Public usage is paused by the operator."; }
      else if (q.waiting > 0) { el("status").textContent = "In the open queue — " + q.waiting + " waiting, " + q.inflight + " generating…"; }
      else { el("status").textContent = "Generating…"; }
    }).catch(function () {});
  }, 2000);
  fetch("/v1/chat/completions", { method: "POST", headers: headers(), body: JSON.stringify({ messages: chatHistory.slice(-20), max_tokens: 512, mcp_tools: el("usetools").checked }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function (res) {
      clearInterval(poller);
      el("send").disabled = false;
      if (!res.ok) {
        el("status").textContent = (res.j.error && (res.j.error.message || res.j.error)) || ("Request failed (" + res.status + ")");
        chatHistory.pop();
        return;
      }
      var reply = res.j.choices && res.j.choices[0] && res.j.choices[0].message && res.j.choices[0].message.content || "";
      addMsg("assistant", reply);
      chatHistory.push({ role: "assistant", content: reply });
      el("status").textContent = "";
      refreshBalance();
    })
    .catch(function () {
      clearInterval(poller);
      el("send").disabled = false;
      el("status").textContent = "Could not reach the pool front door.";
      chatHistory.pop();
    });
});
el("link").addEventListener("click", function () {
  if (!key()) { el("linkmsg").textContent = "Save your account key first."; return; }
  fetch("/link", { method: "POST", headers: headers(), body: JSON.stringify({ enrollment_id: el("linkid").value.trim(), enrollment_key: el("linkkey").value.trim() }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { el("linkmsg").textContent = res.ok ? ("Linked: " + res.j.machine + " now earns shares for your account.") : (res.j.error || "Link failed."); })
    .catch(function () { el("linkmsg").textContent = "Could not reach the pool front door."; });
});
</script>
</body>
</html>
'''


REGISTER_PAGE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Pool — Get an account</title>
<style>
  body { background:#15100c; color:#e8ded0; font-family:Georgia, 'Times New Roman', serif; margin:0; }
  .wrap { max-width:680px; margin:0 auto; padding:24px 16px 48px; }
  h1 { color:#e0a84a; font-size:26px; margin:8px 0 4px; }
  a { color:#e0a84a; }
  .card { background:#241a13; border:1px solid #4a3826; border-radius:10px; padding:16px; margin:14px 0; }
  .muted { color:#b8a88f; font-size:14px; }
  input[type=text] { width:100%; box-sizing:border-box; background:#15100c; color:#e8ded0; border:1px solid #4a3826; border-radius:6px; padding:9px; margin:4px 0 8px; }
  button { background:#e0a84a; color:#15100c; border:0; border-radius:6px; padding:9px 18px; font-weight:bold; cursor:pointer; }
  code { background:#15100c; border:1px solid #4a3826; border-radius:6px; padding:2px 6px; word-break:break-all; }
  #result { display:none; }
  .key { font-size:17px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Get a pool account</h1>
  <p class="muted">An account gives you a personal key for the <a href="/chat">chat page</a> and for the pool's OpenAI-shaped API. New accounts start with a small free share balance; contributing a machine earns more. The operator approves each account by hand, so there may be a wait. <a href="/">Pool home</a></p>

  <div class="card">
    <label for="name">Account name (shown on the public shares board)</label>
    <input type="text" id="name" placeholder="e.g. sam-gaming-rig">
    <button id="create" type="button">Create account</button>
    <p class="muted" id="msg"></p>
  </div>

  <div class="card" id="result">
    <p><strong>Save this key now — it is shown once and cannot be recovered:</strong></p>
    <p class="key"><code id="newkey"></code></p>
    <p class="muted" id="nextsteps"></p>
    <p><a id="gochat" href="/chat" style="display:none">Open the chat — your key goes with you</a></p>
  </div>
</div>
<script>
"use strict";
function el(id) { return document.getElementById(id); }
el("create").addEventListener("click", function () {
  var name = el("name").value.trim();
  if (!name) { el("msg").textContent = "Pick an account name first."; return; }
  el("msg").textContent = "Creating…";
  fetch("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { el("msg").textContent = res.j.error || "Could not create the account."; return; }
      el("msg").textContent = "";
      el("newkey").textContent = res.j.key;
      el("nextsteps").textContent = "Status: " + res.j.status + ". Once the operator approves the account, paste the key into the chat page to check your balance and start. API door: POST /v1/chat/completions with header Authorization: Bearer <your key>.";
      el("result").style.display = "block";
      var g = el("gochat");
      g.href = "/chat#k=" + encodeURIComponent(res.j.key);
      g.style.display = "inline";
      try { localStorage.setItem("poolkey", res.j.key); } catch (e) {}
    })
    .catch(function () { el("msg").textContent = "Could not reach the pool front door."; });
});
</script>
</body>
</html>
'''


# ------------------------------------------------------------------
# M7 — MCP both ways.
#
# OUT: the pool as an MCP server. POST /mcp speaks JSON-RPC 2.0
# (MCP Streamable HTTP, JSON responses), authenticated with the
# same personal account key as the other doors. Tools: pool_chat
# (spends shares through the very same chat path as the API door),
# pool_status, pool_models, pool_balance.
#
# IN: MCP servers the operator registers on the coordinator
# (mcp-servers.json) are offered to the pooled model as tools. A
# chat request that opts in ({"mcp_tools": true}) gets the
# aggregated tool list; when the model calls a tool, the front
# executes it against the registered server and feeds the result
# back, up to MCP_MAX_ROUNDS rounds. Tool names are namespaced
# <server>__<tool> so servers cannot shadow each other.
# ------------------------------------------------------------------

MCP_PATH = os.path.join(POOL_DIR, "mcp-servers.json")
MCP_PROTOCOL = "2025-03-26"
MCP_MAX_ROUNDS = 3
MCP_TOOL_RESULT_CAP = 8000
_mcp_tools_cache = {"at": 0, "tools": [], "routes": {}}


def load_mcp_servers():
    try:
        with open(MCP_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("servers"), list):
            return [s for s in data["servers"] if isinstance(s, dict)]
    except Exception:
        pass
    return []


def mcp_rpc(server, method, params, timeout=30):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    headers = {"Content-Type": "application/json", "User-Agent": "pool-worker"}
    if server.get("key"):
        headers["Authorization"] = "Bearer " + str(server["key"])
    req = urllib.request.Request(str(server["url"]),
                                 data=json.dumps(body).encode(),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def mcp_aggregate_tools():
    if time.time() - _mcp_tools_cache["at"] < 30 and _mcp_tools_cache["tools"]:
        return _mcp_tools_cache["tools"], _mcp_tools_cache["routes"]
    tools, routes = [], {}
    for server in load_mcp_servers():
        if not server.get("enabled", True):
            continue
        try:
            out = mcp_rpc(server, "tools/list", {}, timeout=15)
            listed = (out.get("result") or {}).get("tools") or []
        except Exception:
            continue
        for t in listed:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            ns = str(server["name"]) + "__" + str(t["name"])
            tools.append({"type": "function", "function": {
                "name": ns,
                "description": str(t.get("description") or "")[:500],
                "parameters": t.get("inputSchema") or
                {"type": "object", "properties": {}}}})
            routes[ns] = (server, str(t["name"]))
    _mcp_tools_cache.update(at=time.time(), tools=tools, routes=routes)
    return tools, routes


def mcp_call_tool(routes, ns_name, args):
    server, orig = routes[ns_name]
    out = mcp_rpc(server, "tools/call",
                  {"name": orig, "arguments": args or {}}, timeout=30)
    result = out.get("result") or {}
    parts = []
    for c in result.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(str(c.get("text") or ""))
    text = "\n".join(parts) or json.dumps(result)[:1000]
    if result.get("isError"):
        text = "tool error: " + text
    return text[:MCP_TOOL_RESULT_CAP]


def mcp_tools_list():
    return {"tools": [
        {"name": "pool_chat",
         "description": "Chat with the AI Pool's shared model. Costs "
                        "shares per token generated, like the chat page.",
         "inputSchema": {"type": "object", "properties": {
             "message": {"type": "string",
                         "description": "What to say to the model"},
             "system": {"type": "string",
                        "description": "Optional system prompt"},
             "max_tokens": {"type": "integer",
                            "description": "Reply length cap"}},
             "required": ["message"]}},
        {"name": "pool_status",
         "description": "The pool's live status: brain, model, serving, split.",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "pool_models",
         "description": "Models the pool brain currently serves.",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "pool_balance",
         "description": "Your account's status and shares balance.",
         "inputSchema": {"type": "object", "properties": {}}},
    ]}


def mcp_text(text, is_error=False):
    return {"content": [{"type": "text", "text": text}],
            "isError": bool(is_error)}


def mcp_handle(account, req):
    # Returns (http_status, obj) — obj None means a notification ack.
    method = req.get("method") or ""
    rid = req.get("id")
    params = req.get("params") or {}
    if method.startswith("notifications/"):
        return 202, None
    if method == "initialize":
        want = str(params.get("protocolVersion") or "")
        version = want if want in ("2025-03-26", "2025-06-18",
                                   "2024-11-05") else MCP_PROTOCOL
        return 200, {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "ai-pool", "version": "1.0"}}}
    if method == "ping":
        return 200, {"jsonrpc": "2.0", "id": rid, "result": {}}
    if method == "tools/list":
        return 200, {"jsonrpc": "2.0", "id": rid, "result": mcp_tools_list()}
    if method == "tools/call":
        name = params.get("name") or ""
        args = params.get("arguments") or {}
        if name == "pool_balance":
            out = mcp_text(account["name"] + " — status " +
                           account["status"] + ", balance " +
                           str(account_balance(account["id"])) + " shares")
        elif name == "pool_status":
            st = pool_status()
            out = mcp_text("\n".join([
                "Brain: " + str(st.get("brain")),
                "Model: " + str(st.get("model")),
                "Serving: " + str(st.get("serving")),
                "Split: " + str(st.get("split")),
                "Speed: " + str(st.get("speed"))]))
        elif name == "pool_models":
            status, raw = brain_request("GET", "/v1/models", None, timeout=15)
            if status != 200:
                out = mcp_text("the pool brain answered " + str(status), True)
            else:
                try:
                    ids = [d.get("id") for d in
                           json.loads(raw.decode()).get("data", [])]
                    out = mcp_text("Models: " +
                                   ", ".join(str(i) for i in ids))
                except Exception:
                    out = mcp_text(
                        "the pool brain sent an unreadable model list", True)
        elif name == "pool_chat":
            message = str(args.get("message") or "").strip()
            if not message:
                out = mcp_text("pool_chat needs a message", True)
            else:
                messages = []
                if args.get("system"):
                    messages.append({"role": "system",
                                     "content": str(args["system"])})
                messages.append({"role": "user", "content": message})
                fields = {"messages": messages}
                if args.get("max_tokens"):
                    fields["max_tokens"] = args["max_tokens"]
                code, resp = chat_completion(account, fields)
                if code != 200:
                    out = mcp_text(str(resp.get("error") or
                                       ("chat failed: " + str(code))), True)
                else:
                    try:
                        reply = resp["choices"][0]["message"]["content"] or ""
                    except Exception:
                        reply = ""
                    pool = resp.get("pool") or {}
                    if pool:
                        reply += ("\n\n[pool: cost " +
                                  str(pool.get("cost_shares")) +
                                  " shares; balance " +
                                  str(pool.get("balance")) + "]")
                    out = mcp_text(reply)
        else:
            out = mcp_text("unknown tool: " + str(name), True)
        return 200, {"jsonrpc": "2.0", "id": rid, "result": out}
    return 200, {"jsonrpc": "2.0", "id": rid,
                 "error": {"code": -32601,
                           "message": "method not found: " + method}}


# ------------------------------------------------------------------
# M5b dial-out relay.
#
# An approved worker holds ONE persistent outbound WebSocket to
# /relay (through the Cloudflare Tunnel — raw TCP cannot cross it,
# WebSocket can). Inside the WebSocket, a tiny stream protocol
# multiplexes TCP connections: [stream_id u32][type u8][payload],
# type 1=OPEN, 2=DATA, 3=CLOSE. For each connected machine the front
# listens on a per-machine 127.0.0.1 port on the FX705; llama-server
# targets that port with --rpc and its bytes are carried down the
# worker's WebSocket to the worker's local rpc-server (which listens
# on the worker's own localhost only — nothing inbound, anywhere).
# The port is STABLE per machine: assigned once, persisted in
# relay-ports.json, and reused on every reconnect and front restart.
# (Relay connections DO drop — tunnel edges cycle — so the design
# tolerates drops instead of pretending they won't happen; what must
# never change underneath llama-server is the port number.)
# ------------------------------------------------------------------

def relay_log(msg):
    print("[relay] " + now_iso() + " " + msg, flush=True)


def current_model_info():
    """What the pool runs now and where a worker can download it."""
    name = ""
    try:
        with open(CURRENT_MODEL_PATH) as f:
            name = f.read().strip()
    except OSError:
        pass
    name = name or DEFAULT_MODEL
    sources = dict(BUILTIN_MODEL_SOURCES)
    try:
        with open(MODEL_SOURCES_PATH) as f:
            extra = json.load(f)
        if isinstance(extra, dict):
            sources.update({k: v for k, v in extra.items()
                            if isinstance(v, dict)})
    except (OSError, ValueError):
        pass
    src = sources.get(name, {})
    url = str(src.get("url") or "")
    if not url.startswith("https://huggingface.co/"):
        url = ""
    try:
        size = os.path.getsize(os.path.join(POOL_DIR, name))
    except OSError:
        size = 0
    out = {"file": name, "size_bytes": size, "url": url or None,
           "sha256": str(src.get("sha256") or "") or None}
    if not url:
        out["note"] = ("no download source for this model yet — add it "
                       "to model-sources.json on the pool host")
    return out


def ws_accept(key):
    return base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


class WSReader:
    """Buffered WebSocket frame reader over a raw socket."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read_frame(self):
        """Returns (opcode, payload) with fragmentation reassembled."""
        payload = b""
        opcode = None
        while True:
            b1, b2 = self.read_exact(2)
            fin = b1 & 0x80
            op = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self.read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self.read_exact(8))[0]
            mask = self.read_exact(4) if masked else None
            data = self.read_exact(length) if length else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op in (0, 1, 2):  # continuation / text / binary
                if opcode is None:
                    opcode = op
                payload += data
                if fin:
                    return opcode, payload
            else:  # control frame (ping/pong/close) — returned at once
                return op, data


def ws_send(sock, lock, opcode, payload):
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    with lock:
        sock.sendall(bytes(header) + payload)


class RelayConn:
    def __init__(self, hub, rec, sock):
        self.hub = hub
        self.id = rec["id"]
        self.name = rec["name"]
        self.sock = sock
        self.reader = WSReader(sock)
        self.send_lock = threading.Lock()
        self.streams = {}          # sid -> TCP socket (llama-server side)
        self.streams_lock = threading.Lock()
        self.next_sid = 0
        self.port = None
        self.listener = None
        self.alive = True
        self.since = now_iso()

    # -- keepalive --------------------------------------------------
    def _ping_loop(self):
        while self.alive:
            time.sleep(RELAY_PING_SEC)
            if not self.alive:
                return
            try:
                ws_send(self.sock, self.send_lock, 9, b"")
            except OSError:
                return

    # -- worker -> front ------------------------------------------------
    def run(self):
        why = "worker closed the relay"
        threading.Thread(target=self._ping_loop, daemon=True).start()
        try:
            while self.alive:
                op, payload = self.reader.read_frame()
                if op == 9:        # ping
                    ws_send(self.sock, self.send_lock, 10, payload)
                elif op == 8:      # close
                    break
                elif op in (1, 2) and len(payload) >= 5:
                    sid, typ = struct.unpack(">IB", payload[:5])
                    data = payload[5:]
                    if typ == 2:   # DATA
                        with self.streams_lock:
                            tcp = self.streams.get(sid)
                        if tcp:
                            try:
                                tcp.sendall(data)
                            except OSError:
                                self.close_stream(sid, notify=True)
                    elif typ == 3:  # CLOSE
                        if sid in self.streams:
                            relay_log(self.name + ": split stream " +
                                      str(sid) + " closed by the worker")
                        self.close_stream(sid, notify=False)
        except (ConnectionError, OSError) as e:
            why = str(e) or type(e).__name__
        finally:
            self.hub.drop(self.id, conn=self, why=why)

    def send_stream(self, sid, typ, data=b""):
        if not self.alive:
            return False
        try:
            ws_send(self.sock, self.send_lock, 2,
                    struct.pack(">IB", sid, typ) + data)
            return True
        except OSError:
            return False

    # -- front (llama-server) -> worker ---------------------------------
    def start_listener(self, port):
        self.port = port
        ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        ls.bind(("127.0.0.1", port))
        ls.listen(16)
        ls.settimeout(1.0)   # accept() must re-check alive: see close()
        self.listener = ls
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while self.alive:
            try:
                tcp, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            tcp.settimeout(None)
            with self.streams_lock:
                self.next_sid += 1
                sid = self.next_sid
                self.streams[sid] = tcp
            relay_log(self.name + ": split stream " + str(sid) +
                      " opened on 127.0.0.1:" + str(self.port))
            if not self.send_stream(sid, 1):
                self.close_stream(sid, notify=False)
                continue
            threading.Thread(target=self._pump_tcp, args=(sid, tcp),
                             daemon=True).start()

    def _pump_tcp(self, sid, tcp):
        why = "llama-server closed it"
        try:
            while self.alive:
                data = tcp.recv(262144)
                if not data:
                    break
                if not self.send_stream(sid, 2, data):
                    why = "sending to the worker failed"
                    break
        except OSError as e:
            why = "llama-server socket error: " + (str(e) or type(e).__name__)
        finally:
            if sid in self.streams:
                relay_log(self.name + ": split stream " + str(sid) +
                          " closed: " + why)
            self.close_stream(sid, notify=True)

    def close_stream(self, sid, notify):
        with self.streams_lock:
            tcp = self.streams.pop(sid, None)
        if tcp:
            try:
                tcp.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                tcp.close()
            except OSError:
                pass
        if notify:
            self.send_stream(sid, 3)

    def close(self):
        self.alive = False
        if self.listener:
            try:
                self.listener.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.listener.close()
            except OSError:
                pass
        for sid in list(self.streams):
            self.close_stream(sid, notify=False)
        try:
            ws_send(self.sock, self.send_lock, 8, b"")
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class RelayHub:
    def __init__(self):
        self.conns = {}            # enrollment id -> RelayConn
        self.lock = threading.Lock()
        self.ports = {}            # enrollment id -> stable relay port
        self._load_ports()

    # -- stable per-machine ports --------------------------------------
    def _load_ports(self):
        try:
            with open(RELAY_PORTS_PATH) as f:
                data = json.load(f)
            if isinstance(data, dict):
                for k, v in data.items():
                    try:
                        self.ports[str(k)] = int(v)
                    except (TypeError, ValueError):
                        pass
        except (OSError, ValueError):
            self.ports = {}

    def _save_ports(self):
        # Prune assignments whose enrollment no longer exists, so the
        # file stays bounded; a live assignment is never pruned.
        try:
            live = {r["id"] for r in load_enrollments()["enrollments"]}
            self.ports = {k: v for k, v in self.ports.items()
                          if k in live}
        except Exception:
            pass
        try:
            tmp = RELAY_PORTS_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.ports, f, indent=1, sort_keys=True)
            os.replace(tmp, RELAY_PORTS_PATH)
        except OSError:
            pass

    def _alloc_port(self, eid):
        """eid's stable port: its saved assignment when bindable, else
        the first bindable port at or after it (persisted). The probe
        sets SO_REUSEADDR exactly like the real listener — a port in
        TIME_WAIT from the previous connection must NOT read as taken
        (that mismatch is what made ports climb on every reconnect)."""
        taken = {c.port for c in self.conns.values() if c.port}
        assigned = {p for k, p in self.ports.items() if k != eid}
        port = self.ports.get(eid, RELAY_BASE_PORT)
        while port < RELAY_BASE_PORT + 400:
            if port not in taken and port not in assigned:
                probe = socket.socket()
                probe.setsockopt(socket.SOL_SOCKET,
                                 socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", port))
                    probe.close()
                except OSError:
                    port += 1
                    continue
                if self.ports.get(eid) != port:
                    self.ports[eid] = port
                    self._save_ports()
                return port
            port += 1
        raise RuntimeError("no relay port free")

    def attach(self, rec, sock):
        with self.lock:
            old = self.conns.pop(rec["id"], None)
            if old:
                relay_log(rec["name"] + ": reconnected — replacing the "
                          "previous relay (any split stream on it ends)")
                old.close()
            conn = RelayConn(self, rec, sock)
            conn.port = self._alloc_port(rec["id"])
            self.conns[rec["id"]] = conn
        conn.start_listener(conn.port)
        relay_log(rec["name"] + ": relay connected on 127.0.0.1:" +
                  str(conn.port))
        self.write_state()
        return conn

    def drop(self, eid, conn=None, why=""):
        with self.lock:
            cur = self.conns.get(eid)
            # A replaced connection's reader exits late; it must not
            # tear down the NEW connection that replaced it.
            if conn is not None and cur is not conn:
                return
            self.conns.pop(eid, None)
        if cur:
            relay_log(cur.name + ": relay dropped" +
                      (" (" + why + ")" if why else ""))
            cur.close()
            self.write_state()

    def write_state(self):
        state = {"machines": [
            {"id": c.id, "name": c.name, "port": c.port,
             "rpc": "127.0.0.1:" + str(c.port), "since": c.since}
            for c in self.conns.values() if c.port],
            "generated": now_iso()}
        try:
            tmp = RELAY_STATE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(state, f, indent=1)
            os.replace(tmp, RELAY_STATE_PATH)
        except OSError:
            pass

    def enforce_approvals(self):
        """Revocation cuts the relay: drop any live connection whose
        enrollment is no longer approved."""
        while True:
            time.sleep(15)
            try:
                data = load_enrollments()
                status = {r["id"]: r["status"]
                          for r in data["enrollments"]}
                for eid in list(self.conns):
                    if status.get(eid) != "approved":
                        self.drop(eid)
            except Exception:
                pass


HUB = RelayHub()


def relay_authorize(enrollment_id, key):
    """Returns the enrollment record iff the key matches AND the
    enrollment is approved; otherwise None."""
    if not enrollment_id or not key:
        return None
    data = load_enrollments()
    for rec in data["enrollments"]:
        if rec["id"] == enrollment_id:
            if rec["status"] != "approved":
                return None
            digest = hashlib.sha256(key.encode()).hexdigest()
            if secrets.compare_digest(digest, rec["key_hash"]):
                return rec
            return None
    return None


LANDING = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The AI Pool — front door</title>
<style>
body{font-family:system-ui,sans-serif;background:#15100c;color:#f1e6d6;line-height:1.6;margin:0}
main{max-width:760px;margin:0 auto;padding:2.5rem 1.25rem 3.5rem}
h1{color:#f5c873} a{color:#f5c873} .card{background:#241a13;border:1px solid #3a2a1d;
border-radius:12px;padding:1rem 1.2rem;margin:1rem 0} .fine{color:#b9a68f;font-size:.9rem}
code{background:#1e1611;padding:.1rem .35rem;border-radius:5px}
</style></head>
<body><main>
<h1>The AI Pool</h1>
<p>One AI model, split across a pool of PCs. This is the pool's public
front door — status, downloads, and machine enrollment.
The project page is at <a href="https://tavernworks.dev/pool/">tavernworks.dev/pool</a>.</p>
<div class="card">
<p><strong>Brain:</strong> {brain}</p>
<p><strong>Model:</strong> {model} · <strong>Serving:</strong> {serving}</p>
<p class="fine">Full status as JSON: <a href="/status.json">/status.json</a> ·
Downloads: <a href="/downloads/">/downloads/</a></p>
</div>
<div class="card">
<p><strong>Enroll a machine</strong> (early testers — the one-click worker app is
still in development):</p>
<p><code>curl -X POST https://pool.tavernworks.dev/enroll -H 'Content-Type: application/json'
-d '{"name":"my-pc","offered_mb":8192,"gpu":"RTX 4070","os":"windows"}'</code></p>
<p class="fine">You get an enrollment id and a key (shown once — save it). The operator
approves each machine by hand before it can hold any part of the model.</p>
</div>
<p class="fine">Part of Tavernworks. Nothing here can control the pool — the
operator's control page lives on a private network, not on this site.</p>
</main></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, indent=1), "application/json")

    def _bearer(self):
        h = self.headers.get("Authorization") or ""
        return h[7:].strip() if h.lower().startswith("bearer ") else ""

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == RELAY_PUBLIC_PATH:
            self.handle_relay()
        elif path == "/":
            st = pool_status()
            # NOT str.format for the page below: LANDING's CSS is
            # full of braces, format() reads '{font-family' as a
            # field name and raises KeyError — which dropped the
            # connection and surfaced as a Cloudflare 502 on every
            # request since M5a (found live 2026-11-18).
            page = (LANDING
                    .replace("{brain}",
                             escape(str(st.get("brain", "—"))))
                    .replace("{model}",
                             escape(str(st.get("model", "—"))))
                    .replace("{serving}",
                             escape(str(st.get("serving", "—")))))
            self._send(200, page)
        elif path == "/status.json":
            self._json(200, pool_status())
        elif path == "/model.json":
            self._json(200, current_model_info())
        elif path == "/downloads/":
            rows = "".join(
                "<tr><td><a href=\"/downloads/" + escape(c["name"]) + "\">" +
                escape(c["name"]) + "</a></td><td>" +
                str(round(c["size_bytes"] / 1048576, 1)) + " MB</td><td><code>" +
                c["sha256"][:16] + "…</code></td></tr>"
                for c in components())
            self._send(200, "<!doctype html><html><head><meta charset=\"utf-8\">"
                       "<title>AI Pool downloads</title></head><body>"
                       "<h1>AI Pool downloads</h1>"
                       "<p>Versioned components; verify SHA-256 before use; "
                       "downloads resume (Range supported). Full hashes: "
                       "<a href=\"/downloads/manifest.json\">manifest.json</a></p>"
                       "<table>" + rows + "</table></body></html>")
        elif path == "/downloads/manifest.json":
            self._json(200, {"components": components(),
                             "max_component_mb": MAX_COMPONENT_MB,
                             "generated": now_iso()})
        elif path.startswith("/downloads/"):
            self.serve_download(unquote(path[len("/downloads/"):]))
        elif path.startswith("/enroll/"):
            q = parse_qs(parsed.query)
            code, obj = enrollment_status(path[len("/enroll/"):], (q.get("key") or [""])[0])
            self._json(code, obj)
        elif path == "/chat":
            self._send(200, CHAT_PAGE)
        elif path == "/register":
            self._send(200, REGISTER_PAGE)
        elif path == "/me":
            acct = account_for_key(self._bearer())
            if not acct:
                self._json(403, {"error": "bad or missing account key"})
            else:
                self._json(200, {"name": acct["name"], "status": acct["status"],
                                 "balance": account_balance(acct["id"])})
        elif path == "/shares.json":
            self._json(200, shares_public())
        elif path == "/queue.json":
            snap = DOOR_QUEUE.snapshot()
            snap["paused"] = bool(load_shares_cfg()["public_paused"])
            self._json(200, snap)
        elif path == "/v1/models":
            acct = account_for_key(self._bearer())
            if not acct or acct["status"] != "approved":
                self._json(403, {"error": "an approved account key is required"})
            else:
                status, raw = brain_request("GET", "/v1/models", None, timeout=15)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        elif path == "/mcp":
            self._json(200, {"name": "ai-pool MCP",
                             "note": "POST JSON-RPC 2.0 here with your "
                                     "account key in an Authorization: "
                                     "Bearer header",
                             "tools": ["pool_chat", "pool_status",
                                       "pool_models", "pool_balance"]})
        elif path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._send(404, "Not here")

    def serve_download(self, name):
        if not name or "/" in name or "\\" in name or name.startswith("."):
            self._send(404, "Not here")
            return
        path = os.path.join(DOWNLOADS_DIR, name)
        if not os.path.isfile(path):
            self._send(404, "Not here")
            return
        size = os.path.getsize(path)
        start, end, partial = 0, size - 1, False
        range_hdr = self.headers.get("Range")
        if range_hdr and range_hdr.startswith("bytes="):
            try:
                spec = range_hdr[len("bytes="):].split(",")[0]
                a, _, b = spec.partition("-")
                if a == "":
                    start = max(0, size - int(b))
                else:
                    start = int(a)
                    if b:
                        end = min(size - 1, int(b))
                if start > end or start >= size:
                    raise ValueError
                partial = True
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */" + str(size))
                self.end_headers()
                return
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", "bytes " + str(start) + "-" + str(end) + "/" + str(size))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def handle_relay(self):
        if (self.headers.get("Upgrade") or "").lower() != "websocket":
            self._send(400, "websocket upgrade required")
            return
        rec = relay_authorize(self.headers.get("X-Enrollment-Id"),
                              self.headers.get("X-Enrollment-Key"))
        if rec is None:
            self._send(403, "not an approved enrollment")
            return
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self._send(400, "missing Sec-WebSocket-Key")
            return
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", ws_accept(key.strip()))
        self.end_headers()
        self.close_connection = True
        conn = HUB.attach(rec, self.connection)
        conn.run()  # blocks until the worker disconnects

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/enroll", "/register", "/link", "/v1/chat/completions", "/mcp"):
            self._send(404, "Not here")
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode() if length else ""
        fields = {}
        ctype = self.headers.get("Content-Type") or ""
        try:
            if "application/json" in ctype:
                fields = json.loads(raw) if raw else {}
            else:
                fields = {k: v[0] for k, v in parse_qs(raw).items()}
        except Exception:
            self._json(400, {"error": "unreadable body"})
            return
        if parsed.path == "/enroll":
            code, obj = create_enrollment(fields)
        elif parsed.path == "/register":
            code, obj = create_account(fields)
        elif parsed.path == "/mcp":
            acct = account_for_key(self._bearer())
            if not acct:
                self._json(403, {"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32001,
                                           "message": "bad or missing account key"}})
            else:
                code, obj = mcp_handle(acct, fields)
                if obj is None:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._json(code, obj)
            return
        elif parsed.path == "/link":
            acct = account_for_key(self._bearer())
            if not acct:
                code, obj = 403, {"error": "bad or missing account key"}
            else:
                code, obj = link_enrollment(acct, fields)
        else:
            acct = account_for_key(self._bearer())
            if not acct:
                code, obj = 403, {"error": "bad or missing account key"}
            else:
                code, obj = chat_completion(acct, fields)
        self._json(code, obj)


def main():
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    threading.Thread(target=HUB.enforce_approvals, daemon=True).start()
    threading.Thread(target=earn_loop, daemon=True).start()
    bind = os.environ.get("POOL_FRONT_BIND", "127.0.0.1")
    srv = ThreadingHTTPServer((bind, PORT), Handler)
    print("AI Pool front door on http://" + bind + ":" + str(PORT) +
          " (pool dir " + POOL_DIR + ")", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
