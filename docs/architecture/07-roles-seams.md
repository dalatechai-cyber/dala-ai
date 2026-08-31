> **The DDL in this file is superseded.** It was one of eight independently written
> proposals, and [`09-reconciliation.md`](09-reconciliation.md) arbitrated the twenty-three
> places they contradicted each other. The schema is
> [`../schema.md`](../schema.md) + `supabase/migrations/0001_initial_schema.sql`, which
> is applied and verified; where this file disagrees with either, this file is stale.
> The reasoning here is still live — it is why the schema is shaped as it is.

## 7. The four AI staff roles, the Quality layer, and the phase seams

> **Citation convention.** Every claim about existing code is cited as an absolute `path:line` and was read in this session. Claims marked *(assumed)* or *(unverified)* are inference I could not confirm from a file or a primary source. Ancestor repo root: `/home/user/Matrix-Chatbot`. Sibling lessons: `/home/user/dalatech-english/CLAUDE.md` and `/home/user/dalatech-english/docs/`.

---

## 7.0 The spine all four roles stand on

Four "AI staff" is a **sales taxonomy**, not four systems. If it becomes four systems you get four tenant resolvers, four budget checks, four consent gates and four ways to leak a page token. One runtime, one gate; a role is a row.

### 7.0.1 A role is data, not a deployment

```sql
create table roles (                        -- platform-owned, seeded, never per-tenant
  role                 text primary key,    -- 'reception'|'care'|'analytics'|'voice'|'quality'
  is_client_facing     boolean not null,    -- quality = false. Enforced, not remembered.
  requires_transport   boolean not null,    -- care = true; no transport exists (§7.2)
  requires_data_source text                 -- care = 'appointment_feed'; null otherwise (§7.2.0)
);

create table tenant_roles (
  tenant_id          uuid not null references tenants(id),
  role               text not null references roles(role),
  state              text not null default 'off'
                       check (state in ('off','trial','active','suspended','degraded')),
  monthly_budget_usd numeric(10,4) not null default 0,   -- 0 refuses without reading anything
  config             jsonb not null default '{}',        -- per-role policy, validated on write
  enabled_at         timestamptz,
  enabled_by         uuid,                               -- founder user id — an audit fact
  primary key (tenant_id, role)
);
```

`monthly_budget_usd` defaults to **0**, not null, for the reason `BANK_BUILD_BUDGET_USD` is 0 next door (`/home/user/dalatech-english/CLAUDE.md`, "The quiz bank build is CLOSED"): zero is the only value that refuses *without depending on a read that might be stale or cached*. A new tenant row cannot spend before a human sets a number.

### 7.0.2 One gate, four steps, in order, each failing closed

```ts
// The ONLY way to obtain a tenant-scoped client, a budget reservation, or a send
// capability. There is no second implementation. A route that does not call this
// cannot spend and cannot send.
async function withTenantRole<T>(
  ctx: {
    tenantId: string;
    role: RoleName;
    op: string;
    estCostUsd: number;
    initiated: boolean;      // REQUIRED. true = we are starting contact; false = we are replying.
    personId?: string;       // REQUIRED when initiated === true. Refused otherwise.
    channelKind?: ChannelKind;
    purpose?: OutboundPurpose;
  },
  fn: (t: TenantContext) => Promise<T>
): Promise<T>
```

1. **Identity — who is this tenant?** Inbound webhooks resolve the tenant *server-side* from `(object, entry[].id)` through `channel_identity`, primary key `(provider, external_id)`, never from anything else in the request body. Unknown identity → 200 + drop + `webhook.unrouted` counter + alert. **Never auto-create a tenant from a webhook.** Dashboard traffic resolves through `current_tenant_ids()`.
2. **Entitlement — is this role on, and are its prerequisites present?** `tenant_roles.state ∈ {active, trial}`, else `403 role_not_enabled`. A failed read yields `undefined` and is refused — the `profiles.tier` nullable-with-no-default posture applied to roles. If `roles.requires_transport` and no transport resolves → `503 no_transport`. If `roles.requires_data_source` and the tenant has no such feed → `503 no_data_source`. Two absent prerequisites, one refusal mechanism.
3. **Consent — may we speak to this person at all?** Checked *here*, not in a role module. `initiated === true` requires `personId`, a null `persons.blocked_at`, and a `granted` row for `(channel_kind, purpose)`. `initiated === false` (a reply inside a live window) skips the consent lookup but still checks `persons.blocked_at`.
4. **Budget — can this tenant afford this call?** A **reservation row is inserted into `spend_ledger` before the upstream call**. The ceiling is enforced by a constraint on the insert, so exhaustion is a database refusal, not an application comparison against a possibly-stale read. Any error from the ledger helper returns **503**. Never `try { check() } catch { continue }` — that exact pattern was the HIGH finding in the 2026-08-13 audit next door.

> **Consent moved into the gate because the draft's version did not work.** An earlier draft put consent at step 8 of Reception's pipeline while asserting in prose that it lived in the gate — and the gate's signature had no person in it, so it structurally could not evaluate consent. The concrete miss was not Phase-4 Voice but **comment private replies (§7.1.6)**, which fire a DM at someone who never DM'd us and whose `persons.blocked_at` nothing on that path read. `initiated` and `personId` are now parameters of the gate, and reactive replies pass `initiated: false` **by declaring it**, not by omitting a field.

> **Why reserve rather than write after.** The ancestor spends with no ceiling at all: `generateSalonReply` checks only that `ANTHROPIC_API_KEY` exists (`/home/user/Matrix-Chatbot/lib/salonBrain.js:178-181`) and calls the API. There is no cost, budget, quota or ledger symbol anywhere in that repo. The only bound on Messenger spend today is how fast a human can type into the Page. With N tenants that becomes "how fast any human can type into any of N Pages", and a runaway is now *another tenant's* money — worse than losing your own, because it is not yours to lose.

### 7.0.3 The four roles as capability sets

| | Reception | Customer Care | Analytics | Voice | Quality |
|---|---|---|---|---|---|
| Phase | **Build now** | Seam only | Build now (v1.1) | Phase 4, seam only | Build now, internal |
| Direction | inbound-triggered reply | **tenant-initiated** | none (report) | inbound + outbound | none |
| Reads KB | yes | templates only | no | yes | yes |
| Writes KB | never | never | never | never | **proposes only** |
| Client-facing | yes | yes | yes (report) | yes | **never** |
| Budget bucket | `reception` | `care` | `analytics` | `voice` | `platform_ops` |
| Queue | `q:reception` | `q:care` | `q:analytics` | — | `q:quality` |

Separate queues and separate budget buckets are the bulkhead. Analytics burning its month's budget on the 1st must not stop Reception answering a customer on the 2nd (§7.6.4).

---

## 7.1 Reception AI — build now

### 7.1.1 The capability contract, stated as refusals

Reception's contract is a set of **negative** capabilities, each enforced in code or schema, not only in the prompt. This is the bake-off's transferable finding: *"a rule that only describes the right answer loses to a model's disposition; a rule that forbids the specific wrong answer does not"* (`/home/user/dalatech-english/docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`, "The technique that worked").

Reception **can**: answer from the tenant KB in Mongolian inside a customer-initiated window; send the tenant's booking **link** (tracked, §7.3); reply to a public comment under a per-tenant policy (§7.1.6); hand off to a named human path (§7.1.4); record an opt-out arriving in a DM (§7.2.5).

Reception **cannot**, and the enforcement is named:

| Cannot | Enforced by |
|---|---|
| Book an appointment | No booking adapter exists — no calendar write path, no tenant credential for one. |
| Quote a price on a refusal topic | `refusal_topics` row with `quote_price = false`, **plus** an output guard (§7.1.7). |
| Initiate a conversation | Reception has no `MessageTransport`; the send helper takes a `conversation_id` and refuses when `window_expires_at < now()`. |
| Compose a date, a closure sentence, or a handoff apology | Those strings come from `canned_responses` / `tenant_closures`, quoted verbatim (`/home/user/Matrix-Chatbot/config/closures.js:38`, `/home/user/Matrix-Chatbot/lib/salonBrain.js:48-51`). |
| Take payment | Out of scope. The ancestor hardcodes `QPay-ээр` into the booking sentence (`/home/user/Matrix-Chatbot/lib/salonBrain.js:79-81`); here payment language is a per-tenant string with no platform meaning. |
| See another tenant's anything | `withTenantRole`, composite FKs carrying `tenant_id`, tenant-prefixed cache/queue/ratelimit keys (§7.6.3). |

### 7.1.2 The conversation lifecycle

```sql
persons          (tenant_id, id, blocked_at, ...)                 -- §7.2.5
contacts         (tenant_id, id, person_id, channel_id, external_user_id, ...)
  -- one row per (tenant, channel, PSID/IGSID). PSIDs are page-scoped and IGSIDs are
  -- account-scoped: the same human is a DIFFERENT external_user_id at Matrix and at
  -- GS Auto. That is exactly why the key carries tenant_id and channel_id.

conversations    (tenant_id, id, channel_id, contact_id, state,
                  opened_at, last_inbound_at, window_expires_at,
                  handoff_state, kb_version_at_open, ...)
  unique (tenant_id, id)                          -- enables the composite FK below

messages         (tenant_id, id, conversation_id, direction, external_id,
                  role, body, body_nfc, modality, media_ref,
                  tokens_in, tokens_out, cost_usd, ...)
  -- modality: 'text'|'audio'|'image'|'file'  (audio reserved for Voice, §7.4)
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id),
  unique (tenant_id, channel_id, external_id)     -- the idempotency key
```

The composite FK is the one check the database still enforces against a service-role scoping bug, because the whole inbound path runs as `service_role` with `BYPASSRLS` and RLS protects nothing there. A message can never attach to another tenant's conversation. `modality` and `media_ref` are in the DDL from day one so §7.4's seam attaches to a table that actually has the columns it names — the earlier draft's Voice paragraph referenced fields the schema did not contain.

**States:** `active` → `awaiting_human` → `human_handled` → `closed`, plus `paused_budget` and `paused_role_off`. Transitions are rows in `conversation_events`, not an overwritten column: Analytics and Quality both need the history and neither may re-derive it from prose.

**The pipeline, in strict order.** Each step fails closed.

```
WEBHOOK (must ACK 200 in seconds)
 1. read RAW bytes; verify X-Hub-Signature-256 constant-time (secret missing → 401)
 2. FOR EACH entry: resolve tenant from (object, entry.id) via channel_identity
 3. insert into webhook_events (tenant_id, provider, external_id) ON CONFLICT DO NOTHING
 4. enqueue per-entry onto q:reception, tenant_id inside the SIGNED body
 5. 200

WORKER
 6. verify queue signature; re-derive tenant from the signed body; assert it matches the
    channel_identity for the payload's entry id (mismatch → drop + alert)
 7. withTenantRole({role:'reception', initiated:false, personId})
       → identity · entitlement · consent(blocked_at) · budget reservation
 8. hydrate: conversation, contact, last N messages, immutable tenant policy snapshot
 9. policy layer: closure? out of hours? refusal topic matched? → may short-circuit
10. deterministic shortcuts (location / greeting) — no model call
11. retrieval over kb_entries → snippets
12. generate (Anthropic), two-block prompt (§7.1.8)
13. OUTPUT GUARDS (§7.1.7) — may replace the reply with a pinned line
14. send (one atomic Send API call)
15. commit: mark handled, append messages, write spend_ledger actuals, emit metrics
```

