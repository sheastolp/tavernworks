#!/usr/bin/env bash
# AI Pool M1 — FX705 host: install the pinned CUDA build, fetch the
# model (checksum-verified), start the pooled 14B.
# Run this on the FX705. Safe to re-run; downloads resume, checks repeat.
set -euo pipefail

POOL_DIR="${HOME:-/root}/ai-pool"  # systemd may not set HOME; set -u makes that fatal
BUILD="b12359"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD"
MODEL="huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf"
# The M3 model picker can point the split at another on-disk model
# via current-model.txt; the pinned Qwen3 above stays the default.
if [ -f "$POOL_DIR/current-model.txt" ]; then
  CM="$(head -1 "$POOL_DIR/current-model.txt" | tr -d '[:space:]')"
  [ -n "$CM" ] && MODEL="$CM"
fi
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
  ans="Y"
  if [ -t 0 ]; then read -rp ">> Unload them for this pool session? [Y/n] " ans || ans="Y"; fi
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

# 2. Model — the pinned file downloads (resumable) and is checksum-
#    verified; any other model must already be on disk (the
#    coordinator's picker only lists on-disk models anyway).
if [ "$MODEL" = "huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf" ]; then
  if [ ! -f "$MODEL" ]; then wget -c "$MODEL_URL" -O "$MODEL"; fi
  echo "$MODEL_SHA256  $MODEL" | sha256sum -c - || { echo "!! Model checksum MISMATCH — delete the file and re-run."; exit 1; }
  echo ">> Model verified: $MODEL"
else
  [ -f "$MODEL" ] || { echo "!! Model file not in $POOL_DIR: $MODEL (only the pinned Qwen3 downloads automatically)"; exit 1; }
  echo ">> Model (via current-model.txt): $MODEL"
fi

# 3. Addresses, and prove every RPC worker is listening before
#    loading 9 GB.
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -z "$TS_IP" ] && [ -t 0 ]; then read -rp "FX705 tailnet IP (100.x.y.z): " TS_IP; fi
[ -n "$TS_IP" ] || { echo "!! No tailnet IP — is tailscale up?"; exit 1; }
# RPC device list: the coordinator (M3/M5c) writes pool-rpc.txt from
# ALL live machines — tailnet workers first (the first RPC device
# holds the model's first layers), then relayed public workers
# (middle layers only); this card always takes the last share.
# Without the file, fall back to the M1 arrangement: the Yoga alone,
# found by tailnet peer discovery (environment wins, then discovery,
# then an interactive prompt — under systemd there is no terminal,
# so discovery is what makes the service work).
RPC_LIST=""
if [ -f "$POOL_DIR/pool-rpc.txt" ]; then
  RPC_LIST="$(head -1 "$POOL_DIR/pool-rpc.txt" | tr -d '[:space:]')"
fi
if [ -n "$RPC_LIST" ]; then
  echo ">> RPC devices (coordinator's list): $RPC_LIST"
else
  if [ -z "${YOGA_IP:-}" ]; then
    YOGA_IP="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    for p in (d.get("Peer") or {}).values():
        if "yoga" in (p.get("HostName","") + p.get("DNSName","")).lower():
            print(p["TailscaleIPs"][0]); break
except Exception:
    pass' || true)"
    [ -n "$YOGA_IP" ] && echo ">> Found the Yoga on the tailnet: $YOGA_IP"
  fi
  if [ -z "${YOGA_IP:-}" ] && [ -t 0 ]; then read -rp "Yoga tailnet IP (100.x.y.z): " YOGA_IP; fi
  [ -n "${YOGA_IP:-}" ] || { echo "!! No RPC list and no Yoga IP — start the split from the coordinator, or set YOGA_IP."; exit 1; }
  RPC_LIST="$YOGA_IP:50052"
fi
OLD_IFS="$IFS"; IFS=',' read -ra RPC_ENDPOINTS <<< "$RPC_LIST"; IFS="$OLD_IFS"
for EP in "${RPC_ENDPOINTS[@]}"; do
  if (timeout 5 bash -c "exec 3<>/dev/tcp/${EP%:*}/${EP##*:}") 2>/dev/null; then
    echo ">> RPC worker reachable at $EP"
  else
    echo "!! Cannot reach the RPC worker at $EP — check that machine's worker first."
    exit 1
  fi
done

