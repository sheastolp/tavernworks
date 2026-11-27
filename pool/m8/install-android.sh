#!/data/data/com.termux/files/usr/bin/bash
# AI Pool worker — one-step setup for Android, in Termux.
#
# Install Termux from F-Droid (the Play Store build is outdated), open
# it, and run:
#   curl -fsSL https://pool.tavernworks.dev/downloads/install-android.sh -o install-android.sh && bash install-android.sh
#
# What it does: installs Python, fetches the pool worker from the
# pool's own downloads shelf, and starts it. The worker enrolls the
# phone (named after its model, offering about a third of its RAM),
# waits for the operator's approval, then downloads llama.cpp's own
# Android engine at the pool's pinned version:
#   - Snapdragon phones with an Adreno 7xx/8xx GPU (8 Gen 2 and newer,
#     plus 8 Gen 1 / 7-series with Adreno 7xx) get the Adreno build and
#     lend their GPU whenever the pool's model is one the GPU can run;
#   - every other phone (Mali, PowerVR, older Adreno) gets the CPU
#     build and lends its RAM and CPU.
# Extra arguments pass straight to the worker, e.g.
#   bash install-android.sh --offered-mb 4096
#   bash install-android.sh --backend cpu
set -euo pipefail

SHELF="https://pool.tavernworks.dev/downloads"
DIR="${HOME}/pool-worker"

if [ -z "${PREFIX:-}" ] || [ ! -d "${PREFIX}" ]; then
  echo "This script is for Termux on Android. On a PC use install-worker.sh / install-worker.bat."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "Installing Python and curl (Termux packages) ..."
  pkg install -y python curl
fi
# Optional: the Termux:API add-on lets the worker see the battery
# (it yields when unplugged or hot). Without it the worker can't tell,
# so keep the phone on its charger.
if ! command -v termux-battery-status >/dev/null 2>&1; then
  echo "Tip: install the Termux:API app (F-Droid) and run 'pkg install termux-api'"
  echo "     so the worker can pause when the phone is unplugged or hot."
fi

mkdir -p "$DIR"
echo "Downloading the pool worker from $SHELF ..."
curl -fsSL "$SHELF/pool-worker.py" -o "$DIR/pool-worker.py"

# Keep Android from putting Termux to sleep while the worker runs.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

echo "Starting the worker. Leave Termux open and the phone plugged in;"
echo "it enrolls this phone and waits for the operator's approval."
exec python3 "$DIR/pool-worker.py" "$@"
