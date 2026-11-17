# AI Pool — M7: MCP both ways

Status: built 2026-11-17. The last designed phase: the pool speaks
MCP in both directions.

## Out — the pool as an MCP server

`POST https://pool.tavernworks.dev/mcp` — JSON-RPC 2.0 (MCP
Streamable HTTP, plain JSON responses), authenticated with the same
personal account key as the other doors, in an
`Authorization: Bearer <key>` header. Tools:

- `pool_chat` — chat with the pooled model. Runs through the exact
  same path as the API door: same queue, same caps, same shares
  charged per token generated. The reply text carries the cost and
  the remaining balance.
- `pool_status` — brain / model / serving / split / speed.
- `pool_models` — what the brain currently serves.
- `pool_balance` — the calling account's status and balance.

Client setup (Claude, or any MCP client that takes a remote server
with headers):

```json
{
  "mcpServers": {
    "ai-pool": {
      "url": "https://pool.tavernworks.dev/mcp",
      "headers": { "Authorization": "Bearer <your account key>" }
    }
  }
}
```

Pending accounts can look (status/models/balance) but cannot chat;
revoked keys are refused at the door.

## In — registered MCP servers, offered to the model

The operator registers MCP servers on the tailnet coordinator
(**MCP servers** section: name, URL, optional Bearer key). When a
chat request opts in — the chat page's "Let the model use
registered tools" checkbox, or `"mcp_tools": true` on the API
door — the front:

1. asks each enabled server for its tools (30s cache) and offers
   them to the model, namespaced `<server>__<tool>`;
2. when the model calls a tool, executes it against that server
   and feeds the result back, up to 3 rounds;
3. charges shares on the total tokens across all rounds.

Servers that are down are skipped, never fatal. Tool results are
capped at 8,000 chars. **Register only servers you trust** — a
tool's output lands in the model's context, and a malicious or
sloppy tool can steer replies. Server keys live only in
`~/ai-pool/mcp-servers.json` on the FX705.

## Refresh on the FX705

```
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m5/pool-front.py" -o /opt/ai-pool/pool-front.py
curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/sheastolp/tavernworks/contents/pool/m3/pool-coordinator.py" -o /opt/ai-pool/pool-coordinator.py
sudo systemctl restart pool-front pool-coordinator
```
