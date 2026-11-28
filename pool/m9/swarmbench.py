#!/usr/bin/env python3
"""SwarmBench: time to first token and generation speed for any local
or distributed LLM setup.

    python swarmbench.py                      finds a server on this computer
    python swarmbench.py http://host:8080     llama.cpp llama-server
    python swarmbench.py http://host:11434    Ollama
    python swarmbench.py http://host:1234/v1  LM Studio, vLLM, koboldcpp, any
                                              OpenAI-style server
Options:
    --model NAME        model to test (Ollama / OpenAI-style servers)
    --rpc a:50052,b:50052
                        the machines in a llama.cpp RPC split (the same list
                        you give llama-server --rpc), so the network cost of
                        each one is measured
    --quick             one run per case instead of two
    --out FILE          where to save the result (default: a dated JSON file)
    --api-key KEY       for servers that need one (or env SWARMBENCH_API_KEY)
    --timeout SEC       per request (default 900)

Python 3.8 or newer, nothing to install. Every run uses the same fixed
test ("standard-v1"), so results from different setups compare.
"""

import argparse
import datetime
import json
import math
import os
import platform
import re
import secrets
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"
SUITE_VERSION = "standard-v1"
RESULTS_PAGE = "https://swarmbench.tavernworks.dev/"

# ---------------- the standard test (same as the AI Pool's) ----------------

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


def case_prompt(words, tag):
    """The case's prompt. The tag at the very start is different on every
    request, so no server can answer from a cached prompt: the time to
    first token is always the real one."""
    return ("[" + tag + "] You are the narrator of a fantasy tavern story. Continue the "
            "scene below in plain prose.\n\n" + filler(words) + "\n\nContinue:")


def new_tag():
    return "run " + secrets.token_hex(3)


# Score: 1000 means a 1.0 s first token and 10 tokens/s on the medium case.
# The first token weighs twice as much as speed, since that's what people
# feel first. Higher is better.
TTFT_REF_MS = 1000.0
GEN_REF_TPS = 10.0


def score(ttft_ms, gen_tps):
    if not ttft_ms or not gen_tps:
        return None
    f_ttft = TTFT_REF_MS / float(ttft_ms)
    f_gen = float(gen_tps) / GEN_REF_TPS
    return int(round(1000.0 * (f_ttft ** (2.0 / 3.0)) * (f_gen ** (1.0 / 3.0))))


def first_token_score(ttft_ms):
    return int(round(1000.0 * TTFT_REF_MS / float(ttft_ms))) if ttft_ms else None


# ---------------- HTTP ----------------

API_KEY = os.environ.get("SWARMBENCH_API_KEY", "")
TIMEOUT = 900


def _headers():
    h = {"Content-Type": "application/json", "User-Agent": "SwarmBench/" + VERSION}
    if API_KEY:
        h["Authorization"] = "Bearer " + API_KEY
    return h


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open(url, body=None, timeout=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers())
    return _opener.open(req, timeout=timeout or TIMEOUT)


