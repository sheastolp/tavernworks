#!/usr/bin/env bash
# AI Pool M1 — Yoga worker: install the pinned build, start the worker.
# Run this on the Yoga. Safe to re-run; it skips work already done.
set -euo pipefail

POOL_DIR="$HOME/ai-pool"
BUILD="b12359"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD"
mkdir -p "$POOL_DIR"; cd "$POOL_DIR"

# 1. Engine — Vulkan build preferred, CPU build as fallback.
#    ggml-rpc-server has NO --version flag (it errors on it), so the
#    build is pinned by construction: the archive name carries it and
#    extraction lands in llama-b12359/. Anything else is rejected by
#    the host's v9 handshake at connect time anyway.
ENGINE_DIR="$POOL_DIR/llama-$BUILD"
RPC_SERVER="$ENGINE_DIR/ggml-rpc-server"
if [ ! -x "$RPC_SERVER" ]; then
  got=""
  for asset in "llama-$BUILD-bin-ubuntu-vulkan-x64.tar.gz" "llama-$BUILD-bin-ubuntu-x64.tar.gz"; do
    echo ">> Trying $asset"
    if curl -fL -o engine.tar.gz "$BASE/$asset"; then got="$asset"; break; fi
  done
  [ -n "$got" ] || { echo "!! No engine archive downloaded — check the $BUILD release page."; exit 1; }
  echo ">> Downloaded $got"
  tar -xzf engine.tar.gz
fi
[ -x "$RPC_SERVER" ] || { echo "!! ggml-rpc-server not at $RPC_SERVER after extract."; exit 1; }
echo ">> Worker binary OK (pinned $BUILD archive): $RPC_SERVER"

# 2. Tailnet address. RPC has NO password — bind to the tailnet only,
#    never 0.0.0.0 on a public interface.
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$TS_IP" ]; then read -rp "Yoga tailnet IP (100.x.y.z): " TS_IP; fi
echo ">> Yoga tailnet IP: $TS_IP"

# 3. Serve. This build's rpc-server has no memory flag — how much of
#    the model lands here is set by the host's --tensor-split
#    (at 3,2 the Yoga carries about 3.6 GB of the 9 GB model, inside
#    the headroom the bots on this machine need).
echo ">> Starting worker on $TS_IP:50052 (its share of the model is set by the host's split)."
echo ">> Leave this terminal open. Ctrl-C stops the worker."
exec "$RPC_SERVER" -H "$TS_IP" -p 50052
