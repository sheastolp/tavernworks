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
#     from the roster's offered memory (pool-split.txt)
#   - serve /status.json in the shape the public pool page reads
#
# Python 3 standard library only — python3 is already on the FX705.
# Test hooks: POOL_DIR, POOL_BIND, POOL_PORT, POOL_BRAIN_URL,
# POOL_MEMINFO override every machine-specific path.
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
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
MEMINFO_PATH = os.environ.get("POOL_MEMINFO", "/proc/meminfo")
PORT = int(os.environ.get("POOL_PORT", "8091"))
DEFAULT_MODEL = "Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf"
MEASURED_SPEED = "3.3 tokens/sec (solo) · 0.9 split"

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


def worker_up(ip):
    try:
        with socket.create_connection((ip, 50052), timeout=2):
            return True
    except Exception:
        return False


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


def current_model():
    try:
        with open(CURRENT_MODEL_PATH) as f:
            name = f.read().strip()
        if name:
            return name
    except Exception:
        pass
    return DEFAULT_MODEL


def compute_split(cfg, fx_share):
    workers = [m for m in cfg["machines"] if m.get("role") == "worker"]
    parts = []
    for w in workers:
        offered = int(w.get("offered_mb") or 0)
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

    machines = []
    total_offered = 0
    for m in cfg["machines"]:
        entry = dict(m)
        if m.get("role") == "coordinator":
            entry["up"] = brain["up"] or solo == "active" or host == "active"
            entry["holds"] = "first layers (an end)"
            total_offered += gpu_total + mem["total_mb"]
        else:
            entry["up"] = worker_up(m.get("ip", ""))
            entry["holds"] = "middle layers" if m.get("name") != "Yoga" else "last layers (an end)"
            total_offered += int(m.get("offered_mb") or 0)
        machines.append(entry)

    solo_capacity = gpu_total + mem["available_mb"] - reserve
    workers_offered = sum(int(m.get("offered_mb") or 0)
                          for m in cfg["machines"] if m.get("role") == "worker")
    split_capacity = fx_share + workers_offered  # M1-proven: the 2,1 load's KV lived inside these shares
    split = compute_split(cfg, fx_share)

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
        "models": models,
        "current_model": cur,
        "endpoint": "http://" + ip + ":8090/v1",
        "page_url": "http://" + ip + ":" + str(PORT) + "/",
        "updated": datetime.now().strftime("%d %b %Y %H:%M"),
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
        "enrollment": "Not yet open — worker app in development",
        "speed": MEASURED_SPEED,
        "updated": datetime.now().strftime("%d %b %Y"),
    }


# ---------------- actions ----------------

def act(name, fields):
    cfg = load_config()
    if name == "start_solo":
        sh(["systemctl", "start", "ai-pool-solo"], timeout=30)
        return "Starting the solo brain — loading takes a few minutes."
    if name == "start_split":
        st = pool_state()
        with open(SPLIT_PATH, "w") as f:
            f.write(st["split"] + "\n")
        sh(["systemctl", "start", "ai-pool-host"], timeout=30)
        return "Starting the split pool with tensor split " + st["split"] + " — loading takes a few minutes."
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
            with open(SPLIT_PATH, "w") as f:
                f.write(st2["split"] + "\n")
            sh(["systemctl", "restart", "ai-pool-host"], timeout=30)
            return "Model set to " + model + " — the split pool is restarting with it (a few minutes)."
        return "Model set to " + model + " — it will load at the next start."
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


def page(st, msg=""):
    def dot(up, idle=False):
        cls = "dot" if up else ("dot idle" if idle else "dot off")
        return '<span class="' + cls + '"></span>'

    rows = ""
    for m in st["machines"]:
        offered = "detected live" if m.get("role") == "coordinator" else (
            str(m.get("offered_mb") or 0) + " MB "
            '<form class="inline" method="post" action="/action">'
            '<input type="hidden" name="action" value="set_offered">'
            '<input type="hidden" name="machine" value="' + escape(str(m.get("name", ""))) + '">'
            '<input name="offered_mb" size="6" placeholder="MB">'
            '<button class="alt" type="submit">Set</button></form>')
        rows += ("<tr><td><strong>" + escape(str(m.get("name", ""))) + "</strong></td>"
                 "<td>" + escape(str(m.get("role", ""))) + " · " + escape(str(m.get("ip", ""))) + "</td>"
                 "<td>" + offered + "</td>"
                 "<td>" + escape(str(m.get("holds", ""))) + "</td>"
                 "<td>" + dot(bool(m.get("up"))) + ("up" if m.get("up") else "down") + "</td></tr>")

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
                   '<button class="alt" type="submit">Use this model</button></form>')
        mrows += ("<tr><td>" + escape(md["file"]) + (" <strong>(current)</strong>" if md["current"] else "") +
                  "</td><td>" + str(md["size_mb"]) + " MB</td><td>" + " · ".join(fit) +
                  "</td><td>" + btn + "</td></tr>")

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
</div>

<h2>Models on the host</h2>
<div class="card"><div class="tbl"><table>
<tr><th>Model</th><th>Size</th><th>Fit check</th><th></th></tr>
{mrows}
</table></div>
<p class="fine">“Use this model” writes the picker's choice for the next start — and restarts the
brain with it if one is running (expect a few minutes of loading).</p>
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
            self._send(200, page(pool_state(), (q.get("msg") or [""])[0]))
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
