#!/usr/bin/env bash
set -euo pipefail

# Maintenance helper for the paper-trading SQLite database.
# - Truncates WAL to keep journal small
# - Vacuum to reclaim space
# - Optional retention purge for leader_trades when RETENTION_DAYS is set

DB_PATH="${DB_PATH:-/data/trades.db}"
if [ ! -f "$DB_PATH" ]; then
  DB_PATH="./data/trades.db"
fi

RETENTION_DAYS="${RETENTION_DAYS:-}"

if [ -n "$RETENTION_DAYS" ]; then
  sqlite3 "$DB_PATH" "DELETE FROM leader_trades WHERE timestamp < (strftime('%s','now')-${RETENTION_DAYS}*86400)*1000;"
fi

sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "$DB_PATH" "VACUUM;"

echo "Maintenance complete on ${DB_PATH}." >&2
