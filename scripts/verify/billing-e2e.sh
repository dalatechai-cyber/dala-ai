#!/usr/bin/env bash
# Local run of scripts/verify/billing-e2e.ts: a fresh database, a PostgREST in front of it,
# the walk-through, and PostgREST stopped again. Needs the scratch cluster (CLAUDE.md,
# Testing) and a `postgrest` binary on PATH or in $POSTGREST. CI runs the .ts directly
# against its own PostgREST (.github/workflows/schema.yml).
set -euo pipefail
export PGHOST=${PGHOST:-/tmp} PGPORT=${PGPORT:-5433} PGUSER=${PGUSER:-postgres}
DB=${1:-dala_billing_e2e}
PGRST=${POSTGREST:-postgrest}
./scripts/localvalidate/run.sh "$DB" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f scripts/verify/postgrest-roles.sql 2>/dev/null
CONF=$(mktemp)
cat > "$CONF" <<CONF
db-uri = "postgres://authenticator:dala-ci-authenticator@localhost:${PGPORT}/${DB}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "dala-ci-postgrest-secret-at-least-32-chars"
server-port = 3011
CONF
"$PGRST" "$CONF" >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -f "$CONF"' EXIT
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/ || true)" = "200" ] && break
  sleep 0.5
done
PGRST_URL=http://127.0.0.1:3011 PGRST_JWT_SECRET=dala-ci-postgrest-secret-at-least-32-chars \
  node scripts/verify/billing-e2e.ts "$DB"
