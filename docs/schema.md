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
| `supabase/migrations/0001`–`0026` | apply clean in order on an empty database (`scripts/localvalidate/run.sh`) |
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
| `0023_channel_expects_traffic` | adds `tenant_channels.expects_traffic_since`, `ops.mode_expects_traffic()`, and two triggers stamping it on the first transition into `shadow_routing`/`shadow`/`live` — on INSERT as well as UPDATE — plus a backfill of existing rows in those modes | Nothing for an INSERT: the triggers set it, and setting it by hand is the thing they exist to prevent. `0012` asked "when did this channel start expecting traffic?" and then answered a narrower question, stamping only the transition into `live` — so a channel in `shadow` had no clock to measure silence from, `assessSilence` returned `not_configured`, and `diagnoseChannel` rendered `not_provisioned`, which is recorded and deliberately never alerted. Correct for a channel mid-setup; wrong for one deliberately pointed at live customer traffic, where the only symptom of a broken subscription is an empty table nobody is watching. A SECOND column rather than widening `went_live_at`, by `0012`'s own argument against reusing `created_at` and `name_confirmed_at`: "when did we start answering customers" and "when did we start expecting webhooks" are different questions. `shadow_routing` is in the set because proving routing works is its entire purpose, so silence is precisely its failure mode; a tenant parked there before its Page is subscribed lands on `not_provisioned`, which does not page. The backfill is `coalesce(went_live_at, now())` — `created_at` was rejected because it would have put ~600 open minutes of parked time behind the threshold and paged on the watchdog's first run. `catalog.sql` V31, `isolation.sql` T14 |
| `0025_alert_routing` | adds `alerts.route`, `alerts.repeat_policy` (both `not null` with defaults), `alerts.resolved_at` and `alerts.notified_at` (both nullable), two CHECKs and two partial indexes | D-063. **Nothing for an INSERT that does not want it**: the defaults are `'now'` and `'daily'`, which reproduce the behaviour every existing call site already had, so a row written by un-redeployed code is unchanged. Measured 2026-09-14, the table held eleven rows and ten were one condition — `channel.no_webhooks`, critical, once a morning for six days for a channel whose state never changed — because the dedup key carried the local date. `route` says how the FIRST notification is delivered (`now` = Telegram immediately, `digest` = recorded and first seen at 09:00). `repeat_policy` says whether the condition may raise another row: `once`, `on_change` (one alert per unresolved episode), or `daily` (the caller put a period in the key, as `spendDedupKey` does). **`resolved_at` and `notified_at` are meaningful only for `on_change` rows**, which are EPISODES with an open/closed lifecycle; a `once` or `daily` row is an EVENT that happened and is over, its `resolved_at` stays null for ever, and both the digest and the three-day re-escalation filter on `repeat_policy` so the digest cannot grow into the whole history of the table. `notified_at` exists so re-escalation is an UPDATE rather than a second row with a dated key — `coalesce(notified_at, at)` is "when was a human last told", null-safe for a digest-routed row nobody has been paged about. It is NOT `delivered`, which records whether one Telegram call succeeded. `catalog.sql` V34 |
| `0024_snapshot_canned_hash` | adds `config_snapshots.canned_hash text` — **nullable, never backfilled** | D-058. The tenant's canned responses moved out of the per-request volatile tail and into the compiled prefix, which is worth ~1,000 tokens a reply — text that changes only at publish, previously billed at full input rate on every message because it sat after the cache boundary. **Nothing for an INSERT**: `publishRevision` writes it, and there is no hand-written INSERT into this table. The column exists because the move gives one sentence TWO sources — the snapshot the model reads and the `canned_responses` rows the deterministic short-circuit answers from — so a row edited without republishing would answer one customer from each with nothing able to notice. That is D-039's shape, and D-029's. `handleReception` recomputes the hash from the live rows on every request and returns 503 `canned_stale` on a mismatch, holding the message in QStash until an operator republishes. **NULL is a FORMAT marker, not "unknown"**: a snapshot published before this migration has a prefix that does not contain the section, and the reply path answers that by appending it to the volatile tail exactly as before — so the rollout needs no backfill, no flag day and has no window. A backfill is also impossible and should stay so: `config_snapshots` is append-only by an `ENABLE ALWAYS` trigger that binds `service_role`, and writing a hash onto an old row would claim its prefix contains text it does not. `catalog.sql` V33 |
| `0022_superseded_keeps_its_time` | widens `config_revisions`'s `published_has_a_time` from `(status = 'published') = (published_at is not null)` to `(status = 'draft') = (published_at is null)` | Nothing for an INSERT — it only ever permits more rows, and the project's one existing revision already satisfies it. Fixes a bug in `publishRevision`, not in the schema's intent: step 3 supersedes the outgoing revision with a bare `set status = 'superseded'` and leaves `published_at` in place, which the original CHECK refused — so **every tenant's second publish failed at step 3, after the snapshot insert and the CAS had already committed**, leaving two rows claiming `published` and the pointer on the old one. Measured by running the exact statement against PostgreSQL 2026-09-07. Nulling `published_at` instead would satisfy the old rule and destroy the only record of when a configuration was live, since `rollbackTo` moves the pointer without re-publishing. `publish.test.ts` stubs the client and accepts any update, so a green suite said nothing — the D-029 shape. `scripts/verify/isolation.sql` T12 runs the whole second-publish sequence and T13 pins the half of the old rule that was right |
| `0021_messages_retention` | replaces `ops.purge_expired` so it also redacts `messages.body` past `tenants.message_retention_days`, setting `body_redacted_at`, and reports a third count | Nothing for an INSERT — no table, no column, and a no-op on today's data since nothing is 90 days old. The messages half of §2's Retention table, deliberately left out of `0020` (whose instruction named the `webhook_events` rows) and reported as a follow-up rather than quietly widened. Everything it needs already existed: `body_redacted_at` from `0001`, the `redacted_or_present` CHECK that refuses a nulled body with no marker, and `readHistory`'s existing skip of redacted rows so a purge cannot put a blank turn in front of the model. **The row survives for a different reason than a `webhook_events` row does**: not idempotency, but that `revision_id`/`prompt_hash`/`answered_by` are how a reply is traced to the config that produced it, and deleting would silently change historical counts. The three counts are disjoint — `0021` keeps `0020`'s statement order so no row lands in two. `scripts/verify/retention.sql` P15–P17 |
| `0020_retention_closure` | adds `tenants.retention_days_raw_events` (not null, default 7, 1–30), `webhook_events.raw_purged_at`; makes `kb_change_proposals.decided_at` nullable with a CHECK; creates `ops.purge_expired` and its `public` wrapper | Nothing for an INSERT — both new columns are defaulted or nullable. Closes D-044: §2's Retention table decided "null `raw_payload` at 7 days, delete the row at 30" and only the messages half ever shipped, so `purge_after` was written by nothing and read by nothing. **`purge_after` stays deliberately unwritten** — retention is computed from `received_at` at purge time so a policy change reaches rows already stored, where stamping at claim time would freeze the old policy into every row; the column is reserved as a per-row override. **The row lives 30 days regardless of the knob, and that floor is correctness rather than privacy**: `unique (provider, dedup_key)` lives in the row, so deleting it re-opens double-answering a customer on a Meta redelivery — which is why the design nulls the payload instead. An UNROUTED event gets the 1-day floor rather than the 7-day default: it belongs to no tenant, so no tenant's policy can justify keeping it. The `public` wrapper exists because every client in `supabase/clients.ts` is built with no `db: { schema }` — a function only in `ops` is unreachable over PostgREST, which is D-029's third bug exactly. `scripts/verify/retention.sql` asserts all twelve properties against real rows |
| `0019_staff_short_name` | adds `staff_members.short_name` (nullable text, NFC-checked) | Nothing for an INSERT — nullable, no default, no existing row changes. It holds what customers actually call a person when that differs from `name` — **five of Matrix's six active stylists have one** (Zaya, Otgoo, Muugii, Оюунаа, Бадмаа), corrected 2026-09-07 against a stale roster that said one (D-047) — and it is rendered in БАГИЙН ЖАГСААЛТ as `Оюунсүрэн (Оюунаа)` so both spellings are in the roster Ш4 reads. **Deliberately not unique and deliberately not a `staff_aliases` table** (D-038): an alias table answers only the names somebody thought to type into it, and the case that actually happens — a customer who half-remembers a name — is the one it cannot hold. That case is Ш10's, drafted and unsigned. **Ordering matters for deployment:** `loadTenantKb` selects the column, so shipping the code before the migration makes every publish refuse with `staff_members unreadable` until it is applied. `catalog.sql` V30 asserts the column; `scripts/verify/postgrest.ts` now asserts every column in every `.select()` in `src/` exists on the public profile, which is what would catch that ordering in CI |
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
| 8 | Four idempotency tables | One `webhook_events`, keyed `(provider, dedup_key)` **globally** — a per-tenant key lets one event process twice under two tenants. The key itself is built by `src/lib/webhook/identity.ts` from **Meta's own ids for what the entry carries** (`message.mid`, `value.comment_id`), sorted and hashed. It was the request's BYTE LENGTH until 2026-09-06, which measured out to `307 + utf8_length(customer text)` on the real project — so two messages of equal length were one event, for ever (D-039). `source` says whether a delivery came from Meta directly or was forwarded by an incumbent during a mirror; it is written from `x-dala-webhook-source` and defaults to `meta` |
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