**Steps 1–5 are lifted from the ancestor and the reasoning must survive the rewrite.** The webhook does nothing expensive before the ACK (`/home/user/Matrix-Chatbot/api/messenger.js:109-145`), because Meta retries a slow webhook and after ~1h of failures **unsubscribes that Page** — a silent, total outage for one tenant, discovered not from a request but from the absence of requests. Two subtleties to carry verbatim:

- **An ambiguous enqueue failure is not a failure.** `/home/user/Matrix-Chatbot/api/messenger.js:118-127` distinguishes a *timed-out* publish (which may have landed) from a *hard-rejected* one and processes only hard failures inline. Processing a timed-out-but-succeeded publish inline too double-replies the customer — and here it also double-charges the tenant.
- **Send first, mark handled second** (`/home/user/Matrix-Chatbot/lib/messengerProcess.js:111-116`), with the reply capped to a single Send API call first (`/home/user/Matrix-Chatbot/lib/messengerText.js:66-84`), so a failure leaves nothing delivered and the retry is clean.

**Two things change at step 3.** Today dedup is a Redis `get`/`set` that **fails open** on any error (`/home/user/Matrix-Chatbot/lib/conversationStore.js:51-56`, and `markHandled` silently no-ops), with QStash's `deduplicationId` (`/home/user/Matrix-Chatbot/lib/messengerQueue.js:66`) as the second layer. Those two layers fail together in exactly the case that matters: the degraded inline path runs when QStash is unconfigured or hard-failed, which is precisely when there is no `deduplicationId` either. Here the idempotency key is a **unique constraint in Postgres**, checked before the model call, because a duplicate now costs a tenant's money.

**And `getHistory`'s `null` vs `[]` distinction must survive.** `/home/user/Matrix-Chatbot/lib/conversationStore.js:86-90` returns `null` when Redis is unreachable and `[]` only when Redis genuinely answered "no turns"; the consumer at `/home/user/Matrix-Chatbot/lib/messengerProcess.js:58-60` treats `null` as "assume an ongoing conversation". Without it a cache hiccup mid-conversation makes the bot greet an existing customer from scratch.

### 7.1.3 The booking handoff — a link, never a booking

```sql
create table tenant_booking (
  tenant_id           uuid primary key references tenants(id),
  mode                text not null check (mode in ('link','phone','none')),
  destination_url     text,           -- host must exist in tenant_domains; checked at write time
  deposit_text        text,           -- per-tenant, verbatim (Matrix: QPay deposit language)
  booking_template_id uuid references canned_responses(id)   -- pinned, one {{link}} slot
);
```

The booking reply is a **pinned template with exactly one substitution slot**, filled with a tracked URL (§7.3.3), never by the model. The ancestor already found out why the sentence must be pinned: its base prompt's example dialogues end bookings with a website *"Цаг захиалах" button* CTA that does not exist on Messenger, so `BOOKING_LINE` had to be pinned to remove the contradiction — the comment at `/home/user/Matrix-Chatbot/lib/salonBrain.js:74-78` says exactly that.

**The dangerous failure is a false confirmation.** A customer writes «Маргааш 4 цагт болох уу?» and the model answers «Тийм ээ, боллоо». Nothing was booked. Three layers, because the prompt alone will lose:

1. **Prompt** — a first-line gate naming forbidden openings: never «боллоо», «баталгаажлаа», «захиаллаа», «бүртгэлээ»; never a specific date/time as an offer.
2. **Output guard** — if `mode='link'` and the reply contains a confirmation token from the per-tenant list, discard the model's reply, send the pinned booking template, emit `guard.false_confirmation` → a Quality flag (§7.5).
3. **The absence of a booking adapter.** A model that hallucinates a booking has still not made one, and the guard means the customer is not told otherwise.

GS Auto Center sets `mode='phone'` and a different template. No branch.

### 7.1.4 Handoff to a human

