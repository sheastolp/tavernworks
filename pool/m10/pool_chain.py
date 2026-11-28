#!/usr/bin/env python3
"""AI Pool M10 — chain mode's cost-aware planner (Nov 28).

Chain mode is the pooled model laid out by cost instead of by offered
memory. The split (M3) gives every live machine a share in proportion
to the memory it offers, so a phone that takes 400 ms per exchange
holds as many layers as a laptop. Here each machine's cost comes from
SwarmBench's own timings (pool_meter's replies table):

    ms per layer = (time spent waiting on that machine per exchange
                    - the network round trip) / layers it held

and the plan then
  1. always uses the FX705's own card and RAM (no network at all),
  2. adds the cheapest other machines only until the model fits,
     dropping the rest (a slow machine costs every token its round
     trip, however few layers it holds),
  3. gives each chosen machine at least one layer and every other
     layer to whichever machine is cheapest per layer, up to what it
     can hold,
  4. keeps the split's safety rule: the first RPC device (which gets
     the prompt's embeddings) is one of the operator's own machines.

It writes ~/ai-pool/pool-chain-{rpc,split,draft}.txt and
pool-chain-plan.json, which fx705-chain.sh reads. Estimates are
labelled as estimates; SwarmBench measures the real thing.

Stdlib only. Imported by pool-coordinator.py (M3) when present.
"""

import json
import os
import sqlite3
import time

HOME = os.environ.get("HOME") or "/root"
POOL_DIR = os.environ.get("POOL_DIR", os.path.join(HOME, "ai-pool"))
CHAIN_RPC_PATH = os.path.join(POOL_DIR, "pool-chain-rpc.txt")
CHAIN_SPLIT_PATH = os.path.join(POOL_DIR, "pool-chain-split.txt")
CHAIN_DRAFT_PATH = os.path.join(POOL_DIR, "pool-chain-draft.txt")
CHAIN_PLAN_PATH = os.path.join(POOL_DIR, "pool-chain-plan.json")
SPLIT_DRAFT_PATH = os.path.join(POOL_DIR, "pool-draft.txt")
METER_DB = os.environ.get("POOL_METER_DB", os.path.join(POOL_DIR, "pool-meter.db"))
RELAY_STATS_PATH = os.path.join(POOL_DIR, "relay-stats.json")
RELAY_STATE_PATH = os.path.join(POOL_DIR, "relay-state.json")

DEFAULT_DRAFT = "Qwen3.5-0.8B-Q4_K_M.gguf"
CTX = int(os.environ.get("POOL_CHAIN_CTX", "8192") or 8192)
MIN_REMOTE = int(os.environ.get("POOL_CHAIN_MIN_REMOTE", "1") or 0)

# Unmeasured costs (ms of compute per layer per token, and network
# ms per exchange). Measured values replace these as soon as the
# meter has seen the machine hold layers.
DEFAULT_MS_PER_LAYER = {"card": 0.6, "hostram": 2.0, "tailnet": 4.0, "relay": 6.0}
DEFAULT_NET_MS = {"card": 0.0, "hostram": 0.5, "tailnet": 8.0, "relay": 150.0, "relay-lan": 10.0}
MARGIN = 1.06        # headroom on each machine's memory


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def kind_of(dev):
    src = dev.get("source")
    if src == "host":
        return "hostram"
    return src if src in ("tailnet", "relay") else "tailnet"


# ---------------- measured costs ----------------

