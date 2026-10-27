# Local AI web search server

Lets the [browser chat](https://tavernworks.dev/local-ai/chat/) search the
web. With 🌐 switched on (it's on by default), Ollama models that can use
tools get two of them: `web_search`, which searches DuckDuckGo, and
`fetch_page`, which reads a page as plain text. The model decides when to
use them, and the reply lists the searches it ran and the pages it used.
GuildScribe's `!askme` sends its searches through it too
(`ASKME_SEARCH_URL`).

The browser can't ask DuckDuckGo directly (DuckDuckGo doesn't let other
websites read its answers), so this small server on the laptop does it
instead. No API key, no account. Needs Node 18 or newer (the laptop has
Node 22) and has no dependencies. All steps run as **root** on the laptop.

## 1. Copy it to the laptop

```sh
mkdir -p /opt/local-ai-search
curl -fsSL https://tavernworks.dev/local-ai/web-search/server.mjs -o /opt/local-ai-search/server.mjs
```

Check that DuckDuckGo answers:

```sh
node /opt/local-ai-search/server.mjs "ollama tool calling"
```

## 2. Run it as a service

`/etc/systemd/system/local-ai-search.service`:

```ini
[Unit]
Description=Local AI web search
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/local-ai-search/server.mjs
DynamicUser=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`DynamicUser=yes` runs it as a throwaway user instead of root.

```sh
systemctl daemon-reload
systemctl enable --now local-ai-search
systemctl status local-ai-search --no-pager
```

It listens on `127.0.0.1:8791` only.

## 3. Give it an HTTPS address on the tailnet

```sh
tailscale serve --bg --https=8444 http://127.0.0.1:8791
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

Web search needs a model that can use tools, like `llama3.2` or `qwen3:4b`.
If a model can't, it answers without searching and the reply says so. When
search is on, the chat asks Ollama for an 8k context so the results fit.

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
- **Updating:** run step 1's `curl` again, then `systemctl restart local-ai-search`.
- Logs: `journalctl -u local-ai-search`.
