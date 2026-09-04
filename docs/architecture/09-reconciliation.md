# Cross-section reconciliation — the arbitration that makes this buildable

The eight sections were designed independently and **invented incompatible versions of
the same tables**. This file is the single arbitration: 23 contradictions, one
recommended answer each, plus the canonical table list and environment-variable list.

**Read this before writing migration `0001`.** Where a section file and this file
disagree, this file wins — that is the whole point of it existing.

---

# Cross-section consistency review — Dala AI

Twenty-three contradictions, ranked by blast radius. Every one has a single recommended answer. Canonical table list and env-var list at the end.

---

## The ranked contradictions

---

### 1. Three incompatible knowledge-base schemas, plus a fourth naming in the checklist
**Sections 1, 2, 4, 8.**

- §1: `services` + `price_axes` + `service_variants` (two-dimensional, `price_kind` enum), `disclosure_rules`, `out_of_scope_topics`, `canned_responses` keyed to `canned_response_kinds`.
- §2: `service_items` (flat, one `tier_key`, `quotable boolean`), `service_tiers`, `refusal_rules`, `knowledge_documents`/`knowledge_chunks`.
- §4: an entirely parallel `kb_*` namespace — `kb_service` (`price_basis`), `kb_staff_tier`, `kb_refusal_topic`, `kb_canned_response`, `kb_closure`, `kb_faq`, `kb_note`, `kb_snapshot`, `kb_revision`, `kb_change`, `kb_proposal`, `ai_call_ledger`.
- §8 step 3: `services` + `service_prices` (a third pricing shape), plus `config_keys`, `prompt_blocks`, `prompt_examples`, `deposit_rules` that exist in no other section.

Nothing joins. §1's `config_change_proposals.target_table` check literally enumerates `('services','service_variants','staff',…)` — table names that do not exist in §2, which is the schema-of-record section.

**Resolution.** One namespace, no `kb_` prefix. Take **§1's pricing model** (`price_axes` + `services` + `service_variants` + `price_kind`), because §1 proves Matrix already carries *two* axes hidden inside `"Эмэгтэй тайралт (Мастер)"` and §2's single `tier_key` reproduces the flattening one level down. Take **§2's names for everything else** (`staff_members`, `canned_responses`, `service_aliases`, `disambiguation_pairs`, `knowledge_documents`/`knowledge_chunks`). Take **§1's two-table refusal split** (`disclosure_rules` = know-and-won't-say, founder-approved; `out_of_scope_topics` = can't know, platform defaults) — GS Auto's top inbound message is «Машин маань бэлэн болсон уу?», which is neither. Take **§8's prompt tables wholesale** (`prompt_blocks` with `scope ∈ platform|tenant`, `prompt_examples`, `deposit_rules`, `config_keys`) — §8 is the only section that noticed half the ancestor's prompt is Matrix policy in a template literal, and without it GS Auto's prompt contains a deposit table and three haircut examples. Delete `kb_service`, `kb_staff*`, `kb_faq`, `kb_canned_response`, `kb_closure`, `kb_policy`, `kb_clarifier`, `kb_disambiguation`, `kb_note`, `ai_call_ledger`, `service_prices`, `service_tiers`.
*Reason: one pricing model that survives GS Auto without a branch, and one set of names the checklist can actually provision.*

---

### 2. The unit economics do not close — and §5 contradicts itself before it contradicts §6
**Sections 5, 6.**

§5 sets the tenant monthly ceiling at **$25** and derives it from the margin formula (₮250,000 × 0.30 ÷ 3,500 = $21.43). §6 computes the design-point Reception cost at **$48.84/month (₮175,800)** for a 750-conversation tenant on Sonnet 5.

§5 is also internally inconsistent: its assumption table (§5.3.2 A7/A8) says 6 messages × 750 conversations = **4,500 replies/month**, while §5.6 derives the $25 ceiling from "300–600 conversations × ~5 replies = 1,500–3,000 replies". The ceiling is computed on the low volume; every other number uses the high one.

Three further disagreements feed into it:
- **Prefix size.** §5 plans on P = 7,000 tokens; §6 measures the L0 block alone at 9,441 characters and argues P = 9,000 (range 8,000–11,500), *explicitly rejecting* the 2.0 chars/token density that produces §5's figure as "the only density in the plausible range that keeps Haiku below the cliff".
- **Cache write multiplier.** §5's price table seeds 1.25× and its own reservation formula (§5.3.7) uses `P × 2.0 × price_in`. §6 verifies 1.25× is the 5-minute rate and **2× is the 1-hour rate** — and Matrix runs 1h.
- **Model.** §6 leaves Sonnet-vs-Haiku open pending bake-off arm E. §5 prices everything on Sonnet.

Recomputed on one consistent basis (P = 9,000, V = 600, O = 250, 1h TTL, h = 0.83, ₮3,500/$):

| | $/reply | 4,500 replies/mo | ₮/mo | Gross margin @ ₮250,000 |
|---|---:|---:|---:|---:|
| Sonnet 5 | $0.0113 | $50.85 | ₮178,000 | **29%** |
| Haiku 4.5 | $0.0057 | $25.46 | ₮89,100 | **64%** |

Conversations supported at the $21.43 margin-floor ceiling: **316/month on Sonnet, 631/month on Haiku.**

**Resolution.** Three decisions, in this order, and **§8's Phase F step 31 must not set a budget until all three are done**:
1. Run **`messages.count_tokens`** on the rendered Matrix prompt (free) and pull one production `usage` line from the ancestor's existing log (`salonBrain.js:249-253`). Replace P with a fact. Adopt **9,000** as the planning figure until then, not 7,000.
2. Run **§6's bake-off arm D vs arm E** before setting any ceiling. **The $25 ceiling and the ₮250,000 price close on Haiku and do not close on Sonnet.** If arm E ties, Reception ships on Haiku 4.5 and the plan works; if it does not, either the ceiling is $50 or the plan price is ₮400,000+ — that is a pricing decision, not an engineering one.
3. Pin the cache-write multiplier at **2× for 1h, 1.25× for 5m** everywhere, and re-seed `model_prices` accordingly. §5's price-table seed is wrong for the TTL Dala AI actually uses.

*Reason: at 750 conversations on Sonnet the flagship tenant is a 29%-margin loss-maker against a ceiling that stops the bot mid-Saturday; the model choice is the pricing decision, and it is currently unmade in one section and assumed in another.*

