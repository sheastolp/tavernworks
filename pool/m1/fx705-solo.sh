#!/usr/bin/env bash
# AI Pool M1 — SOLO experiment: the same 14B on the FX705 ALONE.
# Layers that fit go on the GPU, the rest run on the FX705's CPU/RAM
# (llama.cpp's auto-fit decides) — no split, no Yoga, no network.
# NOTE: do NOT pass -ngl here — an explicit n_gpu_layers makes the
# auto-fit abort (seen live: 'n_gpu_layers already set by user to 99,
# abort' followed by an 8.2 GB cudaMalloc failure on the 4 GB card).
# Purpose: compare speed against the split (which measured 0.9 tok/s
# on 2026-11-16 — the Yoga's share is the bottleneck). Foreground;
# Ctrl-C ends it. Stop ai-pool-host first so the GPU is free.
# Context is 16384: the lore-keeper gate sizes its window to the
# canon it sends, up to 16k, and this solo brain is the one the
# gate talks to. The KV pool for 16k on this model is ~2.6 GB —
# the FX705's RAM carries it easily alongside the weights; Burn's
# small prompts are unaffected. The split host asks for 8192
# first (raised 2026-11-18 so typical lore-keeper prompts fit),
# with a one-time load fallback to 4096; 16384 failed context
# creation on the split twice, so the full window is solo-only.
set -euo pipefail

POOL_DIR="${HOME:-/root}/ai-pool"
# Model choice: an explicit argument wins, then the coordinator's
# current-model.txt (the M3 model picker writes it), then the
# production default — the Qwen2.5, because the Qwen3 file thinks
# out loud through every off switch we found.
MODEL="${1:-}"
if [ -z "$MODEL" ] && [ -f "$POOL_DIR/current-model.txt" ]; then
  MODEL="$(head -1 "$POOL_DIR/current-model.txt" | tr -d '[:space:]')"
fi
MODEL="${MODEL:-Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf}"
mkdir -p "$POOL_DIR"; cd "$POOL_DIR"
[ -f "$MODEL" ] || { echo "!! Model file not in $POOL_DIR: $MODEL"; exit 1; }
echo ">> Model: $MODEL"

if command -v nvidia-smi >/dev/null; then
  echo ">> NVIDIA driver: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
fi

# Free the GPU: unload Ollama's resident model for this run.
PS_JSON="$(curl -s http://localhost:11434/api/ps || true)"
if echo "$PS_JSON" | grep -q '"name"'; then
  echo ">> Ollama is holding model(s) in VRAM:"
  echo "$PS_JSON" | grep -o '"name":"[^"]*"'
  ans="Y"
  if [ -t 0 ]; then read -rp ">> Unload them for this run? [Y/n] " ans || ans="Y"; fi
  case "${ans:-Y}" in
    n|N) echo ">> Leaving Ollama loaded — expect a tighter GPU fit." ;;
    *)
      for m in $(echo "$PS_JSON" | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do
        curl -s http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null 2>&1 || true
        echo ">> Unloaded $m"
      done
      ;;
  esac
fi

SERVER="$(find "$POOL_DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || { echo "!! llama-server not found under $POOL_DIR — run fx705-host.sh once first."; exit 1; }
BIN_DIR="$(dirname "$SERVER")"
CUBLAS="$(find "$POOL_DIR" -name 'libcublas.so*' 2>/dev/null | head -1 || true)"
if [ -n "$CUBLAS" ]; then
  export LD_LIBRARY_PATH="$BIN_DIR:$(dirname "$CUBLAS")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  export LD_LIBRARY_PATH="$BIN_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
[ -n "$TS_IP" ] || { echo "!! No tailnet IP — is tailscale up?"; exit 1; }

echo ">> Starting SOLO $MODEL at http://$TS_IP:8090 (auto-fit: GPU what fits, CPU the rest)"
echo ">> Then run ./test-pool.sh in another terminal. Ctrl-C here stops it."
exec "$SERVER" -m "$MODEL" \
  --reasoning off \
  --chat-template-kwargs '{"enable_thinking":false}' \
  -c 16384 \
  --host "$TS_IP" --port 8090
