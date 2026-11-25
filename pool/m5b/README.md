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
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5b/install-worker.bat" -o install-worker.bat
curl -fL -o llama-b12359-bin-win-cuda-12.4-x64.zip https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cuda-12.4-x64.zip
curl -fL -o cudart-llama-bin-win-cuda-12.4-x64.zip https://github.com/ggml-org/llama.cpp/releases/download/b12359/cudart-llama-bin-win-cuda-12.4-x64.zip
curl -fL -o llama-b12359-bin-win-vulkan-x64.zip https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-vulkan-x64.zip
curl -fL -o llama-b12359-bin-win-cpu-x64.zip https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cpu-x64.zip
curl -s http://127.0.0.1:8092/downloads/manifest.json
```

Every component must be ≤ 512 MB. The Windows CUDA pair is the
12.4 build on purpose: it runs on any NVIDIA driver from 551 up,
where the 13.5 build would need 580+.

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

## A worker PC (Windows) — the easy path

```
curl -fsSL https://pool.tavernworks.dev/downloads/install-worker.bat -o install-worker.bat
install-worker.bat
```

(in Command Prompt.) The installer checks for Python 3 (via the
`py` launcher, then `python`), downloads `pool-worker.py` into
`%USERPROFILE%\pool-worker`, and starts it. Everything after
that matches the Linux path: enroll (name = the PC's name,
auto-sized offer), operator approval, engine download (the
Windows CUDA / Vulkan / CPU zip from the shelf, picked
automatically for the machine), relay, and the personal
`#link=` URL on approval. Yield on battery and the GPU
temperature guard work the same; the PAUSE file lives in
`%USERPROFILE%\pool-worker`. There is no boot-service story
on Windows yet — the worker runs in its console window.

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

## Split keeps failing on a relayed worker? (fixed 2026-11-24)

Two relay bugs broke every split that used a public worker:

- **The worker cut its own RPC link after 10 quiet seconds.** The
  socket to the local rpc-server kept its 10 s connect timeout for
  life. In a split the link sits silent for minutes (while the host
  loads the other machines' layers, and between requests), so the
  stream closed mid-load and llama-server lost the device. The relay
  WebSocket had the same problem with its 30 s connect timeout racing
  the 30 s ping cycle. Both now drop the timeout after connecting,
  and the front pings every worker every 20 s.
- **A reconnect knocked the machine offline.** When a worker
  reconnected, the old connection's reader exited late and removed
  the NEW connection from the hub, so the machine vanished from
  `relay-state.json` until the next reconnect (the same churn behind
  the old 51103 → 51190 port climb). The hub now only drops the
  connection that actually ended.

The worker also starts rpc-server with its **local tensor cache**
(`-c`) by default: the first split load sends this machine's slice
over the network once, and later loads of the same model read it
from the worker's disk. If the pinned build refuses the flag, the
worker logs that and starts without it. Turn it off with
`"rpc_cache": false` in `~/pool-worker/config.json`.

### Pre-download: the worker fetches the model itself

So a split doesn't have to push this machine's share over the
FX705's upload, the worker downloads the pool's current model from
Hugging Face in the background (low priority) and fills rpc-server's
cache with it ahead of time. When a split starts, the host sends
each large tensor's hash first, finds it already on the worker, and
skips sending the bytes.

- The front tells workers what to fetch at
  `https://pool.tavernworks.dev/model.json` (the model in
  `current-model.txt`, its size, and its download address). The two
  Qwen 14Bs and the 1.5B test model are built in. For any other
  model, add a line to `~/ai-pool/model-sources.json` on the FX705:
  `{"Its-File.gguf": {"url": "https://huggingface.co/.../resolve/main/Its-File.gguf"}}`
- The worker only downloads from Hugging Face over https, checks the
  download is the same size as the pool's file (and its SHA-256 when
  one is known), checks free disk first (about the model's size +
  1 GB), resumes where it stopped, and re-checks every 10 minutes,
  so a model change on the coordinator is picked up and the old
  pre-download is removed.
- Turn it off with `"predownload": false` in `config.json`.
- After a split, the worker logs a warning if rpc-server cached
  tensors the pre-download didn't cover (meaning the host sent them
  after all). If you see that for most of the slice, tell the
  operator: the pinned llama.cpp build's cache doesn't match.

### Logs

- Worker console: `relay connected`, `split stream N opened`, and a
  reason whenever a stream or the relay ends.
- Worker rpc-server output: `~/pool-worker/rpc-server.log`
  (Windows: `%USERPROFILE%\pool-worker\rpc-server.log`). It used to
  be thrown away.
- FX705 front: `journalctl -u pool-front -f` shows `[relay]` lines
  (connect, drop with reason, each split stream).
- FX705 brain: `journalctl -u ai-pool-host -f` shows the model load
  across the devices.
