#!/usr/bin/env bash
# AI Pool M1 — Yoga worker: install the pinned build, start the worker.
# Run this on the Yoga. Safe to re-run; it skips work already done.
set -euo pipefail

POOL_DIR="$HOME/ai-pool"
BUILD="b12359"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD"
mkdir -p "$POOL_DIR"; cd "$POOL_DIR"

# 1. Engine — Vulkan build preferred, CPU build as fallback.
#    Either way it MUST be build b12359: the host rejects anything else.
RPC_SERVER="$(find "$POOL_DIR" -name ggml-rpc-server -type f 2>/dev/null | head -1 || true)"
if [ -z "$RPC_SERVER" ]; then
  got=""
  for asset in "llama-$BUILD-bin-ubuntu-vulkan-x64.tar.gz" "llama-$BUILD-bin-ubuntu-x64.tar.gz"; do
    echo ">> Trying $asset"
    if curl -fL -o engine.tar.gz "$BASE/$asset"; then got="$asset"; break; fi
  done
  [ -n "$got" ] || { echo "!! No engine archive downloaded — check the $BUILD release page."; exit 1; }
  echo ">> Downloaded $got"
  tar -xzf engine.tar.gz
  RPC_SERVER="$(find "$POOL_DIR" -name ggml-rpc-server -type f | head -1)"
fi
[ -n "$RPC_SERVER" ] || { echo "!! ggml-rpc-server not found after extract."; exit 1; }
"$RPC_SERVER" --version | grep -q "$BUILD" || { echo "!! Worker binary is not $BUILD — mismatched builds cannot pool."; exit 1; }
echo ">> Worker binary OK ($BUILD): $RPC_SERVER"

# 2. Tailnet address. RPC has NO password — bind to the tailnet only,
#    never 0.0.0.0 on a public interface.
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$TS_IP" ]; then read -rp "Yoga tailnet IP (100.x.y.z): " TS_IP; fi
echo ">> Yoga tailnet IP: $TS_IP"

# 3. Serve. 6000 MB offered — leaves the bots on this machine their room.
echo ">> Starting worker on $TS_IP:50052 (6000 MB offered)."
echo ">> Leave this terminal open. Ctrl-C stops the worker."
exec "$RPC_SERVER" -H "$TS_IP" -p 50052 -m 6000
