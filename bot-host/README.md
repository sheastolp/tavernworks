# Hosting the bots on the Yoga laptop

GuildScribe, UndercoverBurn and The Wandering Clerk run on the Yoga laptop at
home as plain Deno processes. Nothing runs on Val Town any more.

| Bot | Repo | Local port | Public address |
|-----|------|-----------|----------------|
| GuildScribe | `sheastolp/dnd-twitch-bot` | 8801 | guildscribe.tavernworks.dev |
| UndercoverBurn | `sheastolp/UndercoverBurn` | 8802 | burn.tavernworks.dev |
| The Wandering Clerk | `sheastolp/The-Wandering-Clerk` | 8803 | hunt.tavernworks.dev |

How the pieces fit:

- Each bot is one systemd user service (`tavernworks-<bot>`) running its
  `server.ts`: the web side (EventSub webhooks, OAuth, dashboards, overlays) on
  `127.0.0.1` only, plus the scheduled jobs that used to be Val Town crons. The
  Clerk's chat bot runs in the same process and stays connected (no more
  6-hour GitHub Actions runs).
- Data is one SQLite file per bot in `~/.local/share/tavernworks/`, backed up
  every night to `~/.local/share/tavernworks/backups/` (newest 14 kept).
- Settings (Twitch secrets and so on) are in `~/.config/tavernworks/<bot>.env`.
- A **Cloudflare Tunnel** carries the three subdomains to the laptop. No
  ports are opened on the router, and the laptop's home IP stays hidden.
- **Deploys:** push to `main` as before. Every 3 minutes the laptop pulls new
  commits, type-checks them and restarts that bot. A commit that doesn't
  type-check isn't started; the bot stays on the last good one.
- **AI replies** (GuildScribe's `!haggle` and NPCs, UndercoverBurn's chat
  commentary) used Val Town's built-in OpenAI. Now they use either your own
  OpenAI key or Ollama on the Local AI laptop.

The Local AI laptop keeps what it already runs (Ollama, Open WebUI, the
suggestion box). The bots don't depend on it, except for AI replies if you
point them at its Ollama.

## 1. Prepare the Yoga

Ubuntu with `git` and `curl` (`sudo apt install -y git curl`). Keep it awake
with the lid shut, like the Local AI laptop:

```sh
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

If the bot repos are private, give the laptop read access first, for example
`sudo apt install gh && gh auth login && gh auth setup-git`.

## 2. Run the setup script

```sh
curl -fsSL https://tavernworks.dev/bot-host/setup.sh -o setup.sh
bash setup.sh
```

It installs Deno, clones the three repos into `~/bots`, creates the settings
files, installs the services and timers, and turns on lingering so they run
while you're logged out. It doesn't start the bots yet. Running it again is
safe: it never overwrites settings or data.

## 3. Fill in the settings

Edit each file in `~/.config/tavernworks/`. Copy the values over from where
they live today:

- `guildscribe.env` and `undercoverburn.env`: the val's **Environment
  variables** page on Val Town. Copy every variable, including optional ones
  you set.
- `clerk.env`: the Clerk repo's GitHub Actions secrets (bot tokens) and the
  `huntandhoardbot` val's environment variables (`ADMIN_USERNAMES`,
  `ADMIN_SESSION_SECRET`). `VALTOWN_API_BASE_URL`, `VALTOWN_API_SECRET` and
  `API_SHARED_SECRET` aren't needed any more.

For AI replies, pick one in `guildscribe.env` and `undercoverburn.env`:

```sh
# OpenAI (pay as you go; gpt-4o-mini is what the bots ask for)
OPENAI_API_KEY=sk-...