def measured_costs(db_path=METER_DB, limit=300):
    """{device name: {"ms_per_layer", "net_ms", "samples"}} from the
    meter's recent split/chain replies. Uses the hops (relayed
    workers' own timings), so a machine's compute and the network in
    between are told apart."""
    out = {}
    if not os.path.isfile(db_path):
        return out
    try:
        con = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True, timeout=5)
        rows = con.execute(
            "SELECT devices_json, hops_json FROM replies WHERE mode IN ('split','chain') "
            "AND hops_json IS NOT NULL ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        con.close()
    except Exception:
        return out
    acc = {}
    for dj, hj in rows:
        try:
            devs = json.loads(dj or "[]") or []
            hops = json.loads(hj or "[]") or []
        except ValueError:
            continue
        layers = {d.get("name"): int(d.get("n_layers") or 0) for d in devs}
        for h in hops:
            nm = h.get("name")
            ex = int(h.get("exchanges") or 0)
            nl = layers.get(nm) or 0
            if not nm or ex <= 0 or nl <= 0:
                continue
            a = acc.setdefault(nm, {"lay": [], "net": []})
            if h.get("remote_ms") is not None:
                a["lay"].append(float(h["remote_ms"]) / ex / nl)
            if h.get("rtt_ms") is not None:
                a["net"].append(float(h["rtt_ms"]))
            elif h.get("net_ms") is not None:
                a["net"].append(float(h["net_ms"]) / ex)
    for nm, a in acc.items():
        def med(xs):
            xs = sorted(xs)
            return xs[len(xs) // 2] if xs else None
        out[nm] = {"ms_per_layer": med(a["lay"]), "net_ms": med(a["net"]),
                   "samples": max(len(a["lay"]), len(a["net"]))}
    return out


def live_relay_info():
    """{name: {"route", "rtt_ms"}} for the relayed workers right now."""
    out = {}
    state = read_json(RELAY_STATE_PATH, {}) or {}
    for m in state.get("machines") or []:
        out.setdefault(m.get("name"), {})["route"] = m.get("route") or "cloudflare"
    stats = read_json(RELAY_STATS_PATH, {}) or {}
    workers = stats.get("workers") if isinstance(stats, dict) else None
    if isinstance(workers, dict):
        workers = list(workers.values())
    for w in workers or []:
        if isinstance(w, dict) and w.get("name"):
            out.setdefault(w["name"], {})["rtt_ms"] = w.get("rtt_avg")
    return out


# ---------------- draft ----------------

def chain_draft():
    """What chain mode batch-checks with: the split's draft choice if
    it names one, else the 0.8B Qwen3.5 draft when it is on disk.
    Returns {"line", "mode", "file", "card_mb"} (line "off" = none)."""
    line = ""
    try:
        with open(SPLIT_DRAFT_PATH) as f:
            line = (f.readline() or "").strip()
    except OSError:
        pass
    if line.lower() == "mtp":
        return {"line": "mtp", "mode": "mtp", "file": "", "card_mb": 256}
    cands = [line] if line.endswith(".gguf") else []
    cands.append(DEFAULT_DRAFT)
    for c in cands:
        p = os.path.join(POOL_DIR, c)
        if os.path.isfile(p):
            return {"line": c, "mode": "model", "file": c,
                    "card_mb": os.path.getsize(p) // (1024 * 1024) + 512}
    return {"line": "off", "mode": "off", "file": "", "card_mb": 0}


# ---------------- the plan ----------------

def plan(devices, layout, card_cap_mb, measured=None, relay_info=None,
         ctx=CTX, min_remote=MIN_REMOTE, draft=None):
    """devices: the coordinator's live RPC devices
         [{name, endpoint, offered_mb, source: tailnet|relay|host}]
       layout: pool_meter.model_layout() of the current model
       card_cap_mb: what the card may hold for the main model's layers
    Returns a plan dict; plan["ok"] False with plan["why"] when no
    layout fits."""
    measured = measured or {}
    relay_info = relay_info or {}
    n = layout["n_layer_all"]
    layer_mb = list(layout["layer_mb"])
    kv_tok = list(layout.get("kv_per_tok") or [0] * n)
    mib = 1024.0 * 1024.0
    per_layer = [(layer_mb[i] + kv_tok[i] * ctx / mib) * MARGIN for i in range(n)]
    avg_layer = sum(per_layer) / n
    output_mb = layout.get("output_mb", 0.0) * MARGIN

    cands = []
    for d in devices:
        k = kind_of(d)
        m = measured.get(d["name"]) or {}
        ri = relay_info.get(d["name"]) or {}
        lan = k == "relay" and ri.get("route") == "lan"
        ms_l = m.get("ms_per_layer")
        lay_measured = ms_l is not None
        if ms_l is None:
            ms_l = DEFAULT_MS_PER_LAYER[k]
        if lan:
            # On the local route the measured Cloudflare round trip no
            # longer applies: use the live one, else the LAN default.
            net = ri.get("rtt_ms") or DEFAULT_NET_MS["relay-lan"]
        else:
            net = m.get("net_ms")
            if net is None:
                net = ri.get("rtt_ms") if k == "relay" else None
            if net is None:
                net = DEFAULT_NET_MS[k]
        cands.append({"name": d["name"], "endpoint": d["endpoint"], "kind": k,
                      "cap_mb": float(d.get("offered_mb") or 0),
                      "ms_per_layer": round(float(ms_l), 2), "net_ms": round(float(net), 1),
                      "measured": lay_measured, "route": ("lan" if lan else
                                                     ("cloudflare" if k == "relay" else "")),
                      "layers": 0})
    card = {"name": "FX705 card", "endpoint": "CUDA0", "kind": "card",
            "cap_mb": float(card_cap_mb), "ms_per_layer": DEFAULT_MS_PER_LAYER["card"],
            "net_ms": 0.0, "measured": False, "route": "", "layers": 0}

    host = [c for c in cands if c["kind"] == "hostram"]
    remotes = [c for c in cands if c["kind"] != "hostram" and c["cap_mb"] > 0]
    # A remote's cost to the plan: its round trip (paid every pass, no
    # matter how few layers) plus its per-layer compute on an average
    # layer's worth of work.
    remotes.sort(key=lambda c: (c["net_ms"] + c["ms_per_layer"] * 4, c["ms_per_layer"]))

    need = sum(per_layer) + output_mb
    chosen = host[:]
    cap = card["cap_mb"] + sum(c["cap_mb"] for c in chosen)
    picked_remotes = []
    for c in remotes:
        if cap >= need and len(picked_remotes) >= min_remote:
            break
        picked_remotes.append(c)
        cap += c["cap_mb"]
    solo_fits = (card["cap_mb"] + sum(c["cap_mb"] for c in host)) >= need
    if cap < need:
        return {"ok": False, "why": "the live machines offer %.0f MB; the model needs about %.0f MB "
                                    "at context %d" % (cap, need, ctx),
                "need_mb": round(need), "cap_mb": round(cap)}

    # Order: operator's tailnet machines, then relayed workers, then
    # the FX705's RAM, then the card (always last).
    tail = [c for c in picked_remotes if c["kind"] == "tailnet"]
    rel = [c for c in picked_remotes if c["kind"] == "relay"]
    if tail:
        order = tail + rel + host
    elif host:
        order = host + rel
    else:
        return {"ok": False, "why": "no safe first machine: the first layers must sit on one of "
                                    "your own machines (a tailnet worker or the FX705's RAM)"}
    order.append(card)

    # Layer counts. Card's memory also holds the output layer.
    caps_layers = []
    for c in order:
        room = c["cap_mb"] - (output_mb if c is card else 0)
        caps_layers.append(max(0, int(room // avg_layer)))
    counts = [0] * len(order)
    left = n
    for i, c in enumerate(order):
        if c["kind"] in ("tailnet", "relay") and caps_layers[i] > 0 and left > 0:
            counts[i] = 1
            left -= 1
    by_cost = sorted(range(len(order)), key=lambda i: order[i]["ms_per_layer"])
    for i in by_cost:
        if left <= 0:
            break
        take = min(caps_layers[i] - counts[i], left)
        if take > 0:
            counts[i] += take
            left -= take
    if left > 0:
        return {"ok": False, "why": "the chosen machines can't hold every layer (%d left over)" % left}
    # Drop remotes that ended up with nothing (not needed after all).
    keep = [i for i in range(len(order)) if counts[i] > 0 or order[i] is card]
    order = [order[i] for i in keep]
    counts = [counts[i] for i in keep]
    if order[0]["kind"] == "relay":
        return {"ok": False, "why": "no safe first machine for the plan"}

    shares = counts[:-1] + [counts[-1] + 1]   # +1: the output layer, on the card
    first = 0
    rows = []
    t_token = 0.0
    for c, k in zip(order, counts):
        last = first + k - 1
        mb = sum(per_layer[first:last + 1]) + (output_mb if c is card else 0)
        t = c["net_ms"] + k * c["ms_per_layer"]
        t_token += t
        rows.append(dict(c, layers=k,
                         range=(str(first) + "-" + str(last) if k else "none") +
                         (" + output" if c is card else ""),
                         mb=round(mb), est_ms=round(t, 1)))
        first = last + 1
    dropped = [{"name": c["name"], "kind": c["kind"], "net_ms": c["net_ms"],
                "ms_per_layer": c["ms_per_layer"],
                "why": "not needed: the model fits on faster machines"}
               for c in remotes if c not in picked_remotes]
    rpc = [c["endpoint"] for c in order[:-1]]
    draft = draft or {"line": "off", "mode": "off", "card_mb": 0}
    est_tps = 1000.0 / t_token if t_token else None
    est = {"ms_per_pass": round(t_token, 1),
           "tok_s_no_draft": round(est_tps, 2) if est_tps else None}
    if draft.get("mode") != "off" and est_tps:
        # A batch of 8 guesses costs about one pass plus a little per
        # extra token; with ~60% of guesses kept that is ~3 tokens a pass.
        est["tok_s_with_draft"] = round(est_tps * 3.0 / 1.25, 2)
    return {"ok": True, "generated": time.time(), "ctx": ctx,
            "need_mb": round(need), "rpc": rpc, "shares": shares,
            "split": ",".join(str(s) for s in shares),
            "rpc_list": ",".join(rpc), "devices": rows, "dropped": dropped,
            "draft": draft.get("line", "off"), "estimate": est,
            "solo_fits": solo_fits,
            "note": ("Estimates only, from SwarmBench's timings and defaults where a machine "
                     "hasn't been measured yet. Run SwarmBench on chain to measure it." +
                     (" The model also fits on the FX705 alone, so solo will likely stay "
                      "faster than any chain." if solo_fits else ""))}


def write_plan(p):
    """Write the files fx705-chain.sh reads. Only for an ok plan."""
    def put(path, text):
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    put(CHAIN_RPC_PATH, p["rpc_list"] + "\n")
    put(CHAIN_SPLIT_PATH, p["split"] + "\n")
    put(CHAIN_DRAFT_PATH, (p.get("draft") or "off") + "\n")
    put(CHAIN_PLAN_PATH, json.dumps(p, indent=1))


def last_plan():
    return read_json(CHAIN_PLAN_PATH)
