#!/usr/bin/env python3
# AI Pool meter (M9) — the pool's benchmark and usage log.
#
# Imported by pool-coordinator.py (same folder, /opt/ai-pool). It:
#   - follows the brain's journal (ai-pool-solo + ai-pool-host) and
#     logs EVERY reply llama-server prints timings for, whoever sent
#     it (bots, Rosin, the public door): model, mode, prompt and
#     generated tokens, time to first token, tokens/s, total time,
#     draft acceptance, and the machines in the split with their
#     layer ranges and memory;
#   - joins each reply with the relay's own counters (relay-stats.json,
#     written by pool-front.py): per relayed worker, how long the
#     host waited on it, how much of that the worker spent computing
#     (it reports that itself), the rest is network, and the relay's
#     ping round trip;
#   - runs a repeatable benchmark (fixed prompts and lengths, greedy,
#     no prompt cache) in the current mode, or solo then split back
#     to back, with a latency probe of every worker first;
#   - stores it all in ~/ai-pool/pool-meter.db (SQLite) and serves
#     JSON, CSV and a page — the full one on the tailnet control
#     service, a read-only copy for the public link.
#
# The name and public address are one setting: ~/ai-pool/bench-name.json
#   {"name": "SwarmBench", "host": "swarmbench.tavernworks.dev"}
# (env POOL_BENCH_NAME / POOL_BENCH_HOST win). pool-front.py reads the
# same file to know which hostname is the meter's.
#
# Python 3 standard library only.
import csv
import io
import json
import secrets
import os
import re
import select
import sqlite3
import statistics
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
if HOME == "~":
    HOME = "/root"
POOL_DIR = os.environ.get("POOL_DIR", os.path.join(HOME, "ai-pool"))
DB_PATH = os.environ.get("POOL_METER_DB", os.path.join(POOL_DIR, "pool-meter.db"))
NAME_PATH = os.path.join(POOL_DIR, "bench-name.json")
RELAY_STATS_PATH = os.path.join(POOL_DIR, "relay-stats.json")
BOARD_DB = os.path.join(POOL_DIR, "swarmbench-board.db")   # kept by pool-front.py
RELAY_PROBE_PATH = os.path.join(POOL_DIR, "relay-probe.json")
RPC_PATH = os.path.join(POOL_DIR, "pool-rpc.txt")
SPLIT_PATH = os.path.join(POOL_DIR, "pool-split.txt")
CONFIG_PATH = os.path.join(POOL_DIR, "pool-config.json")
RELAY_STATE_PATH = os.path.join(POOL_DIR, "relay-state.json")
UNITS = {"ai-pool-solo.service": "solo", "ai-pool-host.service": "split"}
DEFAULT_NAME = "SwarmBench"
DEFAULT_HOST = "swarmbench.tavernworks.dev"
SUITE_VERSION = "standard-v1"


def bench_identity():
    """(name, host) — the one setting for what the meter is called
    and where its public page lives."""
    name, host = DEFAULT_NAME, DEFAULT_HOST
    try:
        with open(NAME_PATH) as f:
            data = json.load(f)
        name = str(data.get("name") or name).strip() or name
        host = str(data.get("host") or host).strip().lower() or host
    except Exception:
        pass
    name = os.environ.get("POOL_BENCH_NAME") or name
    host = (os.environ.get("POOL_BENCH_HOST") or host).lower()
    return name, host


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------- storage ----------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,            -- end of the reply, unix seconds
  source TEXT NOT NULL,        -- live | bench
  run_id INTEGER,              -- bench_runs.id for bench replies
  case_name TEXT,              -- bench case (short/medium/long)
  rep INTEGER,
  mode TEXT,                   -- solo | split
  model TEXT,
  draft TEXT,                  -- draft model file / mtp / ''
  slot INTEGER, task INTEGER,
  prompt_n INTEGER, prompt_ms REAL, prompt_tps REAL,
  ttft_ms REAL,                -- bench: measured; live: prompt eval time
  gen_n INTEGER, gen_ms REAL, gen_tps REAL,
  total_ms REAL,
  draft_n INTEGER, draft_accepted INTEGER, draft_rate REAL,
  wait_ms REAL,                -- host time spent waiting on relayed workers
  remote_ms REAL,              -- of that, workers' own compute (reported)
  net_ms REAL,                 -- of that, network + relay
  local_ms REAL,               -- everything else: FX705 card, RAM, tailnet
  bottleneck TEXT,
  overlap INTEGER DEFAULT 0,   -- another reply ran at the same time
  devices_json TEXT,
  hops_json TEXT,
  -- the same split for the time to first token alone (prompt phase)
  ttft_wait_ms REAL, ttft_remote_ms REAL, ttft_net_ms REAL,
  ttft_local_ms REAL, ttft_bottleneck TEXT, ttft_hops_json TEXT
);
CREATE INDEX IF NOT EXISTS replies_ts ON replies(ts);
CREATE TABLE IF NOT EXISTS bench_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started REAL, finished REAL,
  suite TEXT, plan TEXT, status TEXT, note TEXT,
  probe_json TEXT, summary_json TEXT,
  other_replies INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""

REPLY_COLS = ["id", "ts", "source", "run_id", "case_name", "rep", "mode",
              "model", "draft", "slot", "task", "prompt_n", "prompt_ms",
              "prompt_tps", "ttft_ms", "gen_n", "gen_ms", "gen_tps",
              "total_ms", "draft_n", "draft_accepted", "draft_rate",
              "wait_ms", "remote_ms", "net_ms", "local_ms", "bottleneck",
              "overlap", "devices_json", "hops_json",
              "ttft_wait_ms", "ttft_remote_ms", "ttft_net_ms", "ttft_local_ms",
              "ttft_bottleneck", "ttft_hops_json"]
REPLY_TYPES = {"ttft_bottleneck": "TEXT", "ttft_hops_json": "TEXT"}
RUN_COLS = ["id", "started", "finished", "suite", "plan", "status", "note",
            "probe_json", "summary_json", "other_replies"]


