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
- `GET /health` tells the page whether the narrator is awake, and which
  model narrates.
- `/admin/models` and `/admin/model` let the owner switch the narrator
  model from the page, with the owner's token.
- Only tavernworks.dev is allowed in from a browser, and every address is
  rate limited (40 turns per 10 minutes, 240 for everyone together).
- If the browser hangs up before a reply is sent (the player pressed
  **Stop**, or closed the page), the server cancels it in Ollama, so the GPU
  is free at once for the next turn, such as a **Resend**.

The [Orrery Explorer](https://tavernworks.dev/orrery/#chat)'s chat (the
lore-keeper, which helps create and review characters and work out
worldbuilding and mechanics) uses the same
`/narrate` and `/health`, the same model and the same rate limits. It sends
its own instructions and the orrery's documents in the first message, so
nothing here changes for it.

Ollama itself stays on the tailnet. The Local AI browser chat has its own
gate ([local-ai/gate](../../local-ai/gate/)). Needs Node 18 or newer (the laptop has Node 22), no dependencies. All
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

## Changing the narrator model (owner only)

The footers of the game, the Codex and the Orrery have **🤖 Change AI model**,
and the Orrery control page (**🔒 Admin**) has the same switch. It needs the owner's
token, which the server makes the first time it starts:

```sh
VERROWEN_SAVE_DIR=/var/lib/verrowen node /opt/verrowen/server.mjs token
```

Paste it in, press **Show the models** to list what's installed in Ollama,
pick one and press **Use this model**. It's for every player from their next
turn on, and stays after a restart (kept in `narrator-model.txt` in the save
folder). Without the token, nobody else can change it. To start over with a
new token, delete `owner-token.txt` there and restart the service.

Stick to models that fit the GTX 1650's 4 GB, or every turn gets slow.

## The Review Clone (owner only)

Every change to the universe lands on grand-orrery's `review` branch first,
never straight on `main`. `main` is the live Orrery: the Explorer, the
lore-keeper and the narrator all read it. The **Review Clone** page
(`/orrery/control/review/`, from **🔒 Admin**) shows everything waiting on
`review`, file by file, and a preview of the whole Orrery as it would look.
**Publish to the live Orrery** puts it on `main`; **Throw it all away** resets
`review` back to `main`.

The page also shows your **latest lore-keeper chat**. On any browser where
you've entered the owner's token (on the control page, the Review Clone or
the model picker), every message you send the lore-keeper and every reply
saves the whole chat to the laptop, as `lorekeeper-latest.json` in the save
folder. Each save replaces the last, so only the most recent chat is kept.
Visitors' chats aren't saved.

Publishing goes through this server, so it needs the owner's token and a
GitHub token on the laptop:

1. On GitHub, make a fine-grained personal access token for
   `sheastolp/grand-orrery` only, with **Contents: Read and write**.
2. Add it to the service file and restart:

   ```ini
   Environment=ORRERY_GITHUB_TOKEN=github_pat_...
   ```

   ```sh
   systemctl daemon-reload && systemctl restart verrowen
   ```

To make sure nothing skips the review, protect `main` on GitHub
(**Settings → Branches → Add rule**, require a pull request) and let only
the token above bypass it, or simply commit to `review` every time.

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
| `VERROWEN_MODEL` | `gemma3:4b` | The model that narrates until the owner picks another on the page |
| `VERROWEN_PORT` | `8792` | Port to listen on |
| `VERROWEN_HOST` | `127.0.0.1` | Address to listen on |
| `VERROWEN_ORIGINS` | `https://tavernworks.dev` | Websites allowed to use it, comma-separated |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama is |
| `VERROWEN_SAVE_DIR` | systemd's state directory | Where stories are saved |
| `ORRERY_GITHUB_TOKEN` | (none) | Lets the owner publish the Review Clone. Without it, publishing says so |
| `ORRERY_REPO` | `sheastolp/grand-orrery` | The repo whose `review` branch is the Review Clone |

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