> **Resolved and partly refuted, 2026-09-01.** The model choice was made by measurement (D-009: Sonnet 5). The *750 conversations* premise of this reasoning was then measured and refuted — Matrix runs at ~41% of it, giving a **71% margin, not 29%** (D-016). The reasoning was sound; its volume input was a guess. The ceiling question is settled by the D-015 band, and at the ceiling the bot degrades to shortcuts plus a handoff line (§5.7), never silence.

---

### 3. Two complete, incompatible spend-ceiling mechanisms
**Sections 2, 5** (with §1, §7, §8 each adding a third shape of the budget row).

- §2: `usage_counters(tenant_id, metric, window_kind, window_start, value)` + `app.reserve_usage(...)` — one conditional insert, `numeric` USD, `spend_budgets(scope, limit_usd, on_exhausted)`.
- §5: `app.spend_counters(scope, scope_key, period_kind, period_key, ceiling_nanousd, reserved, settled, count_used)` + `app.spend_reservations` (per-attempt, with a `provider_call_started_at` CAS gate) + `app.spend_ledger` in **bigint nano-USD**, + `app.tenant_budgets` append-only versioned.
- §1: "Budgets are a row per tenant (`monthly_usd_ceiling`, `daily_usd_ceiling`, `per_message_usd_cap`, `alert_at_pct`)."
- §7: `tenant_roles.monthly_budget_usd`.
- §8: `tenant_budgets(monthly_ceiling_usd, alert_threshold_pct, on_exhausted, effective_from)`.

And four different enums for the same field: `on_exhausted ∈ ('hard_stop','canned_reply','overage_bill')` (§2) / `on_exhaustion ∈ ('canned_handoff','silent','notify_only')` (§5) / `budget_exhausted_policy ∈ ('silent','canned','continue')` (§1) / `('stop','canned','overage')` (§8).