### `0026_image_reply_kind`

Adds the `image_received` row to `canned_response_kinds`. A customer whose message is only
a photograph got silence: `meta/extract.ts` skips a text-less attachment, and four real
photographs were dropped on 2026-09-15/16 (`inbound_dropped`, `attachments: ["image"]`, no
`sticker_ids`) — the case D-070 predicted. The ancestor answers these with a fixed line, so
the silence was a regression against the bot being replaced.

The kind only. The tenant's sentence is founder-gated Mongolian and lands as a
`canned_responses` row with `reviewed_at` null; `inbound/imageReply.ts` refuses to serve an
unreviewed row, so nothing reaches a customer until the reading evening.

### `0027_thread_control`

Answers a question nothing had ever asked: **who is holding this conversation — the bot, or
a person in the salon's inbox?** `conversations.state` has allowed `awaiting_human` and
`human_handled` since `0001` and **nothing writes either**; they appear in exactly one
place, `persist.ts`'s `OPEN_STATES`, where they read as "still open". That is D-064's
shape — a value that reads as a safety signal for as long as nobody tests it.

Adds to `conversations`:

| Column | Notes for hand-written INSERTs |
|---|---|
| `thread_control` | NOT NULL, **default `unknown`**, `check in ('bot','human','unknown')` |
| `thread_control_at` | nullable; when control last CHANGED, and what the cooldown measures from |
| `thread_control_source` | nullable, `check in ('handover','echo','reclaim')`. `reclaim` is unwritten — the outbound half is not built |

Adds `tenants.human_takeover_cooldown_minutes` (NOT NULL, default 30, `between 0 and 1440`)
and `tenant_channels.meta_app_id` (nullable, `^[0-9]{1,32}$`).

**The default is `unknown` on purpose, and the gate above is built to match.** `bot` would
be convenient and is a claim this platform cannot support — nobody has read the far side of
a Meta thread, and D-062 is eleven days of that mistake. D-063's addendum is the rule: a
migration adding a discriminator with a default retroactively decides the semantics of
every row already there, and those rows are the ones that motivated the change. H11 check 4
therefore refuses on a positively-established `human` and nothing else, so `unknown` can
never silence a tenant. **Widening that gate to refuse on `unknown` mutes every tenant at
once** — the honest default and the narrow gate are one design.

`meta_app_id` is Meta's own numeric id and **not** `app_slug`, which names a callback path
on this platform rather than an app at Meta (D-041). Handover events identify apps by this
id alone; NULL makes every handover verdict `unknown`, which changes no state. Only the
console can supply the value.

