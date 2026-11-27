#!/usr/bin/env python3
# AI Pool coordinator — the M3 control service for the FX705.
#
# Serves a small control page on the tailnet only (the design's
# trust model: Shea's tailnet, Shea's page, same as the bot
# dashboards' private side). It can:
#   - probe the pool live (brain health, service states, GPU/RAM,
#     worker reachability) and show roster + pool total
#   - list the GGUF models on disk with a fit check per mode
#   - start/stop the brain (solo or split) via systemd
#   - pick the model (writes current-model.txt, which the solo and
#     host scripts read at startup) and compute the tensor split
#     from the roster's offered memory (pool-split.txt + pool-rpc.txt)
#   - serve /status.json in the shape the public pool page reads
#
# Python 3 standard library only — python3 is already on the FX705.
# Test hooks: POOL_DIR, POOL_BIND, POOL_PORT, POOL_BRAIN_URL,
# POOL_MEMINFO override every machine-specific path.
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

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
from urllib.parse import parse_qs, quote, urlparse

HOME = os.path.expanduser("~")
if HOME == "~":
    HOME = "/root"
POOL_DIR = os.environ.get("POOL_DIR", os.path.join(HOME, "ai-pool"))
CONFIG_PATH = os.path.join(POOL_DIR, "pool-config.json")
CURRENT_MODEL_PATH = os.path.join(POOL_DIR, "current-model.txt")
SPLIT_PATH = os.path.join(POOL_DIR, "pool-split.txt")
RPC_PATH = os.path.join(POOL_DIR, "pool-rpc.txt")
DRAFT_PATH = os.path.join(POOL_DIR, "pool-draft.txt")
LAST_SEEN_UP = {}   # worker endpoint -> epoch it last answered a probe
WORKER_GRACE_SEC = 600  # seen up this recently = busy, not down, while
                        # a split is loading or running


def running_rpc_endpoints():
    """The --rpc list the running split was started with — the file
    the coordinator itself wrote at Start split."""
    try:
        with open(RPC_PATH) as f:
            return [e.strip() for e in f.read().split(",") if e.strip()]
    except Exception:
        return []
RELAY_STATE_PATH = os.path.join(POOL_DIR, "relay-state.json")
MEMINFO_PATH = os.environ.get("POOL_MEMINFO", "/proc/meminfo")
PROC_DIR = os.environ.get("POOL_PROC", "/proc")
PORT = int(os.environ.get("POOL_PORT", "8091"))
DEFAULT_MODEL = "Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf"
MEASURED_SPEED = "3.3 tokens/sec (solo) · 0.9 split"
ENROLL_PATH = os.path.join(POOL_DIR, "enrollments.json")
ACCOUNTS_PATH = os.path.join(POOL_DIR, "accounts.json")
LEDGER_PATH = os.path.join(POOL_DIR, "ledger.jsonl")
SHARES_CFG_PATH = os.path.join(POOL_DIR, "shares-config.json")
MCP_PATH = os.path.join(POOL_DIR, "mcp-servers.json")
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


def save_shares_cfg(cfg):
    tmp = SHARES_CFG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({k: cfg[k] for k in DEFAULT_SHARES}, f, indent=1)
    os.replace(tmp, SHARES_CFG_PATH)


def load_mcp_servers():
    try:
        with open(MCP_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("servers"), list):
            return [s for s in data["servers"] if isinstance(s, dict)]
    except Exception:
        pass
    return []


def save_mcp_servers(servers):
    tmp = MCP_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"servers": servers}, f, indent=1)
    os.replace(tmp, MCP_PATH)


def append_ledger(account_id, kind, shares, detail):
    rec = {"ts": now_central().isoformat(timespec="seconds"),
           "account": account_id, "kind": kind,
           "shares": round(float(shares), 4), "detail": str(detail)[:120]}
    with open(LEDGER_PATH, "a") as f:
        f.write(json.dumps(rec) + "\n")


def ledger_balances():
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
    return out


def starter_credited(account_id):
    try:
        with open(LEDGER_PATH) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    if rec.get("account") == account_id and rec.get("kind") == "starter":
                        return True
                except Exception:
                    continue
    except Exception:
        pass
    return False

DEFAULT_CONFIG = {
    "machines": [
        {"name": "FX705", "ip": "100.100.40.72", "role": "coordinator", "offered_mb": 0},
        {"name": "Yoga", "ip": "100.115.176.72", "role": "worker", "offered_mb": 6144},
    ],
    "fx705_gpu_cap_mb": 3072,
    "kv_reserve_mb": 1024,
}


def sh(args, timeout=8):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "").strip()
    except Exception:
        return 1, ""


def own_tailnet_ip():
    _, out = sh(["tailscale", "ip", "-4"], timeout=5)
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("100."):
            return line
    cfg = load_config()
    for m in cfg["machines"]:
        if m.get("role") == "coordinator":
            return m.get("ip", "")
    return ""


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        cfg.setdefault("machines", [])
        cfg.setdefault("fx705_gpu_cap_mb", 3072)
        cfg.setdefault("kv_reserve_mb", 1024)
        return cfg
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


def unit_state(name):
    _, out = sh(["systemctl", "is-active", name], timeout=5)
    return out or "unknown"


