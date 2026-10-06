# Hushwave suggestion box server

A small server that keeps Hushwave suggestions on your own machine, in one
JSON file. Anyone can drop a suggestion in from
[tavernworks.dev/hushwave](https://tavernworks.dev/hushwave/). Only one
admin password can read them, at
[tavernworks.dev/hushwave/suggestions](https://tavernworks.dev/hushwave/suggestions/).

The same server and password also hold the homepage tip jar links, edited
at [tavernworks.dev/tips](https://tavernworks.dev/tips/). Anyone can read
those links; only the admin can change them.

It's also the support desk: anyone can open a support ticket and follow it
with a private key, and the admin answers and triages them. See
[Support tickets](#support-tickets) below for the API.

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

Suggestions, tip links, tickets and the password hash live in `~/.local/share/hushwave-suggestions/`.

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

## Support tickets

All JSON. "Admin" means `Authorization: Bearer <token>` from `POST /login`.
"Key" means the `X-Ticket-Key` header with the key handed back when the
ticket was opened. `:id` can be the ticket's id or its short number.

| Request | Who | |
|---|---|---|
| `POST /tickets` | Anyone | Open one. Body: `name`, `email` (optional), `category`, `subject`, `message`. Returns `{ id, number, key, status }`. The key is shown once and only its hash is kept, so the page must hand it to the person. |
| `GET /tickets/:id` | Key or admin | The ticket and its thread. With a key, internal notes, email, priority and tags are left out. |
| `POST /tickets/:id/messages` | Key or admin | Reply. Body: `message`. Admin can add `"internal": true` for a private note, or `status` to set something other than the default. |
| `POST /tickets/:id/resolve` | Key | The person who opened it marks it solved. |
| `GET /tickets?status=&q=` | Admin | Summaries, newest first, with per-status `counts`. `needsReply` is true when the last word was theirs. `q` searches subject, name, email, number and messages. |
| `PATCH /tickets/:id` | Admin | Any of `status`, `priority`, `category`, `tags`. |
| `DELETE /tickets/:id` | Admin | Remove it for good. |

Statuses: `open` (needs you), `pending` (waiting on them), `resolved`,
`closed`. An admin reply moves a ticket to `pending`; their reply moves it
back to `open`, even from `resolved`. Closed tickets take no more customer
replies. Priorities: `low`, `normal`, `high`, `urgent`. Categories are the
`TICKET_CATEGORIES` list at the top of `server.mjs`, also returned by
`GET /tickets`.

## Updating

To pick up a newer `server.mjs` (for example, the tip jar links), download it
again and restart:

```sh
curl -fsSL https://tavernworks.dev/hushwave/suggestion-box/server.mjs -o ~/suggestion-box/server.mjs
systemctl --user restart suggestion-box
```

## Troubleshooting

- **Log:** `journalctl --user -u suggestion-box`
- **"Too many tries":** five wrong passwords lock logins from that address for 15 minutes.
- **Spam:** each address can send five suggestions or three new tickets per 10 minutes, and a hidden `website` form field catches simple bots.
- **Ticket keys:** twenty wrong keys from one address lock ticket lookups for 15 minutes. A lost key can't be recovered; the admin can still reply, or the person can open a new ticket.
