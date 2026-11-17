# M5c — host integration: the split uses every live machine

The coordinator now builds the split from **all** live machines,
not just the tailnet roster:

- **Device list, in split order:** tailnet workers that answer
  their probe (the operator's own machines) first, then **relayed
  public workers** (from the front door's `relay-state.json`,
  offered memory taken from their enrollments). The host card's
  share is appended last, as always.
- Split proportions run RPC-first (proven in M1), so the split's
  two ends — the first RPC device and the card — always sit on the
  operator's hardware; **public workers only ever hold middle
  layers**. The coordinator enforces it: with only relayed workers
  live, **Start split refuses** and says why.
- `Start split` (and a model change during split) writes both
  `pool-split.txt` and the new **`pool-rpc.txt`**; `fx705-host.sh`
  reads the list, reachability-checks every endpoint, and passes it
  to `--rpc`. With no list file it falls back to the M1 behaviour
  (the Yoga alone, by tailnet discovery).
- The roster shows relayed machines as `worker (relay)` with their
  enrollment's offered memory; split capacity counts live devices
  only.

Sandbox suites: coordinator 19/19 (ordering, split math, both
refusals, the M1 arrangement unchanged), host-script resolution
block 3/3 (coordinator list used, dead endpoint refused by name,
M1 fallback intact).

## FX705 — refresh

```
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m3/pool-coordinator.py" -o /opt/ai-pool/pool-coordinator.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m1/fx705-host.sh" -o /opt/ai-pool/fx705-host.sh
sudo systemctl restart pool-coordinator
```

(The host script is read when the split next starts — no service
restart needed for it.)

## The stranger-path test (Yoga as a public worker)

Proves a machine that comes in through the public door — no
tailnet shortcut — can hold a real slice. It uses a small test
model so the cycle takes minutes, and it briefly takes the bots'
brain: run it while the stream is quiet.

1. **FX705 — fetch the test model** (~1 GB; it joins the picker):

   ```
   cd ~/ai-pool
   curl -fL -o qwen2.5-1.5b-instruct-q4_k_m.gguf https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf
   ```

2. **Yoga — enroll through the public door.** Leave the tailnet
   `ai-pool-worker` running (it holds the split's first end). Keep
   the Yoga **plugged in** — the worker yields on battery by design.

   ```
   mkdir -p ~/pool-worker && cd ~/pool-worker
   curl -fsSL https://pool.tavernworks.dev/downloads/pool-worker.py -o pool-worker.py
   python3 pool-worker.py --name yoga-public --offered-mb 6144
   ```

   It enrolls and waits. **Approve `yoga-public`** on the
   coordinator (Enrollments (public)). The worker downloads the
   Vulkan engine from the shelf, starts its rpc-server on its own
   localhost, and connects the relay. The coordinator roster gains
   `yoga-public · worker (relay)`.

3. **FX705 — run the split on the test model.** On the coordinator:
   **Stop** (brain off), set the model to
   `qwen2.5-1.5b-instruct-q4_k_m.gguf`, then **Start split**. The
   message should name both endpoints
   (`100.115.176.72:50052,127.0.0.1:51100`) with tensor split
   `2,2,1`. The host journal should show the model loading across
   a CUDA device and **two** RPC devices — the `127.0.0.1` one is
   the Yoga's slice arriving through the relay.

4. **Test it:**

   ```
   bash /opt/ai-pool/test-pool.sh
   ```

   A coherent reply is the pass. Speed will be modest — the
   relayed slice's traffic hairpins through the Cloudflare edge;
   this test proves the path, not pace.

5. **Put the bots back:** on the coordinator, **Stop**, set the
   model back to `Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf`,
   **Start solo**. On the Yoga, Ctrl+C the public worker when
   you're done with it (its enrollment can stay approved for the
   next test).
