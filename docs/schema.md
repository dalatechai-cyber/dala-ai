# Schema

**This document and `supabase/migrations/0001_initial_schema.sql` are the schema.**
Where a file under `docs/architecture/` disagrees with either, that file is stale — its
DDL was a proposal, and [`09-reconciliation.md`](architecture/09-reconciliation.md)
arbitrated the twenty-three places the proposals contradicted each other.

79 tables in `public`, **13** functions across `app` and `ops`. The count was 11 until
`0012` added `ops.stamp_went_live` and `ops.stamp_went_live_on_insert`; `catalog.sql` V26
now asserts the property that matters about all thirteen (every one pins `search_path`), so
the number here is a description and the check is the guarantee.

## Status: applied and verified locally, and `0001`–`0012` applied to the real project

Built against PostgreSQL 16.13 and verified by **execution**, not by reading:

| | |
|---|---|
| `supabase/migrations/0001`–`0018` | apply clean in order on an empty database (`scripts/localvalidate/run.sh`) |
| `scripts/verify/spend.sql` | **10/10 PASS** on PG16 — the ledger moves all of its counters or none. Runs in `run-all.sh` beside the other three |
| `scripts/verify/catalog.sql` | **30/30 PASS** on PG16. On the real project V25 fails by design until `supabase_admin`'s default ACL is revoked by a role that can; V26 and V27 pass since `0014` and `0015` landed; V28 fails until `0017` is pushed |
| `scripts/verify/isolation.sql` | **14/14 PASS** — behavioural, **as `service_role`**, the role that writes. It must bypass RLS for these checks to mean anything; `T0` fails the run if it stops doing so (D-027) |
| `scripts/verify/rls.sql` | **8/8 PASS** — behavioural, **as `anon` and `authenticated`** |

## What every migration after `0001` adds

**This list is enforced, not maintained by hope.** `scripts/guards/check-schema-doc.mjs`
fails the build when a migration exists that this section does not name — because a
schema document that is silently five migrations stale is the same defect as
`supabase_migrations.schema_migrations` looking identical whether a migration ran or not,
and this file is the one CLAUDE.md points at as authoritative. It was five behind when the
guard was written.

