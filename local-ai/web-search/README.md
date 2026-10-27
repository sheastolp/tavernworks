# Local AI web search server

Lets the [browser chat](https://tavernworks.dev/local-ai/chat/) search the
web. With 🌐 switched on (it's on by default), Ollama models that can use
tools get two of them: `web_search`, which searches DuckDuckGo, and
`fetch_page`, which reads a page as plain text. The model decides when to
use them, and the reply lists the searches it ran and the pages it used.

The browser can't ask DuckDuckGo directly (DuckDuckGo doesn't let other
websites read its answers), so this small server on the laptop does it
instead. No API key, no account. It runs next to Ollama and the Claude
bridge, needs Node 18 or newer and has no dependencies.

## 1. Copy it to the laptop

```sh
mkdir -p ~/local-ai-search
curl -fsSL https://tavernworks.dev/local-ai/web-search/server.mjs -o ~/local-ai-search/server.mjs
```

Check that DuckDuckGo answers:

```sh
node ~/local-ai-search/server.mjs "ollama tool calling"
```

## 2. Run it as a service

`~/.config/systemd/user/local-ai-search.service`:

```ini
[Unit]
Description=Local AI web search

[Service]
ExecStart=/usr/bin/env node %h/local-ai-search/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now local-ai-search
sudo loginctl enable-linger $USER   # keep it running when you're logged out
```

It listens on `127.0.0.1:8791` only.

## 3. Give it an HTTPS address on the tailnet

```sh
sudo tailscale serve --bg --https=8444 http://127.0.0.1:8791
```

The address is `https://<machine>.<tailnet>.ts.net:8444`, the same name as
Ollama's with `:8444` on the end (`tailscale serve status` lists it). Like
Ollama, only devices on your tailnet can reach it. Opening
`<address>/health` in a tab should show `{"ok":true,"engine":"duckduckgo"}`.

## 4. Connect the chat

In the chat, open **⚙ Connection settings**, paste the address into **Search
server address**, hit **Test connection**, then **Save**. 🌐 next to 📎 turns
web search on and off; the choice is remembered in that browser.

## Models

Web search needs a model that can use tools. On the GTX 1650's 4 GB,
`qwen3:4b`, `qwen2.5:3b` and `llama3.2:3b` fit and can. If a model can't,
it answers without searching and the reply says so. When search is on, the
chat asks Ollama for an 8k context so the results fit.

## Settings

Environment variables, set with `Environment=` in the service file:

| Variable | Default | What it does |
| --- | --- | --- |
| `SEARCH_PORT` | `8791` | Port to listen on |
| `SEARCH_HOST` | `127.0.0.1` | Address to listen on |
| `SEARCH_ORIGINS` | `https://tavernworks.dev` | Websites allowed to use it, comma-separated |
| `SEARCH_REGION` | `wt-wt` (no region) | DuckDuckGo region, e.g. `us-en`, `uk-en` |

## Good to know

- DuckDuckGo limits automated searches. The server spaces its searches out
  and keeps results for 15 minutes, but after a burst DuckDuckGo may ask for
  a captcha for a while. The chat then shows that the search failed, and the
  model answers without it. Wait a few minutes.
- `fetch_page` only reads public addresses. It refuses anything on the home
  network, the tailnet or the laptop itself, so the model can't be talked
  into poking around your network.
- Logs: `journalctl --user -u local-ai-search`.
