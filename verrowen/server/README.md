# Wake in Verrowen narrator gate

Lets the [game page](https://tavernworks.dev/verrowen/) reach Ollama on the
laptop from anywhere on the internet, through Tailscale Funnel.

The funnel points at this small server instead of at Ollama itself. Anyone
can reach a funnel address, and Ollama's own API can also download, copy and
delete models. This server only lets the game through:

- `POST /narrate` runs one turn on one model (`gemma3:4b` by default), with
  reply length, message count and size capped.
- `POST /save` keeps each player's story on the laptop, one file per player,
  rewritten after every turn, so stories that stop halfway are kept too.
- `GET /health` tells the page whether the narrator is awake.
- Only tavernworks.dev is allowed in from a browser, and every address is
  rate limited (40 turns per 10 minutes, 240 for everyone together).

Ollama itself stays on the tailnet, where the Local AI browser chat uses it as
before. Needs Node 18 or newer (the laptop has Node 22), no dependencies. All
steps run as **root** on the laptop.

## 1. Get the model

```sh
ollama pull gemma3:4b
```

It's about 3.3 GB, so it fits in the GTX 1650's 4 GB. Check it:
`ollama run gemma3:4b "hi"`, then `ollama ps` should say `100% GPU`.

## 2. Copy the server to the laptop

```sh
mkdir -p /opt/verrowen
curl -fsSL https://tavernworks.dev/verrowen/server/server.mjs -o /opt/verrowen/server.mjs
```

## 3. Run it as a service

`/etc/systemd/system/verrowen.service`:

```ini
[Unit]
Description=Wake in Verrowen narrator gate
After=network-online.target ollama.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/verrowen/server.mjs
DynamicUser=yes
StateDirectory=verrowen
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`DynamicUser=yes` runs it as a throwaway user instead of root.
`StateDirectory=verrowen` gives it `/var/lib/verrowen` to save stories in.

```sh
systemctl daemon-reload
systemctl enable --now verrowen
curl http://127.0.0.1:8792/health
```

It should say `"ok":true` and `"ollama":true`. It listens on
`127.0.0.1:8792` only.

## 4. Point the funnel here, not at Ollama

If you ran `tailscale funnel --bg 11434` earlier, Ollama is open to the whole
internet on port 443. Turn that off, put Ollama back on the tailnet only (the
Local AI chat needs it there), and funnel port 8443 to this server instead:

```sh
tailscale funnel --https=443 off
tailscale serve --bg 11434
tailscale funnel --bg --https=8443 http://127.0.0.1:8792
tailscale funnel status
```

`funnel status` should show 443 as tailnet only and 8443 as available on the
internet. From any device, even one not on the tailnet:

```sh
curl https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:8443/health
```

The page has that address built in (`NARRATOR` near the top of its script).
If the laptop's name ever changes, update it there.

## Reading the characters

```sh
VERROWEN_SAVE_DIR=/var/lib/verrowen node /opt/verrowen/server.mjs list
```

lists every saved story, newest first: who played, the character's name, how
many turns, and whether they wrapped it up. Each story is a JSON file in
`/var/lib/verrowen/` with the whole transcript and, once wrapped up, the
character profile. With `DynamicUser=yes`, systemd keeps the files at
`/var/lib/private/verrowen/` and links them there; read them as root.

## Settings

Environment variables, set with `Environment=` in the service file:

| Variable | Default | What it does |
| --- | --- | --- |
| `VERROWEN_MODEL` | `gemma3:4b` | The Ollama model that narrates |
| `VERROWEN_PORT` | `8792` | Port to listen on |
| `VERROWEN_HOST` | `127.0.0.1` | Address to listen on |
| `VERROWEN_ORIGINS` | `https://tavernworks.dev` | Websites allowed to use it, comma-separated |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama is |
| `VERROWEN_SAVE_DIR` | systemd's state directory | Where stories are saved |

Ollama doesn't need `OLLAMA_ORIGINS` for this: the browser talks to this
server, and this server talks to Ollama on the laptop itself.

## Good to know

- **The laptop has to be awake.** The page shows "Narrator asleep" when it
  can't reach this server.
- **One reply at a time.** The GPU writes one reply at a time. Up to 4 players
  can be waiting; past that, the page asks them to try again in a minute.
- **The lore comes from GitHub.** The page loads `lore.md` from the
  [grand-orrery](https://github.com/sheastolp/grand-orrery) repo, so editing
  it there changes the game within a few minutes. Nothing here needs updating.
- **Updating:** run step 2's `curl` again, then `systemctl restart verrowen`.
- Logs: `journalctl -u verrowen`.
