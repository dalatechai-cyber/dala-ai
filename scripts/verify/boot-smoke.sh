#!/usr/bin/env bash
# Boot the built app and prove the webhook's four HTTP-level properties.
#
# Everything else in this repository is a unit test or a database check. This is the only
# thing that starts the actual Next.js server and speaks HTTP to it, which is the layer
# where a route can be perfectly correct and still never run: a middleware matcher that
# swallows the path, a route that fails to export POST, an env accessor that throws at
# module scope, a body read that decodes bytes as text.
#
# ## What it asserts, and why these four
#
#   1. GET verify with the right token returns the challenge VERBATIM, 200. Meta's
#      subscription handshake fails on anything else, and it fails silently — the app
#      simply never gets subscribed.
#   2. GET verify with a wrong token, or an unknown app slug, is 403. A verify endpoint
#      that accepts anything is an open invitation to have someone else's Page subscribed
#      to our app.
#   3. A POST whose HMAC is computed over the RAW BYTES verifies — with a Mongolian
#      Cyrillic body, because that is where a re-serialise-then-verify implementation
#      breaks and an ASCII fixture would not notice.
#   4. One changed character in a still-valid body is 401. That is the whole point of
#      the signature — and the body stays valid JSON so that the SIGNATURE is what refuses
#      it, not the parser one layer down.
#
# And one more that falls out of the setup: with the registry unreachable the verified
# POST is **500**, not 200. That is the transient half of the 200/500 asymmetry, which no
# unit test can demonstrate at the HTTP layer — an unreadable registry must make Meta
# retry, because a 200 would drop the event forever.
#
# ## The environment here is deliberately fake
#
# Every value below is a placeholder, and `NEXT_PUBLIC_SUPABASE_URL` points at a closed
# local port so the registry read fails immediately and deterministically. Nothing here
# reaches Meta, Supabase, Anthropic or QStash, and there is no credential to leak.
set -euo pipefail

PORT=${PORT:-3210}
APP_SECRET='testappsecret'
VERIFY_TOKEN='verifyme'
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ ! -d .next ]; then
  echo "boot-smoke: no .next build found. Run 'npx next build' first." >&2
  exit 2
fi

TMP="$(mktemp -d)"
# `npx` spawns `next start`, which spawns `next-server`. Killing only the pid we recorded
# reaps the wrapper and ORPHANS the server, which then holds the port — and the next run
# of this script tests that stale process instead of a fresh build. Found the hard way, and
# it is why the port check below exists as well. `setsid` makes the child a process-group
# leader so the whole tree can be signalled at once.
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill -TERM -- "-${SERVER_PID}" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Refuse to run against somebody else's server.
#
# Found by mutating the signature comparison to always-true and watching this script pass
# anyway: a leftover server from an earlier run was still holding the port, the new one
# failed to bind, the readiness probe succeeded against the OLD process, and every check
# passed against the OLD build. A smoke test that silently tests a stale binary is worse
# than no smoke test, because it reports the opposite of the truth.
if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then
  echo "boot-smoke: something is already listening on ${PORT}. Refusing to test it." >&2
  exit 2
fi

export DALA_ENV=preview
# Port 9 (discard) is closed here, so the registry read fails with a connection refusal
# rather than a DNS lookup — deterministic, and it costs no time.
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9
export SUPABASE_PUBLISHABLE_KEY=sb_publishable_placeholder
export SUPABASE_SECRET_WEBHOOK=sb_secret_placeholder
export SUPABASE_SECRET_WORKER=sb_secret_placeholder
export SUPABASE_SECRET_PRIVACY=sb_secret_placeholder
export DALA_PUBLIC_URL=https://dala.example.com
export META_APP_SECRETS="{\"dala\":\"${APP_SECRET}\"}"
export META_VERIFY_TOKENS="{\"dala\":\"${VERIFY_TOKEN}\"}"
export META_GRAPH_VERSION=v21.0
export ANTHROPIC_API_KEY=placeholder
export IDENTITY_PEPPER=placeholder
export QSTASH_TOKEN=placeholder
export QSTASH_CURRENT_SIGNING_KEY=placeholder
export QSTASH_NEXT_SIGNING_KEY=placeholder
export WORKER_PUBLIC_URL="http://127.0.0.1:${PORT}/api/workers/reception"
export LINK_SIGNING_KEY=placeholder
export TELEGRAM_BOT_TOKEN=placeholder
export TELEGRAM_ALERT_CHAT_ID=0
export ALERTS_ENABLED=false
export TENANT_KEK_V1="$(node scripts/kek/generate.ts 2>/dev/null)"
export TENANT_KEK_ACTIVE_VERSION=v1

setsid npx next start -p "$PORT" > "$TMP/server.log" 2>&1 &
SERVER_PID=$!

ready=no
for _ in $(seq 1 40); do
  # The liveness check is on OUR pid, not only on the port: if the server died at boot
  # (a missing env var, a port clash) the loop would otherwise spin for 20 seconds and
  # then run every check against a connection error, reporting six confusing failures
  # instead of the one true one.
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo 'boot-smoke: the server exited during startup.' >&2
    cat "$TMP/server.log" >&2
    exit 1
  fi
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/webhooks/meta/dala?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=up"; then
    ready=yes
    break
  fi
  sleep 0.5
done
if [ "$ready" != yes ]; then
  echo 'boot-smoke: the server never became ready.' >&2
  cat "$TMP/server.log" >&2
  exit 1
fi

