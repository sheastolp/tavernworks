# M1 in one session — nothing to a working pooled 14B

One sitting, start to finish. Two laptops, three scripts, one test.
Downloads are the long pole (the model is 9 GB); on a decent
connection the whole session is roughly half an hour.

## Before you start

- Both laptops plugged in, awake, and on the tailnet.
- The FX705's 4 GB GPU is shared: Ollama (phi4-mini, ~2.4 GB) and the
  Whisper service already live there. The host script checks whether
  Ollama is holding its model in VRAM and offers to unload it for the
  session — say yes for a clean measurement; the bots reload it on
  demand afterwards. (End state, once Burn and the gate move to the
  pool: Ollama on the FX705 retires and this contention goes away.)
- FX705: ~12 GB free disk (model 9 GB + engines). Yoga: ~2 GB free.
- Copy this `m1/` folder to both laptops (USB, scp, however you like).
- `chmod +x *.sh` in the folder on each laptop.

## The session

**1. FX705 first — start the big downloads (terminal 1)**
```
./fx705-host.sh
```
It checks the NVIDIA driver, downloads the pinned CUDA engine +
runtime, then the 9 GB model, and verifies the model's SHA-256
(`d7688905…dbe`, from the repo's own file list) before anything loads.
While the model downloads, do step 2. When it asks for the Yoga's
tailnet IP, it first proves the Yoga worker answers — so the Yoga
must be up by then. At the end it starts the pooled model and stays
running in that terminal.

**2. Yoga — start the worker (terminal 2)**
```
./yoga-worker.sh
```
Downloads the same pinned build (Vulkan, CPU fallback) and starts
the worker on the Yoga's tailnet address, port 50052 — the host's
split decides its share of the model (about 3.6 GB at 3,2). Leave
it running.

**3. Test (back on the FX705, new terminal)**
```
./test-pool.sh
```
Success = a coherent one-sentence roast and a tok/s number:
≥5 is good for Burn, 3–5 workable, under 3 means retune the split
(more layers on the FX705) before wiring anything to it.

What "working" looked like on the way: the FX705's load log listed a
CUDA device AND an RPC device with layers offloaded to both; the
Yoga's terminal showed the host connect. If the host script stops at
"cannot reach the Yoga worker", the Yoga script isn't running or the
IP is wrong — nothing else fails that way.

## Optional last step — point Burn at it (only if the test passed)

On the Yoga: back up `/etc/tavernworks/undercoverburn.env`, change
its `OPENAI_BASE_URL` to `http://<FX705 tailnet IP>:8080/v1`, then
`sudo systemctl restart tavernworks-undercoverburn` and check
/admin/connections. To flip back, restore the backup (the Ollama
address) and restart again. If banter feels laggy on a live stream,
flip back first and retune the split second.

## Stopping

Ctrl-C in either terminal stops that side. Nothing is installed as a
service; closing both terminals is a full stop. Re-running the
scripts later skips finished downloads and re-checks versions.
