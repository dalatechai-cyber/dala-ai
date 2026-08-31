# Dala AI — Architecture

**Status: proposed, for founder review. Nothing is approved and no code has been written.**
Date: 2026-08-31.

Dala AI is Dalatech's multi-tenant AI-staff platform for Mongolian SMBs. It is a new
business, separate from Core Language (`dalatech-english`) — shared **lessons only**, zero
shared code, customers, or databases. New Supabase project, new Meta app, new repository.

This document is the reviewable summary. The full design lives in
[`docs/architecture/`](architecture/), section by section, with the SQL, the failure
tables, the Mongolian prompt text and the research notes that back each claim. Where this
summary and a section file disagree, the section file is the detail and this file is the
decision.

---

## 0. The test everything is measured against

> **Onboarding client #3 must be filling in a config, not writing code.**

Everything that distinguishes one customer from another is a **row**. One codebase, one
deployment, one Meta app, one Supabase project. A tenant is a `tenants` row plus rows in
~20 tenant-scoped tables, and a *live* tenant is additionally an immutable **compiled
config snapshot** that the runtime reads.

Onboarding client #3 is: create a tenant, bind a channel, fill the knowledge tables,
publish, activate. No branch, no deploy, no migration.

**The counter-example is in this session's own repositories.** Matrix-Chatbot's
`config/currentClient.js` is a JS object literal imported at module load by four modules,
rendered by a template that hardcodes the salon's own policy
(`lib/systemPromptBuilder.js:114-188`), and cached in a module-scope singleton
(`lib/salonBrain.js:142`). Its onboarding guide says: *"Open `/config/currentClient.js` and
update the following sections"*, then rebuild and redeploy (`CLIENT_ONBOARDING.md:9,52-56`).
That guide is already **wrong about its own shape** — it documents `productList` /
`faqList` / `contactInfo` while the file it points at uses `knowledge.priceList` /
`knowledge.faqs` / `knowledge.contact`. A config format that drifts out of sync with its
own documentation at one tenant will not survive three.

---

## 1. Three properties that carry the whole design

1. **Tenant is derived server-side, per webhook entry, from a registry with a unique key.**
   Never from a request body, never from an env var, never with a default. There is no
   `?? DEFAULT_TENANT` anywhere, not even for local testing — that line, written once for
   convenience, is the most likely source of a cross-tenant leak.

2. **The compiler turns rows into a rendered prompt, and the rendered text — not the
   template — is what is hashed, reviewed, and served.** A config that cannot be rendered
   is a publish-blocking error, never a silently empty string.

3. **The wrong answer is kept out of the context window rather than forbidden in prose.**
   A price that is not in the prompt cannot be quoted. This is the strongest form of the
   bake-off's hardening result, and it is cheaper than any rule.

---

## 2. Tenant model and configuration

Full detail: [`architecture/01-tenant-model.md`](architecture/01-tenant-model.md)

### 2.1 Lifecycle is behaviour, not a label

`onboarding → active → suspended → churned`, and each state is a defined behaviour at the
inbound path:

| State | Persist inbound | Spend | Send | Alert |
|---|---|---|---|---|
| `onboarding` | yes | no | no | **yes, urgent** — a real customer reached a Page bound to a non-live tenant |
| `active` | yes | yes | yes | — |
| `suspended` | yes | no | only a reviewed canned notice | on first inbound after suspension |
| `churned` | **no — drop the body** | no | no | **page the founder** — we are receiving a former customer's private messages |

A constraint makes `lifecycle='active'` with no published config *impossible*, rather than
merely discouraged.

### 2.2 Channel bindings are the routing registry

```sql
create table channel_bindings (
  tenant_id     uuid not null references tenants(id),
  provider      text not null references channel_providers(key),
  external_id   text not null,          -- Page ID, or IG professional account ID
  enabled       bool not null default false,
  token_status  text not null default 'unprovisioned',
  verified_name text,                   -- fetched live from Graph at onboarding
  ...
  unique (provider, external_id),       -- ONE identity → exactly ONE tenant
  constraint enabled_requires_name_confirmation
    check (not enabled or name_confirmed_at is not null)
);
```

`unique (provider, external_id)` is global and unconditional — a disabled binding still
*reserves* the identity, so moving a Page between tenants is an explicit delete, never an
accident. Two tenants claiming one Page is structurally impossible; the *attempt* raises
`23505`, which the admin route translates into "Page 1234 is already bound to
`matrix-eco`", not a 500.