Nothing in this migration sends anything. `pass_thread_control` and `take_thread_control`
are not built: passing control is a live mutation of a real salon's thread ownership,
it cannot be rehearsed during a shadow mirror, and the receiver configuration on Matrix's
Page is not yet known. See [`docs/handover.md`](handover.md).

### `0028_prompt_blocks_seed`

The signed platform Mongolian, **the full set**, upserted into `prompt_blocks`. Twenty-two
blocks — the twenty-one of `0010` plus `02_style`, the brevity rules (D-081).

**`0010` is not regenerated and must never be.** It is what ran in September, and it is not
merely stale history: its `on conflict (block_key)` **cannot be applied at all** since `0018`
replaced that index with one over `(block_key, coalesce(vertical, ''))` — Postgres answers
the old target with *"there is no unique or exclusion constraint matching the ON CONFLICT
specification"* (measured, PG 16.13, `0001`–`0027` applied). So `0010`'s own row above —
"seeds 21 signed platform blocks" — stays true, and would have become a lie under the
regenerate path.

Every seed migration from here carries **every** signed block as an idempotent upsert, so:

- the end state after `db push` is the newest seed file, whatever was missed before;
- a push that is skipped is repaired by the *next* ordinary commit rather than lost. A
  delta chain cannot do this — it computes "already seeded" from the repo, so an unpushed
  block is excluded from every future delta and the tool reports "nothing changed" for ever;
- `generate-seed.ts` allocates `max(prefix) + 1` and writes with `wx`, so it has no way to
  open an existing migration. There is no `--force`.

The header carries a **manifest** — one line per row with `block_key`, `vertical`, `ordinal`,
`layer`, `sha256(body)[0:12]` and the sign-off date — emitted from the same array that emits
the tuples. A one-block change moves two lines of it; without it a 20 KB regenerated file is
unreviewable.

`VERTICAL_SEED_PATH` is **deleted**, and with it a live collision: it pointed at a
per-vertical seed file numbered **0019**, while `0019_staff_short_name` is applied under that
same number — so the first per-vertical block ever signed would have written a *second*
migration numbered 0019.
The four per-vertical gate blocks waiting on the reading evening are exactly that case. A
per-vertical block is now just a row whose `vertical` is not null, in the same file.

**A row here reaches no customer.** `compileStablePrefix` reads `prompt_blocks` at compile
time; the reply path serves frozen `config_snapshots` bytes via `tenants.live_revision_id`.
Pushing this migration puts the text where the compiler can see it — **the republish is what
publishes it**, per tenant.

### `0029_snapshot_prompt_gate`

`config_snapshots.prompt_gate text` — nullable.

The PLATFORM sections of the snapshot, joined; the corpus `disclosesPrompt` matches a
reply against. Before this the corpus was `prompt_stable`, the **whole** compiled prefix —
gate blocks and the tenant's knowledge base together — so a reply that quoted the tenant's
own facts back to a customer counted as disclosing the prompt.

Measured 2026-09-18 04:02 (D-084): a customer asked Matrix how many branches it has, the
model answered «Матрикс эко салон нийт зургаан салбартай» straight from the knowledge base,
and the reply was discarded for the generic handoff. The offending run was sixty characters
of which **two were punctuation** — a 58-character KB sentence plus the full stop and space
in front of it, present in both corpus and reply by coincidence of sentence boundaries.
Every KB sentence of 58 characters or more carried that trap.

It is the exact mirror of `allowed_numbers`, which has always excluded platform sections
because the gate's numerals are its counter-examples. This excludes tenant sections because
the tenant's sentences are the answer the bot was hired to give.

**NULL is a format marker, not "unknown"** — the same shape as `canned_hash` in `0024`. A
snapshot published before this column falls back to `prompt_stable`, which is exactly
today's behaviour: it over-refuses rather than under-refuses, and the next republish
narrows it. Reading NULL as "no corpus" would disable the check, which is the one direction
that must never happen by default.

**Not backfilled**, and it cannot be: `prompt_stable` is the concatenation and the
platform/tenant boundary is not recorded in it. A guessed corpus is worse than a null one
that says so.
---

## `0030_comment_rules.sql` — which public comments deserve a reply (D-085)

Adds one table, `comment_rules`. Nothing else is touched, and no existing behaviour
changes until a tenant has rows: `classifyComment` refuses `no_rules`, and the comment path
already refuses at `comment_policy = 'none'` for both tenants.

| column | |
|---|---|
| `tenant_id`, `rule_key` | composite primary key, as `out_of_scope_topics` |
| `verdict` | `escalate` \| `reply` \| `ignore`. **`unclassified` is deliberately unwritable** — it is the absence of a matching rule, and a row able to assert it would be a way to edit the operator's own to-do list |
| `matcher` | the SAME `matcher` jsonb `out_of_scope_topics` carries, parsed by the same `parseMatcher`. One matcher language on this platform, not two that drift |
| `enabled` | **defaults FALSE.** A rule is written, read by a human, then switched on. The same shape as `deterministic_shortcircuit`, and for the same reason: this surface is public and permanent |
| `provenance` | D-020, NOT NULL with no default |

RLS is on and forced, `anon` and `authenticated` are revoked, the three per-command
restrictive deny-write policies are created, and the table is registered in
`ops.tenant_scope` and `ops.table_security_class` — the five things `0001` does in bulk
loops that a later migration inherits none of.

**And a sixth: `grant all on comment_rules to service_role`.** `0001:1636` is a one-time
bulk grant over the tables that existed when it ran. Without it PostgREST does not expose
the relation at all — not a permission error, an absence from the schema cache, so every
`.from('comment_rules')` 404s at runtime while every SQL suite stays green. It shipped that
way and CI's PostgREST reachability check (D-037) caught it. **`catalog.sql` V35 asserts it
now**, because that suite only ever checked the deny side: V5 (`anon` holds nothing) and V6
(`authenticated` holds only SELECT) both pass perfectly for a table nobody can read.

