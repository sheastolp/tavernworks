#!/usr/bin/env bash
# AI Pool M1 — FX705 host: install the pinned CUDA build, fetch the
# model (checksum-verified), start the pooled 14B.
# Run this on the FX705. Safe to re-run; downloads resume, checks repeat.
set -euo pipefail

POOL_DIR="$HOME/ai-pool"
BUILD="b12359"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD"
MODEL="huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF/resolve/main/$MODEL"
MODEL_SHA256="d76889059a3bfab30bc565012a0184827ff2bdc10197f6babc24541b98451dbe"
mkdir -p "$POOL_DIR"; cd "$POOL_DIR"

# 0. Driver check — the CUDA 12.8 build wants a current NVIDIA driver.
if command -v nvidia-smi >/dev/null; then
  echo ">> NVIDIA driver: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
else
  echo "!! nvidia-smi not found — install the NVIDIA driver first, then re-run."
  exit 1
fi

# 0.5 VRAM contention — Ollama holding phi4-mini (~2.4 GB) leaves too
#     little of this 4 GB card for the pool's local slice. Offer to
#     unload it for the session; the bots reload it on their next
#     request (one slower reply, then normal).
PS_JSON="$(curl -s http://localhost:11434/api/ps || true)"
if echo "$PS_JSON" | grep -q '"name"'; then
  echo ">> Ollama is holding model(s) in VRAM right now:"
  echo "$PS_JSON" | grep -o '"name":"[^"]*"'
  read -rp ">> Unload them for this pool session? [Y/n] " ans
  case "${ans:-Y}" in
    n|N) echo ">> Leaving Ollama loaded — expect the pool to load slowly or fail on VRAM." ;;
    *)
      for m in $(echo "$PS_JSON" | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do
        curl -s http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null 2>&1 || true
        echo ">> Unloaded $m"
      done
      ;;
  esac
fi

# 1. Engine + CUDA runtime, extracted together.
SERVER="$(find "$POOL_DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
if [ -z "$SERVER" ]; then
  curl -fL -o engine.tar.gz "$BASE/llama-$BUILD-bin-ubuntu-cuda-12.8-x64.tar.gz"
  curl -fL -o cudart.tar.gz "$BASE/cudart-llama-$BUILD-bin-ubuntu-cuda-12.8-x64.tar.gz"
  tar -xzf engine.tar.gz
  tar -xzf cudart.tar.gz
  SERVER="$(find "$POOL_DIR" -name llama-server -type f | head -1)"
fi
[ -n "$SERVER" ] || { echo "!! llama-server not found after extract."; exit 1; }
BIN_DIR="$(dirname "$SERVER")"
CUBLAS="$(find "$POOL_DIR" -name 'libcublas.so*' 2>/dev/null | head -1 || true)"
if [ -n "$CUBLAS" ]; then
  export LD_LIBRARY_PATH="$BIN_DIR:$(dirname "$CUBLAS")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  export LD_LIBRARY_PATH="$BIN_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
VER="$("$SERVER" --version 2>&1 || true)"
echo "$VER"
case "$VER" in
  *"build 12359"*) echo ">> Host build confirmed: $BUILD" ;;
  *) echo "!! Host binary is not $BUILD — mismatched builds cannot pool."; exit 1 ;;
esac
echo ">> Host binary OK ($BUILD): $SERVER"

# 2. Model — resumable download, then checksum. A bad file never loads.
if [ ! -f "$MODEL" ]; then wget -c "$MODEL_URL" -O "$MODEL"; fi
echo "$MODEL_SHA256  $MODEL" | sha256sum -c - || { echo "!! Model checksum MISMATCH — delete the file and re-run."; exit 1; }
echo ">> Model verified: $MODEL"

# 3. Addresses, and prove the Yoga worker is listening before loading 9 GB.
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$TS_IP" ]; then read -rp "FX705 tailnet IP (100.x.y.z): " TS_IP; fi
read -rp "Yoga tailnet IP (100.x.y.z): " YOGA_IP
if (timeout 5 bash -c "exec 3<>/dev/tcp/$YOGA_IP/50052") 2>/dev/null; then
  echo ">> Yoga worker reachable at $YOGA_IP:50052"
else
  echo "!! Cannot reach the Yoga worker at $YOGA_IP:50052 — run yoga-worker.sh on the Yoga first."
  exit 1
fi

# 4. Serve the pooled model: layers split 3:2 toward this machine's GPU,
#    thinking OFF (Burn must never receive think blocks).
echo ">> Starting pooled Qwen3-14B at http://$TS_IP:8080"
echo ">> Watch the load log: it should list a CUDA device AND an RPC device,"
echo ">> with layers offloaded to both. Leave this terminal open; Ctrl-C stops the pool."
exec "$SERVER" -m "$POOL_DIR/$MODEL" \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --rpc "$YOGA_IP:50052" \
  --tensor-split 3,2 \
  -ngl 99 -fit off \
  -c 8192 \
  --host "$TS_IP" --port 8080