`channel_providers` is a lookup **table**, not a Postgres enum: `alter type … add value`
cannot run in a transaction with surrounding DDL and cannot be rolled back, and a table
gives every provider an `enabled` flag — so pausing Instagram platform-wide is a row, not
a deploy.

### 2.3 The config is typed rows, not one JSON blob

Services, prices, staff, qualifiers, disclosure rules, answer rules, canned responses and
booking requirements are each their own table. The proof that this is vertical-neutral is
that Matrix and GS Auto differ only in **which columns are null, which booleans are false,
and how many rows are in each table**:

| Concept | Matrix Eco Salon | GS Auto Center | Dental clinic |
|---|---|---|---|
| `price_qualifiers` | none | `make`, `model`, `year` | `insurance_status` |
| `service_prices.quotable` | true on all 40 rows; children's has **no row at all** | false on brakes, bodywork, suspension | false after examination |
| `booking_mode` | `link` → matrixecosalon.org | `structured_handoff` | `link` |
| `disclosure_rules` | 1 × price | ~4 × price + 1 × safety | 1 × price, **2 × clinical_advice** |
| `staff_groups` | selectable, affects price | neither ⇒ section omitted entirely | selectable, not pricing |

**Vertical templates** seed a new tenant's draft with the right disclosure rules and canned
responses. A blank config is not neutral — in a regulated vertical it is unsafe by default,
and a clinic that starts empty starts with a bot willing to give a dose.

### 2.4 Per-agent pricing (your call, folded in)

Because Dala AI is sold **per agent**, entitlement is per capability, not one plan tier:

```sql
create table tenant_capabilities (
  tenant_id  uuid not null,
  capability text not null,   -- reception_messenger | reception_instagram |
  enabled    bool not null,   -- reception_comments | customer_care_sms |
  price_mnt  numeric,         -- analytics_monthly | quality_review | voice
  granted_by uuid not null,
  primary key (tenant_id, capability)
);
```

`enabled` has **no default** — onboarding must state it, so a missing row means *not
entitled* rather than *quietly on*. Each role carries its own price and therefore its own
margin floor and its own budget slice (§6.2). `quality_review` is opt-in with three values
— `off | metadata | full` — because a dental clinic will not sign a contract letting the
platform read every DM, but the tenant most likely to need a KB fix must not be the one
whose KB never improves.

### 2.5 Per-tenant secrets

A Meta Page token is per-tenant **data**, so it cannot come from the environment. Envelope
encryption: AES-256-GCM under a DEK, DEK wrapped by a KEK held in Vercel's environment.

Chosen over Supabase Vault deliberately. Both are equivalent against a stolen database
backup; they are **not** equivalent against a leaked `sb_secret_…` key — Vault decrypts on
read for the same credential that already has full data access, whereas the KEK lives
somewhere a Supabase key does not reach. For a public repo with a solo operator, a leaked
service key is the likelier incident.

`tenant_id || binding_id || kind` is passed as GCM additional authenticated data, so
copying one row's ciphertext onto another fails authentication instead of decrypting as the
wrong salon's token. Decrypt per request, never module-scope: Vercel reuses warm lambdas
across tenants, and a module-level `let token` is a cross-tenant credential leak with a
15-minute half-life — the same defect class as `lib/salonBrain.js:142`.

---

## 3. Meta webhook routing — one app, many pages

Full detail: [`architecture/03-meta-routing.md`](architecture/03-meta-routing.md).
Research: [`architecture/00-research-notes.md`](architecture/00-research-notes.md).

### 3.1 Signature proves authenticity, not identity

One app secret serves all tenants. `X-Hub-Signature-256` proves the event came from Meta.
It says **nothing** about which tenant it belongs to. These are two separate checks and
conflating them is how a multi-tenant bot leaks.

### 3.2 Routing is per entry, never per request

```
for each entry in body.entry:                     # ONE POST can carry two tenants
    key     = entry.id                            # Page ID | IG professional account ID
    binding = resolve_channel(body.object, key)   # server-side, exact match, enabled only
    if binding is null: 200 + drop + counter + alert    # NEVER auto-create a tenant
```

The ancestor never notices this because `extractActionableEvents` iterates `body.entry` and
**never reads `entry.id`** (`api/messenger.js:164-180`). Tenant routing does not exist in it
at all.

A cross-check against `messaging.recipient.id` (or `sender.id` for echoes) runs alongside,
because Chatwoot — production, multi-tenant, thousands of installs — does *not* route
Instagram by `entry.id` alone. Treat "same value everywhere" as something to measure, not
to trust. **This is the highest-value item on the re-verification list (§10).**