**Resolution.** **§5 wins wholesale** — it is the only version with a reservation, a CAS gate, an attempt counter, and a settlement path, and it is the only one that survives forty concurrent inbound events. Adopt `tenant_budgets` (append-only, versioned), `spend_counters`, `spend_reservations`, `spend_ledger`, `ledger_deadletter`, `model_prices`, `fx_rates`, `job_runs`. Delete `usage_counters`, `app.reserve_usage`, `spend_budgets`, `ai_call_ledger`, and `tenant_roles.monthly_budget_usd`. **Money is `bigint` nano-USD everywhere** (§5's argument holds: a Haiku cache-read token is $0.0000001 and truncates to zero at §2's `numeric(14,6)`); §2's `cost_usd numeric(14,6)`, `ai_cost_usd`, `limit_usd` all become `*_nanousd bigint`, with a `app.v_spend_usd` view for humans.
**But bolt on §2's enforcement**, which §5 lacks: `BEFORE UPDATE OR DELETE` **and** `BEFORE TRUNCATE` statement triggers, `ENABLE ALWAYS`, plus `revoke truncate on spend_ledger, audit_log from service_role`. §2 verified by execution that §5's ACL-only posture leaves TRUNCATE open to a leaked worker key with a byte-identical catalog afterwards.
One enum: `on_exhausted ∈ ('hard_stop','canned_reply','overage_bill')` (§2's names), default `canned_reply`.
*Reason: §5 built the mechanism, §2 proved what it takes to make it un-erasable; neither alone is sufficient.*

---

### 4. Four shapes and four state machines for the channel table
**Sections 1, 2, 3, 8.**

| | Table | Key | State column(s) |
|---|---|---|---|
| §1 | `channel_bindings` | `id`, unique `(provider, external_id) where released_at is null` | `delivery_mode ∈ (shadow,live,paused)` + `token_status` |
| §2 | `tenant_channels` | `id`, unique `(provider, external_id)` | `status ∈ (pending,active,authorization_error,disabled)` |
| §3 | `tenant_channels` **+ `channel_identity`** | identity keyed `(provider, external_id) where active` | `status ∈ (pending,probing,active,suspended,offboarded)` |
| §8 | `tenant_channels` | **primary key `(provider, external_id)`** | `mode ∈ (off,shadow_routing,shadow,live)` + `token_status` |

Secrets follow the same fracture: `channel_secrets(binding_id, kind)` (§1) / `tenant_secrets(tenant_id, channel_id, kind)` (§2, §3) / `tenant_secrets(tenant_id, kind)` — **no channel column at all** (§8), which cannot hold a Page token and an IG token for one tenant.

**Resolution.** **`tenant_channels` (3 sections agree) with §2's surrogate `id` and `unique (tenant_id, id)`** so composite FKs work — §8's natural PK breaks every downstream composite FK. **Add §3's `channel_identity` split**: §3 is right that an Instagram channel legitimately has three routing keys (IG user id, linked Page id, observed entry id) and that a transfer must be `active=false` + insert, not an `UPDATE` in the dashboard editor. Also take §3's `channel_transfers` and `channel_probe_tokens`.
**Keep both state columns — they are orthogonal, not duplicates.** `status` = health (§3's five values, plus §2's `authorization_error`); `delivery_mode` = §8's four cutover modes (`off | shadow_routing | shadow | live`). §8's `shadow_routing` (resolve and persist, never generate) is free and is what makes Phase D cost nothing; §3's `probing` is what gates activation on a proof-of-possession nonce.
Secrets: **§2's `tenant_secrets(tenant_id, channel_id, channel_key generated, kind)`** with §2's generated-column PK fix — §2 verified that `primary key (tenant_id, kind, coalesce(channel_id,…))` does not compile and that a nullable `channel_id` in a bare unique permits two identical token rows. Delete `channel_secrets`.
*Reason: one table three sections already agree on, plus the one split that Instagram actually requires, plus the two orthogonal state axes the cutover and the health watchdog each need.*

---

### 5. Four competing config-versioning and publish mechanisms
**Sections 1, 2, 4, 7, 8.**

- §1: validated JSON document → publish route → immutable `tenant_config_snapshots(version, content_hash, est_tokens, omitted_sections, not_applicable_sections)`; `tenants.live_config_version`; probe gate.
- §4: `kb_revision(seq, status draft|published|superseded)` with a partial unique "one draft per tenant", publish transaction, `kb_snapshot(variant, channel, prompt_hash, probe_baseline, allowed_numbers)`, forward-only rollback; `tenants.live_revision_id`.
- §2: typed rows, **no snapshot or version table at all**.
- §7: `tenants.kb_version`, `kb_entries` "versioned", no table.
- §8: `tenant_config_versions`, `config_version`.

**Resolution.** **Merge §4's lifecycle with §1's guardrails, under one pair of names.** `config_revisions` (§4's draft/published/superseded, `kb_revision_one_draft` partial unique, forward-only rollback, `est_tokens` + `est_token_source`, §4's stable-vs-volatile section split) + `config_snapshots` (§1's immutability trigger, `content_hash`, `omitted_sections`, `not_applicable_sections`, plus §4's `allowed_numbers` and `probe_baseline`). `tenants.live_revision_id`. Delete `tenant_config_versions`, `kb_revision`, `kb_snapshot`, `tenant_config_snapshots`, `tenants.kb_version`.
Keep **§1's two CHECK constraints** (`active_requires_published_config`, `active_requires_probe_run`) and **§4's publish-time invariants**. Keep **§1's `tenant_prompt_overrides`** with the 90-day expiry and the two-renewals-becomes-a-column rule — it is the only mechanism in eight sections that detects the config test failing.
Drop §4's `kb_snapshot.variant` — see item 14.
*Reason: §4 owns the operational lifecycle, §1 owns the refusals; §2's silence on versioning is a hole and §7/§8's column-only versions cannot roll back.*

---

### 6. Migrations: Supabase CLI (§2) vs the dashboard SQL editor (§8)
**Sections 2, 8.**

§2 §2.10 is unambiguous: *"Supabase CLI, with a real ledger, from `0001`. Never the dashboard SQL editor"* — with the cost stated ("you may never touch the dashboard SQL editor again"). §8 institutionalises the opposite: `supabase/migrations/` is annotated *"applied BY HAND via the dashboard editor (assume it, because that is what happens, and it is what freezes the ledger)"*, and step 3 applies to staging *"through the same path you will use in production (the dashboard SQL editor)"*.

**Resolution.** **§2 wins. CLI, from `0001`, both projects, no exceptions.** §8's §8.1.2 annotation and step 3 change to `supabase db push`. The emergency escape hatch is §2's: paste → immediately write the migration file → `supabase migration repair --status applied <version>` → re-run V0–V16 → record it in the PR. §8's fatalism is understandable and is exactly how the sibling's ledger froze; a greenfield project is the one moment the habit can be prevented rather than mitigated.
*Reason: §8's own dependence on catalog verification exists because the ledger lied next door — the fix is to not create the condition, not to plan around it.*

---

### 7. §8's onboarding checklist omits ~19 provisioning steps and half the schema
**Section 8 vs 1, 2, 3, 5, 6, 7.**

§8 step 3's table list is 33 tables. The union of the other sections is ~80. Concretely missing from the checklist, each of which blocks something:

| Missing step | Blocks |
|---|---|
| Seed `model_prices` | §5: *"a model with no current price row is not callable"* — every reply 503s |
| Seed `fx_rates` | §5's `spend_ledger.cost_mnt NOT NULL` — every ledger insert fails |
| Seed `channel_providers`, `outbound_policies`, `canned_response_kinds`, `probe_templates`, `roles` | FK violations on first tenant insert |
| Populate `ops.table_security_class` + `ops.tenant_scope` | §2's V6, V7, V15a–d gates cannot run |
| Create `platform_admins` row | §2's `app.is_platform_admin()` returns false; founder cannot read anything |
| Create `tenant_roles` rows | §7's `withTenantRole` step 2 refuses every call with `403 role_not_enabled` |
| Run a `probe_run`, populate `forbidden_phrasings` | §1's `active_requires_probe_run` CHECK **refuses the `lifecycle='active'` UPDATE**. §8 step 40's flip fails. |
| Set `name_confirmed_at` on the binding | §1's `live_requires_name_confirmation` CHECK refuses `delivery_mode='live'`. §8 step 40 fails. |
| Create `handoff_targets` + Telegram `/start` with the salon | §7's entire handoff path has no destination |
| Bootstrap `persons`/`consent_records` + the opt-out phrase list | §7's consent gate has nothing to check |
| Register the booking host in `tenant_domains` | §7's redirect token cannot be minted |
| Capture the 3-month pre-launch booking baseline | §7's Analytics before/after |
| Run §6's bake-off; run `count_tokens` | §5's ceiling (item 2) |
| Platform Mongolian sign-off (`platform-mn-review.json`) | §6's L0/L1 review gate |
| Set `retention_days_*`; schedule `ops.purge_expired` | §2's retention promise |

**Resolution.** Insert all fifteen into §8's checklist. Specifically: a new **Phase A step 3b "seed the platform reference tables"** (`channel_providers`, `model_prices`, `fx_rates`, `outbound_policies`, `roles`, `canned_response_kinds`, `probe_templates`, `mn_fold`, `ops.table_security_class`, `ops.tenant_scope`, `platform_admins`); a new **Phase A step 9b "run the bake-off and measure P"** before any ceiling is set; and in Phase E, steps for `tenant_roles`, `handoff_targets`, `tenant_domains`, the probe run, and `name_confirmed_at`. §8's step 3 table list is replaced by the canonical list below.
*Reason: two of §1's CHECK constraints make §8's cutover step literally un-executable as written, and three seed tables make the first customer message 503.*

---

### 8. Four idempotency tables for one event
**Sections 2, 3, 5, 7/8.**

- §2: `webhook_events(provider, dedup_key)` **globally unique**, `routing`, `raw_payload`, `outcome`, retention.
- §3: `inbound_events(provider, event_key)` globally unique, with a state machine (`pending_enqueue`, `persist_deferred`, `routed_provisionally`, `standby_not_primary`, `expired_unqueued`, `shed`, `blocked_no_token`) and `reply_text`. Plus a separate `unrouted_events` quarantine table.
- §5: `app.inbound_messages(tenant_id, provider_message_id)` — **per-tenant**, with `lease_until`, `attempts`, `replied_at`.
- §7/§8: `webhook_events` + `messages.external_id` unique.

**Resolution.** **One table: `webhook_events`** (§2's name and retention/PII design), keyed **`unique (provider, dedup_key)` globally** (§2 and §3 agree; §2's argument is decisive — a per-tenant key lets the same event be processed twice under two tenants, and every downstream guard is scoped by the field that is wrong). Add §3's `state` machine, `source ∈ ('meta','mirror')`, and `routing` discriminator with `check ((routing='unrouted') = (tenant_id is null))`. Add §5's `lease_until`, `attempts`, `replied_at` to the same row. Delete `inbound_events`, `inbound_messages`, `unrouted_events` (§2's `routing='unrouted'` + `tenant_id null` covers the quarantine; §3's 500-id cap becomes a founder-view filter).
On dedup conflict: re-read and compare `tenant_id`; equal → benign duplicate; different → `event_key_cross_tenant`, refuse, **page**.
*Reason: one row per event, one key, one lease — three tables cannot agree on which one a retry consults.*

---

### 9. Four outbound tables, and `'voice'` is in one enum and explicitly banned from another
**Sections 1, 2, 3, 7, 8.**

`outbound_messages` (§2, §7) vs `outbound_sends` (§3, the reply-send claim) vs `private_replies` (§3) / `private_reply_sent` (§8) vs `comment_replies` (§3).

And a direct contradiction: **§1's `channel_provider` enum includes `'voice'`**; **§7 §7.4 explicitly excludes it** from `channel_kind` with a specific argument — a call's cost is per-second and unknown at accept time, so §2's `check (state <> 'sent' or unit_cost_usd is not null)` forces an implementer to write `costUsd: 0`, which passes and breaks the metering rule.

**Resolution.** **One table: `outbound_messages`** (§2's, whose `kind` already spans `reply | private_reply | comment_reply | sms_*`), with §3's claim columns added (`state='claiming'`, `lease_until`) and §2's partial unique index `(tenant_id, kind, dedup_key) where dedup_key is not null` doing the private-reply single-use job. Delete `outbound_sends`, `private_replies`, `private_reply_sent`, `comment_replies`.
**§7 wins on voice.** `channel_providers` becomes a **lookup table, not an enum** (§2's shape) — seeded with `facebook_page, instagram, sms, web`, and voice is simply a row nobody inserts. §1's `channel_provider` enum is deleted. Adding a provider is then data, and no enum value exists that no code path executes.
*Reason: §7's cost argument is specific and correct, and a lookup table makes the seam a row instead of a promise the CHECK constraint cannot keep.*

---

### 10. Six shapes of the refusal table and four incompatible matcher semantics
**Sections 1, 2, 4, 6, 7, 8.**

Shapes: `disclosure_rules(topic_examples[], reply_key, quote_price)` + `out_of_scope_topics` (§1) / `refusal_rules(match_terms[], verbatim_response_id, forbidden_phrases[])` (§2) / `kb_refusal_topic(trigger_examples[], forbidden_outputs[], allow_price, escalation_channel)` (§4) / `refusal_topics(match_stems[], response_key, deterministic_shortcircuit)` (§6) / `refusal_topics(match_terms[], forbidden_openings[])` (§7) / `refusal_topics(matcher jsonb, decision_question, forbidden_openings[])` (§8).

Matcher semantics, all four mutually exclusive:
- §1: **compiler input only, never a runtime matcher.**
- §7: **exact token match.**
- §6: **stem-prefix match with ordered stem sequences.**
- §8: **typed closed-vocabulary jsonb through one engine.**
- §4/§6: additionally a **deterministic short-circuit** that suppresses the model entirely.

**Resolution.** **Table: §2's name `refusal_rules`, §1's two-table split** (`disclosure_rules` + `out_of_scope_topics`), columns from §8 (`matcher jsonb`, `decision_question`) + §4 (`forbidden_outputs` sourced from measured failures) + §6 (`deterministic_shortcircuit`, default false). Evidence-linked forbidden phrasings live in **§1's `forbidden_phrasings` table**, not an array column, because they must carry `observed_at` and `evidence`.
**Matcher: §8's one engine, §6's stem-prefix semantics.** §7's exact-token loses to Mongolian agglutination — `хүүхэд` misses «хүүхдэд» and «хүүхдүүдийн», so the refusal never fires; §6 is the only section that measured this. §1's "compiler input only" is right about *customer text used to short-circuit* and wrong about *the outbound guard*, which §6 and §4 both need. So: matchers run **inbound only to select which gate text is rendered and to set `deterministic_shortcircuit`**, and **outbound over our own text** for the guard — never as an unanchored pattern deciding to suppress a reply, unless `deterministic_shortcircuit` is explicitly enabled after a measured precision run. Enforce with §8's `check-matchers.mjs` (min 4 characters, not a prefix of any canonical service or staff name, dry run against the last 500 messages).
*Reason: one engine, one table pair, the only matcher semantics anyone measured against real Mongolian.*

---

### 11. Prompt cache: default TTL, column name, and write multiplier all disagree
**Sections 4, 6, 7.**

§4: `tenant.prompt_cache_ttl ∈ ('none','5m','1h')`, **default `1h`**. §6: `tenants.prompt_cache_mode ∈ ('off','5m','1h')`, **default `off`**, with a regret table showing `1h` has both the best and the worst case. §7 hardcodes `ttl:'1h'`. §5 seeds 1.25× write; §6 verifies 1.25×/5m and 2×/1h; §4 flags the same uncertainty and says it moves break-even from 21.7% to 52.6%.

**Resolution.** Column: **`tenants.prompt_cache_mode ∈ ('off','5m','1h')`** (§6's name and values). Write multiplier: **1.25× for 5m, 2× for 1h**, seeded into `model_prices` as separate columns.
Default: **neither section's answer — set it from measurement, which §8 already provides for free.** §6's `off` default is safest against an unknown traffic shape but is the *most expensive* absolute setting for a busy tenant ($97.65/month for Matrix at P=9,000, vs $50.85 on 1h). §4's `1h` default is right for Matrix and wrong for a five-message-a-day tenant. **§8's Phase D mirror gives 14 days of real inbound timestamps before the first paid reply**, and §6's counterfactual replay query computes `h₅` and `h₁` exactly from timestamps alone. So: `prompt_cache_mode` defaults to `off` in the DDL, and **§8's step 39 (which already runs a per-hour volume query over mirror data) additionally sets the mode from the counterfactual replay before go-live.** No tenant ever ships on a guessed default.
*Reason: the one section that worried about unknown traffic and the one section that built a way to know it never spoke; the mirror already measures it.*

---

### 12. The owner dashboard: §4 built on an answer the other four sections list as open
**Sections 2, 4, 7, 8.**

§4's entire §4.5 — the mobile-first Mongolian dashboard, three-role model, magic-link login, in-person 90-day session, CSV import, draft/publish UI — presupposes a tenant-owner login. §2 §2.15 Q1, §7 §7.8 Q8 and §8 §8.9 Q1 all list "does the tenant owner get a login in v1?" as **the single highest-leverage open question**, and §8 step 41 answers it in the opposite direction: *"v1 recommendation: the owner changes nothing directly."*

Compounding it: **§4's freshness loop delivers a one-tap confirmation "as a Messenger postback to the registered owner PSID"** — an *initiated* Messenger message to someone outside the 24-hour window. §3 §3.9.2 and §7 §7.2.0 both establish that the tags this would use were retired 2026-04-27 (error `100`) and that `HUMAN_AGENT` forbids AI-authored text. §4's mechanism is not deliverable.

**Resolution.** **No tenant-owner login in v1.** §2's Class B tenant-authored RLS policies, `current_tenant_ids()`, and the `tenant_members` machinery ship but are dormant; the whole security budget goes to the service-role inbound path where all the volume and spend are. §4's §4.5 dashboard becomes the founder's admin UI, unchanged in substance.
**But §4's freshness argument survives and must be implemented**, because it is correct: removing the founder from the price-change loop deletes the only staleness detector the ancestor had. Move it to **Telegram**, which §7 already provisions per tenant (`handoff_targets(channel='telegram')`, established by the owner sending `/start`). `confirmed_at`, `stale_after_days`, the monthly «Үнэ хэвээрээ юу? [Тийм] [Өөрчлөх]» prompt, and §4's unplanned-closure toggle all become Telegram callback buttons. That kills the RLS-for-humans work, kills the Meta compliance problem, and is a better channel for a 21:40 emergency closure than a dashboard.
*Reason: one answer, and Telegram is already in the architecture for exactly this person.*

---

### 13. Quality's cost bucket, and the surface fractions are miscalibrated ~1.8×
**Sections 5, 6, 7.**

§5's default `surface_month_fraction` is `{reception: 0.80, analytics: 0.10, quality: 0.10, care: 0.00}` — Quality charged to the tenant. §7 §7.5.6: *"Charged to `platform_ops`, not the tenant — the tenant did not ask for it and must not pay for the founder's tooling."* The surface enums differ too: §5 `('reception','analytics','quality','care','onboarding','platform')` vs §7 `('reception','care','analytics','voice','platform_ops')`.

Against §6's measured costs, §5's fractions are wrong regardless: at a $25 ceiling, Analytics gets $2.50 and needs **$0.009**; Quality gets $2.50 and §6 prices the cascade at **$4.46** — under-provisioned 1.8×, so the Quality run would refuse against a tenant sub-ceiling.

**Resolution.** **§7 wins: Quality is `platform_ops`, attributed per tenant in the ledger but not charged to the tenant's ceiling.** That simultaneously fixes the fraction problem and gives the founder the "which tenant costs most to keep good" number. One surface enum: `('reception','care','analytics','onboarding','quality','platform_ops')`; `quality` rows carry `platform_ops` as their budget bucket. New default fractions: **`{reception: 0.95, analytics: 0.02, care: 0.00}`**, with the remaining 3% unallocated headroom. `voice` is not in the enum (item 9).
*Reason: the fractions as written would refuse the Quality run they were sized for, and Quality is founder tooling.*

---

### 14. Prompt cache key ×4, and the closure sits in the cached block in one section and outside it in three
**Sections 1, 4, 6, 7, 8.**

Keys: `content_hash` of the stable prefix (§1) / `(tenant_id, revision_id, variant, channel)` (§4) / `(tenant_id, config_version)` (§6, §8) / `(tenant_id, kb_version, channel, policy_hash)` (§7).

Closure placement: §4 **pre-renders one snapshot per closure variant, inside the cached block**. §1 (`volatile` sections → uncached suffix), §6 (L4), and §7 (BLOCK 2 uncached) all put it **outside**, each citing the ancestor's comment that a warm lambda outlives the end of a break.

**Resolution.** **Local snapshot cache keyed `(tenant_id, revision_id, channel)`. Anthropic cache keyed by content — i.e. `config_snapshots.content_hash` over the stable prefix only.** Delete `variant`, `config_version`, `kb_version`, `policy_hash` as cache-key components.
**Closure goes in the uncached suffix (3 sections to 1).** §4's variant pre-render is defensible but costs a snapshot-row explosion for ~180 uncached tokens ($0.00036/message), and it re-introduces the exact staleness the ancestor's comment warns about the moment a *second* volatile fact appears (today's special, a mechanic on leave). §4's stable-vs-volatile *concept* is kept — it is the right abstraction; the closure is simply a `volatile` section.
The rest of §4's §4.2.2 survives intact: `tenants.closed_from`/`closed_until` as a runtime flag, `closure_generic` reviewed once with a `{{reopen_date}}` sentinel filled by the ancestor's proven suffix-free `spokenDate()` form, no publish transaction, no founder.
*Reason: one key, one placement, and the volatile-suffix cost is a rounding error against the failure it prevents.*

---

### 15. Route paths, env-var formats, and two ceilings-as-env-vars
**Sections 3, 5, 8.**

| | §3 | §8 |
|---|---|---|
| Webhook | `/api/meta/webhook/[app]` | `/api/webhooks/meta` |
| Worker | `/api/meta/worker` | `/api/workers/inbound` |
| App secrets | `META_APP_SECRETS` = **JSON map** `{slug: secret}` | `META_APP_SECRETS` = **comma-separated set** |
| Verify token | `META_VERIFY_TOKENS` = JSON map per slug | `META_WEBHOOK_VERIFY_TOKEN` = one value |
| KEK | `META_TOKEN_KEK_V1` (also §1, §2) | `TENANT_KEK_V1` + `TENANT_KEK_ACTIVE_VERSION` |

And §8 defines `PLATFORM_MONTHLY_CEILING_USD` as an env var, while §5 states flatly: *"Ceilings and budgets are **not** environment variables… An env var is the worst of both: mutable from a dashboard, invisible in a diff, with no record of who changed it."*

**Resolution.**
- Paths: **`/api/webhooks/meta/[app]`** and **`/api/workers/inbound`** — §8's prefixes (which the middleware matcher excludes as `/api/webhooks/:path*` and `/api/workers/:path*`) with §3's app slug, which the `matched_app_slug` cross-check and the §8 cutover mirror both require.
- **`META_APP_SECRETS` is a JSON map** (§3). §8's comma-separated set cannot produce `matched_app_slug`, and §3's `tenant_channels.meta_app_id` vs `matched_app_slug` comparison is what ties authenticity to identity.
- **`META_VERIFY_TOKENS` is a JSON map** (§3), value `token | token[]` for rotation. §8's "one app, one token" is true today and false the moment `dala-legacy` and staging coexist — which §8's own cutover plan requires.
- **`TENANT_KEK_V1` / `TENANT_KEK_ACTIVE_VERSION`** (§8's names — they generalise past Meta to the SIP password and any future credential).
- **`PLATFORM_MONTHLY_CEILING_USD` is deleted.** §5 wins: the platform ceiling is a compiled constant (`PLATFORM_HARD_CAP_USD_PER_DAY` in `config/platform.ts`, commit-gated) plus a `spend_counters` row with `scope='platform'`.
*Reason: §3's formats are the ones the cutover and multi-app design actually need; §5's rule about ceilings is a security decision, not a preference.*

---

### 16. §8 verifies with a materially weaker catalog pack than §2 defines
**Sections 2, 8.**

§8 references "V1–V9" throughout and step 34 runs V1, V2, V3, V5, V6, V7, V8, V9. §2 defines **V0–V16 with six zero-row gates**, and the ones §8 omits are the ones §2 proved were needed:

- **V4** (views/matviews) — §2: "the whole class the draft could not see"; a `security_invoker=false` dashboard view is a total cross-tenant leak invisible to a `relkind in ('r','p')` pack.
- **V13** (triggers, `tgenabled='A'`) — §2 verified that dropping both append-only triggers produced an **identical V12 fingerprint**. Without V13, item 3's whole append-only guarantee is unverified.
- **V14a/b** (`has_schema_privilege`, `pg_default_acl`) — §2 verified `revoke usage on schema public from anon` is a **no-op** (the ACL text changes and the privilege does not), and that `service_role` has **no USAGE on a freshly created `app` schema**, which 500s every budget check.
- **V10** (SECURITY DEFINER without `search_path=''`), **V15a–d** (class-registry gates — the query that catches a copy-pasted tenant write policy on `usage_counters`, which V7 cannot catch by construction), **V16** (`*_id` columns with no FK).

**Resolution.** **§8's step 34 runs the full V0–V16 pack**, and §8's CI check 11 does the same on staging for any `supabase/` PR. Add §2's `ops.table_security_class` and `ops.tenant_scope` to §8's step 3 (item 7) — V6, V7, V15a–d are driven from them and cannot run without them. §2's note that `tenants` scopes on `id`, not `tenant_id`, is why V6/V7 must read `ops.tenant_scope` rather than a hardcoded column name.
*Reason: §8's pack passes on a system whose ledger triggers have been dropped and whose dashboard view leaks every tenant.*

---

### 17. The consent model exists in exactly one section
**Section 7 vs 1, 2, 3, 8.**

§7 introduces `persons`, `person_identities`, `consent_records`, `persons.blocked_at`, and makes consent **step 3 of the gate**, before budget. No other section has any of it. §2's `contacts` has no `person_id`; §8 provisions none of it; §3's private-reply path — which §7 identifies as the concrete case that needs it (a DM to someone who never DM'd us) — has no consent check.

**Resolution.** **Adopt §7's three tables and the gate ordering** (identity → entitlement → **consent** → budget). Add `contacts.person_id` (composite FK to `persons`). §7's rule 5 stands: an inferred opt-out takes effect **immediately**, with the Quality flag existing to reverse false positives, not to authorise true ones. §8's Phase E gets a step: seed the tenant's opt-out phrase list and confirm the escalation path.
This is not deferrable to the SMS phase — §3's comment→DM private reply is `initiated: true` and ships in v1 if comments ship.
*Reason: the one path in v1 that messages a stranger is the one the other seven sections' gate does not check.*

---

### 18. Roles/capabilities designed twice under different names
**Sections 1, 7.**

§1: `platform_capabilities(key, status ∈ available|gated|disabled, gate_reason)` + `tenant_capabilities(entitled)`. §7: `roles(role, is_client_facing, requires_transport, requires_data_source)` + `tenant_roles(state, monthly_budget_usd, config jsonb)` + `role_health`.

**Resolution.** **One pair, §7's names, §1's status field folded in:** `roles(role, is_client_facing, status ∈ available|gated|disabled, gate_reason, requires_transport, requires_data_source)` + `tenant_roles(tenant_id, role, state, config)` + `role_health`. Delete `platform_capabilities`, `tenant_capabilities`. **Budgets do not live on `tenant_roles`** (item 3) — `monthly_budget_usd` is deleted from it.
§7's `requires_data_source` is a genuine finding the other sections missed: Customer Care has **two** missing prerequisites, not one — no SIP trunk *and* no appointment feed — and without the second, the trunk arriving turns Care into "tenant pastes a list and blasts it", a different product with a different consent story.
*Reason: two names for one gate is how a second, unmaintained gate gets written.*

---

### 19. Two attribution models for Analytics
**Sections 2, 7.**

§2: `booking_handoffs(link_sent, service_id, staff_id, deposit_quoted, outcome ∈ link_sent|confirmed_by_tenant|no_show|abandoned|unknown, outcome_source)` and `analytics_reports(bookings_link_sent, bookings_confirmed, revenue_attributed_mnt, attribution_basis ∈ tenant_confirmed|inferred|none)`. §7: `booking_links` + `link_clicks(ua_class, counted)` + `attributed_bookings(source, period_month, quantity, booking_state)`, a four-tier evidence model (A/B/C/D), a stored `ATTRIBUTION_WINDOW_DAYS`, and a signed Dala-owned redirect.

**Resolution.** **§7's three tables win** — it is the only version with a click log, a booking *state* (a booking is not revenue; no-shows and cancellations all push booked value above received value), a self-report tier that cannot masquerade as confirmed, and the `unique nulls not distinct` fix that stops a double-clicked self-report doubling the month's revenue line. Delete `booking_handoffs`. `analytics_reports` keeps §2's shape plus §7's `attribution_window_days` and `evidence_tier` per figure, and `attribution_basis` becomes §7's four tiers.
Add **`tenant_domains`** — §7 references it twice (booking-URL host check, redirect minting) and no section defines it.
Adopt §7's rename in the sales material too: **«Dala AI-н холбоосоор дамжсан захиалга»**, not "revenue Dala AI drove".
*Reason: §2's model cannot express "booked but not completed", which is the whole gap between a link click and money.*

---

### 20. Retrieval: built in one section, forbidden in three, assumed by a fourth
**Sections 2, 4, 6, 7, 8.**

§2 ships `knowledge_chunks` with `vector(1536)`, `app.search_kb()`, a CI grep banning `<=>` outside it, and a partition escalation plan. §4 §4.3.3 says whole-KB-in-prompt with three named triggers for changing. §6 agrees (Matrix's whole KB is 7,824 characters). §8's "what I would NOT do in week one" says **"No retrieval / RAG."** §7 §7.1.8 says *"Retrieval, not inlining… pinned entries always inline; the long tail is retrieved"* and references a `kb_entries` table that exists nowhere.

**Resolution.** **Build §2's tables and `app.search_kb()`; do not populate embeddings at launch.** The schema is cheap, the chokepoint function is the thing that must exist *before* someone writes a hand-rolled `order by embedding <=> $1` outside it, and §2's CI grep is the guard. Retrieval is switched on per tenant by §4's named triggers (T1 size / T2 dollar / T3 quality), with §4's `kb_inline_token_budget` (default 6,000) as the switch. §7's `kb_entries` becomes `knowledge_documents` + the structured config tables. §8's "no RAG in week one" stands as an *operational* statement, not a schema one.
Also carry §2's two refusals: **no global HNSW index at launch** (an ANN scan with a post-filter on `tenant_id` returns zero rows for a small tenant and invites "raise the limit and filter in JS"), and **no per-tenant partial index** — that is schema-per-tenant wearing an index's clothes. The escalation is hash partitioning on `tenant_id` with a fixed partition count.
*Reason: build the chokepoint, ship inline — the danger is not retrieval, it is a hand-written vector query outside `withTenant`.*

---

### 21. At-least-once generation (§3) vs at-most-once generation (§5)
**Sections 3, 5.**

§3 §3.5.3 states the posture explicitly: *"at-least-once **generation**, at-most-once **delivery**"* — a duplicate generation costs cents and is invisible; a duplicate reply is customer-visible. §5 §5.4 step 9a is a compare-and-swap on `provider_call_started_at`: *"Zero rows ⇒ `indeterminate`: somebody already made this call. **DO NOT CALL**."* — at-most-once generation, with `max_attempts = 2`.

**Resolution.** **Both, and they compose — state it once so nobody implements one and assumes the other.** Generation is bounded by §5: the CAS gate means exactly one worker calls per *attempt*, and `max_attempts = 2` for Reception bounds attempts. Delivery is bounded by §3: the `outbound_messages` claim + lease means at most one send ever, and a retry re-sends the **stored** reply text rather than re-entering generation. §3's `indeterminate` (lease expired, outcome unknown) resolves to silence + a Quality flag, never a re-send.
Net posture: **at most 2 generations, at most 1 delivery, and a retry after a successful generation costs nothing.** That also fixes the ancestor's four-generations-on-a-permanent-401 burn independently of the retryable/terminal classification.
*Reason: §5 bounds the money, §3 bounds the customer experience; neither alone is the whole rule.*

---

### 22. Contacts key, message body columns, and conversation states
**Sections 2, 3, 7.**

- Contacts uniqueness: `(tenant_id, channel_id, external_id)` (§2, §3) vs `(tenant_id, provider, external_id)` (§7).
- Message body: `body` with `check (body is normalized)` + `body_redacted_at` (§2) vs `body, body_nfc` — two columns (§7).
- Conversation state: `('open','idle','handed_off','closed')` (§2) vs `('active','awaiting_human','human_handled','closed','paused_budget','paused_role_off')` (§7).

**Resolution.** **§2's `(tenant_id, channel_id, external_id)`** — a PSID is Page-scoped and an IGSID is account-scoped, so the key must carry the channel, not the provider class. **§2's single `body` column** with the `IS NORMALIZED` constraint — a second `body_nfc` column is two copies of one fact and lets them diverge; NFC is enforced at the boundary and by the constraint. **§7's six conversation states** — `paused_budget` and `paused_role_off` are load-bearing for §5's degradation ladder and §7's `role_health`, and §2's four cannot express them. Add §7's `conversation_events` (§2 has no history table and both Analytics and Quality need the transitions).
*Reason: the narrower key, the single normalized column, and the state set that can express degradation.*

---

### 23. Tail: names and enums that must be picked once
**All sections.**

| Concept | Competing | Canonical |
|---|---|---|
| The chokepoint | `withTenant` (§1,§3,§8), `withTenantRole` (§7), `withTenantSpend` (§5) | **`withTenantRole`** (§7's signature is the superset: `initiated`, `personId`, `role`, `estCostUsd`) |
| Alerts table | `alerts` (§5,§8), `ops_alerts` (§3) | **`alerts`** |
| Proposal table | `kb_change_proposals` (§2,§8), `kb_change_proposal_evidence` (§7), `kb_proposal_evidence` (§2), `kb_proposal` (§4), `config_change_proposals` (§1) | **`kb_change_proposals` + `kb_change_proposal_evidence`**; §1's config-scoped variant merges in via `target_kind` |
| Tenant lifecycle | `lifecycle ∈ (onboarding,active,suspended,churned)` (§1), `status ∈ (provisioning,active,suspended,offboarding,purged)` (§2), `status='onboarding'` (§8) | **§2's `status`**, five values, plus §1's two CHECK constraints |
| Booking config vs event | `tenant_booking` (§7) / `booking_handoff` (§1,§8) / `booking_handoffs` (§2, an event log) | **`tenant_booking`** (config, PK `tenant_id`) + **`booking_links`** (event). Delete `booking_handoff(s)` |
| `auth_flavour` | `('facebook_login','instagram_login')` (§1,§2,§3) vs `('facebook_login')` only (§8) | **§8's narrow check plus `'n_a'`** for sms/web; widen only after §8 step 7 rehearses IG-Login end to end |
| Quality flags | `quality_flags` (§6,§7) — absent from §2 | **Add `quality_flags`** (runtime, zero-cost) alongside `quality_reviews` (model verdict) |
| Prompt token measurement | `tenant_prompt_versions` (§5,§6), `kb_revision.est_tokens` (§4) | **`config_revisions.est_tokens` + `est_token_source`** |
| Locale column | `primary_locale` (§1) vs `default_locale` (§2) | **`default_locale`** |
| FX planning rate | ₮3,500 (§5) vs ₮3,600 (§6) | **`fx_rates` row; no constant in any document** |

---

## Canonical table list

Schema `public` unless noted. **[seed]** = platform reference data, populated in §8 Phase A. **[P2]** = ships schema-only at Matrix go-live.

**Tenancy & identity**
`tenants` · `tenant_members` · `platform_admins` · `channel_providers` [seed] · `tenant_channels` · `channel_identity` · `channel_transfers` · `channel_probe_tokens` · `tenant_secrets` · `tenant_domains` · `roles` [seed] · `tenant_roles` · `role_health`

**Config & knowledge**
`config_revisions` · `config_snapshots` · `config_audit` · `config_keys` · `price_axes` · `services` · `service_variants` · `service_aliases` · `staff_members` · `disambiguation_pairs` · `disambiguation_candidates` · `deposit_rules` · `business_hours` · `tenant_closures` · `faqs` · `knowledge_documents` · `knowledge_chunks` [P2 — schema now, embeddings later] · `canned_response_kinds` [seed] · `canned_responses` · `disclosure_rules` · `out_of_scope_topics` · `forbidden_phrasings` · `deterministic_replies` · `prompt_blocks` · `prompt_examples` · `tenant_prompt_overrides` · `tenant_booking` · `contact_points` · `mn_fold` [seed] · `probe_templates` [seed] · `probe_runs`

**Conversation & delivery**
`persons` · `person_identities` · `consent_records` · `contacts` · `conversations` · `conversation_events` · `messages` · `webhook_events` · `outbound_messages` · `outbound_policies` [seed] · `handoffs` · `handoff_targets` · `staff_notifications` · `channel_health` · `contact_erasure_requests`

**Money**
`model_prices` [seed] · `fx_rates` [seed] · `tenant_budgets` · `spend_counters` · `spend_reservations` · `spend_ledger` · `ledger_deadletter` · `job_runs`

**Analytics & quality**
`booking_links` · `link_clicks` · `attributed_bookings` · `analytics_reports` · `quality_flags` · `quality_reviews` · `kb_change_proposals` · `kb_change_proposal_evidence`

**Ops**
`alerts` · `audit_log` · `onboarding_steps` · `tenant_offboardings` · `ops.table_security_class` [seed] · `ops.tenant_scope` [seed]

**Functions only in `app`:** `current_tenant_ids`, `is_platform_admin`, `admin_may_read_bodies`, `bump_counter`, `reserve_spend`, `settle_spend`, `search_kb`, `mn_search_fold`, `variant_key`, `v_spend_usd`. **`ops`:** `deny_mutation`, `audit_snapshot_class_guard`, `purge_expired`, `export_tenant`.

**Deleted** (superseded above): `channel_bindings`, `channel_secrets`, `platform_capabilities`, `tenant_capabilities`, `tenant_config_snapshots`, `tenant_config_versions`, `kb_revision`, `kb_snapshot`, `kb_change`, `kb_proposal`, `kb_service*`, `kb_staff*`, `kb_faq`, `kb_note`, `kb_policy`, `kb_clarifier`, `kb_disambiguation`, `kb_canned_response`, `kb_closure`, `kb_contact_channel`, `kb_hours`, `ai_call_ledger`, `service_items`, `service_prices`, `service_tiers`, `refusal_rules`(as a third shape), `refusal_topics`(as a fourth), `inbound_events`, `inbound_messages`, `unrouted_events`, `outbound_sends`, `private_replies`, `private_reply_sent`, `comment_replies`, `booking_handoff`, `booking_handoffs`, `usage_counters`, `spend_budgets`, `ops_alerts`, `kb_entries`, `kb_proposal_evidence`.

---

## Canonical environment variables

**Required — the deployment refuses to serve if any is absent**

```
DALA_ENV                      production | staging | preview
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY      sb_publishable_…
SUPABASE_SECRET_WEBHOOK       sb_secret_… one named key per component (§2)
SUPABASE_SECRET_WORKER
SUPABASE_SECRET_ADMIN
SUPABASE_SECRET_ANALYTICS
SUPABASE_SECRET_QUALITY
SUPABASE_SECRET_PURGE
SUPABASE_SECRET_PRIVACY       the data-deletion callback + its status page (§10.5).
                              Its own key: the one surface that is unauthenticated by
                              design AND writes a row
TENANT_KEK_V1                 32-byte base64. No plaintext fallback, ever.
TENANT_KEK_ACTIVE_VERSION
META_APP_ID
META_APP_SECRETS              JSON map {app_slug: secret} — a SET, for rotation,
                              staging, and the dala-legacy cutover app
META_VERIFY_TOKENS            JSON map {app_slug: token | token[]}
META_GRAPH_VERSION            default; per-tenant override is a nullable column
DALA_PUBLIC_URL               the deployment's own origin. The data-deletion status URL
                              is built from it, NEVER from the request's Host header
ANTHROPIC_API_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
WORKER_PUBLIC_URL
LINK_SIGNING_KEY              HMAC key for the booking redirect token (§7)
TELEGRAM_BOT_TOKEN            one bot: founder alerts AND per-tenant handoff chats
TELEGRAM_ALERT_CHAT_ID        the founder's chat
CRON_SECRET
```

**Optional**

```
TENANT_KEK_V2                 present only during rotation
TELEGRAM_ALERT_CHAT_ID_CRIT   🔴 only
ALERTS_ENABLED                default true; false only in dev/CI
ALERT_MAX_PER_HOUR            default 20
ALERT_DIGEST_HOUR_UB          default 9
ANTHROPIC_ADMIN_API_KEY       read-only, monthly reconciliation only
SENTRY_DSN
```

**Explicitly banned as env vars** — each is per-tenant data or a spending decision:
`PAGE_ACCESS_TOKEN` · `FACEBOOK_PAGE_ID` · `MESSENGER_VERIFY_TOKEN` · `SALON_CLOSURE_*` · `ALLOWED_ORIGINS` · `LOG_WEBHOOK_URL` · `ANTHROPIC_MODEL` · **`PLATFORM_MONTHLY_CEILING_USD`** and every other ceiling.

**Ceilings live in exactly two places, and neither is an env var** (§5):
- `config/platform.ts`, compiled, commit-gated, requires an approver's name in the message: `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY`, `PLATFORM_HARD_CAP_USD_PER_DAY`, `ANALYTICS_RUN_BUDGET_USD = 0`, `QUALITY_RUN_BUDGET_USD = 0`, `BAKEOFF_BUDGET_USD`, `ATTRIBUTION_WINDOW_DAYS`, `MODEL_REGISTRY`.
- `tenant_budgets`, append-only and versioned, which can only ever **lower** the compiled cap.

**One CI check that does not yet exist in any section:** `check-env-example.mjs` (§8's) must additionally assert that no identifier matching `/CEILING|BUDGET|LIMIT/` appears in `process.env` anywhere under `src/`. That is the mechanical form of §5's rule, and it is the one place §8's env list violated it.