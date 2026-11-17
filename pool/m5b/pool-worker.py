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
# Python 3 standard library only. Linux is the proven platform;
# the code avoids Unix-only calls where it can.
#
# Config lives in <worker dir>/config.json (worker dir: env
# POOL_WORKER_DIR, else ~/pool-worker). First run creates it:
#   python3 pool-worker.py --name my-pc --offered-mb 8192
# Test hooks: config keys pool_url, rpc_port, engine_dir,
# rejoin_delay_sec, drain_grace_sec, temp_limit_c.
import base64
import hashlib
import json
import os
import platform
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
}


def log(msg):
    print("[pool-worker] " + msg, flush=True)


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
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10)
            name = out.stdout.strip().splitlines()
            if out.returncode == 0 and name:
                return name[0].strip()
        except Exception:
            pass
        return ""

    def ensure_enrolled(self):
        if self.cfg["enrollment_id"] and self.cfg["key"]:
            return
        name = self.cfg["name"]
        offered = int(self.cfg["offered_mb"] or 0)
        if not name or offered < 512:
            raise SystemExit(
                "first run needs --name and --offered-mb (512 or more):\n"
                "  python3 pool-worker.py --name my-pc --offered-mb 8192")
        code, obj = self.http_json("POST", "/enroll", {
            "name": name, "offered_mb": offered,
            "gpu": self.detect_gpu() or "unknown",
            "os": (platform.system() or "unknown").lower()})
        if code != 201:
            raise SystemExit("enrollment failed: " + json.dumps(obj))
        self.cfg["enrollment_id"] = obj["id"]
        self.cfg["key"] = obj["key"]
        self.save_cfg()
        log("enrolled as " + obj["id"] + " — key saved to config. "
            "Waiting for the operator to approve this machine.")

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
        if want in ("cuda", "vulkan", "cpu"):
            return want
        if self.detect_gpu():
            return "cuda"
        return "vulkan"

    def fetch_manifest(self):
        url = self.cfg["pool_url"].rstrip("/") + "/downloads/manifest.json"
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.loads(r.read().decode())

    @staticmethod
    def _pin_of(name):
        # llama-b12359-cuda-12.8-x64.tar.gz -> 12359
        try:
            return int(name.split("-")[1].lstrip("b"))
        except Exception:
            return -1

    def pick_components(self, manifest, backend):
        """Returns (pin, [component names in download order]).
        Split components (…tar.gz.partNN) are grouped under their
        base name and ordered by suffix."""
        groups = {}
        for comp in manifest.get("components", []):
            name = comp["name"]
            base, part = name, None
            if ".part" in name:
                base, _, suffix = name.partition(".part")
                part = suffix
            groups.setdefault(base, []).append((part, comp))
        engines, cudarts = {}, {}
        for base, parts in groups.items():
            if base.startswith("llama-"):
                engines[base] = parts
            elif base.startswith("cudart-"):
                cudarts[base] = parts
        cands = [b for b in engines
                 if ("-" + backend + "-") in b or
                 ("-" + backend + ".") in b or backend in b.split("-")]
        if not cands:
            raise SystemExit("the shelf has no " + backend +
                             " engine component — tell the operator")
        cands.sort(key=lambda b: self._pin_of(b))
        engine_base = cands[-1]
        pin = self._pin_of(engine_base)
        chosen = [engine_base]
        if backend == "cuda":
            cc = [b for b in cudarts if self._pin_of(b) == pin]
            if not cc:
                raise SystemExit("the shelf has no cudart component "
                                 "for pin b" + str(pin))
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
        pin, names, by_name = self.pick_components(manifest, backend)
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
        lib_dirs = []
        for root, _dirs, files in os.walk(self.engine_dir):
            if any(f.startswith("libcudart.so") or
                   f.startswith("libcublas.so") for f in files):
                lib_dirs.append(root)
            if any(f.startswith("libggml") for f in files):
                lib_dirs.append(root)
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
        return WSConn(raw, rest)

    # ---------------------------------------------------------- rpc
    def start_rpc(self):
        rpc = self.find_rpc()
        port = int(self.cfg["rpc_port"])
        cmd = [rpc, "-H", "127.0.0.1", "-p", str(port)]
        log("starting rpc-server on 127.0.0.1:" + str(port))
        self.rpc_proc = subprocess.Popen(
            cmd, env=self.engine_env(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if self.rpc_proc.poll() is not None:
                raise SystemExit("rpc-server exited at startup")
            try:
                with socket.create_connection(("127.0.0.1", port),
                                              timeout=1):
                    return
            except OSError:
                time.sleep(0.2)
        raise SystemExit("rpc-server did not open its port")

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

    def gpu_temp(self):
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=temperature.gpu",
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
        temp = self.gpu_temp()
        if temp is not None and temp >= int(self.cfg["temp_limit_c"]):
            return "GPU at " + str(temp) + "C (limit " + \
                str(self.cfg["temp_limit_c"]) + "C)"
        return None

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
                self.start_rpc()
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
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
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
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.send_lock:
            self.sock.sendall(bytes(header) + masked)

    def close(self):
        try:
            self.send_frame(8, b"")
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

    def send_stream(self, sid, typ, data=b""):
        try:
            self.ws.send_frame(2, struct.pack(">IB", sid, typ) + data)
            return True
        except OSError:
            return False

    def run(self):
        threading.Thread(target=self._heartbeat, daemon=True).start()
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
                        with self.lock:
                            local = self.streams.get(sid)
                        if local:
                            try:
                                local.sendall(data)
                            except OSError:
                                self._close(sid, notify=True)
                    elif typ == 3:
                        self._close(sid, notify=False)
        except (ConnectionError, OSError):
            pass
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
        except OSError:
            self.send_stream(sid, 3)
            return
        with self.lock:
            self.streams[sid] = local
        threading.Thread(target=self._pump, args=(sid, local),
                         daemon=True).start()

    def _pump(self, sid, local):
        try:
            while self.alive:
                data = local.recv(CHUNK)
                if not data:
                    break
                if not self.send_stream(sid, 2, data):
                    break
        except OSError:
            pass
        finally:
            self._close(sid, notify=True)

    def _close(self, sid, notify):
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
    ap.add_argument("--name", default="")
    ap.add_argument("--offered-mb", type=int, default=0)
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
    w.ensure_engine()
    log("serving — rpc stays on localhost; the relay is the only "
        "way in. Ctrl+C / SIGTERM drains and exits.")
    w.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
