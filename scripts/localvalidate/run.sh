#!/usr/bin/env bash
# Rebuild a throwaway database and apply every migration in order. Fails loudly.
#
# Connection comes from the standard PG* environment variables so this script is
# identical locally and in CI. Defaults match the local scratch cluster.
set -euo pipefail

export PGHOST=${PGHOST:-/tmp}
export PGPORT=${PGPORT:-5433}
export PGUSER=${PGUSER:-postgres}

DB=${1:-dala_validate}
PSQL="psql -v ON_ERROR_STOP=1 -q"

$PSQL -d postgres -c "drop database if exists $DB;" >/dev/null
$PSQL -d postgres -c "create database $DB;" >/dev/null
$PSQL -d "$DB" -f scripts/localvalidate/shim.sql >/dev/null

for m in supabase/migrations/*.sql; do
  $PSQL -d "$DB" -f "$m" || { echo "FAILED: $m"; exit 1; }
  echo "applied $(basename "$m")"
done
echo "APPLIED OK -> $DB"
