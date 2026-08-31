# Schema

**This document and `supabase/migrations/0001_initial_schema.sql` are the schema.**
Where a file under `docs/architecture/` disagrees with either, that file is stale — its
DDL was a proposal, and [`09-reconciliation.md`](architecture/09-reconciliation.md)
arbitrated the twenty-three places the proposals contradicted each other.

79 tables in `public`, 11 functions across `app` and `ops`.

## Status: applied and verified locally, never applied to a real project

Built against PostgreSQL 16.13 and verified by **execution**, not by reading:

| | |
|---|---|
| `supabase/migrations/0001_initial_schema.sql` | applies clean on an empty database |
| `scripts/verify/catalog.sql` | **15/15 PASS** — and it raises, so CI fails on red |
| `scripts/verify/isolation.sql` | **10/10 PASS** — behavioural, not structural |
| `supabase/migrations/0002_knowledge_embeddings.sql` | **not validated** — pgvector is not installed locally. P2; applied when retrieval is switched on |

No Supabase project exists yet, so none of this has run against one. Supabase is on
PG17, where Postgres grants an eighth privilege (`MAINTAIN`); the ACL checks read
`aclexplode` and so cover it without change, but that is reasoning, not a test.

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

## Two things the migration does that reading it would not reveal

**The ops metadata must be populated before the policy loops.** §10 and §11 are driven
from `ops.tenant_scope`. On the first run the seed came *after* them, so both loops ran,
succeeded, and created **zero policies and zero grants** — silently. That is the exact
failure this schema is built to prevent, it survived being written carefully, and it was
caught only by running the file and counting rows. Section 9.5 now precedes them.

**Three foreign keys were off the spine.** `disambiguation_candidates`,
`spend_ledger.reservation_id` and `spend_reservations.webhook_event_id` referenced bare
parent ids. V14 found them; all three are now composite.

## Verifying

```bash
# throwaway cluster; never point this at production
scripts/localvalidate/run.sh
psql -d dala_validate -f scripts/verify/catalog.sql     # raises on failure
psql -d dala_validate -f scripts/verify/isolation.sql   # raises on failure
```

`scripts/localvalidate/shim.sql` recreates just enough of Supabase's `auth` schema and
roles for `0001` to run offline. **It is never applied to a real project.**

Run `catalog.sql` after every migration touching grants, policies, triggers or seeds,
and check each table independently — the last failure of this kind next door was
partial, one of four tables.

## What is deliberately not here

- **Embeddings** — `0002`, applied when retrieval is switched on per tenant.
- **A tenant-owner login** — the policies exist and are dormant (item 12).
- **Any SMS transport** — `channel_providers.sms` is seeded `enabled = false` and
  `outbound_policies.sms.per_message_cost_nanousd` is `NULL`, which **refuses**. An
  unknown price does not default to zero.
- **`voice` anywhere** — not a provider row, not a role state a code path executes.
- **Billing** — there is still no revenue path. The platform can spend and cannot
  collect (`10-completeness.md` #6).
