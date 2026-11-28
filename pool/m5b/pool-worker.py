#!/usr/bin/env python3
# AI Pool — the worker app (M5b).
#
# Runs on a contributor's PC. It:
#   1. enrolls this machine with the pool (or reuses a saved
#      enrollment) and waits for the operator's approval;
#   2. downloads the pool's PINNED llama.cpp engine from the pool's
#      own downloads shelf, verifying every component's SHA-256
#      (split components are joined back together first);
#   3. runs the pinned ggml-rpc-server bound to this machine's
#      LOCALHOST ONLY — nothing on this PC listens to the network;
#   4. holds ONE persistent outbound WebSocket to the pool front
#      (the "relay"); the front bridges it to a localhost port on
#      the host, and llama-server's RPC traffic travels down it.
#      Revoking the enrollment on the coordinator cuts the relay;
#   5. yields the machine to its owner: a PAUSE file, running on
#      battery, or a hot GPU each drain the worker out of the pool
#      (relay closes first, rpc-server stops after a grace), and it
#      rejoins only after a quiet delay.
#
# Python 3 standard library only. Windows and Linux are both
# supported: the engine picking, archive extraction, battery
# and memory probes are platform-aware.
#
# Config lives in <worker dir>/config.json (worker dir: env
# POOL_WORKER_DIR, else ~/pool-worker). First run creates it:
#   python3 pool-worker.py
# The name defaults to this machine's hostname and the offered
# memory to a conservative auto-size; override either with
# --name / --offered-mb. Once the operator approves the machine,
# the worker prints a personal link that ties the machine to
# the owner's pool account — that link is how its earnings
# reach their balance.
# Test hooks: config keys pool_url, rpc_port, engine_dir,
# rejoin_delay_sec, drain_grace_sec, temp_limit_c.
import base64
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CHUNK = 262144
# The relay WebSocket's read/write backstop. The live checks are the
# heartbeat below (ping every 30 s, drop after 90 s with nothing
# received) and the front's own pings every 20 s; this only catches a
# socket that hangs outright. It MUST stay well above both intervals:
# the 30 s connect timeout used to stay on the socket for its whole
# life and raced the 30 s ping cycle.
RELAY_IO_TIMEOUT = 150
RPC_LOG_MAX = 20 * 1024 * 1024

DEFAULTS = {
    "pool_url": "https://pool.tavernworks.dev",
    "name": "",
    "offered_mb": 0,
    "backend": "auto",          # auto | cuda | vulkan | cpu
    "enrollment_id": "",
    "key": "",
    "rpc_port": 50052,
    "engine_dir": "",           # empty = <worker dir>/engine/current
    "pause_file": "",           # empty = <worker dir>/PAUSE
    "battery_yield": True,
    "temp_limit_c": 85,
    "drain_grace_sec": 10,
    "rejoin_delay_sec": 600,
    # rpc-server's local tensor cache: the first split load sends
    # this machine's slice over the network once; later loads of the
    # same model find it on disk instead of re-sending it.
    "rpc_cache": True,
    # Pre-download: fill that cache from the model's public download
    # (Hugging Face) ahead of time, so a split sends almost nothing.
    "predownload": True,
    # Android only: yield when the battery is this hot (deg C).
    "battery_temp_limit_c": 42,
    # Keep this script current: every 10 min, while no split is using
    # this machine, compare it with the pool shelf's pool-worker.py
    # (SHA-256 from the shelf manifest, like the engine) and restart
    # on the new copy when it changed.
    "self_update": True,
}


LOG_MAX = 5 * 1024 * 1024
_log_path = ""
_log_lock = threading.Lock()


def log(msg):
    line = "[pool-worker] " + msg
    print(line, flush=True)
    # Also kept in <worker dir>/pool-worker.log, so the owner can send
    # the operator what happened without copying a console window.
    if _log_path:
        with _log_lock:
            try:
                if os.path.getsize(_log_path) > LOG_MAX:
                    os.replace(_log_path, _log_path + ".old")
            except OSError:
                pass
            try:
                with open(_log_path, "a", encoding="utf-8") as f:
                    f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")
            except OSError:
                pass


def ws_mask(data, mask):
    """XOR with the 4-byte WebSocket mask as one big integer. The old
    per-byte Python loop managed ~15 MB/s: every split reply's
    activations going back to the host (~16 MB for a 2k-token prompt)
    sat in it for a second or more."""
    n = len(data)
    if not n:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "little") ^
            int.from_bytes(key, "little")).to_bytes(n, "little")


def nodelay(sock):
    """RPC is many small request/response messages. With Nagle on, a
    small write waits for the previous one's ACK (up to 40 ms on
    Linux, 200 ms on Windows) before it leaves, on every hop of the
    relay. llama.cpp turns Nagle off on its own sockets; so must we."""
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except (OSError, AttributeError):
        pass


# ------------------------------------------------------------------
# Android (Termux). The worker runs unchanged in Termux's Python; the
# engine is llama.cpp's own Android arm64 release at the pool's pin:
#   llama-<pin>-bin-android-arm64-snapdragon.tar.gz  CPU + Adreno GPU
#       (OpenCL) + Hexagon — for Snapdragon phones with Adreno 7xx/8xx
#   llama-<pin>-bin-android-arm64.tar.gz             CPU only — every
#       other phone (Mali, PowerVR, older Adreno)
# The Snapdragon rpc-server links libOpenCL.so, so it only starts on a
# phone whose vendor ships it; if it can't start, the worker falls
# back to the CPU engine by itself.
# ------------------------------------------------------------------
def is_android():
    if platform.system() == "Android":          # Python 3.13+
        return True
    if hasattr(sys, "getandroidapilevel"):
        return True
    return bool(os.environ.get("TERMUX_VERSION") or
                os.environ.get("ANDROID_ROOT"))


def getprop(key):
    try:
        out = subprocess.run(["getprop", key], capture_output=True,
                             text=True, timeout=5)
        return out.stdout.strip()
    except Exception:
        return ""


def android_gpu():
    """'Adreno 750', 'Mali-G715', ... or '' — best effort: Android
    hides most of this from apps."""
    for path in ("/sys/class/kgsl/kgsl-3d0/gpu_model",):
        try:
            with open(path) as f:
                model = f.read().strip()
            if model:
                m = re.match(r"(?i)adreno\D*(\d{3})", model)
                return ("Adreno " + m.group(1)) if m else model
        except OSError:
            pass
    egl = (getprop("ro.hardware.egl") or "").lower()
    vk = (getprop("ro.hardware.vulkan") or "").lower()
    for name in (egl, vk):
        if "adreno" in name:
            return "Adreno"
        if "mali" in name:
            return "Mali"
        if "powervr" in name or "img" in name:
            return "PowerVR"
    return ""


def adreno_gen(gpu):
    """The Adreno series digit (7 for an Adreno 750), 0 when unknown."""
    m = re.search(r"Adreno (\d)\d\d", gpu or "")
    return int(m.group(1)) if m else 0


def model_gpu_ok_opencl(model_file):
    """Whether the Adreno OpenCL backend can run every matmul of this
    model. The RPC host never asks a remote device what it supports,
    so an op the phone's GPU can't do would crash its rpc-server
    mid-split. llama.cpp's OpenCL backend runs MoE expert matmuls
    (MUL_MAT_ID) in general only for Q4_0, Q8_0 and MXFP4 — so a
    phone's GPU only computes for MXFP4/Q4_0/Q8_0 files; for any
    other quant it lends its RAM and CPU instead."""
    name = (model_file or "").upper()
    return any(t in name for t in ("MXFP4", "Q4_0", "Q8_0"))