**`MatcherSpec` gains a `stem_sequence` mode** in the same change (`src/lib/gate/match.ts`),
available to every caller of `parseMatcher` and not only to this table. It exists because
`MIN_STEM_CHARS = 4` correctly refuses «цаг» (*appointment*) and «хэд» (*how much*), which
are three characters and prefix «цагаан» and «хэдийнээ» — so a salon's two most valuable
intents were unreachable in rows. Ordered stems within a capped code-point window supply the
specificity the length floor is a proxy for; `parseMatcher` requires at least two stems and
a window ≤ 40, so the mode cannot smuggle a single short stem past the floor.

### `0031_website_channel`

Two tables and one function, for the website channel. Additive; nothing existing changes,
and `channel_providers.web` stays `enabled = false`.

**`web_sessions`** — the registry rule 1 demands for a surface where the caller can be
asked nothing. A tenant's own server signs a mint request with a per-tenant secret; the
platform derives the tenant from *which secret verified* (the shape `verifyMetaSignature`
already uses), mints an opaque token, and every later message resolves the tenant by
looking that token up here.

Writing one by hand, the columns with no default: `tenant_id`, `channel_id`,
`token_sha256`, `expires_at`, **`turn_cap`**. `turn_cap` is deliberately undefaulted — a
caller that cannot say what bound it wants must answer rather than be given a generous one
— and `check (turn_cap > 0)` refuses zero. `token_sha256` is the SHA-256 of the token in
PostgREST's `\x…` hex form, never the token; `web_sessions_token_key` is unique across
**all** tenants, because the lookup has no tenant to scope by. Two further CHECKs will
refuse a hand-written row: `expires_at > issued_at`, and `turns <= turn_cap`.

**`web_rate_counters`** — `(tenant_id, bucket_key, window_start)` is the primary key, and
`window_start` is floored by the caller. Do not insert into it directly; use the function
below, because read-then-write lets two concurrent requests both pass.

**`public.bump_web_rate(p_tenant_id uuid, p_bucket_key text, p_window_start timestamptz)`**
→ `integer` — upserts and returns the count *after* this request, in one statement. In
`public` and not `app`, for D-029's reason: the clients carry no `db: { schema }` option.

`ops.purge_expired` gains clauses (d) and (e), deleting sessions one day past expiry and
rate windows one day past close, and its returned jsonb gains `sessions_purged` and
`counters_purged`. The one-day lag on sessions is not a retention preference: it keeps a
just-expired token resolvable long enough to say "your session ended" rather than missing,
which is indistinguishable from a forged token.

### `0032_web_mint_secret_kind`

`tenant_secrets.kind` gains **`web_mint_secret`** — the tenant server's HMAC key for the
website channel's session mint (D-086). Widening a CHECK, so every existing row still
satisfies it and nothing is dropped, rewritten or narrowed.

It is per-tenant data and therefore sealed under the KEK like `page_token`, not an
environment variable: `META_APP_SECRETS` is an env map because a Meta app secret belongs to
the app, which is ours, and a mint secret belongs to the client. Keyed on `channel_key` as
well as `tenant_id`, so a tenant running two widgets can rotate one without the other going
dark.

**Nothing reads this value yet** — the mint route is not built. It exists so that sealing
the secret (a founder step) can start in parallel. Do not cite its presence as evidence the
channel works.

### `0033_thread_control_passed`

`conversations.thread_control_source` gains **`passed`**, and `canned_response_kinds` gains
**`handover_notice`** and **`handover_reclaim`**. Widening a CHECK and adding two lookup
rows, so nothing existing is dropped, rewritten or narrowed.

`passed` is the discriminator `docs/handover.md` names as the one thing blocking the reclaim
sweeper. `handover` is written whenever **Meta** names a new owner — which happens both when
this platform passes a thread and when a receptionist takes one through Business Suite. One
value, two facts, and the sweeper's safety turns on telling them apart: the reclaim window
is 15 minutes and `human_takeover_cooldown_minutes` is 30, so reclaiming any `human` thread
would take it back off a person still inside the cooldown and make that cooldown unreachable.

**No row is retyped and no default is applied.** D-063's addendum is the reason: `0025`
added a discriminator with a default, and the default retroactively decided the semantics of
the ten rows recording an eleven-day outage — the exact rows the change was built for. Here
the conservative reading costs nothing. A thread whose source says `handover` is one we
cannot prove we passed, so it is not ours to reclaim; `passed` starts empty and fills only
from the pass path.

The two kinds are **registered with no row inserted**, and that order is a constraint rather
than tidiness. Both must be in `MODEL_INVISIBLE_KINDS` and deployed before any tenant has a
row, or `cannedSectionBody` sweeps the sentence into the cached prefix, moves `canned_hash`
on the publish side only, and 503s every DM reply for that tenant with `canned_stale` until
a republish — D-082's outage with a different sentence in it. The code half ships with the
migration; the sentences are unsigned in `prompt/drafts/handover_notice_and_reclaim.mn.txt`
and wait for the founder.

### `0034_refusal_suitability`

`canned_response_kinds` gains **`refusal_suitability`**. One lookup row; nothing is dropped,
rewritten or narrowed, and no tenant row is inserted by the migration.

It exists because "will this work on MY hair" is a question the platform must never answer.
A live customer asked on 2026-09-20 whether office colour takes on black-dyed hair; all
seven of Matrix's knowledge documents were read and **none says**. Two adjacent true rows do
exist — office colour is a technique involving «30 хувийн цайруулалт», and black-dyed hair
«хоёр удаагийн будалтаар бор өнгөтэй болгож болно» — and the model bridged them into three
different answers in 26 seconds, one of them carrying the real bleach figure.

**Ш8 structurally cannot catch that.** It refuses what is not in the knowledge base, and
here the parts are in it; only the join is invented. Writing INSERTs by hand against this
kind: the sentence is founder-approved Mongolian and belongs in `canned_responses` with
`reviewed_at` set, pointed at by `out_of_scope_topics` rows whose matchers are
`stem_sequence` — never `contains_stem`, because «болох», «үсэнд» and «тохирох» all appear
in ordinary PRICE questions («хэд болох вэ» is *how much will it be*) and a single-stem
matcher refuses those too. Measured: five real suitability questions caught, zero false
positives across seventeen price, booking, location and greeting messages.

### `0035_secret_expiry`

