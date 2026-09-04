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

**Status: V1 BUILD AUTHORIZED 2026-09-01 by the founder. Product code is allowed.**
The earlier "no product code" rule is lifted and must not be reinstated by inference.
Build V1 Track 1 onward per [`docs/V1.md`](docs/V1.md).

**The Meta app EXISTS, and every earlier statement in this repo that it does not was
wrong** (corrected 2026-09-04 by the founder). The app is **`dalatech`**, it holds
**`pages_messaging` and `public_profile` at Advanced Access**, and the founder has
generated a working Page access token for Matrix and read the inbox with it.

That correction has teeth, so read how the error happened before trusting anything similar
here. `developers.facebook.com` is blocked by this environment's egress proxy, so no
session can check the App Dashboard. Earlier sessions read "no Meta app exists" in these
docs, could not falsify it, and repeated it as established fact — until it was load-bearing
in a schedule. **An unfalsifiable claim in this repository is a claim to re-ask the founder
about, not a fact to inherit.** It is the same failure D-020 names: a source answering
plausibly instead of admitting it cannot see.

The consequence is large: **Reception's DM path needs no App Review.** It makes exactly one
Graph call, `POST /{page-id}/messages`, under a permission the app already holds at
Advanced Access. App Review is now a *comments-only* concern (D-023), and it no longer sits
on the critical path to a first real message.

Still true, and still constraining: **no Supabase project exists.** The schema is verified
against a scratch PostgreSQL only, so anything needing a live project is written and
tested against local Postgres until one is provisioned.

**The Supabase project is DEFERRED, and deliberately so** (2026-09-04). The free tier caps
at two projects and both are spent on `core-english` and `core-chinese`; Pro is not being
bought until Matrix is signed, because one tenant covers the $25 several times over. That
makes it a cost against revenue rather than against hope — which is the same test D-017
applied to KEK escrow, and it is not a blocker to raise again.

The consequence is a standing rule, not a temporary inconvenience: **build everything that
does not need Postgres, and mark what does as parked and unverified.** Parked today:

- **`isolation.sql` T8/T9 against a real project.** They pass against scratch Postgres in
  CI, which is not the same claim and must never be written as if it were.
- **Anything that needs PostgREST**, i.e. the `@supabase/supabase-js` transport. Every
  query in `src/` is exercised against a stub and has never been sent over the wire.

Everything else is written against stubs and says so.

**The send is built and has never sent anything** (2026-09-04). Draft → claim → decrypt →
`POST /{page-id}/messages` → mark, with the Graph error taxonomy, the failed/indeterminate
split, and the `delivery_mode` gate. **It has never reached Meta** — not for want of an app
or a token, both of which exist, but because no Supabase project holds a `tenant_channels`
row or a sealed secret for it to read. `docs/STATUS.md` is the ordered list of what turns
that into a real message, and the list is shorter than it was.

**Meta token decryption is no longer parked** (2026-09-04, on the founder's call: *"waiting
until a Meta app exists means writing crypto at the worst moment — when I'm trying to go
live"*). The call was righter than the reasoning given for it: the app existed already, so
the crypto was never being built early at all.

`src/lib/crypto/` and `src/lib/secrets/` are built, and `scripts/verify/secret-roundtrip.ts`
runs the whole path against a real PostgreSQL in CI: seal, store in `bytea`, read back in
PostgREST's hex form, decrypt through the runtime loader. What that does **not** prove, and
must never be written as if it did: there is no Supabase project and no PostgREST hop, and
the KEK in CI is generated per run and thrown away. A real Page token now exists — the
founder holds one for Matrix — but it has never been sealed by `scripts/kek/seal.ts` or
read back by the runtime loader, so the round trip is still proven only over test material.

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

## Merge authority

**Open a PR for everything; merge your own once CI is fully green AND the job logs have
been read step-by-step rather than the tick trusted.** Authorised 2026-09-04 by the
founder. Reading the logs is the load-bearing half: a green tick has already hidden a
skipped test here, and a step that prints nothing on success looks identical to one that
did nothing.

**Four things still wait for the founder**, and each is a category rather than a file:

| Waits | Means |
|---|---|
| **Money movement** | Payments, billing, ceilings — anything that changes *what can be spent*. **Not** a code path that will eventually call a model under an existing ceiling. Settled 2026-09-04 after PR #9 tested the boundary |
| **Credentials** | Provisioning, rotating or handling real secret material |
| **Destructive migrations** | Anything that drops, rewrites or narrows existing data |
| **Any customer-visible Mongolian string** | The words a customer reads. Matcher stems and test fixtures are not this; a sentence the bot sends is |

The last one has a mechanism rather than a convention: platform Mongolian lives in
`prompt/platform/*.mn.txt`, signed by **file hash** in `prompt/platform-mn-review.json`,
and `scripts/guards/check-mn-review.mjs` fails the build when a block is unsigned or has
changed since sign-off. Unsigned drafts live in `prompt/drafts/` and are loaded by
nothing.

`docs/schema.md` has one too. `scripts/guards/check-schema-doc.mjs` fails the build when a
migration exists that the document does not name — it was five behind when the guard was
written, including `0011`, which adds a NOT NULL column with no default to five tables, so
following the document produced INSERTs the database refuses.

## Where things are

| | |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **Where this actually is.** What is built, what has never been proven, and the ordered list of what the founder must supply for one real message |
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
  for internal/structured work. **The 29% margin figure is superseded** — it assumed
  4,500 replies/month; measured traffic is 41% of that, so the real margin is **71%**
  and Reception clears the 60% target (D-016). `docs/prefix-trim.md` is therefore no
  longer a margin rescue; it matters for scaling across tenants.
- **Reception is sold against a 400-conversation/month band** (D-015). The ceiling is
  unchanged — D-004's formula gives ₮80,000 ≈ $22.86/mo. **Overage is the §5.7
  degradation ladder, never an invoice** — billing overage is undesigned and must stay
  that way while there is no revenue path.
- **Matrix's real volume is measured (D-016):** 6 days of production logs, mean 60.5
  replies/day → ~1,842/month, **41% of the assumed 4,500**. Spend $16.57/mo against a
  $22.86 ceiling (0.73×), margin **71%**. A8 = 750 conv/mo is refuted;
  `05-spend-ledger.md`'s 300–600 was closer. **The margin figure rests only on measured
  replies and is solid. The conversation count still divides by the unmeasured A7 = 6 —
  count distinct PSIDs instead** (the log line carries them). The band stays at 400: the
  busiest measured day sustained is ~477 conversations, outside it. Six days carries no
  seasonal shape; the mirror phase's 14 days still sets the final number.
- **No revenue path exists.** The platform can spend and cannot collect.
- **Single-owner risk is ACCEPTED, not open** (D-017). KEK escrow and second admins are
  deliberately deferred; provider recovery emails and codes are the mitigation. **Do not
  raise this again** unless one of D-017's named triggers fires.

## The ancestor

`Matrix-Chatbot` is the single-tenant predecessor, in production for Matrix Eco Salon.
Read it for what works — fast-ACK plus a durable QStash hand-off, raw-body signature
verification, per-PSID conversation keys, pinned Mongolian sentences — and for the list of
things multi-tenancy must undo. Its known live defects are catalogued in
`docs/architecture/00-research-notes.md`; **do not port them.** Chief among them: a
module-scope prompt cache, `/me/messages` (which posts as whoever the token belongs to),
and a `|| process.env.PAGE_ACCESS_TOKEN` credential fallback.
