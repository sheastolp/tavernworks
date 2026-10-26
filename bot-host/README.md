# Hosting the bots on the Yoga laptop

GuildScribe and UndercoverBurn run on the Yoga laptop at home as plain Deno
processes instead of Val Town. (The Wandering Clerk stays where it is, on Val
Town and GitHub Actions.)

| Bot | Repo | Local port | Public address |
|-----|------|-----------|----------------|
| GuildScribe | `sheastolp/dnd-twitch-bot` | 8801 | guildscribe.tavernworks.dev |
| UndercoverBurn | `sheastolp/UndercoverBurn` (private) | 8802 | burn.tavernworks.dev |
| GuildScribe for Discord | `sheastolp/guildscribe-discord` | 8803 | guildscribe-discord.tavernworks.dev |

How the pieces fit:

- Each bot is one systemd service (`tavernworks-<bot>`) running its
  `server.ts` as the unprivileged `tavernworks` account: the web side
  (EventSub webhooks, OAuth, dashboards, overlays) on `127.0.0.1` only, plus
  the scheduled jobs that used to be Val Town crons.
- Code: `/var/lib/tavernworks/bots/`. Data: one SQLite file per bot in
  `/var/lib/tavernworks/data/`, backed up every night to
  `/var/lib/tavernworks/data/backups/` (newest 14 kept). Settings (Twitch
  secrets and so on): `/etc/tavernworks/<bot>.env`.
- A **Cloudflare Tunnel** carries the two subdomains to the laptop. No
  ports are opened on the router, and the home IP stays hidden.
- **Deploys:** push to `main` as before. Every 3 minutes the laptop pulls new
  commits, type-checks them and restarts that bot. A commit that doesn't
  type-check isn't started; the bot stays on the last good one.
- **AI replies** (GuildScribe's `!haggle` and NPCs, UndercoverBurn's roasts)
  used Val Town's built-in OpenAI. Now they use either your own
  OpenAI key or Ollama on the Local AI laptop.

All steps below run as **root** (e.g. a `tailscale ssh root@<yoga>` session).
`setup.sh` also works as a normal user, with systemd user services and
everything under the home folder; use `systemctl --user` then.

