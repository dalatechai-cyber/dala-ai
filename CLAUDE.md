# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Dala AI** — Dalatech's multi-tenant AI staff platform for Mongolian SMBs. Businesses
hire AI staff by the role, per month. One codebase, one deployment, one Meta app, one
Supabase project, and a **configuration per tenant**.

Separate business from Core Language (`dalatech-english`) — shared lessons only, **zero
shared code, customers, or databases**. Never import from that repo.

Tenant #1 Matrix Eco Salon (hair/beauty). Tenant #2 GS Auto Center. Customer-facing text
is Mongolian Cyrillic. Keep it that way.

**Status: architecture approved; the schema exists and is verified locally.** No Supabase
project, no Meta app, no product code — nothing has been applied to a real environment.

## The test every decision is measured against

> **Onboarding client #3 must be filling in a config, not writing code.**

Everything that distinguishes one customer from another is a row. If you find yourself
writing a per-tenant `if`, a per-tenant prompt string, or a per-tenant env var, the design
is wrong — make it data.

## The rules that override convenience

1. **Tenant is derived server-side**, per webhook entry, from a registry with a unique
   key. Never from a request body, a header, or an env var. **There is no
   `?? DEFAULT_TENANT`** — not even for local testing.
2. **Fail closed on money.** Identity → entitlement → budget, in order, each refusing on
   error. Helpers return **503 on any error**. Never
   `try { check() } catch { continue }` — that exact pattern was the HIGH finding next
   door. A 503 costs a retry; failing open costs money, and here it is *another tenant's*
   money.
3. **Reserve spend before the call, settle after.** A ceiling checked after the call is
   not a ceiling.
4. **RLS per tenant, verified against the catalog** — `pg_policies`,
   `pg_class.relrowsecurity`, `aclexplode(pg_class.relacl)`. Never
   `information_schema.role_table_grants` (permission-filtered, silently empty) and never
   `supabase_migrations.schema_migrations`. **A migration file in the repo is not a
   migration applied to the database.** Check each table independently — the last failure
   next door was partial, one of four. A policy on a table with RLS **off** is created,
   looks perfect, and is never evaluated.
5. **`revoke insert, update, delete` is not "cannot write."** Postgres grants seven
   privileges and TRUNCATE bypasses RLS entirely. Enumerate the ACL. Ownership RLS checks
   *who a row belongs to, never what it says*.
6. **Mongolian Cyrillic, not ASCII.** NFC-normalise at every input boundary. No `\b`, no
   `\w`, no `[a-z]`, no unanchored substring matchers over user text, no byte-length as
   character-length. `unaccent` must **not** be installed (it maps `Ё→Е` while leaving
   `Ө`, `Ү` alone — partially destructive, so it passes nine tests in ten).
7. **Secrets from the environment only.** Per-tenant Meta tokens are *data*: envelope
   encryption, KEK in the platform env, decrypt per request. **Never a module-scope
   credential cache** — warm lambdas are reused across tenants.
8. **Next.js caching trap.** A route exporting only `GET` caches every Supabase read for a
   **year**, and `export const dynamic = 'force-dynamic'` does *not* stop it. Only
   `cache: 'no-store'` does. Use the shared clients; never construct a bare one.
9. **Never mark work done without running it.** Say what you verified, what you did not,
   and why.

## Where things are

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The reviewable summary — start here |
| [`docs/architecture/09-reconciliation.md`](docs/architecture/09-reconciliation.md) | **The arbitration. Takes precedence over every section file.** Canonical table and env lists live here |
| [`docs/architecture/10-completeness.md`](docs/architecture/10-completeness.md) | What no section addressed; the CLAUDE.md carry-forward audit |
| [`docs/architecture/`](docs/architecture/) | 01–08, the full design by dimension |
| [`docs/schema.md`](docs/schema.md) | **The schema.** Beats every section file's DDL |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Settled calls and why. Pricing lives here |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 3–5 |

## The schema

**Done.** [`docs/schema.md`](docs/schema.md) + `supabase/migrations/0001_initial_schema.sql`
are the schema; the eight section files carry a banner saying their DDL is superseded.
Applied to a scratch PostgreSQL 16.13 and verified by execution: `catalog.sql` 18/18,
`isolation.sql` 10/10, `rls.sql` 8/8. **Never applied to a real Supabase project** —
none exists.

Before changing it: run `scripts/localvalidate/run.sh`, then all three files in
`scripts/verify/`. All raise on failure, so a red check fails CI rather than printing.
**`rls.sql` is not optional after a policy or grant change** — it runs as `anon` and
`authenticated`, and it is the only one that distinguishes a policy that works from a
policy that merely exists. It found three bugs the other two could not.
Re-run them after any migration touching grants, policies, triggers or seeds, and check
each table independently — the last failure of this kind next door was partial.

## Open, and blocking

- **Reception runs Sonnet 5** (D-009, settled by two bake-off rounds and native-speaker
  review). **No Haiku for customer-facing Mongolian prose** — it is a fluency ceiling, not
  a prompt gap; hardening that names the wrong forms did not fix it. Haiku stays eligible
  for internal/structured work. Margin is 29% against a 60% target; the recovery path is
  `docs/prefix-trim.md`, which does not close it alone.
- **The ceiling contradiction — this blocks V1 Track 2.2.** D-004 derives Reception's
  spend ceiling from the discounted floor: ₮80,000 ≈ **$22.86/month**. D-009's measured
  Sonnet 5 cost at the assumed 4,500 replies/month is **$40.50** — **1.77× the ceiling**,
  which the ceiling buys only ~2,540 replies of. The ledger fails closed and reserves
  before the call, so shipping both as written means **Reception stops replying around
  day 17 of every month.** Neither decision is wrong; the arithmetic they produce
  together is. The trim cannot close 1.77×, and reopening D-009 re-opens broken
  Mongolian. It is a commercial call — options and a recommendation are in
  [`docs/V1.md`](docs/V1.md#the-ceiling-contradiction). **Do not pick a number here.**
- **No revenue path exists.** The platform can spend and cannot collect.
- **KEK escrow and a second admin** on Meta, Supabase, GitHub and the registrar are not
  done. Losing either is unrecoverable.

## The ancestor

`Matrix-Chatbot` is the single-tenant predecessor, in production for Matrix Eco Salon.
Read it for what works — fast-ACK plus a durable QStash hand-off, raw-body signature
verification, per-PSID conversation keys, pinned Mongolian sentences — and for the list of
things multi-tenancy must undo. Its known live defects are catalogued in
`docs/architecture/00-research-notes.md`; **do not port them.** Chief among them: a
module-scope prompt cache, `/me/messages` (which posts as whoever the token belongs to),
and a `|| process.env.PAGE_ACCESS_TOKEN` credential fallback.
