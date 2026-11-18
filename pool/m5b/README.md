# M5b — the worker app + dial-out relay

The downloadable worker and the relay that lets an approved machine
hold model slices without any inbound port, anywhere:

- `pool-worker.py` (on the worker PC) enrolls the machine, waits for
  the operator's approval, downloads the pool's **pinned** llama.cpp
  engine from the downloads shelf (every component SHA-256-verified
  against the manifest; split components are joined back together),
  and runs `ggml-rpc-server` bound to the machine's **localhost
  only**. Nothing on a worker PC listens to any network.
- The worker holds **one persistent outbound WebSocket** to the
  front door (`wss://pool.tavernworks.dev/relay`, gated by the
  enrollment id + key; only `approved` enrollments get in). The
  front — relay code added to `pool-front.py` in this milestone —
  bridges it to a **per-machine localhost port on the FX705**
  (127.0.0.1:51100+), which is what `llama-server --rpc` will target
  in M5c. Live assignments are written to `~/ai-pool/relay-state.json`.
- **Revoking an enrollment cuts its relay** (checked every 15 s).
- Owner-first: a `PAUSE` file in the worker dir, running on battery,
  or a GPU at/over the temperature limit (default 85 °C) each drain
  the worker out of the pool — relay first, rpc-server after a short
  grace — and it rejoins only after a quiet delay (default 10 min).

Sandbox suite: 13/13 (relay auth negatives, engine download +
SHA-256 + extraction for Vulkan and CUDA incl. the two-part cudart
join, 1-byte / 1 MiB / concurrent-stream echo through the full
tunnel, PAUSE drain + rejoin, revocation cut).

## FX705 — refresh the front + coordinator

The relay lives in the front door, so refresh `pool-front.py` (and
the coordinator, for its updated enrollment status text):

```
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5/pool-front.py" -o /opt/ai-pool/pool-front.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m3/pool-coordinator.py" -o /opt/ai-pool/pool-coordinator.py
sudo systemctl restart pool-front pool-coordinator
```

## FX705 — stock the remaining engines + the worker itself

So non-CUDA workers can fetch their engine (and anyone can fetch
the worker from the pool's own domain):

```
cd ~/ai-pool/downloads
curl -fL -o llama-b12359-vulkan-x64.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-ubuntu-vulkan-x64.tar.gz
curl -fL -o llama-b12359-cpu-x64.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-ubuntu-x64.tar.gz
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5b/pool-worker.py" -o pool-worker.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5b/install-worker.sh" -o install-worker.sh
curl -s http://127.0.0.1:8092/downloads/manifest.json
```

The manifest should now list seven components, every one ≤ 512 MB.

## A worker PC (Linux) — the easy path

```
curl -fsSL https://pool.tavernworks.dev/downloads/install-worker.sh -o install-worker.sh
bash install-worker.sh
```

The installer fetches `pool-worker.py` from the shelf and starts
it. First run enrolls this machine — the name defaults to its
hostname and the offered memory to a conservative auto-size
(override either with `--name` / `--offered-mb`) — and waits.
Approve the machine on the coordinator
(http://100.100.40.72:8091/ → Enrollments (public) → Approve). The
worker then downloads its engine from the shelf, starts rpc-server
on its own localhost, and connects the relay. Ctrl+C drains and
exits.

On approval the worker prints a personal
`https://pool.tavernworks.dev/chat#link=…` URL: the contributor
opens it, saves their account key on that page, and clicks Link
machine — the form pre-fills from the fragment. That link is how
the machine's earnings reach their account balance.

- Backend: auto = CUDA when `nvidia-smi` exists, else Vulkan. Force
  one with `--backend cpu` (or `"backend"` in `~/pool-worker/config.json`).
- Yield any time: `touch ~/pool-worker/PAUSE`; remove the file to rejoin.
- As a boot service (root): enroll interactively first (above), then

```
sudo cp ~/pool-worker/pool-worker.py /opt/ai-pool/
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5b/pool-worker.service" -o /tmp/pool-worker.service
sudo cp /tmp/pool-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pool-worker
```

## How you know it worked

- The worker logs `relay connected — this machine is in the pool`.
- On the FX705, `cat ~/ai-pool/relay-state.json` lists the machine
  with its `127.0.0.1:<port>` rpc address. M5c teaches the host to
  build its `--rpc` list from exactly this file.