def get_json(url, timeout=4):
    try:
        with _open(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


class ServerError(Exception):
    pass


# ---------------- backends ----------------

class Backend:
    kind = "?"
    model = ""
    exact = False      # server reports its own token counts and timings

    def info(self):
        return {}

    def run(self, prompt, n_predict):
        """-> {ttft_ms, wall_ms, prompt_n, prompt_ms, gen_n, gen_ms, server_*}"""
        raise NotImplementedError


class LlamaCpp(Backend):
    kind = "llama.cpp"
    exact = True

    def __init__(self, base, props):
        self.base = base
        self.props = props or {}
        path = self.props.get("model_path") or ""
        self.model = os.path.basename(path.replace("\\", "/")) or (self.props.get("model_alias") or "")

    def info(self):
        p = self.props
        g = p.get("default_generation_settings") or {}
        return {"model_path": p.get("model_path"), "build": p.get("build_info"),
                "n_ctx": g.get("n_ctx") or p.get("n_ctx"), "slots": p.get("total_slots"),
                "speculative": bool((g.get("params") or {}).get("speculative.n_max"))}

    def run(self, prompt, n_predict):
        body = {"prompt": prompt, "n_predict": n_predict, "temperature": 0, "top_k": 1,
                "seed": 42, "ignore_eos": True, "cache_prompt": False, "stream": True}
        t0 = time.perf_counter()
        ttft = None
        timings = {}
        try:
            with _open(self.base + "/completion", body) as r:
                for raw in r:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if ttft is None and ev.get("content"):
                        ttft = (time.perf_counter() - t0) * 1000.0
                    if ev.get("timings"):
                        timings = ev["timings"]
                    if ev.get("stop"):
                        break
        except urllib.error.HTTPError as e:
            raise ServerError("llama-server said " + str(e.code) + ": " + _err_text(e))
        wall = (time.perf_counter() - t0) * 1000.0
        out = {"ttft_ms": ttft if ttft is not None else wall, "wall_ms": wall,
               "prompt_n": timings.get("prompt_n"), "prompt_ms": timings.get("prompt_ms"),
               "gen_n": timings.get("predicted_n"), "gen_ms": timings.get("predicted_ms")}
        if timings.get("draft_n"):
            out["draft_rate"] = round(timings.get("draft_n_accepted", 0) / float(timings["draft_n"]), 4)
        return out


class Ollama(Backend):
    kind = "Ollama"
    exact = True

    def __init__(self, base, model):
        self.base = base
        self.model = model
        self.load_ms = None

    def info(self):
        ps = get_json(self.base + "/api/ps") or {}
        for m in ps.get("models") or []:
            if m.get("name") == self.model or m.get("model") == self.model:
                size, vram = m.get("size") or 0, m.get("size_vram") or 0
                d = m.get("details") or {}
                return {"size_mb": round(size / 1048576.0), "on_gpu_pct": round(100.0 * vram / size) if size else None,
                        "quant": d.get("quantization_level"), "params": d.get("parameter_size"),
                        "context": m.get("context_length")}
        return {}

    def run(self, prompt, n_predict):
        body = {"model": self.model, "prompt": prompt, "raw": True, "stream": True,
                "keep_alive": "15m",
                "options": {"num_predict": n_predict, "temperature": 0, "top_k": 1, "seed": 42}}
        t0 = time.perf_counter()
        ttft = None
        last = {}
        try:
            with _open(self.base + "/api/generate", body) as r:
                for raw in r:
                    try:
                        ev = json.loads(raw.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if ev.get("error"):
                        raise ServerError("Ollama said: " + str(ev["error"]))
                    if ttft is None and ev.get("response"):
                        ttft = (time.perf_counter() - t0) * 1000.0
                    if ev.get("done"):
                        last = ev
                        break
        except urllib.error.HTTPError as e:
            raise ServerError("Ollama said " + str(e.code) + ": " + _err_text(e))
        wall = (time.perf_counter() - t0) * 1000.0
        ns = 1e-6
        if last.get("load_duration"):
            self.load_ms = last["load_duration"] * ns
        return {"ttft_ms": ttft if ttft is not None else wall, "wall_ms": wall,
                "prompt_n": last.get("prompt_eval_count"),
                "prompt_ms": (last.get("prompt_eval_duration") or 0) * ns or None,
                "gen_n": last.get("eval_count"),
                "gen_ms": (last.get("eval_duration") or 0) * ns or None,
                "load_ms": (last.get("load_duration") or 0) * ns}


class OpenAI(Backend):
    kind = "OpenAI-style"

    def __init__(self, base, model):
        self.base = base        # ends in /v1
        self.model = model
        self.chat = False
        self.extra = {"ignore_eos": True}

    def run(self, prompt, n_predict):
        body = {"model": self.model, "max_tokens": n_predict, "temperature": 0, "top_p": 1,
                "seed": 42, "stream": True, "stream_options": {"include_usage": True}}
        body.update(self.extra)
        if self.chat:
            body["messages"] = [{"role": "user", "content": prompt}]
            url = self.base + "/chat/completions"
        else:
            body["prompt"] = prompt
            url = self.base + "/completions"
        t0 = time.perf_counter()
        ttft = None
        t_last = None
        chunks = 0
        usage = {}
        try:
            with _open(url, body) as r:
                for raw in r:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        ev = json.loads(data)
                    except ValueError:
                        continue
                    if ev.get("usage"):
                        usage = ev["usage"]
                    for ch in ev.get("choices") or []:
                        text = ch.get("text") if not self.chat else (ch.get("delta") or {}).get("content")
                        if text:
                            now = time.perf_counter()
                            if ttft is None:
                                ttft = (now - t0) * 1000.0
                            t_last = now
                            chunks += 1
        except urllib.error.HTTPError as e:
            msg = _err_text(e)
            if e.code in (400, 422) and self.extra:
                self.extra = {}            # server doesn't know ignore_eos: try plain
                return self.run(prompt, n_predict)
            if e.code == 404 and not self.chat:
                self.chat = True           # chat-only server
                return self.run(prompt, n_predict)
            raise ServerError("the server said " + str(e.code) + ": " + msg)
        wall = (time.perf_counter() - t0) * 1000.0
        gen_n = usage.get("completion_tokens") or chunks
        gen_ms = (t_last - t0) * 1000.0 - ttft if (t_last and ttft is not None) else None
        return {"ttft_ms": ttft if ttft is not None else wall, "wall_ms": wall,
                "prompt_n": usage.get("prompt_tokens"), "prompt_ms": None,
                # the first token comes with the first-token time, so speed
                # counts the tokens after it
                "gen_n": gen_n, "gen_ms": gen_ms, "gen_counted_from": "first token",
                "gen_n_estimated": not usage.get("completion_tokens")}


def _err_text(e):
    try:
        return e.read().decode("utf-8", "replace")[:300]
    except Exception:
        return str(e)


def detect(url, model=None, ask=True):
    """Work out what kind of server is at url."""
    url = url.rstrip("/")
    if not re.match(r"^https?://", url):
        url = "http://" + url
    root = re.sub(r"/v1$", "", url)
    props = get_json(root + "/props")
    if isinstance(props, dict) and ("default_generation_settings" in props or "model_path" in props):
        return LlamaCpp(root, props)
    tags = get_json(root + "/api/tags")
    if isinstance(tags, dict) and isinstance(tags.get("models"), list):
        names = [m.get("name") for m in tags["models"] if m.get("name")]
        if not model:
            loaded = [m.get("name") for m in (get_json(root + "/api/ps") or {}).get("models") or []]
            model = pick_model(loaded or names, "Ollama", ask)
        return Ollama(root, model)
    base = root + "/v1"
    models = get_json(base + "/models")
    if isinstance(models, dict):
        ids = [m.get("id") for m in models.get("data") or [] if m.get("id")]
        if not model:
            model = pick_model(ids, "this server", ask)
        return OpenAI(base, model or "default")
    return None


def pick_model(names, where, ask):
    if not names:
        raise SystemExit("No model found on " + where + ". Load one, or pass --model NAME.")
    if len(names) == 1 or not ask or not sys.stdin.isatty():
        return names[0]
    print("Models on " + where + ":")
    for i, n in enumerate(names, 1):
        print("  " + str(i) + ". " + n)
    while True:
        a = input("Which one should SwarmBench test? [1] ").strip() or "1"
        if a.isdigit() and 1 <= int(a) <= len(names):
            return names[int(a) - 1]


LOCAL_GUESSES = [
    ("llama.cpp", "http://127.0.0.1:8080"),
    ("Ollama", "http://127.0.0.1:11434"),
    ("LM Studio", "http://127.0.0.1:1234"),
    ("vLLM", "http://127.0.0.1:8000"),
    ("koboldcpp", "http://127.0.0.1:5001"),
    ("text-generation-webui", "http://127.0.0.1:5000"),
    ("AI Pool brain", "http://127.0.0.1:8090"),
]


def find_local():
    for name, url in LOCAL_GUESSES:
        host, port = urllib.parse.urlparse(url).hostname, urllib.parse.urlparse(url).port
        try:
            socket.create_connection((host, port), timeout=0.3).close()
        except OSError:
            continue
        return url
    return None


# ---------------- network ----------------

def tcp_rtt(host, port, n=10):
    """Median time to open a TCP connection: about one network round
    trip, measured the same way on every OS without needing ping."""
    vals, lost = [], 0
    for _ in range(n):
        t = time.perf_counter()
        try:
            s = socket.create_connection((host, port), timeout=2)
            vals.append((time.perf_counter() - t) * 1000.0)
            s.close()
        except OSError:
            lost += 1
        time.sleep(0.05)
    if not vals:
        return {"host": host, "port": port, "rtt_ms": None, "lost": lost}
    return {"host": host, "port": port, "rtt_ms": round(statistics.median(vals), 2),
            "rtt_best_ms": round(min(vals), 2), "rtt_worst_ms": round(max(vals), 2), "lost": lost}


def parse_rpc(text):
    out = []
    for part in (text or "").replace(" ", "").split(","):
        if not part:
            continue
        host, _, port = part.rpartition(":")
        if not host or not port.isdigit():
            raise SystemExit("Couldn't read the machine '" + part + "' in --rpc. Use host:port, like 192.168.1.20:50052.")
        out.append((host.strip("[]"), int(port)))
    return out


def is_local(host):
    return host in ("localhost", "::1") or (host or "").startswith("127.")


# ---------------- this computer ----------------

def sysinfo():
    info = {"os": platform.system() + " " + platform.release(), "machine": platform.machine(),
            "cpu": platform.processor() or "", "cpu_threads": os.cpu_count(),
            "python": platform.python_version()}
    try:
        if sys.platform.startswith("linux"):
            for line in open("/proc/cpuinfo"):
                if line.startswith("model name"):
                    info["cpu"] = line.split(":", 1)[1].strip()
                    break
            mem = {}
            for line in open("/proc/meminfo"):
                k, v = line.split(":", 1)
                mem[k] = int(v.split()[0])
            info["ram_mb"] = mem.get("MemTotal", 0) // 1024
        elif sys.platform == "win32":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong),
                            ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("pt", ctypes.c_ulonglong), ("pa", ctypes.c_ulonglong),
                            ("vt", ctypes.c_ulonglong), ("va", ctypes.c_ulonglong),
                            ("ve", ctypes.c_ulonglong)]
            m = MS()
            m.l = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            info["ram_mb"] = int(m.total // 1048576)
        elif sys.platform == "darwin":
            info["ram_mb"] = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True,
                                                text=True, timeout=5).stdout.strip()) // 1048576
            info["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                         text=True, timeout=5).stdout.strip() or info["cpu"]
    except Exception:
        pass
    gpus = []
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True,
                             timeout=10).stdout
        for line in out.strip().splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) >= 3:
                gpus.append({"name": p[0], "vram_mb": int(float(p[1])), "vram_used_mb": int(float(p[2]))})
    except Exception:
        pass
    info["gpus"] = gpus
    return info