| Migration | Adds | Why it matters to someone writing INSERTs |
|---|---|---|
| `0002_knowledge_embeddings` | `knowledge_chunks.embedding vector(1536)` + a partial HNSW index | P2. Applied when retrieval is switched on, not at launch |
| `0003_gate_canned_kinds` | six more `canned_response_kinds` rows | The Ш0–Ш9 gate names ten kinds; the initial seed had four. A gate pointing at a kind that cannot exist is a check with no answer |
| `0004_forbidden_phrasing_gates` | `forbidden_phrasings.gate`, `.stems[]` | Without them the guard check that reads the table is inert — a row with no `gate` is documentary and is skipped, never flattened into another gate's list |
| `0005_deterministic_matchers` | `deterministic_replies.match_mode`, `.stems[]`, `.requires_empty_history` | The table stored a reply and no way to decide when to send it |
| `0006_reply_freshness` | `tenants.max_reply_age_minutes` | §3.9's H11 check 7. A redelivery hours later must not answer a customer who has moved on |
| `0007_comment_replies` | `outbound_messages.kind`/`comment_id`, `tenant_channels.comment_*` | Public replies to comments on the tenant's own posts (§3.8) |
| `0008_erasure_requests` | `contact_erasure_requests`: `id_kind`, `source`, `app_slug`, `status`, `confirmation_code` + two CHECKs | Meta's Data Deletion callback. `erasure_completed_has_evidence` makes a row unable to claim completion without it |
| `0009_comment_post_cap` | `outbound_messages.comment_post_id`, `tenant_channels.comment_replies_per_post_per_day` (default 1, 1–50) | D-021's one public reply per post per day |
| `0010_prompt_blocks_seed` | `prompt_blocks.layer` (nullable) + two CHECKs + a partial unique index; seeds 21 signed platform blocks | `layer is null` means customer-visible Mongolian the prompt compiler must NOT render — the status page and the comment template live in the same table |
| `0011_provenance` | `provenance text` on `service_aliases`, `deterministic_replies`, `out_of_scope_topics`, `faqs`, `disclosure_rules` — **NOT NULL with NO DEFAULT** | D-020. **An INSERT into any of those five that does not say where the row came from is refused by the database.** `tenant_confirmed` \| `seeded` \| `inferred` |
| `0012_channel_went_live` | `tenant_channels.went_live_at` + two triggers | D-025. Stamped automatically on the transition into `delivery_mode='live'`, and on an insert already at `live`. Never set it by hand |
| `0018_prompt_block_vertical` | adds `prompt_blocks.vertical` (nullable) and relaxes `prompt_blocks_platform_key` to `(block_key, coalesce(vertical, ''))` | Nothing for an INSERT while no row carries a vertical — and none does yet, so every compiled prompt is byte-identical. A block with a vertical applies only to tenants whose `tenants.vertical` matches; `loadPromptSections` picks the most specific row per key, in JavaScript rather than in the PostgREST filter, because `tenants.vertical` is free-form text. The index change is the one non-additive line and it is a relaxation: every row the old index permitted, the new one permits. `catalog.sql` V29 asserts every vertical a tenant HAS is covered by every block that is per-vertical at all; V22 now counts only blocks with no vertical, so the twelve-block gate stays exact (D-034) |
| `0017_channel_health_state` | adds `channel_health.state` (nullable text) and a CHECK that `healthy = (state = 'healthy')` | Nothing for an INSERT beyond writing the verdict alongside the boolean — the watchdog is the only writer. The five verdicts used to reach this table as one bit plus prose, so the first dashboard question ("how many channels are unhealthy?") would have counted a tenant whose hours are not entered yet as an outage — the conflation D-032 removed from the alert, waiting one layer down. No CHECK on the vocabulary on purpose: the states are a code-level union, and a constraint that must be migrated in lockstep would silently stop health being recorded on the release that adds one. `catalog.sql` V28 asserts the column AND the constraint |
| `0016_spend_all_or_nothing` | adds `reserve_spend_all`, `release_spend` and `settle_spend_all` (with `public` wrappers), each moving every counter it is given or raising and rolling back | Nothing for an INSERT. It closes two leaks in the money path: a reservation that incremented the tenant counter and was refused by the platform one stayed charged until midnight, and `release()` set a state without ever giving the budget back — so every 503 after a successful reserve consumed the estimate again on each retry. `scripts/verify/spend.sql` proves the atomicity, and was made to go red both ways before being trusted |
| `0015_public_spend_rpc` | adds `public.reserve_spend` / `public.settle_spend` — thin `SECURITY INVOKER` wrappers over the `app.*` originals — and revokes `PUBLIC`/`anon`/`authenticated` EXECUTE on all four | Nothing for an INSERT, and everything for the runtime. `supabase/clients.ts` builds every client on the default `public` profile, so `db.rpc('reserve_spend')` asked PostgREST for `public.reserve_spend`, which did not exist: **every reply refused with `guard_unavailable`, for every tenant, from the first message that ever reached the worker** (2026-09-06). The unit tests stub `db.rpc` and answered `true`, so nothing could have caught it short of a real request |
| `0014_pin_ops_search_path` | pins `search_path = ''` on the four `ops.*` trigger functions | Nothing for an INSERT. Found by Supabase's linter, not by CI: V11 only ever asked about SECURITY DEFINER functions, and all four are INVOKER. `catalog.sql` V26 now asks the wider question |
| `0013_supabase_admin_default_acl` | attempts to revoke `supabase_admin`'s default table privileges from `anon`/`authenticated` in `public` | Nothing for an INSERT to know. It is a no-op on a vanilla cluster (no such role) and **warns rather than fails** on Supabase, where `postgres` is not a member of `supabase_admin` and cannot revoke it. `catalog.sql` V25 is what makes the residual visible |

Two of those change what a hand-written INSERT must contain: **`0011`'s `provenance`**
(five tables, no default, so omitting it is an error rather than a silent guess) and
**`0010`'s `layer`** on `prompt_blocks`. `0012`'s column is the opposite — set by trigger,
so writing it by hand is at best redundant.

**The RLS suite is the one that matters most**, and it had to be written separately:
the catalog pack proves a policy *exists*, and `isolation.sql` runs as superuser, which
bypasses RLS unconditionally. Only `set role` proves a policy *bites*. It found three
bugs the other two could not — see below.

**Applied to the real project 2026-09-05** (`tlggenaatnopnxzbkbuf`, PostgreSQL 17.6, via
the CLI with a 12-row ledger). `catalog.sql` returned **25/25** there — every check the file
carried at the time. It carries 27 now: `0013` and `0014` were written after that push and
have not reached the project, so V25 and V26 fail there until they do.

