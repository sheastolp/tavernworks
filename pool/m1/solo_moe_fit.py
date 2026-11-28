#!/usr/bin/env python3
"""How many layers' MoE experts solo should keep in the FX705's RAM.

Prints one integer N for llama-server's --n-cpu-moe N: the experts of
blocks 0..N-1 stay on the CPU, everything else (attention, the shared
expert, norms, the output layer, the KV cache and the experts of the
last blocks that still fit) goes on the card. On a 4 GB card with a
35B-A3B model that puts the small, always-used weights on the GPU and
the big, sparsely-used experts in RAM.

    solo_moe_fit.py MODEL.gguf FREE_MB CTX [DRAFT_MB]

Reads only the GGUF header (pool_meter.gguf_layout). Prints the block
count (all experts on the CPU) when it can't tell, and nothing with
exit code 1 when the file isn't a MoE model.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for p in (HERE, "/opt/ai-pool", os.path.join(HERE, "..", "m9")):
    if p not in sys.path:
        sys.path.insert(0, p)

EXPERT = re.compile(r"^blk\.(\d+)\.ffn_(up|down|gate|gate_up)_(ch)?exps\b")
CUDA_RESERVE_MB = 900      # CUDA context + compute buffers at 16k context
DRAFT_OVERHEAD_MB = 400    # the draft's own KV and compute buffers


def fit(path, free_mb, ctx, draft_mb=0):
    import pool_meter
    kv, tensors = pool_meter.gguf_layout(path)
    arch = kv.get("general.architecture") or ""
    n = kv.get(arch + ".block_count")
    if not isinstance(n, int) or n <= 0:
        return None
    mib = 1024.0 * 1024.0
    experts = [0.0] * n
    dense = 0.0
    for name, nb in tensors.items():
        m = EXPERT.match(name)
        if m:
            il = int(m.group(1))
            if 0 <= il < n:
                experts[il] += nb / mib
        elif name.startswith("blk.") or name in ("output.weight", "output_norm.weight"):
            dense += nb / mib
    if "output.weight" not in tensors:     # tied embeddings: copied to the output device
        dense += tensors.get("token_embd.weight", 0) / mib
    if not any(experts):
        return -1
    layout = pool_meter.model_layout(path) or {}
    kv_mb = sum(layout.get("kv_per_tok") or []) * ctx / mib
    budget = (free_mb - CUDA_RESERVE_MB - (draft_mb + DRAFT_OVERHEAD_MB if draft_mb else 0)
              - dense - kv_mb)
    on_gpu = 0
    for il in range(n - 1, -1, -1):       # --n-cpu-moe keeps the FIRST N on the CPU
        if experts[il] > budget:
            break
        budget -= experts[il]
        on_gpu += 1
    return n - on_gpu


def main(argv):
    if len(argv) < 4:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    path, free_mb, ctx = argv[1], float(argv[2]), int(argv[3])
    draft_mb = float(argv[4]) if len(argv) > 4 and argv[4] else 0.0
    try:
        n = fit(path, free_mb, ctx, draft_mb)
    except Exception as e:
        print("can't read " + path + ": " + str(e), file=sys.stderr)
        return 1
    if n is None:
        return 1
    if n < 0:
        print("not a MoE model", file=sys.stderr)
        return 1
    print(n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
