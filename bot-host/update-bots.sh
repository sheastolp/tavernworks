#!/usr/bin/env bash
# Run every 3 minutes by tavernworks-update.timer. For each bot: if the
# branch it follows (main, normally) has new commits on GitHub, pull them,
# type-check, and restart the bot. If the new code doesn't type-check, go
# back to the commit that was running. Data and settings live outside the
# repos, so a pull never touches them.
set -uo pipefail

MODE=${MODE:-user}
BOTS_DIR=${BOTS_DIR:-$HOME/bots}
DENO=${DENO:-$HOME/.deno/bin/deno}
RUN_USER=${RUN_USER:-$(id -un)}

if [ "$MODE" = system ]; then
  RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
  as_user() { runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" "$@"; }
  cd /
  restart() { systemctl restart "tavernworks-$1"; }
else
  as_user() { "$@"; }
  restart() { systemctl --user restart "tavernworks-$1"; }
fi

for entry in "guildscribe dnd-twitch-bot" "undercoverburn UndercoverBurn" "clerk The-Wandering-Clerk"; do
  read -r name repo <<<"$entry"
  dir="$BOTS_DIR/$repo"
  [ -d "$dir/.git" ] || continue
  branch=$(as_user git -C "$dir" rev-parse --abbrev-ref HEAD)
  as_user git -C "$dir" fetch --quiet origin "$branch" || { echo "$repo: fetch failed"; continue; }
  old=$(as_user git -C "$dir" rev-parse HEAD)
  new=$(as_user git -C "$dir" rev-parse "origin/$branch")
  [ "$old" = "$new" ] && continue

  as_user git -C "$dir" reset --quiet --hard "$new"
  if as_user sh -c "cd '$dir' && '$DENO' check server.ts >/dev/null 2>&1"; then
    echo "$repo: ${old:0:7} -> ${new:0:7} ($branch), restarting"
    restart "$name"
  else
    echo "$repo: ${new:0:7} doesn't type-check, staying on ${old:0:7}"
    as_user git -C "$dir" reset --quiet --hard "$old"
  fi
done