`tenant_secrets` gains **`expires_at`** and **`data_access_expires_at`**, both
`timestamptz` and both **nullable**. Nothing is dropped, rewritten or narrowed, and no row
is inserted by the migration. Writing INSERTs by hand: neither column is required, and
`scripts/kek/seal.ts` fills them from `--expires-at` / `--data-access-expires-at` when you
pass them.

**NULL means "not known", never "never".** Every row written before this reads NULL, and
`health/secretExpiry.ts` counts those as UNKNOWN rather than clean — a checker that reports
zero problems while knowing nothing is the shape D-070 is named for.

**Two columns because Meta runs two clocks.** `expires_at` is when the token stops
authenticating; a Page token minted from a long-lived user token reports `expires_at: 0`
from `debug_token`, meaning never, and that is stored as NULL. `data_access_expires_at` is
when data stops flowing to a token that still authenticates — about ninety days after the
last authorization. A credential can be "never expires" and still go dark on the second
clock, so recording only the first reproduces the same surprise on a longer fuse.

It exists because Matrix went live on 2026-09-21 on a short-lived Explorer token that
sealed cleanly, opened cleanly through the runtime loader, and died forty minutes later as
a `401 code=190 subcode=463` at send time, tripping the credential breaker (D-109). Nothing
could have warned: `unusableBecause` rejects an empty secret, control characters and stray
whitespace, and that is the whole test a credential passes.

**Warn only.** Nothing in the platform may renew or re-authorize from these columns
(founder, 2026-09-21).

### `0036_prompt_blocks_seed`

**No DDL at all.** It rewrites the `prompt_blocks` rows from the twenty-two signed files in
`prompt/platform/*.mn.txt`. Nothing is dropped, added or narrowed; writing INSERTs by hand
is unaffected.

**It is GENERATED, never edited.** `node scripts/prompt/generate-seed.ts` writes it and
`--check` fails when it is stale, because a hand-copied seed is a second copy of the
platform's Mongolian and the second copy is what drifts (D-020). Two tests enforce it:
*"the NEWEST seed migration is exactly what the signed files produce"* and *"every signed
platform file reaches the migration, and nothing else does"*. Both went red the moment
`02_style` was re-signed and before this file existed, which is the mechanism working.

**What changed in it:** `02_style` only, on the founder's approval of style item (4),
2026-09-21. Rule (4) now says that a service with THREE or fewer price options is answered
with each option on **its own short line with its price**, and FOUR or more still gets one
short clarifying question. Rule (3) had to move with it: it previously forbade
«Жагсаалт» — lists — outright, which the new (4) would have contradicted, so it now forbids
the MARKERS (`**`, `#`, `•`, a line-initial `-`, HTML) and says in as many words that
breaking lines is allowed. Leaving both as they were would have been two rules with nothing
ordering them, which is exactly the Ш2/Ш8 collision D-065 measured.

**Pushing it changes no reply on its own.** The compiled prefix is what a tenant is
answered from, so every tenant must be republished afterwards — deploy, `git pull`,
publish, in that order (D-074). Expect every `content_hash` to move and every
`allowed_numbers` to stay put; if a tenant's numbers move, something other than this
changed too.

### `0037_out_of_scope_quote_price`

**Additive, one column, default `false`.** `out_of_scope_topics.quote_price boolean not
null default false` — which is exactly the value `reception/load.ts` already substituted
for the absent column, so **no tenant's behaviour changes and no reply moves by one byte**.
What changes is that a tenant can now say otherwise.

**Why.** Measured on 2026-09-21, turn 14 of Matrix's first real side-by-side. The customer
asked «dund zergiin usend shuluun himi hedeer hiih ve»; the model answered «Шулуун хими
430,000₮–510,000₮ байна.», which is the `Шулуун хими` row to the tögrög and is what the
ancestor sent. `suitability_lat_himi` — `stem_sequence ["usend","himi"]`, 40 codepoints —
fired on "…usend shuluun himi hedeer…", `quotePrice: false` set `refusedTopicBlocksPrice`,
the guard was handed an EMPTY allow-list, and the correct answer was thrown away for the
generic handoff.

**The distinction the column expresses.** The blanket `false` is justified in
`guard/outbound.ts` by **Ш1's** rule — on a refused topic, mention no number at all,
because a customer who writes «Хүүхдийн үс 33,000₮ мөн үү?» has supplied the number that
would make an echo read as confirmation. That reasoning is sound and is kept. But it is
reasoning about Ш1, and `refusal_suitability` is **absent from `GATE_BY_RESPONSE_KIND`**,
so it falls to `DEFAULT_GATE = 'Ш8'` — *"not in the knowledge base"* — for a service that
IS in the knowledge base with a confirmed price. A rule written for one gate was being
applied under a gate whose own rule does not ask for it, for want of a column.

- **A refusal for want of a FACT** — `photo_consultation`. We cannot see the picture, so we
  cannot know which service it is, so we must not price it. Stays `false`.
- **A refusal for want of a JUDGEMENT** — `suitability_*`. The service is named and priced;
  only whether it suits this person is unknowable. Refusing the judgement does not require
  refusing the price.

**Which rows should flip it is NOT decided here.** A price beside "I can't say whether it
suits you" can read as an endorsement that no guard can see, so the switch is the founder's.
D-063's addendum is why the default is the conservative one: a backfill default
retroactively decides the semantics of every row already there, and those rows are exactly
the ones that motivated the change.

**Merge order matters (D-058).** The same PR adds `quote_price` to the `out_of_scope_topics`
`.select()` in `reception/load.ts`. Against a project where this migration has not been
pushed, PostgREST answers that select with a 400 and **every reply for every tenant 503s**.
CI cannot see it — CI applies every migration in `supabase/migrations/` before it runs. Read
`supabase_migrations.schema_migrations` and merge only after the push.

### `0038_prompt_blocks_seed`

**No DDL.** Regenerated by `node scripts/prompt/generate-seed.ts` from the signed files —
never hand-edited, and `--check` fails when it is stale (D-020). Twenty-three blocks now;
`0036` carried twenty-two.

