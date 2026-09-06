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

**The Supabase project EXISTS as of 2026-09-05** — ref `tlggenaatnopnxzbkbuf`, PostgreSQL
17.6, ap-southeast-1. Migrations `0001`–`0015` are applied through the CLI with a real
**fifteen**-row ledger (D-012, read back 2026-09-06), and `catalog.sql` returned 25/25
against it when the file carried twenty-five checks. It carries twenty-eight now: V26 and V27
pass there since `0014` and `0015` landed, and **V25 still fails and is meant to** (see the
second bullet below). **`0016` is written and NOT yet pushed** — it closes two
leaks in the money path (D-031), and until it lands `release()` still gives no budget back. Read the count off `supabase_migrations.schema_migrations`, never off
`ls supabase/migrations/`.

**Running it there immediately found three things CI structurally could not**, which is the
argument for having bought it, and the reason to distrust "verified in CI" as a synonym for
verified:

- **0001's `alter default privileges … revoke all` is a no-op in CI and the entire defence
  in production.** A vanilla cluster has no default ACLs, so tables come out ungranted
  whether that line is right, wrong or absent. Supabase seeds defaults granting `anon` and
  `authenticated` all **eight** PG17 privileges on every future table in `public`. The line
  bites — proven by creating a table and reading its ACL — but nothing had ever tested it.
- **There are two grantors and 0001 reached only one.** `supabase_admin` owns a second
  default-ACL entry that `postgres` cannot revoke. `0013` attempts it and warns; V25
  asserts the end state so the residual is visible rather than silent. **Re-measured
  2026-09-06, after `0013` was pushed: still there** — `supabase_admin` grants `anon` and
  `authenticated` all eight privileges on every future table in `public`. It is latent, not
  live: it only matters for objects created in `public` **by** `supabase_admin`.
- **The collation differs and it is not cosmetic.** CI is `C.UTF-8`, the project is
  `en_US.UTF-8`, and the same Mongolian strings sort differently under each — which fed
  the compiled prefix and therefore the prompt-cache key. Ordering now happens in
  JavaScript by code point (D-026).

**Still not proven, and do not write as if it were:**

- **`isolation.sql` and `rls.sql` against the project.** They seed test tenants and depend
  on `begin … rollback`; the MCP transport commits, and `config_audit` is append-only so a
  seeded `tenants` row cannot be deleted. They must be run over psql. The critical claims
  were confirmed by direct probe — `anon` refused everywhere, cross-tenant isolation holds,
  TRUNCATE and INSERT refused — but the suites themselves have not been run there.
- **Most of what needs PostgREST.** The transport itself is no longer unproven: on
  2026-09-06 a real Meta delivery had the app read `channel_identity` and insert into
  `webhook_events` against the project, over `@supabase/supabase-js` with the service key.
  Everything downstream of the queue — the config compile, the outbound claim, the spend
  ledger — is still exercised only against a stub, and `query-columns.ts` (277 references
  across 100 sites, checked against the applied schema every CI run) is what stands under
  those until they run for real.

**The send is built and has never sent anything** (2026-09-04; still true 2026-09-06, for a
third reason). Draft → claim → decrypt → `POST /{page-id}/messages` → mark, with the Graph
error taxonomy, the failed/indeterminate split, and the `delivery_mode` gate. **Tenant #0
is now fully provisioned**: nine founder-approved `canned_responses`, config revision
`26814470-…` published (`content_hash 8b35d072…`, 9,265 chars, `allowed_numbers []`), the
channel `active / live / active` with a sealed `page_token`. `tenants.status` stays
`provisioning` because `active_requires_probe_run` wants a `probe_passed_at` that only a
probe run sets, and the probe route is not built — **nothing on the reply path reads
`tenants.status`**, so it does not gate a reply.

`0015` is pushed and verified against the project: both wrappers exist in `public`,
`reserve_spend` returns boolean, `settle_spend` returns void, and the ACLs are `postgres`
and `service_role` only.

**The first real webhook arrived on 2026-09-06 and was lost, with every status code
behaving as written** — QStash refused the colon-joined `deduplicationId`, the route 500'd,
and Meta's two retries were skipped as duplicates and answered 200, which ends redelivery.
Read D-028 before touching `webhook/events.ts`, `queue/qstash.ts` or `health/stranded.ts`:
the id is hashed, a duplicate that never reached the queue is re-enqueued, and the sweeper
§3.6.3 specified is finally built.

**Then the second message found two more of the same shape** (D-029), and this is the
sentence to carry forward: **three lost messages in one night, all three from reading "a
row exists" as "the work was done."** The queue layer (a `webhook_events` row ⇒ enqueued),
the reply layer (a `messages` row ⇒ answered), and underneath both, a spend RPC that could
never have worked:

- **`db.rpc('reserve_spend')` asked PostgREST for `public.reserve_spend`; the function
  lives in `app`.** Every client in `supabase/clients.ts` is built with no `db: { schema }`
  option, so the default profile is `public`. Every reply, for every tenant, refused with
  `guard_unavailable`. `0015` adds the wrappers. **The unit tests stub `db.rpc` and answer
  `true`** — so a passing suite said nothing at all about this, and could not have.
