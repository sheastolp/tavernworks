#!/usr/bin/env bash
# Sets a laptop up to host the Tavernworks Twitch bots:
# GuildScribe and UndercoverBurn.
#
#   As root (recommended):   bash setup.sh
#     The bots run as system services under their own unprivileged account,
#     "tavernworks": code in /var/lib/tavernworks/bots, data in
#     /var/lib/tavernworks/data, settings in /etc/tavernworks.
#   As a normal user:        bash setup.sh
#     systemd user services: code in ~/bots, data in
#     ~/.local/share/tavernworks, settings in ~/.config/tavernworks.
#
# Options (environment variables):
#   BRANCH=<name>   install from this branch instead of main; the laptop then
#                   follows that branch until you switch it (README.md)
#   PRIVATE_REPOS   repos cloned over SSH with the account's deploy key;
#                   default "UndercoverBurn" (the others are public)
#
# Safe to run again: it never overwrites settings or data.
#
# What it does:
#   - installs Deno if it's missing
#   - clones the three bot repos
#   - creates a settings file per bot (from each repo's .env.example) for you
#     to fill in
#   - installs a service per bot, a timer that pulls new commits from GitHub
#     every 3 minutes and restarts what changed, and a nightly database backup
#
# The Cloudflare Tunnel that brings the tavernworks.dev subdomains to the
# laptop is a separate, one-time step: see README.md.
set -euo pipefail

OWNER=${OWNER:-sheastolp}
BRANCH=${BRANCH:-main}
PRIVATE_REPOS=${PRIVATE_REPOS-UndercoverBurn}
HOST_URL=${HOST_URL:-https://tavernworks.dev/bot-host}

# name  repo  port
BOTS=(
  "guildscribe dnd-twitch-bot 8801"
  "undercoverburn UndercoverBurn 8802"
)

if [ "$(id -u)" = 0 ]; then
  MODE=system
  RUN_USER=tavernworks
  RUN_HOME=${RUN_HOME:-/var/lib/tavernworks}
  BOTS_DIR=$RUN_HOME/bots
  DATA_DIR=$RUN_HOME/data
  CONF_DIR=${CONF_DIR:-/etc/tavernworks}
  UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
  SYSTEMCTL="systemctl"
  WANTED_BY=multi-user.target
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$RUN_HOME" --shell /usr/sbin/nologin "$RUN_USER"
    echo "Created the $RUN_USER account."
  fi
  as_user() { runuser -u "$RUN_USER" -- "$@"; }
  export DENO_INSTALL=/usr/local
else
  MODE=user
  RUN_USER=$(id -un)
  RUN_HOME=$HOME
  BOTS_DIR=$HOME/bots
  DATA_DIR=$HOME/.local/share/tavernworks
  CONF_DIR=$HOME/.config/tavernworks
  UNIT_DIR=$HOME/.config/systemd/user
  SYSTEMCTL="systemctl --user"
  WANTED_BY=default.target
  as_user() { "$@"; }
  export DENO_INSTALL=$HOME/.deno
fi

if ! command -v deno >/dev/null && [ ! -x "$DENO_INSTALL/bin/deno" ]; then
  echo "Installing Deno..."
  command -v unzip >/dev/null || { [ "$MODE" = system ] && apt-get install -y unzip >/dev/null; }
  curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path
fi
DENO=$(command -v deno || echo "$DENO_INSTALL/bin/deno")
echo "Deno: $("$DENO" --version | head -1)"

mkdir -p "$UNIT_DIR" "$CONF_DIR"
as_user mkdir -p "$BOTS_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR"
if [ "$MODE" = system ]; then
  chown root:"$RUN_USER" "$CONF_DIR"
  chmod 750 "$CONF_DIR"
else
  chmod 700 "$CONF_DIR"
fi

# A deploy key for the private repos (read-only access to just those repos).
if [ -n "$PRIVATE_REPOS" ]; then
  key="$RUN_HOME/.ssh/id_ed25519"
  if [ ! -f "$key" ]; then
    as_user mkdir -p "$RUN_HOME/.ssh"
    as_user ssh-keygen -q -t ed25519 -N "" -C "tavernworks-bots@$(hostname)" -f "$key"
  fi
  as_user sh -c "ssh-keygen -F github.com >/dev/null || ssh-keyscan -t ed25519 github.com >> '$RUN_HOME/.ssh/known_hosts' 2>/dev/null"
fi

missing_key=""
for entry in "${BOTS[@]}"; do
  read -r name repo port <<<"$entry"
  dir="$BOTS_DIR/$repo"
  url="https://github.com/$OWNER/$repo.git"
  case " $PRIVATE_REPOS " in *" $repo "*) url="git@github.com:$OWNER/$repo.git" ;; esac
  if [ ! -d "$dir/.git" ]; then
    echo "Cloning $repo ($BRANCH)..."
    if ! as_user git clone --quiet --branch "$BRANCH" "$url" "$dir"; then
      echo "Couldn't clone $repo. If it's private, add this deploy key to it first (GitHub → $repo → Settings → Deploy keys → Add, read-only):"
      cat "$RUN_HOME/.ssh/id_ed25519.pub"
      missing_key=1
      continue
    fi
  fi

  if [ ! -f "$dir/server.ts" ]; then
    echo "$repo's $BRANCH branch doesn't have the laptop version yet (no server.ts)."
    echo "Merge it first, or run this with BRANCH=<the branch that has it>."
    exit 1
  fi

  env="$CONF_DIR/$name.env"
  if [ ! -f "$env" ]; then
    sed -e "s#^DB_PATH=.*#DB_PATH=$DATA_DIR/$name.sqlite#" -e "s#^PORT=.*#PORT=$port#" \
      "$dir/.env.example" >"$env"
    if [ "$MODE" = system ]; then chown root:"$RUN_USER" "$env"; chmod 640 "$env"; else chmod 600 "$env"; fi
    echo "Created $env: fill in its values."
  fi

  {
    echo "[Unit]"
    echo "Description=Tavernworks bot: $name"
    echo "After=network-online.target"
    echo "Wants=network-online.target"
    echo
    echo "[Service]"
    [ "$MODE" = system ] && echo "User=$RUN_USER"
    echo "WorkingDirectory=$dir"
    echo "EnvironmentFile=$env"
    echo "ExecStart=$DENO run --allow-net --allow-env --allow-read --allow-write server.ts"
    echo "Restart=always"
    echo "RestartSec=5"
    echo
    echo "[Install]"
    echo "WantedBy=$WANTED_BY"
  } >"$UNIT_DIR/tavernworks-$name.service"
