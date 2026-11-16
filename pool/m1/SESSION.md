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
its `OPENAI_BASE_URL` to `http://<FX705 tailnet IP>:8090/v1`, then
`sudo systemctl restart tavernworks-undercoverburn` and check
/admin/connections. To flip back, restore the backup (the Ollama
address) and restart again. If banter feels laggy on a live stream,
flip back first and retune the split second.

## Run it as a service (close the terminals)

Both halves have systemd units in this folder. The scripts were
taught to run unattended: no prompts (the Ollama unload defaults to
yes), and the host finds the Yoga's tailnet address on its own by
looking up the peer whose name contains "yoga". Order doesn't
matter — if the worker isn't up yet, the host service retries every
15 seconds until it is.

**Yoga:** Ctrl-C the foreground worker if it's running, then:
```
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m1/yoga-worker.sh" -o ~/ai-pool-m1/yoga-worker.sh
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m1/ai-pool-worker.service" -o ~/ai-pool-m1/ai-pool-worker.service
mkdir -p /opt/ai-pool && cp ~/ai-pool-m1/yoga-worker.sh /opt/ai-pool/ && chmod +x /opt/ai-pool/yoga-worker.sh
cp ~/ai-pool-m1/ai-pool-worker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ai-pool-worker
journalctl -u ai-pool-worker -f
```

**FX705:** Ctrl-C the foreground host (even mid-download — the
service run resumes the model download where it stopped), then the
same shape with fx705-host.sh / ai-pool-host.service /
ai-pool-host. Watch it with `journalctl -u ai-pool-host -f`; once
it has loaded the model you can close everything.

Day to day: `systemctl stop|start|restart ai-pool-host` (or
ai-pool-worker), logs via journalctl. Updating a script later means
re-copying it into /opt/ai-pool and restarting the service — the
same pattern as the gate.

## Stopping

Ctrl-C in either terminal stops that side. Nothing is installed as a
service; closing both terminals is a full stop. Re-running the
scripts later skips finished downloads and re-checks versions.
