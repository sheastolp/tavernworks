#!/usr/bin/env bash
# AI Pool M8 — download a pool model onto the FX705, checksum-checked.
#
#   bash get-model.sh                 # list the known models
#   bash get-model.sh split           # the split pick (35B-A3B IQ4_XS, ~19 GB)
#   bash get-model.sh solo            # the FX705-alone pick (35B-A3B i1-IQ3_M, ~15 GB)
#   bash get-model.sh phones-gpu      # the file Adreno phone GPUs can compute (~22 GB)
#   bash get-model.sh 32b             # Qwen2.5 32B abliterated IQ4_XS (~18 GB), the 14B's big sibling
#   bash get-model.sh 32b-q4km        # the same at Q4_K_M (~20 GB)
#   bash get-model.sh <file.gguf>     # any file from the list
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
Q32="https://huggingface.co/mradermacher/Qwen2.5-32B-Instruct-abliterated-GGUF/resolve/main"
NX="https://huggingface.co/noctrex/Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE-GGUF/resolve/main"
# file | url | sha256 | size note
MODELS="
Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf|$MR/Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf|070cbf105010853960c1b0dfecf394c9296d1e8af394bacc40bbb017448b5987|18.9 GB, split pick
Huihui-Qwen3.5-35B-A3B-abliterated.Q4_K_M.gguf|$MR/Huihui-Qwen3.5-35B-A3B-abliterated.Q4_K_M.gguf|f3321b73521fbab3b95c2b05d8ea940042933527d8056f7d1f6c3bf569011cea|21.2 GB, a bigger pool
Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE.gguf|$NX/Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE.gguf|75d0d71d8160af32a2f24e9d2a8df404a7cb1b42fe03318f3300930d485168d9|22.1 GB, Adreno phone GPUs compute
Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_M.gguf|$MRI/Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_M.gguf|26df5bf33a108044fa57fc2f54d38d620ec55b63a29deffcc0f16b43d7ef4714|15.4 GB, solo pick
Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_XXS.gguf|$MRI/Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_XXS.gguf|cea1e91f2cdba2eba8f1e3a2da3edcce0172aa37c8820c421680d330633c767a|13.5 GB, solo if IQ3_M won't fit
Qwen2.5-32B-Instruct-abliterated.IQ4_XS.gguf|$Q32/Qwen2.5-32B-Instruct-abliterated.IQ4_XS.gguf|f157190d92a442824100873e0251db96ed77b9ceccf3d80eed46fffda3912542|17.9 GB, the 14B's 32B sibling, split pick
Qwen2.5-32B-Instruct-abliterated.Q4_K_S.gguf|$Q32/Qwen2.5-32B-Instruct-abliterated.Q4_K_S.gguf|e0c1067d72f45f2ffc8dfd282e1d4d8575c689b6fa8edb5f402701de017dc51d|18.8 GB, 32B dense
Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf|$Q32/Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf|e63617fd56c8585fe78fe05bcbb3b36e0b5ef3857e11233cdd1dc9ba56f38001|19.9 GB, 32B dense, same quant as the 14B
Qwen2.5-32B-Instruct-abliterated.Q3_K_L.gguf|$Q32/Qwen2.5-32B-Instruct-abliterated.Q3_K_L.gguf|8f4dafa2ca29eaf914d78f1af247dd368bc408addadde6b1f72d1a6eed469e1d|17.2 GB, 32B dense, smaller
"

WANT="${1:-}"
case "$WANT" in
  split) WANT="Huihui-Qwen3.5-35B-A3B-abliterated.IQ4_XS.gguf" ;;
  solo) WANT="Huihui-Qwen3.5-35B-A3B-abliterated.i1-IQ3_M.gguf" ;;
  phones-gpu) WANT="Huihui-Qwen3.5-35B-A3B-abliterated-MXFP4_MOE.gguf" ;;
  32b) WANT="Qwen2.5-32B-Instruct-abliterated.IQ4_XS.gguf" ;;
  32b-q4km) WANT="Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf" ;;
esac
if [ -z "$WANT" ]; then
  echo "Known models (bash get-model.sh <file|split|solo|phones-gpu|32b|32b-q4km>):"
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
