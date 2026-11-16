#!/usr/bin/env bash
# AI Pool M1 — test the pooled model and read its speed.
# Run on the FX705 (or pass another tailnet machine's view):
#   ./test-pool.sh [FX705-tailnet-IP]
set -euo pipefail

HOST_IP="${1:-$(tailscale ip -4 2>/dev/null | head -1 || true)}"
[ -n "$HOST_IP" ] || { echo "Usage: ./test-pool.sh <FX705 tailnet IP>"; exit 1; }

curl -s "http://$HOST_IP:8090/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Roast a streamer who just whiffed an easy shot, one short sentence."}],"max_tokens":60}' \
| python3 -c '
import json, sys
d = json.load(sys.stdin)
print("REPLY:", d["choices"][0]["message"]["content"])
pps = d.get("timings", {}).get("predicted_per_second")
if pps:
    print(f"SPEED: {pps:.1f} tok/s")
    print("  >= 5   good for Burn, banter included")
    print("  3 - 5  workable; watch banter timing live")
    print("  < 3    retune: bigger FX705 share in --tensor-split, or smaller -c")
else:
    print("No timings in the response — check the host terminal for errors.")
'
