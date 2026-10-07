# Hushwave suggestion box server

A small server that keeps Hushwave suggestions on your own machine, in one
JSON file. Anyone can drop a suggestion in from
[tavernworks.dev/hushwave](https://tavernworks.dev/hushwave/). Only the admin
can read them, at
[tavernworks.dev/hushwave/suggestions](https://tavernworks.dev/hushwave/suggestions/),
signing in with Google or the admin password.

The same server and login also hold the homepage tip jar links, edited
at [tavernworks.dev/tips](https://tavernworks.dev/tips/). Anyone can read
those links; only the admin can change them.

It also stores [TwitchBotSandbox](https://tavernworks.dev/bot-sandbox/app/)
projects for anyone who signs in there with Google. Each Google account gets
its own folder of projects, layout and GitHub/Val Town tokens (encrypted),
with a backup made automatically about once an hour while they work and
before every restore (the newest 30 per account are kept). The app's
**Backups…** button lists, restores and downloads them, and **Delete my
data** removes an account completely. See "Google sign-in" below to turn it on.

It runs on the Local AI laptop, next to Ollama and the Claude bridge. It
needs Node 18 or newer and has no dependencies.

## 1. Copy it to the laptop

```sh
mkdir -p ~/suggestion-box
curl -fsSL https://tavernworks.dev/hushwave/suggestion-box/server.mjs -o ~/suggestion-box/server.mjs
```

## 2. Set the admin password

```sh
node ~/suggestion-box/server.mjs set-password
```

This is the admin login. Run it again any time to change the password, which
also signs out every open session (linked Google accounts stay linked).

To sign in to the admin pages with Google instead, press **Sign in with
Google** on `/tips/` or `/hushwave/suggestions/`. The first time, the page
asks for the admin password once to link that Google account; after that,
Google alone opens them. (Or list the account's email in
`SUGGEST_ADMIN_EMAILS` to skip linking.) Linked accounts are kept, hashed, in
`admin.json`; delete its `googleAdmins` list to unlink them all.

Suggestions, tip links, sandbox accounts (`sandbox/users/`) and the password
hash live in `~/.local/share/hushwave-suggestions/`. `sandbox/secrets.key`
encrypts everyone's saved tokens; keep that folder out of anything you share.

## 3. Run it as a service

`~/.config/systemd/user/suggestion-box.service`:

```ini
[Unit]
Description=Hushwave suggestion box

[Service]
ExecStart=/usr/bin/env node %h/suggestion-box/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now suggestion-box
sudo loginctl enable-linger $USER   # keep it running when you're logged out
```

It listens on `127.0.0.1:8790` only.

## 4. Make it reachable from the internet

Visitors aren't on your tailnet, so this one port goes public with
Tailscale Funnel. Ollama and the bridge stay private.

```sh
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8790
```

It prints an address like `https://<machine>.<tailnet>.ts.net:10000`. If
Funnel isn't allowed yet, the command prints a link to turn it on in the
Tailscale admin console.

## 5. Point the site at it

Put that address in `hushwave/suggest-config.js` on the site:

```js
window.SUGGEST_API = "https://<machine>.<tailnet>.ts.net:10000";
```

## Google sign-in (TwitchBotSandbox and the admin pages)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create a project, then **Create credentials → OAuth client ID**. If it asks,
   set up the consent screen first: External, app name "Tavernworks", your email.
2. Application type **Web application**. Under **Authorized JavaScript
   origins** add `https://tavernworks.dev`. No redirect URIs are needed.
3. Copy the **Client ID** (ends in `.apps.googleusercontent.com`; it isn't a
   secret). Put it in `bot-sandbox/app/config.js` on the site and in
   `GOOGLE_CLIENT_ID` near the top of `server.mjs` (or set
   `SANDBOX_GOOGLE_CLIENT_ID` in the service's environment). Tavernworks' own
   ID is already filled in both.
4. On the consent screen, click **Publish app** so anyone can sign in, not
   just test users.

The first time you sign in with Google from a browser that's still logged in
as the tip jar admin, the projects you saved with the old password sign-in
move into your Google account.

## Settings

Environment variables, set with `Environment=` lines in the service file:

| Variable | Default | |
|---|---|---|
| `SUGGEST_PORT` | `8790` | Local port |
| `SUGGEST_ORIGINS` | `https://tavernworks.dev` | Sites allowed to use it, comma-separated |
| `SUGGEST_DATA_DIR` | `~/.local/share/hushwave-suggestions` | Where suggestions are stored |
| `SANDBOX_GOOGLE_CLIENT_ID` | built in | Google OAuth Client ID for sandbox and admin sign-in |
| `SUGGEST_ADMIN_EMAILS` | none | Google emails that can open the admin pages without linking, comma-separated |
| `SANDBOX_MAX_USERS` | `500` | Most sandbox accounts it will create |

## Updating

To pick up a newer `server.mjs` (for example, the sandbox storage), download it
again and restart. Set up as above (a user service):

```sh
curl -fsSL https://tavernworks.dev/hushwave/suggestion-box/server.mjs -o ~/suggestion-box/server.mjs
systemctl --user restart suggestion-box
```

If it runs as a system service instead (`systemctl status suggestion-box`
works without `--user`), this finds the file the service runs, swaps it and
restarts:

```sh
F=$(systemctl show -p ExecStart --value suggestion-box | grep -o '/[^ ;]*server\.mjs' | head -1)
curl -fsSL https://tavernworks.dev/hushwave/suggestion-box/server.mjs -o /tmp/server.mjs \
  && sudo cp /tmp/server.mjs "$F" && sudo systemctl restart suggestion-box \
  && sudo journalctl -u suggestion-box -n 3 --no-pager
```

## Troubleshooting

- **Log:** `journalctl --user -u suggestion-box` (system service: `sudo journalctl -u suggestion-box`)
- **"Too many tries":** five wrong passwords lock logins from that address for 15 minutes.
- **Spam:** each address can send five suggestions per 10 minutes, and a hidden form field catches simple bots.