class Store:
    def __init__(self, path=DB_PATH):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=10)
        self.db.executescript(SCHEMA)
        # Older databases: add any column a newer version introduced.
        have = {r[1] for r in self.db.execute("PRAGMA table_info(replies)")}
        for c in REPLY_COLS:
            if c not in have:
                self.db.execute("ALTER TABLE replies ADD COLUMN " + c + " " +
                                REPLY_TYPES.get(c, "REAL"))
        self.db.commit()
        self.db.commit()

    def meta_get(self, k, default=None):
        with self.lock:
            row = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return row[0] if row else default

    def meta_set(self, k, v):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, v))
            self.db.commit()

    def add_reply(self, rec, cursor=None):
        cols = [c for c in REPLY_COLS if c != "id" and c in rec]
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO replies(" + ",".join(cols) + ") VALUES(" +
                ",".join("?" * len(cols)) + ")", [rec[c] for c in cols])
            if cursor:
                self.db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('journal_cursor',?)", (cursor,))
            self.db.commit()
            return cur.lastrowid

    def mark_overlap(self, ids):
        if not ids:
            return
        with self.lock:
            self.db.executemany("UPDATE replies SET overlap=1 WHERE id=?", [(i,) for i in ids])
            self.db.commit()

    def new_run(self, plan):
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO bench_runs(started,suite,plan,status) VALUES(?,?,?,?)",
                (time.time(), SUITE_VERSION, plan, "running"))
            self.db.commit()
            return cur.lastrowid

    def update_run(self, run_id, **kw):
        cols = list(kw)
        with self.lock:
            self.db.execute("UPDATE bench_runs SET " + ",".join(c + "=?" for c in cols) +
                            " WHERE id=?", [kw[c] for c in cols] + [run_id])
            self.db.commit()

    def query(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            names = [d[0] for d in cur.description]
            return [dict(zip(names, r)) for r in cur.fetchall()]


# ---------------- who is who ----------------

def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def read_line(path):
    try:
        with open(path) as f:
            return (f.readline() or "").strip()
    except Exception:
        return ""


def endpoint_names():
    """endpoint -> (name, kind) from the coordinator's roster and the
    front's live relay list. Kind: tailnet | relay | hostram."""
    out = {}
    cfg = read_json(CONFIG_PATH, {}) or {}
    for m in cfg.get("machines", []):
        if m.get("role") == "host-ram":
            out["127.0.0.1:50060"] = (m.get("name") or "FX705 RAM", "hostram")
        elif m.get("role") == "worker":
            out[str(m.get("ip", "")) + ":50052"] = (m.get("name") or "worker", "tailnet")
    st = read_json(RELAY_STATE_PATH, {}) or {}
    for m in st.get("machines", []):
        if m.get("rpc"):
            out[m["rpc"]] = (m.get("name") or "relayed worker", "relay")
    return out


def layer_ranges(n_layer_all, shares):
    """Which layers each device holds, exactly as llama.cpp b12359
    assigns them (llama-model.cpp, -ngl 99): split points are the
    cumulative shares, layer il goes to the first device whose
    cumulative share exceeds il/(n_layer_all+1); the output layer
    counts as one more. Returns [(first, last, holds_output)]."""
    n = len(shares)
    total = float(sum(shares)) or 1.0
    cum, acc = [], 0.0
    for s in shares:
        acc += s
        cum.append(acc / total)
    act = n_layer_all + 1
    owner = []
    for il in range(n_layer_all + 1):
        x = float(il) / act
        dev = next((i for i, c in enumerate(cum) if c > x), n - 1)
        owner.append(dev)
    out = []
    for d in range(n):
        ls = [il for il in range(n_layer_all) if owner[il] == d]
        out.append((ls[0] if ls else None, ls[-1] if ls else None,
                    owner[n_layer_all] == d))
    return out


# ---------------- model file ----------------

def gguf_layout(path):
    """Read a GGUF file's header only: (kv, tensors) where kv holds
    the scalar and string keys and tensors maps name -> bytes in the
    file. Sizes come from the gaps between tensor offsets, so no
    quant-type table is needed. llama-server at its default log level
    prints none of its per-device layer or buffer lines, so the
    meter works the split's layout out from the file itself."""
    import struct
    scal = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f",
            7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
    with open(path, "rb") as f:
        def rd(n):
            b = f.read(n)
            if len(b) != n:
                raise ValueError("GGUF header ended early")
            return b
        def u32():
            return struct.unpack("<I", rd(4))[0]
        def u64():
            return struct.unpack("<Q", rd(8))[0]
        def string():
            return rd(u64()).decode("utf-8", "replace")
        def value(t):
            if t in scal:
                fmt = scal[t]
                return struct.unpack(fmt, rd(struct.calcsize(fmt)))[0]
            if t == 8:
                return string()
            if t == 9:
                it, n = u32(), u64()
                if it in scal:
                    f.seek(struct.calcsize(scal[it]) * n, 1)
                else:
                    for _ in range(n):
                        value(it)
                return None
            raise ValueError("unknown GGUF value type " + str(t))
        if rd(4) != b"GGUF":
            raise ValueError("not a GGUF file")
        if u32() < 2:
            raise ValueError("GGUF version too old")
        n_t, n_kv = u64(), u64()
        kv = {}
        for _ in range(n_kv):
            k = string()
            v = value(u32())
            if v is not None:
                kv[k] = v
        infos = []
        for _ in range(n_t):
            name = string()
            nd = u32()
            f.seek(8 * nd, 1)
            u32()  # type
            infos.append((u64(), name))
        align = int(kv.get("general.alignment") or 32)
        start = (f.tell() + align - 1) // align * align
        end = os.path.getsize(path)
    infos.sort()
    tensors = {}
    for i, (off, name) in enumerate(infos):
        nxt = infos[i + 1][0] if i + 1 < len(infos) else end - start
        tensors[name] = max(0, nxt - off)
    return kv, tensors


def model_layout(path):
    """{n_layer_all, layer_mb: [MiB per block], output_mb, kv_per_tok}
    for a GGUF, or None when it can't be read. kv_per_tok is the KV
    cache bytes per context token per block (0 for blocks without
    attention, e.g. Qwen3.5's linear-attention blocks)."""
    try:
        kv, tensors = gguf_layout(path)
    except Exception:
        return None
    arch = kv.get("general.architecture") or ""
    n = kv.get(arch + ".block_count")
    if not isinstance(n, int) or n <= 0:
        return None
    mib = 1024.0 * 1024.0
    layer = [0.0] * n
    for name, nb in tensors.items():
        if name.startswith("blk."):
            try:
                il = int(name.split(".")[1])
            except ValueError:
                continue
            if 0 <= il < n:
                layer[il] += nb / mib
    out = sum(tensors.get(t, 0) for t in ("output.weight", "output_norm.weight"))
    if "output.weight" not in tensors:      # tied embeddings: llama.cpp copies them to the output device
        out += tensors.get("token_embd.weight", 0)
    heads = kv.get(arch + ".attention.head_count") or 0
    heads_kv = kv.get(arch + ".attention.head_count_kv") or heads
    emb = kv.get(arch + ".embedding_length") or 0
    k_len = kv.get(arch + ".attention.key_length") or (emb // heads if heads else 0)
    v_len = kv.get(arch + ".attention.value_length") or k_len
    per_tok = 2 * int(heads_kv) * (int(k_len) + int(v_len))   # f16 K + V
    names = {}
    for t in tensors:
        if t.startswith("blk."):
            parts = t.split(".")
            if len(parts) > 2 and parts[1].isdigit():
                names.setdefault(int(parts[1]), set()).add(parts[2])
    kv_tok = []
    for il in range(n):
        nm = names.get(il, set())
        # A linear-attention block (Qwen3.5's Gated DeltaNet) carries
        # ssm_* tensors and keeps a small fixed state, not a KV cache.
        attn = bool(nm & {"attn_k", "attn_k_norm", "attn_qkv"}) and "ssm_conv1d" not in nm
        kv_tok.append(per_tok if attn else 0)
    return {"n_layer_all": n, "layer_mb": layer, "output_mb": out / mib, "kv_per_tok": kv_tok}


# ---------------- journal follower ----------------

RE_LOAD = re.compile(r"load_model: loading model '([^']+)'")
RE_LOADED = re.compile(r"srv\s+load_model: model loaded|main: model loaded|: model loaded\s*$")
RE_NLAYER = re.compile(r"print_info: n_layer_all\s*=\s*(\d+)")
RE_NLAYER_OLD = re.compile(r"print_info: n_layer\s*=\s*(\d+)")
RE_OFFLOAD = re.compile(r"offloaded (\d+)/(\d+) layers to GPU")
RE_MBUF = re.compile(r"load_tensors:\s+(\S+) model buffer size =\s*([\d.]+) MiB")
RE_KV = re.compile(r"(\S+) KV buffer size =\s*([\d.]+) MiB")
RE_DRAFT_ECHO = re.compile(r">> Draft: (.+?)(?: \(|$)")
RE_RPC_ECHO = re.compile(r">> RPC devices \(coordinator's list\): (\S+)")
RE_SPLIT_ECHO = re.compile(r">> Tensor split: ([\d.,]+)")
RE_CTX = re.compile(r"initializing, n_slots = (\d+), n_ctx_slot = (\d+), kv_unified = '(\w+)'")
RE_SLOT = r"id\s+(\d+) \| task (-?\d+) \|"
RE_PROMPT = re.compile(RE_SLOT + r" prompt eval time =\s*([\d.]+) ms /\s*(\d+) tokens")
RE_EVAL = re.compile(RE_SLOT + r"\s+eval time =\s*([\d.]+) ms /\s*(\d+) tokens")
RE_TOTAL = re.compile(RE_SLOT + r"\s+total time =\s*([\d.]+) ms /\s*(\d+) tokens")
RE_DRAFTACC = re.compile(RE_SLOT + r" draft acceptance = ([\d.]+) \(\s*(\d+) accepted /\s*(\d+) generated\)")


class LoadInfo:
    """What the brain loaded in one start: model, devices in split
    order with their layers and memory. llama-server's default log
    level hides its per-device lines, so layers and weights come from
    the model file's header (exact), and the KV cache is worked out
    from the context size (an estimate). Buffer lines, when a higher
    log level prints them, win over both."""

    def __init__(self, unit, model_path, ts, rpc_echo="", split_echo=""):
        self.unit = unit
        self.mode = UNITS.get(unit, "solo")
        self.model_path = model_path
        self.model = os.path.basename(model_path)
        self.ts = ts             # load started
        self.loaded_ts = None    # "model loaded" printed
        self.phase = 0          # 1 = main model's print_info, 2 = draft's
        self.n_layer_all = None
        self.offloaded = None
        self.mbuf = {}          # buffer name -> MiB (main model)
        self.kv = {}
        self.draft_mb = 0.0
        self.draft = ""
        self.n_ctx = None        # KV cells across all slots
        self._layout = False     # not read yet
        # The split's device list: what the host script echoed for
        # this start, else what the coordinator's files say now.
        self.rpc = []
        self.shares = []
        if self.mode == "split":
            rpc = rpc_echo or read_line(RPC_PATH)
            self.rpc = [e for e in rpc.replace(" ", "").split(",") if e]
            try:
                self.shares = [float(x) for x in (split_echo or read_line(SPLIT_PATH)).split(",") if x.strip()]
            except ValueError:
                self.shares = []
        self.names = endpoint_names()

    def layout(self):
        if self._layout is False:
            self._layout = model_layout(self.model_path)
        return self._layout

    def n_layers(self):
        if self.n_layer_all:
            return self.n_layer_all
        lay = self.layout()
        return lay["n_layer_all"] if lay else None

    def devices(self):
        """[{name, kind, endpoint, layers, model_mb, kv_mb}] in split
        order (relays and tailnet first, FX705 RAM, the card last)."""
        devs = []
        n_all = self.n_layers()
        if self.mode == "split" and self.rpc:
            names = self.names
            shares = self.shares if len(self.shares) == len(self.rpc) + 1 else [1.0] * (len(self.rpc) + 1)
            ranges = layer_ranges(n_all, shares) if n_all else [(None, None, False)] * len(shares)
            for i, ep in enumerate(self.rpc):
                fallback = (("FX705 RAM", "hostram") if ep == "127.0.0.1:50060" else
                            (ep, "relay" if ep.startswith("127.0.0.1:511") else "tailnet"))
                nm, kind = names.get(ep, fallback)
                buf = "RPC" + str(i) + "[" + ep + "]"
                devs.append(self._dev(nm, kind, ep, ranges[i], buf))
            devs.append(self._dev("FX705 card", "card", "CUDA0", ranges[-1], "CUDA0"))
        else:
            lay = self.layout()
            model_mb = sum(self.mbuf.values())
            if not model_mb and lay:
                model_mb = sum(lay["layer_mb"]) + lay["output_mb"]
            kv_mb = sum(self.kv.values())
            kv_est = False
            if not kv_mb and lay and self.n_ctx:
                kv_mb = sum(lay["kv_per_tok"]) * self.n_ctx / (1024.0 * 1024.0)
                kv_est = True
            devs.append({"name": "FX705", "kind": "solo", "endpoint": "local",
                         "layers": ("all " + str(n_all) if n_all else "all") +
                         (" (" + str(self.offloaded[0]) + "/" + str(self.offloaded[1]) +
                          " offloaded to the card)" if self.offloaded else ""),
                         "n_layers": n_all or 0,
                         "model_mb": round(model_mb, 1),
                         "card_mb": round(sum(v for k, v in self.mbuf.items() if k.startswith("CUDA")), 1),
                         "kv_mb": round(kv_mb, 1), "kv_est": kv_est})
        return devs

    def _dev(self, name, kind, ep, rng, buf):
        first, last, out = rng
        if first is None:
            layers = "output only" if out else "none"
        else:
            layers = str(first) + "-" + str(last) + (" + output" if out else "")
        lay = self.layout()
        model_mb = self.mbuf.get(buf, 0.0)
        if not model_mb and lay:
            if first is not None:
                model_mb = sum(lay["layer_mb"][first:last + 1])
            if out:
                model_mb += lay["output_mb"]
        kv_mb = self.kv.get(buf, 0.0)
        kv_est = False
        if not kv_mb and lay and self.n_ctx and first is not None:
            kv_mb = sum(lay["kv_per_tok"][first:last + 1]) * self.n_ctx / (1024.0 * 1024.0)
            kv_est = True
        return {"name": name, "kind": kind, "endpoint": ep, "layers": layers,
                "n_layers": 0 if first is None else last - first + 1,
                "model_mb": round(model_mb, 1),
                "kv_mb": round(kv_mb, 1), "kv_est": kv_est}

    def to_dict(self):
        return {"mode": self.mode, "model": self.model,
                "started": iso(self.ts),
                "loaded": iso(self.loaded_ts) if self.loaded_ts else None,
                "load_s": round(self.loaded_ts - self.ts) if self.loaded_ts else None,
                "n_layer_all": self.n_layers(), "draft": self.draft,
                "draft_mb": round(self.draft_mb, 1), "devices": self.devices()}

    def feed(self, msg, ts=None):
        if RE_LOADED.search(msg):
            if self.loaded_ts is None:
                self.loaded_ts = ts or time.time()
            return
        m = RE_CTX.search(msg)
        if m:
            slots, per = int(m.group(1)), int(m.group(2))
            self.n_ctx = per if m.group(3).lower() == "true" else per * slots
            return
        m = RE_NLAYER.search(msg)
        if m:
            self.phase += 1
            if self.phase == 1:
                self.n_layer_all = int(m.group(1))
            return
        m = RE_MBUF.search(msg)
        if m:
            if self.phase <= 1:
                self.mbuf[m.group(1)] = self.mbuf.get(m.group(1), 0.0) + float(m.group(2))
            else:
                self.draft_mb += float(m.group(2))
            return
        m = RE_KV.search(msg)
        if m and self.phase <= 1:
            self.kv[m.group(1)] = self.kv.get(m.group(1), 0.0) + float(m.group(2))
            return
        m = RE_OFFLOAD.search(msg)
        if m and self.phase <= 1:
            self.offloaded = (int(m.group(1)), int(m.group(2)))


class RelayHistory:
    """Snapshots of relay-stats.json, read 5 times a second, so a reply's
    [start, end] can be turned into per-worker deltas."""

    def __init__(self):
        self.snaps = []   # (generated, {worker_id: stats})
        self.lock = threading.Lock()

    def poll(self):
        data = read_json(RELAY_STATS_PATH)
        if not isinstance(data, dict):
            return
        t = float(data.get("generated") or 0)
        with self.lock:
            if self.snaps and self.snaps[-1][0] >= t:
                return
            self.snaps.append((t, {w.get("id"): w for w in data.get("workers", []) if w.get("id")}))
            cutoff = time.time() - 900
            while self.snaps and self.snaps[0][0] < cutoff:
                self.snaps.pop(0)

    def latest(self):
        with self.lock:
            return self.snaps[-1] if self.snaps else (0, {})

    def window(self, start, end):
        """(before, after): the last snapshot at or before start and
        the first at or after end, or None when the history doesn't
        cover the window."""
        with self.lock:
            before = None
            after = None
            for t, s in self.snaps:
                if t <= start:
                    before = s
                if t >= end and after is None:
                    after = s
            return before, after


def hop_deltas(before, after):
    """Per relayed worker: what changed between two snapshots."""
    hops = []
    if before is None or after is None:
        return hops
    for wid, a in after.items():
        b = before.get(wid) or {}
        if b.get("since") != a.get("since"):
            b = {}  # relay reconnected in between: counters restarted
        def d(k, src_a=a, src_b=b):
            return max(0.0, float(src_a.get(k) or 0) - float(src_b.get(k) or 0))
        ex = d("ex")
        if not ex:
            continue
        wa, wb = a.get("worker") or {}, b.get("worker") or {}
        if wb.get("session") != wa.get("session"):
            wb = {}
        rep = bool(wa)
        remote = max(0.0, float(wa.get("busy_ms") or 0) - float(wb.get("busy_ms") or 0)) if rep else None
        turn = d("turn_ms")
        hops.append({
            "name": a.get("name") or "relayed worker",
            "exchanges": int(ex),
            "wait_ms": round(turn, 1),
            "remote_ms": round(remote, 1) if remote is not None else None,
            "net_ms": round(max(0.0, turn - remote), 1) if remote is not None else None,
            "bytes_up": int(d("bytes_up")),
            "bytes_down": int(d("bytes_down")),
            "rtt_ms": a.get("rtt_avg"),
        })
    return hops


def bottleneck_of(total_ms, hops, mode):
    """Split a reply's time: waiting on relayed workers (their own
    compute + the network) vs everything on the FX705's side."""
    if not hops:
        return {"wait_ms": None, "remote_ms": None, "net_ms": None,
                "local_ms": round(total_ms, 1),
                "bottleneck": ("FX705 (solo)" if mode == "solo" else
                               "FX705 and tailnet machines") if total_ms else ""}
    wait = sum(h["wait_ms"] for h in hops)
    known = [h for h in hops if h["remote_ms"] is not None]
    unknown = sum(h["wait_ms"] for h in hops if h["remote_ms"] is None)
    remote = sum(h["remote_ms"] for h in known) if known else None
    net = sum(h["net_ms"] or 0 for h in known) if known else None
    local = max(0.0, total_ms - wait)
    parts = {"FX705 and tailnet machines": local}
    if net:
        parts["network to relayed workers"] = net
    if remote:
        parts["relayed workers' compute"] = remote
    if unknown:
        parts["relayed workers (network + compute together)"] = unknown
    return {"wait_ms": round(wait, 1),
            "remote_ms": round(remote, 1) if remote is not None else None,
            "net_ms": round(net, 1) if net is not None else None,
            "local_ms": round(local, 1),
            "bottleneck": max(parts, key=parts.get) if total_ms else ""}


class Meter:
    def __init__(self, store=None):
        self.store = store or Store()
        self.relay = RelayHistory()
        self.loads = {}          # unit -> LoadInfo (latest)
        self.current_unit = None
        self.pending = {}        # (unit, slot, task) -> partial record
        self.recent = []         # (start, end, id) of the last replies, for overlap
        self.bench = None        # Bench while one runs
        self.bench_window = None  # (start, None) while a bench runs
        self.bench_seen = 0      # live replies seen during the bench window
        self.hooks = {}
        self.draft_echo = {}     # unit -> draft the host script said it starts with
        self.rpc_echo = {}       # unit -> RPC list the host script echoed for its latest start
        self.split_echo = {}     # unit -> tensor split it echoed
        self.bench_sigs = []     # (prompt_n, gen_n, end) of benchmark requests
        self.status = "starting"
        self.lock = threading.Lock()

    # ---- threads ----
    def start(self):
        threading.Thread(target=self._relay_loop, daemon=True).start()
        threading.Thread(target=self._journal_loop, daemon=True).start()

    def _relay_loop(self):
        while True:
            try:
                self.relay.poll()
            except Exception:
                pass
            time.sleep(0.2)

    def _journal_cmd(self):
        cmd = ["journalctl", "-f", "-o", "json", "--no-pager"]
        for u in UNITS:
            cmd += ["-u", u]
        cursor = self.store.meta_get("journal_cursor")
        if cursor:
            cmd += ["--after-cursor", cursor]
        else:
            # First run: two weeks of history, so the log isn't empty.
            cmd += ["--since", "-14d"]
        return cmd

    def _journal_loop(self):
        while True:
            try:
                self._prime_load()
                proc = subprocess.Popen(self._journal_cmd(), stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
                self.status = "following the brain's journal"
                buf = b""
                while True:
                    r, _, _ = select.select([proc.stdout], [], [], 0.5)
                    if r:
                        chunk = os.read(proc.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        buf += chunk
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            self._on_entry(line)
                    self._flush(time.time())
                proc.wait()
                self.status = "journal follow ended — restarting it"
            except FileNotFoundError:
                self.status = "journalctl not found — live logging off (benchmarks still work)"
                return
            except Exception as e:
                self.status = "journal follow error: " + (str(e) or type(e).__name__)
            time.sleep(5)

    def _prime_load(self):
        """When the meter starts after the brain loaded (the normal
        case after a coordinator restart), read the brain's latest
        load block so devices and layers are known."""
        if self.loads:
            return
        cmd = ["journalctl", "-o", "json", "--no-pager", "-n", "20000"]
        for u in UNITS:
            cmd += ["-u", u]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=60).stdout
        except Exception:
            return
        for line in out.splitlines():
            self._on_entry(line, prime=True)

    # ---- parsing ----
    def _on_entry(self, line, prime=False):
        try:
            e = json.loads(line)
        except Exception:
            return
        msg = e.get("MESSAGE")
        if isinstance(msg, list):
            try:
                msg = bytes(msg).decode("utf-8", "replace")
            except Exception:
                return
        if not isinstance(msg, str):
            return
        unit = e.get("_SYSTEMD_UNIT") or e.get("UNIT") or ""
        if unit not in UNITS:
            return
        ts = int(e.get("__REALTIME_TIMESTAMP") or 0) / 1e6 or time.time()
        cursor = e.get("__CURSOR")
        for part in msg.split("\n"):
            self._on_line(unit, part, ts, None if prime else cursor, prime)

    def _on_line(self, unit, msg, ts, cursor, prime):
        m = RE_LOAD.search(msg)
        if m:
            li = LoadInfo(unit, m.group(1), ts,
                          self.rpc_echo.get(unit, ""), self.split_echo.get(unit, ""))
            li.draft = self.draft_echo.get(unit, "") if li.mode == "split" else ""
            self.loads[unit] = li
            self.current_unit = unit
            return
        m = RE_RPC_ECHO.search(msg)
        if m:
            self.rpc_echo[unit] = m.group(1)
            return
        m = RE_SPLIT_ECHO.search(msg)
        if m:
            self.split_echo[unit] = m.group(1).strip(",")
            return
        m = RE_DRAFT_ECHO.search(msg)
        if m:
            d = m.group(1).strip()
            self.draft_echo[unit] = "" if d.lower().startswith("off") else d
            return
        if "retrying once without the draft" in msg:
            self.draft_echo[unit] = ""
            return
        li = self.loads.get(unit)
        if li and (RE_NLAYER.search(msg) or RE_MBUF.search(msg) or RE_KV.search(msg) or
                   RE_OFFLOAD.search(msg) or RE_CTX.search(msg) or RE_LOADED.search(msg)):
            li.feed(msg, ts)
            return
        if prime:
            return
        for rx, kind in ((RE_PROMPT, "prompt"), (RE_EVAL, "eval"),
                         (RE_TOTAL, "total"), (RE_DRAFTACC, "draft")):
            m = rx.search(msg)
            if not m:
                continue
            key = (unit, int(m.group(1)), int(m.group(2)))
            rec = self.pending.setdefault(key, {"unit": unit, "slot": key[1], "task": key[2]})
            rec["cursor"] = cursor or rec.get("cursor")
            if kind == "prompt":
                rec["prompt_ms"], rec["prompt_n"] = float(m.group(3)), int(m.group(4))
            elif kind == "eval":
                rec["gen_ms"], rec["gen_n"] = float(m.group(3)), int(m.group(4))
            elif kind == "total":
                rec["total_ms"] = float(m.group(3))
                rec["end"] = ts
                rec["due"] = time.time() + 2.5   # room for the draft line + the relay's next snapshot
            elif kind == "draft":
                rec["draft_rate"] = float(m.group(3))
                rec["draft_accepted"] = int(m.group(4))
                rec["draft_n"] = int(m.group(5))
            return

    def _flush(self, now):
        for key in list(self.pending):
            rec = self.pending[key]
            if "due" not in rec:
                if now - rec.get("end", now) > 120:
                    self.pending.pop(key, None)
                continue
            if now < rec["due"]:
                continue
            self.pending.pop(key, None)
            try:
                self._finish_live(rec)
            except Exception as e:
                self.status = "could not log a reply: " + str(e)

    def _finish_live(self, rec):
        end = rec["end"]
        total = rec.get("total_ms") or 0.0
        start = end - total / 1000.0
        if self.bench_window and start >= self.bench_window[0] - 1:
            # The benchmark logs its own requests (with a measured time
            # to first token): skip those here, log everyone else's and
            # count them, since they share the brain with the run.
            for sig in list(self.bench_sigs):
                if (sig[0] == rec.get("prompt_n") and sig[1] == rec.get("gen_n")
                        and abs(sig[2] - end) < 15):
                    self.bench_sigs.remove(sig)
                    if rec.get("cursor"):
                        self.store.meta_set("journal_cursor", rec["cursor"])
                    return
            self.bench_seen += 1
        li = self.loads.get(rec["unit"])
        split = bool(li and li.mode == "split")
        before, after = self.relay.window(start, end)
        hops = hop_deltas(before, after) if split else []
        tb, ta = self.relay.window(start, start + (rec.get("prompt_ms") or 0) / 1000.0)
        ttft_hops = hop_deltas(tb, ta) if split else []
        out = self._record(rec, li, hops, "live", ttft_hops)
        out["ts"] = end
        rid = self.store.add_reply(out, rec.get("cursor"))
        self._overlap(start, end, rid)

    def _overlap(self, start, end, rid):
        hit = [r for (s, e, r) in self.recent if s < end and e > start]
        if hit:
            self.store.mark_overlap(hit + [rid])
        self.recent.append((start, end, rid))
        self.recent = self.recent[-50:]

    def _record(self, rec, li, hops, source, ttft_hops=None):
        prompt_ms = rec.get("prompt_ms") or 0.0
        gen_ms = rec.get("gen_ms") or 0.0
        prompt_n = rec.get("prompt_n") or 0
        gen_n = rec.get("gen_n") or 0
        total = rec.get("total_ms") or (prompt_ms + gen_ms)
        mode = rec.get("mode") or (li.mode if li else None)
        b = bottleneck_of(total, hops, mode)
        draft = ""
        if li:
            draft = li.draft or ""
        out = {
            "source": source,
            "mode": mode,
            "model": li.model if li else None,
            "draft": draft,
            "slot": rec.get("slot"), "task": rec.get("task"),
            "prompt_n": prompt_n, "prompt_ms": round(prompt_ms, 1),
            "prompt_tps": round(prompt_n * 1000.0 / prompt_ms, 2) if prompt_ms else None,
            "ttft_ms": round(rec.get("ttft_ms", prompt_ms), 1),
            "gen_n": gen_n, "gen_ms": round(gen_ms, 1),
            "gen_tps": round(gen_n * 1000.0 / gen_ms, 2) if gen_ms else None,
            "total_ms": round(total, 1),
            "draft_n": rec.get("draft_n"), "draft_accepted": rec.get("draft_accepted"),
            "draft_rate": rec.get("draft_rate"),
            "devices_json": json.dumps(li.devices()) if li else None,
            "hops_json": json.dumps(hops),
        }
        out.update(b)
        tb = bottleneck_of(out["ttft_ms"], ttft_hops or [], mode)
        out.update({"ttft_" + k: v for k, v in tb.items()})
        out["ttft_hops_json"] = json.dumps(ttft_hops or [])
        return out

    # ---- current brain ----
    def current_load(self, state=None):
        unit = None
        if state:
            if state.get("units", {}).get("ai-pool-host") == "active":
                unit = "ai-pool-host.service"
            elif state.get("units", {}).get("ai-pool-solo") == "active":
                unit = "ai-pool-solo.service"
        unit = unit or self.current_unit
        li = self.loads.get(unit) if unit else None
        return li.to_dict() if li else None

    def workers_now(self):
        _, snap = self.relay.latest()
        out = []
        for w in snap.values():
            wk = w.get("worker") or {}
            out.append({"name": w.get("name"), "rtt_last": w.get("rtt_last"),
                        "rtt_avg": w.get("rtt_avg"), "rtt_min": w.get("rtt_min"),
                        "reports_compute": bool(wk), "mem": wk.get("mem") or {},
                        "since": w.get("since")})
        return out

    # ---- benchmark ----
    def run_bench(self, plan):
        with self.lock:
            if self.bench and self.bench.alive:
                return "A benchmark is already running — wait for it or cancel it."
            if plan not in ("current", "both"):
                return "Unknown benchmark plan."
            self.bench = Bench(self, plan)
            self.bench.start()
        name, _ = bench_identity()
        if plan == "both":
            return (name + " started: solo, then split, then the brain goes back to how it was. "
                    "The brain restarts twice, so bots get no AI replies for a few minutes each time.")
        return name + " started on the brain as it runs now. Results appear below in a few minutes."

    def cancel_bench(self):
        b = self.bench
        if b and b.alive:
            b.cancel = True
            return "Cancelling the benchmark after the current request — the brain then goes back to how it was."
        return "No benchmark is running."


# ---------------- benchmark ----------------

_WORDS = ("the guild hall smelled of pine smoke and spilled ale while the bard tuned a "
          "cracked lute and the ranger counted arrows by the window watching rain fall on "
          "the cobbled road toward the old tower where a lantern burned through the night "
          "and merchants argued over the price of silver thread dragon scales and maps").split()


def filler(n_words):
    """Deterministic prose, the same every run (so results compare)."""
    out = []
    i = 0
    while len(out) < n_words:
        out.append(_WORDS[(i * 7 + i // len(_WORDS)) % len(_WORDS)])
        i += 1
        if i % 17 == 0:
            out[-1] += "."
    return " ".join(out)


# name, prompt words (~1.3 tokens each), tokens to generate
SUITE = [
    ("short", 40, 64),
    ("medium", 450, 128),
    ("long", 1500, 64),
]
REPS = 2


def case_prompt(words):
    """Same as swarmbench.py's: the tag at the start differs on every
    request, so no answer comes from a cached prompt."""
    return ("[run " + secrets.token_hex(3) + "] You are the narrator of a fantasy tavern story. "
            "Continue the scene below in plain prose.\n\n" + filler(words) + "\n\nContinue:")


def suite_prompts():
    return [(name, words, n_predict) for name, words, n_predict in SUITE]


# The SwarmBench score, same formula as swarmbench.py: 1000 means a 1.0 s
# first token and 10 tokens/s on the medium case; the first token counts
# twice as much as speed.
def bench_score(ttft_ms, gen_tps):
    if not ttft_ms or not gen_tps:
        return None
    return int(round(1000.0 * ((1000.0 / float(ttft_ms)) ** (2.0 / 3.0)) * ((float(gen_tps) / 10.0) ** (1.0 / 3.0))))


def http_ok(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200 and json.loads(r.read().decode()).get("status") == "ok"
    except Exception:
        return False


def stream_completion(base, prompt, n_predict, timeout=900):
    """One greedy /completion with streaming. Returns llama-server's
    timings plus the measured time to first token and wall time."""
    body = json.dumps({
        "prompt": prompt, "n_predict": n_predict, "temperature": 0, "top_k": 1,
        "seed": 42, "ignore_eos": True, "cache_prompt": False, "stream": True,
    }).encode()
    req = urllib.request.Request(base + "/completion", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    ttft = None
    timings = None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except ValueError:
                continue
            if ttft is None and ev.get("content"):
                ttft = (time.time() - t0) * 1000.0
            if ev.get("timings"):
                timings = ev["timings"]
            if ev.get("stop"):
                break
    wall = (time.time() - t0) * 1000.0
    return {"timings": timings or {}, "ttft_ms": ttft if ttft is not None else wall, "wall_ms": wall}


def icmp_ping(ip, n=4):
    try:
        out = subprocess.run(["ping", "-c", str(n), "-i", "0.2", "-W", "1", ip],
                             capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None
    m = re.search(r"= [\d.]+/([\d.]+)/([\d.]+)/", out)
    if m:
        return {"avg_ms": float(m.group(1)), "max_ms": float(m.group(2))}
    return None


def probe_workers(wait=6.0):
    """Ask the front for a burst of relay pings to every relayed
    worker, and ping the tailnet workers. Returns a list."""
    req = time.time()
    try:
        tmp = RELAY_PROBE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"req": req, "n": 10}, f)
        os.replace(tmp, RELAY_PROBE_PATH)
    except OSError:
        pass
    out = []
    cfg = read_json(CONFIG_PATH, {}) or {}
    for m in cfg.get("machines", []):
        if m.get("role") == "worker" and m.get("ip"):
            r = icmp_ping(m["ip"])
            out.append({"name": m.get("name"), "kind": "tailnet",
                        "rtt_ms": r["avg_ms"] if r else None,
                        "rtt_max_ms": r["max_ms"] if r else None})
        elif m.get("role") == "host-ram":
            out.append({"name": m.get("name") or "FX705 RAM", "kind": "hostram",
                        "rtt_ms": 0.0, "rtt_max_ms": 0.0})
    deadline = time.time() + wait
    relays = []
    while time.time() < deadline:
        data = read_json(RELAY_STATS_PATH, {}) or {}
        relays = data.get("workers", [])
        done = [w for w in relays if (w.get("probe") or {}).get("req") == req and
                (w.get("probe") or {}).get("done")]
        if relays and len(done) == len(relays):
            break
        time.sleep(0.5)
    for w in relays:
        p = w.get("probe") or {}
        rtts = p.get("rtts") if p.get("req") == req else None
        if rtts:
            out.append({"name": w.get("name"), "kind": "relay",
                        "rtt_ms": round(statistics.median(rtts), 1),
                        "rtt_max_ms": round(max(rtts), 1), "samples": len(rtts),
                        "lost": int(p.get("sent", len(rtts))) - len(rtts)})
        else:
            out.append({"name": w.get("name"), "kind": "relay", "rtt_ms": w.get("rtt_avg"),
                        "rtt_max_ms": None, "note": "no probe answer; last background ping shown"})
    return out


def med(vals):
    vals = [v for v in vals if v is not None]
    return round(statistics.median(vals), 2) if vals else None


def pct(vals, p):
    vals = sorted(v for v in vals if v is not None)
    if not vals:
        return None
    return round(vals[min(len(vals) - 1, int(round((p / 100.0) * (len(vals) - 1))))], 2)


def most(vals):
    vals = [v for v in vals if v]
    return max(set(vals), key=vals.count) if vals else ""


class Bench(threading.Thread):
    def __init__(self, meter, plan):
        super().__init__(daemon=True)
        self.meter = meter
        self.plan = plan
        self.cancel = False
        self.alive = True
        self.step = "starting"
        self.run_id = meter.store.new_run(plan)
        self.notes = []

    def say(self, text):
        self.step = text

    def hook(self, name, *a):
        fn = self.meter.hooks.get(name)
        return fn(*a) if fn else None

    def wait_brain(self, minutes):
        base = self.hook("brain_url")
        deadline = time.time() + minutes * 60
        while time.time() < deadline and not self.cancel:
            if http_ok(base + "/health"):
                return True
            time.sleep(5)
        return False

    def run(self):
        m = self.meter
        status = "done"
        summary = {}
        probes = {}
        m.bench_window = (time.time(), None)
        m.bench_seen = 0
        m.bench_sigs = []
        original = None
        try:
            st = self.hook("state") or {}
            original = st.get("mode")
            if original == "starting":
                self.notes.append("The brain was still loading when the run began.")
            modes = [original] if self.plan == "current" else ["solo", "split"]
            for mode in modes:
                if self.cancel:
                    break
                if mode in (None, "off", "starting") and self.plan == "current":
                    if not self.wait_brain(1):
                        self.notes.append("The brain is off — start it, then run the benchmark.")
                        status = "skipped"
                        break
                    mode = (self.hook("state") or {}).get("mode")
                if self.plan == "both":
                    cur = (self.hook("state") or {}).get("mode")
                    if cur != mode:
                        self.say("switching the brain to " + mode)
                        msg = self.hook("start_" + mode) or ""
                        if "Nothing started" in msg:
                            self.notes.append(mode + " skipped: " + msg)
                            continue
                        time.sleep(8)
                    self.say("waiting for the " + mode + " brain to load")
                    if not self.wait_brain(25):
                        self.notes.append(mode + " skipped: the brain did not come up within 25 minutes.")
                        continue
                    mode = (self.hook("state") or {}).get("mode") or mode
                self.say("probing worker latency (" + mode + ")")
                probes[mode] = probe_workers()
                summary[mode] = self.run_suite(mode)
            if self.cancel:
                status = "cancelled"
        except Exception as e:
            status = "failed"
            self.notes.append("Benchmark error: " + (str(e) or type(e).__name__))
        finally:
            if self.plan == "both" and original in ("solo", "split", "off"):
                cur = (self.hook("state") or {}).get("mode")
                if cur != original:
                    self.say("putting the brain back to " + original)
                    if original == "off":
                        self.hook("stop")
                    else:
                        msg = self.hook("start_" + original) or ""
                        if "Nothing started" in msg:
                            self.notes.append("Could not put the brain back to " + original + ": " + msg)
            m.store.update_run(self.run_id, finished=time.time(), status=status,
                               note=" ".join(self.notes), probe_json=json.dumps(probes),
                               summary_json=json.dumps(summary), other_replies=m.bench_seen)
            m.bench_window = None
            self.alive = False
            self.step = status

    def run_suite(self, mode):
        m = self.meter
        base = self.hook("brain_url")
        st = self.hook("state") or {}
        li = m.loads.get("ai-pool-host.service" if mode == "split" else "ai-pool-solo.service")
        self.say("warming up (" + mode + ")")
        try:
            w = stream_completion(base, "Hello", 8, timeout=300)
            wt = w["timings"]
            m.bench_sigs.append((wt.get("prompt_n"), wt.get("predicted_n"), time.time()))
        except Exception as e:
            self.notes.append(mode + " warm-up failed: " + str(e))
        results = {}
        for case, words, n_predict in suite_prompts():
            for rep in range(1, REPS + 1):
                if self.cancel:
                    return self._summarise(results)
                self.say(mode + ": " + case + " prompt, run " + str(rep) + " of " + str(REPS))
                time.sleep(1.5)   # let the relay snapshot catch up
                start = time.time()
                try:
                    r = stream_completion(base, case_prompt(words), n_predict)
                except Exception as e:
                    self.notes.append(mode + " " + case + " run " + str(rep) + " failed: " + str(e))
                    continue
                end = time.time()
                t = r["timings"]
                m.bench_sigs.append((t.get("prompt_n"), t.get("predicted_n"), end))
                time.sleep(1.5)
                m.relay.poll()
                before, after = m.relay.window(start, end)
                hops = hop_deltas(before, after) if mode == "split" else []
                tb, ta = m.relay.window(start, start + r["ttft_ms"] / 1000.0)
                ttft_hops = hop_deltas(tb, ta) if mode == "split" else []
                rec = {"prompt_ms": t.get("prompt_ms"), "prompt_n": t.get("prompt_n"),
                       "gen_ms": t.get("predicted_ms"), "gen_n": t.get("predicted_n"),
                       "total_ms": (t.get("prompt_ms") or 0) + (t.get("predicted_ms") or 0),
                       "ttft_ms": r["ttft_ms"], "mode": mode,
                       "draft_n": t.get("draft_n"), "draft_accepted": t.get("draft_n_accepted")}
                if t.get("draft_n"):
                    rec["draft_rate"] = round(t["draft_n_accepted"] / float(t["draft_n"]), 4)
                out = m._record(rec, li, hops, "bench", ttft_hops)
                out.update({"ts": end, "run_id": self.run_id, "case_name": case, "rep": rep,
                            "mode": mode, "model": (li.model if li else st.get("current_model"))})
                m.store.add_reply(out)
                results.setdefault(case, []).append(out)
        return self._summarise(results)

    def _summarise(self, results):
        out = {}
        for case, rows in results.items():
            out[case] = {
                "prompt_n": med([r["prompt_n"] for r in rows]),
                "gen_n": med([r["gen_n"] for r in rows]),
                "ttft_ms": med([r["ttft_ms"] for r in rows]),
                "ttft_best_ms": min([r["ttft_ms"] for r in rows if r["ttft_ms"] is not None] or [None]) if rows else None,
                "ttft_net_ms": med([r["ttft_net_ms"] for r in rows]),
                "ttft_remote_ms": med([r["ttft_remote_ms"] for r in rows]),
                "ttft_local_ms": med([r["ttft_local_ms"] for r in rows]),
                "ttft_bottleneck": rows[-1]["ttft_bottleneck"] if rows else "",
                "prompt_tps": med([r["prompt_tps"] for r in rows]),
                "gen_tps": med([r["gen_tps"] for r in rows]),
                "total_ms": med([r["total_ms"] for r in rows]),
                "net_ms": med([r["net_ms"] for r in rows]),
                "remote_ms": med([r["remote_ms"] for r in rows]),
                "local_ms": med([r["local_ms"] for r in rows]),
                "draft_rate": med([r["draft_rate"] for r in rows]),
                "bottleneck": rows[-1]["bottleneck"] if rows else "",
                "model": rows[-1]["model"] if rows else "",
                "runs": len(rows),
            }
        if "medium" in out:
            m = out["medium"]
            m["score"] = bench_score(m["ttft_ms"], m["gen_tps"])
            m["first_token_score"] = int(round(1000000.0 / m["ttft_ms"])) if m["ttft_ms"] else None
        return out


# ---------------- views ----------------

PUBLIC_DROP = ("devices_json", "hops_json", "ttft_hops_json")


def _dec(row):
    row = dict(row)
    for k in ("devices_json", "hops_json", "ttft_hops_json", "probe_json", "summary_json"):
        if k in row:
            try:
                row[k[:-5]] = json.loads(row.pop(k) or "null")
            except ValueError:
                row[k[:-5]] = None
    if "ts" in row and row["ts"]:
        row["time"] = iso(row["ts"])
    for k in ("started", "finished"):
        if row.get(k):
            row[k + "_time"] = iso(row[k])
    return row


def _scrub_devices(devs):
    if not devs:
        return devs
    return [{k: v for k, v in d.items() if k != "endpoint"} for d in devs]


def data(meter, state=None, public=False, n_replies=100):
    name, host = bench_identity()
    replies = [_dec(r) for r in meter.store.query(
        "SELECT * FROM replies ORDER BY ts DESC LIMIT ?", (n_replies,))]
    runs = [_dec(r) for r in meter.store.query(
        "SELECT * FROM bench_runs ORDER BY id DESC LIMIT 30")]
    since = time.time() - 86400
    agg = {}
    for mode in ("solo", "split"):
        rows = meter.store.query(
            "SELECT gen_tps, ttft_ms, prompt_tps, total_ms, net_ms, local_ms, remote_ms, gen_n, "
            "ttft_net_ms, ttft_bottleneck "
            "FROM replies WHERE source='live' AND mode=? AND ts>=? AND gen_n>0", (mode, since))
        if rows:
            agg[mode] = {"replies": len(rows),
                         "gen_tps": med([r["gen_tps"] for r in rows]),
                         "ttft_ms": med([r["ttft_ms"] for r in rows]),
                         "ttft_p90_ms": pct([r["ttft_ms"] for r in rows], 90),
                         "ttft_net_ms": med([r["ttft_net_ms"] for r in rows]),
                         "ttft_bottleneck": most([r["ttft_bottleneck"] for r in rows]),
                         "prompt_tps": med([r["prompt_tps"] for r in rows]),
                         "total_ms": med([r["total_ms"] for r in rows]),
                         "tokens": sum(r["gen_n"] or 0 for r in rows)}
    # Per relayed worker over the last 30 split replies: per generated
    # token, how long the host waited on it, its own compute and the
    # network's part.
    per = {}
    for r in meter.store.query(
            "SELECT hops_json, gen_n FROM replies WHERE mode='split' AND hops_json IS NOT NULL "
            "ORDER BY ts DESC LIMIT 30"):
        try:
            hops = json.loads(r["hops_json"] or "[]")
        except ValueError:
            continue
        for h in hops:
            p = per.setdefault(h["name"], {"name": h["name"], "replies": 0, "tokens": 0,
                                           "wait_ms": 0.0, "remote_ms": 0.0, "net_ms": 0.0,
                                           "split_out": True, "rtts": []})
            p["replies"] += 1
            p["tokens"] += r["gen_n"] or 0
            p["wait_ms"] += h.get("wait_ms") or 0
            if h.get("remote_ms") is None:
                p["split_out"] = False
            else:
                p["remote_ms"] += h["remote_ms"]
                p["net_ms"] += h.get("net_ms") or 0
            if h.get("rtt_ms") is not None:
                p["rtts"].append(h["rtt_ms"])
    hop_summary = []
    for p in per.values():
        tok = max(1, p["tokens"])
        hop_summary.append({
            "name": p["name"], "replies": p["replies"],
            "wait_ms_per_token": round(p["wait_ms"] / tok, 1),
            "remote_ms_per_token": round(p["remote_ms"] / tok, 1) if p["split_out"] else None,
            "net_ms_per_token": round(p["net_ms"] / tok, 1) if p["split_out"] else None,
            "rtt_ms": med(p["rtts"]),
        })
    load = meter.current_load(state)
    host_mem = None
    if state:
        host_mem = {"gpu": state.get("gpu"), "mem": state.get("mem")}
    out = {
        "name": name, "host": host, "suite": SUITE_VERSION,
        "suite_cases": [{"case": c, "prompt_words": w, "n_predict": n, "reps": REPS} for c, w, n in SUITE],
        "generated": iso(time.time()),
        "meter_status": meter.status,
        "brain": {"mode": state.get("mode") if state else None,
                  "model": (state.get("brain") or {}).get("model") if state else None} if state else None,
        "load": load,
        "host_mem": host_mem,
        "workers_now": meter.workers_now(),
        "hop_summary": hop_summary,
        "last_24h": agg,
        "bench": ({"running": True, "step": meter.bench.step, "plan": meter.bench.plan}
                  if meter.bench and meter.bench.alive else {"running": False}),
        "runs": runs,
        "replies": replies,
        "replies_total": (meter.store.query("SELECT COUNT(*) AS n FROM replies") or [{"n": 0}])[0]["n"],
    }
    if public:
        if out["load"]:
            out["load"] = dict(out["load"], devices=_scrub_devices(out["load"]["devices"]))
        for r in out["replies"]:
            r["devices"] = _scrub_devices(r.get("devices"))
        out.pop("meter_status", None)
    else:
        out["board_admin"] = board_admin_rows()
    return out


def board_admin_rows(n=50):
    """The leaderboard's newest entries, hidden ones too, for the
    operator's control page."""
    if not os.path.exists(BOARD_DB):
        return []
    try:
        db = sqlite3.connect(BOARD_DB, timeout=10)
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute(
            "SELECT id, ts, score, ttft_ms, gen_tps, setup, machines, model, gpu, cpu, nick, hidden "
            "FROM entries ORDER BY id DESC LIMIT ?", (n,))]
        db.close()
    except sqlite3.Error:
        return []
    for r in rows:
        r["time"] = iso(r["ts"])
    return rows


def board_set_hidden(entry_id, hidden):
    try:
        eid = int(entry_id)
    except (TypeError, ValueError):
        return "That isn't a leaderboard entry."
    if not os.path.exists(BOARD_DB):
        return "The leaderboard has no entries yet."
    db = sqlite3.connect(BOARD_DB, timeout=10)
    n = db.execute("UPDATE entries SET hidden=? WHERE id=?", (1 if hidden else 0, eid)).rowcount
    db.commit()
    db.close()
    if not n:
        return "No leaderboard entry " + str(eid) + "."
    return ("Entry " + str(eid) + " is hidden from the leaderboard." if hidden
            else "Entry " + str(eid) + " is back on the leaderboard.")


def export(meter, what="replies", fmt="csv", days=30, public=False):
    since = time.time() - float(days) * 86400
    if what == "runs":
        rows = meter.store.query("SELECT * FROM bench_runs WHERE started>=? ORDER BY id", (since,))
        cols = RUN_COLS
    else:
        rows = meter.store.query("SELECT * FROM replies WHERE ts>=? ORDER BY ts", (since,))
        cols = REPLY_COLS
        if public:
            for r in rows:
                try:
                    r["devices_json"] = json.dumps(_scrub_devices(json.loads(r["devices_json"] or "null")))
                except ValueError:
                    r["devices_json"] = None
    if fmt == "json":
        return "application/json", json.dumps([_dec(r) for r in rows], indent=1)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["time"] + cols)
    for r in rows:
        t = r.get("ts") or r.get("started")
        w.writerow([iso(t) if t else ""] + [r.get(c) for c in cols])
    return "text/csv; charset=utf-8", buf.getvalue()


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__NAME__ — AI Pool benchmark</title>
<style>
:root{--bg:#15100c;--bg2:#1e1611;--card:#241a13;--line:#3a2a1d;--text:#f1e6d6;
--muted:#b9a68f;--gold:#e0a84a;--gold2:#f5c873;--ember:#c9572b;--green:#7fb069;--red:#d1603d;--blue:#6fa3c9}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
main{max-width:960px;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-family:Georgia,serif;font-size:2rem;color:var(--gold2)}
h2{font-family:Georgia,serif;font-size:1.2rem;color:var(--gold);margin:1.6rem 0 .5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.9rem 1rem;margin:.7rem 0}
.tbl{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.4rem .45rem;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
.fine{font-size:.85rem;color:var(--muted)}
.big{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem}
.stat{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:.6rem .7rem}
.stat b{display:block;font-size:1.35rem;color:var(--gold2)}
.stat span{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
button,a.btn{background:var(--ember);color:#fff;border:0;border-radius:8px;padding:.6rem 1rem;font-weight:600;
cursor:pointer;text-decoration:none;display:inline-block;font-size:.95rem;min-height:44px}
button.alt,a.btn.alt{background:var(--bg2);color:var(--text);border:1px solid var(--line)}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.solo{color:var(--blue)} .split{color:var(--gold2)} .bad{color:var(--red)} .ok{color:var(--green)}
details.fold{margin-top:1.6rem}
details.fold>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;min-height:44px}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary h2{margin:0;display:inline}
details.fold>summary h2::before{content:"▸ ";color:var(--muted)}
details.fold[open]>summary h2::before{content:"▾ "}
details.fold[open]>summary{margin-bottom:.5rem}
svg{width:100%;height:110px;background:var(--bg2);border-radius:10px;border:1px solid var(--line)}
</style></head><body><main>
<h1 id="nm">__NAME__</h1>
<p class="fine">The AI Pool's benchmark and usage log — every reply timed, every machine in the split measured.
<span id="gen"></span></p>
__CONTROLS__
__MSG__
<div id="app"><p class="fine">Loading…</p></div>
</main>
<script>
const DATA_URL = "__DATA__", EXPORT_URL = "__EXPORT__";
const f = (v, d=1) => v === null || v === undefined ? "—" : Number(v).toFixed(d);
const s = (v) => v === null || v === undefined ? "—" : (Number(v) < 1000 ? Math.round(Number(v)) + " ms" : (Number(v)/1000).toFixed(Number(v) < 10000 ? 2 : 1) + " s");
const esc = (t) => String(t === null || t === undefined ? "" : t).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
function stat(label, val){ return `<div class="stat"><b>${val}</b><span>${esc(label)}</span></div>`; }
function table(head, rows){ return `<div class="tbl"><table><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr>${rows.join("")}</table></div>`; }
function spark(replies){
  const pts = replies.filter(r => r.ttft_ms).slice(0, 60).reverse();
  if (!pts.length) return "";
  const max = Math.max(...pts.map(r => r.ttft_ms)) * 1.1, w = 600, h = 110, bw = w / pts.length;
  const bars = pts.map((r,i) => { const bh = (r.ttft_ms / max) * (h - 16);
    return `<rect x="${i*bw+1}" y="${h-bh}" width="${Math.max(1,bw-2)}" height="${bh}" fill="${r.mode==='split'?'#f5c873':'#6fa3c9'}"><title>${esc(r.time)} ${esc(r.mode)} first token ${s(r.ttft_ms)}, ${r.prompt_n} tokens in</title></rect>`; }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}<text x="6" y="14" fill="#b9a68f" font-size="12">time to first token per reply (lower is better), newest right · worst ${s(max/1.1)}</text></svg>`;
}
function render(d){
  document.getElementById("nm").textContent = d.name;
  document.title = d.name + " — time to first token and pool benchmark";
  document.getElementById("gen").textContent = "Updated " + d.generated + ".";
  let h = "";
  if (d.bench && d.bench.running) h += `<div class="card"><b>Benchmark running:</b> ${esc(d.bench.step)}</div>`;
  const last = (d.runs || []).find(r => r.status === "done" || r.status === "cancelled");
  h += `<h2>Time to first token</h2><div class="card">`;
  if (last && last.summary) {
    for (const mode of Object.keys(last.summary)) {
      const cs = last.summary[mode];
      h += `<p class="fine"><span class="${mode}">${esc(mode)}</span> · benchmark run ${last.id}</p><div class="big">`;
      if (cs.medium && cs.medium.score) h += stat("SwarmBench score", cs.medium.score);
      for (const c of Object.keys(cs)) h += stat(c + " (" + f(cs[c].prompt_n,0) + " tokens in)", s(cs[c].ttft_ms));
      h += `</div>`;
      const m = cs.medium || cs.short || {};
      if (m.ttft_bottleneck) h += `<p class="fine" style="margin:.2rem 0 .7rem">Slowest part before the first token: <b>${esc(m.ttft_bottleneck)}</b>${m.ttft_net_ms ? " · network to relayed workers " + s(m.ttft_net_ms) : ""}${m.ttft_remote_ms ? " · their compute " + s(m.ttft_remote_ms) : ""}</p>`;
    }
  } else h += `<p class="fine">No benchmark yet.</p>`;
  const a24 = d.last_24h || {};
  for (const mode of ["solo","split"]) if (a24[mode]) h += `<p class="fine">Live ${esc(mode)} replies, last 24 h: median ${s(a24[mode].ttft_ms)}, slowest 10% over ${s(a24[mode].ttft_p90_ms)}${a24[mode].ttft_bottleneck ? ", mostly held up by " + esc(a24[mode].ttft_bottleneck) : ""}.</p>`;
  h += `</div><h2>Latest benchmark</h2>`;
  if (last && last.summary) {
    h += `<div class="card"><p class="fine">Run ${last.id} · ${esc(last.finished_time || last.started_time)} · ${esc(last.plan === "both" ? "solo then split" : "as it ran")} · suite ${esc(last.suite)}${last.other_replies ? " · " + last.other_replies + " other replies ran meanwhile (numbers may be noisy)" : ""}</p>`;
    const rows = [];
    for (const mode of Object.keys(last.summary)) for (const c of Object.keys(last.summary[mode])) {
      const x = last.summary[mode][c];
      rows.push(`<tr><td class="${mode}">${esc(mode)}</td><td>${esc(c)}</td><td>${f(x.prompt_n,0)} → ${f(x.gen_n,0)}</td><td><b>${s(x.ttft_ms)}</b></td><td>${s(x.ttft_best_ms)}</td><td>${f(x.prompt_tps,1)}</td><td>${s(x.ttft_net_ms)}</td><td>${esc(x.ttft_bottleneck)}</td><td>${f(x.gen_tps,2)}</td><td>${s(x.total_ms)}</td><td>${esc(x.bottleneck)}</td></tr>`);
    }
    h += table(["Mode","Case","Tokens in → out","First token","Best","Prompt tok/s","Network before first token","Slowest before first token","Gen tok/s","Total","Slowest overall"], rows);
    if (last.probe) {
      const pr = [];
      for (const mode of Object.keys(last.probe)) for (const p of last.probe[mode]) pr.push(`<tr><td class="${mode}">${esc(mode)}</td><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td>${f(p.rtt_ms)} ms</td><td>${f(p.rtt_max_ms)} ms</td><td>${p.lost ? p.lost + " lost" : ""}${esc(p.note||"")}</td></tr>`);
      if (pr.length) h += `<p class="fine" style="margin-top:.6rem">Latency probe before the run:</p>` + table(["Mode","Machine","Link","Round trip","Worst",""], pr);
    }
    if (last.note) h += `<p class="fine" style="margin-top:.5rem">${esc(last.note)}</p>`;
    h += `</div>`;
  } else h += `<div class="card"><p class="fine">No benchmark yet.</p></div>`;
  const a = d.last_24h || {};
  h += `<h2>Last 24 hours (live replies)</h2><div class="card"><div class="big">`;
  for (const mode of ["solo","split"]) if (a[mode]) h += stat(mode + " first token (median)", s(a[mode].ttft_ms)) + stat(mode + " gen tok/s", f(a[mode].gen_tps,2)) + stat(mode + " replies", a[mode].replies);
  if (!a.solo && !a.split) h += `<p class="fine">No replies logged in the last day.</p>`;
  h += `</div>${spark(d.replies || [])}</div>`;
  if (d.load) {
    const hm = t => t ? new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) : "";
    const loadTxt = d.load.loaded
      ? `loaded ${esc(hm(d.load.loaded))}${d.load.load_s != null ? " (took " + (d.load.load_s >= 90 ? Math.round(d.load.load_s / 60) + " min" : d.load.load_s + " s") + ")" : ""}`
      : `loading since ${esc(hm(d.load.started))}`;
    const kvEst = d.load.devices.some(x => x.kv_est);
    h += `<h2>Machines in the brain now</h2><div class="card"><p class="fine"><span class="${d.load.mode}">${esc(d.load.mode)}</span> · ${esc(d.load.model)} · ${d.load.n_layer_all || "?"} layers · ${loadTxt}${d.load.draft ? " · draft " + esc(d.load.draft) : ""}</p>`;
    h += table(["Machine","Kind","Layers","Weights",kvEst ? "KV cache (est.)" : "KV cache"], d.load.devices.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.kind)}</td><td>${esc(x.layers)}</td><td>${f(x.model_mb,0)} MB</td><td>${x.kv_est ? "~" : ""}${f(x.kv_mb,0)} MB</td></tr>`));
    if (d.host_mem && d.host_mem.gpu) h += `<p class="fine" style="margin-top:.5rem">FX705 card ${d.host_mem.gpu.used_mb} / ${d.host_mem.gpu.total_mb} MB used · RAM ${d.host_mem.mem.available_mb} MB free of ${d.host_mem.mem.total_mb} MB</p>`;
    h += `</div>`;
  }
  const hs = d.hop_summary || [], wn = d.workers_now || [];
  if (hs.length || wn.length) {
    h += `<h2>Relayed workers: compute vs network</h2><div class="card">`;
    if (hs.length) h += table(["Worker","Split replies","Host waited / token","Its compute / token","Network / token","Relay round trip"], hs.map(x => `<tr><td>${esc(x.name)}</td><td>${x.replies}</td><td>${f(x.wait_ms_per_token)} ms</td><td>${f(x.remote_ms_per_token)} ms</td><td><b>${f(x.net_ms_per_token)} ms</b></td><td>${f(x.rtt_ms)} ms</td></tr>`));
    if (wn.length) h += `<p class="fine" style="margin-top:.6rem">Connected now:</p>` + table(["Worker","Ping now","Ping avg","Ping best","RAM free","VRAM used","Reports compute"], wn.map(x => `<tr><td>${esc(x.name)}</td><td>${f(x.rtt_last)} ms</td><td>${f(x.rtt_avg)} ms</td><td>${f(x.rtt_min)} ms</td><td>${x.mem.ram_avail_mb !== undefined ? x.mem.ram_avail_mb + " / " + x.mem.ram_total_mb + " MB" : "—"}</td><td>${x.mem.vram_used_mb !== undefined ? x.mem.vram_used_mb + " / " + x.mem.vram_total_mb + " MB" : "—"}</td><td>${x.reports_compute ? "yes" : "no (older worker)"}</td></tr>`));
    h += `<p class="fine" style="margin-top:.5rem">"Host waited" is the time the FX705 spent waiting on that worker. The worker reports its own compute; the rest of the wait is network and relay.</p></div>`;
  }
  h += `<h2>Benchmark history</h2><div class="card">`;
  const hist = [];
  for (const r of d.runs || []) {
    const sm = r.summary || {};
    const cell = (mode) => sm[mode] && sm[mode].medium ? f(sm[mode].medium.gen_tps,2) : "—";
    const tt = (mode) => sm[mode] && sm[mode].medium ? s(sm[mode].medium.ttft_ms) : "—";
    hist.push(`<tr><td>${r.id}</td><td>${esc(r.started_time)}</td><td>${esc(r.status)}</td><td class="solo"><b>${tt("solo")}</b></td><td class="split"><b>${tt("split")}</b></td><td>${cell("solo")} / ${cell("split")}</td><td>${esc(Object.values(sm).map(m => (m.medium||m.short||{}).model).filter(Boolean)[0] || "")}</td></tr>`);
  }
  h += hist.length ? table(["Run","Started","Status","Solo first token (medium)","Split first token (medium)","Gen tok/s solo / split","Model"], hist) : `<p class="fine">None yet.</p>`;
  h += `</div>`;
  const reps = d.replies || [], total = d.replies_total || reps.length;
  const shown = SHOW_ALL ? reps : reps.slice(0, 20);
  h += `<details class="card fold" id="recent"${REPLIES_OPEN ? " open" : ""}><summary><h2>Recent replies</h2><span class="fine">${total ? (SHOW_ALL ? "all " + reps.length : "latest " + shown.length) + " of " + total : "none yet"}</span></summary>`;
  h += table(["#","Time","Source","Mode","In → out","First token","Slowest before first token","Gen tok/s","Total","Draft","Network","Slowest overall"], shown.map((r, i) => `<tr><td>${i + 1}</td><td>${esc((r.time||"").replace("T"," ").slice(5,19))}</td><td>${esc(r.source)}${r.case_name ? " " + esc(r.case_name) : ""}</td><td class="${esc(r.mode)}">${esc(r.mode)}</td><td>${r.prompt_n} → ${r.gen_n}</td><td><b>${s(r.ttft_ms)}</b></td><td>${esc(r.ttft_bottleneck || "")}</td><td>${f(r.gen_tps,2)}</td><td>${s(r.total_ms)}</td><td>${r.draft_rate !== null && r.draft_rate !== undefined ? f(r.draft_rate*100,0) + "%" : "—"}</td><td>${s(r.net_ms)}</td><td>${esc(r.bottleneck)}${r.overlap ? " (overlapped)" : ""}</td></tr>`));
  if (total > 20 || SHOW_ALL) h += `<div class="row" style="margin-top:.8rem"><button class="alt" type="button" onclick="toggleAll()">${SHOW_ALL ? "Show the latest 20" : "View all (" + total + ")"}</button>${SHOW_ALL && total > reps.length ? `<span class="fine">The page holds the latest ${reps.length}; the CSV has the rest.</span>` : ""}</div>`;
  h += `</details><div class="card"><div class="row"><a class="btn alt" href="${EXPORT_URL}?what=replies&fmt=csv">Replies CSV</a><a class="btn alt" href="${EXPORT_URL}?what=replies&fmt=json">Replies JSON</a><a class="btn alt" href="${EXPORT_URL}?what=runs&fmt=csv">Benchmarks CSV</a><a class="btn alt" href="${EXPORT_URL}?what=runs&fmt=json">Benchmarks JSON</a></div>`;
  h += `</div><h2>Test your own setup</h2><div class="card"><p>SwarmBench runs the same test on any llama.cpp, Ollama, LM Studio, vLLM or other OpenAI-style server, on one machine or a split, and gives a score you can compare with the numbers here.</p>
<div class="row" style="margin-top:.6rem"><a class="btn" href="https://pool.tavernworks.dev/downloads/swarmbench.exe">Windows app (.exe)</a><a class="btn alt" href="https://pool.tavernworks.dev/downloads/swarmbench.bat">Windows launcher (.bat)</a><a class="btn alt" href="https://pool.tavernworks.dev/downloads/swarmbench.py">swarmbench.py</a><a class="btn alt" href="https://${esc(d.host)}/board">Leaderboard</a></div>
<p class="fine" style="margin-top:.6rem">On Windows, the .exe needs nothing else: double-click it to test the server on that PC. If Windows warns that it doesn't know the app, click More info, then Run anyway. The .bat launcher does the same with your own Python. On Linux and Mac, swarmbench.py needs Python 3.8 or newer. Run <code>python swarmbench.py</code> to test the server on that computer, <code>python swarmbench.py http://host:port</code> for another, and add <code>--rpc host:port,host:port</code> for the machines in a llama.cpp split (the .exe takes the same options). Score: 1000 means a 1.0 s first token and 10 tokens/s on the medium case, with the first token counting twice as much.</p>`;
  h += `<p class="fine" style="margin-top:.5rem">Suite ${esc(d.suite)}: ${(d.suite_cases||[]).map(c => c.case + " (~" + Math.round(c.prompt_words*1.3) + " tokens in, " + c.n_predict + " out)").join(", ")}, ${d.suite_cases && d.suite_cases[0] ? d.suite_cases[0].reps : 2} runs each, greedy, no prompt cache. Exports cover the last 30 days.</p></div>`;
  if (d.board_admin) {
    h += `<h2>Leaderboard entries (only you see this)</h2><div class="card">`;
    h += d.board_admin.length ? table(["#","Posted","Score","First token","Gen tok/s","Setup","Model","Hardware","By",""], d.board_admin.map(e => `<tr><td>${e.id}</td><td>${esc((e.time||"").slice(0,16).replace("T"," "))}</td><td><b>${e.score}</b></td><td>${s(e.ttft_ms)}</td><td>${f(e.gen_tps,1)}</td><td>${esc(e.setup)}${e.machines > 1 ? " (" + e.machines + ")" : ""}</td><td>${esc(e.model)}</td><td>${esc(e.gpu || e.cpu || "")}</td><td>${esc(e.nick || "")}</td><td><form method="post" action="/action"><input type="hidden" name="action" value="${e.hidden ? "bench_board_show" : "bench_board_hide"}"><input type="hidden" name="id" value="${e.id}"><button class="alt" type="submit">${e.hidden ? "Show again" : "Hide"}</button></form></td></tr>`)) : `<p class="fine">Nobody has posted a result yet.</p>`;
    h += `<p class="fine" style="margin-top:.5rem">Hide takes an entry off the public leaderboard; it stays here so you can show it again.</p></div>`;
  }
  document.getElementById("app").innerHTML = h;
}
let REPLIES_OPEN = false, SHOW_ALL = false;
document.addEventListener("toggle", e => { if (e.target && e.target.id === "recent") REPLIES_OPEN = e.target.open; }, true);
function toggleAll(){ SHOW_ALL = !SHOW_ALL; REPLIES_OPEN = true; load(); }
async function load(){ try { const r = await fetch(DATA_URL + (SHOW_ALL ? "?replies=all" : ""), {cache:"no-store"}); render(await r.json()); } catch(e) { document.getElementById("app").innerHTML = '<p class="fine">Could not load the data just now.</p>'; } }
load(); setInterval(load, 15000);
</script></body></html>"""

CONTROLS = """<div class="card"><div class="row">
<form method="post" action="/action"><input type="hidden" name="action" value="bench_run"><input type="hidden" name="plan" value="current"><button type="submit">Run benchmark now</button></form>
<form method="post" action="/action"><input type="hidden" name="action" value="bench_run"><input type="hidden" name="plan" value="both"><button class="alt" type="submit">Solo, then split</button></form>
<form method="post" action="/action"><input type="hidden" name="action" value="bench_cancel"><button class="alt" type="submit">Cancel</button></form>
<a class="btn alt" href="/">Control page</a></div>
<p class="fine" style="margin-top:.5rem">“Run benchmark now” tests the brain as it runs (a few minutes, bots stay up).
“Solo, then split” restarts the brain in each mode and puts it back after, so bots get no AI replies while each mode loads.
Public read-only page: <a style="color:var(--gold2)" href="https://__HOST__/">https://__HOST__/</a></p></div>"""


def page(public=False, data_url="data.json", export_url="export", msg=""):
    from html import escape
    name, host = bench_identity()
    controls = "" if public else CONTROLS.replace("__HOST__", host)
    msg_html = ('<div class="card" style="border-color:#7fb069">' + escape(msg) + "</div>") if msg else ""
    return (PAGE.replace("__CONTROLS__", controls).replace("__MSG__", msg_html)
            .replace("__NAME__", name.replace("<", "").replace(">", "").replace("&", "and"))
            .replace("__DATA__", data_url).replace("__EXPORT__", export_url))
