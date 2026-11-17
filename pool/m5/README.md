# AI Pool M5a — the public front door

A second small service on the FX705 (pool-front.py), exposed to the
internet ONLY through the pool.tavernworks.dev Cloudflare Tunnel.
It serves public-safe endpoints and nothing else:

- `GET /` — a small landing page with the pool's status summary.
- `GET /status.json` — proxied from the tailnet coordinator (the
  public pool page at tavernworks.dev/pool/ starts reading live
  status from here the moment the tunnel exists — no page change).
- `GET /downloads/` + `/downloads/manifest.json` — the component
  shelf: versioned files from `~/ai-pool/downloads/`, each with a
  SHA-256 in the manifest, served with HTTP Range so downloads
  resume. Design rule: no single component over 512 MB.
- `POST /enroll` — a machine registers (name, offered MB, GPU, OS)
  and gets an id + key. The key is shown once; only its SHA-256 is
  stored (in `~/ai-pool/enrollments.json`).
- `GET /enroll/<id>?key=...` — the machine polls its status.

Approval lives on the OTHER service: the tailnet control page
(:8091) gains an "Enrollments (public)" section with Approve/Revoke.
Approving means the machine MAY join — it cannot actually hold
model slices until the worker relay (M5b) exists; the poll answer
says so honestly.

The control page itself is never tunnel-exposed. The front binds
localhost; cloudflared is the only public face.

## Install (FX705, as root)

```sh
RAW="https://api.github.com/repos/sheastolp/tavernworks/contents"
H='Accept: application/vnd.github.raw'
curl -fsSL -H "$H" "$RAW/pool/m5/pool-front.py" -o /opt/ai-pool/pool-front.py
curl -fsSL -H "$H" "$RAW/pool/m3/pool-coordinator.py" -o /opt/ai-pool/pool-coordinator.py
curl -fsSL -H "$H" "$RAW/pool/m5/pool-front.service" -o /etc/systemd/system/pool-front.service
systemctl daemon-reload
systemctl restart pool-coordinator
systemctl enable --now pool-front
# First shelf stock: the engine archives already on this machine,
# under versioned names.
mkdir -p ~/ai-pool/downloads
cp ~/ai-pool/engine.tar.gz ~/ai-pool/downloads/llama-b12359-cuda-12.8-x64.tar.gz
cp ~/ai-pool/cudart.tar.gz ~/ai-pool/downloads/cudart-b12359-cuda-12.8-x64.tar.gz
ls -lh ~/ai-pool/downloads/
```

## The tunnel (Cloudflare, once)

1. Cloudflare Zero Trust → Networks → Tunnels → **Create a tunnel**,
   name it `pool`, choose the Debian environment, and run the
   install command it gives you on the FX705 (it carries the
   tunnel's token and sets cloudflared up as a service).
2. In the tunnel's **Public Hostnames**, add:
   `pool.tavernworks.dev` → HTTP → `localhost:8092`.
3. Check from anywhere: https://pool.tavernworks.dev/status.json
   shows the pool's live status, and
   https://tavernworks.dev/pool/ starts displaying it too.