# ---------------- running ----------------

def med(vals):
    vals = [v for v in vals if v is not None]
    return round(statistics.median(vals), 2) if vals else None


def fmt_ms(v):
    if v is None:
        return "—"
    if v < 10:
        return "%.1f ms" % v
    return str(int(round(v))) + " ms" if v < 1000 else ("%.2f s" % (v / 1000.0) if v < 10000 else "%.1f s" % (v / 1000.0))


def fmt(v, d=1):
    return "—" if v is None else ("%." + str(d) + "f") % v


def say(*a, **kw):
    print(*a, flush=True, **kw)


def run_case(be, name, words, n_predict, reps):
    rows = []
    for rep in range(1, reps + 1):
        say("  " + name + " (" + str(rep) + "/" + str(reps) + ") ...", end="")
        sys.stdout.flush()
        r = be.run(case_prompt(words, new_tag()), n_predict)
        gen_n, gen_ms = r.get("gen_n"), r.get("gen_ms")
        if r.get("gen_counted_from"):
            gen_tps = (gen_n - 1) * 1000.0 / gen_ms if gen_n and gen_n > 1 and gen_ms else None
        else:
            gen_tps = gen_n * 1000.0 / gen_ms if gen_n and gen_ms else None
        r["gen_tps"] = round(gen_tps, 2) if gen_tps else None
        if r.get("prompt_n") and r.get("prompt_ms"):
            r["prompt_tps"] = round(r["prompt_n"] * 1000.0 / r["prompt_ms"], 1)
        elif r.get("prompt_n") and r.get("ttft_ms"):
            r["prompt_tps"] = round(r["prompt_n"] * 1000.0 / r["ttft_ms"], 1)
        if r.get("prompt_ms") is not None:
            r["overhead_ms"] = round(max(0.0, r["ttft_ms"] - r["prompt_ms"]), 1)
        r.update({"case": name, "rep": rep, "n_predict": n_predict})
        rows.append(r)
        say(" first token " + fmt_ms(r["ttft_ms"]) + ", " + fmt(r["gen_tps"], 1) + " tok/s")
    return rows