def auto_offered_mb_android(ram_mb):
    """Phones share one pool of RAM between the GPU, the apps and
    Android itself, and Android kills big background processes under
    pressure: offer a third of RAM, 512 MB steps, [1024, 6144]."""
    if ram_mb <= 0:
        return 2048
    third = (ram_mb // 3 // 512) * 512
    return max(1024, min(6144, third))


def auto_offered_mb(vram_mb, ram_mb):
    """The default share when the user offers nothing: half of
    the GPU's VRAM (a CUDA worker holds its slice there) or half
    of system RAM, rounded down to a 512 MB step and clamped to
    [1024, 8192]. 4096 when nothing can be detected."""
    base = vram_mb or ram_mb or 0
    if base <= 0:
        return 4096
    half = (base // 2 // 512) * 512
    return max(1024, min(8192, half))


def nvidia_smi_cmd():
    """Path to nvidia-smi, or None. Windows drivers don't always
    put it on PATH, so check their usual homes too."""
    found = shutil.which("nvidia-smi")
    if found:
        return found
    if platform.system() == "Windows":
        for cand in (
                r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
                r"C:\Windows\System32\nvidia-smi.exe"):
            if os.path.isfile(cand):
                return cand
    return None


# ------------------------------------------------------------------
# Model pre-download ("seeding").
#
# llama.cpp RPC normally pushes every one of this machine's tensors
# from the host at each split load. rpc-server's local cache (-c)
# changes that: for each tensor over 10 MiB the host first sends only
# a hash (64-bit FNV-1a of the tensor's bytes), and if rpc-server has
# a file of that name in its cache directory it loads the bytes from
# disk instead. Seeding fills that cache ahead of time straight from
# the model's public download (Hugging Face), so the remote machine's
# own download speed does the work and almost nothing crosses the
# FX705's upload when a split starts.
#
# The worker seeds every large tensor in the model, not just its own
# share: which layers land here depends on the split of the day.
# Disk use is about the model's size; it is checked first.
# ------------------------------------------------------------------

SEED_MIN_BYTES = 10 * 1024 * 1024   # rpc-server hashes tensors larger than this
SEED_CHECK_SEC = 600                # how often to re-check the pool's model
SEED_SKIP_MAX = 64 * 1024 * 1024    # resume further than this with a Range request
FNV_OFFSET = 0xcbf29ce484222325
FNV_PRIME = 0x100000001b3
FNV_MASK = (1 << 64) - 1

# ggml type id -> (elements per block, bytes per block)
GGML_BLOCKS = {
    0: (1, 4), 1: (1, 2), 2: (32, 18), 3: (32, 20), 6: (32, 22),
    7: (32, 24), 8: (32, 34), 9: (32, 36), 10: (256, 84),
    11: (256, 110), 12: (256, 144), 13: (256, 176), 14: (256, 210),
    15: (256, 292), 16: (256, 66), 17: (256, 74), 18: (256, 98),
    19: (256, 50), 20: (32, 18), 21: (256, 110), 22: (256, 82),
    23: (256, 136), 24: (1, 1), 25: (1, 2), 26: (1, 4), 27: (1, 8),
    28: (1, 8), 29: (256, 56), 30: (1, 2), 34: (256, 54), 35: (256, 66),
}


def rpc_cache_dir():
    """Where rpc-server -c keeps its cache: llama.cpp's cache
    directory (LLAMA_CACHE, else the platform default) + rpc/."""
    base = os.environ.get("LLAMA_CACHE")
    if not base:
        system = platform.system()
        if system == "Windows":
            base = os.path.join(os.environ.get("LOCALAPPDATA") or
                                os.path.expanduser("~"), "llama.cpp")
        elif system == "Darwin":
            base = os.path.join(os.path.expanduser("~"), "Library",
                                "Caches", "llama.cpp")
        else:
            base = os.path.join(os.environ.get("XDG_CACHE_HOME") or
                                os.path.join(os.path.expanduser("~"),
                                             ".cache"), "llama.cpp")
    return os.path.join(base, "rpc")


def fnv1a64_file(path):
    """64-bit FNV-1a of a file — the hash rpc-server names cache files
    by. Pure Python (~7 MB/s a core), so tensors hash in parallel."""
    h = FNV_OFFSET
    with open(path, "rb") as f:
        while True:
            block = f.read(1 << 22)
            if not block:
                break
            for b in block:
                h = ((h ^ b) * FNV_PRIME) & FNV_MASK
    return h


def seed_source_ok(url):
    """Model bytes only ever come from Hugging Face over https."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (
        host == "huggingface.co" or host.endswith(".huggingface.co"))


def _seed_hash_job(path):
    return path, fnv1a64_file(path)


def _seed_pool_init():
    # Owner-first: hashing runs at low priority.
    try:
        os.nice(10)
    except (AttributeError, OSError):
        pass


class _CountingReader:
    def __init__(self, f):
        self.f = f
        self.pos = 0

    def read(self, n):
        out = b""
        while len(out) < n:
            chunk = self.f.read(n - len(out))
            if not chunk:
                raise ConnectionError("model download ended early")
            out += chunk
        self.pos += n
        return out

    def u32(self):
        return struct.unpack("<I", self.read(4))[0]

    def u64(self):
        return struct.unpack("<Q", self.read(8))[0]

    def string(self):
        return self.read(self.u64())


_GGUF_SCALAR = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1,
                10: 8, 11: 8, 12: 8}


def _gguf_skip_value(r, vtype):
    if vtype in _GGUF_SCALAR:
        return r.read(_GGUF_SCALAR[vtype])
    if vtype == 8:
        return r.string()
    if vtype == 9:
        itype, count = r.u32(), r.u64()
        if itype in _GGUF_SCALAR:
            r.read(_GGUF_SCALAR[itype] * count)
        else:
            for _ in range(count):
                _gguf_skip_value(r, itype)
        return None
    raise ValueError("unknown GGUF value type " + str(vtype))


def gguf_read_header(stream):
    """Parse a GGUF header from a byte stream. Returns
    (tensors, data_start, reader): tensors is a list of
    (name, offset_in_data, nbytes or None if the type is unknown),
    sorted by offset; reader has consumed exactly the header."""
    r = _CountingReader(stream)
    if r.read(4) != b"GGUF":
        raise ValueError("not a GGUF file")
    version = r.u32()
    if version < 2:
        raise ValueError("GGUF v" + str(version) + " is too old")
    n_tensors, n_kv = r.u64(), r.u64()
    alignment = 32
    for _ in range(n_kv):
        key = r.string()
        vtype = r.u32()
        if key == b"general.alignment" and vtype == 4:
            alignment = r.u32()
        else:
            _gguf_skip_value(r, vtype)
    tensors = []
    for _ in range(n_tensors):
        name = r.string().decode("utf-8", "replace")
        n_dims = r.u32()
        n_el = 1
        dims = [r.u64() for _ in range(n_dims)]
        for d in dims:
            n_el *= d
        ttype = r.u32()
        offset = r.u64()
        nbytes = None
        if ttype in GGML_BLOCKS:
            per, size = GGML_BLOCKS[ttype]
            if dims and dims[0] % per == 0:
                nbytes = n_el // per * size
        tensors.append((name, offset, nbytes))
    tensors.sort(key=lambda t: t[1])
    data_start = -(-r.pos // alignment) * alignment
    # Sanity: a computed size must fit before the next tensor starts.
    checked = []
    for i, (name, off, nb) in enumerate(tensors):
        if nb is not None and i + 1 < len(tensors) and \
                off + nb > tensors[i + 1][1]:
            nb = None
        checked.append((name, off, nb))
    return checked, data_start, r



class Worker:
    def __init__(self, cfg_path):
        self.dir = os.path.dirname(cfg_path)
        self.cfg_path = cfg_path
        self.cfg = dict(DEFAULTS)
        if os.path.isfile(cfg_path):
            with open(cfg_path) as f:
                self.cfg.update(json.load(f))
        self.stop_flag = threading.Event()
        self.rpc_proc = None
        self.relay = None
        self.rpc_cache_on = False
        self._seed_warned = ""
        self._seed_extra_seen = 0
        self._seed_thread = None
        self._seed_skip_said = ""
        self.restart = False
        self.android = is_android()
        self.rpc_device = ""
        if self.android and not os.path.isfile(cfg_path):
            # A phone's storage rarely has room for a whole ~20 GB
            # model; its slice arrives over the network at the first
            # split instead (and is cached for the next one).
            self.cfg["predownload"] = False

    # ---------------------------------------------------------- config
    def save_cfg(self):
        tmp = self.cfg_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.cfg, f, indent=1)
        os.replace(tmp, self.cfg_path)
        try:
            os.chmod(self.cfg_path, 0o600)
        except OSError:
            pass

    @property
    def pause_path(self):
        return self.cfg["pause_file"] or os.path.join(self.dir, "PAUSE")

    @property
    def engine_dir(self):
        return self.cfg["engine_dir"] or os.path.join(self.dir, "engine", "current")

    # ---------------------------------------------------------- http
    def http_json(self, method, path, body=None, timeout=30):
        url = self.cfg["pool_url"].rstrip("/") + path
        data = None
        headers = {"User-Agent": "pool-worker"}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers,
                                     method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            except Exception:
                return e.code, {}

    # ---------------------------------------------------------- enroll
    def detect_gpu(self):
        if self.android:
            gpu = android_gpu()
            soc = getprop("ro.soc.model") or getprop("ro.board.platform")
            return ((gpu or "unknown GPU") + (" (" + soc + ")" if soc else ""))
        smi = nvidia_smi_cmd()
        if not smi:
            return ""
        try:
            out = subprocess.run(
                [smi, "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10)
            name = out.stdout.strip().splitlines()
            if out.returncode == 0 and name:
                return name[0].strip()
        except Exception:
            pass
        return ""

    def detect_vram_mb(self):
        if self.android:
            return 0  # unified memory: the RAM figure is the one
        smi = nvidia_smi_cmd()
        if not smi:
            return 0
        try:
            out = subprocess.run(
                [smi, "--query-gpu=memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10)
            vals = out.stdout.strip().splitlines()
            if out.returncode == 0 and vals:
                return int(float(vals[0].strip()))
        except Exception:
            pass
        return 0

    def total_ram_mb(self):
        if platform.system() == "Windows":
            try:
                import ctypes

                class MEMORYSTATUSEX(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
                st = MEMORYSTATUSEX()
                st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(
                        ctypes.byref(st)):
                    return int(st.ullTotalPhys // (1024 * 1024))
            except Exception:
                pass
            return 0
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) // 1024
        except Exception:
            pass
        try:
            return (os.sysconf("SC_PHYS_PAGES") *
                    os.sysconf("SC_PAGE_SIZE")) // (1024 * 1024)
        except Exception:
            return 0

    def ensure_enrolled(self):
        if self.cfg["enrollment_id"] and self.cfg["key"]:
            return
        name = self.cfg["name"]
        if not name and self.android:
            # Termux's hostname is just 'localhost'; the phone's model
            # name says more ('Pixel-8', 'SM-S921U').
            model = getprop("ro.product.model") or getprop("ro.product.device")
            name = re.sub(r"[^A-Za-z0-9_-]+", "-", model).strip("-")[:32]
        if not name:
            name = socket.gethostname() or "my-pc"
            self.cfg["name"] = name
            log("no name given — this machine enrolls as '" + name +
                "' (change it any time with --name)")
        offered = int(self.cfg["offered_mb"] or 0)
        if offered < 512:
            vram = self.detect_vram_mb()
            ram = self.total_ram_mb()
            offered = (auto_offered_mb_android(ram) if self.android
                       else auto_offered_mb(vram, ram))
            self.cfg["offered_mb"] = offered
            base = vram or ram
            log("no --offered-mb given — offering " + str(offered) +
                " MB" + ((" (about half of this machine's " +
                          str(base) + " MB)") if base else "") +
                " (change it any time with --offered-mb)")
        self.save_cfg()
        code, obj = self.http_json("POST", "/enroll", {
            "name": name, "offered_mb": offered,
            "gpu": self.detect_gpu() or "unknown",
            "os": "android" if self.android else
                  (platform.system() or "unknown").lower()})
        if code != 201:
            raise SystemExit("enrollment failed: " + json.dumps(obj))
        self.cfg["enrollment_id"] = obj["id"]
        self.cfg["key"] = obj["key"]
        self.save_cfg()
        log("enrolled as " + obj["id"] + " — key saved to config.")
        log("Next: the pool operator approves every machine by "
            "hand. You don't need to do anything — just leave "
            "this running and it will carry on by itself.")

    def poll_status(self):
        code, obj = self.http_json(
            "GET", "/enroll/" + self.cfg["enrollment_id"] +
            "?key=" + self.cfg["key"])
        if code == 200:
            return obj.get("status", "")
        if code == 403:
            return "bad-key"
        return ""

    def wait_for_approval(self):
        last = None
        while not self.stop_flag.is_set():
            status = self.poll_status()
            if status != last:
                log("enrollment status: " + (status or "unreachable"))
                last = status
            if status == "approved":
                return True
            self.stop_flag.wait(20)
        return False

    # ---------------------------------------------------------- engine
    def detect_backend(self):
        want = (self.cfg["backend"] or "auto").lower()
        if self.android:
            if want in ("opencl", "cpu"):
                return want
            gpu = android_gpu()
            # Adreno 7xx/8xx are the GPUs llama.cpp's OpenCL backend is
            # verified on; 6xx and older (and Mali, PowerVR) run the
            # CPU engine — they'd be slower than the phone's own CPU.
            if adreno_gen(gpu) >= 7 or gpu == "Adreno":
                return "opencl"
            return "cpu"
        if want in ("cuda", "vulkan", "cpu"):
            return want
        if self.detect_gpu():
            return "cuda"
        return "vulkan"

    def fetch_manifest(self):
        url = self.cfg["pool_url"].rstrip("/") + "/downloads/manifest.json"
        # The User-Agent matters: Cloudflare refuses the default
        # Python-urllib one with a 403 (learned live, 2026-11-17).
        req = urllib.request.Request(url, headers={"User-Agent": "pool-worker"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())

    @staticmethod
    def _pin_of(name):
        # llama-b12359-cuda-12.8-x64.tar.gz -> 12359
        try:
            return int(name.split("-")[1].lstrip("b"))
        except Exception:
            return -1

    def pick_components(self, manifest, backend, plat=None):
        """Returns (pin, [component names in download order],
        by_name). Split components (…tar.gz.partNN) are grouped
        under their base name and ordered by suffix. Only this
        worker's platform is considered: Windows assets carry
        '-win-' in the name, Linux ones don't."""
        if plat is None:
            plat = ("android" if self.android else
                    "win" if platform.system() == "Windows" else "linux")
        groups = {}
        for comp in manifest.get("components", []):
            name = comp["name"]
            base, part = name, None
            if ".part" in name:
                base, _, suffix = name.partition(".part")
                part = suffix
            groups.setdefault(base, []).append((part, comp))
        def for_plat(base):
            return ("-win-" in base) == (plat == "win")
        engines, cudarts = {}, {}
        for base, parts in groups.items():
            if plat == "android":
                if "-android-arm64" not in base:
                    continue
            elif "arm64" in base or not for_plat(base):
                continue
            if base.startswith("llama-"):
                engines[base] = parts
            elif base.startswith("cudart-"):
                cudarts[base] = parts
        if plat == "android":
            # The Adreno build is upstream's '-snapdragon' package;
            # the plain one is CPU only.
            cands = [b for b in engines
                     if ("snapdragon" in b) == (backend == "opencl")]
        else:
            cands = [b for b in engines
                     if ("-" + backend + "-") in b or
                     ("-" + backend + ".") in b or backend in b.split("-")]
        if not cands and backend == "cpu" and plat != "android":
            # The plain build carries no backend keyword in its
            # name (llama-b12359-bin-ubuntu-x64.tar.gz upstream).
            others = ("cuda", "vulkan", "rocm", "sycl", "opencl",
                      "openvino")
            cands = [b for b in engines
                     if not any(("-" + o + "-") in b for o in others)]
        if not cands:
            raise SystemExit("the shelf has no " + backend +
                             " engine component for this platform "
                             "— tell the operator")
        cands.sort(key=lambda b: self._pin_of(b))
        engine_base = cands[-1]
        pin = self._pin_of(engine_base)
        chosen = [engine_base]
        if backend == "cuda":
            cc = [b for b in cudarts
                  if pin > 0 and self._pin_of(b) == pin]
            if not cc:
                # The Windows cudart name carries no pin — match
                # the engine's CUDA version instead.
                m = re.search(r"cuda-(\d+\.\d+)", engine_base)
                if m:
                    cc = [b for b in cudarts
                          if ("cuda-" + m.group(1)) in b]
            if not cc and len(cudarts) == 1:
                cc = list(cudarts)
            if not cc:
                raise SystemExit("the shelf has no cudart component "
                                 "matching " + engine_base)
            chosen.append(cc[0])
        names = []
        by_name = {c["name"]: c for c in manifest["components"]}
        for base in chosen:
            parts = sorted(groups[base],
                           key=lambda p: (p[0] is not None, p[0] or ""))
            for _, comp in parts:
                names.append(comp["name"])
        return pin, names, by_name

    @staticmethod
    def _sha256(path):
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    def download(self, name, want_sha, dest):
        """Resumable download of one shelf component, SHA-256
        verified against the manifest."""
        if os.path.isfile(dest) and self._sha256(dest) == want_sha:
            return
        url = self.cfg["pool_url"].rstrip("/") + "/downloads/" + name
        have = os.path.getsize(dest) if os.path.isfile(dest) else 0
        headers = {"User-Agent": "pool-worker"}
        if have:
            headers["Range"] = "bytes=" + str(have) + "-"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            mode = "ab" if (have and r.status == 206) else "wb"
            if mode == "wb":
                have = 0
            with open(dest, mode) as f:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
        digest = self._sha256(dest)
        if digest != want_sha:
            raise SystemExit("SHA-256 mismatch on " + name +
                             " — refusing to use it")

    def ensure_engine(self):
        backend = self.detect_backend()
        manifest = self.fetch_manifest()
        pin, names, by_name = self.pick_components(
            manifest, backend, plat=self.cfg.get("platform") or None)
        stamp = os.path.join(self.engine_dir, ".pin")
        want_stamp = "b" + str(pin) + "-" + backend
        rpc = self.find_rpc()
        if rpc and os.path.isfile(stamp):
            with open(stamp) as f:
                if f.read().strip() == want_stamp:
                    log("engine current: pin b" + str(pin) +
                        " (" + backend + ")")
                    return backend, pin
        log("fetching engine: pin b" + str(pin) + " (" + backend + ")")
        dl_dir = os.path.join(self.dir, "downloads")
        os.makedirs(dl_dir, exist_ok=True)
        archives = []
        grouped = {}
        for name in names:
            grouped.setdefault(name.split(".part")[0], []).append(name)
        for base, parts in grouped.items():
            local = os.path.join(dl_dir, base)
            if len(parts) == 1 and parts[0] == base:
                self.download(base, by_name[base]["sha256"], local)
            else:
                part_paths = []
                for p in sorted(parts):
                    pp = os.path.join(dl_dir, p)
                    self.download(p, by_name[p]["sha256"], pp)
                    part_paths.append(pp)
                with open(local, "wb") as out:
                    for pp in part_paths:
                        with open(pp, "rb") as f:
                            shutil.copyfileobj(f, out)
                log("joined " + str(len(part_paths)) + " parts -> " + base)
            archives.append(local)
        if os.path.isdir(self.engine_dir):
            shutil.rmtree(self.engine_dir)
        os.makedirs(self.engine_dir)
        for arc in archives:
            if arc.endswith(".zip"):
                import zipfile
                # zipfile.extractall sanitizes absolute paths and
                # '..' itself; the component is SHA-256-verified
                # against the pool's own manifest either way.
                with zipfile.ZipFile(arc) as zf:
                    zf.extractall(self.engine_dir)
            else:
                with tarfile.open(arc, "r:gz") as tf:
                    try:
                        tf.extractall(self.engine_dir, filter="data")
                    except TypeError:  # older Python without PEP 706 filters
                        tf.extractall(self.engine_dir)
        with open(stamp, "w") as f:
            f.write(want_stamp)
        if not self.find_rpc():
            raise SystemExit("engine installed but ggml-rpc-server "
                             "not found inside it")
        log("engine ready: pin b" + str(pin) + " (" + backend + ")")
        return backend, pin

    def find_rpc(self):
        for root, _dirs, files in os.walk(self.engine_dir):
            if "ggml-rpc-server" in files or "ggml-rpc-server.exe" in files:
                name = "ggml-rpc-server" if "ggml-rpc-server" in files \
                    else "ggml-rpc-server.exe"
                return os.path.join(root, name)
        return None

    def engine_env(self):
        env = dict(os.environ)

        def _is_lib(f):
            return (f.startswith("libcudart.so") or
                    f.startswith("libcublas.so") or
                    f.startswith("libggml") or
                    f.startswith("cudart64") or
                    f.startswith("cublas64") or
                    (f.startswith("ggml") and f.endswith(".dll")))

        lib_dirs = []
        for root, _dirs, files in os.walk(self.engine_dir):
            if any(_is_lib(f) for f in files):
                lib_dirs.append(root)
        if self.android:
            # The Adreno engine links the vendor's libOpenCL.so.
            for vd in ("/vendor/lib64", "/system/vendor/lib64"):
                if os.path.isfile(os.path.join(vd, "libOpenCL.so")):
                    lib_dirs.append(vd)
                    break
        if lib_dirs:
            key = "LD_LIBRARY_PATH" if platform.system() != "Windows" \
                else "PATH"
            env[key] = os.pathsep.join(
                lib_dirs + ([env[key]] if env.get(key) else []))
        return env

    # ---------------------------------------------------------- relay
    def ws_connect(self):
        parsed = urlparse(self.cfg["pool_url"])
        host = parsed.hostname
        tls = parsed.scheme == "https"
        port = parsed.port or (443 if tls else 80)
        raw = socket.create_connection((host, port), timeout=30)
        nodelay(raw)
        if tls:
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        lines = [
            "GET /relay HTTP/1.1",
            "Host: " + host,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: " + key,
            "Sec-WebSocket-Version: 13",
            "X-Enrollment-Id: " + self.cfg["enrollment_id"],
            "X-Enrollment-Key: " + self.cfg["key"],
            "", "",
        ]
        raw.sendall("\r\n".join(lines).encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = raw.recv(4096)
            if not chunk:
                raise ConnectionError("relay handshake: connection closed")
            resp += chunk
        head, _, rest = resp.partition(b"\r\n\r\n")
        status = head.split(b"\r\n")[0].decode(errors="replace")
        if " 101" not in status:
            raw.close()
            raise ConnectionError("relay refused: " + status)
        accept = ""
        for line in head.split(b"\r\n")[1:]:
            if line.lower().startswith(b"sec-websocket-accept:"):
                accept = line.split(b":", 1)[1].strip().decode()
        want = base64.b64encode(hashlib.sha1(
            (key + WS_GUID).encode()).digest()).decode()
        if accept != want:
            raw.close()
            raise ConnectionError("relay handshake: bad accept key "
                                  "(not the real pool front?)")
        raw.settimeout(RELAY_IO_TIMEOUT)
        return WSConn(raw, rest)

    # ---------------------------------------------------------- rpc
    @property
    def rpc_log_path(self):
        return os.path.join(self.dir, "rpc-server.log")

    def _rpc_log(self):
        path = self.rpc_log_path
        try:
            if os.path.getsize(path) > RPC_LOG_MAX:
                os.replace(path, path + ".old")
        except OSError:
            pass
        f = open(path, "ab")
        f.write(("\n===== " + time.strftime("%Y-%m-%d %H:%M:%S") +
                 " rpc-server start =====\n").encode())
        f.flush()
        return f

    def start_rpc(self):
        rpc = self.find_rpc()
        port = int(self.cfg["rpc_port"])
        base = [rpc, "-H", "127.0.0.1", "-p", str(port)]
        if self.android:
            # One device per endpoint, always: the host's tensor split
            # counts RPC devices, and the Snapdragon engine would
            # otherwise also offer the Hexagon NPU.
            dev = self.android_device()
            base += ["-d", dev]
            self.rpc_device = dev
            log("this phone serves its slice on " +
                ("its Adreno GPU (OpenCL)" if dev == "GPUOpenCL"
                 else "its CPU"))
        tries = [base + ["-c"], base] if self.cfg.get("rpc_cache") else [base]
        for cmd in tries:
            log("starting rpc-server on 127.0.0.1:" + str(port) +
                (" with its local tensor cache" if "-c" in cmd else "") +
                " (output: " + self.rpc_log_path + ")")
            logf = self._rpc_log()
            try:
                self.rpc_proc = subprocess.Popen(
                    cmd, env=self.engine_env(),
                    stdout=logf, stderr=subprocess.STDOUT)
            finally:
                logf.close()
            for _ in range(50):
                if self.rpc_proc.poll() is not None:
                    break
                try:
                    with socket.create_connection(("127.0.0.1", port),
                                                  timeout=1):
                        self.rpc_cache_on = "-c" in cmd
                        return
                except OSError:
                    time.sleep(0.2)
            else:
                raise SystemExit("rpc-server did not open its port — see " +
                                 self.rpc_log_path)
            if "-c" in cmd:
                log("rpc-server refused the cache flag — starting it "
                    "without the cache (see " + self.rpc_log_path + ")")
        raise SystemExit("rpc-server exited at startup — see " +
                         self.rpc_log_path)

    def android_device(self):
        if self.detect_backend() != "opencl":
            return "CPU"
        model = ""
        try:
            status, info = self.http_json("GET", "/model.json", timeout=20)
            if status == 200:
                model = info.get("file") or ""
        except Exception:
            pass
        if model and model_gpu_ok_opencl(model):
            return "GPUOpenCL"
        if model:
            log("the pool's model (" + model + ") has expert layers the "
                "phone's GPU can't compute (it needs an MXFP4, Q4_0 or "
                "Q8_0 file) — lending RAM + CPU instead")
        return "CPU"

    def stop_rpc(self):
        if self.rpc_proc and self.rpc_proc.poll() is None:
            self.rpc_proc.terminate()
            try:
                self.rpc_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.rpc_proc.kill()
        self.rpc_proc = None
    # ---------------------------------------------------------- owner-first
    def paused(self):
        return os.path.isfile(self.pause_path)

    def on_battery(self):
        if not self.cfg["battery_yield"]:
            return False
        if platform.system() == "Windows":
            try:
                import ctypes

                class SYSTEM_POWER_STATUS(ctypes.Structure):
                    _fields_ = [("ACLineStatus", ctypes.c_byte),
                                ("BatteryFlag", ctypes.c_byte),
                                ("BatteryLifePercent", ctypes.c_byte),
                                ("SystemStatusFlag", ctypes.c_byte),
                                ("BatteryLifeTime", ctypes.c_ulong),
                                ("BatteryFullLifeTime", ctypes.c_ulong)]
                sps = SYSTEM_POWER_STATUS()
                if ctypes.windll.kernel32.GetSystemPowerStatus(
                        ctypes.byref(sps)):
                    # ACLineStatus 0 = running on battery. BatteryFlag
                    # 128 = no battery at all (a desktop) — never yield.
                    return (sps.ACLineStatus == 0 and
                            sps.BatteryFlag != 128)
            except Exception:
                pass
            return False
        if self.android:
            st = self.termux_battery()
            if st:
                return str(st.get("plugged", "")).upper() == "UNPLUGGED"
        base = "/sys/class/power_supply"
        try:
            for name in os.listdir(base):
                dev = os.path.join(base, name)
                with open(os.path.join(dev, "type")) as f:
                    if f.read().strip() != "Battery":
                        continue
                with open(os.path.join(dev, "status")) as f:
                    if f.read().strip() == "Discharging":
                        return True
        except Exception:
            pass
        return False

    def termux_battery(self):
        """termux-battery-status (the Termux:API add-on), or None."""
        exe = shutil.which("termux-battery-status")
        if not exe:
            return None
        try:
            out = subprocess.run([exe], capture_output=True, text=True,
                                 timeout=15)
            return json.loads(out.stdout) if out.returncode == 0 else None
        except Exception:
            return None

    def gpu_temp(self):
        smi = nvidia_smi_cmd()
        if not smi:
            return None
        try:
            out = subprocess.run(
                [smi, "--query-gpu=temperature.gpu",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10)
            if out.returncode == 0:
                return int(out.stdout.strip().splitlines()[0])
        except Exception:
            pass
        return None

    def yield_reason(self):
        if self.paused():
            return "paused by owner (PAUSE file present)"
        if self.on_battery():
            return "running on battery"
        if self.android:
            st = self.termux_battery()
            t = (st or {}).get("temperature")
            lim = float(self.cfg.get("battery_temp_limit_c") or 42)
            if isinstance(t, (int, float)) and t >= lim:
                return ("battery at " + str(round(t, 1)) + "C (limit " +
                        str(lim) + "C)")
        temp = self.gpu_temp()
        if temp is not None and temp >= int(self.cfg["temp_limit_c"]):
            return "GPU at " + str(temp) + "C (limit " + \
                str(self.cfg["temp_limit_c"]) + "C)"
        return None

    # ---------------------------------------------------------- pre-download
    @property
    def seed_path(self):
        return os.path.join(self.dir, "seed.json")

    def _seed_load(self):
        try:
            with open(self.seed_path) as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("tensors"), dict):
                return data
        except (OSError, ValueError):
            pass
        return {"model": "", "size_bytes": 0, "tensors": {}, "complete": False}

    def _seed_save(self, data):
        tmp = self.seed_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, self.seed_path)

    def _seed_forget(self, data, cache):
        """Delete the cache files an earlier seed wrote (a model change)."""
        for hexname in set(data.get("tensors", {}).values()):
            try:
                os.remove(os.path.join(cache, hexname))
            except OSError:
                pass

    def device_check(self):
        """Android + Adreno: when the pool's model changes between a
        GPU-friendly quant and one the phone's GPU can't run, restart
        rpc-server on the right device (only while no split holds it)."""
        if not (self.android and self.rpc_device and
                self.detect_backend() == "opencl"):
            return
        status, info = self.http_json("GET", "/model.json", timeout=20)
        if status != 200 or not info.get("file"):
            return
        want = "GPUOpenCL" if model_gpu_ok_opencl(info["file"]) else "CPU"
        if want == self.rpc_device or (self.relay and self.relay.streams):
            return
        log("the pool's model changed — restarting rpc-server on " +
            ("the GPU" if want == "GPUOpenCL" else "the CPU"))
        if self.rpc_proc and self.rpc_proc.poll() is None:
            self.rpc_proc.terminate()  # the monitor restarts it

    def self_update_check(self):
        """Swap in the shelf's newer pool-worker.py and restart on it.
        Never while a split holds this machine: its RPC stream stays
        open for the whole split, so this waits until it ends."""
        if not self.cfg.get("self_update", True):
            return False
        if self.relay and self.relay.streams:
            return False
        me = os.path.abspath(__file__)
        try:
            manifest = self.fetch_manifest()
        except Exception:
            return False
        comp = next((c for c in manifest.get("components", [])
                     if c.get("name") == "pool-worker.py"), None)
        want = (comp or {}).get("sha256") or ""
        if not want or self._sha256(me) == want:
            return False
        new = me + ".new"
        try:
            if os.path.exists(new):
                os.remove(new)
            self.download("pool-worker.py", want, new)
            with open(new, "rb") as f:
                compile(f.read(), new, "exec")
        except (Exception, SystemExit) as e:
            log("self-update: could not fetch the newer pool-worker.py (" +
                (str(e) or type(e).__name__) + ") — keeping this one")
            try:
                os.remove(new)
            except OSError:
                pass
            return False
        if self.relay and self.relay.streams:
            os.remove(new)
            return False
        try:
            os.replace(new, me)
        except OSError as e:
            log("self-update: can't replace " + me + " (" + str(e) +
                ") — keeping this one")
            return False
        log("self-update: the pool has a newer pool-worker.py — "
            "restarting on it")
        self.restart = True
        self.stop_flag.set()
        if self.relay:
            self.relay.ws.close()
        return True

    def _seed_say_once(self, key, msg):
        said = getattr(self, "_seed_said", set())
        if key not in said:
            said.add(key)
            self._seed_said = said
            log(msg)

    def _seed_say_skip(self, why):
        if self._seed_skip_said != why:
            self._seed_skip_said = why
            log("pre-download is off: " + why)

    def seed_loop(self):
        while not self.stop_flag.is_set():
            try:
                if self.self_update_check():
                    return
            except Exception as e:
                log("self-update check failed: " +
                    (str(e) or type(e).__name__))
            try:
                self.device_check()
            except Exception:
                pass
            if not self.cfg.get("predownload"):
                self._seed_say_skip('"predownload" is false in ' +
                                    self.cfg_path)
            elif not self.cfg.get("rpc_cache"):
                self._seed_say_skip('"rpc_cache" is false in ' +
                                    self.cfg_path + " (the pre-download "
                                    "fills rpc-server's cache)")
            elif not self.rpc_cache_on:
                self._seed_say_skip("rpc-server would not start with its "
                                    "cache (-c); see " + self.rpc_log_path)
            if self.cfg.get("predownload") and self.cfg.get("rpc_cache") \
                    and self.rpc_cache_on:
                try:
                    self.seed_once()
                except Exception as e:
                    log("pre-download stopped: " +
                        (str(e) or type(e).__name__) +
                        " — trying again in " +
                        str(SEED_CHECK_SEC // 60) + " min")
                finally:
                    self._seed_tmp_cleanup()
            self.stop_flag.wait(SEED_CHECK_SEC)

    def _seed_tmp_cleanup(self):
        parts = os.path.join(rpc_cache_dir(), ".seed-parts")
        shutil.rmtree(parts, ignore_errors=True)

    def seed_once(self):
        status, info = self.http_json("GET", "/model.json", timeout=20)
        if status != 200 or not info.get("file"):
            return

        model, url = info["file"], info.get("url") or ""
        size = int(info.get("size_bytes") or 0)
        data = self._seed_load()
        cache = rpc_cache_dir()
        if data.get("complete") and data.get("model") == model and \
                data.get("size_bytes") == size:
            # Trust seed.json only as far as the cache still holds its
            # files: a cleanup tool, another user account (a different
            # LOCALAPPDATA) or an empty earlier pass leaves it "complete"
            # with nothing behind it, and this used to return silently.
            missing = [n for n, h in data["tensors"].items()
                       if not os.path.isfile(os.path.join(cache, h))]
            if data["tensors"] and not missing:
                self._seed_say_once("ready:" + model,
                                    "pre-download: ready — " +
                                    str(len(data["tensors"])) +
                                    " tensors of " + model + " in " + cache)
                return
            if missing:
                log("pre-download: " + str(len(missing)) + " of " +
                    str(len(data["tensors"])) + " cached tensors are gone "
                    "from " + cache + " — fetching them again")
                for n in missing:
                    del data["tensors"][n]
            else:
                log("pre-download: seed.json says done but lists no "
                    "tensors — starting over")
            data["complete"] = False
            self._seed_save(data)
        self._seed_say_once("check:" + model,
                            "pre-download: checking " + model +
                            " (cache " + cache + ")")
        if not url:
            if self._seed_warned != model:
                log("pre-download: the pool has no download source for " +
                    model + " yet (the operator adds it to "
                    "model-sources.json on the FX705) — its slice will "
                    "be sent over the network at the first split instead")
                self._seed_warned = model
            return
        if not seed_source_ok(url):
            log("pre-download: refusing a model source that is not "
                "Hugging Face over https: " + url)
            return
        if not size:
            log("pre-download: the pool did not say how big " + model +
                " is — skipping")
            return
        os.makedirs(cache, exist_ok=True)
        if data.get("model") != model or data.get("size_bytes") != size:
            if data.get("tensors"):
                log("pre-download: the pool's model changed — removing "
                    "the old pre-download")
                self._seed_forget(data, cache)
            data = {"model": model, "size_bytes": size, "tensors": {},
                    "complete": False}
            self._seed_save(data)
        free = shutil.disk_usage(cache).free
        if free < size + 1024 ** 3:
            log("pre-download: not enough free disk for " + model +
                " (needs about " + str(round(size / 1024 ** 3, 1)) +
                " GB + 1 GB spare in " + cache + ", has " +
                str(round(free / 1024 ** 3, 1)) + " GB) — skipping")
            return
        self._seed_run(url, model, size, info.get("sha256") or "",
                       data, cache)

    def _seed_open(self, url, start, size):
        headers = {"User-Agent": "pool-worker"}
        if start:
            headers["Range"] = "bytes=" + str(start) + "-"
        resp = urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=60)
        total = None
        cr = resp.headers.get("Content-Range")
        if start:
            if resp.status != 206 or not cr:
                resp.close()
                raise ConnectionError("the model host ignored the resume")
            total = int(cr.rsplit("/", 1)[1])
        else:
            total = int(resp.headers.get("Content-Length") or 0)
        if total != size:
            resp.close()
            raise ValueError("the download is " + str(total) +
                             " bytes but the pool's file is " + str(size) +
                             " — not the same model file")
        return resp

    def _seed_run(self, url, model, size, want_sha, data, cache):
        import concurrent.futures as cf
        resp = self._seed_open(url, 0, size)
        try:
            tensors, data_start, reader = gguf_read_header(resp)
        except Exception:
            resp.close()
            raise
        todo = [(n, o, b) for (n, o, b) in tensors
                if b is not None and b > SEED_MIN_BYTES
                and n not in data["tensors"]]
        total_big = sum(1 for (_n, _o, b) in tensors
                        if b is not None and b > SEED_MIN_BYTES)
        if not total_big:
            resp.close()
            unknown = sum(1 for (_n, _o, b) in tensors if b is None)
            self._seed_say_once("none:" + model,
                                "pre-download: found no tensor it can "
                                "cache in " + model + "'s header (" +
                                str(len(tensors)) + " tensors, " +
                                str(unknown) + " of an unknown type) — "
                                "the split will send this slice instead; "
                                "tell the operator")
            return
        if not todo:
            resp.close()
            data["complete"] = True
            self._seed_save(data)
            return
        log("pre-download: fetching " + model + " from Hugging Face so "
            "a split needs almost nothing from the pool — " +
            str(len(todo)) + " of " + str(total_big) + " large tensors "
            "to go (background, low priority)")
        fresh = len(todo) == total_big
        # A whole-file SHA-256 check is only possible on a fresh,
        # single-pass download (a resumed one never sees every byte).
        sha = hashlib.sha256() if (want_sha and fresh) else None
        # Re-open so the stream (and the optional SHA-256) starts cleanly
        # at the first tensor that is still missing.
        first = data_start + todo[0][1]
        if sha is not None:
            resp.close()
            resp = self._seed_open(url, 0, size)
            pos = 0
        elif reader.pos <= first and first - reader.pos <= SEED_SKIP_MAX:
            pos = reader.pos
        else:
            resp.close()
            resp = self._seed_open(url, first, size)
            pos = first
        parts = os.path.join(cache, ".seed-parts")
        os.makedirs(parts, exist_ok=True)
        workers = max(1, (os.cpu_count() or 2) - 1)
        pending = {}
        done_since_save = 0

        def collect(block):
            nonlocal done_since_save
            if not pending:
                return
            finished, _ = cf.wait(list(pending),
                                  return_when=(cf.ALL_COMPLETED if block
                                               else cf.FIRST_COMPLETED),
                                  timeout=None if block else 0)
            for fut in finished:
                name, path = pending.pop(fut)
                try:
                    h = fut.result()[1]
                except Exception:
                    # No worker processes on this machine (some Python
                    # builds can't spawn them): hash it here instead.
                    h = fnv1a64_file(path)
                hexname = "%016x" % h
                dest = os.path.join(cache, hexname)
                if os.path.exists(dest):
                    os.remove(path)
                else:
                    os.replace(path, dest)
                data["tensors"][name] = hexname
                done_since_save += 1
            if done_since_save >= 8:
                self._seed_save(data)
                done_since_save = 0

        def skip_to(target):
            nonlocal pos
            while pos < target:
                if self.stop_flag.is_set():
                    raise ConnectionError("worker stopping")
                chunk = resp.read(min(1 << 20, target - pos))
                if not chunk:
                    raise ConnectionError("model download ended early")
                if sha is not None:
                    sha.update(chunk)
                pos += len(chunk)

        started = time.time()
        with cf.ProcessPoolExecutor(max_workers=workers,
                                    initializer=_seed_pool_init) as pool:
            try:
                for i, (name, off, nb) in enumerate(todo):
                    skip_to(data_start + off)
                    part = os.path.join(parts, str(i) + ".part")
                    left = nb
                    with open(part, "wb") as f:
                        while left:
                            if self.stop_flag.is_set():
                                raise ConnectionError("worker stopping")
                            chunk = resp.read(min(1 << 20, left))
                            if not chunk:
                                raise ConnectionError(
                                    "model download ended early")
                            f.write(chunk)
                            if sha is not None:
                                sha.update(chunk)
                            left -= len(chunk)
                            pos += len(chunk)
                    pending[pool.submit(_seed_hash_job, part)] = (name, part)
                    collect(block=False)
                    if (i + 1) % 50 == 0:
                        log("pre-download: " + str(i + 1) + "/" +
                            str(len(todo)) + " tensors downloaded")
                if sha is not None:
                    skip_to(size)
                collect(block=True)
            finally:
                resp.close()
                self._seed_save(data)
        if sha is not None and sha.hexdigest() != want_sha.lower():
            log("pre-download: SHA-256 mismatch for " + model +
                " — discarding it (the split will send the slice instead)")
            self._seed_forget(data, cache)
            data["tensors"] = {}
            self._seed_save(data)
            return
        data["complete"] = True
        self._seed_save(data)
        log("pre-download done: " + str(len(data["tensors"])) +
            " tensors of " + model + " ready in " + cache + " (" +
            str(round((time.time() - started) / 60, 1)) + " min)")

    def seed_check(self):
        """After a split stream ends: if rpc-server wrote cache files
        the pre-download did not, the host sent those tensors itself —
        say so, so a mismatch with the pinned build is visible."""
        data = self._seed_load()
        if not data.get("complete"):
            return
        ours = set(data["tensors"].values())
        try:
            extra = [n for n in os.listdir(rpc_cache_dir())
                     if len(n) == 16 and n not in ours]
        except OSError:
            return
        if extra and len(extra) != self._seed_extra_seen:
            self._seed_extra_seen = len(extra)
            log("pre-download check: rpc-server has cached " +
                str(len(extra)) + " tensor(s) the pre-download did not "
                "cover — those were sent over the network. If that is "
                "most of this machine's slice, the pre-download does not "
                "match this llama.cpp build; tell the operator.")

    # ---------------------------------------------------------- serve
    def _monitor(self, session, yield_flag):
        while session.alive and not self.stop_flag.is_set():
            reason = self.yield_reason()
            if reason:
                log("yielding: " + reason + " — draining")
                yield_flag.append(reason)
                session.ws.close()
                return
            if self.rpc_proc and self.rpc_proc.poll() is not None:
                log("rpc-server died — dropping the relay to restart it")
                session.ws.close()
                return
            time.sleep(2)

    def serve(self):
        backoff = 2
        while not self.stop_flag.is_set():
            reason = self.yield_reason()
            if reason:
                log("yielding: " + reason)
                self.stop_rpc()
                while not self.stop_flag.is_set() and self.yield_reason():
                    self.stop_flag.wait(10)
                delay = int(self.cfg["rejoin_delay_sec"])
                if delay and not self.stop_flag.is_set():
                    log("machine free — rejoining in " + str(delay) + "s")
                    self.stop_flag.wait(delay)
                continue
            if not self.rpc_proc or self.rpc_proc.poll() is not None:
                try:
                    self.start_rpc()
                except SystemExit as e:
                    if self.android and self.detect_backend() == "opencl":
                        log("the Adreno engine would not start (" + str(e) +
                            ") — switching this phone to the CPU engine")
                        self.cfg["backend"] = "cpu"
                        self.save_cfg()
                        self.ensure_engine()
                        continue
                    raise
            if self._seed_thread is None:
                # After rpc-server is up: the pre-download only makes
                # sense once we know its cache flag was accepted.
                self._seed_thread = threading.Thread(target=self.seed_loop,
                                                     daemon=True)
                self._seed_thread.start()
            try:
                ws = self.ws_connect()
            except ConnectionError as e:
                if "403" in str(e):
                    log("relay refused (enrollment not approved) — "
                        "back to waiting for approval")
                    self.stop_rpc()
                    if not self.wait_for_approval():
                        return
                    continue
                log("relay connect failed: " + str(e))
                self.stop_flag.wait(backoff)
                backoff = min(30, backoff * 2)
                continue
            backoff = 2
            log("relay connected — this machine is in the pool")
            session = RelaySession(self, ws)
            self.relay = session
            yield_flag = []
            threading.Thread(target=self._monitor,
                             args=(session, yield_flag),
                             daemon=True).start()
            session.run()
            self.relay = None
            if yield_flag:
                grace = int(self.cfg["drain_grace_sec"])
                log("draining (" + str(grace) + "s grace), then "
                    "rpc-server stops")
                self.stop_flag.wait(grace)
                self.stop_rpc()
            elif not self.stop_flag.is_set():
                self.stop_flag.wait(3)
        self.stop_rpc()




class WSConn:
    """A client WebSocket: frames we send are masked (RFC 6455)."""

    def __init__(self, sock, buffered=b""):
        self.sock = sock
        self.buf = buffered
        self.send_lock = threading.Lock()
        self.last_rx = time.time()

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("relay closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read_frame(self):
        payload = b""
        opcode = None
        while True:
            b1, b2 = self.read_exact(2)
            fin, op = b1 & 0x80, b1 & 0x0F
            masked, length = b2 & 0x80, b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self.read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self.read_exact(8))[0]
            mask = self.read_exact(4) if masked else None
            data = self.read_exact(length) if length else b""
            if mask:
                data = ws_mask(data, mask)
            self.last_rx = time.time()
            if op in (0, 1, 2):
                if opcode is None:
                    opcode = op
                payload += data
                if fin:
                    return opcode, payload
            else:
                return op, data

    def send_frame(self, opcode, payload):
        mask = secrets.token_bytes(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = ws_mask(payload, mask)
        with self.send_lock:
            self.sock.sendall(bytes(header) + masked)

    def close(self):
        try:
            self.send_frame(8, b"")
        except OSError:
            pass
        # shutdown before close: a recv blocked in another thread only
        # wakes on shutdown (close alone can leave it hanging).
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class RelaySession:
    """One connected relay WebSocket, forwarding streams between the
    front and this machine's local rpc-server."""

    def __init__(self, worker, ws):
        self.worker = worker
        self.ws = ws
        self.streams = {}
        self.lock = threading.Lock()
        self.alive = True
        # Pool meter (M9): how long this machine's rpc-server takes to
        # answer each request, measured here so the pool can tell this
        # machine's compute apart from the network in between. Only
        # timings and memory are reported, never any data.
        self.stat_lock = threading.Lock()
        self.session = secrets.token_hex(4)
        self.pending = {}      # sid -> when the host's request arrived
        self.last_rx = {}      # sid -> the host's latest bytes
        self.ex = 0
        self.busy_ms = 0.0
        self.bytes_in = 0
        self.bytes_out = 0
        self.mem = {}
        self.mem_at = 0.0

    def send_stream(self, sid, typ, data=b""):
        try:
            self.ws.send_frame(2, struct.pack(">IB", sid, typ) + data)
            return True
        except OSError:
            return False

    def _mem(self):
        """RAM free/total and, with an NVIDIA card, VRAM used/total —
        refreshed every 15 s at most."""
        now = time.time()
        if now - self.mem_at < 15:
            return self.mem
        self.mem_at = now
        out = {}
        try:
            out["ram_total_mb"] = self.worker.total_ram_mb()
            avail = None
            if platform.system() == "Windows":
                import ctypes

                class MS(ctypes.Structure):
                    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
                st = MS()
                st.dwLength = ctypes.sizeof(MS)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                    avail = int(st.ullAvailPhys // (1024 * 1024))
            else:
                with open("/proc/meminfo") as f:
                    for line in f:
                        if line.startswith("MemAvailable:"):
                            avail = int(line.split()[1]) // 1024
            if avail is not None:
                out["ram_avail_mb"] = avail
        except Exception:
            pass
        smi = None if self.worker.android else nvidia_smi_cmd()
        if smi:
            try:
                r = subprocess.run([smi, "--query-gpu=memory.used,memory.total",
                                    "--format=csv,noheader,nounits"],
                                   capture_output=True, text=True, timeout=10)
                used, total = [int(float(x)) for x in r.stdout.strip().splitlines()[0].split(",")]
                out["vram_used_mb"], out["vram_total_mb"] = used, total
            except Exception:
                pass
        self.mem = out
        return out

    def _stats_loop(self):
        """Send the host this machine's own timings five times a second
        while they change (every 15 s otherwise), on stream 0 as type 4.
        An older pool front ignores the message."""
        last = None
        last_at = 0.0
        while self.alive:
            time.sleep(0.2)
            with self.stat_lock:
                rep = {"v": 1, "session": self.session, "ex": self.ex,
                       "busy_ms": round(self.busy_ms, 1),
                       "bytes_in": self.bytes_in, "bytes_out": self.bytes_out}
            key = json.dumps(rep, sort_keys=True)
            if key == last and time.time() - last_at < 15:
                continue
            rep["mem"] = self._mem()
            last, last_at = key, time.time()
            if not self.send_stream(0, 4, json.dumps(rep).encode()):
                return

    def run(self):
        threading.Thread(target=self._heartbeat, daemon=True).start()
        threading.Thread(target=self._stats_loop, daemon=True).start()
        try:
            while self.alive and not self.worker.stop_flag.is_set():
                op, payload = self.ws.read_frame()
                if op == 9:
                    self.ws.send_frame(10, payload)
                elif op == 8:
                    break
                elif op in (1, 2) and len(payload) >= 5:
                    sid, typ = struct.unpack(">IB", payload[:5])
                    data = payload[5:]
                    if typ == 1:
                        self._open(sid)
                    elif typ == 2:
                        now = time.time()
                        with self.stat_lock:
                            self.bytes_in += len(data)
                            # A request with no answer, then a quiet
                            # gap: the clock restarts at the next one.
                            if (sid not in self.pending or
                                    now - self.last_rx.get(sid, now) > 1.0):
                                self.pending[sid] = now
                            self.last_rx[sid] = now
                        with self.lock:
                            local = self.streams.get(sid)
                        if local:
                            try:
                                local.sendall(data)
                            except OSError:
                                self._close(sid, notify=True)
                    elif typ == 3:
                        if sid in self.streams:
                            log("split stream " + str(sid) +
                                " closed by the host")
                        self._close(sid, notify=False)
        except (ConnectionError, OSError) as e:
            if not self.worker.stop_flag.is_set():
                log("relay dropped: " + (str(e) or type(e).__name__) +
                    " — reconnecting")
        finally:
            self.alive = False
            for sid in list(self.streams):
                self._close(sid, notify=False)
            self.ws.close()

    def _heartbeat(self):
        while self.alive:
            time.sleep(30)
            if not self.alive:
                return
            if time.time() - self.ws.last_rx > 90:
                log("relay silent for 90s — reconnecting")
                self.ws.close()   # forces read_frame to raise -> reconnect
                return
            try:
                self.ws.send_frame(9, b"")
            except OSError:
                return

    def _open(self, sid):
        try:
            local = socket.create_connection(
                ("127.0.0.1", int(self.worker.cfg["rpc_port"])), timeout=10)
        except OSError as e:
            log("split stream " + str(sid) + ": cannot reach the local "
                "rpc-server (" + str(e) + ")")
            self.send_stream(sid, 3)
            return
        # The 10 s was for connecting only. An RPC link sits silent for
        # minutes in a split (while the host loads the other machines'
        # layers, and between requests); a timeout left on this socket
        # cut the stream after 10 quiet seconds and killed the split.
        local.settimeout(None)
        nodelay(local)
        log("split stream " + str(sid) + " opened (the host connected)")
        with self.lock:
            self.streams[sid] = local
        threading.Thread(target=self._pump, args=(sid, local),
                         daemon=True).start()

    def _pump(self, sid, local):
        why = "the relay closed"
        try:
            while self.alive:
                data = local.recv(CHUNK)
                if not data:
                    why = "rpc-server closed it"
                    break
                now = time.time()
                with self.stat_lock:
                    self.bytes_out += len(data)
                    opened = self.pending.pop(sid, None)
                    if opened is not None:
                        self.ex += 1
                        self.busy_ms += (now - opened) * 1000.0
                if not self.send_stream(sid, 2, data):
                    why = "sending to the relay failed"
                    break
        except OSError as e:
            why = "rpc-server socket error: " + (str(e) or type(e).__name__)
        finally:
            if sid in self.streams:
                log("split stream " + str(sid) + " closed: " + why)
            self._close(sid, notify=True)
            try:
                self.worker.seed_check()
            except Exception:
                pass

    def _close(self, sid, notify):
        with self.stat_lock:
            self.pending.pop(sid, None)
            self.last_rx.pop(sid, None)
        with self.lock:
            local = self.streams.pop(sid, None)
        if local:
            try:
                local.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                local.close()
            except OSError:
                pass
        if notify:
            self.send_stream(sid, 3)



def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description="AI Pool worker (M5b)")
    ap.add_argument("--config", default="")
    ap.add_argument("--name", default="",
                    help="machine name (default: this PC's hostname)")
    ap.add_argument("--offered-mb", type=int, default=0,
                    help="memory to offer, MB (default: a "
                         "conservative auto-size)")
    ap.add_argument("--backend", default="")
    ap.add_argument("--enroll-only", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    if args.config:
        cfg_path = args.config
    else:
        wdir = os.environ.get("POOL_WORKER_DIR") or \
            os.path.join(os.path.expanduser("~"), "pool-worker")
        os.makedirs(wdir, exist_ok=True)
        cfg_path = os.path.join(wdir, "config.json")
    os.makedirs(os.path.dirname(cfg_path) or ".", exist_ok=True)
    global _log_path
    _log_path = os.path.join(os.path.dirname(cfg_path) or ".",
                             "pool-worker.log")
    w = Worker(cfg_path)
    changed = False
    for key, val in (("name", args.name), ("offered_mb", args.offered_mb),
                     ("backend", args.backend)):
        if val:
            w.cfg[key] = val
            changed = True
    if changed:
        w.save_cfg()

    def _sig(_signum, _frame):
        w.stop_flag.set()
    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)

    w.ensure_enrolled()
    if args.enroll_only:
        log("status: " + (w.poll_status() or "unreachable"))
        return 0
    if args.check:
        log("enrollment: " + (w.poll_status() or "unreachable"))
        backend = w.detect_backend()
        manifest = w.fetch_manifest()
        pin, names, _ = w.pick_components(manifest, backend)
        log("shelf pin for " + backend + ": b" + str(pin) +
            " (" + ", ".join(names) + ")")
        return 0
    if not w.wait_for_approval():
        return 0
    log("approved! If you haven't already, link this machine to "
        "your pool account so its earnings land in your balance:")
    log("  " + w.cfg["pool_url"].rstrip("/") + "/chat#link=" +
        w.cfg["enrollment_id"] + "." + w.cfg["key"])
    log("(Open it, save your account key on that page, and click "
        "'Link machine' — the form fills itself in.)")
    w.ensure_engine()
    log("serving — rpc stays on localhost; the relay is the only "
        "way in. Ctrl+C / SIGTERM drains and exits.")
    w.serve()
    if w.restart:
        # Same arguments, the updated script. On Windows exec would
        # leave the console to the .bat's "pause" mid-run, so wait on
        # the new process instead.
        cmd = [sys.executable, os.path.abspath(__file__)] + list(argv)
        if platform.system() == "Windows":
            return subprocess.call(cmd)
        os.execv(sys.executable, cmd)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