### 3.3 The 200/500 asymmetry — the subtlest decision in the document

| Condition | Response | Why |
|---|---|---|
| `channel_unresolved` — unknown Page | **200** + drop + persist tenant-less + alert | Permanent. Retrying cannot help, and sustained non-200s get the asset unsubscribed after ~1h — losing a **tenant** rather than a message. |
| `registry_unavailable` — database down | **500** | Transient. A 200 drops the event forever; a 500 gets it redelivered. |

Getting these the same way round costs either one message or one tenant's entire
subscription. The ancestor already has the instinct at one tenant — *"A timeout is
ambiguous: the publish may actually have landed at QStash. Only DEFINITIVE (hard) failures
are processed inline"* (`api/messenger.js:118-120`). This promotes it to a first-class rule.

### 3.4 Business Portfolio tokens

`GET /me/accounts` returns an **empty list** for Pages owned by a Business Portfolio — the
trap you named. The token is fetched by Page ID instead, and the whole acquisition runs
server-side inside one admin transaction: mint the token, `GET /{page-id}?fields=name` to
capture `verified_name`, envelope-encrypt into `channel_secrets`,
`POST /{page-id}/subscribed_apps`, insert the binding **disabled**. The founder then
confirms the fetched Page name before `enabled` flips true.

That route is the one that can half-succeed — a token stored but the subscription failing
leaves a tenant that will never receive a webhook. It is idempotent on
`(provider, external_id)`, rolls back to `unprovisioned` on any step failure, and may never
leave `enabled=true` with `token_status <> 'active'`.

A Graph `190` sets `token_status='revoked'`, stops **all** outbound on that binding, keeps
persisting inbound, alerts, and **never retries** — retrying a 190 in a queue is how one
tenant earns a rate-limit ban on the shared app. Per *binding*, not per tenant: Messenger
can die while Instagram lives.

> **Caveat you must read before building this.** `developers.facebook.com` was blocked by
> this session's network egress policy, so the research agent could not open a single page
> of Meta's primary documentation. Its findings are marked VERIFIED-local /
> SEARCH-CORROBORATED / SINGLE-SOURCE / UNVERIFIED individually. Everything below
> SEARCH-CORROBORATED must be re-checked from an unblocked network before it becomes code.
> The consolidated re-verification list is in the research notes.

---

## 4. Knowledge base and the owner update flow

Full detail: [`architecture/04-knowledge-base.md`](architecture/04-knowledge-base.md)

### 4.1 Whole-KB-in-prompt now, with a named trigger for change

**Measured in this checkout, 2026-08-30:** the live Matrix system prompt built by
`buildSystemPrompt()` is **7,824 characters, 61% Cyrillic, 12,866 UTF-8 bytes** for 40
services and 9 staff; the full cached Messenger block is 10,987 characters.

Mongolian Cyrillic is 2 bytes per character and thinly represented in BPE vocabularies, so
the token count is materially higher than an English document of the same length. **The
token count is an estimate and is flagged as one.** `tenant_config_snapshots.prompt_tokens`
exists as a column precisely so it stops being an estimate — the ancestor already logs the
true number on every call (`lib/salonBrain.js:249-253`).

Whole-KB-in-prompt is right for a 40-service salon. The trigger for moving to retrieval is
named with numbers, not left to judgement, and GS Auto's parts-and-labour catalogue is
expected to cross it.

### 4.2 The prompt is a build artefact

The runtime **never reads the knowledge tables**. It reads the immutable snapshot named by
`tenants.live_config_version`, so a half-finished edit cannot reach a customer. Publishing
inserts version N+1 and flips an integer; rollback is one write.

`content_hash` over the rendered blocks is the prompt-cache key. This replaces
`lib/salonBrain.js:142`'s module-scope singleton — the highest-severity multi-tenancy
defect in the ancestor, invisible at one tenant, and at two tenants on one warm lambda it
means **tenant B answered with tenant A's prices, staff and phone number**.

### 4.3 Deliberate omissions are data

Matrix's unpriced children's haircuts is today a code comment plus two divergent copies of
a string (`salonBrain.js:70-72` and `systemPromptBuilder.js:135`). It becomes one row in
`refusal_topics`, with `quote_price=false` and a bound canned response. The compiler then
emits the service name and the refusal and **no amount anywhere in the prompt**. Adding one
for tenant #3 is a form, not a deploy.

