# NOTES — Tara in-chat QPay booking (session 2026-10-02, resume point)

Branch: `claude/happy-pasteur-4gp7gd`. Brief: in-Messenger booking + QPay deposit for Tara, built OFF
for every tenant, draft PR, merge nothing. All new Mongolian = drafts. No real QPay charges.
Previous session's notes moved to `docs/notes-2026-10-02-overnight.md`.

## Status
- [x] Investigate (website report summarised in the design doc; live asks counted)
- [x] Design `docs/proposals/tara-inchat-booking.md`
- [x] Migration `0082_booking.sql` (all 5 SQL suites pass locally; schema.md row)
- [x] Build (flag off), fake QPay, fake calendar, tests, reply cases
  - [x] src/lib/booking/{config,slots,calendar,wording,store,links,engine,turn}.ts (typecheck ok)
  - [x] send.ts quick replies + linkButtonTitle; extract.ts quickReplyPayload; billing qpay mccCode
  - [x] prompt/drafts/booking/*.mn.txt (31 drafts + README)
  - [x] pay page + /book route, /api/booking/qpay, /api/workers/booking, worker hook, clients, env, preflight
  - [x] testkit fakes, unit tests (23), worker hook tests (4), booking-e2e.ts 88 checks (+ CI step), transcript
  - [x] scripts/booking/from-website.ts (config from website checkout), scripts/booking/check.ts (branches)
  - [x] docs/proposals/matrix-website-booking-holds.md (change request)
- [x] Draft PR https://github.com/dalatechai-cyber/dala-ai/pull/280 (subscribed)
- [ ] Opus reviewer running (background); fix findings; CI green; preview link; report
- [ ] Review (Opus reviewer), CI green, draft PR, preview link
- [ ] Final report (<15 lines)

## Decisions (with reason)
1. Deterministic flow, no model: C1/E2 stay true of the model; every line is a signed platform block.
2. Deposit per stylist level (Мастер 20,000₮, 1-р зэрэг 10,000₮) — Tara's website rule and her live
   deposit_rules; the brief's "20,000₮" is the Мастер case. Every booking needs a deposit.
3. Holds: DB (advisory lock per calendar + partial unique index; no btree_gist extension) AND a busy
   Google Calendar event, so the website's free/busy stops offering the time. Re-read after insert;
   chat yields if the website wrote first.
4. Hold 10 min (config), QR 5 min with renewal on the pay page (website's 5-min QR).
5. QPay: reuse platform `QPAY_USERNAME/PASSWORD/TERMINAL_ID` (website uses the same terminal
   `DALATECH_AI`); merchant id, mcc 7230, bank account are tenant config rows. Founder confirms.
6. Calendar: Google service account from env `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_PRIVATE_KEY`
   (same names and values as the website); calendar ids are tenant config rows.
7. New env: `BOOKING_MODE` (master switch), `BOOKING_LINK_SECRET`, `SUPABASE_SECRET_BOOKING` (own key
   for the public pay page and callback, like billing).
8. Test mode = booking_config.mode 'test' + `config.test_sender_ids` (PSIDs): 100₮, «ТЕСТ» events.
   Channel `test_sender_ids` only works in shadow, Tara's channel is live, hence its own list.
9. Booking replies are `outbound_messages kind='reply'` (answers: `reply:<mid>`; pushes:
   `booking:<hold>:<event>`), so every existing "was it answered" reader sees them. Quick replies
   only on the first send (body text stands alone on a resend). No outbound schema change.
10. One service per booking (v1). Website allows several.
11. Entry = list of gate matchers per tenant (`entry_matchers`); Tara's proposal catches 33/33 real asks, 1 FP.
12. Service buttons: optional short `label` (CICA…); stylist button drops the level when > 20 chars.
13. Local PostgREST (all versions 11.2–14.1) 400s claim()'s PATCH+or; hosted 200s (edge log). e2e gateway
    drops the lease `or` only (state CAS stays). Documented in booking-e2e.ts `claimShim`.
14. Yaarmag stylists proposed = dala-ai active staff (Оюунаа, Бадмаа, Батзаяа, Уянга, Отгонжаргал); website
    also has Уранчимэг + Ананд (male) -> founder question; men cannot book in chat with that list.

## Findings
- dala-ai already has a Quick QR client (`src/lib/billing/qpay.ts`) for DalaTech's own merchant
  (Core Language's). Tara's deposits must go to Tara's merchant (website's), not this one.
- dali.md C1 «Дали never books/confirms» and E2 «no availability»: hold for the MODEL. The booking
  flow must be a deterministic path that never lets model text confirm anything.

## Local environment (re-create after a container reset)
- PG16 + pgvector: `apt-get install -y postgresql-16-pgvector`; cluster as user postgres:
  `su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /tmp/pg/data -U postgres --locale=C.UTF-8 && /usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data -o '-p 5433 -k /tmp' -l /tmp/pg/log start"`
- `PGHOST=/tmp PGPORT=5433 PGUSER=postgres ./scripts/verify/run-all.sh dala_ci` (baseline green 2026-10-02)
- PostgREST 12.2.3 static binary at /tmp/postgrest (github release download works); roles:
  `psql -d dala_ci -f scripts/verify/postgrest-roles.sql`, then run with PGRST_DB_URI=postgres://authenticator:dala-ci-authenticator@localhost:5433/dala_ci,
  ANON_ROLE=anon, SCHEMAS=public, JWT_SECRET=dala-ci-postgrest-secret-at-least-32-chars, PORT=3001.
  billing-e2e passes locally (118 checks) -> model for booking-e2e.