def summarise(rows):
    return {
        "prompt_n": med([r.get("prompt_n") for r in rows]),
        "gen_n": med([r.get("gen_n") for r in rows]),
        "ttft_ms": med([r["ttft_ms"] for r in rows]),
        "ttft_best_ms": round(min(r["ttft_ms"] for r in rows), 1),
        "prompt_tps": med([r.get("prompt_tps") for r in rows]),
        "gen_tps": med([r.get("gen_tps") for r in rows]),
        "overhead_ms": med([r.get("overhead_ms") for r in rows]),
        "draft_rate": med([r.get("draft_rate") for r in rows]),
        "runs": len(rows),
    }


def bottlenecks(be, summary, server_net, workers):
    """Plain-language findings about where the time goes."""
    out = []
    m = summary.get("medium") or summary.get("short") or {}
    if server_net and server_net.get("rtt_ms") is not None and not is_local(server_net["host"]):
        out.append("Network to the server: about " + fmt_ms(server_net["rtt_ms"]) +
                   " per round trip, added to every first token.")
    if m.get("overhead_ms") is not None and m.get("ttft_ms"):
        share = 100.0 * m["overhead_ms"] / m["ttft_ms"]
        if share >= 20:
            out.append("Before the model even starts reading, " + fmt_ms(m["overhead_ms"]) + " (" +
                       str(int(share)) + "% of the first token) goes to the request itself: network, "
                       "queueing behind other requests or the server's own overhead.")
    info = be.info()
    if isinstance(be, Ollama) and info.get("on_gpu_pct") is not None and info["on_gpu_pct"] < 100:
        out.append("Only " + str(info["on_gpu_pct"]) + "% of the model fits on the graphics card; the "
                   "rest runs from system RAM, which is usually the slowest part.")
    if workers and m.get("gen_tps"):
        per_tok = 1000.0 / m["gen_tps"]
        live = [w for w in workers if w.get("rtt_ms") is not None]
        floor = sum(w["rtt_ms"] for w in live)
        if live:
            share = min(100.0, 100.0 * floor / per_tok)
            worst = max(live, key=lambda w: w["rtt_ms"])
            out.append("Each token passes through " + str(len(live)) + " remote machine(s): at least " +
                       fmt_ms(floor) + " of the " + fmt_ms(per_tok) + " each token takes (" + str(int(share)) +
                       "%) is network round trips. The slowest link is " + worst["host"] + " at " +
                       fmt_ms(worst["rtt_ms"]) + ".")
            if share >= 50:
                out.append("So the network, not the machines' speed, is the main limit on tokens per second.")
            elif share < 10:
                out.append("So the network isn't what limits speed here; the machines are.")
            if m.get("prompt_n"):
                chunks = max(1, int(math.ceil(m["prompt_n"] / 512.0)))
                tfloor = chunks * floor
                out.append("For the first token, the prompt crosses the network in about " + str(chunks) +
                           " chunk(s): at least " + fmt_ms(tfloor) + " of the " + fmt_ms(m["ttft_ms"]) + ".")
        dead = [w for w in workers if w.get("rtt_ms") is None]
        for w in dead:
            out.append("Couldn't reach " + w["host"] + ":" + str(w["port"]) + " from this computer.")
    if not out:
        out.append("Nothing stands out: the time goes to the model itself on this hardware.")
    return out


