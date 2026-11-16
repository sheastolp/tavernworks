# M1 — proof runbook: one 14B split across FX705 + Yoga

Purpose: prove a 14B model runs split across the two laptops, get a real
tokens/sec number, and judge whether it's quick enough for Burn. No
webpage yet — that comes after this works. Everything below runs on
Shea's two laptops; Claude can't reach them directly.

**ONE-GO PATH (2026-11-15):** this runbook is now the reference behind
`m1/SESSION.md` + the three scripts in `m1/` (yoga-worker.sh,
fx705-host.sh, test-pool.sh), which take the laptops from nothing to a
tested pool in a single sitting — pinned downloads, version asserts,
model SHA-256 check, worker reachability check, optional Burn flip.
Run the session, keep this file for the why and the failure notes.

## The model

**Pinned model (2026-11-15, swapped from Qwen2.5 at Shea's choice):**
`huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf` (~9 GB — filename verified
against the repo's file list 2026-11-15) from
**bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF** on Hugging Face —
huihui-ai's abliteration of Qwen3-14B (Qwen3's dense models are the
chat models by default; there is no separate -Instruct SKU). 40K
native context. No Qwen3.5 equivalent exists — that name belongs to a
14B-A3B MoE reasoning distillate, not an abliterated instruct model.

**Where you download it:** the repo page is
https://huggingface.co/bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF
and the direct file link is
https://huggingface.co/bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF/resolve/main/huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf
Download it onto the **FX705** (the host owns the model file), e.g.
`wget <that link>` in the folder you'll run llama-server from.

**Thinking mode — OFF for this pool.** Qwen3 reasons in a <think>
block before answering by default: slower, and think text must never
reach Twitch chat. The Step 2 start command disables it via
`--reasoning off`, so the model
answers directly. (If the lore-keeper is ever tested against the pool,
it can be re-run with thinking on — better research answers, slower.)

**Instruct vs abliterated — different axes, and this file is both.**
Instruct/chat tuning = follows instructions and holds a conversation
(a base model just completes text — wrong for Burn). Abliterated =
the refusal behaviour removed, which is what decides whether Burn's
swearing/roast prompts get refused or softened. A stock model IS a
language risk for Burn; the pinned file keeps both properties.
A/B alternative if you want the comparison: the Qwen2.5 pin this
replaced — mradermacher/Qwen2.5-14B-Instruct-abliterated-GGUF, file
`Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf` (dots before Q4_K_M).

**Choosing a different model in M1:** there is no picker yet (that's
the pool page, M3). For now the choice IS the `-m <file>` in the Step 2
command — any GGUF on the FX705 can be swapped in by changing that one
argument and restarting llama-server.

## Step 0 — same llama.cpp everywhere (the one rule that breaks things)

**Pinned (2026-11-15): llama.cpp v1.0.0, build b12359, on BOTH laptops.**
Do NOT grab "newest" on install day — v1.0.0's RPC protocol is v9 and
rejects mismatched peers, so two different days' downloads would refuse
to talk. Exact assets from the b12359 release:
- **FX705 (CUDA — DECIDED 2026-11-15, matches what ships):**
  `llama-b12359-bin-ubuntu-cuda-12.8-x64.tar.gz` PLUS
  `cudart-llama-b12359-bin-ubuntu-cuda-12.8-x64.tar.gz` (the CUDA
  runtime/cuBLAS — extract it alongside the engine archive).
  Check `nvidia-smi` first: CUDA 12.8 wants a current NVIDIA driver.
  Source fallback: same tag with `-DGGML_CUDA=ON -DGGML_RPC=ON`.
- **Yoga:** the same b12359 Ubuntu **Vulkan** build if offered, else the
  CPU build (no NVIDIA card — its share is mostly RAM).
  Source fallback: same tag with `-DGGML_VULKAN=ON -DGGML_RPC=ON`.
- Verify the filenames on the b12359 release page at download time, then
  verify the match on both machines:
  `llama-server --version` and `ggml-rpc-server --version` — identical.

## Step 1 — worker on the Yoga

```
ggml-rpc-server -H <Yoga tailnet IP> -p 50052
```
- `-H` is the Yoga's **tailnet** address (100.x.y.z) — never 0.0.0.0 on a
  public interface; RPC has no password, the tailnet is the fence.
- This build's rpc-server has **no memory flag** (and no --version) —
  how much of the model lands on the Yoga is set by the host's
  `--tensor-split` (at 3,2 that's ~3.6 GB of the 9 GB, inside the
  headroom the bots on this machine need).

## Step 2 — host on the FX705

```
llama-server -m huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf \
  --reasoning off \
  --rpc <Yoga tailnet IP>:50052 \
  --tensor-split 3,2 \
  -ngl 99 -fit off \
  -c 8192 \
  --host <FX705 tailnet IP> --port 8090
```
- `--tensor-split 3,2` = layer proportions, local:remote — the FX705
  (GPU) takes the bigger share. Tune after the first timing run.
- `-fit off`: llama.cpp's auto-fit is known to crash with RPC on.
- Success looks like: load log shows layers offloaded to the RPC device,
  then the server listening on 8080.

## Step 3 — test + measure

From the FX705 (or any tailnet machine):
```
curl http://<FX705 tailnet IP>:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Roast a streamer who just whiffed an easy shot, one short sentence."}],"max_tokens":60}'
```
- Check: coherent reply (the split works), and read the `timings` in the
  response — record **predicted_per_second** here: ____ tok/s.
- Rule of thumb for Burn: roasts are ~40 tokens. At 5 tok/s that's ~8 s
  per roast — fine for scheduled posts; banter (10 s min gap) is the
  tight case. Below ~3 tok/s, Burn on the pool will feel laggy and we
  revisit the split (more layers on the FX705 GPU, smaller context).

## Step 4 — only after M1 passes (later sessions)

- Point Burn at it: Burn's AI base URL already supports a local
  OpenAI-shaped server — set it to `http://<FX705 tailnet IP>:8090/v1`
  and the model to the pooled 14B, same as its Ollama setup today.
- Then M2: the enrollment page replaces these hand-run commands.

## Failure notes

- Handshake hang / crash at load → version mismatch between the laptops
  (Step 0) until proven otherwise.
- "failed to allocate" → pool memory short: raise the Yoga's `-m`, lower
  `-c`, or shift `--tensor-split` toward the FX705.
- Works but crawling → check whether the FX705 fell back to CPU (Vulkan
  build/device line in the load log) before blaming the network.
