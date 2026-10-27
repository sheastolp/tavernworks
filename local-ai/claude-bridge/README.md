# Claude Code bridge

Lets the [browser chat](https://tavernworks.dev/local-ai/chat/) use
[Claude Code](https://claude.com/claude-code) on the Local AI laptop. Once
it's set up, the chat's model list gains **Claude Code**, **Claude Code ·
Opus** and **Claude Code · Sonnet**. Each message runs Claude Code in a work
folder on the laptop, the reply streams back with the files it read or
edited and what it cost, and later messages carry on the same session.

It's optional and rarely used: the local Ollama models don't need it.
It runs Claude Code on your Claude account, so its use counts against that
account like any other Claude Code session.

What Claude Code may do here, by default: read and edit files in its work
folder (`/var/lib/claude-bridge/workspace`) and search the web. It can't run
commands (`Bash` is turned off), as no one is at the laptop to approve them.
It runs as its own user, `claude-bridge`, not root.

Needs Node 18 or newer (the laptop has Node 22) and has no dependencies.
All steps run as **root** on the laptop.

## 1. Install Claude Code

```sh
npm install -g @anthropic-ai/claude-code
claude --version
```

## 2. Make a user for it and log in

```sh
useradd --system --create-home --home-dir /var/lib/claude-bridge --shell /bin/bash claude-bridge
sudo -u claude-bridge -i claude
```

Claude Code starts and asks you to log in: pick your Claude account, open
the link it prints on any device, and paste the code back. Then type
`/exit`.

## 3. Copy the bridge to the laptop

```sh
mkdir -p /opt/claude-bridge
curl -fsSL https://tavernworks.dev/local-ai/claude-bridge/server.mjs -o /opt/claude-bridge/server.mjs
sudo -u claude-bridge node /opt/claude-bridge/server.mjs token
```

The last command makes the bridge's token and prints it. You'll paste it
into the chat in step 6; run it again any time to see it.

## 4. Run it as a service

`/etc/systemd/system/claude-bridge.service`:

```ini
[Unit]
Description=Claude Code bridge
After=network-online.target
Wants=network-online.target

[Service]
User=claude-bridge
Environment=HOME=/var/lib/claude-bridge
ExecStart=/usr/bin/node /opt/claude-bridge/server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now claude-bridge
systemctl status claude-bridge --no-pager
```

It listens on `127.0.0.1:8792` only.

## 5. Give it an HTTPS address on the tailnet

```sh
tailscale serve --bg --https=8445 http://127.0.0.1:8792
```

The address is `https://<machine>.<tailnet>.ts.net:8445`. Only devices on
your tailnet can reach it, and every request also needs the token.

## 6. Connect the chat

In the chat, open **⚙ Connection settings**, fill in **Bridge address** (the
`:8445` address) and **Bridge token** (from step 3), hit **Test connection**,
then **Save**. The Claude Code models appear in the model list.

## Settings

Environment variables, set with `Environment=` in the service file:

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAUDE_BRIDGE_CWD` | `~/workspace` | The folder Claude Code works in |
| `CLAUDE_BRIDGE_MODE` | `acceptEdits` | Claude Code's permission mode |
| `CLAUDE_BRIDGE_DISALLOW` | `Bash` | Tools it may not use, comma-separated (empty allows all) |
| `CLAUDE_BRIDGE_TIMEOUT_S` | `600` | Longest a single reply may take |
| `CLAUDE_BRIDGE_MAX_JOBS` | `2` | Replies that may run at once |
| `CLAUDE_BRIDGE_PORT` | `8792` | Port to listen on |
| `CLAUDE_BRIDGE_ORIGINS` | `https://tavernworks.dev` | Websites allowed to use it, comma-separated |
| `CLAUDE_BRIDGE_TOKEN_FILE` | `~/.config/claude-bridge/token` | Where the token is kept |

## Good to know

- **"Claude Code isn't logged in"** in the chat: do step 2's
  `sudo -u claude-bridge -i claude` again and log in.
- **New token:** delete `/var/lib/claude-bridge/.config/claude-bridge/token`,
  run `systemctl restart claude-bridge`, then step 3's `token` command.
- **Updating Claude Code:** `npm install -g @anthropic-ai/claude-code`, then
  `systemctl restart claude-bridge`.
- Logs: `journalctl -u claude-bridge`.
