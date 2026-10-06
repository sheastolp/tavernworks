# Hushwave suggestion box server

A small server that keeps Hushwave suggestions on your own machine, in one
JSON file. Anyone can drop a suggestion in from
[tavernworks.dev/hushwave](https://tavernworks.dev/hushwave/). Only one
admin password can read them, at
[tavernworks.dev/hushwave/suggestions](https://tavernworks.dev/hushwave/suggestions/).

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

This is the one login. Run it again any time to change the password, which
also signs out every open session.

Suggestions and the password hash live in `~/.local/share/hushwave-suggestions/`.

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

## Settings

Environment variables, set with `Environment=` lines in the service file:

| Variable | Default | |
|---|---|---|
| `SUGGEST_PORT` | `8790` | Local port |
| `SUGGEST_ORIGINS` | `https://tavernworks.dev` | Sites allowed to use it, comma-separated |
| `SUGGEST_DATA_DIR` | `~/.local/share/hushwave-suggestions` | Where suggestions are stored |

## Troubleshooting

- **Log:** `journalctl --user -u suggestion-box`
- **"Too many tries":** five wrong passwords lock logins from that address for 15 minutes.
- **Spam:** each address can send five suggestions per 10 minutes, and a hidden form field catches simple bots.
