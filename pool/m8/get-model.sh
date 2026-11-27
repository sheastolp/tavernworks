#!/usr/bin/env bash
# AI Pool M8 — download a pool model onto the FX705, checksum-checked.
#
#   bash get-model.sh                 # list the known models
#   bash get-model.sh split           # the split pick (35B-A3B IQ4_XS, ~19 GB)
#   bash get-model.sh solo            # the FX705-alone pick (35B-A3B i1-IQ3_M, ~15 GB)
#   bash get-model.sh phones-gpu      # the file Adreno phone GPUs can compute (~22 GB)
#   bash get-model.sh qwen3.8         # Huihui Qwen3.8 27B abliterated IQ4_XS (~15 GB), dense
#   bash get-model.sh qwen3.8-q4km    # the same at Q4_K_M (~17 GB)
#   bash get-model.sh <file.gguf>     # any file from the list
#   bash get-model.sh delete <file>   # delete a downloaded model (asks first)
#
# The file lands in ~/ai-pool, where the coordinator's model picker
# lists it with its fit check; pick it there and Start split/solo.
# Downloads resume if interrupted. Workers pre-download from the same
# Hugging Face address (the front's /model.json), so the split itself
# sends almost nothing over this laptop's upload.
set -euo pipefail
POOL_DIR="${HOME:-/root}/ai-pool"
mkdir -p "$POOL_DIR"; cd "$POOL_DIR"

MR="https://huggingface.co/mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-GGUF/resolve/main"
MRI="https://huggingface.co/mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-i1-GGUF/resolve/main"
Q38="https://huggingface.co/mradermacher/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main"
NX="https://huggingface.co/noctrex/Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE-GGUF/resolve/main"
# file | url | sha256 | size note
MODELS="
Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf|$MR/Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf|070cbf105010853960c1b0dfecf394c9296d1e8af394bacc40bbb017448b5987|18.9 GB, split pick
Huihui-Qwen3.5-35B-A3B-abliterated.Q4_K_M.gguf|$MR/Huihui-Qwen3.5-35B-A3B-abliterated.Q4_K_M.gguf|f3321b73521fbab3b95c2b05d8ea940042933527d8056f7d1f6c3bf569011cea|21.2 GB, a bigger pool
Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE.gguf|$NX/Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE.gguf|75d0d71d8160af32a2f24e9d2a8df404a7cb1b42fe03318f3300930d485168d9|22.1 GB, Adreno phone GPUs compute
Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_M.gguf|$MRI/Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_M.gguf|26df5bf33a108044fa57fc2f54d38d620ec55b63a29deffcc0f16b43d7ef4714|15.4 GB, solo pick
Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_XXS.gguf|$MRI/Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_XXS.gguf|cea1e91f2cdba2eba8f1e3a2da3edcce0172aa37c8820c421680d330633c767a|13.5 GB, solo if IQ3_M won't fit
Huihui-Qwen3.8-27B-abliterated.IQ4_XS.gguf|$Q38/Huihui-Qwen3.8-27B-abliterated.IQ4_XS.gguf|46cbac118fcfd398da6f48091ee7c0ed443f4bbce1137667ac11a45fb7a3f6dc|15.5 GB, Qwen3.8 27B dense
Huihui-Qwen3.8-27B-abliterated.Q4_K_M.gguf|$Q38/Huihui-Qwen3.8-27B-abliterated.Q4_K_M.gguf|4225f7248586317aedf4f1cd3370ec25eca1c1dcd2ddf7c22145a36b4ec40eac|16.9 GB, Qwen3.8 27B dense
"

WANT="${1:-}"