- **A row proves itself and nothing else.** `outbound/claim.ts` now answers "has this
  customer message been answered?" with `findReplyFor`, keyed on the reply's own dedup key,
  because the evidence that a reply happened is a reply.

**`src/lib/replay.test.ts` is where that property now lives** (D-030): both entry points
run twice with the same delivery, asserting one event, one message, one reply, one send.
Its fake reads its unique constraints out of `0001` rather than carrying transcribed ones.
It is not PostgREST and cannot catch a name resolved against the wrong schema — the third
bug of that night — so do not read a green harness as covering the transport.

**Meta token decryption is no longer parked** (2026-09-04, on the founder's call: *"waiting
until a Meta app exists means writing crypto at the worst moment — when I'm trying to go
live"*). The call was righter than the reasoning given for it: the app existed already, so
the crypto was never being built early at all.

`src/lib/crypto/` and `src/lib/secrets/` are built, and `scripts/verify/secret-roundtrip.ts`
runs the whole path against a real PostgreSQL in CI: seal, store in `bytea`, read back in
PostgREST's hex form, decrypt through the runtime loader. What that does **not** prove, and
must never be written as if it did: the hop is a local socket, not PostgREST, so the
transport the runtime will actually use is still unexercised, and the KEK in CI is generated
per run and thrown away. **Half of that changed on 2026-09-06:** a real Page token has now
been sealed by `scripts/kek/seal.ts` into `tenant_secrets` for tenant #0, under KEK `v1`
from the platform environment. It has never been *opened* — `last_ok_at` is null — because
nothing has reached the send, so the read half of the round trip is still proven only over
CI's test material.

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
5. **`revoke insert, update, delete` is not "cannot write."** Postgres grants **eight**
   privileges on PG17 — the eighth is `MAINTAIN`, and Supabase's bootstrap grants it to
   `anon` — and TRUNCATE bypasses RLS entirely. Enumerate the ACL; never count on a
   remembered list, which is how this said "seven" until the real project was read.
   Ownership RLS checks *who a row belongs to, never what it says*.
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

**The Vercel production build runs `scripts/preflight.ts` before `next build`**
(`vercel.json`). A missing or malformed variable fails the deploy instead of shipping a
deployment that 500s at the first customer message, and preflight never prints a value, so
the build log stays safe to paste. It is gated on `VERCEL_ENV = production`: preview
deployments are protected and serve nobody, and failing every PR build on Preview-scoped
variables that were never set would train the eye to ignore a red build. CI is untouched —
the workflow calls `npx next build` directly rather than through the package script.

**A check that gates has to be right, and this one was not.** When it was wired into the
build it still demanded that `WORKER_PUBLIC_URL` *contain* `/api/workers/reception`, while
`queue/qstash.ts` appends that path itself. So the correct value — an origin — was reported
BAD, and any value that satisfied the rule made QStash post to
`…/api/workers/reception/api/workers/reception`: a 404 on every job, with the enqueue
returning success and nothing to see. `preflight.test.ts` asserted the same wrong contract,
so the suite was green on both halves. Both are fixed. The lesson is the one this repository
keeps relearning: a rule and the code it describes have to be read *together*, because each
one alone reads as correct.

And `scripts/guards/check-deterministic-order.mjs` fails the build on a `.localeCompare(`
call anywhere in `src/`. Ordering that can reach the compiled prompt decides
`content_hash`, i.e. the prompt-cache key, so it must not depend on the runtime's locale
any more than on the database's collation (D-026). Exemptions are written as
`guard-ok:locale` on the line or the one above, so an exemption is always a sentence
somebody wrote rather than a filename that happened to match.

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
Applied to a scratch PostgreSQL 16.13 and verified by execution: `catalog.sql` 28/28,
`isolation.sql` 14/14, `rls.sql` 8/8, `spend.sql` 10/10. **Also applied to the real project** (PG17.6,
2026-09-05, via the CLI; `0013`–`0014` pushed 2026-09-06): `catalog.sql` was 25/25 there
against the twenty-five checks it then carried, and of the two written since, **V26 now
passes** and **V25 still fails** — `supabase_admin`'s default ACL, re-measured 2026-09-06,
and only a role that can act as `supabase_admin` will clear it.

**The two behavioural suites test different roles on purpose, and swapping them breaks
them** (D-027). `rls.sql` runs as `anon`/`authenticated` and proves the policies bite.
`isolation.sql` runs as **`service_role`** and proves the constraints bite for the role
that bypasses those policies — the inbound writer. Its `T0` fails the run unless
`service_role` bypasses RLS: measured, a non-bypassing role has T1's cross-tenant insert
refused by the policy (`42501`) before the composite foreign key is reached, so the test
would pass while the spine went untested.

**PostgreSQL 16 is installed in this environment** — `/usr/lib/postgresql/16/bin`, not on
`PATH`, which is why sessions keep concluding it is absent and leaving the SQL suites to
CI. `initdb` a scratch cluster and they all run locally in seconds; a migration should
never reach a PR without that.

Before changing it: run `scripts/localvalidate/run.sh`, then all four files in
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
