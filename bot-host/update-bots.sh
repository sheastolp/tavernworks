#!/usr/bin/env bash
# Run every 3 minutes by tavernworks-update.timer. For each bot: if main on
# GitHub has new commits, pull them, type-check, and restart the bot. If the
# new code doesn't type-check, go back to the commit that was running.
# Data and settings live outside the repos, so a pull never touches them.
set -uo pipefail

BOTS_DIR="$HOME/bots"
DENO=${DENO:-$HOME/.deno/bin/deno}

for entry in "guildscribe dnd-twitch-bot" "undercoverburn UndercoverBurn" "clerk The-Wandering-Clerk"; do
  read -r name repo <<<"$entry"
  dir="$BOTS_DIR/$repo"
  [ -d "$dir/.git" ] || continue
  git -C "$dir" fetch --quiet origin main || { echo "$repo: fetch failed"; continue; }
  old=$(git -C "$dir" rev-parse HEAD)
  new=$(git -C "$dir" rev-parse origin/main)
  [ "$old" = "$new" ] && continue

  git -C "$dir" reset --quiet --hard "$new"
  if (cd "$dir" && "$DENO" check server.ts >/dev/null 2>&1); then
    echo "$repo: ${old:0:7} -> ${new:0:7}, restarting"
    systemctl --user restart "tavernworks-$name"
  else
    echo "$repo: ${new:0:7} doesn't type-check, staying on ${old:0:7}"
    git -C "$dir" reset --quiet --hard "$old"
  fi
done
