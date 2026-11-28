#!/usr/bin/env bash
# AI Pool M10 — FX705 chain mode (Nov 28): the pooled model, laid out
# by the cost-aware planner (pool_chain.py) and always run with batch
# checking (a draft model guesses ahead; the chain checks the whole
# guess in one pass). It is a third mode beside solo and split and
# never touches their files: it reads only
#   ~/ai-pool/pool-chain-rpc.txt    RPC devices, in layer order
#   ~/ai-pool/pool-chain-split.txt  layer counts (card's last, +1 for output)
#   ~/ai-pool/pool-chain-draft.txt  off | mtp | <draft>.gguf
# which the coordinator's "Start chain" writes from its plan.
set -euo pipefail

POOL_DIR="${HOME:-/root}/ai-pool"
BUILD="b12359"
cd "$POOL_DIR"

MODEL=""
if [ -f "$POOL_DIR/current-model.txt" ]; then
  MODEL="$(head -1 "$POOL_DIR/current-model.txt" | tr -d '[:space:]')"
fi
[ -n "$MODEL" ] || { echo "!! No current-model.txt — pick a model on the control page first."; exit 1; }
[ -f "$MODEL" ] || { echo "!! Model file not in $POOL_DIR: $MODEL"; exit 1; }
echo ">> Mode: chain"
echo ">> Model: $MODEL"

# Ollama holding models in VRAM leaves too little of the 4 GB card
# (same as the split): unload them; the bots reload on next use.
PS_JSON="$(curl -s --max-time 3 http://localhost:11434/api/ps || true)"
if echo "$PS_JSON" | grep -q '"name"'; then
  for m in $(echo "$PS_JSON" | grep -o '"name":"[^"]*"' | cut -d'"' -f4); do
    curl -s --max-time 5 http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null 2>&1 || true
    echo ">> Unloaded Ollama's $m from the card for this session"
  done
fi

# Engine: the same pinned build the split uses.
SERVER="$(find "$POOL_DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || { echo "!! llama-server not found — run the split's fx705-host.sh once to install the engine."; exit 1; }
BIN_DIR="$(dirname "$SERVER")"
CUBLAS="$(find "$POOL_DIR" -name 'libcublas.so*' 2>/dev/null | head -1 || true)"
if [ -n "$CUBLAS" ]; then
  export LD_LIBRARY_PATH="$BIN_DIR:$(dirname "$CUBLAS")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  export LD_LIBRARY_PATH="$BIN_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
VER="$("$SERVER" --version 2>&1 || true)"
case "$VER" in
  *"build 12359"*) echo ">> Host build confirmed: $BUILD" ;;
  *) echo "!! Host binary is not $BUILD — mismatched builds cannot pool."; exit 1 ;;
esac

TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
[ -n "$TS_IP" ] || { echo "!! No tailnet IP — is tailscale up?"; exit 1; }

RPC_LIST=""
[ -f "$POOL_DIR/pool-chain-rpc.txt" ] && RPC_LIST="$(head -1 "$POOL_DIR/pool-chain-rpc.txt" | tr -d '[:space:]')"
[ -n "$RPC_LIST" ] || { echo "!! No chain plan yet — press Start chain on the control page."; exit 1; }
SPLIT=""
[ -f "$POOL_DIR/pool-chain-split.txt" ] && SPLIT="$(head -1 "$POOL_DIR/pool-chain-split.txt" | tr -d '[:space:]')"
case "$SPLIT" in *","*) ;; *) echo "!! pool-chain-split.txt is missing or has one share — press Start chain again."; exit 1 ;; esac
echo ">> RPC devices (coordinator's list): $RPC_LIST"
echo ">> Tensor split: $SPLIT (layer counts in --rpc order; the last is this card's, +1 for the output layer)"

OLD_IFS="$IFS"; IFS=',' read -ra RPC_ENDPOINTS <<< "$RPC_LIST"; IFS="$OLD_IFS"
for EP in "${RPC_ENDPOINTS[@]}"; do
  if (timeout 5 bash -c "exec 3<>/dev/tcp/${EP%:*}/${EP##*:}") 2>/dev/null; then
    echo ">> RPC worker reachable at $EP"
  else
    echo "!! Cannot reach the RPC worker at $EP — press Start chain again so the plan drops it."
    exit 1
  fi