def http_json(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def brain_url():
    if os.environ.get("POOL_BRAIN_URL"):
        return os.environ["POOL_BRAIN_URL"].rstrip("/")
    return "http://" + own_tailnet_ip() + ":8090"


def brain_info():
    base = brain_url()
    health = http_json(base + "/health")
    up = bool(health and health.get("status") == "ok")
    model = None
    if up:
        models = http_json(base + "/v1/models")
        try:
            model = models["data"][0]["id"]
        except Exception:
            model = None
    return {"up": up, "model": model, "url": base}


def gpu_info():
    _, out = sh(["nvidia-smi", "--query-gpu=memory.total,memory.used",
                 "--format=csv,noheader,nounits"], timeout=5)
    try:
        total, used = [int(x) for x in out.splitlines()[0].split(",")]
        return {"total_mb": total, "used_mb": used}
    except Exception:
        return None


def mem_info():
    vals = {}
    try:
        with open(MEMINFO_PATH) as f:
            for line in f:
                parts = line.split()
                if parts and parts[0] in ("MemTotal:", "MemAvailable:"):
                    vals[parts[0][:-1]] = int(parts[1]) // 1024
    except Exception:
        pass
    return {"total_mb": vals.get("MemTotal", 0), "available_mb": vals.get("MemAvailable", 0)}


# The FX705's own RAM can join a split as one more RPC device: a
# CPU-only ggml-rpc-server on this machine's loopback
# (ai-pool-hostram.service). Loopback costs no network time, so it
# is the cheapest memory the split can add — what lets a ~19 GB
# model fit beside the Yoga and the relayed workers. It sits last
# among the RPC devices, right before the card.
HOST_RAM_IP = "127.0.0.1"
HOST_RAM_PORT = 50060
HOST_RAM_NAME = "FX705 RAM"


def worker_up(ip, port=50052):
    try:
        with socket.create_connection((ip, int(port)), timeout=2):
            return True
    except Exception:
        return False


def load_relay_machines():
    """Live relayed (public) workers: the front door's
    relay-state.json joined with enrollments for offered memory.
    A machine appears here only while its relay is connected."""
    try:
        with open(RELAY_STATE_PATH) as f:
            state = json.load(f)
    except Exception:
        return []
    offered = {}
    for rec in load_enrollments()["enrollments"]:
        offered[rec.get("id")] = int(rec.get("offered_mb") or 0)
    out = []
    for m in state.get("machines", []):
        if m.get("rpc"):
            out.append({
                "id": m.get("id", ""),
                "name": m.get("name", "relayed worker"),
                "rpc": m["rpc"],
                "offered_mb": offered.get(m.get("id"), 0),
            })
    return out


def catalog():
    out = []
    try:
        for name in sorted(os.listdir(POOL_DIR)):
            if name.endswith(".gguf"):
                size = os.path.getsize(os.path.join(POOL_DIR, name)) // (1024 * 1024)
                out.append({"file": name, "size_mb": size})
    except Exception:
        pass
    return out


def disk_free_mb():
    try:
        return shutil.disk_usage(POOL_DIR).free // (1024 * 1024)
    except Exception:
        return 0


def model_in_use(name):
    """True when any process has this model file open or mapped: a
    loaded brain (llama-server maps the weights), a download still
    writing it, or a checksum reading it."""
    path = os.path.realpath(os.path.join(POOL_DIR, name))
    try:
        pids = [p for p in os.listdir(PROC_DIR) if p.isdigit()]
    except Exception:
        return False
    for pid in pids:
        base = os.path.join(PROC_DIR, pid)
        try:
            for fd in os.listdir(os.path.join(base, "fd")):
                try:
                    if os.path.realpath(os.path.join(base, "fd", fd)) == path:
                        return True
                except OSError:
                    pass
        except OSError:
            pass
        try:
            with open(os.path.join(base, "maps")) as f:
                for line in f:
                    if line.rstrip("\n").endswith(" " + path):
                        return True
        except OSError:
            pass
    return False


def delete_refusal(model):
    """Why this model can't be deleted right now, or "" when it can."""
    if not model or os.path.basename(model) != model or not model.endswith(".gguf"):
        return "That isn't a model file name — nothing deleted."
    if model not in {m["file"] for m in catalog()}:
        return "That model is not on disk — nothing deleted."
    if model == current_model():
        return (model + " is the pool's current model, so it stays. Pick "
                "another model with Use this model first, then delete this one.")
    loaded = brain_info().get("model") or ""
    if loaded and os.path.basename(loaded) == model:
        return model + " is loaded in the running brain, so it stays. Stop the brain first."
    if model_in_use(model):
        return (model + " is open right now (a running brain, a download "
                "or a checksum), so it stays. Try again once that finishes.")
    return ""


def current_model():
    try:
        with open(CURRENT_MODEL_PATH) as f:
            name = f.read().strip()
        if name:
            return name
    except Exception:
        pass
    return DEFAULT_MODEL


def draft_info():
    """What ~/ai-pool/pool-draft.txt turns on for the next split
    start (fx705-host.sh reads the same line): None when off, else
    {"mode": "model"|"mtp", "file", "card_mb"} where card_mb is what
    the draft takes out of the card's 4 GB — the file plus 512 MB
    for its context and compute buffers."""
    try:
        with open(DRAFT_PATH) as f:
            line = (f.readline() or "").strip()
    except Exception:
        return None
    if not line or line.lower() in ("off", "none"):
        return None
    if line.lower() == "mtp":
        return {"mode": "mtp", "file": "", "card_mb": 256}
    if line.endswith(".gguf"):
        try:
            size = os.path.getsize(os.path.join(POOL_DIR, line)) // (1024 * 1024)
        except OSError:
            return None  # the host script also runs without it
        return {"mode": "model", "file": line, "card_mb": size + 512}
    return None


def compute_split(offered_list, fx_share):
    """One proportion per live RPC device, in device order, plus
    the host card's share — always last, always 1: the card's slice
    must fit whole in its 4 GB (the M1 sizing lesson)."""
    parts = []
    for offered in offered_list:
        parts.append(str(max(1, round(offered / fx_share))) if fx_share else "1")
    parts.append("1")
    return ",".join(parts)


def pool_state():
    cfg = load_config()
    brain = brain_info()
    solo = unit_state("ai-pool-solo")
    host = unit_state("ai-pool-host")
    gpu = gpu_info()
    mem = mem_info()
    reserve = int(cfg.get("kv_reserve_mb") or 1024)
    gpu_total = gpu["total_mb"] if gpu else 0
    fx_share = min(int(cfg.get("fx705_gpu_cap_mb") or 3072), gpu_total or 3072)
    # A draft model lives whole on the card, so the card's layer
    # share shrinks by what the draft takes (floor 1 GB).
    draft = draft_info()
    if draft:
        fx_share = max(1024, fx_share - draft["card_mb"])

    # A ggml-rpc-server will not answer this page's side probe while
    # a llama-server session is connected to it — that is, for the
    # whole life of a split, loads included (proven live 2026-11-18:
    # the roster read 'down', split capacity 3072 and 'tensor 1'
    # while a healthy split was serving). So while a split runs,
    # trust the device list it was started with; while one is
    # starting, a worker seen up within the grace window is busy.
    running_split = brain["up"] and host == "active" and solo != "active"
    starting = (not brain["up"]) and (solo == "active" or host == "active")
    trusted = running_rpc_endpoints() if running_split else []
    now = time.time()

    machines = []
    total_offered = 0
    devices = []  # live RPC devices, in split order
    host_ram = []  # the FX705's own RAM device, appended after relays
    for m in cfg["machines"]:
        entry = dict(m)
        if m.get("role") == "host-ram":
            endpoint = HOST_RAM_IP + ":" + str(HOST_RAM_PORT)
            probed = worker_up(HOST_RAM_IP, HOST_RAM_PORT)
            if probed:
                LAST_SEEN_UP[endpoint] = now
            busy = (not probed) and (running_split or starting) and (
                endpoint in trusted
                or now - LAST_SEEN_UP.get(endpoint, 0) < WORKER_GRACE_SEC)
            entry["ip"] = endpoint
            entry["up"] = probed or busy
            entry["state"] = "up" if probed else ("busy" if busy else "down")
            entry["holds"] = "layers just before the card (loopback)"
            total_offered += int(m.get("offered_mb") or 0)
            if entry["up"] and int(m.get("offered_mb") or 0) > 0:
                host_ram.append({
                    "name": HOST_RAM_NAME,
                    "endpoint": endpoint,
                    "offered_mb": int(m.get("offered_mb") or 0),
                    "source": "host",
                })
            machines.append(entry)
            continue
        if m.get("role") == "coordinator":
            entry["up"] = brain["up"] or solo == "active" or host == "active"
            entry["state"] = "up" if entry["up"] else "down"
            entry["holds"] = "last layers (an end)"
            total_offered += gpu_total + mem["total_mb"]
        else:
            endpoint = str(m.get("ip", "")) + ":50052"
            probed = worker_up(m.get("ip", ""))
            if probed:
                LAST_SEEN_UP[endpoint] = now
            busy = (not probed) and (running_split or starting) and (
                endpoint in trusted
                or now - LAST_SEEN_UP.get(endpoint, 0) < WORKER_GRACE_SEC)
            entry["up"] = probed or busy
            entry["state"] = "up" if probed else ("busy" if busy else "down")
            entry["holds"] = "middle layers"
            total_offered += int(m.get("offered_mb") or 0)
            if entry["up"]:
                if not devices:
                    entry["holds"] = "first layers (an end)"
                devices.append({
                    "name": m.get("name", "?"),
                    "endpoint": endpoint,
                    "offered_mb": int(m.get("offered_mb") or 0),
                    "source": "tailnet",
                })
        machines.append(entry)
    # Relayed public workers come AFTER the operator's own tailnet
    # machines in the device order, and the host card's share is
    # appended last by compute_split. Split proportions run
    # RPC-first (proven in M1), so the split's two ends — the first
    # RPC device and the card — always sit on the operator's own
    # machines, and public workers only ever hold middle layers.
    for rm in load_relay_machines():
        machines.append({
            "name": rm["name"], "role": "worker (relay)",
            "ip": rm["rpc"], "offered_mb": rm["offered_mb"],
            "up": True, "state": "up", "holds": "middle layers", "relayed": True,
        })
        total_offered += rm["offered_mb"]
        devices.append({
            "name": rm["name"], "endpoint": rm["rpc"],
            "offered_mb": rm["offered_mb"], "source": "relay",
        })
    # The FX705's RAM goes last among the RPC devices: its layers sit
    # right before the card's, on the same machine, so the hop
    # between them never leaves this laptop.
    devices.extend(host_ram)

    solo_capacity = gpu_total + mem["available_mb"] - reserve
    workers_offered = sum(d["offered_mb"] for d in devices)
    split_capacity = fx_share + workers_offered  # M1-proven: the 2,1 load's KV lived inside these shares
    split = compute_split([d["offered_mb"] for d in devices], fx_share)
    rpc_list = ",".join(d["endpoint"] for d in devices)
    ends_safe = bool(devices) and devices[0]["source"] in ("tailnet", "host")

    models = []
    cur = current_model()
    for item in catalog():
        models.append({
            **item,
            "current": item["file"] == cur,
            "fits_solo": item["size_mb"] <= solo_capacity,
            "fits_split": item["size_mb"] <= split_capacity,
        })

    if brain["up"] and host == "active" and solo != "active":
        mode = "split"
    elif brain["up"]:
        mode = "solo"
    elif solo == "active" or host == "active":
        mode = "starting"
    else:
        mode = "off"
    ip = own_tailnet_ip()
    return {
        "mode": mode,
        "brain": brain,
        "units": {"ai-pool-solo": solo, "ai-pool-host": host},
        "gpu": gpu,
        "mem": mem,
        "machines": machines,
        "pool_total_mb": total_offered,
        "solo_capacity_mb": solo_capacity,
        "split_capacity_mb": split_capacity,
        "split": split,
        "draft": draft,
        "rpc_list": rpc_list,
        "devices": devices,
        "ends_safe": ends_safe,
        "models": models,
        "current_model": cur,
        "endpoint": "http://" + ip + ":8090/v1",
        "page_url": "http://" + ip + ":" + str(PORT) + "/",
        "updated": now_central().strftime("%d %b %Y %H:%M %Z"),
    }


def status_json():
    st = pool_state()
    brain_txt = {
        "solo": "Online — running on the FX705 (solo)",
        "split": "Online — split across the pool",
        "starting": "Starting…",
        "off": "Offline",
    }[st["mode"]]
    return {
        "brain": brain_txt,
        "model": st["brain"]["model"] or st["current_model"],
        "serving": "UndercoverBurn, the Twitch roast bot" if st["brain"]["up"] else "—",
        "split": "Active" if st["mode"] == "split" else "Standby — proven, currently off",
        "enrollment": "Open — worker app available; operator approves each machine",
        "speed": MEASURED_SPEED,
        "updated": now_central().strftime("%d %b %Y %H:%M %Z"),
    }


# ---------------- actions ----------------

def act(name, fields):
    cfg = load_config()
    if name == "start_solo":
        sh(["systemctl", "start", "ai-pool-solo"], timeout=30)
        return "Starting the solo brain — loading takes a few minutes."
    if name == "start_split":
        st = pool_state()
        if not st["rpc_list"]:
            return ("No live worker to split with — the tailnet worker "
                    "and any relayed workers are all down. Nothing started.")
        if not st["ends_safe"]:
            return ("Only public relayed workers are live. A split "
                    "needs one of your own machines at the front of "
                    "the split (the ends stay on your hardware) — "
                    "start a tailnet worker first. Nothing started.")
        with open(RPC_PATH, "w") as f:
            f.write(st["rpc_list"] + "\n")
        with open(SPLIT_PATH, "w") as f:
            f.write(st["split"] + "\n")
        sh(["systemctl", "start", "ai-pool-host"], timeout=30)
        return ("Starting the split pool across " + st["rpc_list"] +
                " + this card, tensor split " + st["split"] +
                " — loading takes a few minutes.")
    if name == "stop":
        sh(["systemctl", "stop", "ai-pool-solo", "ai-pool-host"], timeout=60)
        return "Brain stopped. Burn's AI is paused until a brain starts again."
    if name == "set_model":
        model = (fields.get("model") or [""])[0]
        files = {m["file"] for m in catalog()}
        if model not in files:
            return "That model is not on disk — nothing changed."
        with open(CURRENT_MODEL_PATH, "w") as f:
            f.write(model + "\n")
        st = pool_state()
        if st["units"]["ai-pool-solo"] == "active":
            sh(["systemctl", "restart", "ai-pool-solo"], timeout=30)
            return "Model set to " + model + " — the solo brain is restarting with it (a few minutes)."
        if st["units"]["ai-pool-host"] == "active":
            st2 = pool_state()
            with open(RPC_PATH, "w") as f:
                f.write(st2["rpc_list"] + "\n")
            with open(SPLIT_PATH, "w") as f:
                f.write(st2["split"] + "\n")
            sh(["systemctl", "restart", "ai-pool-host"], timeout=30)
            return "Model set to " + model + " — the split pool is restarting with it (a few minutes)."
        return "Model set to " + model + " — it will load at the next start."
    if name == "delete_model":
        model = (fields.get("model") or [""])[0]
        if (fields.get("confirm") or [""])[0] != model:
            return "Delete wasn't confirmed — nothing deleted."
        why = delete_refusal(model)
        if why:
            return why
        path = os.path.join(POOL_DIR, model)
        size_gb = os.path.getsize(path) / 1073741824
        os.remove(path)
        return ("Deleted " + model + " — freed " + ("%.1f" % size_gb) +
                " GB. Download it again any time with get-model.sh.")
    if name == "set_host_ram":
        try:
            offered = int((fields.get("offered_mb") or ["0"])[0])
        except ValueError:
            return "Offered memory must be a number of MB."
        cfg["machines"] = [m for m in cfg["machines"]
                           if m.get("role") != "host-ram"]
        if offered <= 0:
            save_config(cfg)
            return ("The FX705's RAM is out of the split. It takes effect "
                    "at the next Start split.")
        mem = mem_info()
        if mem["total_mb"] and offered > mem["total_mb"] - 3072:
            return ("That leaves this laptop under 3 GB for everything "
                    "else — offer at most " +
                    str(max(0, mem["total_mb"] - 3072)) + " MB.")
        cfg["machines"].append({"name": HOST_RAM_NAME, "ip": HOST_RAM_IP,
                                "role": "host-ram", "offered_mb": offered})
        save_config(cfg)
        note = ("" if worker_up(HOST_RAM_IP, HOST_RAM_PORT) else
                " Its RAM worker isn't answering yet — run "
                "'sudo systemctl enable --now ai-pool-hostram' first.")
        return ("The FX705 now offers " + str(offered) + " MB of RAM to "
                "the split (next Start split)." + note)
    if name == "set_offered":
        target = (fields.get("machine") or [""])[0]
        try:
            offered = int((fields.get("offered_mb") or ["0"])[0])
        except ValueError:
            return "Offered memory must be a number of MB."
        for m in cfg["machines"]:
            if m.get("name") == target:
                m["offered_mb"] = offered
                save_config(cfg)
                return target + " now offers " + str(offered) + " MB."
        return "No machine by that name."
    if name in ("approve_enrollment", "revoke_enrollment"):
        eid = (fields.get("id") or [""])[0]
        data = load_enrollments()
        for rec in data["enrollments"]:
            if rec.get("id") == eid:
                rec["status"] = "approved" if name == "approve_enrollment" else "revoked"
                rec["decided"] = now_central().isoformat(timespec="seconds")
                save_enrollments(data)
                return ("Enrollment approved: " + rec.get("name", "?") +
                        " — it can join once the worker relay (M5b) is live."
                        if rec["status"] == "approved" else
                        "Enrollment revoked: " + rec.get("name", "?") + ".")
        return "No enrollment with that id."
    if name == "remove_enrollment":
        eid = (fields.get("id") or [""])[0]
        data = load_enrollments()
        for rec in data["enrollments"]:
            if rec.get("id") == eid:
                if rec.get("status") != "revoked":
                    return "Only a revoked enrollment can be removed — revoke it first."
                data["enrollments"] = [r for r in data["enrollments"]
                                       if r.get("id") != eid]
                save_enrollments(data)
                return "Enrollment removed: " + rec.get("name", "?") + "."
        return "No enrollment with that id."
    if name == "join":
        mname = (fields.get("name") or [""])[0].strip()
        ip = (fields.get("ip") or [""])[0].strip()
        try:
            offered = int((fields.get("offered_mb") or ["0"])[0])
        except ValueError:
            return "Offered memory must be a number of MB."
        if not mname or not ip.startswith("100."):
            return "Join needs a name and a tailnet (100.x) address."
        if not worker_up(ip):
            return ip + " is not answering on the worker port (50052) — start its worker first, then join."
        cfg["machines"] = [m for m in cfg["machines"] if m.get("name") != mname]
        cfg["machines"].append({"name": mname, "ip": ip, "role": "worker", "offered_mb": offered})
        save_config(cfg)
        return mname + " joined the pool offering " + str(offered) + " MB."
    if name in ("approve_account", "revoke_account"):
        aid = (fields.get("id") or [""])[0]
        data = load_accounts()
        for rec in data["accounts"]:
            if rec.get("id") == aid:
                rec["status"] = "approved" if name == "approve_account" else "revoked"
                rec["decided"] = now_central().isoformat(timespec="seconds")
                save_accounts(data)
                if name == "approve_account" and not starter_credited(aid):
                    starter = float(load_shares_cfg()["starter"])
                    append_ledger(aid, "starter", starter, "starter balance")
                    return ("Account approved: " + rec.get("name", "?") +
                            " — starter balance of " + str(starter) + " shares credited.")
                return ("Account " + rec["status"] + ": " + rec.get("name", "?") + ".")
        return "No account with that id."
    if name == "remove_account":
        aid = (fields.get("id") or [""])[0]
        data = load_accounts()
        for rec in data["accounts"]:
            if rec.get("id") == aid:
                if rec.get("status") != "revoked":
                    return "Only a revoked account can be removed — revoke it first."
                data["accounts"] = [r for r in data["accounts"]
                                    if r.get("id") != aid]
                save_accounts(data)
                return ("Account removed: " + rec.get("name", "?") +
                        ". Its ledger lines stay in the append-only log.")
        return "No account with that id."
    if name == "gift":
        aid = (fields.get("id") or [""])[0]
        try:
            amount = float((fields.get("amount") or ["0"])[0])
        except ValueError:
            return "Gift amount must be a number."
        if amount <= 0:
            return "Gift amount must be positive."
        for rec in load_accounts()["accounts"]:
            if rec.get("id") == aid:
                append_ledger(aid, "gift", amount, "operator gift")
                return "Gifted " + str(amount) + " shares to " + rec.get("name", "?") + "."
        return "No account with that id."
    if name == "set_shares":
        scfg = load_shares_cfg()
        for k in ("starter", "earn_per_gb_hour", "worked_multiplier", "spend_per_1k_tokens"):
            raw = (fields.get(k) or [""])[0]
            if raw != "":
                try:
                    scfg[k] = float(raw)
                except ValueError:
                    return k + " must be a number."
        for k in ("max_output_tokens", "max_context_chars", "public_max_inflight"):
            raw = (fields.get(k) or [""])[0]
            if raw != "":
                try:
                    scfg[k] = int(raw)
                except ValueError:
                    return k + " must be a whole number."
        scfg["public_paused"] = (fields.get("public_paused") or [""])[0] == "on"
        save_shares_cfg(scfg)
        return ("Shares settings saved." +
                (" Public usage is PAUSED." if scfg["public_paused"] else ""))
    if name == "add_mcp_server":
        sname = (fields.get("name") or [""])[0].strip()
        surl = (fields.get("url") or [""])[0].strip()
        skey = (fields.get("key") or [""])[0].strip()
        if not sname or not all(c.isalnum() or c in "-_" for c in sname):
            return "MCP server name must be letters, numbers, - or _ (it prefixes the tool names)."
        if not (surl.startswith("http://") or surl.startswith("https://")):
            return "MCP server URL must start with http:// or https://."
        servers = [s for s in load_mcp_servers() if s.get("name") != sname]
        servers.append({"name": sname, "url": surl, "key": skey, "enabled": True})
        save_mcp_servers(servers)
        return ("MCP server registered: " + sname + " — when a chat opts in "
                "(mcp_tools), its tools are offered to the pooled model as " +
                sname + "__<tool>.")
    if name == "remove_mcp_server":
        sname = (fields.get("name") or [""])[0].strip()
        servers = load_mcp_servers()
        keep = [s for s in servers if s.get("name") != sname]
        if len(keep) == len(servers):
            return "No MCP server by that name."
        save_mcp_servers(keep)
        return "MCP server removed: " + sname + "."
    if name == "toggle_mcp_server":
        sname = (fields.get("name") or [""])[0].strip()
        servers = load_mcp_servers()
        for s in servers:
            if s.get("name") == sname:
                s["enabled"] = not s.get("enabled", True)
                save_mcp_servers(servers)
                return ("MCP server " + sname + " is now " +
                        ("enabled." if s["enabled"] else "disabled."))
        return "No MCP server by that name."
    return "Unknown action."


# ---------------- page ----------------

CSS = """
:root{--bg:#15100c;--bg2:#1e1611;--card:#241a13;--line:#3a2a1d;--text:#f1e6d6;
--muted:#b9a68f;--gold:#e0a84a;--gold2:#f5c873;--ember:#c9572b;--green:#7fb069;--red:#d1603d}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.55}
main{max-width:880px;margin:0 auto;padding:2rem 1.25rem 3.5rem}
h1{font-family:Georgia,serif;font-size:2rem;color:var(--gold2)}
h2{font-family:Georgia,serif;font-size:1.25rem;color:var(--gold);margin:1.8rem 0 .6rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.2rem;margin:.8rem 0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.dot{display:inline-block;width:.6em;height:.6em;border-radius:50%;background:var(--green);margin-right:.4em}
.dot.off{background:var(--red)} .dot.idle{background:var(--muted)}
button{background:var(--ember);color:#fff;border:0;border-radius:8px;padding:.5rem .95rem;font-weight:600;cursor:pointer}
button.alt{background:var(--bg2);color:var(--text);border:1px solid var(--line)}
button:disabled{opacity:.45;cursor:default}
input{background:var(--bg2);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:.45rem .6rem}
.fine{font-size:.87rem;color:var(--muted)} .ok{color:var(--green)} .no{color:var(--red)}
.msg{background:#2c3a1e;border:1px solid var(--green);border-radius:10px;padding:.7rem 1rem;margin:.8rem 0}
code{background:var(--bg2);padding:.1rem .35rem;border-radius:5px;word-break:break-all}
.tbl{overflow-x:auto}
form.inline{display:inline} .row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
"""


def delete_confirm_html(st, model):
    """The confirm step for deleting a model: its own card at the top
    of the page, with the file named in full and its size."""
    md = next((m for m in st["models"] if m["file"] == model), None)
    if not md:
        return '<div class="msg">' + escape(model) + " is not on disk — nothing to delete.</div>"
    why = delete_refusal(model)
    if why:
        return '<div class="msg">' + escape(why) + "</div>"
    return ('<div class="card" style="border:2px solid #c0392b">'
            '<p><strong>Delete this model from the FX705?</strong></p>'
            '<p><code>' + escape(model) + '</code> · ' + ("%.1f" % (md["size_mb"] / 1024)) + ' GB</p>'
            '<p class="fine">This removes the file for good. To use it again you would '
            'download it again with get-model.sh.</p>'
            '<div class="row" style="margin-top:.6rem">'
            '<form method="post" action="/action">'
            '<input type="hidden" name="action" value="delete_model">'
            '<input type="hidden" name="model" value="' + escape(model) + '">'
            '<input type="hidden" name="confirm" value="' + escape(model) + '">'
            '<button type="submit" style="background:#c0392b;border-color:#c0392b">Yes, delete it</button></form>'
            '<form method="get" action="/"><button class="alt" type="submit">Cancel</button></form>'
            '</div></div>')


def page(st, msg="", ask_delete=""):
    def dot(up, idle=False):
        cls = "dot" if up else ("dot idle" if idle else "dot off")
        return '<span class="' + cls + '"></span>'

    def state_cell(m):
        s = m.get("state") or ("up" if m.get("up") else "down")
        if s == "busy":
            return dot(False, idle=True) + "busy"
        return dot(s == "up") + s

    rows = ""
    for m in st["machines"]:
        offered = "detected live" if m.get("role") == "coordinator" else (
            str(m.get("offered_mb") or 0) + " MB "
            '<form class="inline" method="post" action="/action">'
            '<input type="hidden" name="action" value="set_host_ram">'
            '<input name="offered_mb" size="6" placeholder="MB">'
            '<button class="alt" type="submit">Set</button></form>'
            if m.get("role") == "host-ram" else (
            str(m.get("offered_mb") or 0) + " MB (enrollment)" if m.get("relayed") else (
            str(m.get("offered_mb") or 0) + " MB "
            '<form class="inline" method="post" action="/action">'
            '<input type="hidden" name="action" value="set_offered">'
            '<input type="hidden" name="machine" value="' + escape(str(m.get("name", ""))) + '">'
            '<input name="offered_mb" size="6" placeholder="MB">'
            '<button class="alt" type="submit">Set</button></form>')))
        rows += ("<tr><td><strong>" + escape(str(m.get("name", ""))) + "</strong></td>"
                 "<td>" + escape(str(m.get("role", ""))) + " · " + escape(str(m.get("ip", ""))) + "</td>"
                 "<td>" + offered + "</td>"
                 "<td>" + escape(str(m.get("holds", ""))) + "</td>"
                 "<td>" + state_cell(m) + "</td></tr>")

    mrows = ""
    for md in st["models"]:
        fit = []
        fit.append('<span class="' + ("ok" if md["fits_solo"] else "no") + '">solo ' +
                   ("fits" if md["fits_solo"] else "too big") + "</span>")
        fit.append('<span class="' + ("ok" if md["fits_split"] else "no") + '">split ' +
                   ("fits" if md["fits_split"] else "too big") + "</span>")
        btn = ""
        if not md["current"]:
            btn = ('<form class="inline" method="post" action="/action">'
                   '<input type="hidden" name="action" value="set_model">'
                   '<input type="hidden" name="model" value="' + escape(md["file"]) + '">'
                   '<button class="alt" type="submit">Use this model</button></form> '
                   '<form class="inline" method="get" action="/">'
                   '<input type="hidden" name="delete" value="' + escape(md["file"]) + '">'
                   '<button class="alt" type="submit">Delete…</button></form>')
        mrows += ("<tr><td>" + escape(md["file"]) + (" <strong>(current)</strong>" if md["current"] else "") +
                  "</td><td>" + str(md["size_mb"]) + " MB</td><td>" + " · ".join(fit) +
                  "</td><td>" + btn + "</td></tr>")

    erows = ""
    for rec in load_enrollments()["enrollments"]:
        btns = ""
        if rec.get("status") in ("pending", "revoked"):
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="approve_enrollment">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<button type="submit">Approve</button></form> ')
        if rec.get("status") in ("pending", "approved"):
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="revoke_enrollment">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<button class="alt" type="submit">Revoke</button></form>')
        if rec.get("status") == "revoked":
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="remove_enrollment">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<button class="alt" type="submit">Remove</button></form>')
        erows += ("<tr><td><strong>" + escape(str(rec.get("name", "?"))) + "</strong></td>"
                  "<td>" + str(rec.get("offered_mb", 0)) + " MB</td>"
                  "<td>" + escape(str(rec.get("gpu", ""))) + " · " + escape(str(rec.get("os", ""))) + "</td>"
                  "<td>" + escape(str(rec.get("status", "?"))) + "</td><td>" + btns + "</td></tr>")
    enroll_html = ('<div class="tbl"><table><tr><th>Machine</th><th>Offered</th><th>Hardware</th>'
                   '<th>Status</th><th></th></tr>' + erows + "</table></div>") if erows else \
        "<p>No enrollments yet.</p>"
    bals = ledger_balances()
    acct_rows = ""
    for rec in load_accounts()["accounts"]:
        btns = ""
        if rec.get("status") in ("pending", "revoked"):
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="approve_account">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<button type="submit">Approve</button></form> ')
        if rec.get("status") in ("pending", "approved"):
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="revoke_account">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<button class="alt" type="submit">Revoke</button></form> ')
        if rec.get("status") == "revoked":
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="remove_account">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<button class="alt" type="submit">Remove</button></form>')
        if rec.get("status") == "approved":
            btns += ('<form class="inline" method="post" action="/action">'
                     '<input type="hidden" name="action" value="gift">'
                     '<input type="hidden" name="id" value="' + escape(str(rec.get("id", ""))) + '">'
                     '<input name="amount" size="5" placeholder="shares">'
                     '<button class="alt" type="submit">Gift</button></form>')
        acct_rows += ("<tr><td><strong>" + escape(str(rec.get("name", "?"))) + "</strong></td>"
                      "<td>…" + escape(str(rec.get("key_hint", ""))) + "</td>"
                      "<td>" + escape(str(rec.get("status", "?"))) + "</td>"
                      "<td>" + str(bals.get(rec.get("id"), 0.0)) + "</td><td>" + btns + "</td></tr>")
    accounts_html = ('<div class="tbl"><table><tr><th>Account</th><th>Key</th><th>Status</th>'
                     '<th>Balance</th><th></th></tr>' + acct_rows + "</table></div>") if acct_rows else \
        "<p>No accounts yet.</p>"
    scfg = load_shares_cfg()
    shares_html = ('<form method="post" action="/action">'
                   '<input type="hidden" name="action" value="set_shares">'
                   '<div class="tbl"><table>'
                   '<tr><td>Starter balance (shares)</td><td><input name="starter" size="8" value="' + str(scfg["starter"]) + '"></td></tr>'
                   '<tr><td>Earn per GB-hour online</td><td><input name="earn_per_gb_hour" size="8" value="' + str(scfg["earn_per_gb_hour"]) + '"></td></tr>'
                   '<tr><td>Worked multiplier (carrying a slice)</td><td><input name="worked_multiplier" size="8" value="' + str(scfg["worked_multiplier"]) + '"></td></tr>'
                   '<tr><td>Spend per 1,000 tokens generated</td><td><input name="spend_per_1k_tokens" size="8" value="' + str(scfg["spend_per_1k_tokens"]) + '"></td></tr>'
                   '<tr><td>Max output tokens per request</td><td><input name="max_output_tokens" size="8" value="' + str(scfg["max_output_tokens"]) + '"></td></tr>'
                   '<tr><td>Max conversation chars per request</td><td><input name="max_context_chars" size="8" value="' + str(scfg["max_context_chars"]) + '"></td></tr>'
                   '<tr><td>Public generations at once (queue)</td><td><input name="public_max_inflight" size="8" value="' + str(scfg["public_max_inflight"]) + '"></td></tr>'
                   '<tr><td>Pause public usage</td><td><input type="checkbox" name="public_paused"' + (" checked" if scfg["public_paused"] else "") + '></td></tr>'
                   '</table></div>'
                   '<button type="submit" style="margin-top:.6rem">Save shares settings</button></form>')
    mcp_rows = ""
    for s in load_mcp_servers():
        btns = ('<form class="inline" method="post" action="/action">'
                '<input type="hidden" name="action" value="toggle_mcp_server">'
                '<input type="hidden" name="name" value="' + escape(str(s.get("name", ""))) + '">'
                '<button class="alt" type="submit">' + ("Disable" if s.get("enabled", True) else "Enable") + '</button></form> '
                '<form class="inline" method="post" action="/action">'
                '<input type="hidden" name="action" value="remove_mcp_server">'
                '<input type="hidden" name="name" value="' + escape(str(s.get("name", ""))) + '">'
                '<button class="alt" type="submit">Remove</button></form>')
        mcp_rows += ("<tr><td><strong>" + escape(str(s.get("name", "?"))) + "</strong></td>"
                     "<td>" + escape(str(s.get("url", ""))) + "</td>"
                     "<td>" + ("enabled" if s.get("enabled", True) else "disabled") + "</td>"
                     "<td>" + ("key set" if s.get("key") else "—") + "</td><td>" + btns + "</td></tr>")
    mcp_html = ('<div class="tbl"><table><tr><th>Server</th><th>URL</th><th>State</th>'
                '<th>Key</th><th></th></tr>' + mcp_rows + "</table></div>") if mcp_rows else \
        "<p>No MCP servers registered.</p>"
    mcp_add_html = ('<form method="post" action="/action" style="margin-top:.8rem">'
                    '<input type="hidden" name="action" value="add_mcp_server">'
                    '<div class="row">'
                    '<input name="name" placeholder="Name" size="12">'
                    '<input name="url" placeholder="https://…/mcp" size="30">'
                    '<input name="key" placeholder="Bearer key (optional)" size="16">'
                    '<button class="alt" type="submit">Register server</button>'
                    '</div></form>')
    mode_txt = {"solo": "Solo — FX705 alone", "split": "Split — pooled across machines",
                "starting": "Starting…", "off": "Off"}[st["mode"]]
    brain_line = dot(st["brain"]["up"]) + mode_txt
    if st["brain"]["model"]:
        brain_line += " · " + escape(st["brain"]["model"])
    gpu_txt = ""
    if st["gpu"]:
        gpu_txt = ("GPU " + str(st["gpu"]["used_mb"]) + " / " + str(st["gpu"]["total_mb"]) +
                   " MB · RAM available " + str(st["mem"]["available_mb"]) + " MB · ")
    msg_html = '<div class="msg">' + escape(msg) + "</div>" if msg else ""
    if ask_delete:
        msg_html += delete_confirm_html(st, ask_delete)
    has_host_ram = any(m.get("role") == "host-ram" for m in st["machines"])
    host_ram_html = "" if has_host_ram else (
        '<form method="post" action="/action" style="margin-top:.8rem">'
        '<input type="hidden" name="action" value="set_host_ram">'
        '<div class="row"><input name="offered_mb" placeholder="MB of FX705 RAM" size="14">'
        '<button class="alt" type="submit">Add the FX705\'s RAM to the split</button></div>'
        '<p class="fine">Needs ai-pool-hostram running. Loopback, so it adds memory '
        'without adding network time — the way a ~19 GB model fits.</p></form>')
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Pool — control</title><style>{CSS}</style></head>
<body><main>
<h1>The AI Pool — control</h1>
<p class="fine">Tailnet only. Status as of {escape(st["updated"])} — reload for fresh numbers.</p>
{msg_html}
<div class="card">
  <p><strong>Brain:</strong> {brain_line}</p>
  <p class="fine">{gpu_txt}Pool total offered: {st["pool_total_mb"]} MB ·
  solo can hold {st["solo_capacity_mb"]} MB (keeping a 1 GB context reserve) · split can hold {st["split_capacity_mb"]} MB</p>
  <div class="row" style="margin-top:.6rem">
    <form method="post" action="/action"><input type="hidden" name="action" value="start_solo">
      <button type="submit">Start solo</button></form>
    <form method="post" action="/action"><input type="hidden" name="action" value="start_split">
      <button type="submit">Start split (tensor {escape(st["split"])})</button></form>
    <form method="post" action="/action"><input type="hidden" name="action" value="stop">
      <button class="alt" type="submit">Stop brain</button></form>
  </div>
  <p class="fine" style="margin-top:.5rem">Starting one mode stops the other. While the brain is
  off or loading, Burn's AI is paused. Split needs the Yoga's worker running.</p>
</div>

<h2>Roster</h2>
<div class="card"><div class="tbl"><table>
<tr><th>Machine</th><th>Role · address</th><th>Offered</th><th>Holds</th><th>State</th></tr>
{rows}
</table></div>
<form method="post" action="/action" style="margin-top:.8rem">
  <input type="hidden" name="action" value="join">
  <div class="row">
    <input name="name" placeholder="Name" size="12">
    <input name="ip" placeholder="100.x.y.z" size="14">
    <input name="offered_mb" placeholder="MB offered" size="10">
    <button class="alt" type="submit">Join a PC</button>
  </div>
  <p class="fine">Joining verifies the PC answers on the worker port (50052) before adding it.</p>
</form>
{host_ram_html}
</div>

<h2>Models on the host</h2>
<div class="card"><div class="tbl"><table>
<tr><th>Model</th><th>Size</th><th>Fit check</th><th></th></tr>
{mrows}
</table></div>
<p class="fine">Disk free in {escape(POOL_DIR)}: {"%.1f" % (disk_free_mb() / 1024)} GB.</p>
<p class="fine">“Use this model” writes the picker's choice for the next start — and restarts the
brain with it if one is running (expect a few minutes of loading). “Delete…” asks once more,
then removes the file; the current model and any file in use can't be deleted.</p>
</div>

<h2>Enrollments (public)</h2>
<div class="card">
{enroll_html}
<p class="fine">Machines register at pool.tavernworks.dev/enroll and wait here.
Approving says the machine MAY join — it can only hold model slices once the
worker relay (M5b) is live. Revoking cuts it off.</p>
</div>

<h2>Accounts (public)</h2>
<div class="card">
{accounts_html}
<p class="fine">Accounts register at pool.tavernworks.dev/register; the key is
shown once and only its hash is kept. Approving credits the starter balance
from the shares settings below. Revoking blocks the key at every public
door. Balances fold from the append-only ledger.</p>
</div>

<h2>Shares</h2>
<div class="card">
{shares_html}
<p class="fine">Earn: a linked machine accrues offered-GB x hours x the base
rate, times the worked multiplier while its slice is in the live split.
Spend: charged per token generated, after a successful reply. Pausing
public usage closes the chat/API doors; your bots keep their direct lane.</p>
</div>

<h2>MCP servers (tools for the model)</h2>
<div class="card">
{mcp_html}
{mcp_add_html}
<p class="fine">Registered servers are offered to the pooled model when a
chat opts in (the chat page's tools checkbox, or "mcp_tools": true on the
API door). Their tools appear as name__tool. Register only servers you
trust — tool results are fed back into the model's context. Keys are
kept in mcp-servers.json on this machine only. The pool's own MCP door
for clients is https://pool.tavernworks.dev/mcp (account key as Bearer).</p>
</div>

<h2>Endpoint card</h2>
<div class="card">
  <p>Bots and tools talk to the brain here:</p>
  <p><code>{escape(st["endpoint"])}</code> · model <code>{escape(st["current_model"])}</code></p>
  <p class="fine">Burn (Yoga, /etc/tavernworks/undercoverburn.env):<br>
  <code>OPENAI_BASE_URL={escape(st["endpoint"])}</code><br>
  <code>OPENAI_MODEL={escape(st["current_model"])}</code></p>
</div>

<p class="fine" style="margin-top:2rem">AI Pool coordinator · part of Tavernworks · this page never leaves the tailnet.</p>
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

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/status.json":
            self._send(200, json.dumps(status_json(), indent=1), "application/json")
        elif path == "/api/state":
            self._send(200, json.dumps(pool_state(), indent=1), "application/json")
        elif path == "/health":
            self._send(200, json.dumps({"status": "ok"}), "application/json")
        elif path == "/":
            q = parse_qs(urlparse(self.path).query)
            self._send(200, page(pool_state(), (q.get("msg") or [""])[0],
                                 (q.get("delete") or [""])[0]))
        else:
            self._send(404, "Not here")

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/action":
            self._send(404, "Not here")
            return
        length = int(self.headers.get("Content-Length") or 0)
        fields = parse_qs(self.rfile.read(length).decode())
        name = (fields.get("action") or [""])[0]
        try:
            msg = act(name, fields)
        except Exception as e:
            msg = "Action failed: " + str(e)
        self.send_response(303)
        self.send_header("Location", "/?msg=" + quote(msg))
        self.end_headers()


def main():
    bind = os.environ.get("POOL_BIND") or own_tailnet_ip() or "127.0.0.1"
    srv = ThreadingHTTPServer((bind, PORT), Handler)
    print("AI Pool coordinator on http://" + bind + ":" + str(PORT) + " (pool dir " + POOL_DIR + ")", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