def main():
    global API_KEY, TIMEOUT
    ap = argparse.ArgumentParser(prog="swarmbench", description="SwarmBench " + VERSION +
                                 ": time to first token and speed for any LLM setup.")
    ap.add_argument("url", nargs="?", help="the model server (default: look on this computer)")
    ap.add_argument("--model")
    ap.add_argument("--rpc", help="machines in a llama.cpp RPC split, host:port,host:port")
    ap.add_argument("--quick", action="store_true", help="one run per case")
    ap.add_argument("--out")
    ap.add_argument("--api-key")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--yes", action="store_true", help="don't ask anything")
    a = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")   # old Windows consoles
        except Exception:
            pass
    API_KEY = a.api_key or API_KEY
    TIMEOUT = a.timeout
    say("SwarmBench " + VERSION + " · test " + SUITE_VERSION)
    url = a.url
    if not url:
        url = find_local()
        if not url:
            if sys.stdin.isatty() and not a.yes:
                url = input("No model server found on this computer. Its address (like http://192.168.1.20:8080): ").strip()
            if not url:
                raise SystemExit("Start your model server, or give its address: python swarmbench.py http://host:port")
    be = detect(url, a.model, ask=not a.yes)
    if not be:
        raise SystemExit("Nothing at " + url + " answered like llama.cpp, Ollama or an OpenAI-style server.")
    say("Server: " + be.kind + " at " + url + (" · model " + be.model if be.model else ""))
    pu = urllib.parse.urlparse(be.base if hasattr(be, "base") else url)
    server_net = tcp_rtt(pu.hostname, pu.port or (443 if pu.scheme == "https" else 80))
    workers = []
    if a.rpc:
        say("Measuring the network to each machine in the split ...")
        for host, port in parse_rpc(a.rpc):
            w = tcp_rtt(host, port)
            workers.append(w)
            say("  " + host + ":" + str(port) + " " + (fmt_ms(w["rtt_ms"]) if w["rtt_ms"] is not None else "no answer"))
    reps = 1 if a.quick else REPS
    say("Warming up (the first request can include loading the model) ...")
    t = time.perf_counter()
    try:
        w = be.run(case_prompt(8, new_tag()), 8)
    except ServerError as e:
        raise SystemExit("The warm-up failed: " + str(e))
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit("Couldn't reach the server: " + str(e))
    warm_ms = (time.perf_counter() - t) * 1000.0
    say("  ready (" + fmt_ms(warm_ms) + ")")
    all_rows, summary = [], {}
    started = time.time()
    try:
        for name, words, n_predict in SUITE:
            rows = run_case(be, name, words, n_predict, reps)
            all_rows += rows
            summary[name] = summarise(rows)
    except KeyboardInterrupt:
        say("\nStopped. Saving what ran.")
    except ServerError as e:
        say("\n" + str(e))
    except (urllib.error.URLError, OSError) as e:
        say("\nLost the server: " + str(e))
    if not summary:
        raise SystemExit("No results.")
    m = summary.get("medium") or {}
    sc = score(m.get("ttft_ms"), m.get("gen_tps"))
    fts = first_token_score(m.get("ttft_ms"))
    finds = bottlenecks(be, summary, server_net, workers)
    estimated = any(r.get("gen_n_estimated") for r in all_rows)
    short_gen = [r for r in all_rows if r.get("gen_n") and r["gen_n"] < r["n_predict"] * 0.8]
    say("")
    say("=" * 60)
    say("SwarmBench score: " + (str(sc) if sc is not None else "—") +
        "   ·   first token score: " + (str(fts) if fts is not None else "—"))
    say("=" * 60)
    say("%-8s %10s %12s %12s %12s" % ("case", "tokens in", "first token", "prompt tok/s", "gen tok/s"))
    for name, _, _ in SUITE:
        if name in summary:
            x = summary[name]
            say("%-8s %10s %12s %12s %12s" % (name, fmt(x["prompt_n"], 0), fmt_ms(x["ttft_ms"]),
                                              fmt(x["prompt_tps"], 1), fmt(x["gen_tps"], 2)))
    say("")
    say("Where the time goes:")
    for f in finds:
        say("  - " + f)
    if estimated:
        say("  - This server doesn't report token counts, so tokens/s is counted from the stream (close, not exact).")
    if short_gen:
        say("  - The model stopped early on " + str(len(short_gen)) + " run(s); speed is from the tokens it did write.")
    result = {
        "swarmbench": VERSION, "suite": SUITE_VERSION, "reps": reps,
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "score": sc, "first_token_score": fts,
        "server": {"kind": be.kind, "model": be.model, "local": is_local(pu.hostname or ""),
                   "info": be.info()},
        "computer": sysinfo(),
        "network": {"server": server_net, "split": workers},
        "warmup_ms": round(warm_ms, 1),
        "summary": summary, "findings": finds, "runs": all_rows,
        "duration_s": round(time.time() - started, 1),
    }
    out = a.out or ("swarmbench-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")
    with open(out, "w") as f:
        json.dump(result, f, indent=1)
    say("")
    say("Saved " + os.path.abspath(out))
    say("Compare with the AI Pool's results at " + RESULTS_PAGE)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)