### 4.4 The owner update flow

The person maintaining this is a busy salon owner in Ulaanbaatar, on a phone, in Mongolian,
who did not ask for a CMS. The flow is designed around that, and around the honest risk
that it goes unused and the founder ends up making every change by hand — which would fail
the multi-tenancy test in a different way. Staleness is treated as a first-class failure
with detection, not as a hope.

---

## 5. Model choice per surface

Full detail: [`architecture/06-model-prompts.md`](architecture/06-model-prompts.md)

### 5.1 Three facts that decide most of it

**Fact 1 — Sonnet 5 supersedes the sibling's decision; it does not inherit it.** The
Core Language bake-off chose `claude-sonnet-4-6`. Sonnet 5 is newer *and* cheaper on both
directions ($2/$10 vs $3/$15) — **$0.00509/message against $0.00764, 33% less.** There is
no surviving argument for 4.6 on any Dala AI surface. The sibling's *conclusion* is dead;
its *method* is what we reuse.

**Fact 2 — Haiku's 4,096-token cache minimum is a silent economic cliff.** Below 4,096
tokens `cache_control` is ignored with no error, detectable only by both
`cache_creation_input_tokens` and `cache_read_input_tokens` returning 0.

| System prefix | Haiku 4.5 | Sonnet 5 (85% hit) | Winner |
|---|---|---|---|
| 3,400 tokens | **cannot cache** → $0.00502 | caches → $0.00509 | tie (1.4% apart) |
| 5,500 tokens | caches → $0.00312 | caches → $0.00624 | Haiku, exactly 2× |

At the prefix size Reception actually wants, **Haiku's half-price headline buys nothing** —
it pays full rate on the prefix every message while Sonnet 5 pays a tenth.

**Fact 3 — a live bug in the production Matrix bot, found while reading it.**
`lib/salonBrain.js:207-224` sends no `thinking` parameter. On `claude-sonnet-5`, omitting it
runs **adaptive thinking**. `MAX_TOKENS = 1024` (`salonBrain.js:21`) is a *shared* ceiling:
if thinking consumes 900 tokens, 124 remain for the Mongolian reply. `extractReplyText`
returns whatever text blocks exist, `capToSingleMessage` will not notice a mid-sentence
truncation, and `messengerProcess.js:115` sends it. **A customer can receive half a
sentence.** This is documentation-derived, not measured — but one added log field settles
it, and it is the cheapest measurement in the whole document.

### 5.2 The choices

| Surface | Model | Why |
|---|---|---|
| **Reception AI** | `claude-sonnet-5`, thinking **pinned disabled**, `max_tokens: 700`, non-streaming, **zero tools** | Incumbent for a production-observed reason; Haiku within 1.4% at the design prefix; Opus 5 is 2.5×. Thinking disabled explicitly — a two-sentence price answer needs no reasoning, and Fact 3 shows what the default costs. |
| **Quality layer** | Stage 1 `claude-sonnet-5` triage → Stage 2 `claude-opus-5` deep review, **both on the Batch API** | Internal, no latency constraint, being right beats being cheap. Batch's 50% discount is free money. $3.92/tenant-month vs $14.25 single-stage — but measure single-stage Opus at low effort first before shipping the cascade. |
| **Analytics AI** | `claude-sonnet-5`, Batch, structured output | ₮48/tenant-month vs ₮119 on Opus. Pick on Mongolian narrative quality; the delta is ₮71. |
| **Customer Care copy** | `claude-opus-5`, adaptive thinking, high effort, refusal fallbacks on | ~60 drafts/month platform-wide = **$2.55/month total**. Irreversible output to a real phone; no cost argument for anything cheaper. |

**Model ids are platform constants, never per-tenant free text.** The tenant carries a
`model_tier`; one registry maps tier → id. A per-tenant model id would let a tenant's config
change what *we* pay per message — spend is ours, so the lever must be ours. A CHECK
constraint rejects date-suffixed ids, because the ancestor already has one:
`api/chat.js:13` pins `'claude-haiku-4-5-20251001'` while `salonBrain.js:19` pins
`'claude-sonnet-5'` — two channels, two models, one stale.

**Analytics has one rule above model choice: the model never computes a number.** Every
figure comes from SQL and is passed in as a labelled fact; the model only narrates it in
Mongolian. A post-check extracts every digit-group from the output and requires each to
appear in the fact sheet. Any invented digit fails the run into a fully templated report
**and raises an alert**. A month of plain templated Mongolian is fine. A month with a
hallucinated revenue figure is the end of the business.

