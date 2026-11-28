# M10 — chain mode (Nov 28)

A third way to run the pooled model, beside solo and split. Built
from SwarmBench's first runs: solo ~20 tok/s; the six-machine split
~1 tok/s, with about 390 ms of every token spent on relay round
trips and about 370 ms on the phones' own compute.

Chain mode changes three things, and SwarmBench measures it against
solo and split:

1. **Cost-aware layers** (`pool_chain.py`). Each machine's cost per
   layer and its round trip come from SwarmBench's timings (defaults
   until a machine has been measured). The FX705's card and RAM are
   always used; other machines are added cheapest first only until
   the model fits, and the rest are left out. Layers go to whichever
   chosen machine is cheapest per layer. The first layers stay on
   one of your own machines (a tailnet worker or the FX705's RAM),
   as in the split.
2. **Batch checking**. The chain always runs with a draft model
   (the split's `pool-draft.txt` choice, else
   `Qwen3.5-0.8B-Q4_K_M.gguf` when it is in `~/ai-pool`). The draft
   guesses up to 8 tokens on the card and the chain checks them in
   one pass, so each machine's round trip is paid once per batch.
   Without a draft file on disk the chain runs without it and says so.
3. **Local routes** (`pool-front.py`, `pool-worker.py`, the Android
   app). The front also answers the relay on the FX705's own private
   home-network addresses (port 8093, path `/relay-lan`), never on
   a public or tailnet address. The Cloudflare relay tells workers
   where (`X-Pool-Lan`, over TLS). A worker on the same Wi-Fi/LAN
   connects there first and skips Cloudflare; anywhere else it
   falls back to Cloudflare as before. The key never crosses the
   home network: the worker sends an HMAC of a fresh nonce keyed by
   the key's SHA-256, the front checks it (time within 2 minutes,
   nonce not reused) and answers with its own HMAC, which the worker
   checks before it trusts the connection. Nothing joins the tailnet.
   `POOL_LAN_ROUTES=off` on the front turns it off.

Files: `pool_chain.py` (next to `pool-coordinator.py` in
`/opt/ai-pool`), `pool/m1/fx705-chain.sh` and
`pool/m1/ai-pool-chain.service` (conflicts with solo and split, so
starting any one stops the others). Chain reads only
`~/ai-pool/pool-chain-{rpc,split,draft}.txt` and
`pool-chain-plan.json`, written by **Start chain** on the control
page; solo's and split's files and scripts are untouched.

The control page's Chain mode card shows the plan before you start
it: each machine's layers, memory, cost and an estimate per pass,
plus who is left out and why. The estimates are estimates; run
SwarmBench (**Chain only**, or **Solo, split, then chain**) for the
real numbers. When the model fits on the FX705 alone, solo will
likely stay the fastest, and the card says so.

## Install on the FX705 (as root)

Each line on its own:

```
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m10/pool_chain.py" -o /opt/ai-pool/pool_chain.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m3/pool-coordinator.py" -o /opt/ai-pool/pool-coordinator.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m9/pool_meter.py" -o /opt/ai-pool/pool_meter.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5/pool-front.py" -o /opt/ai-pool/pool-front.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m1/fx705-chain.sh" -o /opt/ai-pool/fx705-chain.sh
chmod +x /opt/ai-pool/fx705-chain.sh
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m1/ai-pool-chain.service" -o /etc/systemd/system/ai-pool-chain.service
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5b/pool-worker.py" -o /root/ai-pool/downloads/pool-worker.py
systemctl daemon-reload
systemctl restart pool-front
systemctl restart pool-coordinator
```

PC workers pick up the new `pool-worker.py` from the shelf on their
own within about 10 minutes, while no split is using them. Phones
need the new PoolWorker app (1.0.2 or later), which installs over
1.0.1.