The PG17 reasoning above is now a measurement rather than an argument. Postgres grants an
eighth privilege on 17, `MAINTAIN`, and Supabase's bootstrap default ACL grants it to
`anon` and `authenticated` along with the other seven; `aclexplode` decomposes it without
change, exactly as predicted, and `anon` ends with **zero privileges on zero tables**.

Two things that reasoning did *not* predict, both found by running it:

- **0001's `alter default privileges … revoke all` is a no-op in CI and the whole defence
  in production.** A vanilla cluster has no default ACLs, so the statement changes nothing
  whether it is right, wrong or absent. On Supabase it is the only thing standing between
  every future table and an `anon` holding all eight privileges. It bites — verified by
  creating a table and reading its ACL — but it was untested for as long as CI was the
  only place the schema ran.
- **There are two grantors, and 0001 only reached one.** `ALTER DEFAULT PRIVILEGES`
  without `FOR ROLE` rewrites the current role's entry; Supabase also seeds one owned by
  `supabase_admin`, which `postgres` is not a member of and cannot revoke. `0013` attempts
  it and warns rather than failing; `catalog.sql` V25 asserts the end state so the
  residual is visible rather than silent.

The collation also differs and it is not cosmetic — CI is `C.UTF-8`, the project is
`en_US.UTF-8`, and the same Mongolian strings sort differently under each. See
`byCodePoint` in `src/lib/mn/text.ts`; ordering for the compiled prefix is done in
JavaScript for that reason.

## Conventions, chosen once

**Shared schema, `tenant_id uuid not null` on every tenant-scoped table.** At 2, 20 or
200 tenants this is the shape a solo founder can actually verify; schema-per-tenant
multiplies every migration and every policy audit by N.

**The composite-FK spine.** Children reference `(tenant_id, parent_id)`, never a bare
parent id. Every tenant-scoped parent therefore carries a `unique (tenant_id, id)` that
looks redundant against its primary key and is not.

This matters because **`service_role` holds `BYPASSRLS`**. RLS is the client-facing
half of isolation; it does nothing about a service-role route with a scoping bug, and
that route is where all the volume and all the spend are. The spine is what the
database still catches. It is checked by V14 and exercised by T1.

**Money is `bigint` nano-USD.** A Haiku cache-read token costs $0.0000001 and truncates
to zero in `numeric(14,6)` — a per-token price that rounds to nothing is a ledger that
under-reports every row. Humans read `app.v_spend_usd`.

**Lookup tables, not enums.** `alter type … add value` cannot run in a transaction with
surrounding DDL and cannot be rolled back. CHECK constraints are used only where the
value set is genuinely closed and code branches on it.

**Cyrillic is enforced by the database.** Every user-facing text column carries
`check (col is normalized)` — NFC, asserted rather than trusted from every writer.
`unaccent` is banned and its absence is a verification check.

## The tables, by domain

**Tenancy and identity (13)** — `tenants` · `tenant_members` · `platform_admins` ·
`channel_providers` · `tenant_channels` · `channel_identity` · `channel_transfers` ·
`channel_probe_tokens` · `tenant_secrets` · `tenant_domains` · `roles` ·
`tenant_roles` · `role_health`

**Config and knowledge (31)** — `config_revisions` · `config_snapshots` ·
`config_audit` · `config_keys` · `price_axes` · `services` · `service_variants` ·
`service_aliases` · `staff_members` · `disambiguation_pairs` ·
`disambiguation_candidates` · `deposit_rules` · `business_hours` · `tenant_closures` ·
`faqs` · `contact_points` · `tenant_booking` · `knowledge_documents` ·
`knowledge_chunks` · `canned_response_kinds` · `canned_responses` ·
`disclosure_rules` · `out_of_scope_topics` · `forbidden_phrasings` ·
`deterministic_replies` · `prompt_blocks` · `prompt_examples` ·
`tenant_prompt_overrides` · `mn_fold` · `probe_templates` · `probe_runs`

**Conversation and delivery (15)** — `persons` · `person_identities` ·
`consent_records` · `contacts` · `conversations` · `conversation_events` · `messages` ·
`webhook_events` · `outbound_messages` · `outbound_policies` · `handoffs` ·
`handoff_targets` · `staff_notifications` · `channel_health` ·
`contact_erasure_requests`