### 5.3 The boundary gate, hardened the way the bake-off says

The transferable finding: *a rule that only describes the right answer loses to the model's
disposition; a rule that forbids the specific wrong answer does not* — promoted to a
first-line gate with an explicit decision step, not left mid-list.

Six checks run before anything else, in order, in Mongolian, and the model stops at the
first that matches:

| | Failure guarded |
|---|---|
| Ш1 | A price not in the knowledge base |
| Ш2 | An invented booking confirmation |
| Ш3 | Invented staff availability |
| Ш4 | A medical/health question about a treatment |
| Ш5 | Abuse or off-topic |
| Ш6 | A question the KB does not cover |

Each names the **forbidden openings** explicitly — for Ш1 that is «ойролцоогоор», «орчим»,
«-аас эхэлдэг», «дунджаар», «магадгүй», «том хүнийхээс хямд» and others — then gives a
worked wrong example *with the reason it is wrong*, then pins the exact correct sentence to
be copied letter for letter. Ш4's forbidden opening «Санаа зоволтгүй» is the **measured**
Sonnet disposition from the sibling bake-off, not a guess.

Two honesty constraints on this, both structural:

- **Four of the six failures are hypothesised**, not measured. Shipping the text is correct;
  presenting it as validated is not. §6.9 of the section file is the bake-off that turns
  them into evidence — and unlike next door, Dala AI logs conversations from day one, so
  the transcript-capture problem does not recur.
- **Every Mongolian string must be native-speaker reviewed before it ships.** The schema
  enforces this: `canned_responses.reviewed_at` is null until a human signs off, and the
  prompt renderer *refuses to build a prompt* containing an unreviewed line, 503ing with
  `canned_response_unreviewed`. An unprovisioned tenant is an operator-visible state, not a
  silent degradation.

### 5.4 Prompt injection

"Sanitize the input" is **not** a security control — the sibling's own note. The defence is
structural: Reception AI has **zero tools**. It cannot spend, write, book, change the KB, or
read another tenant. The worst a malicious customer can achieve is a bad sentence in their
own conversation. Tenant KB text is *also* treated as untrusted input, because a tenant
owner types it.

---

## 6. Spend: no tenant ever spends unmetered

Full detail: [`architecture/05-spend-ledger.md`](architecture/05-spend-ledger.md)

### 6.1 The order of operations

A ceiling checked *after* the call is not a ceiling. A reservation is inserted **before**
the model call and reconciled against actual `usage` after, so exhaustion is a database
refusal rather than a comparison against a possibly-stale read.

The concurrency race — two messages for one tenant both passing a check against the same
balance — is solved in Postgres with an atomic reserve, and the section states what that
trade costs.

**The forbidden pattern is named explicitly:** never
`try { checkQuota() } catch { continue }`. That exact shape was the HIGH finding in the
sibling's 2026-08-13 audit. Helpers return **503 on any error**. A 503 costs a retry;
failing open costs money — and here it costs *another tenant's* money, which is worse
because it is not yours to lose.

### 6.2 Six ceilings, none redundant

| # | Ceiling | Catches |
|---|---|---|
| 1 | Platform monthly / daily | Per-tenant accounting itself broken |
| 2 | Tenant monthly | A tenant become unprofitable; a slow leak |
| 3 | Tenant daily | A runaway, caught in hours not a month |
| 4 | Tenant × surface | Quality or Analytics eating Reception's budget |
| 5 | Per-conversation reply cap | A loop; the bot answering itself |
| 6 | Per-contact daily cap | One abusive customer, or a script |

### 6.3 The ceiling is a pricing decision, not an engineering guess

```
monthly_ceiling_usd = (agent_price_mnt × (1 − target_gross_margin)) / fx_mnt_per_usd
```

At ₮250,000/month and a 70% target margin: **$21.43/month**. That sits *below* the top of
the expected 300–600-conversation range — which is exactly the signal a ceiling should
give. At 600 conversations this tenant needs a bigger plan, and the ceiling is what tells
you, rather than the Anthropic invoice. With per-agent pricing this is computed per role
and summed.

Starting numbers — **every one is your call**: tenant monthly **$25** (₮87,500), tenant
daily **$3**, per-conversation 25 replies/24h, per-contact 40 replies/24h, platform monthly
**$120**, platform daily **$17**. Reception per reply is **$0.0051 cached / $0.0212 on a
cache miss** (≈₮18 / ≈₮74); blended at 20% miss ≈ **₮29**. FX ₮3,500/USD is a labelled
planning assumption; the live rate is a table column snapshotted onto every ledger row.

