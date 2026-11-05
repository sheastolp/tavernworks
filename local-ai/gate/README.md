# Local AI gate

Lets the [browser chat](https://tavernworks.dev/local-ai/chat/) reach the
FX705 from any device, through Tailscale Funnel. Visitors don't need
Tailscale, and there's nothing to set up in the chat: it always talks to this
gate.

The funnel points at this small server, not at Ollama itself. Anyone can
reach a funnel address, and Ollama's own API can also download, copy and
delete models. This server only lets the chat through:

- `GET /api/tags` lists the installed models (names and sizes only).
- `POST /api/chat` streams one reply from an installed model. Only the
  model, the messages, images and a context size go through, all capped. If
  the chat asks for tools, the model only gets the two web tools.
- `GET /search` and `GET /fetch` go to the [web search server](../web-search/)
  on the laptop, so 🌐 works too.
- `GET /health` tells the chat whether Ollama and search are up.
- Only tavernworks.dev is allowed in from a browser. Each address gets 60
  replies per 10 minutes (400 for everyone together) and 120 searches; at
  most 4 replies wait for the GPU at once.

The Claude Code bridge does **not** go through here. It can run commands on
the laptop, so it stays on the tailnet behind its token.

Needs Node 18 or newer (the laptop has Node 22), no dependencies. All steps
run as **root** on the laptop.

## 1. Copy it to the laptop

```sh
mkdir -p /opt/local-ai-gate
curl -fsSL https://tavernworks.dev/local-ai/gate/server.mjs -o /opt/local-ai-gate/server.mjs
```

## 2. Run it as a service

`/etc/systemd/system/local-ai-gate.service`:

```ini
[Unit]
Description=Local AI gate
After=network-online.target ollama.service local-ai-search.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/local-ai-gate/server.mjs
DynamicUser=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now local-ai-gate
curl http://127.0.0.1:8793/health
```

It should say `"ollama":true`, and `"search":true` if the web search server
is running. It listens on `127.0.0.1:8793` only.

## 3. Put it on the funnel

Funnel can only use ports 443, 8443 and 10000. 443 is Ollama on the tailnet
and 8443 is the Verrowen narrator, so the gate gets 10000:

```sh
tailscale funnel --bg --https=10000 http://127.0.0.1:8793
tailscale funnel status
```

From any device, even one not on the tailnet:

```sh
curl https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:10000/health
```

The chat has that address built in (`LAPTOP` near the top of its script). If
the laptop's name ever changes, update it there.

## Settings

Environment variables, set with `Environment=` in the service file:

| Variable | Default | What it does |
| --- | --- | --- |
| `GATE_MODELS` | every installed model | Only offer these models, comma-separated |
| `GATE_MAX_CTX` | `32768` | Largest context window a chat may ask for |
| `GATE_PORT` | `8793` | Port to listen on |
| `GATE_HOST` | `127.0.0.1` | Address to listen on |
| `GATE_ORIGINS` | `https://tavernworks.dev` | Websites allowed to use it, comma-separated |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama is |
| `SEARCH_URL` | `http://127.0.0.1:8791` | Where the web search server is |

Ollama doesn't need `OLLAMA_ORIGINS` for this: the browser talks to the gate,
and the gate talks to Ollama on the laptop itself.

## Good to know

- **The laptop has to be awake.** The chat says "Can't reach the laptop" when
  it can't reach the gate.
- **Big models are slow for everyone.** The GPU writes one reply at a time.
  `GATE_MODELS` keeps the list to the ones that run well.
- **Updating:** run step 1's `curl` again, then `systemctl restart local-ai-gate`.
- Logs: `journalctl -u local-ai-gate`.