**Money (8)** — `model_prices` · `fx_rates` · `tenant_budgets` · `spend_counters` ·
`spend_reservations` · `spend_ledger` · `ledger_deadletter` · `job_runs`

**Analytics and quality (8)** — `booking_links` · `link_clicks` ·
`attributed_bookings` · `analytics_reports` · `quality_flags` · `quality_reviews` ·
`kb_change_proposals` · `kb_change_proposal_evidence`

**Ops (4 + 2)** — `alerts` · `audit_log` · `onboarding_steps` · `tenant_offboardings` ·
`ops.table_security_class` · `ops.tenant_scope`

## The arbitration, one line each

The twenty-three conflicts and the shape that won. Full reasoning in
[`09-reconciliation.md`](architecture/09-reconciliation.md).

| # | Conflict | Resolution |
|---|---|---|
| 1 | Four knowledge-base schemas | One namespace, no `kb_` prefix; the two-axis pricing model, because Matrix already carries two axes hidden inside its service names |
| 2 | Unit economics did not close | Model choice is a pricing decision (D-009); ceilings derive from the discounted floor price |
| 3 | Two spend-ceiling mechanisms | The reservation + CAS + settlement model, plus append-only triggers — one built the mechanism, the other proved what makes it un-erasable |
| 4 | Four channel-table shapes | `tenant_channels` with a surrogate id, plus the `channel_identity` split Instagram actually requires; `status` (health) and `delivery_mode` (cutover) are orthogonal |
| 5 | Four config-versioning schemes | `config_revisions` + `config_snapshots`; `tenants.live_revision_id`; rollback is one pointer move |
| 6 | CLI vs dashboard SQL editor | CLI from `0001`, no exceptions (D-012) |
| 7 | Checklist omitted ~19 provisioning steps | Seeds are part of the migration; three of them make the first message 503 without it |
| 8 | Four idempotency tables | One `webhook_events`, keyed `(provider, dedup_key)` **globally** — a per-tenant key lets one event process twice under two tenants |
| 9 | Four outbound tables; `voice` in one enum, banned from another | One `outbound_messages`; `channel_providers` is a lookup table and voice is simply a row nobody inserts |
| 10 | Six refusal shapes, four matcher semantics | `disclosure_rules` + `out_of_scope_topics`; stem-prefix matching, because exact-token loses to Mongolian agglutination |
| 11 | Cache TTL and write multiplier | `prompt_cache_mode ∈ (off, 5m, 1h)`, default `off`, set from measured traffic; 1.25× at 5m and **2× at 1h** |
| 12 | Owner dashboard | No tenant-owner login in v1; the policies ship dormant |
| 13 | Quality's cost bucket | Attributed per tenant, billed to `platform_ops` |
| 14 | Four cache keys | Local cache `(tenant_id, revision_id, channel)`; Anthropic cache by `content_hash` over the stable prefix only |
| 15 | Ceilings as env vars | Never. Compiled cap and a DB row that can only lower it |
| 16 | Weaker verification pack | The full pack, driven from `ops.tenant_scope` |
| 17 | Consent existed in one section | `persons` + `person_identities` + `consent_records`; consent is checked across **all** roles |
| 18 | Roles designed twice | `roles` + `tenant_roles` + `role_health`; budgets do not live on `tenant_roles` |
| 19 | Two attribution models | Click log + booking **state** + self-report tier; a booking is not revenue |
| 20 | Retrieval built / forbidden / assumed | Build the tables and the chokepoint; ship inline. The danger was never retrieval, it is a hand-written vector query outside a tenant scope |
| 21 | At-least-once vs at-most-once | Both: generation bounded by the CAS gate, delivery by the claim + lease |
| 22 | Contact key, message body, states | `(tenant_id, channel_id, external_id)`; one `body` column; six conversation states |
| 23 | Names and enums | `tenant_channels`, `alerts`, `kb_change_proposals`, `default_locale`, `tenant_booking` + `booking_links` |

## Client-readable is a separate question from tenant-scoped

67 tables carry a `tenant_id`. **31 are client-readable; 48 are not.** A tenant must
never read its own spend ledger, its encrypted tokens, raw webhook payloads, quality
verdicts, consent evidence or the audit trail — all of which carry a `tenant_id`.