**What changed:** three blocks, all signed by the founder on 2026-09-21 after reading the
drafts and the replies they produced.

- **`00_gate_preamble`** — rule (2) may now prepend information the firing check itself
  requires (Ш3's deposit) and may answer a second question the canned line does not cover;
  rule (3) replaces *"two or more checks → write the generic handoff"* with a precedence:
  Ш8 never outranks a specific check, safety/scope checks (Ш0, Ш1, Ш5, Ш7) outrank
  informational ones (Ш2, Ш3, Ш4, Ш6), and `handoff` is written only when nothing more
  specific applies. The old rule is why «tsag zahialah» got the generic line while its
  Cyrillic form did not — the Cyrillic also asked for the phone, which IS in the KB, so Ш8
  never fired.
- **`02_style`** — rule (4) gains "this is not a suggestion" and two wrong-examples in the
  shape the other blocks use, because compliance was measured at roughly half.
- **`sh11_completeness`** — NEW, ordinal 111. The first block that says what the model MUST
  say rather than what it must not: give the price when the list has it; list treatments
  before suggesting a stylist; name a service exactly as the list writes it; answer every
  part of a multi-part question; ask a clarifying question only when genuinely ambiguous;
  a clarification never replaces the prices.

**Pushing it changes no reply on its own** — the compiled prefix is what a tenant is
answered from, so every tenant needs republishing afterwards (deploy, `git pull`, publish).

### `0050_channel_automation_texts`

**Additive.** `tenant_channels.automation_texts text[] not null default '{}'`: the exact texts
of the Page's own Meta automations (instant reply, comment-to-message, auto comment reply). An
echo or a Page comment whose text is one of them (NFC, whitespace collapsed, case folded) is
not a person: it neither hands the thread to a human nor counts as staff answering a comment.
Measured 2026-09-26: Meta's automated DM carries the same app id as a staff reply typed in the
Page inbox, so the text is the only thing that separates them (D-126 addendum).

### `0051_sales_playbooks`

**Additive.** Three tables for the sales next-step SHADOW (D-127). Nothing existing is
touched, no tenant row is inserted, and **the reply path does not read them** — only
`sales/shadow.ts` does, after a reply is drafted, in its own best-effort queries. So pushing
late cannot fail a reply: before the push the shadow logs `sales_shadow_unusable` and records
nothing. Numbered 0051 because 0050 is taken by parallel work.

| Table | Key | Notes for hand-written INSERTs |
|---|---|---|
| `sales_playbooks` | `tenant_id` | `mode` is `off` (default) or `shadow` — **there is no live value**, so nothing can be switched to sending by an UPDATE. `lead_route` NOT NULL: `founder_telegram` / `tenant_telegram` / `page_label` / `none` (since `0053`) (recorded on each shadow lead; nothing sends to it) |
| `sales_next_steps` | `(tenant_id, kind)` | `kind` ∈ `demo`/`booking`/`callback`/`related_service`/`lead_thanks`. `body` (NFC) is **NULL until the founder chooses the words**, and `reviewed_at` requires a body. `related_service`'s body must carry `{related}`. `link` is an `https://` URL or NULL. `priority` (lower wins), `is_default` (at most one per tenant, and only `demo`/`booking`/`callback`), `intent_matcher` jsonb — one gate matcher or an array of them, any firing counts |
| `service_pairings` | `(tenant_id, service_name, related_name)` | Both names as the compiled price list writes them, not equal. **`provenance` NOT NULL with no default**: the platform's proposals are `seeded`; only the salon's yes is `tenant_confirmed` |

Not `canned_responses`, on purpose: a reviewed row there is compiled into the cached prefix
(D-058) and hashed into `canned_hash`, so a next-step row would be a sentence in the model's
context with no instruction attached (D-082) and would 503 every reply as `canned_stale`
until a republish.

The shadow writes `quality_flags` rows only: `sales_next_step_shadow` (one per drafted
reply; `detail` = verdict, kind or skip reason, row state, optional related pair, outbound
id) and `sales_lead_shadow` (when the customer's message carries a phone; `detail` holds the
number MASKED, «7600****», never digits). `scripts/provision/sales-playbook.ts <slug>
--template salon|software` prints the SQL that switches a tenant's shadow on; it never
writes a body or `reviewed_at`.


### `0053_sales_lead_route_none`

**Additive.** `sales_playbooks.lead_route` also admits `none`: a tenant that takes no leads
because its staff do not call customers back (Tara, 2026-09-26). A number a customer types
anyway is still detected and masked by the shadow; only the routing claim is `none`.


### `0054_sales_live`

**Additive.** The sales line goes live per tenant, as a row (D-132):
- `sales_playbooks.mode` admits `live`;
- `sales_playbooks.small_talk text[] not null default '{}'` holds whole messages that are only a
  greeting or a thanks, and a message matched whole by one gets no sales line;
- `sales_next_steps.kind` admits `follow_up`, the default line after an answer, and it may be
  the tenant's default step.

### `0052_demo_url_contact_kind`

**Widens two CHECKs.** `contact_points.kind` and `branch_contact_points.kind` gain `demo_url`: a
software tenant's demo page, offered the way a salon's booking page is. `contact_points` is
keyed `(tenant_id, kind)`, so a tenant whose `website` row holds its homepage had nowhere to
put a second link. `demo_url` is in `URL_CONTACT_KINDS`, so the outbound guard allows the link
when the model quotes it, and the prefix labels it «Демо захиалгын холбоос» (`CONTACT_KIND_LABELS`,
founder-gated like every label there; it reaches a customer only through a republish). Every
existing row satisfies the new constraints.

### `0049_matcher_rows_can_match`

**Widens a CHECK.** `enabled_rule_can_match` required an enabled `deterministic_replies` row to
carry stems; a `matcher` row carries a matcher instead, and the old CHECK refused the first
real one. It now accepts either. Every row that passed before passes now (D-126).

### `0048_deterministic_matcher`

**Additive.** `deterministic_replies.matcher jsonb` (nullable), `match_mode` may now be
`matcher`, and a CHECK that `matcher` is set exactly when `match_mode = 'matcher'` (true for
every existing row). The row fires when the gate's own matcher fires (`gate/match.ts`), which
is what lets a row require two words together — *tomorrow* AND *working* (D-126). A matcher
that does not parse never fires.

A body may carry `{tomorrow.day}` and `{tomorrow.hours}`. They are filled per request from
`business_hours` on the tenant's clock; when tomorrow has no hours, is closed, falls in a
`tenant_closures` range, or the tenant lists two or more branches, the row does not answer.

For hand-written INSERTs: `match_mode = 'matcher'` with a `matcher` object and `stems = '{}'`;
`provenance` must be `tenant_confirmed` for the row to be served.

### `0047_branches`

**Additive.** Four tables and one `canned_response_kinds` row, for a tenant with more than
one location (D-125). Nothing existing is dropped, rewritten, narrowed or re-keyed, and no
tenant row is inserted. Numbered 0047 because 0045/0046 may be taken by parallel work.

`contact_points` is keyed `(tenant_id, kind)`, so a tenant could hold one address and one
map link; admitting a second would mean replacing a live primary key. These tables hold
only what DIFFERS by branch, and every existing row keeps meaning the tenant-wide fact.

| Table | Key | Notes for hand-written INSERTs |
|---|---|---|
| `tenant_branches` | `id`; unique `(tenant_id, name)` | `name` (NFC, no line break, no `===` — it becomes a prefix heading), `stems text[]` (how customers write it, either script; default `{}`), `ordinal` (default 0), `active` (default true). **`provenance` NOT NULL with NO DEFAULT**, as `0011`'s five tables: only `tenant_confirmed` branches are compiled |
| `branch_contact_points` | `(tenant_id, branch_id, kind)` | Same `kind` vocabulary as `contact_points`. `value` NFC, non-empty. Overrides the tenant-wide row of that kind for this branch |
| `branch_hours` | `(tenant_id, branch_id, weekday)` | As `business_hours` (`weekday` is Postgres `dow`, 0 = Sunday; `closed` or both times). Overrides that weekday for this branch |
| `branch_variant_prices` | `(tenant_id, branch_id, variant_id)` | `variant_id` → `service_variants(tenant_id, id)`. `price_kind` is `exact`/`range`/`from`/`on_inspection` with `service_variants`' own number CHECKs; `none` is not allowed. **`confirmed_at` null means the price is unknown**: the service is shown for that branch with NO figure, never at the tenant-wide price |

Children reference `(tenant_id, branch_id)` — the composite spine (V14). All four are
client-readable config like `contact_points`: RLS enabled and forced, the three restrictive
`_no_client_*` write policies, a dormant `_member_read`, SELECT for `authenticated`, nothing
for `anon`, all for `service_role` (V2, V3, V5, V6, V15–V17, V35 all pass locally).

**Nothing changes until a tenant has TWO active, confirmed branches.** With zero or one,
`planBranches` returns null and the compiled prefix is byte-for-byte what it was — measured
against hashes recorded from the pre-change code (`branches.test.ts`). With two or more, the
tenant-wide contacts, hours and price list keep only what every branch shares, and each
branch gets `=== ХОЛБОО БАРИХ — {name} ===`, `=== БАЙГУУЛЛАГЫН АЖЛЫН ЦАГ — {name} ===` and
`=== ҮНИЙН ЖАГСААЛТ — {name} ===` for what differs, after a `=== САЛБАРУУД ===` list.

`clarify_branch` is the canned kind served when a reply states one branch's facts to a
customer who has not said which branch. It is registered with **no row**, it is in
`MODEL_INVISIBLE_KINDS` (so a row cannot move `canned_hash`), and until the founder approves
a sentence (`prompt/drafts/branch_clarify.mn.txt`) the reply path serves the handoff line.

**Deploy order.** The publish path (`loadTenantKb`) reads these tables, so a publish before
the push refuses with `tenant_branches unreadable` and writes nothing. The reply path reads
them only when the live snapshot lists branches, so deploying the code before the push
cannot 503 a live tenant.
### `0046_tenant_former_names`

**Additive.** `tenants.former_names text[] not null default '{}'` — names the business no
longer uses. The morning flaw report flags a sent reply that uses one (links masked first, so
the salon's own website address is not a hit). D-123.

### `0045_comment_delivery_mode`

**Additive, plus one CHECK widened.** Comments get their own switch (D-122).

- **`tenant_channels.comment_delivery_mode`** — `off` / `shadow` / `live`, default `off`,
  independent of `delivery_mode` (DMs). `shadow` drafts every public reply and private
  message and sends none; `live` sends only while `token_status = 'active'` (checked in
  `channel/delivery.ts`'s `canDeliverComments`). `comment_policy` still says WHAT is sent:
  `public_only`, `private_only` or `both`. The comment job runs only when the policy is not
  `none` AND this is not `off`.
- **`outbound_messages.comment_from_id`** — the commenter a `comment_reply` or
  `private_reply` answers; "one reply per person per post" is counted from it. A CHECK keeps it
  null on every other kind, and `comment_post_id_only_on_comment_replies` is widened to allow
  `private_reply` as well (no existing row can fail the wider check).
- **`canned_response_kinds`** gains `comment_private_reply`, which is in
  `MODEL_INVISIBLE_KINDS`: its row never enters the compiled prefix and never moves
  `canned_hash`. **Deploy the code that lists it BEFORE inserting the row** — the other order
  moves the request-side hash and 503s every DM reply until a republish.

A private reply's `dedup_key` is `pr:{post_id}:{from_id}`, so the unique index
`outbound_messages_dedup` enforces one private message per person per post.

### `0044_flaw_loop`

**Additive.** Two tables and two functions, for the flaw loop (D-120).

- **`reply_cases`** — a reply the founder marked wrong, kept as a permanent test: the
  customer's message, the ten turns before it, and the right answer (`expected_body`, or
  `must_include` / `must_not_include` for an answer the model words; at least one is
  required). `scripts/replycases/gate.ts` replays every `active` case before a publish and in
  the production build, and either one stops on a failing case. Nothing deletes a case;
  `active = false` is a person's decision.
- **`spellings`** — Latin spellings customers use for the tenant's Mongolian words, grown
  every morning from real messages. `settled` (the tenant's data allows one word) and
  `confirmed` (the founder's) are applied to matching; `ask` goes to the founder in the
  morning report; `rejected` is a no. `latin` is one word, or two when only the neighbour
  settles it.
- **`mark_reply_wrong(ref, expected, note)`** — `ref` is the id prefix the morning report
  prints; it copies the customer's message and history into a new case and returns its id.
- **`set_spelling(slug, latin, cyrillic)`** — a word confirms the spelling, null rejects it.

Server-owned like `comment_rules`: RLS forced, restrictive no-client write policies,
`ops.tenant_scope` and `ops.table_security_class` rows, nothing for `anon` or
`authenticated`, all for `service_role`. Both functions are `security definer` with a pinned
`search_path` and executable by `service_role` only.

### `0043_on_correction_replies`

**Additive.** `deterministic_match_mode_known` gains `on_correction`. Such a row never
answers a message. Its `stems` are the tenant's correction words, and its `body` is sent in
place of a reply that repeats the previous one on a turn carrying one of those words.
"Repeats" means the same text once folded, or exactly the same prices. Every draft path goes
through the check, so no path can answer a correction with the answer it corrects. D-119.

### `0042_on_topic_replies`

**Additive.** `deterministic_match_mode_known` gains `on_topic`: `stems` then holds gate
`topic_key`s, and the row fires when one of those topics fired on the message. Used with
`placement = 'append'` to add a line after the answer to a question the gate classified —
Matrix's «Үсэнд тань аль нь тохирохыг мастер үсчин зөвлөж өгнө.» after a suitability
question. An `on_topic` append is not added to a reviewed refusal line, which already says
it. D-117.

### `0041_reply_composition`

**Additive.** Three columns on `deterministic_replies`, one on `out_of_scope_topics`, and
`deterministic_match_mode_known` widened by one value. Every default is today's behaviour.

| Column | Default | Means |
|---|---|---|
| `deterministic_replies.placement` | `'replace'` | `append`: the reply is produced as normal and `body` is added at the END. Never in place of the answer. |
| `deterministic_replies.cover_words` | `'{}'` | For `match_mode = 'covers_message'`: whole words that may accompany a stem. The row fires only when EVERY word of the message is a stem hit or one of these. |
| `deterministic_replies.quote_services` | `'{}'` | Price-list service names. The reply is their rows, verbatim from the compiled price list, in this order, then `body`. A name the list does not carry: the row does not fire. |
| `out_of_scope_topics.grounded_only` | `false` | When the rule fires, a reply the tenant's data does not support is replaced by the rule's refusal line. |

Measured on Matrix, 2026-09-24: the Tara line replaced the answer to «Хаана байрладаг вэ?»
(placement); «Үс будуулахад хэд вэ?» leaked a gate label and got the generic handoff
(quote_services); a suitability question got hair advice no row contains (grounded_only).
D-116 has the rest.

### `0040_prompt_blocks_seed`

**No DDL.** Regenerated by `node scripts/prompt/generate-seed.ts`. Still twenty-three
blocks; exactly one BODY changed, `00_gate_preamble` (`90a759d8` → `d415571b`).

**What changed:** one paragraph, signed by the founder on 2026-09-21 after it was measured
against the block it replaces.

> ЭДГЭЭР ШАЛГАЛТ БОЛ ДОТООД ЗААВАР. Шалгалтын нэр, дугаар (Ш0, Ш2а, Ш11 гэх мэт), дэд
> дүрмийн дугаар (11д, 3а гэх мэт), «БЭЛЭН ХАРИУЛТ»-ын мөрийн түлхүүр (booking_line,
> handoff гэх мэт) — эдгээрийн АЛЬ НЬ Ч хариултад гарч болохгүй.

**Why, and the number that justifies it.** `0038` signed `sh11_completeness` and a new
rule (3), both written as NUMBERED PROCEDURES — and a procedure in the prompt is something
the model narrates back. Measured over 96 replies per arm, same 48 cases, twice:

| | `0038` as seeded | with this paragraph |
|---|---|---|
| `outbound_gate_label` | **6 (6.2%)** | **0** |
| reply discarded, generic handoff served | **11 (11.5%)** | **5 (5.2%)** |

Every one of those six is a customer who got the generic handoff because the reply opened
«Ш0 шалгав — энэ хувийн зурвас тул хязгаарлалт хамаарахгүй. Ш1, Ш5, Ш6, Ш9 хамаарахгүй…».
The guard caught them all, which is why nothing reached a customer — but a caught leak
still costs the answer.

Ш9 does not cover this and widening it would have been the wrong repair: Ш9 is scoped to
the customer ASKING about the instructions, and says nothing about volunteering a label
unprompted. Note the third leaked item in the measured set — `booking_line` is a canned-row
KEY, not a gate number, so a rule naming only «Ш\d» would have missed it. The paragraph
names all three shapes.

**Pushing it changes no reply on its own** — the compiled prefix is what a tenant is
answered from, so every tenant needs republishing afterwards (deploy, `git pull`, publish).

### `0039_service_discontinued_kind`

**Additive, one row in `canned_response_kinds`:** `refusal_service_unavailable`.

A service the business does not offer AT ALL, as distinct from `refusal_price_unlisted`
("we do it, the price is not in my knowledge base"). Matrix stopped doing nails on
2026-09-21; with the eleven `Маникюр`/`Педикюр` services deactivated, «Маникюр хэд вэ?»
fell to `refusal_price_unlisted`, which is true about the price and **wrong about the
salon** — it implies the service exists, so the customer rings up to book something that
is gone.

Deliberately NOT mapped in `GATE_BY_RESPONSE_KIND`, so it falls to `DEFAULT_GATE` (Ш8).
That is right here: Ш8's forbidden vocabulary is hedging («магадгүй», «ихэвчлэн»), which
is exactly what must not appear beside "we no longer offer this".

The sentence itself is a tenant `canned_responses` row and is founder-gated. A tenant that
has not written one is unaffected: the path refuses an unreviewed row.
