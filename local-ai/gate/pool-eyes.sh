#!/usr/bin/env bash
# Gives the AI Pool's brain eyes, so Rosin and the Local AI chat can see photos.
#
# It starts the usual /opt/ai-pool/fx705-solo.sh, but first looks in ~/ai-pool for the vision file (an "mmproj")
# that belongs to the model it's about to load, named like the model:
#   Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf  ->  Huihui-Qwen3.5-35B-A3B-abliterated.mmproj-Q8_0.gguf
# If there is one, llama-server gets it (LLAMA_ARG_MMPROJ) and keeps it in RAM rather than on the 4 GB card
# (LLAMA_ARG_NO_MMPROJ_OFFLOAD), so the model's own share of the card stays the same. Pick a model with no
# matching file and it starts exactly as before, without eyes, instead of failing on a file that doesn't fit it.
#
# Install (see tavernworks.dev/local-ai/#eyes): save as /opt/ai-pool/pool-eyes.sh, chmod +x, and point
# ai-pool-solo.service at it with a drop-in. To turn eyes off, delete the mmproj file and restart the service.
set -euo pipefail

POOL_DIR="${HOME:-/root}/ai-pool"
MODEL="${1:-}"
if [ -z "$MODEL" ] && [ -f "$POOL_DIR/current-model.txt" ]; then
  MODEL="$(head -1 "$POOL_DIR/current-model.txt" | tr -d '[:space:]')"
fi

if [ -n "$MODEL" ]; then
  base="${MODEL%.gguf}"   # Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS
  base="${base%.*}"       # Huihui-Qwen3.5-35B-A3B-abliterated (the quant comes off; "Qwen3.5" keeps its dot)
  base="${base%-[IiQqFfBb][Qq0-9]*}"   # also "Model-Q4_K_M" style names
  MM=""
  for f in "$POOL_DIR/$base".mmproj*.gguf "$POOL_DIR/$base"-mmproj*.gguf "$POOL_DIR/mmproj-$base"*.gguf; do
    [ -f "$f" ] && { MM="$f"; break; }
  done
  if [ -n "$MM" ]; then
    echo ">> Eyes: $(basename "$MM") (kept in RAM)"
    export LLAMA_ARG_MMPROJ="$MM"
    export LLAMA_ARG_NO_MMPROJ_OFFLOAD=1
  else
    echo ">> No vision file for $base in $POOL_DIR, so no eyes this time."
  fi
fi

exec /opt/ai-pool/fx705-solo.sh "$@"
