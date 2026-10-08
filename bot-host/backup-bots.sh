#!/usr/bin/env bash
# Run nightly by tavernworks-backup.timer: a consistent copy of each bot's
# database (VACUUM INTO, safe while the bot runs) into
# ~/.local/share/tavernworks/backups/, keeping the newest 14 per bot.
set -uo pipefail

DATA_DIR="$HOME/.local/share/tavernworks"
BACKUP_DIR="$DATA_DIR/backups"
DENO=${DENO:-$HOME/.deno/bin/deno}
stamp=$(date +%Y-%m-%d_%H%M)
mkdir -p "$BACKUP_DIR"

for name in guildscribe undercoverburn clerk; do
  db="$DATA_DIR/$name.sqlite"
  [ -f "$db" ] || continue
  out="$BACKUP_DIR/$name-$stamp.sqlite"
  "$DENO" eval --quiet "
    import { DatabaseSync } from 'node:sqlite';
    new DatabaseSync(Deno.args[0]).exec(\"VACUUM INTO '\" + Deno.args[1].replaceAll(\"'\", \"''\") + \"'\");
  " "$db" "$out" && echo "$name: $out"
  ls -1t "$BACKUP_DIR/$name-"*.sqlite 2>/dev/null | tail -n +15 | xargs -r rm --
done