done

# Batch checking. The draft guesses DRAFT_N tokens on this card; the
# chain then runs all of them through every machine in ONE pass, so
# each machine's round trip is paid once per batch, not per token.
DRAFT_MODE=""
[ -f "$POOL_DIR/pool-chain-draft.txt" ] && DRAFT_MODE="$(head -1 "$POOL_DIR/pool-chain-draft.txt" | tr -d '[:space:]')"
DRAFT_N="${POOL_CHAIN_DRAFT_N:-8}"
case "$DRAFT_N" in *[!0-9]*|"") DRAFT_N=8 ;; esac
DRAFT_ARGS=()
case "$DRAFT_MODE" in
  ""|off|OFF|none) DRAFT_MODE="" ;;
  mtp|MTP) DRAFT_MODE="mtp"; DRAFT_ARGS=(--spec-type draft-mtp --spec-draft-n-max 3) ;;
  *.gguf)
    if [ -f "$POOL_DIR/$DRAFT_MODE" ]; then
      DRAFT_ARGS=(-md "$POOL_DIR/$DRAFT_MODE" --spec-type draft-simple
                  -ngld 99 -devd CUDA0 --spec-draft-n-max "$DRAFT_N")
    else
      echo "!! Draft model $DRAFT_MODE is not in $POOL_DIR — running the chain without batch checking."
      DRAFT_MODE=""
    fi ;;
  *) echo "!! pool-chain-draft.txt says '$DRAFT_MODE' — running without batch checking."; DRAFT_MODE="" ;;
esac
if [ -n "$DRAFT_MODE" ]; then
  echo ">> Draft: $DRAFT_MODE (batch checking on, up to $DRAFT_N guesses per pass)"
else
  echo ">> Draft: off"
fi

CTX_WANT="${POOL_CHAIN_CTX:-8192}"
case "$CTX_WANT" in *[!0-9]*|"") CTX_WANT=8192 ;; esac
CTX_FALLBACK=4096
[ "$CTX_WANT" -le "$CTX_FALLBACK" ] && CTX_FALLBACK=""
LOAD_WINDOW="${POOL_CHAIN_LOAD_WINDOW:-900}"

run_brain() {
  "$SERVER" -m "$POOL_DIR/$MODEL" \
    --reasoning off \
    --chat-template-kwargs '{"enable_thinking":false}' \
    --rpc "$RPC_LIST" \
    --tensor-split "$SPLIT" \
    -ngl 99 -fit off \
    -c "$1" \
    ${DRAFT_ARGS[@]+"${DRAFT_ARGS[@]}"} \
    --host "$TS_IP" --port 8090
}
wait_for_workers() {
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
echo ">> Starting the chain at http://$TS_IP:8090 (context $CTX_WANT)"
START=$SECONDS
CODE=0
run_brain "$CTX_WANT" || CODE=$?
if [ -n "$DRAFT_MODE" ] && [ "$CODE" -ne 0 ] && [ "$CODE" -ne 130 ] && [ "$CODE" -ne 131 ] && [ $((SECONDS - START)) -lt "$LOAD_WINDOW" ]; then
  echo "!! Chain exited (code $CODE) during load with draft $DRAFT_MODE — retrying once without it."
  wait_for_workers 120 || true
  DRAFT_ARGS=(); DRAFT_MODE=""
  echo ">> Draft: off"
  START=$SECONDS; CODE=0
  run_brain "$CTX_WANT" || CODE=$?
fi
if [ -n "$CTX_FALLBACK" ] && [ "$CODE" -ne 0 ] && [ "$CODE" -ne 130 ] && [ "$CODE" -ne 131 ] && [ $((SECONDS - START)) -lt "$LOAD_WINDOW" ]; then
  echo "!! Chain exited (code $CODE) during load at context $CTX_WANT — retrying once at $CTX_FALLBACK."
  wait_for_workers 120 || true
  CODE=0
  run_brain "$CTX_FALLBACK" || CODE=$?
fi
exit "$CODE"
