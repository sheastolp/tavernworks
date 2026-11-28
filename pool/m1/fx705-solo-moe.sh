#!/usr/bin/env bash
# AI Pool — tuned SOLO for MoE models on the FX705 (beside, not
# instead of, the hand-edited fx705-solo.sh, which this never touches).
#
# Two changes from plain solo, both Sheamus's picks (Nov 28):
#  1. Experts in RAM, the rest on the card: -ngl 99 with --n-cpu-moe N.
#     The big, sparsely-used expert weights of the first N blocks stay
#     in the FX705's RAM; attention, the shared expert, the output
#     layer, the KV cache and the last blocks' experts go on the 4 GB
#     card. N comes from solo_moe_fit.py (the card's free memory at
#     start), or from ~/ai-pool/solo-cpu-moe.txt if that file holds a
#     number.
#  2. Batch checking with the 0.8B draft (~/ai-pool/solo-draft.txt:
#     off, or a .gguf in ~/ai-pool; default Qwen3.5-0.8B-Q4_K_M.gguf
#     when it is on disk). The draft guesses POOL_SOLO_DRAFT_N tokens
#     (default 4) and the main model checks them in one pass.
#
# If a load fails, it steps down once at a time: more experts in RAM,
# then no draft, then every expert in RAM. Used by the ai-pool-solo
# service through the drop-in ai-pool-solo-moe.conf; remove the
# drop-in to go back to plain solo.
set -euo pipefail

POOL_DIR="${HOME:-/root}/ai-pool"
[ "$POOL_DIR" = "/ai-pool" ] && POOL_DIR="/root/ai-pool"
HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="${POOL_SOLO_CTX:-16384}"
LOAD_WINDOW="${POOL_SOLO_LOAD_WINDOW:-600}"
cd "$POOL_DIR"

MODEL="${1:-}"
if [ -z "$MODEL" ] && [ -f "$POOL_DIR/current-model.txt" ]; then
  MODEL="$(head -1 "$POOL_DIR/current-model.txt" | tr -d '[:space:]')"
fi
[ -n "$MODEL" ] || { echo "!! No model chosen — pick one on the control page first."; exit 1; }
[ -f "$MODEL" ] || { echo "!! Model file not in $POOL_DIR: $MODEL"; exit 1; }
echo ">> Model: $MODEL"

# Free the card: unload Ollama's resident models.
PS_JSON="$(curl -s --max-time 5 http://localhost:11434/api/ps || true)"
for m in $(echo "$PS_JSON" | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do
  curl -s --max-time 10 http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null 2>&1 || true
  echo ">> Unloaded Ollama's $m from the card"
done

SERVER="$(find "$POOL_DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || { echo "!! llama-server not found under $POOL_DIR."; exit 1; }
BIN_DIR="$(dirname "$SERVER")"
CUBLAS="$(find "$POOL_DIR" -name 'libcublas.so*' 2>/dev/null | head -1 || true)"
export LD_LIBRARY_PATH="$BIN_DIR${CUBLAS:+:$(dirname "$CUBLAS")}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
HELP="$("$SERVER" --help 2>&1 || true)"
has() { grep -q -- "$1" <<< "$HELP"; }

TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
[ -n "$TS_IP" ] || { echo "!! No tailnet IP — is tailscale up?"; exit 1; }

# ---- draft ----
DRAFT=""
DRAFT_LINE=""
[ -f "$POOL_DIR/solo-draft.txt" ] && DRAFT_LINE="$(head -1 "$POOL_DIR/solo-draft.txt" | tr -d '[:space:]')"
case "$DRAFT_LINE" in
  off|OFF|none) DRAFT="" ;;
  *.gguf) DRAFT="$DRAFT_LINE" ;;
  *) DRAFT="Qwen3.5-0.8B-Q4_K_M.gguf" ;;
esac
if [ -n "$DRAFT" ] && [ ! -f "$POOL_DIR/$DRAFT" ]; then
  echo "!! Draft $DRAFT is not in $POOL_DIR — solo runs without batch checking."
  DRAFT=""
