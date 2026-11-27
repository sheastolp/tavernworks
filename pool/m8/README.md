# AI Pool M8 — pool.tavernworks.dev, Qwen3.5 35B-A3B, Android workers

## 1. pool.tavernworks.dev

The front (`pool-front`, port 8092, already behind the Cloudflare
Tunnel at pool.tavernworks.dev) now serves the full pool page at `/`
when `pool-page.html` sits beside it (copy `pool/index.html` there).
`tavernworks.dev/pool` redirects there (root `_redirects`, plus a
script in the page for any other copy).

## 2. The model: Qwen3.5 35B-A3B (there is no 32B)

Qwen3.5 comes as a dense 27B or the 35B-A3B mixture of experts
(40 layers, 3B active per token). The MoE is the better split model:
per token it computes about a quarter of the 14B's work, so the split
spends its time on the network hops rather than on the slowest card.
Thinking stays off through the host's existing chat-template flags.

| Pick | File | Size | When |
|---|---|---|---|
| split | IQ4_XS | 18.9 GB | default; needs ~21 GB across the pool |
| bigger pool | Q4_K_M | 21.2 GB | more RAM online |
| phone GPUs | MXFP4_MOE | 22.1 GB | Adreno phones compute instead of only storing |
| solo | i1-IQ3_M | 15.4 GB | FX705 alone, experts in RAM |
| solo, tight | i1-IQ3_XXS | 13.5 GB | if IQ3_M won't fit |

`get-model.sh` downloads any of them into `~/ai-pool` with resume and
SHA-256 check; the front's `/model.json` sends workers to the same
Hugging Face files for their pre-download.

### Qwen2.5 32B (dense), the 14B's big sibling

`get-model.sh 32b` fetches Qwen2.5-32B-Instruct-abliterated IQ4_XS
(17.9 GB, mradermacher's quants of huihui-ai's abliteration);
`32b-q4km` the Q4_K_M (19.9 GB). With FX705 RAM at 10 GB the split
holds about 22 GB, so IQ4_XS fits with room for an 8k context. Being
dense, it reads all ~18 GB of weights for every token, against ~2 GB
for the 35B-A3B, so expect it several times slower (around 1 token/s
on this pool, unmeasured).

### Qwen2.5 72B (dense), the Huihui ~70B

There is no Qwen3.8 70B: Qwen3.8 comes as a dense 27B or a 180B MoE
(68 GB at its smallest quant, far past this pool). The only Huihui Qwen
near 70B is huihui-ai's Qwen2.5-72B-Instruct-abliterated, here in
mradermacher's imatrix quants:

| Pick | File | Size | When |
|---|---|---|---|
| `72b` | i1-IQ2_M | 29.4 GB | whole pool online (~31 GB with context) |
| `72b-iq3` | i1-IQ3_XXS | 31.9 GB | a few GB more RAM online |
| `72b-iq4` | i1-IQ4_XS | 39.8 GB | needs ~42 GB, more than the pool has today |

Dense: every token reads the whole file, about 1.5x the 32B's bytes,
so expect it two to three times slower than the 32B (unmeasured).
`get-model.sh qwen3.8` fetches Huihui Qwen3.8 27B abliterated IQ4_XS
(15.5 GB, dense), the Qwen3.8 that fits comfortably.

### Deleting models

The control page's "Models on the host" table has a **Delete…** button
per model. It asks once more (file name and size), then removes the
file. It refuses the current model, the model a running brain has
loaded, and any file something has open (a download or checksum).
From a shell: `bash get-model.sh delete <file.gguf>` (same refusals,
asks you to type yes).

## 3. The FX705's own RAM joins the split

The Yoga (6 GB) + the MSI (relay) + the card's 3 GB is about 12-13 GB,
too small for 19 GB. `hostram.sh` runs a CPU-only `ggml-rpc-server` on
`127.0.0.1:50060`; the coordinator lists it as **FX705 RAM** (Roster →
"Add the FX705's RAM to the split"), placed right before the card, so
it adds no network hop. The coordinator refuses an offer over the
machine's RAM minus 3 GB.

## 4. Android workers (Termux)

`install-android.sh` installs Python in Termux, fetches
`pool-worker.py` from the shelf and runs it. The worker names the
phone after its model, offers a third of its RAM (1-6 GB), and
downloads llama.cpp b12359's own Android build:

- **Adreno 7xx/8xx** (Snapdragon 8 Gen 2 and newer, some 8 Gen 1 / 7-series):
  the OpenCL build; the GPU computes **only when the pool's model is
  MXFP4, Q4_0 or Q8_0** (llama.cpp's Adreno MoE kernels can't run
  K-quants or IQ-quants through the RPC split). With any other model
  the same phone serves on CPU; it switches by itself when the model
  changes.
- **Mali, PowerVR, Adreno 6xx and older:** CPU and RAM only.
- If OpenCL won't load, the worker falls back to CPU and saves that.
- It pauses when unplugged or above 42 °C (needs Termux:API).

Every phone is one more network hop. On the tailnet that's fine; over
the relay it costs tens to hundreds of ms per token.

## Untested here

Live tokens/s, OpenCL inside Termux on a real phone, and the host-RAM
split on the FX705. Watch the first run's `journalctl -u ai-pool-host -f`.