### 6.4 Two controls that depend on no read at all

The founding lesson of this document is that a read can lie. So:

```ts
// A stop that no query, cache, table or credential can change.
// effective_ceiling = min(this, the DB value) — the DB can only ever LOWER a ceiling.
export const SURFACE_HARD_CAP_USD_PER_DAY = {
  reception: 8, analytics: 5, quality: 5,
  care: 0,   // ZERO until the SIP trunk exists and a per-message price is known
} as const
```

`care: 0` refuses before an Anthropic client is constructed, carried directly from
`BANK_BUILD_BUDGET_USD` next door. **Zero is the only value that refuses without depending
on a read.**

Second, a hard monthly spend limit **at Anthropic**, outside this repository, at ~1.5× the
platform ceiling — the only control that survives a total logic failure in our own code.
*(Flagged assumption: that per-workspace spend limits exist. If they do not, hold Dala AI's
Anthropic balance deliberately small and top it up monthly, which achieves the same thing.)*

### 6.5 At the ceiling, and the alert

Degradation is a ladder ending in a **reviewed Mongolian message handing off to the
tenant's phone** — never silence, never an English error. Soft warn at 80%, hard stop at
100%.

Telegram alerts fire on: 80% and 100% of any ceiling, token expiry, an unknown Page ID
(≥3/hour for one `external_id`), ledger unavailable, platform ceiling, and spend spikes.
Alerts are deduplicated so a runaway does not send 500 messages, and the design states what
happens when Telegram itself is down.

**An alert is not a control.** The ceiling stops spend; the alert only tells you.

---

## 7. The four roles, the Quality layer, and the seams

Full detail: [`architecture/07-roles-seams.md`](architecture/07-roles-seams.md)

**Reception AI** (build now) — answers from the KB, hands over a booking **link**, never
books. Its capability contract is stated as refusals. Comment replies are treated as a
different product from DMs, with loop prevention against its own and the tenant's comments.

**Customer Care AI** — seam only. The enforcement is structural, not a boolean: a
provider-agnostic `outbound_messages` table, a `MessageTransport` interface, and
`NullTransport` as **the only implementation**. There is no code path from "the model
produced text" to "a customer's phone rang". Consent and opt-out are modelled **across all
four roles**, not just the one that sends. Note from the research: Meta's outbound tags
`CONFIRMED_EVENT_UPDATE` / `ACCOUNT_UPDATE` / `POST_PURCHASE_UPDATE` were retired
2026-04-27 and now return error `100`, so this really is SMS-or-nothing.

**Analytics AI** — see §7.1 below. It is also Dala AI's **first scheduled spender**, and
therefore the first place the sibling's "NOTHING SPENDS ON A SCHEDULE" rule binds: fan-out
enqueues one message per tenant, the cron itself touches no model, `unique (tenant_id,
period_start)` makes a double-fire hit a constraint rather than a second bill, and a tenant
with a zero analytics budget still gets a **fully templated** report with no model and no
spend.

**Voice AI** — a row in `platform_capabilities` with `enabled=false` and no code behind it.
That is the Phase-4 seam: a row, not a stub.

**Quality layer** — internal, admin-only, never client-facing. Two-stage batch review that
emits `kb_change_proposals` rows carrying the evidence (which conversation, which turn). It
**can never auto-apply**; approval writes the draft only, and publishing remains a separate
deliberate act.

### 7.1 Attribution, solved honestly

Reception sends a link; the booking happens on the tenant's own website; money changes hands
in a chair. **Dala AI has direct evidence of none of it.**

The commercial temptation — *"Dala AI drove ₮4.2 сая this month"* — sells the product until
the day a tenant checks and it is wrong. Once. So:

> **An estimate may never appear without its inputs printed beside it, and no number may
> appear in prose that did not come from SQL.**

Three tiers, visually and lexically distinct in the Mongolian report:

| Tier | Label | What it is |
|---|---|---|
| **A — Fact** | **Баримт** | Observed directly in our own database: messages, conversations, first-response time, handoffs, links sent, links **clicked** |
| **B — Confirmed** | **Баталгаажсан** | A fact plus a join the tenant supplied or their system confirmed |
| **C — Estimate** | **Тооцоолол** | Arithmetic over A/B using an assumption **the tenant supplied** |

