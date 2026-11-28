# SwarmBench: time to first token, benchmark and usage log for the AI Pool

SwarmBench first measures how long the pool takes to produce the first token,
and benchmarks the pool solo against split. Second, it logs where the time
went in every reply, so the slow machine or slow link shows up.

## What it records

- **Every reply the brain gives**, from any client (bots, the public door,
  Rosin). It does this by following the journal of `ai-pool-solo` and
  `ai-pool-host`. Each reply gets these fields:
  - model, draft model, mode (solo or split)
  - tokens in and out
  - time to first token (from llama-server's prompt eval time)
  - generation tok/s, total time and draft acceptance
  - the machines in the brain, with their layer ranges and memory
- **Each relayed worker, per reply:**
  - how long the FX705 waited on it
  - how much of that wait was the worker's own compute
  - how much was network and relay
  - bytes sent each way and the relay round trip

  The same split is stored separately for the time before the first token.
- **The benchmark** is a fixed suite: short (~50 tokens in), medium
  (~600) and long (~2000). Each case runs twice, greedy, with no prompt cache.
  - Before each mode it probes every worker's latency, then sends a warm-up
    request.
  - "Solo, then split" restarts the brain in each mode in turn, then puts it
    back the way it was.
  - "Run benchmark now" runs on whatever is up.
  - Benchmark requests measure the time to first token from the client side,
    including HTTP.

Everything is stored in SQLite at `/root/ai-pool/pool-meter.db`.

## Where it shows

- **Control page (tailnet only):** `/bench`, with the run buttons and full
  details.
- **Public read-only copy:** `https://swarmbench.tavernworks.dev/`, which
  hides IP addresses and has no buttons. Until that hostname exists, the same
  page is at `https://pool.tavernworks.dev/bench/`.
- **Export:** CSV or JSON for replies and benchmark runs, covering the last
  30 days, from the buttons at the bottom of the page.

## The name is one setting

The default name is SwarmBench and its link is swarmbench.tavernworks.dev.
To change either, write this file, then add the matching Cloudflare hostname:

```
echo '{"name": "SwarmBench", "host": "swarmbench.tavernworks.dev"}' > /root/ai-pool/bench-name.json
```

The front picks the change up within 30 seconds, and the coordinator picks it
up on its next page load.

## Install on the FX705

1. Copy `pool_meter.py` next to `pool-coordinator.py` in `/opt/ai-pool`.
2. Restart `pool-coordinator`.
3. Update `pool-front.py` (it adds relay timing and the public route) and
   restart `pool-front`.
4. Refresh the worker on the shelf. The MSI updates itself from there.
5. In Cloudflare Zero Trust, open Networks, then Tunnels, then the pool
   tunnel's Public Hostname tab. Add `swarmbench.tavernworks.dev` pointing to
   `HTTP localhost:8092`.

Phone workers keep working unchanged. They don't report their own compute,
so their wait shows network and compute together.
