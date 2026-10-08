#!/usr/bin/env bash
# Sets the Yoga laptop up to host the Tavernworks Twitch bots:
# GuildScribe, UndercoverBurn and The Wandering Clerk.
#
#   bash setup.sh          (safe to run again; it never overwrites settings or data)
#
# What it does:
#   - installs Deno (to ~/.deno) if it's missing
#   - clones the three bot repos into ~/bots
#   - creates a settings file per bot in ~/.config/tavernworks/ (from each
#     repo's .env.example) for you to fill in
#   - installs systemd user services for the bots, plus a timer that pulls
#     new commits from GitHub every 3 minutes and restarts what changed, and
#     a nightly database backup
#   - keeps them running while you're logged out (loginctl enable-linger)
#
# The Cloudflare Tunnel that brings the tavernworks.dev subdomains to the
# laptop is a separate, one-time step: see README.md.
set -euo pipefail

GITHUB=${GITHUB:-https://github.com/sheastolp}
BOTS_DIR="$HOME/bots"
CONF_DIR="$HOME/.config/tavernworks"
DATA_DIR="$HOME/.local/share/tavernworks"
UNIT_DIR="$HOME/.config/systemd/user"
HOST_URL=${HOST_URL:-https://tavernworks.dev/bot-host}

# name  repo  port
BOTS=(
  "guildscribe dnd-twitch-bot 8801"
  "undercoverburn UndercoverBurn 8802"
  "clerk The-Wandering-Clerk 8803"
)

if ! command -v deno >/dev/null && [ ! -x "$HOME/.deno/bin/deno" ]; then
  echo "Installing Deno..."
  curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path
fi
DENO=$(command -v deno || echo "$HOME/.deno/bin/deno")
echo "Deno: $("$DENO" --version | head -1)"

mkdir -p "$BOTS_DIR" "$CONF_DIR" "$DATA_DIR" "$UNIT_DIR"
chmod 700 "$CONF_DIR" "$DATA_DIR"

for entry in "${BOTS[@]}"; do
  read -r name repo port <<<"$entry"
  dir="$BOTS_DIR/$repo"
  if [ ! -d "$dir/.git" ]; then
    echo "Cloning $repo..."
    git clone --branch main "$GITHUB/$repo.git" "$dir"
  fi

  env="$CONF_DIR/$name.env"
  if [ ! -f "$env" ]; then
    sed -e "s#^DB_PATH=.*#DB_PATH=$DATA_DIR/$name.sqlite#" -e "s#^PORT=.*#PORT=$port#" \
      "$dir/.env.example" >"$env"
    chmod 600 "$env"
    echo "Created $env: fill in its values."
  fi

  cat >"$UNIT_DIR/tavernworks-$name.service" <<UNIT
[Unit]
Description=Tavernworks bot: $name
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$dir
EnvironmentFile=$env
ExecStart=$DENO run --allow-net --allow-env --allow-read --allow-write server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
done

here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
for script in update-bots.sh backup-bots.sh; do
  if [ -f "$here/$script" ]; then
    cp "$here/$script" "$BOTS_DIR/$script"
  else
    curl -fsSL "$HOST_URL/$script" -o "$BOTS_DIR/$script"
  fi
  chmod +x "$BOTS_DIR/$script"
done

cat >"$UNIT_DIR/tavernworks-update.service" <<UNIT
[Unit]
Description=Pull new bot commits from GitHub and restart what changed

[Service]
Type=oneshot
Environment=DENO=$DENO
ExecStart=$BOTS_DIR/update-bots.sh
UNIT

cat >"$UNIT_DIR/tavernworks-update.timer" <<UNIT
[Unit]
Description=Check GitHub for bot updates every 3 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min

[Install]
WantedBy=timers.target
UNIT

cat >"$UNIT_DIR/tavernworks-backup.service" <<UNIT
[Unit]
Description=Back up the bots' databases

[Service]
Type=oneshot
Environment=DENO=$DENO
ExecStart=$BOTS_DIR/backup-bots.sh
UNIT

cat >"$UNIT_DIR/tavernworks-backup.timer" <<UNIT
[Unit]
Description=Back up the bots' databases every night

[Timer]
OnCalendar=*-*-* 04:30
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable tavernworks-guildscribe tavernworks-undercoverburn tavernworks-clerk >/dev/null
systemctl --user enable --now tavernworks-update.timer tavernworks-backup.timer >/dev/null
me=${USER:-$(id -un)}
loginctl enable-linger "$me" 2>/dev/null || sudo loginctl enable-linger "$me"

cat <<MSG

Done. Next:
  1. Fill in the settings files in $CONF_DIR/
  2. Copy the old data in (README.md, "Move the data off Val Town")
  3. Start the bots:  systemctl --user start tavernworks-guildscribe tavernworks-undercoverburn tavernworks-clerk
  4. Set up the Cloudflare Tunnel (README.md)
MSG