**Triggers** (per-tenant in `tenant_roles.config`, all on by default except #8):

| # | Trigger |
|---|---|
| 1 | Customer explicitly asks for a person — exact-match phrase list, NFC-normalised, per tenant |
| 2 | Nothing in the KB answers it — the model emits the pinned handoff line; the ancestor restricts this to exactly two cases, which is the right shape |
| 3 | A refusal topic matched (children's prices) — soft handoff: give the phone, lower severity |
| 4 | An output guard tripped (§7.1.7) |
| 5 | Budget exhausted / role degraded (§7.7) |
| 6 | N turns without resolution (default 6; off for GS Auto, where diagnostics run long) |
| 7 | Attachment / voice note / image received — Reception cannot read it; hand off rather than guess |
| 8 | Complaint or escalation language — **opt-in, default off**; false positives are expensive and the phrase list must be native-reviewed per tenant |

**A handoff is a row first, a notification second.**

```sql
create table handoff_targets (           -- created ONLY at onboarding, by the founder
  tenant_id  uuid not null references tenants(id),
  id         uuid not null,
  channel    text not null check (channel in ('telegram','email')),
  address    text not null,              -- telegram chat_id | staff email
  quiet_hours_exempt boolean not null default false,
  primary key (tenant_id, id)
);

create table handoffs (
  tenant_id uuid not null, id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  trigger text not null, severity text not null check (severity in ('info','normal','urgent')),
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz, acknowledged_by text, resolved_at timestamptz,
  deep_link text not null,               -- m.me / ig.me thread link
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id)
);

create table staff_notifications (       -- INTERNAL. Never customer-facing.
  tenant_id uuid not null, id uuid primary key,
  handoff_id uuid not null,
  handoff_target_id uuid not null,       -- FK, NOT free text. See below.
  state text not null check (state in ('queued','sent','failed','dropped')),
  provider_message_id text,
  attempts int not null default 0, last_error text, sent_at timestamptz,
  foreign key (tenant_id, handoff_target_id) references handoff_targets (tenant_id, id),
  check (state <> 'sent' or provider_message_id is not null)
);
```

**`handoff_target_id` is a foreign key because the earlier draft's `target_ref text` was a live, free-text-addressed send path sitting outside every discipline in §7.2.** That critique is right and it is the sharpest finding against the draft: `staff_notifications` is the only outbound-to-a-human path that actually ships in v1, and with an unconstrained text address a later "tell the customer their handoff was picked up" feature could put a customer-supplied string in it and send, uncosted, unmetered, unconsented. With the FK, "notify a staff destination" is expressible and "notify an arbitrary address" is not — the same move as checking `tenant_booking.destination_url` against `tenant_domains`. **`staff_notifications` is deliberately outside `MessageTransport`** (internal operational alerting is not customer messaging and must not be gated on a customer-messaging trunk that does not exist); that exception is documented here rather than left to be discovered.

**Primary channel: Telegram, via a Dala-owned bot.** It costs nothing per message and needs no template approval — Messenger's outbound story is a minefield (§7.2.0) and SMS does not exist yet. The tenant starts the conversation, which yields the `chat_id` and is itself the consent artefact. It puts a push on a phone, which is where a salon owner is. Onboarding is a `handoff_targets` row: client #3 sends `/start`, the founder pastes the chat id. No code.

**Mandatory fallback: email**, at most one per handoff. **Canonical surface: the dashboard queue** — open handoffs with deep link, last five turns, and *Acknowledge*.

**The hard-won rule about the alert.** The sibling shipped a registration flow where Brevo returned 2xx and silently dropped the mail, indistinguishable in the logs from a healthy send (`/home/user/dalatech-english/CLAUDE.md`, "Email senders must sit on the authenticated domain"). Therefore: `state='sent'` requires `provider_message_id`, enforced by CHECK, so "we think we sent it" is not a representable state; **a 2xx from a notification provider means "accepted for delivery", never "delivered"**; and a **watchdog** every 15 minutes re-notifies once on any `urgent` handoff unacknowledged after 20 minutes, then alerts the *founder*. An unacknowledged handoff is the product failing, and the founder should learn before the tenant's customer does.

The customer never waits on the alert: at handoff time Reception immediately sends the tenant's pinned handoff line with the phone number — the shape of `/home/user/Matrix-Chatbot/lib/salonBrain.js:57-59`, now a `canned_responses` row with `reviewed_by` / `reviewed_at`.

**Deliberately not reused:** the ancestor's `logInteraction` (`/home/user/Matrix-Chatbot/lib/logger.js:12-19`) POSTs a 180-character preview of the customer's message *and* the reply to one global `LOG_WEBHOOK_URL` with a bare `catch {}`. Under multi-tenancy that is every tenant's customer data leaving to one destination, failing silently.

### 7.1.5 Business hours and closures

Two separate concepts. The ancestor conflates them into one env-var holiday with a **closure for Matrix shipped in the code** — `DEFAULT_CLOSURES`, Naadam 2026-07-11..17, verbatim Mongolian message (`/home/user/Matrix-Chatbot/config/closures.js:40-52`) — which would apply to any deployment that failed to override it. Both become tenant rows and there is **no default closure**.

```sql
create table business_hours (
  tenant_id uuid not null, dow smallint not null check (dow between 0 and 6),
  opens time, closes time, closed boolean not null default false,
  primary key (tenant_id, dow)
);

create table tenant_closures (
  tenant_id uuid not null references tenants(id), id uuid primary key,
  starts_on date not null, ends_on date not null, title text not null,
  verbatim_message text not null,        -- quoted letter-for-letter. Never model-composed.
  reviewed_by uuid, reviewed_at timestamptz,
  check (starts_on <= ends_on)
);
```

Three properties from the ancestor that must survive, each for a reason:

1. **The customer-facing sentence is never composed by the model.** Mongolian date suffixes are not safely generated, and a break announcement is the one message a customer must not misread. The shipped default's own comment (`config/closures.js:45-47`) shows the care involved: it says when *bookings resume*, not only when the salon reopens.
2. **The closure is evaluated per request, never cached with the base prompt** (`/home/user/Matrix-Chatbot/lib/salonBrain.js:140-141`, verbatim: *"a warm lambda can outlive the end of the break, and a cached section would keep announcing a holiday after the salon reopened"*). Generalised: the cached prompt block is keyed `(tenant_id, kb_version, channel, policy_hash)` and the closure/hours section sits **outside** it.
3. **A malformed closure is ignored with an alert, never announced.** Same instinct as `formatPriceList` refusing to render an unknown price shape *"rather than risk serving a category (e.g. children's) the official list doesn't carry"* (`/home/user/Matrix-Chatbot/lib/systemPromptBuilder.js:36-38`).

Timezone is `tenants.timezone` (IANA), **not** a platform constant: `SALON_UTC_OFFSET_MINUTES = 8 * 60` (`/home/user/Matrix-Chatbot/config/closures.js:32`) is right for Mongolia and wrong the first day the founder sells outside it.

**Out-of-hours behaviour is a per-tenant policy value:** `answer` (default — a price question at 23:00 is still a price question), `answer_no_commitments` (booking template suppressed), `acknowledge_only` (one pinned line, no model call). `acknowledge_only` is also the automatic degradation target when a budget is spent (§7.7): the bot keeps saying something true and human-routable instead of going silent.

**The clock must be injectable.** The ancestor's only test suite reads the real clock and has been red for six weeks — two tests assert the shipped Naadam closure is active and it ended 2026-07-17. A suite guarding *"once the break ends the bot must be what it was before"* was time-bombed the day it was written and nothing noticed.

### 7.1.6 Comment replies — a different product from DMs

A DM is private, revisable, bounded by a 24-hour window. A **public comment reply is a screenshot**.

```
tenant_roles.config.reception.comments = {
  mode: 'off' | 'acknowledge_only' | 'answer_from_kb',   -- DEFAULT: 'acknowledge_only'
  private_reply: boolean,                                 -- DEFAULT: false
  quote_prices_publicly: boolean,                         -- DEFAULT: false
  max_replies_per_post: int,                              -- DEFAULT: 20
  max_replies_per_hour: int                               -- DEFAULT: 30
}
```

`acknowledge_only` = one short pinned line inviting a DM: no prices, no model call, no spend. A wrong DM costs one customer; a wrong public price under a viral post costs the tenant's price list.

- **Facebook comments arrive on `object:'page'`, field `feed`** — there is no dedicated `comments` field, so you subscribe to the feed firehose and filter to `item='comment'`, `verb='add'`. Instagram comments arrive on `object:'instagram'`, field `comments`. Two shapes, one adapter table keyed by `(object, field)`, not two code branches.
- **Never reply to your own page's comments.** The ancestor's triple guard — `is_echo`, delivery/read receipts, and an explicit refusal to act on the Page itself (`/home/user/Matrix-Chatbot/api/messenger.js:169-173`) — exists because a bot answering its own outbound message loops until Meta rate-limits the Page. The comment path needs the same: skip if `from.id` equals the page/IG account id or matches a known staff identity.
- **A private reply is `initiated: true`.** It goes through `withTenantRole` with a `personId` and is refused for a blocked person. This is the case the earlier draft missed entirely.
- **The private reply is one-shot, expiring, non-idempotent.** One per comment ever; a second attempt returns subcode `2534014`; the window is **7 days from the comment's creation timestamp**, not from webhook receipt. Therefore: `private_replies (tenant_id, comment_external_id)` unique, checked **before** the send; `2534014` treated as **success-equivalent**, never retryable; the 7-day deadline checked **before** generation, in the same fail-closed ordering, because it is free and refusing early saves a paid call. *(Rule and subcode SEARCH-CORROBORATED only — re-verify against Meta's docs before implementing.)*
- **Comments are their own budget bucket and rate bucket.** Beyond `max_replies_per_post` the tenant is alerted and the bot stops. Silence with an alert beats a bill.
- **Enrichment is a metered call.** Comment payloads often omit media and parent context; an album comment does not carry the album id. Every enrichment `GET` is charged to the tenant's Graph rate budget and counted.

### 7.1.7 Deliberate omissions, and the output guard

The children's-haircut omission is the sharpest test in the product because it is a business decision to **not answer**, and the ancestor encodes it in three places: a comment in the data (`config/currentClient.js:34-35`), a pinned constant (`/home/user/Matrix-Chatbot/lib/salonBrain.js:67-72`), and a second copy inside the shared prompt template (`lib/systemPromptBuilder.js:135`). One fact, three copies, none of them data.

```sql
create table refusal_topics (
  tenant_id uuid not null references tenants(id), id uuid primary key,
  label text not null,                              -- 'children_services'
  match_terms text[] not null,                      -- NFC-normalised, case-folded, EXACT tokens
  quote_price boolean not null default false,
  verbatim_response_id uuid not null references canned_responses(id),
  forbidden_openings text[] not null default '{}',  -- the MEASURED wrong answers
  reviewed_by uuid, reviewed_at timestamptz
);
```

`forbidden_openings` is the bake-off technique made into a column. The prompt renders it as *"never say X, never say Y"* with a worked wrong example — not as a description of the right answer. The ancestor reaches for this instinctively: `CHILDREN_REPLY` is *"[p]inned verbatim like the other canned lines so the model cannot garble it"* (`lib/salonBrain.js:69`), and the pinning exists because live replies contained garbled Mongolian and an invented Russian word, `дополнительн` (`lib/salonBrain.js:48-51`). Making it a column means the founder adds the pattern for tenant #3 from a form — and, critically, that it is *measurable*: you populate `forbidden_openings` from observed failures.

**The output guard is the layer the ancestor does not have.** When a refusal topic matches and `quote_price = false`:

```
reply contains a digit-group of length >= 3, or '₮', or 'төгрөг'
   → DISCARD the model's reply
   → send canned_responses[verbatim_response_id] verbatim
   → emit guard.price_leak (tenant_id, topic, conversation_id) → Quality flag
```

Three honesty notes. It runs on **our own output**, never on customer text, so it does not violate the no-unanchored-patterns rule, and a false positive costs a pinned line — the safe direction. It does **not** catch spelled-out numerals («тавин мянга»); that gap is written down as a Quality detection target, not papered over. And `sanitizeForPrompt` next door is explicitly *not* a security control (`/home/user/dalatech-english/CLAUDE.md`, known issue #8) — this is a **business-rule** control with a known bypass and must never be described as a safety boundary.

**Match terms are exact tokens, not regexes.** The ancestor is the cautionary tale, and both defects are verified: `GREETING_REGEX = /^(сайн|байна|уу|hi|hello|hey)/i` (`/home/user/Matrix-Chatbot/lib/salonIntents.js:26`) is unanchored at the right edge, so «Уучлаарай асуумаар байна» — a commonplace Mongolian service opener — is classified as a greeting; `LOCATION_REGEX` matches «хаяг» anywhere (`:21`), so «Facebook хаяг байна уу» returns a Google Maps card, and `EMAIL_CONTEXT_REGEX` (`:25`) is a hand-patched symptom of exactly that, with more symptoms to come. Nothing in that repo calls `normalize()` anywhere, so `й`/`ё` typed on an NFD-producing keyboard silently fail to match.

The rule here: **NFC-normalise at the input boundary, case-fold Unicode-aware, tokenise, compare tokens against a per-tenant list.** No `\b` (JavaScript's `\b` is defined in terms of `\w`, permanently `[A-Za-z0-9_]`; the `u` flag does not change it), no `[a-z]`, no unanchored patterns over customer text. Where fuzzy matching is wanted, use an explicit `mn_fold` table (`ө→о`, `ү→у`, `й→и`, `ё→е`) applied to a *search column only* — never `unaccent`, which destroys `Ё→Е` while leaving `Ө` and `Ү` untouched, i.e. it is *partially* destructive on Mongolian and therefore looks harmless in nine tests out of ten.

### 7.1.8 Prompt assembly and caching

```
BLOCK 1 — cached, cache_control {type:'ephemeral', ttl:'1h'}
   key: (tenant_id, kb_version, channel, policy_hash)
   identity, language rules, channel rules, pinned KB (contact, hours, canned lines,
   refusal topics, pricing rules), forbidden openings
BLOCK 2 — uncached
   retrieved kb_entries snippets, active closure section, out-of-hours section
MESSAGES — the customer's own turns. NEVER inside a cache block.
```

The ancestor's cache reasoning is sound and must be carried, not re-derived: one block covering exactly the system prompt, breakpoint placed so customer history stays outside it (`lib/salonBrain.js:210-222`) — no customer's messages are ever written into an entry every other customer reads; the `1h` TTL justified against measured inter-message gaps; and every response logging `cache_read / cache_creation / uncached` counts (`:243-253`), because a cache miss is invisible in the reply and quietly bills full price. Here those counts become `spend_ledger` columns.

**The single most dangerous line to port is `let cachedBasePrompt = null` (`/home/user/Matrix-Chatbot/lib/salonBrain.js:142`)** — a module-scope singleton built once per process from a build-time `clientData` import. Two tenants on one warm Vercel lambda: tenant B is answered with tenant A's prices, staff names and phone number. A cross-tenant data leak, completely invisible at one tenant. Every module-scope cache here is keyed by tenant or does not exist. Related: `export const SALON_NAME = clientData.branding?.companyName` (`:46`) stamps every log line with the *build's* tenant rather than the *request's*; here `tenant_id` is on every log line, cache key, rate-limit key and queue message.

**Retrieval, not inlining.** The base prompt is 7,824 characters for 40 services and 9 staff; GS Auto's parts-and-labour catalogue cannot be rendered whole. Pinned entries always inline; the long tail is retrieved. On short, misspelt, code-switched Mongolian, embeddings or trigram similarity over a folded column beat Postgres FTS, which has no Mongolian configuration and no Mongolian stop-word list.

### 7.1.9 Reception failure modes

| Failure | Symptom without design | Response |
|---|---|---|
| Anthropic down / 429 / timeout | Customer gets nothing | Retry on the queue for **transient only**; on final attempt send the pinned fallback + phone. Distinguish **terminal** (401, budget exhausted, 4xx) from retryable — the ancestor rethrows on *any* brain failure (`lib/messengerProcess.js:101-109`) and burns four attempts on a missing API key. |
| Page token expired / revoked (`190`) | **Reception silently dead for that tenant. Nothing throws.** | `tenant_secrets.status='revoked'`, stop all sends, `tenant_roles.state='degraded'`, alert founder AND tenant. Never retry a `190`. |
| Tenant misidentified | Reply posted as the wrong salon | Never `/me/messages` (`/home/user/Matrix-Chatbot/lib/messengerClient.js:10`) — with `/me` a token/tenant mismatch **succeeds** and there is no error to catch. Always `/{page-id}/messages`, cross-checked against the token's owning tenant. |
| Token missing for a tenant | Falls back to a global token → tenant B sends on tenant A's credential | `pageToken(explicit) { return explicit \|\| process.env.PAGE_ACCESS_TOKEN }` (`lib/messengerClient.js:67-69`) must not survive. Token is a required argument; missing → `503 tenant_not_provisioned`. |
| Event delivered twice | Duplicate reply, duplicate spend | DB-unique `(tenant_id, channel_id, external_id)`, checked before the model call. |
| Budget exhausted mid-conversation | Bot goes silent on a Saturday | Degrade to `acknowledge_only` + handoff line + tenant alert. Never silence (§7.7). |
| Redis / queue unavailable | Degrades silently to best-effort, amnesiac, may double-reply | The ancestor has `memoryEnabled()` for exactly this signal and **never calls it** (`lib/conversationStore.js:130`). Here every degradation writes a `role_health` row and fires a notification. |
| Meta unsubscribes a Page | Total outage found from the *absence* of traffic | `channel_identity.last_webhook_at` watchdog + periodic `GET /{page-id}/subscribed_apps` reconciliation. |
| Config missing / malformed | Prompt renders with holes | Refuse to render, alert, fall back to `acknowledge_only`. Note the ancestor's opposite failure: a team member whose `gender` is not one of three literal values **silently vanishes** from the prompt — there is no `else` (`lib/systemPromptBuilder.js:68-85`) — which is how GS Auto's mechanics would disappear. The new renderer fails loudly. |

---

## 7.2 Customer Care AI — the seam, and nothing else

### 7.2.0 Two prerequisites are missing, not one

**No Mongolian SIP/SMS trunk exists.** That was the known gap. The second gap is larger and the earlier draft hid it: **Customer Care also has no event feed.** Every value of `purpose` needs something Dala AI cannot observe — `reminder` needs an appointment, `winback` needs a last-visit date, `review_request` needs a completed visit. Reception sends a link and never learns what happened; §7.3.1 says so for Analytics and it is identically true here. The one thing that would supply all three is the per-tenant booking/visit webhook of §7.3.3 Option 3, whose existence for tenant #1 is **unverified**.

So `roles` carries **both** prerequisites, and `withTenantRole` refuses `care` for a missing data source with the same mechanism it refuses a missing transport:

```sql
update roles set requires_transport = true, requires_data_source = 'appointment_feed'
where role = 'care';
```

Without this, the trunk lands, `outbound_messages` is fully built and empty, and Customer Care gets re-scoped in a hurry into "tenant pastes a list and blasts it" — a different product, with a different consent story (`linked_by='tenant_import'`) and a different regulatory posture than the reminders it was sold as.

**A third constraint, from Meta's side, decides whether Messenger is even a candidate:** the legacy tags (`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE`) were retired 2026-04-27 and now return error `100`; Recurring Notifications ended 2026-02-10; the surviving `HUMAN_AGENT` tag extends the window to 7 days but Meta explicitly prohibits AI-authored text under it and says it detects misuse. **Outbound reminders on Messenger, written by an AI, are not buildable as specified.** Do not build the seam around "message tags"; build it around an outbound-eligibility policy resolved as data, where `per_message_cost_usd === null` refuses.

### 7.2.1 The provider-agnostic table

```sql
create table outbound_messages (
  tenant_id uuid not null references tenants(id),
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid,
  person_id uuid not null,                      -- the tenant-scoped PERSON, not a channel id
  channel_kind text not null check (channel_kind in ('sms','messenger','instagram','email')),
  address text not null,                        -- E.164 for sms; PSID/IGSID otherwise
  purpose text not null check (purpose in ('reminder','winback','review_request','service')),
  template_id uuid not null references outbound_templates(id),
  rendered_body text not null,                  -- rendered at ENQUEUE, frozen, auditable
  locale text not null default 'mn',

  state text not null default 'draft'
    check (state in ('draft','queued','blocked','sent','delivered','failed','expired')),
  block_reason text,        -- 'no_consent'|'opted_out'|'quiet_hours'|'no_transport'
                            -- |'no_data_source'|'budget'|'role_off'|'unknown_cost'|'window_closed'
  not_before timestamptz not null,
  expires_at timestamptz not null,

  provider text, provider_message_id text,
  cost_usd numeric(10,6),
  attempts int not null default 0, last_error_code text,
  sent_at timestamptz, delivered_at timestamptz,

  idempotency_key text not null,
  unique (tenant_id, idempotency_key),
  check (state <> 'sent' or (provider_message_id is not null and cost_usd is not null))
);
```

Five load-bearing details:

- **`rendered_body` is frozen at enqueue.** A message queued Monday and sent Tuesday sends what was reviewed.
- **`expires_at` is mandatory.** A "your appointment is tomorrow" reminder delivered two days late is worse than not delivered. Expiry is a state, not a silent drop.
- **The CHECK makes "sent but we don't know what it cost" unrepresentable.** Rule #5 in the schema rather than in code review.
- **`person_id`, not a channel identity.** Opt-out is a property of a person.
- **`'voice'` is deliberately NOT in `channel_kind`.** See §7.4 — a voice call's cost is per-second and unknown at accept time, which this table's CHECK constraint cannot express.

### 7.2.2 The `MessageTransport` interface

```ts
export interface SendRequest {
  tenantId: string; outboundId: string;
  channelKind: 'sms' | 'messenger' | 'instagram' | 'email';
  address: string;            // E.164 for sms
  body: string;               // already rendered, already NFC-normalised
  templateRef: string;        // provider-side template id where required
  idempotencyKey: string;     // the provider MUST honour it, or the adapter emulates it
}

export interface SendResult {
  providerMessageId: string;  // required. No id => not sent.
  costUsd: number;            // required. Unknown cost is NOT zero — see quoteCost().
  acceptedAt: string;
}

export interface MessageTransport {
  readonly provider: string;                  // 'mobicom' | 'unitel' | 'twilio' | ...
  readonly channelKinds: readonly ('sms'|'messenger'|'instagram'|'email')[];

  /** Startup assertion: credentials present, endpoint reachable, sender id registered.
   *  Throws => NOT registered. There is no "degraded but sending" mode. */
  healthCheck(): Promise<void>;

  /** Price for THIS message BEFORE sending. null => the send is REFUSED.
   *  Unknown price never defaults to zero. */
  quoteCost(req: SendRequest): Promise<number | null>;

  /** Mongolian Cyrillic is NOT GSM-7: it is UCS-2, so a segment is 70 characters, not
   *  160, and a 160-character Mongolian reminder is THREE segments, not one. */
  segments(body: string): { count: number; encoding: 'gsm7' | 'ucs2' };

  send(req: SendRequest): Promise<SendResult>;

  parseDeliveryReceipt(raw: unknown): {
    providerMessageId: string; state: 'delivered'|'failed'|'expired'; errorCode?: string;
  };

  /** Inbound STOP. `destination` is REQUIRED: it is what the tenant is routed from. */
  parseInbound(raw: unknown): {
    from: string; destination: string; body: string; receivedAt: string;
  };
}
```

`segments()` is on the interface because Mongolian Cyrillic is two bytes per character in UTF-8 and forces UCS-2 — **every ASCII-derived length budget is roughly 1.9× too small.** The ancestor measures `.length` against Messenger's 2,000-*character* cap (`lib/messengerText.js:78`, `lib/messengerClient.js:52`), which errs safe there and will not err safe here, where it maps to money.

**`parseInbound` returns `destination` because inbound SMS has no other tenant signal.** `channel_identity`'s primary key is `(provider, external_id)` — one identity, exactly one tenant. For SMS the identity is the sender id / short number. **Therefore per-tenant sender identity is a procurement requirement, not a nice-to-have:** a provider that cannot issue a distinct sender id per tenant is disqualified, because with a shared sender the tenant is unrecoverable from an inbound «БОЛИ».

> **One line of disagreement with the critique that raised this.** It called a cross-tenant block derived from a shared-sender STOP "precisely the input-derived tenant identity rule #1 forbids." Half right. Rule #1 forbids input-derived identity that *grants* capability or spend; a block is monotonically restrictive and only ever refuses, so applying an inbound STOP to every tenant that person has a relationship with is the safe direction and is arguably the correct regulatory reading anyway. It is still the wrong design — it makes one tenant's customer able to silence another tenant's messaging — so per-tenant sender stands as the requirement, with shared-sender-plus-global-block as the documented fallback if procurement forces it. Whether MN operators will issue per-tenant sender ids to a small company, and at what per-tenant cost, is a founder question (§7.8).

### 7.2.3 The only implementation is `NullTransport`, and that is the enforcement

```ts
class NullTransport implements MessageTransport {
  readonly provider = 'null';
  readonly channelKinds = [] as const;                  // claims NOTHING
  async healthCheck() { throw new Error('no_transport'); }
  async quoteCost() { return null; }                    // unknown price => refuse
  async send(): Promise<SendResult> {
    throw new NoTransportError('Customer Care has no send capability on this deployment');
  }
  ...
}

const TRANSPORTS = new Map<string, MessageTransport>();   // deliberately EMPTY

export async function resolveTransport(kind: string): Promise<MessageTransport> {
  const t = TRANSPORTS.get(kind);
  if (!t) throw new NoTransportError(kind);               // 503, never a fallback
  await t.healthCheck();
  return t;
}
```

**Why this is enforcement and not discipline.** No code path from `outbound_messages` to a network call avoids `resolveTransport`, and the map is empty: sending requires *registering a transport* — a visible, reviewable, single-line change with a name attached — rather than quietly adding a `fetch`. Five further locks:

1. **`roles.requires_transport`** — `withTenantRole` refuses to open a budget reservation for `care`. No transport → no reservation → no spend, before any provider question arises.
2. **`roles.requires_data_source`** — same refusal for the missing event feed (§7.2.0).
3. **Platform kill switch** `platform_flags.outbound_enabled = false`, checked in the same gate, plus `platform_flags.outbound_dry_run` (see §7.2.4).
4. **Per-tenant OFF platform-wide:** `tenant_roles(role='care').state='off'` and `monthly_budget_usd = 0` for every tenant.
5. **A CI guard that actually tests something.** The earlier draft proposed failing the build if "any file outside `lib/transports/` performs a network call from the `care` code path" — unbuildable (that needs whole-program call-graph analysis through dynamic dispatch) and, worse, the kind of guard that gets written as a `grep`, passes forever, and looks identical in CI to one that works. The precedent does something else, and I read it: `/home/user/dalatech-english/scripts/check-supabase-nostore.mjs` **stubs `globalThis.fetch`, runs the real client, and inspects the `init` actually handed over** — and asserts the negative direction too, because, in its own words, *"an assertion that can never fail reads identically in a diff"* (`:22-24`). Port that technique:

```
scripts/check-no-outbound-send.mjs      # no credentials, no network
  1. stub globalThis.fetch; drive a real care enqueue → send attempt end to end
     assert ZERO fetches occurred, and the thrown error is NoTransportError
  2. register a fixture transport in the same process; repeat
     assert EXACTLY ONE fetch occurred   <- proves the harness can detect a send at all
  3. syntactic: TRANSPORTS is constructed as a literal empty map
```

Until a transport exists, rows accumulate in `state='blocked'`, `block_reason='no_transport'`. That is deliberate: the *rest* of Customer Care — consent, quiet hours, templates, the ledger — can be exercised against real rows without a message leaving the building.

### 7.2.4 Filling the seam

**`blocked` is terminal.** There is no transition out of it. When the trunk arrives, filling the seam creates **new** rows via an explicit re-enqueue with fresh `idempotency_key`s, which forces a human to look at what is being re-created. The alternative — re-evaluating blocked rows — is a mass-send event: six months of `winback` rows, a purpose with no natural short expiry, going out at once with `rendered_body` frozen from a stale KB, to consent recorded months ago, at real per-segment cost. The tenant's first experience of Customer Care would be a complaint volume.

**And the first registration ships behind `platform_flags.outbound_dry_run = true`:** `send()` returns a synthetic `providerMessageId` and the *real* `quoteCost()` figure, and sends nothing. You read the rendered Mongolian, in bulk, before flipping it.

**Providers to evaluate.** *Everything here is SEARCH-CORROBORATED at best; `business.mobicom.mn` is blocked by this session's egress proxy, so no primary operator page was read. This is a shortlist and a checklist, not findings.*

| Route | Why it matters |
|---|---|
| Direct operator contracts (Mobicom, Unitel, Skytel, G-Mobile) | `13xxxx`/`14xxxx` short-number ranges reportedly need a separate contract per operator. Best deliverability, worst operational load — the "one adapter per operator" case the interface exists for. |
| Local aggregators | The realistic v1: one contract, one adapter. Verify delivery receipts and inbound STOP. |
| International CPaaS (Twilio, Sinch, MessageBird, Plivo, …) | Fastest to integrate; often no registered alpha sender id into MN, higher cost, variable route quality. Fine for a pilot, risky as the product. |

**Checklist before any of this becomes an adapter — every item is a business answer, not a code answer:**

1. Can each **tenant** get its own registered sender id / short number, and what does it cost? (§7.2.2 — this is a disqualifier, not a preference.)
2. Per-message price for **UCS-2** segments, per operator. This is `quoteCost()`'s return; without it the transport refuses by construction.
3. Does the provider deliver **inbound** messages and **delivery receipts**? A transport with no inbound path cannot honour an SMS opt-out and must not be registered.
4. Does it honour an idempotency key, or must the adapter emulate one? Without it a retry is a second charge and a second message.
5. **Regulatory:** SMS sits under the CRC and the Law of Mongolia on Personal Data Protection (in force 2022-05-01), which requires documented consent naming sender, data, purpose, duration, third-party transfer and withdrawal method. That list is effectively the schema for `consent_records`. **Reviewed by a Mongolian lawyer before the first send, not after.**
6. Whose sender id, whose contract, whose liability — Dalatech's or the tenant's? This changes the data model (per-tenant credentials = another key-management problem).

### 7.2.5 Consent and opt-out — the cross-role model

**This is a platform invariant enforced in `withTenantRole` (§7.0.2 step 3), not a Customer Care feature.**

```sql
create table persons (
  tenant_id uuid not null references tenants(id),
  id uuid primary key default gen_random_uuid(),
  display_name text,
  blocked_at timestamptz,            -- PERSON-LEVEL. Checked first, on every initiated send.
  blocked_source text,               -- 'sms_stop' | 'dm_stop' | 'tenant_request' | 'inferred'
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table person_identities (
  tenant_id uuid not null, person_id uuid not null,
  kind text not null check (kind in ('psid','igsid','phone_e164','email')),
  value text not null,
  linked_by text not null,           -- 'customer_stated'|'tenant_import'|'inferred'
  primary key (tenant_id, kind, value),
  foreign key (tenant_id, person_id) references persons (tenant_id, id)
);

create table consent_records (       -- per-purpose GRANT/WITHDRAW only. Blocking lives above.
  tenant_id uuid not null, person_id uuid not null,
  channel_kind text not null,
  purpose text not null check (purpose in ('reminder','winback','review_request','service')),
  state text not null check (state in ('unknown','granted','withdrawn')),
  source text not null, evidence_ref text,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, person_id, channel_kind, purpose),
  foreign key (tenant_id, person_id) references persons (tenant_id, id)
);
```

**`blocked` moved to `persons.blocked_at`** because the earlier draft claimed *"blocked blocks everything, on every channel, forever"* while storing it as a value of a per-`(channel, purpose)` row — expressing "blocked everywhere" would have required writing the full cross-product, and the check would have been an aggregate instead of a lookup.

The rules, as absolutes:

1. **`unknown` is the default and it REFUSES.** Absence of `granted` is not permission.
2. **Reactive replies need no consent; initiated messages always do.** Reception answering someone who just messaged is service. Anything `initiated: true` requires `granted` for that `(channel_kind, purpose)`.
3. **`blocked_at` blocks everything initiated, on every channel, for every role, until the person themselves reverses it.** `withdrawn` is per-purpose.
4. **An opt-out arriving on any channel applies to all of them.** A customer types «битгий мессеж илгээ» into Messenger, not into SMS. Reception recognises it, sets `blocked_at`, confirms with a pinned line, and keeps answering the current conversation. This is why consent hangs off `person_id`.
5. **Detection is exact-match first, model-inferred second — and an inferred opt-out takes effect IMMEDIATELY.** The Quality flag on `source='inferred'` exists to *reverse false positives*, never to authorise true ones. Quality runs weekly (§7.5.2); gating effect on that review would mean up to seven more days of messages to someone who asked us to stop, which is the exposure §7.2.4 item 5 is about. The asymmetry is deliberate: a false-positive opt-out costs one marketing message; a false negative is a regulatory problem.
6. **When a phone number and a PSID are later linked into one person, the strictest state wins.** Linking must never launder an opt-out.

### 7.2.6 Quiet hours

`tenant_roles.config.care.quiet_hours = { start: '21:00', end: '09:00', tz: 'Asia/Ulaanbaatar' }`, evaluated in the **tenant's** timezone at *send* time, not enqueue time. A message landing in quiet hours has `not_before` pushed forward; if that would pass `expires_at` it becomes `expired`, not delayed into the wrong day. Quiet hours are per-purpose: `service` may be exempt if the tenant explicitly enables it; `winback` and `review_request` never are. Staff notifications (§7.1.4) have their own quiet hours, defaulting to **exempt for `urgent`** — a customer waiting for a human is why the tenant bought the product.

### 7.2.7 Customer Care failure modes (all hypothetical until both prerequisites exist)

| Failure | Response |
|---|---|
| No transport registered | Every row `blocked / no_transport`. Dashboard: *"Customer Care AI: тохируулагдаагүй"*. Never a silent skip. |
| No appointment/visit feed | `blocked / no_data_source`, refused at the gate. |
| `quoteCost()` returns null | `blocked / unknown_cost`. **Unknown price refuses; it never defaults to zero.** |
| Provider 5xx / timeout | Backoff up to `attempts`, then `failed` + alert. Retry the **send**, never re-render or re-generate. |
| Provider returns 2xx with no message id | **Failed**, by the CHECK constraint. "Accepted" is not "delivered". |
| Delivery receipt says failed | `failed`; cost still recorded (you were charged); person flagged for bad-number review. |
| Duplicate enqueue | `unique (tenant_id, idempotency_key)` — a database refusal, not a second charge. |
| Budget spent mid-campaign | Remaining rows `blocked / budget`; campaign paused; tenant told the exact sent and blocked counts. |
| Opt-out between enqueue and send | Re-checked at send time. `blocked / opted_out`. |

---

## 7.3 Analytics AI — and the attribution problem, solved honestly

### 7.3.1 The problem, stated plainly

Reception sends a booking link. The booking happens on `matrixecosalon.org`, which Dala AI cannot see. Money changes hands in a salon chair. **Dala AI has direct evidence of none of it.**

And the evidence chain we *do* have — link sent → link clicked → booking appeared — supports **"this booking passed through our link."** It does not support **"this booking would not otherwise exist."** Those are different claims, and the earlier draft printed only the second one, under a heading (*Тооцоолсон орлого*, estimated revenue) that asserts causation. The sceptical-client conversation ends the design:

> — *"Тэр арван хоёр хүн Instagram-аас маань шууд орж захиалж болох байсан биз дээ?"*

There is no answer. The system holds no baseline and no bot-off comparison. So:

> **Rule 1. The report makes a channel-volume claim, never a causal one.** The heading is **«Dala AI-н холбоосоор дамжсан захиалга»** — bookings that passed through our link — not "revenue Dala AI drove". Do the rename in the sales material too, before the first sale; renaming after a client challenges it is an admission.
>
> **Rule 2. An estimate never appears without its inputs printed beside it, and no number appears in prose that did not come from SQL.**
>
> **Rule 3. The limitations section must contain at least one limitation that points against us.** Every limitation in the earlier draft — phone bookings, walk-ins, copied links — made the number a floor. A caveat list that only ever flatters the vendor is a sales device with the typography of candour. The missing sentence: *«Эдгээр хүмүүсийн зарим нь бидэнгүйгээр ч захиалах байсан байж магадгүй. Бид үүнийг ялгаж чадахгүй.»*

### 7.3.2 Four evidence tiers

| Tier | Label in the report | What it is |
|---|---|---|
| **A — FACT** | **Баримт** | Dala AI observed it directly in its own database: messages in/out, conversations, unique people, first-response time, handoffs opened/acknowledged, detected unanswered questions, links sent, **raw** link hits, comment replies |
| **B — CONFIRMED** | **Баталгаажсан** | A fact plus a machine join the tenant's own system produced — a signed booking webhook carrying our token |
| **C — ESTIMATE** | **Тооцоолол** | Arithmetic or a classifier output over A/B: filtered click counts, service classification, booked-value arithmetic |
| **D — SELF-REPORTED** | **Танай мэдээлсэн** | A number the tenant typed. Never merged into B. Any C computed from a D input inherits D. |

**Tier D exists because the earlier draft let a tenant's monthly guess wear the word Баталгаажсан** — the same badge as a cryptographically joined webhook — and then argued *"the tenant cannot later dispute a number they supplied."* That is the wrong instinct to write down: a client who realises their offhand estimate was multiplied by an average ticket and printed as revenue does not feel bound by it, they feel handled. Mitigations: the reconciliation form shows **no click count on the same screen**, and we store `entered_at` relative to `report_viewed_at` so an anchored entry is at least detectable later.

### 7.3.3 The measurement chain

**Option 1 — a tracking parameter on the booking link.** `?dala=<token>`. Worth nothing alone; it is the join key that makes 3 and 4 possible. Do it.

**Option 2 — a Dala-owned redirect. BUILD THIS.** `https://l.dala.mn/r/<token>` → 302 to the tenant's booking URL with `?dala=<token>` appended.

- Token = `base64url(payload) . HMAC(payload, LINK_SIGNING_KEY)`; the payload **encodes the destination, tenant id and conversation id**, minted only against a host in `tenant_domains`.
- **The destination is inside the token, so the redirect reads no database on the hot path.** Putting a Dala hop in front of a tenant's booking link makes us a dependency of their *revenue*; if our database is down the redirect must still work. The click log is fire-and-forget: losing it loses a measurement, not a booking.
- **Never accept a `next`/`url` parameter.** This is an open-redirect surface and is treated as one.
- **Report raw and filtered click counts side by side, always** — *"Нийт дарсан: 61 · Хүн гэж тооцсон: 43"* — with the filter rule in the appendix. Raw hits are Tier A; **the filtered count is Tier C and stays Tier C.** The critique that raised this proposed validating the filter against twenty test links and then promoting it; I disagree on the promotion and adopt the validation: a one-device, one-moment false-positive rate does not generalise, and Meta's prefetch fleet changes without notice. Run the twenty-link test, write the observed rate into the appendix, keep the tier.
- `link_clicks` stores `ua_class` and `counted` per row, so the filter decision is auditable rather than asserted.

**Option 3 — a webhook from the tenant's booking system. The only path to a booking FACT.** `POST /api/webhooks/booking/{tenant}` with a per-tenant HMAC secret, carrying `{ external_booking_id, dala_token?, state, created_at, service, amount? }`.

**`state` is required** (`booked | completed | cancelled | no_show`). A booking is an intention, not money: no-shows, cancellations, a customer who books colour and takes a trim, a discount applied in the chair — every one makes booked value exceed received value, all in the same direction. Only `completed` may appear under a revenue heading. If the tenant's system cannot send state, the line is titled **«Захиалсан дүн»** (booked amount), never **«Орлого»**, and the difference is stated in one sentence.

> **Does `matrixecosalon.org` have such a webhook, and does its booking flow preserve an unknown query parameter through to confirmation? UNVERIFIED.** The domain is blocked by this session's egress proxy (`EGRESS_BLOCKED`). This is the highest-value unknown in the section: yes → Matrix reaches Tier B; no → Matrix is capped at Tier A + C forever, **and Customer Care has no event feed either** (§7.2.0). Ten minutes with a browser. Do it before designing a report for a customer.

**Option 4 — tenant self-reporting. BUILD THIS, it is cheap** — and it is Tier D, not B.

**Option 5 — a stated-assumption model.** Tier C, never standing alone.

```sql
create table booking_links (
  tenant_id uuid not null, id uuid primary key,
  conversation_id uuid not null, token_hash bytea not null unique,
  destination_url text not null, sent_at timestamptz not null,
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id)
);

create table link_clicks (
  tenant_id uuid not null, id uuid primary key,
  booking_link_id uuid not null, clicked_at timestamptz not null,
  ua_class text not null,        -- 'human'|'prefetch'|'bot'|'unknown'
  counted boolean not null       -- the filter decision, stored so it is auditable
);

create table attributed_bookings (
  tenant_id uuid not null, id uuid primary key,
  booking_link_id uuid,                       -- null when reported without a token
  source text not null check (source in ('booking_webhook','tenant_reported')),
  period_month date not null,                 -- first of month, tenant timezone
  quantity int not null default 1,            -- a self-report is a COUNT, not a row per booking
  booking_state text check (booking_state in ('booked','completed','cancelled','no_show')),
  external_booking_id text, amount_mnt numeric, occurred_on date,
  unique (tenant_id, source, external_booking_id),
  unique nulls not distinct (tenant_id, source, period_month)      -- PG15+; Supabase is PG17
);
```

**The second unique constraint is a real bug fix, not a tidy-up.** The earlier draft had only `unique (tenant_id, source, external_booking_id)` — and for `source='tenant_reported'` there *is* no `external_booking_id`, so with Postgres's default NULL-distinct semantics that constraint imposed **no constraint at all** on the self-report path. A tenant double-clicking submit on a slow connection doubled the month's booking count and therefore the revenue line. The draft even listed "cron double-fires → unique constraint" as a solved case, which is exactly the confidence that stops anyone checking. `quantity` is added because a self-report is a count, which the row-per-booking model could not express without fabricating rows.

**The attribution window is a stored constant.** `ATTRIBUTION_WINDOW_DAYS = 30`, click→booking, enforced in the join, printed in the appendix, and **stored on the `analytics_reports` row** so a report generated under an old window stays reproducible. Without it, a link sent in March, clicked in July and booked in August is attributable, and whichever way the query happens to be written silently becomes the policy. (A token in a forwarded URL is a second, unfixable leak: a friend who books produces a real booking attributed to a conversation with someone who never booked. Not catastrophic in aggregate, fatal in the one row a tenant checks — so the appendix says so.)

**Pricing an attributed booking.** The earlier draft used `confirmed bookings × tenant-stated average ticket`. That is the wrong population: the salon's average is over all customers — regulars, colour clients, package buyers — while bot-sourced bookings are self-selected first-visit, price-sensitive, single-service enquiries. The error is of unknown sign and easily 30–50%, printed with false precision. So:

1. If the booking webhook carries `amount` and `state='completed'`, use it. **Tier B.**
2. Else, if the conversation matched a service, price it from the tenant's own `pricing_rules` row for that service and sum. **Still Tier C** — the critique's fix improves accuracy but does not promote the tier, because "which service was asked about" is itself a classifier output, the exact problem §7.3.4 flags for intents.
3. Else, print a **range** from the tenant's cheapest and dearest common service — *"600,000₮ – 1,400,000₮ хооронд"* — never a mean. A range is both more honest and, in a sales conversation, harder to argue with than fake precision.
4. If none of the above is available, **the line is absent, not zero**, with one line saying what to supply to enable it.

**Baseline.** Capture the tenant's monthly booking count for the three months before go-live at onboarding (Tier D, self-supplied) and print it beside the current month as an unadorned before/after labelled *«хамаарал, шалтгаан биш»*. One caveat the critique did not raise and the report must: Mongolian retail seasonality is severe (Tsagaan Sar, Naadam) and the tenant is doing their own marketing, so a before/after is context, **never a lift figure**.

### 7.3.4 The report

Fixed order, same every month — a report whose shape changes invites the reader to think the numbers are curated.

1. **Хураангуй — Баримт.** Conversations, unique people, messages, median first response, **«Хүн рүү шилжүүлээгүй харилцан яриа: 87%»**, handoffs opened / acknowledged / unacknowledged.
2. **Хамгийн их асуусан** — the raw counts of exact NFC-normalised question strings are Tier A; any semantic grouping renders below them marked **«автомат ангилал»** (Tier C).
3. **«Илрүүлсэн хариулж чадаагүй асуулт»** — detected unanswered questions.
4. **Захиалгын холбоос.** Sent; raw hits; filtered ("human") count marked Tier C; rate.
5. **Dala AI-н холбоосоор дамжсан захиалга.** Tier B/D, present only with a reconciliation source, source named.
6. **Захиалсан / гүйцэтгэсэн дүн.** Tier B, C or D per §7.3.3; absent when unavailable.
7. **Бидний харж чадахгүй зүйл.** Phone bookings, walk-ins, copied links, anything after the click — **and the sentence that points the other way** (§7.3.1 Rule 3). Not buried; it is why a tenant believes sections 1–6.
8. **Хэрхэн тоолсон бэ.** Methodology: the click filter rule and its measured false-positive rate, `ATTRIBUTION_WINDOW_DAYS`, the tier of every number above. Not optional, not collapsible.

**Two renames that matter more than they look.** Dala AI cannot observe *resolution* — it observes the **absence of a handoff**, which a satisfied customer and a customer who gave up and phoned a competitor produce identically. "% resolved without a human" is the single most quotable wrong number in the report because it is the one a founder says out loud in a meeting. Likewise the unanswered list counts *detections*: a confidently wrong answer is by construction absent from it, which the appendix states in one line.

**The ancestor already shipped a fabricated counter as a real number, and it is verified.** `trackConversationStart` is defined at `/home/user/Matrix-Chatbot/lib/analytics.js:59-60` and `grep -rn "trackConversationStart"` returns **only the definition** — it is called from nowhere. `totalConversations` is therefore permanently `0`, and `getSummary()` returns it at `:132` where `/home/user/Matrix-Chatbot/api/analytics.js:16` publishes it as `data.overview.totalConversations`, behind only `applyCors` — which passes any request with **no `Origin` header** and any request at all when `ALLOWED_ORIGINS` is unset (`/home/user/Matrix-Chatbot/lib/cors.js:16-17`). An analytics endpoint reporting a number that cannot ever be true, with no indication it is broken, in this product line, already. The invariant that catches it: **every metric in the fact sheet carries the row count it was computed from.** One refinement on the critique's version of this rule — a genuine zero within a non-empty population is meaningful and must render as `0` (zero handoffs is good news); only an **empty source population** renders as *«мэдээлэл алга»*.

Similarly, intent classification is a Tier C output: the ancestor's `detectIntent` (`/home/user/Matrix-Chatbot/lib/analytics.js:81-114`) buckets on unanchored Cyrillic regexes carrying the same `/^(сайн|байна|уу|hi|hello|hey)/i` defect as §7.1.7, plus a bare `message.length < 30` gate, and its output is served as authoritative counts.

**The model writes prose only, and never a number.** The job computes a **fact sheet** in SQL, hands it to the model, and asks for two or three sentences of Mongolian narrative. A post-check extracts every digit-group from the output and requires each to be in the fact sheet's allowed-value set (compare after stripping non-digits, so Mongolian case suffixes on numerals do not false-fail). Any invented digit → fully templated report, no model prose, **plus a founder alert**.

> **The post-check has two known holes and they are written down rather than papered over.** It validates *tokens*, not *claims*: spelled-out Mongolian numerals («арван хоёр») bypass it entirely, and comparatives assembled from allowed digits («хоёр дахин өссөн») contain no digit to check. Mitigation: compute month-over-month deltas into the fact sheet and whitelist comparative vocabulary against them; where that is not done, restrict the model to non-quantitative prose.

**Delivery.** Dashboard (canonical, links through to the underlying conversations); PDF from the same `analytics_reports` row; Telegram headline to the same `handoff_targets` chat, which is what the tenant actually reads. **PDF trap: the font must embed full Mongolian Cyrillic coverage** — many default stacks silently drop `Ө` (U+04E8) and `Ү` (U+04AE) or substitute a lookalike. Verify by rendering `Өнгө үс засалт ҮНЭ` and **byte-comparing extracted text against the source**, not by looking at it.

**Job, schedule, ceiling.** This is Dala AI's **first scheduled spender**, and the sibling's scar is explicit: *"NOTHING SPENDS ON A SCHEDULE"* without an explicit ceiling and an alert path. The ancestor has no `crons` key in `/home/user/Matrix-Chatbot/vercel.json` at all (verified — the file contains only `buildCommand`, `outputDirectory` and two rewrites), so this is genuinely new surface.

- **Schedule** `0 17 1 * *` UTC = 01:00 on the 2nd `Asia/Ulaanbaatar`; the period is the calendar month that ended **in the tenant's timezone**.
- **Fan-out:** the cron enqueues one message per active tenant onto `q:analytics` and itself touches no model.
- **Idempotency:** `analytics_reports` unique `(tenant_id, period_start)`. A double-fired cron hits a constraint, not a second bill.
- **Ceilings:** `ANALYTICS_RUN_BUDGET_USD` per run, plus `tenant_roles.monthly_budget_usd` for the `analytics` bucket, reserved before the model call.
- **Model:** `claude-sonnet-5` for the narrative (a few hundred output tokens on a small fact sheet). If the tenant's analytics budget is 0, the report still generates — **fully templated, no model, no spend.**
- **Alert path:** any failed or budget-refused run produces a founder alert *and* a tenant dashboard banner. A missing monthly report must never be discovered by its absence.
- **The Next.js caching trap applies with force.** A route exporting only `GET` caches every Supabase read for a **year**, and `export const dynamic = 'force-dynamic'` does not stop it — only `cache: 'no-store'` on the fetch does. The specific hazard here is a tenant-config or channel-binding read returning a *stale other-tenant* value. Port `src/lib/supabase/fetch.ts` and `scripts/check-supabase-nostore.mjs` on day one.

### 7.3.5 Analytics failure modes

| Failure | Response |
|---|---|
| Model unavailable | Templated report, no prose. It still ships. |
| Post-check rejects a digit | Templated report **plus a founder alert** — a model inventing numbers is a defect, not a routine fallback. |
| No reconciliation source | Tiers B/D absent with one line on how to enable them. Never a zero, never an inferred number. |
| Booking webhook secret wrong/rotated | 401s; bookings stop joining. Detected as a *drop* in Tier B against prior months → founder alert. A silent stop is the failure to guard against. |
| Click log write fails | Redirect still works (destination is in the token). Click lost; the appendix already says clicks are a floor. |
| Cron double-fires | Unique constraint. No second spend. |
| Tenant timezone missing | `503 tenant_timezone_missing`. Do not default to UTC and silently report the wrong month. |

---

## 7.4 Voice AI — Phase 4, the seam only

Voice attaches at exactly two places. First, `channels.kind` gains `'voice'` and `channel_identity.provider` gains a voice provider, so a call resolves to a tenant through the same server-side registry lookup as a Messenger event and passes the same `withTenantRole` gate — identity, entitlement, consent, budget — before a token is spent. Second, `conversations` and `messages` already model a turn-taking exchange, so a call is a conversation whose messages carry `modality='audio'` with the transcript in `body_nfc` and `media_ref` pointing at stored audio, and `tokens_in/out/cost_usd` absorb STT, LLM and TTS cost in the same ledger rows every other role writes.

**What the seam deliberately does NOT do: `'voice'` is not a `channel_kind` and not a `MessageTransport.channelKinds` value.** The earlier draft pre-committed it in both enums, which asserts that voice outbound is a `MessageTransport` — an interface with `segments(body)`, a `body: string`, and a `send()` returning a **final `costUsd` at accept time**, enforced by `check (state <> 'sent' or cost_usd is not null)`. A call's cost is per-second and known only when it ends. An implementer reading that schema would either write `costUsd: 0` (which passes the CHECK, because zero is not null, and breaks rule #5) or reshape three things at once — the redesign the seam exists to prevent. Adding an enum value later is one migration; its absence today stops the wrong reading. **Voice reserves against a maximum-duration estimate and reconciles through the ledger's existing `reservation → actual → refund` rows** (§7.6.2), which already supports exactly this.

Nothing else is designed, and deliberately: real-time voice adds a latency budget, a barge-in model, a per-second cost curve and a Mongolian STT/TTS quality question that no schema answers. The seam's only promise is that Voice will not need a second tenant resolver, a second budget gate, a second consent check, or a second conversation table.

---

## 7.5 The Quality layer — internal, admin-only, never client-facing

### 7.5.1 What it is for

Reception will be wrong. The ancestor's own history is the evidence: *"[t]he garbled phrases seen in live replies ('чадам туслаарай', Russian 'дополнительн') came from the model inventing its own filler/closing language"* (`/home/user/Matrix-Chatbot/lib/salonBrain.js:48-51`), which is why every customer-facing line is pinned. Nobody found those by reading logs; someone read conversations. The Quality layer is that reading, done systematically. It is also the only instrument that can populate `forbidden_openings` (§7.1.7) — you cannot forbid a wrong answer you have not seen.

### 7.5.2 What it reads, and when

**Reads** (one tenant at a time): `messages` for the period; `conversation_events`; `quality_flags` raised by the runtime at zero model cost — `guard.price_leak`, `guard.false_confirmation`, `handoff.no_kb_answer`, `fallback_sent`, `shortcut.suspected_false_positive`, `optout.inferred`, `comment.skipped`; and `kb_entries`, `refusal_topics`, `canned_responses` so a proposal can state what is there now.

**Never reads:** `tenant_secrets`, another tenant's anything, raw page tokens, payment details.

**Cadence:** **weekly** per tenant over 7 days — all flagged conversations plus a bounded random sample of unflagged ones (default 25), so the layer is not blind to failures nobody flagged. **Immediate** when `handoff.no_kb_answer` for one normalised question crosses a threshold (default 3 in 24h). **Never real-time** — reviewing every conversation as it happens roughly doubles per-message cost for a signal that is better in aggregate. Note that opt-out inference is *not* gated on this cadence (§7.2.5 rule 5).

### 7.5.3 A proposal is a row with its evidence attached

```sql
create table kb_change_proposals (
  tenant_id uuid not null references tenants(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in
    ('add_faq','edit_faq','add_price','correct_price','add_refusal_topic',
     'edit_canned_response','add_forbidden_opening','add_synonym','no_action')),
  target_ref uuid, proposed jsonb not null, current_value jsonb,
  rationale text not null,
  confidence text not null check (confidence in ('low','medium','high')),
  frequency int not null,
  state text not null default 'pending'
    check (state in ('pending','approved','rejected','superseded','expired')),
  created_by_role text not null default 'quality',   -- the self-serve seam (§7.5.7)
  reviewed_by uuid, reviewed_at timestamptz, review_note text,
  model text not null, run_id uuid not null, cost_usd numeric(10,6) not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table kb_change_proposal_evidence (
  tenant_id uuid not null, proposal_id uuid not null,
  conversation_id uuid not null, message_id uuid not null,   -- the exact TURN, not "a conversation"
  excerpt text not null,
  foreign key (tenant_id, proposal_id)     references kb_change_proposals (tenant_id, id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id),
  foreign key (tenant_id, message_id)      references messages (tenant_id, id)
);
```

**A proposal with no evidence rows is rejected at write time.** "The bot seems bad at prices" is not a proposal; "these four turns, this question, this wrong answer" is. `no_action` is a first-class `kind` so a clean week produces a row rather than silence — otherwise you cannot distinguish a clean week from a job that failed.

### 7.5.4 The approval flow, and why it cannot auto-apply

Founder-only `/admin/quality`. Each proposal renders as current value, proposed value, rationale, frequency, and every evidence excerpt with a link to the full conversation. **Approve / Reject (with reason) / Edit and approve.** Approving writes a **new version** of the KB entry (never in place), bumps `tenants.kb_version`, and thereby invalidates the prompt cache key `(tenant_id, kb_version, channel, policy_hash)` — live on the next message, no deploy. Rejection reasons are the corpus for improving the Quality prompt.

**The guarantee is an ACL, not a promise.** On the 2026 Supabase key model the Quality worker runs under its own named secret key (`sb_secret_quality`) whose role holds `INSERT` on the two proposal tables and `SELECT` on the read set, **and nothing beyond `SELECT` on `kb_entries`, `refusal_topics`, `canned_responses`, `tenant_roles` or `tenant_secrets`.** Verified per table, independently, with `aclexplode(coalesce(relacl, acldefault('r', relowner)))` — never `information_schema.role_table_grants`, which is permission-filtered and returns an empty result instead of an error. And `revoke insert, update, delete` is not the check: Postgres grants seven privileges (eight on PG17 with `MAINTAIN`), and `TRUNCATE` bypasses RLS entirely. The approval route runs under a *different* key (`sb_secret_admin`) gated on `is_founder`. So "Quality cannot auto-apply" is the database refusing the write, and stays true if someone later writes a bug that tries.

### 7.5.5 Preventing cross-tenant leakage in review

Quality is inherently cross-tenant in purpose and must never be cross-tenant in execution. Five mechanisms, ordered by what each catches alone:

1. **One job invocation per `(tenant_id, period)`.** The queue message carries one tenant id. There is no batch mode.
2. **A runtime assertion, not a convention:** the hydrator asserts every loaded row's `tenant_id` equals the run's, and throws otherwise. Cheap, and it converts a scoping bug into a crash instead of a leak — this is the mechanism that would have caught `let cachedBasePrompt = null` (`/home/user/Matrix-Chatbot/lib/salonBrain.js:142`) on day one.
3. **Composite foreign keys.** A Matrix proposal physically cannot cite a GS Auto conversation, and referential-integrity checks are not subject to RLS, so it holds under `service_role`.
4. **No shared module-scope state.** Vercel reuses warm lambdas across tenants; a module-level `let` is a cross-tenant leak with a fifteen-minute half-life.
5. **A founder review identity that is not `service_role`** — a scoped `founder` role with one permissive `using (true)` SELECT policy, so reviewing happens *through* RLS. Then a scoping bug in the admin tooling surfaces as a missing row rather than another tenant's conversation on screen. One policy, and the only place RLS can still catch a mistake on this path.

**The Quality prompt is never given two tenants' text**, and a run's output is never used to build another tenant's prompt. Cross-tenant *pattern* learning ("salons often get asked X") is explicitly out of scope for v1 — it is the mechanism by which one tenant's price list ends up in another tenant's answer.

### 7.5.6 Ceiling and cost

Charged to **`platform_ops`**, not the tenant — the tenant did not ask for it and must not pay for the founder's tooling — but **attributed per tenant** in the ledger, so the founder sees which tenant costs most to keep good. `QUALITY_RUN_BUDGET_USD` per run and `QUALITY_MONTHLY_BUDGET_USD` platform-wide, both enforced by the same pre-reservation. Model `claude-sonnet-5` (long context over a week of conversations; judgment matters more than price, and the volume is weekly). Sampling caps input size and the sample size is a config value the founder can turn down when the bill says so.

### 7.5.7 Why admin-only matters commercially

1. **It is the moat.** The product is not "an LLM with a price list" — that is a weekend. It is an accumulating body of judgment about what a correct Mongolian reply looks like for a business like this one: the pinned lines, the forbidden openings, the refusal topics, the disambiguation rules. That body lives in the founder's approvals. A self-serve KB editor gives away the compounding asset.
2. **Showing a tenant the raw flag stream is showing them an unfiltered list of your failures.** *«Хариулж чадаагүй 34 асуулт»* reads as "the bot is broken" to a salon owner and as "next week's work" to the founder. Analytics shows the tenant-useful subset; the rest is engineering telemetry.
3. **It is the retention motion.** *"Here is what we improved in your bot this month"* is a concrete reason a subscription renews.
4. **Liability follows whoever writes the price.** A tenant-authored refusal rule that stops the bot selling is a dispute the founder owns anyway; owning the write path means owning it deliberately, with `reviewed_by` / `reviewed_at` / `review_note` showing who approved what.

**The seam for later:** self-serve KB editing is `kb_change_proposals` with `created_by_role='tenant'` and `state='pending'`, still requiring founder approval. Same table, one column value. Data, not a branch.

---

## 7.6 Cross-cutting — sharing config, KB, ledger and conversations without shared fate

### 7.6.1 One config, four readers

```
tenants ──┬── tenant_roles              (state, budget, config jsonb, per role)
          ├── channels / channel_identity      (Messenger, Instagram, [sms], [voice])
          ├── tenant_secrets            (encrypted; service-role only; envelope, KEK in env)
          ├── business_hours / tenant_closures
          ├── kb_entries (versioned) / refusal_topics / canned_responses / pricing_rules
          ├── persons / person_identities / consent_records
          ├── handoff_targets
          └── tenant_booking / tenant_domains
```

Every role reads this; **no role writes it** except Quality, which writes only proposals. Config is loaded once per request into an immutable `TenantContext` carrying `tenant_id`, `kb_version` and `policy_hash`; nothing downstream re-reads it, so a mid-request change cannot produce a half-old prompt.

**The onboarding proof.** Onboarding GS Auto Center is: one `tenants` row, one `channel_identity` row per Page/IG account, one `tenant_secrets` row, seven `business_hours` rows, N `kb_entries`, a `tenant_booking` row with `mode='phone'`, some `canned_responses`, `handoff_targets`, and `tenant_roles` rows. The staff roster the ancestor renders through three hardcoded buckets keyed on `m.gender === 'female' | 'male' | 'manicure'` (`/home/user/Matrix-Chatbot/lib/systemPromptBuilder.js:68-85`) becomes tenant-declared `staff_groups`: Matrix declares *Эмэгтэй үсчид / Эрэгтэй үсчид / Маникюр баг*, GS Auto declares *Мотор / Явах анги / Цахилгаан*, with no code between them. Compare today, where onboarding is "open `/config/currentClient.js` and update the following sections", then `npm run build:react` and redeploy: **the tenant is currently a git branch.** If client #3 needs a column you do not have, add the column — not a branch.

### 7.6.2 One ledger, five buckets

```sql
create table spend_ledger (
  tenant_id uuid not null references tenants(id),
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('reception','care','analytics','voice','platform_ops')),
  period_month date not null,                       -- first of month, tenant timezone
  kind text not null check (kind in ('reservation','actual','refund')),
  ref_kind text not null, ref_id uuid,
  model text, tokens_in int, tokens_out int,
  cache_read_tokens int, cache_write_tokens int,
  cost_usd numeric(12,6) not null,
  created_at timestamptz not null default now()
);
```

- **Reserve, spend, reconcile.** A `reservation` at estimated cost before the call; an `actual` from the provider's own `usage` block after; the difference a `refund`. The ceiling is enforceable without an after-the-fact read, and cache economics become visible per tenant — the ancestor logs `cache_read / cache_creation / uncached` (`lib/salonBrain.js:249-253`); here they are columns. This is also the model Voice reconciles through (§7.4).
- **Buckets are independent ceilings.** Analytics exhausting its bucket on the 1st cannot stop Reception on the 2nd. The roles are sold separately; a tenant paying for Reception must not lose it because Analytics misbehaved.
- **`spend_ledger` is server-asserted**, so `SELECT`-only to clients with **per-command** restrictive denies (`for insert` / `for update` / `for delete` separately) — never `as restrictive for all using(true) with check(false)`, which lets `DELETE` through, since `DELETE` has no `WITH CHECK` clause and that policy's `USING` is `true`.

### 7.6.3 One conversation store, tenant-first keys

```
q:reception:{tenant_id}        ratelimit:meta:{tenant_id}:{provider}
q:care:{tenant_id}             ratelimit:anthropic:{tenant_id}
q:analytics:{tenant_id}        cache:prompt:{tenant_id}:{kb_version}:{channel}:{policy_hash}
q:quality:{tenant_id}          hist:{tenant_id}:{channel_id}:{external_user_id}
```

The ancestor's keys are `msgr:hist:<psid>` (`/home/user/Matrix-Chatbot/lib/conversationStore.js:88`) and `msgr:done:<mid>` (`:53`) with no tenant dimension. PSIDs are page-scoped so a collision is unlikely — but "unlikely" is not a boundary to bet a customer's chat history on, and `mid` carries no such guarantee at all.

**Rate limiting, two layers, both fail closed.** Per-tenant buckets, so one tenant's comment storm does not consume app-level Graph budget belonging to another (Meta will not fair-share for you), plus a global bucket sized *below* Meta's, so you throttle yourself before Meta does — yours is observable and per-tenant, theirs is opaque and page-wide. Parse `X-App-Usage` / `X-Page-Usage` / `X-Business-Use-Case-Usage` on every response and store the per-tenant high-water mark: a tenant at 80% of `X-Page-Usage` is a page about to go silent. When the limiter cannot be consulted, **the webhook ACK may fail open** (a non-200 risks unsubscription, a worse outcome) but **the Graph call and the Anthropic call must not** — the `FAIL_OPEN_KEYS` discipline from `src/lib/rateLimit.ts`, with the exception list justified in a comment block.

### 7.6.4 One failure does not become four

| If this fails | Reception | Care | Analytics | Quality |
|---|---|---|---|---|
| Anthropic down | pinned fallback + handoff | n/a | templated report, no prose | run deferred |
| Redis / queue down | degraded, alerted; dedup falls back to Postgres | enqueue only; nothing sends anyway | unaffected | unaffected |
| Postgres down | **hard stop** — cannot resolve tenant → 503; the webhook still ACKs 200 to protect the subscription | blocked | run fails, alert | run fails, alert |
| One tenant's token revoked | that tenant degraded | that tenant only | unaffected | unaffected |
| One tenant's budget spent | that tenant + that bucket | that bucket | that bucket | `platform_ops`, unaffected |
| Meta rate-limits one Page (`613`) | back off **that tenant only**; retry the **send**, never re-enter generation | n/a | unaffected | unaffected |
| Quality worker crashes | unaffected | unaffected | unaffected | proposals deferred; **Reception never depends on Quality** |
| Analytics cron misfires | unaffected | unaffected | idempotency constraint | unaffected |

The one genuinely shared fate is Postgres, which is why the webhook path ACKs 200 and loses the message rather than 5xx-ing and risking a per-asset unsubscription. Write the trade down: **losing one message is recoverable; losing the subscription is a silent outage nobody detects from a request.**

---

## 7.7 What a tenant sees when a role they paid for is degraded

**Silent degradation is the enemy**, learned the expensive way next door: Brevo returned 2xx and dropped the mail; the ancestor's queue degrades with only a `console.error`; `memoryEnabled()` exists precisely to signal a missing Redis and is never called (`/home/user/Matrix-Chatbot/lib/conversationStore.js:130`). Every degradation here writes a row and fires a notification.

```sql
create table role_health (
  tenant_id uuid not null, role text not null,
  state text not null check (state in ('healthy','degraded','suspended','not_configured')),
  reason text not null,   -- 'budget_exhausted'|'token_revoked'|'upstream_down'|'no_transport'
                          -- |'no_data_source'|'not_provisioned'|'rate_limited'
  since timestamptz not null, expected_recovery timestamptz, notified_at timestamptz,
  primary key (tenant_id, role)
);
```

| Role | Degradation | Customer sees | Tenant sees | Notified |
|---|---|---|---|---|
| Reception | budget exhausted | pinned line + phone. Never silence. | *«Reception AI: энэ сарын хязгаарт хүрсэн»* + reset date + one-click raise request | Telegram + email + dashboard |
| Reception | token revoked (`190`) | **nothing** — Meta will not accept our sends | **urgent**: *«Facebook холболт тасарсан. Дахин холбоно уу.»* + re-auth link | Telegram immediately; founder too |
| Reception | Anthropic down | pinned fallback + phone | *«Түр зуурын саатал»* with live status | Telegram only past 15 min |
| Reception | comment cap hit | no public reply | banner + the post that caused it | Telegram |
| Care | no transport / no data source (**always, today**) | nothing is sent | *«Customer Care AI: тохируулагдаагүй (SMS холболт ба захиалгын мэдээлэл хүлээгдэж байна)»* — an honest permanent state, not an error | Dashboard only |
| Analytics | budget 0 or model down | n/a | report ships, templated, with a note | Telegram with the report |
| Analytics | run failed | n/a | *«Тайлан бэлдэж чадсангүй»* + a budget-gated re-run button | Telegram + founder alert |
| Quality | anything | n/a | **nothing — the tenant never sees Quality** | Founder only |

Two rules that make this honest rather than decorative. **A degraded role is visible before the tenant asks** — the banner and the Telegram message are written by the same event that wrote the `role_health` row; there is no path where the state changes and nobody is told. **The customer is never the one who discovers it** — every Reception degradation has a customer-facing behaviour that is a true sentence with a human route in it. The one exception is a revoked token, where Meta will not carry our words at all, which is exactly why that case is `urgent`, escalates to the founder, and drives the `last_webhook_at` watchdog.

---

## 7.8 Open questions — the founder's call, not mine

1. **Does `matrixecosalon.org` preserve an unknown query parameter through its booking flow, and does its platform expose a webhook or API?** Blocked by this session's egress proxy, so unverified. This single answer decides whether Matrix's report can reach Tier B or is capped at Tier A + C forever, **and** whether Customer Care has an event feed at all (§7.2.0). Ten minutes with a browser; it gates two roles.

2. **Can each tenant get its own SMS sender id / short number in Mongolia, and at what per-tenant cost?** §7.2.2 makes it a procurement disqualifier because with a shared sender an inbound «БОЛИ» has no recoverable tenant. If MN operators will not issue per-tenant senders to a small company, the fallback is a shared sender with a **global** block on STOP — safe in direction (it only ever refuses) but it lets one tenant's customer silence another tenant's messaging. Which trade is acceptable is a business call, and it must be made before an operator contract is signed, not after.

3. **Does Customer Care ship as SMS-only, or does Dalatech commit to Meta's Utility Template approval track as a second product surface?** The legacy tags died 2026-04-27 and `HUMAN_AGENT` forbids AI-authored text, so "AI-written outbound reminders on Messenger" is not buildable as specified. SMS-only is honest and slow; the template track is approval-gated, category-constrained and possibly per-message priced. Selling Customer Care before either exists is the risk.

4. **What is a tenant's monthly AI budget, and what happens at the ceiling?** Designed here as `acknowledge_only` + handoff line + alert, because going silent on a Saturday is the worst outcome. Hard stop / degrade / auto-overage-bill is a pricing decision, and the ledger cannot be finished without the number.

5. **Who is paged when a tenant's page token dies at 02:00, and what is the promised time-to-restore?** Designed as Telegram-first, email fallback, 20-minute unacknowledged-handoff watchdog. Whether that is contractual, and whether the founder is on the hook overnight, is a commitment.

6. **Do Matrix's pinned Mongolian strings get re-reviewed on migration?** `CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY`, `BOOKING_LINE` (`/home/user/Matrix-Chatbot/lib/salonBrain.js:52-81`) were native-speaker reviewed for *that* prompt in *that* context. Moving them into `canned_responses` and changing the surrounding prompt changes the conditions they were validated under. Re-review is a day of a native speaker's time; skipping it should be a recorded decision.

7. **Is `refusal_topics` ever tenant-self-serve, or founder-approved forever?** "Never quote a price for X, say this instead" is valuable and dangerous — a tenant who sets it carelessly gets a bot that refuses to sell, and blames the product.

8. **Does the tenant get a dashboard login in v1 at all?** If Matrix and GS Auto get a monthly report and Telegram alerts instead, then all the `authenticated`-role RLS machinery is dead weight in v1 and the whole security budget should go to the service-role path, where all the volume and all the spend are. The highest-leverage scoping decision available.

9. **Comment handling in v1, or DM-only first?** Comments expand the App Review surface (`pages_manage_engagement`, `instagram_manage_comments`), add per-event enrichment calls against each tenant's Graph budget, and put the bot's output on a public wall where a mistake is a screenshot. DM-only first is the conservative sequence; comments are the feature a salon owner will actually ask for.

10. **How is the causal claim handled in the sales conversation?** §7.3 deliberately downgrades the headline from "revenue Dala AI drove" to "bookings that passed through our link", and adds a limitation that points against us. That is the correct engineering answer and it is a weaker sales line than the one the product brief implies. If the founder wants a defensible causal number, the only honest instrument is a **held-out period** — the bot off for a fortnight, or on for one channel and off for another — and that costs real bookings to measure. Whether to run one, and when, is a business decision that must be made before the first invoice, not after the first sceptical client.