# 4. Serve the pooled model. Sizing learned live (2026-11-15/16):
#    the split proportions run RPC-first — the FIRST number is the
#    first RPC device's share, the last is this card's. And each device gets
#    ONE buffer for all its layers, so this card's share must fit
#    whole in 4 GB alongside Whisper: at 3,2 the card held 40% and
#    died on the KV cache; at 1,1 it was handed 4.2 GB in a single
#    allocation and died instantly (2,207 service restarts overnight).
#    2,1 gives the card ~3.0 GB of weights. If it still OOMs, go
#    3,1 (~2.25 GB). Context is handled at the launch below.
#    reasoning OFF (Burn must never receive think blocks).
# Tensor split: the coordinator (M3) computes it from the roster's
# offered memory into pool-split.txt; 2,1 is the M1-proven fallback.
SPLIT="2,1"
if [ -f "$POOL_DIR/pool-split.txt" ]; then
  PS="$(head -1 "$POOL_DIR/pool-split.txt" | tr -d '[:space:]')"
  case "$PS" in *","*) SPLIT="$PS" ;; esac
fi
echo ">> Tensor split: $SPLIT (shares follow the --rpc order; the last is this card's)"
# Context: 8192 first (raised 2026-11-18, Shea's call). The
# split's KV pool splits by layer share like the weights: at 2,1
# a 16384 pool does not fit this pairing (failed at context
# creation on both live tries, journals 2026-11-17 + 2026-11-18),
# while 4096 is M1-proven but too small for the lore-keeper —
# its canon prompt measured 5,931 tokens live, over a 4096
# context. 8192 covers typical lore-keeper asks; the heaviest
# canon loads (~10k tokens) still need solo's 16384. If the
# brain dies DURING LOAD at 8192, wait for every RPC worker to
# answer again (a failed load can leave a dead endpoint for as
# long as that machine's own restart takes), then retry ONCE at
# 4096. A brain that loaded and ran past the load window is
# never retried — its exit code passes through and systemd
# decides. Ctrl-C (130/131) never retries. Overrides:
# POOL_SPLIT_CTX=<n> picks a different first try, and
# POOL_SPLIT_TRY_16K=1 restores the 16384 attempt. Solo is
# unaffected (its 16384 comes out of RAM).
CTX_WANT="${POOL_SPLIT_CTX:-8192}"
case "$CTX_WANT" in *[!0-9]*|"") CTX_WANT=8192 ;; esac
if [ "${POOL_SPLIT_TRY_16K:-}" = "1" ]; then
  CTX_WANT=16384
fi
CTX_FALLBACK=4096
if [ "$CTX_WANT" -le "$CTX_FALLBACK" ]; then
  CTX_FALLBACK=""
fi
CTX_LOAD_WINDOW="${POOL_SPLIT_LOAD_WINDOW:-900}"
run_brain() {
  "$SERVER" -m "$POOL_DIR/$MODEL" \
    --reasoning off \
    --chat-template-kwargs '{"enable_thinking":false}' \
    --rpc "$RPC_LIST" \
    --tensor-split "$SPLIT" \
    -ngl 99 -fit off \
    -c "$1" \
    --host "$TS_IP" --port 8090
}
wait_for_workers() {
  # Poll every RPC endpoint until all answer, up to $1 seconds.
  local deadline=$((SECONDS + $1)) ep ok
  while [ $SECONDS -lt $deadline ]; do
    ok=1
    for ep in "${RPC_ENDPOINTS[@]}"; do
      (timeout 3 bash -c "exec 3<>/dev/tcp/${ep%:*}/${ep##*:}") 2>/dev/null || { ok=0; break; }
    done
    [ "$ok" = 1 ] && return 0
    sleep 3
  done
  return 1
}
echo ">> Starting pooled $MODEL at http://$TS_IP:8090 (context $CTX_WANT${CTX_FALLBACK:+; load fallback $CTX_FALLBACK})"
echo ">> Watch the load log: it should list a CUDA device AND an RPC device,"
echo ">> with layers offloaded to both. Leave this terminal open; Ctrl-C stops the pool."
START=$SECONDS
CODE=0
run_brain "$CTX_WANT" || CODE=$?
if [ -n "$CTX_FALLBACK" ] && [ "$CODE" -ne 0 ] && [ "$CODE" -ne 130 ] && [ "$CODE" -ne 131 ] && [ $((SECONDS - START)) -lt "$CTX_LOAD_WINDOW" ]; then
  echo "!! Brain exited (code $CODE) during load at context $CTX_WANT — waiting for the RPC workers to answer again, then retrying once at $CTX_FALLBACK."
  if wait_for_workers "${POOL_SPLIT_WORKER_WAIT:-120}"; then
    echo ">> All RPC workers are answering again."
  else
    echo "!! RPC workers still not answering after ${POOL_SPLIT_WORKER_WAIT:-120}s — retrying anyway; the run fails fast if they are truly down."
  fi
  CODE=0
  run_brain "$CTX_FALLBACK" || CODE=$?
fi
exit "$CODE"
