#!/bin/sh
# Backs up the game database on a schedule, using SQLite's online backup so it
# is safe while the server is running. Each backup is checked, compressed and
# kept for BACKUP_KEEP_DAYS.
#
#   boxhead-backup          loop forever, one backup every BACKUP_EVERY_HOURS
#   boxhead-backup once     take one backup now and exit
set -eu

DB="${BOXHEAD_DB:-/data/boxhead.db}"
DIR="${BACKUP_DIR:-/backups}"
EVERY_HOURS="${BACKUP_EVERY_HOURS:-6}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

backup_once() {
    if [ ! -f "$DB" ]; then
        echo "backup: no database at $DB yet"
        return 0
    fi
    stamp="$(date -u +%Y%m%d-%H%M%S)"
    tmp="$DIR/.boxhead-$stamp.tmp"
    rm -f "$tmp"
    sqlite3 "$DB" ".timeout 10000" ".backup '$tmp'"
    check="$(sqlite3 "$tmp" 'PRAGMA integrity_check;')"
    if [ "$check" != "ok" ]; then
        echo "backup: FAILED integrity check: $check" >&2
        rm -f "$tmp"
        return 1
    fi
    gzip -c "$tmp" > "$DIR/boxhead-$stamp.db.gz"
    rm -f "$tmp"
    find "$DIR" -maxdepth 1 -name 'boxhead-*.db.gz' -mtime +"$KEEP_DAYS" -delete
    echo "backup: wrote boxhead-$stamp.db.gz ($(du -h "$DIR/boxhead-$stamp.db.gz" | cut -f1))"
}

if [ "${1:-}" = "once" ]; then
    backup_once
    exit $?
fi

echo "backup: every ${EVERY_HOURS}h into $DIR, keeping ${KEEP_DAYS} days"
while :; do
    backup_once || echo "backup: will retry next cycle" >&2
    sleep "$((EVERY_HOURS * 3600))"
done
