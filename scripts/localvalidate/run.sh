#!/usr/bin/env bash
# Rebuild a throwaway database and apply the migration to it. Fails loudly.
set -euo pipefail
DB=${1:-dala_validate}
PSQL="psql -h /tmp -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -d postgres -c "drop database if exists $DB;" >/dev/null
$PSQL -d postgres -c "create database $DB;" >/dev/null
$PSQL -d "$DB" -f scripts/localvalidate/shim.sql >/dev/null
for m in supabase/migrations/*.sql; do
  $PSQL -d "$DB" -f "$m" || { echo "FAILED: $m"; exit 1; }
  echo "applied $(basename "$m")"
done
echo "APPLIED OK -> $DB"
