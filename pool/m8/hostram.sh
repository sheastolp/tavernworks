#!/usr/bin/env bash
# AI Pool M8 — the FX705's own RAM as one more split device.
#
# A CPU-only ggml-rpc-server on this machine's loopback. The split
# host (fx705-host.sh) reaches it at 127.0.0.1:50060 like any other
# worker, so the FX705's system RAM can hold a block of layers right
# before the card's — no network hop, which is what lets a ~19 GB
# model fit beside the Yoga and the relayed machines. Its size is set
# on the coordinator (Roster -> "FX705 RAM").
set -euo pipefail
POOL_DIR="${HOME:-/root}/ai-pool"
RPC="$(find "$POOL_DIR" -name ggml-rpc-server -type f 2>/dev/null | head -1 || true)"
[ -n "$RPC" ] || { echo "!! ggml-rpc-server not found under $POOL_DIR (run fx705-host.sh once first)."; exit 1; }
BIN_DIR="$(dirname "$RPC")"
export LD_LIBRARY_PATH="$BIN_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Hide the GTX 1650 from this process: its 4 GB belong to the card's
# own share of the split, and even an idle CUDA context costs VRAM.
export CUDA_VISIBLE_DEVICES=""
echo ">> FX705 RAM worker: $RPC on 127.0.0.1:50060 (CPU only)"
exec "$RPC" -H 127.0.0.1 -p 50060 -d CPU