Tier C never renders without its arithmetic inline: *"12 баталгаажсан захиалга × 85,000₮
(Танай өгсөн дундаж дүн) = 1,020,000₮."* With no tenant-supplied average ticket the revenue
line is **absent, not zero.**

The measurement chain is a Dala-owned signed redirect (`l.dala.mn/r/<token>`) whose
destination is *inside* the token, so the redirect does not touch the database on the hot
path — because putting a Dala hop in front of a tenant's booking link makes us a dependency
of their revenue, and if our database is down the redirect must still work. Click counts are
filtered for Messenger/Instagram link prefetch and **both raw and filtered numbers are
reported**, with the rule disclosed. Never quietly report the flattering one.

The report ends with two non-optional sections: **«Бидний харж чадахгүй зүйл»** (what we
cannot see — phone bookings, walk-ins, copied links) and **«Хэрхэн тоолсон бэ»**
(methodology). That first section is not a disclaimer to bury; it is the reason a tenant
believes the other six, and it is a sales asset.

> **Highest-value ten-minute check in this document:** does `matrixecosalon.org`'s booking
> flow preserve an unknown query parameter through to confirmation? If yes, Matrix reaches
> Tier B. If no, Matrix is capped at Tier A + C forever. The research agent's request was
> blocked by this session's egress proxy, so this is **unverified** and needs a browser.

---

## 8. Database, RLS and grants

Full detail: [`architecture/02-schema-rls.md`](architecture/02-schema-rls.md)

Shared schema, `tenant_id uuid not null` on every tenant-scoped table, RLS per tenant, plus
a **composite-FK spine** — child rows reference `(tenant_id, parent_id)`, so a row cannot be
attached to a parent belonging to another tenant even when the writer is `service_role`.
That spine is the real last line of defence, because `service_role` bypasses RLS: RLS
protects you from a *client*, the spine protects you from *your own bug*.

**Server-owned tables** — spend, plan, analytics figures, quality verdicts — get the full
treatment: `SELECT`-only client grants, a restrictive `_no_client_writes` policy
(`with check (false)`), and an explicit revoke of **all seven** Postgres privileges where
not needed. `revoke insert, update, delete` is not "the client cannot write": TRUNCATE sits
outside RLS entirely and would empty the table. Ownership RLS checks **who a row belongs
to, never what it says**.

**Verification is a protocol, not a claim.** Runnable catalog SQL against `pg_policies`,
`pg_class.relrowsecurity`, `relforcerowsecurity` and `aclexplode(pg_class.relacl)`, plus the
"which table did I forget" query listing every `public` table with RLS disabled or zero
policies. `information_schema.role_table_grants` and `supabase_migrations.schema_migrations`
are **not trusted**, for the reasons the sibling audit records.

One finding worth surfacing here: **a policy on a table with RLS off is created
successfully, looks perfect in `pg_policies`, and is never evaluated.** The verification
pack must assert `relrowsecurity` per table independently — the sibling's last failure was
partial, one of four tables.

**Migrations go through the Supabase CLI with a real ledger from day one.** Repeating the
dashboard-SQL-editor gap next door is the one lesson it would be inexcusable to drop, and
the section states what adopting the CLI costs.

**Cyrillic is enforced at the schema level**, and I verified these by execution:

- NFD-decomposed `Сайн байна уу` **fails** the ancestor's greeting regex entirely (13 vs 15
  code units, same visible text). The ancestor has **zero** normalisation calls anywhere.
- `/^(сайн|байна|уу|…)/i` matches **`Уучлаарай`** — an apology is classified as a greeting
  and the customer's real question is never answered. `LOCATION_REGEX` matches `хаяг`
  anywhere, so "Facebook хаяг байна уу" returns a Google Maps card.
- `lib/validator.js:201`'s gibberish class `/^[^аеёиоуыэюя\s]{20,}$/i` is the **Russian**
  vowel set — missing `ө` and `ү`, so strings of exactly the two letters that most
  distinguish Mongolian from Russian are classified as *having no vowels*.
- `unaccent` must **not** be installed: it maps `Ё→Е` while leaving `Й`, `Ө`, `Ү` untouched
  — *partially* destructive, so it looks harmless in nine tests of ten. `Ё` is a full letter.
- `datcollate` must not be `C`/`POSIX` — `lower('ҮС ЗАСАЛТ' collate "C")` returns the string
  **unchanged, silently** — and it cannot be changed after database creation, so it is a
  catalog assertion on day one.

