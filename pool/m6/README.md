# AI Pool — M6: accounts + shares

Status: built 2026-11-17. Extends the M5 public front door with user
accounts and the mining-pool shares ledger from DESIGN.md, and gives
the tailnet coordinator the operator controls for them. MCP (the
third door) is M7.

## The doors (all on the public front, pool.tavernworks.dev)

- `GET /register` — signup page. `POST /register {name}` creates an
  account and returns its personal key **once**; only the key's
  SHA-256 is stored. Accounts start **pending**.
- `GET /chat` — the web chat page. The browser keeps the key in
  localStorage and talks to the API door; it also hosts the
  machine-linking form.
- `POST /v1/chat/completions` — the API door (OpenAI-shaped), header
  `Authorization: Bearer <key>`. `GET /v1/models` likewise.
- `POST /link` — body `{enrollment_id, enrollment_key}` with the
  account key as Bearer: links an approved enrollment to the account
  so the machine's earnings land in the account.
- `GET /me` — `{name, status, balance}` for a Bearer key.
- `GET /shares.json` — published stats: rates, approved accounts'
  balances, all-time totals. The pool page renders this.
- `GET /queue.json` — `{inflight, waiting, paused}`.

## Shares (operator-tunable on the coordinator, Shares section)

Defaults in `~/ai-pool/shares-config.json` (created on first save):

- starter 100 — credited once, when the operator approves the account.
- earn 1.0 per GB-hour — a relay-connected, linked machine accrues
  offered-GB x hours x this rate; x3 (worked multiplier) while its
  endpoint is in the live split. Accrued by the front every minute.
- spend 10 per 1,000 tokens generated — charged after a successful
  reply, from the response's usage (estimated if usage is absent).
  A request is refused at 0 balance; one in-flight request can
  overdraw, the next is refused.
- caps: max 1024 output tokens per request (requests asking for more
  are clamped), 48,000 conversation chars, 2 public generations at
  once (the rest of the queue waits, FIFO, position visible via
  /queue.json). Streaming is refused on the public door for now.

The ledger `~/ai-pool/ledger.jsonl` is append-only; balances are a
fold of it. Lines record who / when / kind / shares / a short detail
("chat 250 tokens", "worked rig 0.5h") — never prompt or reply text.

## The reserved lane

Nothing about the bots changes: Burn and the lore-keeper talk to the
brain directly on the tailnet and never pass through the front, so
public usage cannot starve them — and the queue cap leaves brain
slots free for them. Pausing public usage (coordinator, Shares
section) closes the chat/API doors without touching the bots.

## Operator flow

1. Someone registers at /register and tells you their account name.
2. Coordinator → Accounts (public): Approve (starter credited) or
   Revoke. Gift adds shares to any approved account.
3. Their machine enrolls as before; they link it from /chat with the
   enrollment id + key; earnings start with the next split/online
   tick (base rate while merely connected, worked rate in a split).

## Refresh on the FX705

```
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5/pool-front.py" -o /opt/ai-pool/pool-front.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m3/pool-coordinator.py" -o /opt/ai-pool/pool-coordinator.py
sudo systemctl restart pool-front pool-coordinator
```

Then register your own account at https://pool.tavernworks.dev/register,
approve it here on the coordinator, and gift it a comfortable balance.
