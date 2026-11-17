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
#
# Python 3 standard library only. Binds localhost by default —
# cloudflared is the public face. Test hooks: POOL_DIR,
# POOL_FRONT_BIND, POOL_FRONT_PORT, POOL_COORD_URL.
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
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

_lock = threading.Lock()
_hash_cache = {}
_status_cache = {"at": 0, "data": None}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
            "enrollment": "Not yet open — worker app in development",
            "speed": "—",
            "updated": datetime.now().strftime("%d %b %Y"),
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
                out["relay"] = "not yet configured — the worker relay arrives in M5b"
            return 200, out
    return 404, {"error": "no such enrollment"}


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
-d '{{"name":"my-pc","offered_mb":8192,"gpu":"RTX 4070","os":"windows"}}'</code></p>
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

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            st = pool_status()
            self._send(200, LANDING.format(
                brain=escape(str(st.get("brain", "—"))),
                model=escape(str(st.get("model", "—"))),
                serving=escape(str(st.get("serving", "—")))))
        elif path == "/status.json":
            self._json(200, pool_status())
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

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/enroll":
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
        code, obj = create_enrollment(fields)
        self._json(code, obj)


def main():
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    bind = os.environ.get("POOL_FRONT_BIND", "127.0.0.1")
    srv = ThreadingHTTPServer((bind, PORT), Handler)
    print("AI Pool front door on http://" + bind + ":" + str(PORT) +
          " (pool dir " + POOL_DIR + ")", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