# or Ollama on the Local AI laptop, free. The Yoga must be on the tailnet
# (curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up).
# Use the HTTPS address `tailscale serve status` shows on the AI laptop:
OPENAI_BASE_URL=https://<ai-laptop>.<tailnet>.ts.net/v1
OPENAI_MODEL=llama3.2
```

Without either, the bots still run; only the AI replies fail.

## 4. Move the data off Val Town

Do this right before the switch in step 6, so little changes on Val Town in
between. Each command runs once, with that bot stopped, from its folder.
Nothing on Val Town is changed.

**UndercoverBurn** kept its tables in your Val Town account-wide database.
Create an API token at val.town → Settings → API tokens, then:

```sh
cd ~/bots/UndercoverBurn
export DB_PATH=~/.local/share/tavernworks/undercoverburn.sqlite
VAL_TOWN_API_KEY=<token> deno task import-db --valtown-global
```

**GuildScribe** kept its tables in the val's own database (std/sqlite
`main.ts`), which the account-wide API doesn't reach. Download that database
as a `.sqlite` file from the val on Val Town, then:

```sh
cd ~/bots/dnd-twitch-bot
export DB_PATH=~/.local/share/tavernworks/guildscribe.sqlite
deno task import-db --file ~/Downloads/<the download>.sqlite
```

**The Wandering Clerk** copies over the old val's storage API, plus a scan of
your Val Town databases for character sheets:

```sh
cd ~/bots/The-Wandering-Clerk
export DB_PATH=~/.local/share/tavernworks/clerk.sqlite
OLD_API_SECRET=<the val's API_SHARED_SECRET> VAL_TOWN_API_KEY=<token> deno task import-db
```

If it reports `characters: 0`, the val stored them somewhere the scan can't
see. Don't switch the val off yet; the characters need another route out.

## 5. Start the bots

```sh
systemctl --user start tavernworks-guildscribe tavernworks-undercoverburn tavernworks-clerk
systemctl --user status tavernworks-guildscribe     # should say active (running)
curl -s http://127.0.0.1:8801/ | head -5           # GuildScribe answers locally
journalctl --user -u tavernworks-guildscribe -f     # live log (Ctrl+C to leave)
```

## 6. Point the subdomains at the laptop (Cloudflare Tunnel)

Install `cloudflared`
([Cloudflare's package repo](https://pkg.cloudflare.com/index.html) has the
Ubuntu steps), then:

```sh
cloudflared tunnel login                    # pick the tavernworks.dev zone in the browser
cloudflared tunnel create tavernworks-bots  # prints the tunnel id
mkdir -p ~/.cloudflared
curl -fsSL https://tavernworks.dev/bot-host/cloudflared-config.yml -o ~/.cloudflared/config.yml
nano ~/.cloudflared/config.yml              # fill in the tunnel id and your home folder
```

Then the cut-over. In the Cloudflare dashboard for tavernworks.dev:

1. **Workers routes:** remove the route for `burn.tavernworks.dev/*` and any
   route on `guildscribe.tavernworks.dev`. Keep `hunt.tavernworks.dev/*`, and
   redeploy that Worker from `cloudflare/hunt-worker.js` in this repo: it still
   serves the onboarding page, and now passes everything else through to the
   tunnel.
2. **DNS:** delete the existing records for `guildscribe`, `burn` and `hunt`
   (the placeholders for the Workers, or a Val Town custom domain).
3. Route the names to the tunnel and run it as a system service:

```sh
cloudflared tunnel route dns tavernworks-bots guildscribe.tavernworks.dev
cloudflared tunnel route dns tavernworks-bots burn.tavernworks.dev
cloudflared tunnel route dns tavernworks-bots hunt.tavernworks.dev
sudo cloudflared --config ~/.cloudflared/config.yml service install
```

Check from your phone (off Wi-Fi): https://guildscribe.tavernworks.dev,
https://burn.tavernworks.dev and https://hunt.tavernworks.dev/onboard should
all load.

## 7. Twitch settings

- **GuildScribe and UndercoverBurn** already use their tavernworks.dev
  addresses for OAuth and EventSub, so existing channels keep working with no
  reconnect.
- **The Wandering Clerk** used `huntandhoardbot.val.run` for sign-in. In the
  [Twitch developer console](https://dev.twitch.tv/console/apps), add these
  OAuth Redirect URLs to its app:
  `https://hunt.tavernworks.dev/oauth/callback` and
  `https://hunt.tavernworks.dev/admin/callback`.

## 8. Switch Val Town off

Once everything answers from the laptop:

- On Val Town, delete (or at least disable) the GuildScribe, UndercoverBurn
  (roastbot and its cron val) and `huntandhoardbot` vals and their cron
  triggers.
- On GitHub, delete the `VAL_TOWN_API_KEY` secret from `dnd-twitch-bot` and
  `UndercoverBurn`, and the bot secrets from `The-Wandering-Clerk` (its
  workflow is gone). The deploy workflows were removed from the repos.
- Revoke the Val Town API token you made for step 4.

## Day to day

| Task | Command |
|------|---------|
| Live log | `journalctl --user -u tavernworks-<bot> -f` |
| Restart a bot | `systemctl --user restart tavernworks-<bot>` |
| Change a setting | edit `~/.config/tavernworks/<bot>.env`, then restart that bot |
| See recent deploys | `journalctl --user -u tavernworks-update -n 50` |
| Deploy right now | `systemctl --user start tavernworks-update` |
| Back up right now | `systemctl --user start tavernworks-backup` |
| Restore a backup | stop the bot, copy the backup over `~/.local/share/tavernworks/<bot>.sqlite`, delete the `-wal`/`-shm` files next to it, start the bot |

`<bot>` is `guildscribe`, `undercoverburn` or `clerk`.

Backups live on the same laptop. For a copy that survives the laptop, sync
`~/.local/share/tavernworks/backups/` somewhere else now and then.
