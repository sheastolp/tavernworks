#!/usr/bin/env bash
# AI Pool worker — one-step setup (Linux).
#
# Downloads the pool worker from the pool's own downloads shelf
# and starts it. First run enrolls this machine (name = this
# PC's hostname, offered memory = a conservative auto-size) and
# waits for the operator's approval; once approved it prints a
# personal link that ties the machine to your pool account.
# Any extra arguments are passed through to the worker, e.g.:
#   bash install-worker.sh --offered-mb 4096
set -euo pipefail

SHELF="https://pool.tavernworks.dev/downloads"
DIR="${HOME}/pool-worker"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required — install it first (e.g. sudo apt install python3), then run this again."
  exit 1
fi

mkdir -p "$DIR"
echo "Downloading the pool worker from $SHELF ..."
curl -fsSL "$SHELF/pool-worker.py" -o "$DIR/pool-worker.py"
echo "Starting the worker — leave it running; it enrolls this"
echo "machine and waits for the operator's approval."
exec python3 "$DIR/pool-worker.py" "$@"