# Delete a downloaded model: bash get-model.sh delete <file.gguf>
# Refuses the pool's current model and any file something has open.
if [ "$WANT" = "delete" ]; then
  F="${2:-}"
  case "$F" in ""|*/*|.*) echo "!! Name one .gguf in $POOL_DIR, e.g. bash get-model.sh delete My-Model.gguf"; ls -1sh "$POOL_DIR"/*.gguf 2>/dev/null; exit 1 ;; esac
  [ -f "$F" ] || { echo "!! $F is not in $POOL_DIR. On disk:"; ls -1sh "$POOL_DIR"/*.gguf 2>/dev/null; exit 1; }
  CUR="$(cat current-model.txt 2>/dev/null | tr -d '[:space:]')"
  [ "$F" != "$CUR" ] || { echo "!! $F is the pool's current model. Pick another one first."; exit 1; }
  if grep -qsF " $POOL_DIR/$F" /proc/[0-9]*/maps 2>/dev/null || \
     { ls -l /proc/[0-9]*/fd 2>/dev/null || true; } | grep -qF -- "-> $POOL_DIR/$F"; then
    echo "!! $F is open right now (a running brain, a download or a checksum). Try again once that finishes."; exit 1
  fi
  echo ">> $F is $(du -h "$F" | cut -f1). Delete it for good?"
  read -r -p "   Type yes to delete: " OK
  [ "$OK" = "yes" ] || { echo ">> Kept $F."; exit 0; }
  rm -f -- "$F" && echo ">> Deleted $F. Free now: $(df -h --output=avail "$POOL_DIR" | tail -1 | tr -d ' ')"
  exit 0
fi

case "$WANT" in
  split) WANT="Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf" ;;
  solo) WANT="Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_M.gguf" ;;
  phones-gpu) WANT="Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE.gguf" ;;
  qwen3.8) WANT="Huihui-Qwen3.8-27B-abliterated.IQ4_XS.gguf" ;;
  qwen3.8-q4km) WANT="Huihui-Qwen3.8-27B-abliterated.Q4_K_M.gguf" ;;
esac
if [ -z "$WANT" ]; then
  echo "Known models (bash get-model.sh <file|split|solo|phones-gpu|qwen3.8|qwen3.8-q4km>)"
  echo "Delete one: bash get-model.sh delete <file>"
  echo "$MODELS" | awk -F'|' 'NF==4 {printf "  %-55s %s\n", $1, $4}'
  exit 0
fi
LINE="$(echo "$MODELS" | awk -F'|' -v w="$WANT" '$1==w')"
[ -n "$LINE" ] || { echo "!! Unknown model: $WANT (run with no argument for the list)"; exit 1; }
URL="$(echo "$LINE" | cut -d'|' -f2)"; SHA="$(echo "$LINE" | cut -d'|' -f3)"

# Disk: the file plus 2 GB to spare.
NEED_GB="$(echo "$LINE" | cut -d'|' -f4 | grep -o '^[0-9.]*')"
FREE_GB="$(df -BG --output=avail "$POOL_DIR" | tail -1 | tr -dc '0-9')"
HAVE=0; [ -f "$WANT" ] && HAVE="$(( $(stat -c %s "$WANT") / 1073741824 ))"
if awk -v n="$NEED_GB" -v f="$FREE_GB" -v h="$HAVE" 'BEGIN{exit !(n + 2 - h > f)}'; then
  echo "!! Not enough disk in $POOL_DIR: needs about $NEED_GB GB + 2 GB spare, has ${FREE_GB} GB free."
  echo "   Free some space (old .gguf files you no longer use) and run this again."
  exit 1
fi

echo ">> Downloading $WANT ($(echo "$LINE" | cut -d'|' -f4)) — resumable, safe to re-run."
wget -c "$URL" -O "$WANT"
echo ">> Checking the SHA-256 (takes a minute) ..."
echo "$SHA  $WANT" | sha256sum -c - || { echo "!! Checksum MISMATCH — delete $POOL_DIR/$WANT and run this again."; exit 1; }
echo ">> Ready: $POOL_DIR/$WANT"
echo ">> Next: on the coordinator page (Models on the host), pick it and Start split or solo."
