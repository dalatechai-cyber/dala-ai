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
echo "ALL SUITES PASSED"