`ops.tenant_scope` answers *"what column scopes this table"* (for the spine, purge and
export). `ops.table_security_class.client_readable` answers *"may the tenant see it"*,
defaults to **false**, and is an explicit allowlist. V15 and V16 assert both directions.

The read policies are dormant in v1 — there is no tenant login (item 12) — so this is
what the dashboard *would* show, decided now rather than at the moment it is switched on.

## Five things the migration does that reading it would not reveal

**The ops metadata must be populated before the policy loops.** §10 and §11 are driven
from `ops.tenant_scope`. On the first run the seed came *after* them, so both loops ran,
succeeded, and created **zero policies and zero grants** — silently. That is the exact
failure this schema is built to prevent, it survived being written carefully, and it was
caught only by running the file and counting rows. Section 9.5 now precedes them.

**Three foreign keys were off the spine.** `disambiguation_candidates`,
`spend_ledger.reservation_id` and `spend_reservations.webhook_event_id` referenced bare
parent ids. V14 found them; all three are now composite.

**`FORCE ROW LEVEL SECURITY` broke the SECURITY DEFINER helpers.** FORCE applies RLS to
the table *owner*, and `app.current_tenant_ids()` / `app.is_platform_admin()` execute as
the owner — so they read **zero rows** from `tenant_members` and `platform_admins`. Every
member read returned nothing and every admin check returned false, silently, with a
policy set that looked perfect. Those two tables are now the documented FORCE exception,
and V3 asserts the exception *exactly*, so a third table losing FORCE still fails.

**The restrictive write-deny policy was `FOR ALL`, which includes SELECT.** Restrictive
policies AND with everything else, so `false AND member_read` = false: the schema denied
**every client read**, not just writes. It fails closed, so nothing was unsafe — but the
dormant dashboard would never have worked when switched on, and the catalog pack still
counted a policy on every table. Now three policies per table, one per write command,
asserted by V17.

**A mechanical grant rule handed tenants their own spend ledger.** Driving reads from
"has a `tenant_id`" granted SELECT on `spend_ledger`, `tenant_secrets`, `webhook_events`
and 45 others. Fixed by the allowlist above; V15 asserts it.

All five were found by running the schema. Three of them are invisible to review,
because in each case the file reads correctly.

## Verifying

```bash
scripts/verify/run-all.sh          # migrations + all three suites; exits non-zero on red
```

Connection comes from the standard `PG*` variables, so the identical script runs
locally and in CI. **`.github/workflows/schema.yml` runs it on every PR touching
`supabase/` or `scripts/`**, against `pgvector/pgvector:pg16` with `--locale=C.UTF-8`
— so `0002` is exercised rather than assumed, and V0 fails the job if the collation is
ever wrong. Validation only one person can perform is not durable validation.

Individually:

```bash
scripts/localvalidate/run.sh                            # applies every migration in order
psql -d dala_validate -f scripts/verify/catalog.sql     # 18 structural checks
psql -d dala_validate -f scripts/verify/isolation.sql   # 10 behavioural, as superuser
psql -d dala_validate -f scripts/verify/rls.sql         # 8 behavioural, as anon/authenticated
```

All three raise on failure. **Run `rls.sql` after any policy or grant change** — it is
the only one that can tell a policy that works from a policy that merely exists.

`scripts/localvalidate/shim.sql` recreates just enough of Supabase's `auth` schema and
roles for `0001` to run offline. **It must never be applied to a real project** — it defines
its own `auth.uid()`, which on Supabase would overwrite the real one and hand every RLS
policy in the database a stub. This was a note about a project that did not exist; one does
now, so read it as a prohibition.

Run `catalog.sql` after every migration touching grants, policies, triggers or seeds,
and check each table independently — the last failure of this kind next door was
partial, one of four tables.

## What is deliberately not here

- **Embeddings at launch** — `0002` is validated and applied when retrieval is switched
  on per tenant; no embeddings are populated.
- **A tenant-owner login** — the policies exist and are dormant (item 12).
- **Any SMS transport** — `channel_providers.sms` is seeded `enabled = false` and
  `outbound_policies.sms.per_message_cost_nanousd` is `NULL`, which **refuses**. An
  unknown price does not default to zero.
- **`voice` anywhere** — not a provider row, not a role state a code path executes.
- **Billing** — there is still no revenue path. The platform can spend and cannot
  collect (`10-completeness.md` #6).