done

here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
for script in update-bots.sh backup-bots.sh; do
  target="$BOTS_DIR/$script"
  if [ -f "$here/$script" ]; then cp "$here/$script" "$target"; else curl -fsSL "$HOST_URL/$script" -o "$target"; fi
  chmod 755 "$target"
done

cat >"$UNIT_DIR/tavernworks-update.service" <<UNIT
[Unit]
Description=Pull new bot commits from GitHub and restart what changed

[Service]
Type=oneshot
Environment=DENO=$DENO BOTS_DIR=$BOTS_DIR RUN_USER=$RUN_USER MODE=$MODE
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

{
  echo "[Unit]"
  echo "Description=Back up the bots' databases"
  echo
  echo "[Service]"
  echo "Type=oneshot"
  [ "$MODE" = system ] && echo "User=$RUN_USER"
  echo "Environment=DENO=$DENO DATA_DIR=$DATA_DIR"
  echo "ExecStart=$BOTS_DIR/backup-bots.sh"
} >"$UNIT_DIR/tavernworks-backup.service"

cat >"$UNIT_DIR/tavernworks-backup.timer" <<UNIT
[Unit]
Description=Back up the bots' databases every night

[Timer]
OnCalendar=*-*-* 04:30
Persistent=true

[Install]
WantedBy=timers.target
UNIT

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable tavernworks-guildscribe tavernworks-undercoverburn >/dev/null 2>&1
$SYSTEMCTL enable --now tavernworks-update.timer tavernworks-backup.timer >/dev/null 2>&1
if [ "$MODE" = user ]; then
  me=${USER:-$(id -un)}
  loginctl enable-linger "$me" 2>/dev/null || sudo loginctl enable-linger "$me"
fi

if [ -n "$missing_key" ]; then
  echo
  echo "Add the deploy key above, then run this script again to finish."
  exit 1
fi

cat <<MSG

Done. Next:
  1. Fill in the settings files in $CONF_DIR/
  2. Copy the old data in (README.md, "Move the data off Val Town")
  3. Start the bots:  $SYSTEMCTL start tavernworks-guildscribe tavernworks-undercoverburn
  4. Set up the Cloudflare Tunnel (README.md)
MSG