fi
DRAFT_N="${POOL_SOLO_DRAFT_N:-4}"
case "$DRAFT_N" in *[!0-9]*|"") DRAFT_N=4 ;; esac
if has "--spec-draft-n-max"; then DRAFT_MAX_FLAG="--spec-draft-n-max"
elif has "--draft-max"; then DRAFT_MAX_FLAG="--draft-max"
else DRAFT_MAX_FLAG=""; fi
draft_args() {
  [ -n "$DRAFT" ] || return 0
  printf '%s\n' -md "$POOL_DIR/$DRAFT" -ngld 99 -devd CUDA0
  has "--spec-type" && printf '%s\n' --spec-type draft-simple
  [ -n "$DRAFT_MAX_FLAG" ] && printf '%s\n' "$DRAFT_MAX_FLAG" "$DRAFT_N"
  return 0
}
DRAFT_MB=0
[ -n "$DRAFT" ] && DRAFT_MB=$(( $(stat -c %s "$POOL_DIR/$DRAFT") / 1048576 ))

# ---- experts in RAM ----
has "--n-cpu-moe" || { echo "!! This llama-server has no --n-cpu-moe; use plain solo."; exit 1; }
FREE_MB="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ' || true)"
case "$FREE_MB" in ''|*[!0-9]*) FREE_MB=3800 ;; esac
N_LAYERS=""
if [ -f "$POOL_DIR/solo-cpu-moe.txt" ]; then
  N_LAYERS="$(head -1 "$POOL_DIR/solo-cpu-moe.txt" | tr -d '[:space:]')"
  case "$N_LAYERS" in *[!0-9]*) N_LAYERS="" ;; esac
  [ -n "$N_LAYERS" ] && echo ">> Experts in RAM for the first $N_LAYERS blocks (from solo-cpu-moe.txt)"
fi
if [ -z "$N_LAYERS" ]; then
  N_LAYERS="$(python3 "$HERE/solo_moe_fit.py" "$MODEL" "$FREE_MB" "$CTX" "$DRAFT_MB" 2>/dev/null || true)"
  case "$N_LAYERS" in ''|*[!0-9]*) echo "!! Couldn't size the experts for $MODEL (not a MoE model?) — use plain solo."; exit 1 ;; esac
  echo ">> Card has $FREE_MB MB free: experts of the first $N_LAYERS blocks stay in RAM, the rest on the card"
fi
# The block count: what "every expert in RAM" needs.
ALL="$(python3 "$HERE/solo_moe_fit.py" "$MODEL" 0 "$CTX" 2>/dev/null || echo 99)"
case "$ALL" in ''|*[!0-9]*) ALL=99 ;; esac

run_brain() {   # $1 = n-cpu-moe, $2 = 1 with draft
  local args=()
  if [ "$2" = 1 ] && [ -n "$DRAFT" ]; then
    mapfile -t args < <(draft_args)
    echo ">> Draft: $DRAFT (batch checking on, up to $DRAFT_N guesses per pass)"
  else
    echo ">> Draft: off"
  fi
  echo ">> Starting tuned SOLO at http://$TS_IP:8090 (context $CTX, --n-cpu-moe $1)"
  "$SERVER" -m "$MODEL" \
    --reasoning off \
    --chat-template-kwargs '{"enable_thinking":false}' \
    -ngl 99 -fit off \
    --n-cpu-moe "$1" \
    -c "$CTX" \
    ${args[@]+"${args[@]}"} \
    --host "$TS_IP" --port 8090
}

try() {   # returns 0 if the server ran past the load window and ended normally
  local start=$SECONDS code=0
  run_brain "$1" "$2" || code=$?
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then exit "$code"; fi
  if [ $((SECONDS - start)) -ge "$LOAD_WINDOW" ]; then exit "$code"; fi   # died after loading: let systemd restart
  echo "!! Tuned solo exited (code $code) while loading with --n-cpu-moe $1, draft $([ "$2" = 1 ] && echo "${DRAFT:-off}" || echo off)."
  return 1
}

MORE=$(( N_LAYERS + 4 )); [ "$MORE" -gt "$ALL" ] && MORE="$ALL"
try "$N_LAYERS" 1 || true
echo ">> Retrying with more experts in RAM"
try "$MORE" 1 || true
if [ -n "$DRAFT" ]; then
  echo ">> Retrying without the draft"
  try "$MORE" 0 || true
fi
echo ">> Last try: every expert in RAM, no draft"
try "$ALL" 0 || exit 1