`<bot>` below is `guildscribe`, `undercoverburn` or `guildscribe-discord`.
GuildScribe for Discord came later; on a laptop that's already set up, see
[Adding GuildScribe for Discord](#adding-guildscribe-for-discord).

## 1. Prepare the Yoga

```sh
apt-get update && apt-get install -y git curl unzip openssh-client

# keep running with the lid shut, never sleep
sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
systemctl restart systemd-logind
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

## 2. Run the setup script

```sh
git clone https://github.com/sheastolp/tavernworks.git /root/tavernworks
bash /root/tavernworks/bot-host/setup.sh
```

Until the bot repos' laptop changes are merged to `main`, install from their
branch instead (clone tavernworks with `-b <branch>` too):

```sh
BRANCH=<branch> bash /root/tavernworks/bot-host/setup.sh
```

The first run creates the `tavernworks` account and installs Deno, then stops
at UndercoverBurn (a private repo) and prints a deploy key. Add it on GitHub:
**UndercoverBurn → Settings → Deploy keys → Add deploy key**, paste it, leave
*Allow write access* off. Then run the same command again to finish.

It installs the services and timers but doesn't start the bots. Running it
again is always safe: it never overwrites settings or data.

## 3. Fill in the settings

```sh
nano /etc/tavernworks/guildscribe.env
nano /etc/tavernworks/undercoverburn.env
```

Copy the values over from where they live today:

- `guildscribe.env` and `undercoverburn.env`: the val's **Environment
  variables** page on Val Town. Copy every variable, including optional ones
  you set.

Leave `PORT` and `DB_PATH` as setup wrote them. For AI replies, pick one in
`guildscribe.env` and `undercoverburn.env`:

```sh
# OpenAI (pay as you go; gpt-4o-mini is what the bots ask for)
OPENAI_API_KEY=sk-...

# or Ollama on the Local AI laptop, free, over the tailnet. Use the HTTPS
# address `tailscale serve status` shows on the AI laptop:
OPENAI_BASE_URL=https://<ai-laptop>.<tailnet>.ts.net/v1
OPENAI_MODEL=llama3.2
```

Without either, the bots still run; only the AI replies fail.

UndercoverBurn can also **hear the streamer**: it pulls each live channel's
audio with `streamlink` and `ffmpeg` (setup installs both) and transcribes it,
so its roasts can react to what the streamer says. With
`OPENAI_API_KEY` set it uses OpenAI's `gpt-4o-mini-transcribe` (about $0.18
per hour of talking; silent stretches aren't sent). To keep it free, run a
Whisper server on the Local AI laptop instead and point it there:

```sh
# on the AI laptop: speaches, an OpenAI-compatible Whisper server, on port 8000
# (CPU build, so it doesn't fight Ollama for the GTX 1650's 4 GB)
docker run --detach --restart unless-stopped --publish 8000:8000 --name speaches \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu
SPEACHES_BASE_URL=http://localhost:8000 uvx speaches-cli model download Systran/faster-distil-whisper-small.en
sudo tailscale serve --bg --https=8443 8000

# in undercoverburn.env
TRANSCRIBE_BASE_URL=https://<ai-laptop>.<tailnet>.ts.net:8443/v1
TRANSCRIBE_MODEL=Systran/faster-distil-whisper-small.en
TRANSCRIBE_LANGUAGE=en
```

It's the "Hear the streamer" switch on UndercoverBurn's `/dashboard`.
**Already set up before this?** Run `setup.sh` again (it adds streamlink,
ffmpeg and the bot's `--allow-run` permission), then
`systemctl restart tavernworks-undercoverburn`.

## 4. Get the tunnel ready (nothing switches yet)

Install `cloudflared` from Cloudflare's package repo and create the tunnel:

```sh
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
apt-get update && apt-get install -y cloudflared

cloudflared tunnel login                    # open the printed link on any device, pick tavernworks.dev
cloudflared tunnel create tavernworks-bots  # prints the tunnel id
```

Write the config, with the id from the last command:

```sh
TID=<tunnel id>
mkdir -p /etc/cloudflared
sed "s/<TUNNEL-ID>/$TID/g" /root/tavernworks/bot-host/cloudflared-config.yml > /etc/cloudflared/config.yml
cloudflared tunnel ingress validate         # should say OK
cloudflared service install
systemctl enable --now cloudflared
```

The tunnel is now running but no hostname points at it yet.

## 5. Cut over: stop the old copies, move the data

Do steps 5 to 7 in one sitting, ideally while no one is streaming. Anything
written on Val Town after the import is lost.

1. **Stop the old copies** so nothing posts twice:
   - Val Town: on the GuildScribe and UndercoverBurn vals, pause or delete
     their cron triggers (GuildScribe's merchant, timed messages, autohunt and
     watchtime crons; UndercoverBurn's poster cron val).

2. **Copy the data.** Each command runs once, as the `tavernworks` account.
   Nothing on Val Town is changed. You need a Val Town API token (val.town →
   Settings → API tokens).

   UndercoverBurn kept its tables in your Val Town account-wide database:

   ```sh
   cd /var/lib/tavernworks/bots/UndercoverBurn
   runuser -u tavernworks -- env HOME=/var/lib/tavernworks \
     DB_PATH=/var/lib/tavernworks/data/undercoverburn.sqlite \
     VAL_TOWN_API_KEY=<token> deno task import-db --valtown-global
   ```

   GuildScribe kept its tables in the val's own database, which the
   account-wide API doesn't reach. Download it from the val on Val Town as a
   `.sqlite` file on your PC, send it to the Yoga with
   `tailscale file cp <file>.sqlite <yoga>:`, then on the Yoga:

   ```sh
   mkdir -p /tmp/gs && tailscale file get /tmp/gs/ && chmod -R a+rX /tmp/gs
   cd /var/lib/tavernworks/bots/dnd-twitch-bot
   runuser -u tavernworks -- env HOME=/var/lib/tavernworks \
     DB_PATH=/var/lib/tavernworks/data/guildscribe.sqlite \
     deno task import-db --file /tmp/gs/<file>.sqlite
   ```

3. **Start the bots** and check them locally:

   ```sh
   systemctl start tavernworks-guildscribe tavernworks-undercoverburn
   systemctl status tavernworks-guildscribe tavernworks-undercoverburn --no-pager
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8801/   # 200
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8802/   # 200
   ```

## 6. Point the subdomains at the laptop

In the Cloudflare dashboard for tavernworks.dev:

1. **Workers routes:** remove the route for `burn.tavernworks.dev/*` and any
   route on `guildscribe.tavernworks.dev`. Leave `hunt.tavernworks.dev` alone.
2. **DNS:** delete the existing records for `guildscribe` and `burn`.
3. **Wildcard custom domains:** on **Workers & Pages → tavernworks → Domains**,
   make sure the website Worker doesn't hold `*.tavernworks.dev`. A wildcard
   custom domain beats the tunnel's DNS records, and every bot subdomain shows
   Cloudflare's "There is nothing here yet" page. Keep only `tavernworks.dev`
   (plus `www.tavernworks.dev` if you use it).

Then on the Yoga:

```sh
cloudflared tunnel route dns tavernworks-bots guildscribe.tavernworks.dev
cloudflared tunnel route dns tavernworks-bots burn.tavernworks.dev
```

Check from your phone (off Wi-Fi): https://guildscribe.tavernworks.dev and
https://burn.tavernworks.dev should both load.

## 7. Twitch settings

GuildScribe and UndercoverBurn already use their tavernworks.dev addresses for
OAuth and EventSub, so existing channels keep working with no reconnect.

Then try a command in a channel for each bot, and watch the logs:
`journalctl -u tavernworks-<bot> -f`.

## 8. Clean up

- Merge the laptop changes in the two bot repos and tavernworks. If you
  installed from a branch, move the laptop onto `main`:

  ```sh
  for r in dnd-twitch-bot UndercoverBurn; do
    runuser -u tavernworks -- env HOME=/var/lib/tavernworks sh -c \
      "cd /var/lib/tavernworks/bots/$r && git fetch -q origin main && git checkout -q -B main origin/main"
  done
  git -C /root/tavernworks fetch -q origin main && git -C /root/tavernworks checkout -q -B main origin/main
  systemctl restart tavernworks-guildscribe tavernworks-undercoverburn
  ```

- Val Town: delete the GuildScribe, UndercoverBurn (roastbot and its cron
  val) vals, and revoke the API token from step 5.
- GitHub: delete the `VAL_TOWN_API_KEY` secret from `dnd-twitch-bot` and
  `UndercoverBurn`.

## Adding GuildScribe for Discord

The Discord bot is its own process with its own database
(`guildscribe-discord.sqlite`); it shares no data with the Twitch bot. It
runs the Twitch bot's game code, copied into its `game/` folder, so it plays
the same. Discord sends each slash command to it over HTTPS, so it only needs
the tunnel, like the others. Its own README covers the Discord side in full.

1. **GitHub:** push the bot to `sheastolp/guildscribe-discord` (public, like
   `dnd-twitch-bot`; make it private and add it to `PRIVATE_REPOS` otherwise).
2. **Yoga:** run `setup.sh` again. It clones the repo, writes
   `/etc/tavernworks/guildscribe-discord.env` and the service. Fill the env
   file in: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`,
   `DISCORD_BOT_TOKEN` and `PUBLIC_BASE_URL=https://guildscribe-discord.tavernworks.dev`
   (plus the AI settings from step 3 for `/haggle`).
3. **Tunnel:** add the hostname to `/etc/cloudflared/config.yml` (it's in
   `cloudflared-config.yml` here) and route it:

   ```sh
   cloudflared tunnel route dns tavernworks-bots guildscribe-discord.tavernworks.dev
   systemctl restart cloudflared
   systemctl start tavernworks-guildscribe-discord
   curl -s https://guildscribe-discord.tavernworks.dev/health   # ok
   ```

4. **Discord:** in the Developer Portal, set the app's **Interactions
   Endpoint URL** to `https://guildscribe-discord.tavernworks.dev/interactions`
   (Discord checks it on save). The bot registers its slash commands itself
   when it starts and they've changed, so a deploy never needs a manual step.
   To force it by hand:

   ```sh
   runuser -u tavernworks -- sh -c 'cd /var/lib/tavernworks/bots/guildscribe-discord && set -a && . /etc/tavernworks/guildscribe-discord.env && deno task register'
   ```

5. **Staying in step with the Twitch bot** needs nothing on the laptop: a
   GitHub Actions workflow in `guildscribe-discord` copies the Twitch bot's
   game code every 15 minutes and commits it only when its type-check and
   tests pass. The updater here then deploys it like any other commit.

## Day to day

| Task | Command |
|------|---------|
| Live log | `journalctl -u tavernworks-<bot> -f` |
| Restart a bot | `systemctl restart tavernworks-<bot>` |
| Change a setting | edit `/etc/tavernworks/<bot>.env`, then restart that bot |
| See recent deploys | `journalctl -u tavernworks-update -n 50` |
| Deploy right now | `systemctl start tavernworks-update` |
| Back up right now | `systemctl start tavernworks-backup` |
| Restore a backup | stop the bot, copy the backup over `/var/lib/tavernworks/data/<bot>.sqlite` (owned by `tavernworks`), delete the `-wal`/`-shm` files next to it, start the bot |

Backups live on the same laptop. For a copy that survives the laptop, sync
`/var/lib/tavernworks/data/backups/` somewhere else now and then.