fails=0
check() {   # check <name> <expected-status> <expected-body-substring|-> <curl args...>
  local name="$1" want_status="$2" want_body="$3"; shift 3
  local out status body
  out="$(curl -s -m 30 -w '\n%{http_code}' "$@")"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$status" != "$want_status" ]; then
    echo "  FAIL  $name — expected HTTP $want_status, got $status ($body)"
    fails=$((fails + 1))
    return
  fi
  if [ "$want_body" != '-' ] && [ "$body" != "$want_body" ]; then
    echo "  FAIL  $name — expected body '$want_body', got '$body'"
    fails=$((fails + 1))
    return
  fi
  echo "  ok    $name  [$status]"
}

BASE="http://127.0.0.1:${PORT}/api/webhooks/meta"

check 'GET verify returns the challenge verbatim' 200 'CH4LL3NGE' \
  "${BASE}/dala?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CH4LL3NGE"

check 'GET verify with a wrong token is refused' 403 - \
  "${BASE}/dala?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CH4LL3NGE"

check 'GET verify for an unknown app slug is refused' 403 - \
  "${BASE}/nosuchapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CH4LL3NGE"

# Mongolian Cyrillic on purpose: a verifier that re-serialises the parsed body instead of
# hashing the bytes it received passes every ASCII fixture and fails here.
BODY='{"object":"page","entry":[{"id":"100000000000001","time":1756900000000,"messaging":[{"sender":{"id":"7654321098765432"},"recipient":{"id":"100000000000001"},"timestamp":1756900000000,"message":{"mid":"m_smoke","text":"Сайн байна уу, үнэ хэд вэ?"}}]}]}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.*= //')"

# The registry is unreachable, so a VERIFIED post must 500 — the transient half of the
# asymmetry. A 200 here would mean Meta never retries and the event is gone.
check 'a verified POST passes the signature and 500s on an unreachable registry' 500 \
  '{"error":"webhook.registry_unavailable"}' \
  -X POST "${BASE}/dala" -H 'content-type: application/json' \
  -H "x-hub-signature-256: sha256=${SIG}" --data-raw "$BODY"

# One character changed inside the message id, so the tampered body is still perfectly
# valid JSON of the same length. Appending a stray byte would ALSO be refused — but by the
# JSON parser one layer down, with a 400, which means the check would pass even with the
# signature comparison disabled. Verified by doing exactly that: mutating digestsMatch to
# `return true` turns this into a 500, and turns the stray-byte version into a 400 that
# still looks like a pass.
TAMPERED="${BODY/m_smoke/m_smokf}"
check 'one changed character in a still-valid body is refused' 401 '{"error":"webhook.sig_invalid"}' \
  -X POST "${BASE}/dala" -H 'content-type: application/json' \
  -H "x-hub-signature-256: sha256=${SIG}" --data-raw "$TAMPERED"

check 'a POST with no signature at all is refused' 401 '{"error":"webhook.sig_missing"}' \
  -X POST "${BASE}/dala" -H 'content-type: application/json' --data-raw "$BODY"

# ---------------------------------------------------------------------------
# The data-deletion callback (§10.5). An App Review deliverable, so it is worth proving
# it is reachable and that its signature path works over real HTTP rather than only in a
# unit test — this is where a route that forgot to export POST looks identical to one that
# refuses everything.
# ---------------------------------------------------------------------------

PRIVACY="http://127.0.0.1:${PORT}/api/meta/data-deletion"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Meta signs the ENCODED payload string, not the decoded JSON — the single most common way
# this is implemented wrongly, and a mistake that rejects every real deletion request.
SR_PAYLOAD="$(printf '%s' '{"algorithm":"HMAC-SHA256","issued_at":1756900000,"user_id":"1234567890123456"}' | b64url)"
SR_SIG="$(printf '%s' "$SR_PAYLOAD" | openssl dgst -sha256 -hmac "$APP_SECRET" -binary | b64url)"

check 'data-deletion with no signed_request is refused' 400 \
  '{"error":"privacy.signed_request_missing"}' \
  -X POST "$PRIVACY" -H 'content-type: application/x-www-form-urlencoded' --data-raw 'nothing=here'

check 'data-deletion with a forged signature is refused' 400 \
  '{"error":"privacy.signature_invalid"}' \
  -X POST "$PRIVACY" -H 'content-type: application/x-www-form-urlencoded' \
  --data-raw "signed_request=$(printf '%s' 'forged' | b64url).${SR_PAYLOAD}"

# A GENUINE signature gets past verification and fails at the write, because Supabase is
# unreachable here. 500 rather than 200 is the whole design: a dropped deletion request is
# a legal obligation nobody ever learns about, so Meta must retry.
check 'a genuinely signed request verifies and 500s on an unreachable database' 500 \
  '{"error":"privacy.not_recorded"}' \
  -X POST "$PRIVACY" -H 'content-type: application/x-www-form-urlencoded' \
  --data-raw "signed_request=${SR_SIG}.${SR_PAYLOAD}"

# The status page, with the database unreachable. It must refuse OUTRIGHT rather than
# render a partial page, and the body has to say WHICH refusal this is: `unavailable`
# (we could not read the blocks) and `status_page_unsigned` (we read them and they are
# not signed) are different incidents with different fixes. Asserting only the 503 passed
# for either reason, which made it blind to the two being confused.
check 'the status page refuses, and says the database is why' 503 \
  '{"error":"privacy.unavailable"}' \
  "http://127.0.0.1:${PORT}/data-deletion/status?code=ABCDEFGHJKLMNPQRSTUVWXYZ"

if [ "$fails" -ne 0 ]; then
  echo "BOOT SMOKE FAILED ($fails)"
  echo '--- server log ---'
  cat "$TMP/server.log"
  exit 1
fi
echo 'BOOT SMOKE PASSED (a real server over HTTP; no Meta, Supabase, Anthropic or QStash)'
