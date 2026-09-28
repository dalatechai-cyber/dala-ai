# PROGRESS — client billing by QPay (2026-09-28, D-156)

Brief (founder, 2026-09-28): every client's monthly fee is invoiced automatically on the 1st
(Ulaanbaatar), paid by QPay into the SAME merchant Core Language uses, recorded without the
founder, reminded on the 3rd and 6th, summarised to the founder on the 6th, and on the 8th the
founder is ASKED (never automatic) whether to pause the client's AI staff. Annual prepay
clients get one yearly invoice. Money is never lost, doubled or mis-assigned; Core Language
keeps working exactly as today (this repo changes nothing there). No live client is invoiced
until the founder approves the first real run. All new Mongolian is a draft.

The previous PROGRESS (one-command onboarding, D-155) is complete; it is in git history at
bee6a69.

## Checkpoints

- [x] **1. Schema.** `supabase/migrations/0065_billing.sql`: accounts, schedules, invoices,
  payments (append-only), outbox, pauses, events (append-only) and the fourteen functions
  that carry the promises. `scripts/verify/billing.sql` proves them (17 checks) on local
  PostgreSQL 16; every existing suite still passes. NOT applied to the project.
- [x] **2. Engine** (`src/lib/billing/`): QPay Quick QR client (same endpoint and env names as
  Core Language, `callback_url` set), contract amounts (best single discount), Ulaanbaatar
  calendar, wording from signed blocks only (drafts for test accounts from the operator's
  shell only), Brevo e-mail with the founder as Reply-To, founder Telegram with a URL button,
  signed links, the idempotent tick. 21 unit tests.
- [x] **3. Surfaces:** `/api/workers/billing` (QStash, hourly), `/api/billing/qpay` (callback;
  asks QPay, trusts nothing it is sent), `/pay/<link>` (the client's page), `/billing/action`
  (the founder's pause/resume: GET confirms, POST acts). Preflight enforces the billing
  variables only when `BILLING_MODE` is test/live. The seed generator now keeps `billing_*`
  blocks out of the prompt (layer null) — without that, signing them would have put invoice
  text into every tenant's system prompt.
- [x] **4. Operator commands** (`scripts/billing/`): `account.ts` (propose from the contract,
  write unconfirmed, confirm by fingerprint), `charge.ts` (one-offs), `tick.ts` (one run from
  the shell; `--drafts`/`--today` for test accounts only), `report.ts` (preview of the first
  live run, ledger CSV, status), `settle.ts` (bank transfer, accept/withdraw, requeue, pause,
  resume). `scripts/onboard/tenant.ts --billing-staff …` writes the same unconfirmed record.
  22 Mongolian drafts in `prompt/drafts/billing/`, unsigned.
- [x] **5. End to end on the local replica:** `scripts/verify/billing-e2e.ts` walks a month over
  real PostgREST + PostgreSQL 16 with QPay/Brevo/Telegram faked — 52 checks (added to CI).
  `query-columns.ts`, `postgrest.ts`, every SQL suite and `npm run check` (2303 pass, 1
  pre-existing skip) are green.
- [ ] **5b. Review** of every changed file (Opus reviewer), fixes, draft PR.
- [ ] **6. Founder:** approve wording, add the environment, the real 100₮ test, then live.
