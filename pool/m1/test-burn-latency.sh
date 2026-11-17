#!/usr/bin/env bash
# AI Pool — Burn-shaped latency test against the solo/pool server.
# Sends requests sized like Burn's real ones (persona + grounding:
# recent chat, transcript, a quote) and reports the numbers that
# decide live feel: prompt-reading (prefill) speed, generation
# speed, and total seconds per reply. Run on the FX705:
#   ./test-burn-latency.sh [FX705-tailnet-IP]
set -euo pipefail

HOST_IP="${1:-$(tailscale ip -4 2>/dev/null | head -1 || true)}"
[ -n "$HOST_IP" ] || { echo "Usage: ./test-burn-latency.sh <FX705 tailnet IP>"; exit 1; }
export POOL_URL="http://$HOST_IP:8090"

echo ">> Waiting for the server at $POOL_URL ..."
for i in $(seq 1 200); do
  if curl -s "$POOL_URL/health" | grep -q '"status":"ok"'; then
    echo ">> Server is up."
    break
  fi
  if [ "$i" = "200" ]; then
    echo "!! Server not ready after 10 minutes — check: journalctl -u ai-pool-solo -n 40 (or ai-pool-host for the split)"
    exit 1
  fi
  sleep 3
done

python3 - <<'PY'
import json, os, time, urllib.request

URL = os.environ["POOL_URL"] + "/v1/chat/completions"

PERSONA = (
    "You are Burn, the roast bot in a Twitch channel. You post short, flat, "
    "one-sentence roasts. Never repeat or quote what the streamer or chat said; "
    "use it only as material for a fresh line. Never mention shells of any kind. "
    "Every image in a roast must be a real, concrete thing from the game or the "
    "situation, never an invented mash-up. Keep a light touch: most roasts are "
    "plain, with at most one small Mushroom Kingdom reference when it truly fits, "
    "drawn from your own season there long ago. The streamer speaks with a West "
    "Virginia Appalachian dialect; that is real speech, not garble. Aim roasts at "
    "people active in the recent chat or at the streamer when he calls on you. "
    "One sentence, no preamble, no quotes around the roast."
)

CHAT = "\n".join([
    "pixelranger: that corner peek was criminal",
    "doomdaisy: CLIP IT",
    "marcus_v: he had the whole magazine and landed two",
    "pixelranger: two generous",
    "lilwomp: the aim assist is on vacation",
    "doomdaisy: ranked ready btw",
    "sable_fox: i counted three whiffs that fight",
    "marcus_v: four if you count the reload panic",
    "lilwomp: coach is writing this down",
    "sable_fox: streamer diff",
])

TRANSCRIPT = (
    "all right we take those, we take those... nah that corner is free every "
    "single round, watch this... okay that one is on me, that one is on me, "
    "chat saw nothing... run it back, same peek, he will not expect it twice"
)

QUOTE = "Quote #112: Slow is smooth, smooth is fast, and brother you are neither."

def run(label, user, max_tokens, good, workable):
    body = {
        "messages": [
            {"role": "system", "content": PERSONA},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.85,
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as res:
        d = json.load(res)
    wall = time.time() - t0
    if "choices" not in d:
        print(f"{label}: NO REPLY — server answered: {json.dumps(d)[:300]}")
        return
    t = d.get("timings", {})
    reply = d["choices"][0]["message"]["content"].strip()
    pn, pps = t.get("prompt_n", 0), t.get("prompt_per_second", 0)
    gn, gps = t.get("predicted_n", 0), t.get("predicted_per_second", 0)
    print(f"\n== {label} ==")
    print(f"REPLY: {reply}")
    print(f"prompt: {pn} tokens read at {pps:.1f} tok/s | generation: {gn} tokens at {gps:.1f} tok/s")
    print(f"TOTAL: {wall:.1f}s   (<= {good}s good | {good}-{workable}s workable | > {workable}s sluggish for this job)")

run(
    "Scheduled roast (big grounding prompt)",
    f"Recent chat:\n{CHAT}\n\nRecent streamer speech (material only, never quote it):\n{TRANSCRIPT}\n\nA quote from the channel collection: {QUOTE}\n\nWrite one roast of the streamer for chat.",
    60, 30, 60,
)
run(
    "Banter reply (streamer just called on Burn)",
    f"Recent chat:\n{CHAT}\n\nThe streamer just said to you: \"Burn, you seeing this aim today?\" Reply to him directly, conversational, one short sentence. Do not repeat his words.",
    40, 12, 20,
)
PY
