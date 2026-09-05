#!/usr/bin/env bash
# Apply the migrations to a scratch database and run all three verification suites.
# Every suite raises on failure, so this exits non-zero on any red check.
set -euo pipefail

export PGHOST=${PGHOST:-/tmp}
export PGPORT=${PGPORT:-5433}
export PGUSER=${PGUSER:-postgres}

DB=${1:-dala_verify}
./scripts/localvalidate/run.sh "$DB"

for suite in catalog isolation rls; do
  echo "--- $suite ---"
  psql -v ON_ERROR_STOP=1 -d "$DB" -f "scripts/verify/$suite.sql"
done

# Not a suite: it reads the SOURCE and checks it against the schema just applied. Every
# PostgREST query in src/ is exercised against a stub and has never been sent over the
# wire, so a column that does not exist passes every test and fails at the first real
# request. Needs no npm install — node builtins and psql only.
echo "--- query columns ---"
node scripts/verify/query-columns.ts "$DB"

echo "ALL SUITES PASSED"