Both of the last two are catalog assertions in the verification pack, because neither is
fixable in place later.

---

## 9. Onboarding Matrix, and the tenant-#3 proof

Full detail: [`architecture/08-onboarding.md`](architecture/08-onboarding.md)

**Topology:** Next.js 14.2 App Router on Vercel, TypeScript, Supabase, Upstash. Every
cost-bearing route exports `POST` — which also sidesteps the GET-caching trap — and all
Supabase access goes through a shared client with `cache: 'no-store'`, with
`scripts/check-supabase-nostore.mjs` ported on day one. **Per-tenant values are data; the
env var list is platform-level only.**

Ten phases, each step naming who does it and **how you verify it worked**: platform stands
up → Meta app and App Review (starts day 1, runs in parallel because it is the long pole) →
tenant record, channel identities, secrets → webhook subscription and *proof of delivery* →
config becomes data → budget and alerts, **including deliberately tripping a low test
threshold to confirm Telegram fires** → catalog verification in production, pasted → 
acceptance tests → cutover → handover.

The acceptance tests are written as pass/fail, not vibes: a message from a phone that is not
yours on both Messenger and Instagram, a comment reply, a booking-link handoff, the
**children's-haircut question which must refuse to quote**, an abusive turn, and a question
the KB does not cover.

**The cutover is the moment of maximum risk.** Both bots are subscribed to the same Page;
the design sequences it so the salon never has two bots replying or zero bots replying, and
rollback is minutes.

**Tenant #3's checklist is the proof the platform works** — and the section names honestly
any step that would *still* force a code change. That list is the real backlog.

---

## 10. What is verified, what is assumed

**Verified by execution or by reading the file (cited throughout):** the ancestor's every
hardcoded-tenant site; the module-scope prompt cache; the missing `entry.id` routing; the
adaptive-thinking/`max_tokens` interaction; the three Cyrillic matching failures; the
Russian-vowel gibberish filter; the live prompt's 7,824-character size; Postgres collation
and `unaccent` behaviour (one research agent stood up a local PostgreSQL 16.13 and verified
its claims by execution).

**Assumed, and flagged wherever it appears:** every Meta Graph API fact above
SEARCH-CORROBORATED (the docs were unreachable from this session); the Mongolian token
counts; the FX rate; conversation volumes; whether `matrixecosalon.org` preserves a query
parameter; whether Anthropic supports per-workspace spend limits; and every Mongolian
string, which needs native-speaker review before it ships.

**Nothing here has been built or run against a live system.** No Supabase project exists, no
Meta app is configured, no code has been written.

---

## 11. Open questions — your call, not mine

1. **Per-agent prices.** The margin-floor formula needs a price per role and a target gross
   margin. ₮250,000/month and 70% are placeholders I invented to make the arithmetic
   concrete.
2. **The six starting ceilings** in §6.3 — all placeholders derived from assumed volumes.
3. **Does Matrix's booking site preserve a query parameter?** Ten minutes with a browser,
   and it decides whether Analytics can ever reach Tier B for tenant #1.
4. **Meta re-verification** from an unblocked network, especially: what `entry[].id`
   actually contains for `instagram` objects versus what onboarding must store.
5. **Native-speaker review** of every Mongolian string, particularly the six boundary-gate
   refusals.
6. **Is Matrix's existing bot switched off at cutover, or run in parallel?** The design
   proposes a sequenced cutover; the risk appetite is yours.
7. **Quality layer defaults** — is `full` acceptable to sell, or should new tenants start at
   `metadata`?
8. **One Meta app or one per tenant?** The design assumes one. It is the right default and
   it concentrates App Review risk.
9. **Whether to run the pre-launch bake-off at all** (~$0.45 of model spend) or ship the
   hardened prompt on the strength of the sibling's method.

---

## 12. Recommended order from here

1. Approve or amend this document. Nothing is built until you do.
2. The **ten-minute checks** first, because they change the design: the booking-site query
   parameter, and one extra log field on the ancestor to settle the thinking/`max_tokens`
   question (Fact 3, §5.1) — that one may be a live customer-facing bug today.
3. Meta App Review **started immediately** — it is the long pole and it blocks the cutover.
4. Then Phase A of the onboarding checklist: the platform stands up with the RLS
   verification pack green before a single tenant row exists.

---

*Full sections: [`docs/architecture/`](architecture/). Research and verification notes with
per-claim provenance: [`docs/architecture/00-research-notes.md`](architecture/00-research-notes.md).*
