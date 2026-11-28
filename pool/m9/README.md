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

## SwarmBench for anyone's setup

`swarmbench.py` is the portable version of the same test. It's one file
that needs only Python 3.8 or newer. It runs on Windows, Linux and Mac
against llama.cpp `llama-server`, Ollama, LM Studio, vLLM, koboldcpp or any
other OpenAI-style server, whether that's a single machine or a llama.cpp
RPC split. `swarmbench.bat` is a double-click launcher for Windows.

```
python swarmbench.py                          # finds a server on this computer
python swarmbench.py http://host:8080         # or names one
python swarmbench.py http://host:8080 --rpc a:50052,b:50052   # a split
```

- **Test:** the same `standard-v1` cases as the pool's own benchmark. Every
  request starts with a fresh tag, so no server can answer from a cached
  prompt.
- **Results:** time to first token per case, prompt and generation speed,
  and findings on where the time goes. The findings cover network to the
  server, request overhead, how much of the model is off the card on
  Ollama, and the network round trips to each machine in a split, as a
  share of each token's time.
- **Saved:** everything goes to a JSON file.
- **SwarmBench score:** 1000 means a 1.0 s first token and 10 tokens/s on
  the medium case. The first token counts twice as much as speed
  (score = 1000 × (1 s / TTFT)^(2/3) × (tok/s / 10)^(1/3)). The pool's own
  benchmark shows the same score.
- **Where to get it:** the public page links the downloads at
  `https://pool.tavernworks.dev/downloads/swarmbench.py` and `.bat`, so both
  files go on the FX705's shelf (`/root/ai-pool/downloads/`). The workers
  ignore them.

## Leaderboard

When a run finishes, swarmbench.py asks whether to post the result. You can
also pass `--share` (with an optional `--nick NAME`) or `--no-share`. A
posted result shows at `https://swarmbench.tavernworks.dev/board`, best
score first, with tabs for single machines and splits.

- **What gets sent:** only the scores, the model name and the CPU/GPU names.
  The client strips everything else. `pool-front.py` keeps only the fields
  it knows, removes anything that looks like an address, URL or email, and
  works out the score again from the raw numbers.
- **The sender's address:** stored only as a salted hash, for the rate limit.
- **Limits:**
  - 64 KB per post.
  - 3 posts per sender per 10 minutes, and 10 per day.
  - 300 posts a day in total.
  - The same result can't be posted twice.
  - Numbers have to be possible, and the prompts have to be the standard
    ones.
- **Removing entries:** the control page `/bench` lists the newest entries
  with Hide and Show again buttons.
- **Storage:** `/root/ai-pool/swarmbench-board.db`.

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
