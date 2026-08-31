> **The DDL in this file is superseded.** It was one of eight independently written
> proposals, and [`09-reconciliation.md`](09-reconciliation.md) arbitrated the twenty-three
> places they contradicted each other. The schema is
> [`../schema.md`](../schema.md) + `supabase/migrations/0001_initial_schema.sql`, which
> is applied and verified; where this file disagrees with either, this file is stale.
> The reasoning here is still live — it is why the schema is shaped as it is.

## 1. Tenant model and configuration

The tenant is a row, its knowledge is rows, its credentials are rows, and its prompt is *compiled* from those rows at publish time into an immutable snapshot. Nothing about a tenant is a module, an env var, a branch, or a deploy.

The hard test — *onboarding client #3 is filling in a config, not writing code* — is the constraint every decision below answers to. But the honest version of that claim, after the critiques, is narrower than the slogan: onboarding client #3 is **(a)** filling in one validated document, **(b)** affirmatively ticking what does not apply to them, **(c)** confirming the Page name Meta reports, **(d)** having a native speaker review ~6 verbatim Mongolian strings, and **(e)** running a probe pass whose observed failures become forbid-rules. That is an afternoon of a person's time and roughly $2 of metered Anthropic spend. It is not a code change, not a deploy, and not a git branch — which is the whole point. Claiming it is "just a form" would be the same overclaim `CLIENT_ONBOARDING.md:7-9` makes today ("Open `/config/currentClient.js` and update the following sections" — then `npm run build:react` and redeploy).

Every `path:line` citation below was read in the file this session. Every "verified by execution" was run in this session against the real modules on Node 22. Assumptions are marked as such.

---

### 1.1 The tenant record and its lifecycle

#### 1.1.1 The row

```sql
create table tenants (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique,      -- 'matrix-eco', 'gs-auto'
  display_name            text not null,
  legal_name              text,
  timezone                text not null,             -- IANA: 'Asia/Ulaanbaatar'
  primary_locale          text not null default 'mn-MN',
  vertical                text not null,             -- 'salon' | 'auto_service' | 'generic'
  lifecycle               text not null default 'onboarding'
    check (lifecycle in ('onboarding','active','suspended','churned')),
  suspension_reason       text
    check (suspension_reason in ('nonpayment','abuse','founder_hold','tenant_request')),
  suspension_reply        text not null default 'silent'
    check (suspension_reply in ('silent','canned')),
  budget_exhausted_policy text not null default 'canned'
    check (budget_exhausted_policy in ('silent','canned','continue')),
  live_config_version     int,
  probe_run_id            uuid,
  created_at              timestamptz not null default now(),

  constraint active_requires_published_config
    check (lifecycle <> 'active' or live_config_version is not null),
  constraint active_requires_probe_run
    check (lifecycle <> 'active' or probe_run_id is not null),
  constraint suspended_requires_reason
    check (lifecycle <> 'suspended' or suspension_reason is not null)
);
```

`slug` is the log prefix, the Redis namespace, the rate-limit key prefix and the ledger dimension. It is `unique` because those namespaces must not collide.

`vertical` selects a probe template set (§1.7.5) and a set of inherited platform defaults. It selects **no code path**. If it ever selects a code path, this design has failed.

#### 1.1.2 What is deliberately *not* in this row

No model ID, no prompt text, no phone number, no price, no Page token, no closure dates, no timezone offset in minutes. Every one of those exists as a hardcoded constant in the ancestor — `ANTHROPIC_MODEL = 'claude-sonnet-5'` (`lib/salonBrain.js:19`), `HUMAN_PHONE = '7741-7777'` (`:41`), `SALON_UTC_OFFSET_MINUTES = 8 * 60` (`config/closures.js:32`) — and each is a per-tenant fact wearing a platform constant's clothes.

#### 1.1.3 The lifecycle state machine

| State | Inbound persisted? | AI called? | Outbound sent? |
|---|---|---|---|
| `onboarding` | yes | **no** | **no** — plus a **founder alert**: a real customer has reached a Page bound to a non-live tenant, which is an onboarding bug, and it is urgent |
| `active` | yes | yes | yes (subject to `delivery_mode` on the binding, §1.2) |
| `suspended` | yes | **no** | only `suspended_notice`, and only under the four conditions in §1.1.4 |
| `churned` | **no** — the message body is not written | no | no — **page the founder**: Dalatech is receiving a former customer's private messages on a channel that should have been released |

The two `check` constraints are the load-bearing part. `active_requires_published_config` makes "a tenant serving customers with no published config" a state the database refuses to represent, not a state the code remembers to avoid — and the sibling's entire postscript is about the gap between those two things (`docs/security-audit-2026-08-23.md`, steps 1-2: a migration file existed, was believed shipped, and the HIGH it closed stayed open in production for weeks).

Constraints, foreign keys, unique indexes and **triggers** all still bind `service_role`. `BYPASSRLS` bypasses row-security policies only. That is the short list of things the database will still enforce against a bug in your own service-role code, and this design leans on all four.

#### 1.1.4 Suspension is not a licence to speak

A suspended tenant sends `suspended_notice` **only if** all four hold: `suspension_reply = 'canned'`; the reviewed response exists for the right `(key, locale, channel)`; the binding's `token_status = 'active'`; and `delivery_mode = 'live'`. Otherwise: silence, persist, alert. A tenant suspended for abuse must not get a free outbound channel, and a tenant suspended for nonpayment must not have their customers told so by a string nobody reviewed.

---

### 1.2 Channel identity — how an event becomes a tenant

```sql
create type channel_provider as enum
  ('facebook_page','instagram','sms','web_widget','voice');

create table channel_bindings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  provider      channel_provider not null,
  external_id   text not null,       -- Page ID | IG professional account ID | DID
  auth_flavour  text check (auth_flavour in ('facebook_login','instagram_login')),
  app_id        text,                -- which Meta app; nullable for sms/web_widget
  graph_version_override text,
  granted_scopes    text[] not null default '{}',
  subscribed_fields text[] not null default '{}',
  token_status  text not null default 'unconfigured'
    check (token_status in ('unconfigured','active','revoked','expired')),
  verified_name      text,           -- what Meta reports the Page is called
  name_confirmed_by  uuid,
  name_confirmed_at  timestamptz,
  delivery_mode text not null default 'shadow'
    check (delivery_mode in ('shadow','live','paused')),
  last_webhook_at timestamptz,
  released_at   timestamptz,

  constraint live_requires_name_confirmation
    check (delivery_mode <> 'live' or name_confirmed_at is not null)
);

create unique index channel_identity_active
  on channel_bindings (provider, external_id) where released_at is null;
```

The partial unique index is the whole security property: **one live identity maps to exactly one tenant, and the database enforces it.** `provider` is in the key because a Facebook Page ID and an Instagram professional account ID live in different namespaces and must not be allowed to collide.

**On the wrong-tenant binding (critique A7 was right, and its fix is better than the draft's).** The draft proposed alerting when `verified_name` "shares no token with `tenants.display_name`". That matcher fires on every legitimate Mongolian binding — «Матрикс Эко Салон» and "Matrix Eco Salon" share zero tokens — gets muted within a week, and then misses the one case it exists for. It also needs a tokenizer over Mongolian text, which §1.9 forbids doing casually. Replaced with something binary and locale-free: onboarding calls `GET /{page-id}?fields=name` **with that tenant's own token**, stores the answer in `verified_name`, and shows the founder *"Bind «<verified_name>» to tenant `gs-auto`?"*. Confirmation stamps `name_confirmed_by/at`, and `live_requires_name_confirmation` refuses to let the binding go live without it. The check moves to the moment a human is already looking at the screen, and no string is compared.

**`delivery_mode` is the soak.** A new binding starts `shadow`: events are received, resolved, persisted and (optionally) generated against, and **nothing is sent**. Promotion to `live` is an explicit act. This is also the mechanism for the Matrix cutover (§1.15 Q8).

**Assumed, and it is the highest-value item to re-verify before code:** that `entry[].id` is the routing key under both Instagram auth flavours. The Meta research packet could not open `developers.facebook.com` at all (403 on the CONNECT tunnel), and its secondary sources disagreed with Chatwoot's production code, which routes Instagram from `messaging[].recipient.id` / `sender.id` rather than trusting `entry.id`. The design therefore treats `entry.id` as the lookup key **and** cross-checks it against the messaging IDs, counting mismatches (§1.11 #9).

---

### 1.3 The knowledge base as data

#### 1.3.1 Prices have axes — this is the correction both critiques converged on

Matrix's price list is already two-dimensional and the dimensions are hidden inside the name string. Verified, `config/currentClient.js:38-41`:

```js
{ "service_name": "Эмэгтэй тайралт (Мастер)",    "price": "66,000 – 88,000" },
{ "service_name": "Эмэгтэй тайралт (1-р зэрэг)", "price": 55000 },
```

Gender and stylist tier are baked into text; the price is `number | string` in the same array, branched twice (`lib/systemPromptBuilder.js:18-23` and again at `:106-110`). And prompt rules 3 and 4 (`:131-132`) exist for one reason only: to make the model recover, in Mongolian prose, the dimensions the data model threw away. The deposit table (`:138-149`) is keyed on the same two axes and is therefore also unnormalisable under a flat model.

A flat `services × price` table means GS Auto's onboarder either writes 600 synthetic service names (`Тос солих (Land Cruiser 200)` …) or writes a paragraph of Mongolian prose into an override telling the model to ask which engine. The second is far more likely, and it is a per-tenant code branch wearing a data costume.

```sql
create table price_axes (
  tenant_id uuid not null references tenants(id),
  key       text not null,          -- 'gender' | 'stylist_tier' | 'vehicle_class' | 'material'
  ordinal   smallint not null,
  label     jsonb not null,         -- {"mn-MN": "Үсчний зэрэглэл"}
  values    jsonb not null,         -- ordered [{value:'master', label:{"mn-MN":"Мастер"}}, …]
  clarify_before_quoting boolean not null default true,
  clarify_question_key   text references canned_response_kinds(key),
  primary key (tenant_id, key)
);

create table services (
  tenant_id      uuid not null references tenants(id),
  id             uuid not null default gen_random_uuid(),
  canonical_name jsonb not null,    -- {"mn-MN": "Эмэгтэй тайралт"} — the ONLY name quoted
  group_key      text,              -- tenant-declared service family
  aliases        text[] not null default '{}',  -- folded; «гель маникюр» -> «Гелэн будалт»
  primary key (tenant_id, id),
  unique (tenant_id, id)            -- enables the composite FK below
);

create table service_variants (
  tenant_id   uuid not null,
  service_id  uuid not null,
  axis_values jsonb not null default '{}',   -- {"gender":"female","stylist_tier":"master"}
  variant_key text generated always as (config.variant_key(axis_values)) stored,
  price_kind  text not null check (price_kind in
                ('fixed','range','from','on_inspection','parts_extra','not_quoted')),
  amount_min  numeric(12,2),
  amount_max  numeric(12,2),
  currency    text not null default 'MNT',
  unit        text,                            -- 'per_nail', 'per_litre', null
  primary key (tenant_id, service_id, variant_key),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  constraint amounts_match_kind check (
       (price_kind = 'fixed'  and amount_min is not null and amount_max is null)
    or (price_kind = 'range'  and amount_min is not null and amount_max is not null
                              and amount_max >= amount_min)
    or (price_kind = 'from'   and amount_min is not null and amount_max is null)
    or (price_kind = 'parts_extra' and amount_min is not null)
    or (price_kind in ('on_inspection','not_quoted')
                              and amount_min is null and amount_max is null)
  )
);
```

`config.variant_key()` is a small `IMMUTABLE` SQL function that sorts the keys and NFC-normalises the values, so the generated column is legal and the uniqueness is real. That every key in `axis_values` names a declared axis is a **publish-validator** rule plus a trigger, not a check constraint — a check constraint cannot subquery, and pretending otherwise would be the "a rule I wrote down is a rule the database enforces" mistake this whole design is built against.

**Three deliberate properties.**

- **Zero axes is legal.** `axis_values = '{}'` is one variant, flat. Matrix can migrate its 40 rows verbatim on day one and decompose later; nothing forces a re-modelling exercise as a precondition of cutover. (This is where I part company with critique B: its single `axis_key`/`axis_value` column pair is too narrow — Matrix carries **two** axes simultaneously, so a single pair reproduces the same flattening one level down.)
- **`clarify_before_quoting` is what turns prose into a compiled rule.** `systemPromptBuilder.js:131-132` — "ask which tier", "ask male or female" — become generated text from the axis declaration. GS Auto's "which vehicle?" is generated the same way, from a different row.
- **Ranges are values, not display strings.** `"66,000 – 88,000"` with an en dash cannot be compared, summed, or validated, and Analytics AI will need to attribute revenue against it.

#### 1.3.2 "No price exists" is not "we won't say the price"

`price_kind` carries `on_inspection`, `from` and `parts_extra` as first-class values, tenant-writable like any other price field, each rendering from a tenant-authored canned response. That is deliberately **separate** from `disclosure_rules` (§1.3.4), which means *we know the price and will not state it*.

Conflating them inverts the risk profile and destroys the onboarding story. For a salon, non-quotable is one topic out of forty. For an auto centre it is most of the catalogue — bodywork, brakes, anything downstream of diagnostics, anything with parts. Under the draft, onboarding GS Auto meant the founder personally authoring ~20 founder-gated refusal rules. Withholding a *known* price is the dangerous act that deserves a founder gate; "we must see the car" is the ordinary one.

The compiler emits the forbid-rule from the enum, and it must be a **forbid**, not a description. From the bake-off's transferable finding (`docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`, "The technique that worked"): *"A rule that only describes the right answer loses to a model's disposition; a rule that forbids the specific wrong answer does not."* Sonnet went 0/3 → 3/3 only after the observed failure openings were named as forbidden. So for `on_inspection` the compiled block is not "refer to the phone" but *"never state or estimate a figure for a service whose price is `on_inspection`; do not reason from a similar service, a similar vehicle, or the adult price; do not say «ойролцоогоор» or «орчим»; the reply is exactly: «…»"* — with the specific wrong openings supplied by that tenant's probe run (§1.7.5).

#### 1.3.3 Canned responses, and their vocabulary is closed

```sql
create table canned_response_kinds (          -- PLATFORM-level, not per tenant
  key         text primary key,   -- 'handoff_to_human','fallback','closing_line',
                                  -- 'booking_direction','suspended_notice',
                                  -- 'budget_exhausted_notice','price_on_inspection', …
  required    boolean not null default false,
  consumed_by text not null,      -- 'compiler:booking_block' | 'runtime:lifecycle'
  description text not null
);

create table canned_responses (
  tenant_id   uuid not null references tenants(id),
  key         text not null references canned_response_kinds(key),
  locale      text not null,
  channel     channel_provider,             -- null = every channel
  body        text not null check (body is nfc normalized),
  reviewed_by uuid, reviewed_at timestamptz
);
create unique index canned_responses_pk
  on canned_responses (tenant_id, key, locale, coalesce(channel::text, '*'));
```

Critique A was right that an open key vocabulary produces dead config that looks live: the founder adds `warranty_notice` for GS Auto because it looks like the place such things go, nothing consumes it, it validates, it publishes, `content_hash` changes, and the bot never says it. Symmetrically, a typo (`handoff_to_humans`) makes a *required* response silently absent.

**One line of disagreement on the fix.** Critique A proposed a `check` constraint enumerating the keys. That works, but it makes adding a response kind a schema migration — mildly against this section's own thesis. An FK to a `canned_response_kinds` reference table gives identical enforcement while making the addition a row insert, and it carries `consumed_by`, which documents *what actually emits the string*. Adding a kind still requires a compiler change; that change is the real gate, and it should be code-shaped.

`reviewed_by`/`reviewed_at` exist because these strings are the reason the ancestor works at all. `lib/salonBrain.js:48-51` records why, verbatim: garbled Mongolian and an invented Russian word (`дополнительн`) in live replies, so closings, handoffs, fallbacks and the children's line are pinned to native-reviewed sentences the model copies letter for letter. A canned response with a null `reviewed_at` is a blocking publish error.

#### 1.3.4 Two kinds of "don't answer that", and they are not the same table

```sql
-- WE KNOW AND WILL NOT SAY. Founder-authored (§1.15 Q4).
create table disclosure_rules (
  tenant_id      uuid not null references tenants(id),
  key            text not null,             -- 'children_services'
  topic_examples text[] not null,           -- NFC; the compiler QUOTES these
  reply_key      text not null references canned_response_kinds(key),
  quote_price    boolean not null default false check (quote_price = false),
  approved_by    uuid not null,
  approved_at    timestamptz not null,
  primary key (tenant_id, key)
);

-- WE CANNOT KNOW. Platform defaults, tenant-extensible.
create table out_of_scope_topics (
  tenant_id      uuid,            -- null = platform default, inherited by every tenant
  topic_key      text not null,   -- 'per_customer_job_status' | 'live_availability'
                                  -- | 'personal_appointment' | 'clinical_advice'
  topic_examples text[] not null,
  reply_key      text not null references canned_response_kinds(key),
  escalation     text not null check (escalation in ('phone','human_handoff','silent')),
  product_gap    boolean not null default true
);
create unique index oos_pk
  on out_of_scope_topics (coalesce(tenant_id::text,'*'), topic_key);
```

Critique B is right that the config surface as drafted expresses only class-level facts — services, prices, staff, hours, closures — which is nearly complete coverage for a salon and badly incomplete for anything else. GS Auto's top inbound message is «Машин маань бэлэн болсон уу?» ("is my car ready?"). A restaurant gets «Ширээ сул байна уу?». A dental clinic gets «Шүд минь өвдөж байна, юу болов?», which is a request for medical advice and is not a price, a fact, or a disclosure. With no data source *and no configured refusal*, the model either invents ("Тийм ээ, бэлэн байна" — catastrophic for a car) or falls to a context-free handoff line, which reads as a broken bot on the question the customer cares most about.

`product_gap` is why these are a separate table: an out-of-scope hit is a signal for the **product** (build a job-status integration), not a knowledge-base gap. It must never enter the Quality layer's KB-proposal queue.

**One line of disagreement on mechanism.** Critique B specified `matcher_terms text[]` as a runtime matcher. I take the table and reject the matcher. A substring pass over the customer's Mongolian text deciding to suppress the model is precisely the bug class verified by execution in this session against the real ancestor modules:

```
detectShortcutIntent('Уучлаарай асуумаар байна', {hasHistory:false})  ->  'greeting'
detectShortcutIntent('Facebook хаяг байна уу',   {hasHistory:true})   ->  'location'
```

«Уучлаарай» ("excuse me") is one of the commonest Mongolian service openers, and it is swallowed by `GREETING_REGEX = /^(сайн|байна|уу|hi|hello|hey)/i` (`lib/salonIntents.js:26`) because the pattern is unanchored at the right edge. The second case asks for the Facebook page and gets a Google Maps card. So `topic_examples` are **compiler input** — quoted into a first-line gate with a decision step and a verbatim reply, per the bake-off technique — not a runtime regex.

#### 1.3.5 Staff, booking, hours, closures, facts

- **`staff_groups`** — tenant-declared `(key, label jsonb, ordinal)` plus an FK from `staff`. This replaces `gender: 'female'|'male'|'manicure'` (`config/currentClient.js:18-28`; a service line encoded as a gender, and typed that way at `types/clientConfig.ts:20`) and the three hardcoded headings at `systemPromptBuilder.js:69-84`, which have **no `else` branch** — a member with an unrecognised value silently vanishes from the prompt. The new renderer fails loudly instead, following `systemPromptBuilder.js:36-38`'s own precedent: refuse to render prices rather than risk serving a category the official list doesn't carry.
- **`booking_requirements`** — keyed on `(service_group, axis_values)`, the same axes as pricing. Matrix's deposit table becomes six rows instead of twelve lines of template literal.
- **`booking_handoff`** — URL plus a `booking_direction` canned response. `BOOKING_LINE` (`lib/salonBrain.js:79-81`) currently hardcodes the literal string `QPay-ээр` and the phrase `урьдчилгаа төлбөр`; GS Auto may use neither.
- **`tenant_closures`** — `(start, end, title, verbatim_message)` rows, **and no default, ever**. `config/closures.js:40-52` ships a Naadam 2026-07-11..17 closure in code that applies to any deployment not overriding it. Three properties from that module survive verbatim because each encodes a real decision: the message is quoted, never model-composed (`:22-26` — Mongolian date suffixes are not safely generated); the window is evaluated per request against the tenant's own IANA timezone; and a malformed row is ignored with an alert rather than announcing a wrong break (`:113-121`).
- **`business_hours`, `tenant_facts`** — ordinary rows. FAQ answers carry **no markup**: `config/currentClient.js:91` stores `<br><br><a href=…>`, which the website renders and `lib/messengerText.js` strips back out. Store the fact and the URL; let a per-channel renderer decide.

#### 1.3.6 "Not applicable" and "missing" are different states

Critique B is right, and this is an alerting-integrity issue, not a nicety. GS Auto is *correctly* configured with zero `booking_requirements` (no deposits), no booking URL, no meaningful staff groups, no closures. Under the draft each of those produced an `omitted_sections` entry and an alert **on a healthy tenant** — on the same channel as "a real customer reached an `onboarding` tenant" (urgent) and "Graph 190, this tenant is silently dead" (urgent). Those are exactly the alerts that get lost.

It is also a correctness bug. Zero rows cannot be distinguished from "onboarding stopped halfway", so under the fail-safe precedent the compiler must emit nothing — but the customer asked «Урьдчилгаа төлөх үү?» and the correct answer is the *positive* «Урьдчилгаа шаарддаггүй», which the draft could never produce.

Every optional section therefore carries a tri-state resolved **at publish, not at serve**:

| State | Set by | Compiler | Alerts? | Publish |
|---|---|---|---|---|
| `configured` | rows exist | renders | no | allowed |
| `not_applicable` | an affirmative tick in the onboarding document | emits the **positive** statement from a canned response | **never** | allowed |
| `missing` | neither | — | — | **blocked** |

The ticks are the onboarding checklist, and they are self-documenting for vertical #3.

---

### 1.4 The same schema, two verticals, zero code difference

**Matrix column: verified from `config/currentClient.js`. GS Auto column: ASSUMED — the vertical is real, the values are invented illustration. The structure is the deliverable, not the numbers.**

| Config surface | Matrix Eco Salon | GS Auto Center |
|---|---|---|
| `vertical` | `salon` | `auto_service` |
| `timezone` | `Asia/Ulaanbaatar` | `Asia/Ulaanbaatar` |
| `price_axes` | `gender` (эмэгтэй / эрэгтэй), `stylist_tier` (Мастер / 1-р зэрэг) | `vehicle_class` (сууны / жийп / микро), `engine_volume` |
| `staff_groups` | Эмэгтэй үсчид · Эрэгтэй үсчид · Маникюр баг | Мотор · Явах анги · Цахилгаан |
| `price_kind` mix | 40 variants, all `fixed` or `range` | `fixed` (тос солих) · `from` (оношилгоо) · `on_inspection` (тоормос, засвар) · `parts_extra` |
| `booking_requirements` | 6 rows on (family × tier): 20,000₮ / 10,000₮ | **`not_applicable`** — ticked |
| booking hand-off | `matrixecosalon.org`, QPay deposit language | phone only; booking URL **`not_applicable`** |
| `disclosure_rules` | `children_services` — founder-approved, the one deliberate omission | none (or warranty terms) |
| `out_of_scope_topics` | platform defaults only | + `per_customer_job_status` — *the top inbound message* |
| `canned_responses` | 6 reviewed strings | ~7 reviewed strings |
| `closures` | rows, no default | rows, no default |
| **Code difference** | **zero** | **zero** |
| **Deploy required** | **none** | **none** |

---

### 1.5 Capabilities, plans, and where the money gate sits

```sql
create table platform_capabilities (
  key         text primary key,   -- 'reception','customer_care','analytics','voice','quality'
  status      text not null check (status in ('available','gated','disabled')),
  gate_reason text
);
insert into platform_capabilities values
  ('reception',     'available', null),
  ('analytics',     'available', null),
  ('quality',       'available', null),       -- admin-only, never client-facing
  ('customer_care', 'gated',     'mongolian_sip_trunk_absent'),
  ('voice',         'disabled',  'phase_4_out_of_scope');

create table tenant_capabilities (
  tenant_id  uuid not null references tenants(id),
  capability text not null references platform_capabilities(key),
  entitled   boolean not null default false,
  primary key (tenant_id, capability)
);
```

**The platform status is checked first, before tenant resolution.** A `gated` or `disabled` capability cannot be turned on for a tenant by data alone. That is what "design the seam, do not build it" means mechanically: Customer Care and Voice have a row, a config shape, a failure code and a policy table, and no path to a send.

```sql
create table outbound_policies (
  provider                 channel_provider primary key,
  window_hours             int,          -- 24 messenger/instagram; null sms
  free_form_outside_window boolean not null,
  template_required        boolean not null,
  ai_authored_allowed      boolean not null,
  per_message_cost_usd     numeric(10,5)  -- NULL = unknown price -> REFUSE
);
```

A send is refused unless the policy permits it **and** `per_message_cost_usd is not null` **and** the ledger affords it. `NULL` refuses rather than defaulting to zero — the same reasoning that made `BANK_BUILD_BUDGET_USD` zero next door: a value that refuses without depending on an unreliable read.

This is deliberately **not** modelled as "message tags". Per the Meta research: the legacy tags (`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE`) were retired 2026-04-27 and now return error `100`; `HUMAN_AGENT` survives but forbids AI-authored text and Meta says it detects misuse. Building a tag column would encode a dead mechanism into the schema.

```sql
create table model_tiers (
  key      text primary key,                  -- 'standard' | 'premium'
  model_id text not null check (
    model_id in ('claude-opus-5','claude-sonnet-5','claude-sonnet-4-6','claude-haiku-4-5')
    and model_id !~ '[0-9]{8}$'               -- no date suffix, ever
  ),
  min_cacheable_prefix_tokens int not null,   -- 4096 for claude-haiku-4-5
  thinking jsonb,                             -- {"type":"adaptive"} — never budget_tokens
  effort   text,                              -- output_config.effort
  input_usd_per_mtok  numeric not null,
  output_usd_per_mtok numeric not null
);
```

The date-suffix check exists because `api/chat.js:13` pins `'claude-haiku-4-5-20251001'`. This is one of the few places an ASCII character class is legitimate — a model ID is not user text, and §1.9's ban is specifically about user text. `budget_tokens` is absent because it is rejected with a 400 on Opus 5 and Sonnet 5.

`min_cacheable_prefix_tokens` is load-bearing and connects to §1.7.4: on Haiku 4.5 a prompt under 4,096 tokens **silently fails to cache** — no error, just full-price input on every message. A small tenant's compiled prompt can land under it. The publish validator refuses a Haiku tier when `snapshot.prompt_tokens < min_cacheable_prefix_tokens` unless the founder explicitly acknowledges it in the document.

Budgets are a row per tenant (`monthly_usd_ceiling`, `daily_usd_ceiling`, `per_message_usd_cap`, `alert_at_pct`). The ledger itself belongs to another section; what belongs *here* is the gate order, which is fixed and non-negotiable: **identity → entitlement → budget, each refusing on error, quota helpers returning 503 on any failure.** Never `try { check() } catch { continue }` — that exact pattern was the HIGH finding next door. The ancestor has no gate at all: `generateSalonReply` (`lib/salonBrain.js:177`) checks only that `ANTHROPIC_API_KEY` exists and calls the API, and the Messenger path has no rate limiting of any kind.

---

### 1.6 Per-tenant secrets

A Page access token is per-tenant **data**, so "secrets from the environment only" does not survive contact with N tenants. It becomes envelope encryption with the KEK in the environment:

```sql
create table channel_secrets (
  binding_id   uuid not null references channel_bindings(id),
  kind         text not null,   -- 'page_token' | 'ig_token' | 'sip_password'
  ciphertext   bytea not null,  -- AES-256-GCM(secret, DEK); AAD = binding_id || kind
  wrapped_dek  bytea not null,  -- AES-256-GCM(DEK, KEK)
  kek_version  int not null,
  status       text not null default 'active'
                 check (status in ('active','rotating','revoked')),
  last_ok_at   timestamptz,
  last_error   text,            -- Meta's numeric code ONLY, never the token
  primary key (binding_id, kind)
);
```

Recommended over Supabase Vault on blast-radius grounds: both are equivalent against a stolen database backup, but Vault's `decrypted_secrets` view decrypts on read for `service_role` — so a leaked `sb_secret_` key yields every tenant's token in plaintext, while envelope encryption yields ciphertext because the KEK lives in Vercel's environment, a different vendor. A leaked service key is the more likely incident for a solo founder on a public repo. (Vault also sits at `public alpha` and is mid-reimplementation as pgsodium is deprecated — a secondary reason, not the main one.)

Four details: **AAD binds ciphertext to its row**, so copying binding A's ciphertext onto binding B fails authentication instead of decrypting. **`revoke all … from anon, authenticated`**, not merely "no policy" — a future `grant all on all tables in schema public to authenticated` would otherwise silently re-open it. **Never log a decrypted token, `wrapped_dek`, or a token prefix** — the sibling still logs QPay bank details on error, and this is that bug's larger sibling. **Decrypt per request, cache in request scope only** — a module-level `let token` on Vercel is a cross-tenant leak with a warm-lambda half-life.

Two rotations, and conflating them is how this goes wrong. **KEK rotation** is yours: add `META_TOKEN_KEK_V2` alongside V1, walk the table unwrapping with V1 and re-wrapping with V2, never touching plaintext, then confirm `select count(*) where kek_version <> 2` is `0` **by querying the database**, not by the job reporting success. **Token invalidation** is Meta's: on Graph `190`, set `status='revoked'` and `token_status='revoked'`, stop all outbound on that binding, keep persisting inbound, alert — and **never retry a `190`**, which is how a webhook queue becomes a rate-limit ban on the shared Meta app.

The replaced anti-pattern is one line: `function pageToken(explicit) { return explicit || process.env.PAGE_ACCESS_TOKEN; }` (`lib/messengerClient.js:67-69`). In a multi-tenant build that fallback means tenant B's message goes out on tenant A's token. The token becomes a required argument resolved by `binding_id`; missing means refuse.

---

### 1.7 The config document, the validator, and the snapshot

#### 1.7.1 One document per tenant, and one writer

Critique A is right that "onboarding = insert rows, publish, no deploy" never said *what writes the rows* — and the house habit next door is pasting SQL into the Supabase dashboard editor. Composite FKs catch a cross-tenant `conversation_id`; they do **not** catch a mistyped `tenant_id` on `canned_responses` or `disclosure_rules`, because another real tenant's UUID satisfies `references tenants(id)` perfectly. GS Auto's warranty refusal lands on Matrix and ships in Matrix's next snapshot.

So the onboarding artefact is literal: **one validated JSON document per tenant**, diffable, reviewable, versioned. It is the only input to `POST /api/admin/tenants/{slug}/publish`, and that route (running as a dedicated named secret key, not the general service key) is the **only writer of `tenant_config_snapshots`**. Content tables carry a restrictive deny against every role but that path plus a `before insert or update` trigger on the snapshot table that refuses any writer without the publish route's session GUC. Hand-written SQL can populate drafts; it cannot produce a live snapshot.

#### 1.7.2 The snapshot

```sql
create table tenant_config_snapshots (
  tenant_id      uuid not null references tenants(id),
  version        int not null,
  schema_version int not null,
  document       jsonb not null,   -- the validated source document
  compiled       jsonb not null,   -- prompt_blocks, lookup tables, fold tables
  content_hash   text not null,    -- sha256 over STABLE blocks only (§1.7.4)
  prompt_tokens  int,              -- measured from a usage block, not estimated
  omitted_sections        jsonb  not null default '[]',
  not_applicable_sections text[] not null default '{}',
  published_by   uuid not null,
  published_at   timestamptz not null default now(),
  primary key (tenant_id, version)
);
```

Immutable, enforced by a trigger that raises on `UPDATE`/`DELETE` — a trigger, because a restrictive policy would not bind `service_role` and a trigger does. `tenants.live_config_version` is the pointer; rollback is setting it back to 6.

Reading a snapshot whose `schema_version` exceeds the reader's is a **503**, never a best-effort parse. The compiler supports N and N−1 for one deploy cycle.

#### 1.7.3 The validator

Blocking errors name the exact path — `canned_responses.handoff_to_human[mn-MN][*] missing`, not "config invalid". It rejects: a missing required canned response; a canned response with null `reviewed_at`; an axis value not declared in `price_axes`; a `price_kind` whose amounts contradict it; an optional section in state `missing`; overrides over budget or on their third renewal (§1.8); a Haiku tier under the cacheable minimum; and a document whose text is not NFC-normalised.

At publish it renders the full prompt and shows the founder a **diff against the live version**. That is the only defence against a config edited to something valid but wrong, and it is a weak one — see §1.11 #14, where this is stated plainly as unsolved.

#### 1.7.4 Stable versus volatile sections — the prompt cache depends on it

Critique B is right, and the ancestor already solved this before the draft dropped the reasoning while porting the data. `lib/salonBrain.js:139-155` deliberately keeps the closure section *out of* `cachedBasePrompt`, with the comment: *"a warm lambda can outlive the end of the break, and a cached section would keep announcing a holiday after the salon reopened."* It is evaluated per request.

The same property must survive as a schema concept, for a second reason: **`content_hash` is the Anthropic prompt-cache key.** A restaurant's daily special, a sold-out dish, a mechanic on leave, a changed delivery cutoff — each would be a version bump, a new hash, and therefore a cold cache and a 1.25× cache *write* on the next message over a prompt of Matrix's order of magnitude. Publish at 11:00 and again at 17:00 on a slow Tuesday and the cache never amortises: keeping a tenant's config current would make them strictly more expensive.

So every section declares `volatility ∈ {stable, volatile}`. `content_hash` covers stable sections only; volatile sections compile into an **uncached suffix** evaluated per request, in exactly the closure's existing position. Volatile edits are validated and audited but publish without a version bump and without founder ceremony. A daily special becomes a form field.

`prompt_tokens` is recorded from a real `usage` block rather than estimated. The ancestor logs `cache_read / cache_creation / uncached` per response (`lib/salonBrain.js:249-253`) precisely because a cache miss is invisible in the reply and quietly bills full price — keep that, per tenant.

#### 1.7.5 The probe gate — measurement made structural

Critique B is right that "onboarding #3 is filling in a config" was not true as stated, and the reason is the bake-off's own finding. The observed failure opening is a property of the **vertical**, not the platform. Matrix's was reassurance-then-teach. GS Auto's will be «ойролцоогоор 150,000₮ орчим» — estimating from a similar vehicle — plus inventing a parts price. A dental clinic's will be a tentative diagnosis. None is forbidden by any rule the compiler can generate from Matrix's config, and a rule that merely describes the right answer loses.

```sql
create table probe_templates (
  vertical  text not null,     -- 'salon' | 'auto_service' | 'generic'
  key       text not null,
  message   text not null,     -- the customer message to send, NFC
  expects   text not null check (expects in
              ('no_price','clarify_first','verbatim_reply','out_of_scope_referral')),
  primary key (vertical, key)
);
create table probe_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  config_version int not null,
  ran_at timestamptz not null default now(), ran_by uuid not null,
  passed int not null, failed int not null,
  cost_usd numeric(10,4) not null      -- metered, attributed, charged like any other spend
);
create table forbidden_phrasings (
  tenant_id  uuid not null references tenants(id),
  id         uuid not null default gen_random_uuid(),
  opening    text not null,            -- the observed wrong answer, verbatim
  applies_to text not null,            -- disclosure key | oos topic | price_kind
  observed_at timestamptz not null,
  evidence   jsonb not null,           -- probe_run id or conversation id
  primary key (tenant_id, id)
);
```

`active_requires_probe_run` (§1.1.1) makes this a state the database enforces rather than a step someone remembers. The probes cost Anthropic money, so they go through the same budget gate and are attributed to the tenant as an onboarding line item — nothing spends unmetered, including our own tooling. The validator additionally requires a probe run at or after the last version that changed `price_axes`, `disclosure_rules` or `out_of_scope_topics`.

#### 1.7.6 The Quality layer's write path

The Quality layer proposes; it never writes config and never auto-applies.

```sql
create table config_change_proposals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  origin       text not null check (origin in ('quality_ai','founder','tenant_owner')),
  target_table text not null check (target_table in
                 ('services','service_variants','staff','tenant_facts',
                  'canned_responses','business_hours','out_of_scope_topics')),
  target_pk    jsonb not null,
  operation    text not null check (operation in ('insert','update','delete')),
  proposed     jsonb not null,
  evidence     jsonb,             -- the conversation ids that motivated it
  validated_at timestamptz,       -- validator ran against the SIMULATED post-apply draft
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected','applied')),
  constraint approval_requires_validation
    check (status <> 'approved' or validated_at is not null),
  decided_by uuid, decided_at timestamptz, applied_version int,
  created_at timestamptz not null default now()
);
```

Both of critique A's objections are folded. The `target_table` check confines proposals to content tables — never `tenants`, never `channel_secrets`, never `channel_bindings`, never `disclosure_rules` — so a generic applier consuming `(table, pk, jsonb)` cannot be steered at a credential. And `approval_requires_validation` means the founder approves a **decision**, not a syntax gamble: a proposal of `{amount_min: "55,000"}` that reads correct in the UI but would fail or render broken cannot reach `approved`.

Approval writes the **draft**. Publishing stays a separate, explicit founder act. That is what "never auto-applies" means mechanically: two humans-in-the-loop steps, both audited.

```sql
create table config_audit (
  id bigserial primary key,
  tenant_id uuid not null,
  at timestamptz not null default now(),
  actor text not null,                -- founder user id | 'system:validator'
  via   text not null,                -- 'admin_ui' | 'proposal:<uuid>' | 'migration'
  target text not null, operation text not null,
  before jsonb, after jsonb,          -- NEVER a secret column
  config_version_after int
);
```

---

### 1.8 `tenant_prompt_overrides` — the escape hatch, deliberately uncomfortable

Both critiques identified the same failure, and it is the most important one in the set: this table is where every gap in the schema will quietly drain. The repo stops accumulating per-tenant branches and the *database* starts. The precedent is in the ancestor: `MESSENGER_ADDENDUM` (`lib/salonBrain.js:86-106`) grew to 3,163 characters, roughly half of it spent cancelling website-specific rules in the base template — two channels sharing one template, each partially undoing the other.

```sql
create table tenant_prompt_overrides (
  tenant_id  uuid not null references tenants(id),
  id         uuid not null default gen_random_uuid(),
  block      text not null references prompt_blocks(key),   -- must name a REAL block
  body       text not null check (length(body) <= 400 and body is nfc normalized),
  reason     text not null,
  schema_gap text not null,        -- which concept the schema is missing
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  renewals   smallint not null default 0,
  primary key (tenant_id, id),
  constraint expiry_is_bounded check (expires_at <= created_at + interval '90 days')
);
```

Four teeth, all cheap:

1. **An override must name a block.** It appends to a declared prompt block, so it is visibly a patch on a known structure rather than free-floating prose.
2. **`schema_gap` is required.** Writing one forces the author to name the concept the schema lacks.
3. **A per-tenant character budget** (~800 total, roughly the bake-off's measured hardening cost of ~550 characters) enforced by the publish validator and a trigger.
4. **An override renewed twice becomes a schema field.** `renewals >= 2` is a blocking publish error naming the `schema_gap`.

And one number on the founder's dashboard, next to each tenant: `sum(length(body))` of live overrides. That is the single best leading indicator that the hard test is failing, and this design otherwise has no way to hear the alarm.

The draft's §1.13 row 20 pointed at expiry as the defence against another tenant's persona surviving in the bundle — `api/chat.js:337-383` still ships a DalaTech.ai *"Ахлах AI Борлуулалтын Зөвлөх"* sales persona with ROI objection handling, reachable only through `buildConversationSystemInstruction` at `:385-387`, whose only occurrence in the entire repo is its own definition (verified by grep). Expiry stops an override *persisting*; it does not stop overrides *accumulating*. Both mechanisms are needed.

---

### 1.9 Mongolian Cyrillic in the config layer

Everything in this subsection was verified by execution in this session, on Node 22, against the real ancestor modules.

**NFC-normalise at every input boundary and nowhere else.** `grep -rn "normalize("` over the whole ancestor returns nothing. The consequence, measured:

```
detectShortcutIntent('Байна уу')                 ->  'greeting'
detectShortcutIntent('Байна уу'.normalize('NFD')) ->  null
'Й'.normalize('NFD').length === 2   (NFC is 1)
'Ө' and 'Ү' do NOT decompose
```

So the same class of message matches or does not match depending on which letters it happens to contain and which keyboard the customer used — a silent, per-word, unreproducible inconsistency. `Й`, `й`, `Ё`, `ё` are the affected Mongolian letters. Enforce it in the database: `check (body is nfc normalized)` on every text column that participates in matching or rendering. Postgres has `IS NORMALIZED`, and checking is cheaper than converting.

**No `\b`, no `\w`, no `[a-z]` in any JavaScript regex over user text.** Verified: `/\bзасалт\b/` is `false`, and `/\bзасалт\b/u` is **also** `false` — the `u` flag does not fix it, because JavaScript defines `\b` in terms of `\w` and `\w` is permanently `[A-Za-z0-9_]`. There is no flag. `/\p{L}+/u` is `true`. Postgres disagrees with JavaScript here — `\y` and `\w` are locale-aware in Postgres — so a validation regex ported from `psql` to Node silently changes meaning. Where tokenisation is genuinely needed, `Intl.Segmenter` exists and works (verified: `[...new Intl.Segmenter('mn',{granularity:'word'}).segment('Уучлаарай асуумаар байна')]` yields the three words correctly).

**Three different lengths for one string.** The compiled Matrix base prompt, measured this session:

```
utf16 .length: 7824   |   code points: 7818   |   utf-8 bytes: 12866
```

Mongolian Cyrillic is 2 bytes per character, so every ASCII-derived length budget is ~1.9× too small. Meta's 2,000-character cap, `varchar(n)` sized by eye, and the ancestor's `.length` checks at `lib/messengerClient.js:52` and `lib/messengerText.js:78` all live in this trap. Character budgets use `Array.from(s).length`; byte budgets use `Buffer.byteLength`; they are never interchanged. (The ancestor's comment calling the prompt "~12.8k characters" at `lib/salonBrain.js:23` is quoting the *byte* count.)

**No `unaccent`, asserted in the catalog.** It maps `Ё → Е` and `ё → е` while leaving `Й`, `Ө`, `Ү` untouched — partially destructive on Mongolian, so it looks harmless in nine tests out of ten. `Ё` is a full letter (ёстой, ёс, Ёндон), not a decoration.

**Search folding is an explicit table you own**, applied only to a derived search column, never to stored canonical text:

```sql
create table mn_fold (src text primary key, dst text);
insert into mn_fold values ('ө','о'), ('ү','у'), ('й','и'), ('ё','е');
```

These are Mongolian keyboard-layout errors, not diacritics. Trigram similarity collapses on them — `similarity('өнгө','онго') = 0` because every character differs — so folding before matching is what makes fuzzy service-name lookup work at all.

**Collation asserted, because it cannot be fixed later.** `datcollate` cannot be changed after database creation, and under `C`/`POSIX` `lower('ҮС ЗАСАЛТ')` returns the string unchanged, silently. The assertion belongs in the same verification pack as §1.12's queries.

**And the semantic pre-filter is deleted.** Critique A is right. `isProfessionalQuestion` today gates a paid model call behind `hasBusinessContext = /салон|үйлчилгээ|үнэ|цаг|хаана|service|price/i` (`lib/validator.js:224` — the literal word «салон» in the platform's input filter) and a gibberish class `/^[^аеёиоуыэюя\s]{20,}$/i` (`:201`) that is the **Russian** vowel set, missing `ө` and `ү`, the two vowels that most distinguish Mongolian. When it is wrong the customer gets a canned "I don't have that information" with **HTTP 200** and `filtered: true` in a log nobody reads (`api/chat.js:58-73`). Replacing it with "tenant-declared stems" would convert a broken code heuristic into an unbounded per-tenant linguistic obligation the founder cannot discharge or verify. The filter's purpose was to save money; §1.5's budget gate does that properly, observably, and before the spend. Any surviving pre-model gate is a **length or rate** check, which needs no per-tenant data. A refusal must in any case be visible to the Quality layer, which is the whole point of having one.

---

### 1.10 The chokepoint: `withTenant`

There is exactly one path from an inbound event to a tenant-scoped anything. Route code should not be *able* to build a query without it — the `guardAiRoute()` lesson from next door: one gate, no local re-implementations.

```ts
type TenantContext = {
  tenantId: string; slug: string; timezone: string; locale: string;
  bindingId: string; provider: ChannelProvider; externalId: string;
  snapshot: CompiledConfig;   // keyed (tenant_id, version) — NEVER module scope
  budget: BudgetHandle;       // opened, not yet charged
  log(line: string): void;    // tenant_id stamped on every line
};

async function withTenant(entry, envelope, capability, fn) {
  assertPlatformCapability(capability);          // BEFORE anything tenant-shaped
  const key      = routingKey(envelope.object, entry);   // per ENTRY, not per request
  const binding  = await resolveChannel(key);            // throw -> 500; null -> 200+drop
  const tenant   = await loadTenant(binding.tenant_id);
  assertLifecycle(tenant);
  assertTenantCapability(tenant, capability);
  const snapshot = await loadSnapshot(tenant.id, tenant.live_config_version);
  const budget   = await openBudget(tenant.id);          // 503 on ANY error
  return fn(buildContext(tenant, binding, snapshot, budget));
}
```

| Code | HTTP (webhook) | HTTP (admin/API) | Behaviour |
|---|---|---|---|
| `signature_invalid` | 401 | — | Missing app secret is **401, never "skip verification"** |
| `channel_unresolved` | **200 + drop** | 404 | Persist raw envelope with `tenant_id = null`; counter `webhook.unrouted{provider}`; alert at ≥3/hour for one `external_id`. **Never auto-create a tenant** |
| `registry_unavailable` | **500** | 503 | Deliberately *not* 200 — see below |
| `tenant_not_active` | 200 + policy | 409 | §1.1.3 / §1.1.4 |
| `capability_platform_disabled` | 200 + drop | 403 | Checked before tenant resolution |
| `capability_not_entitled` | 200 + drop | 403 | |
| `config_not_published` | 200 + persist | 409 | Alert — a customer reached a Page bound to a non-live tenant |
| `config_schema_unsupported` | **503** | 503 | Never best-effort an unknown snapshot shape |
| `credential_missing` / `credential_revoked` | 200 + persist | 409 | Stop outbound on that binding. Never retry a Graph `190` |
| `budget_exhausted` | 200 + policy | 429 | Per `budget_exhausted_policy` |
| `tenant_not_provisioned` | 200 + persist | 409 | Distinct from 500 and from a silent skip — onboarding is incomplete, and that is an operator-visible state |

**The one asymmetry worth staring at: `channel_unresolved` is 200, `registry_unavailable` is 500.** An unknown channel is a *permanent* condition — retrying cannot help, and sustained non-200s get the asset unsubscribed after roughly an hour, losing a tenant rather than a message. An unreadable registry is *transient* — a 200 drops the event permanently; a 500 gets it redelivered. Getting these the same way round costs either one message or one tenant's entire subscription.

That is the same instinct as `api/messenger.js:118-133`, which the ancestor got right at one tenant: *"A timeout is ambiguous: the publish may actually have landed at QStash. Only DEFINITIVE (hard) failures are processed inline — processing a timed-out-but-succeeded publish inline too would double-reply."* Ambiguous failure is not failure. Promote it to a first-class rule.

**Per entry, never per request.** `body.entry` is an array of distinct event sources and one POST can legitimately carry entries for two different tenants, so `withTenant` runs once per entry and three entries produce three contexts, three ledger charges, three sets of log lines. The ancestor never notices because `api/messenger.js:164-180` iterates `body.entry` and **never reads `entry.id`** — tenant routing does not exist in it at all.

---

### 1.11 Failure modes

| # | Failure | Detection | Response |
|---|---|---|---|
| 1 | **Tenant not found for an inbound event** | resolver returns zero rows | ACK **200** (a 4xx risks unsubscription). Persist the raw envelope with `tenant_id = null`, flagged `unrouted`, 7-day retention, founder-read-only — the only tenant-less data in the system. Counter plus alert on repetition. **Never auto-create a tenant. Never a `?? DEFAULT_TENANT` fallback**, not even for local testing: that line, written once for convenience, is the single most likely source of a cross-tenant leak |
| 2 | **Registry unreachable** | resolver throws | **500**, accept the retry (§1.10) |
| 3 | **Tenant found, `onboarding`** | lifecycle | Persist, no AI, no send, **alert** — urgent |
| 4 | **Tenant found, `suspended`** | lifecycle + reason | Persist, no AI. Notice only under §1.1.4's four conditions; otherwise silent |
| 5 | **Tenant found, `churned`** | lifecycle | Drop, do **not** persist the body, **page the founder** |
| 6 | **A required field is missing** | validator | Cannot occur at serve time — `active_requires_published_config` plus the snapshot model. At publish it is a blocking error naming the exact path |
| 6b | **An optional section is absent** | tri-state (§1.3.6) | `not_applicable` → compiler emits the **positive** statement, **no alert**. `missing` → publish blocked. Only an *unrenderable* `configured` section is omitted-with-a-recorded-reason and alerts — generalising `systemPromptBuilder.js:36-38` |
| 7 | **Two tenants claiming one channel** | `channel_identity_active` | Impossible. The attempt raises `23505`; the admin route must translate it to *"Page 1234 is already bound to tenant `matrix-eco`"*, never a 500 |
| 8 | **Right page id, wrong tenant** | no constraint catches this | Founder confirms the Meta-reported Page name against the target tenant slug; `live_requires_name_confirmation` blocks activation without it (§1.2). No string matching |
| 9 | **Tenant misidentified** (catastrophic) | layered | (a) the resolver is the only path and keys off the *verified* envelope; (b) cross-check `entry.id` against `messaging[].recipient.id` — or `sender.id` for echoes — and count mismatches, because Chatwoot in production does not trust `entry.id` alone; (c) the send path takes a `binding_id`, fetches the token by it, and posts to `/{external_id}/messages`, **never `/me/messages`** (`lib/messengerClient.js:10`), so a mismatch fails instead of succeeding as the wrong salon; (d) `tenant_id` on every log line, cache key, rate-limit key and ledger row; (e) the prompt cache key is the snapshot `content_hash` |
| 10 | **Page token expired / revoked** | Graph `190` | `token_status='revoked'`, `channel_secrets.status='revoked'`, stop **all** outbound on that binding, keep persisting inbound, alert. Never retry a `190`. Per-*binding*: Messenger can die while Instagram lives |
| 11 | **Token dies silently and nobody notices** | absence of traffic | `last_webhook_at` watchdog per binding, plus periodic reconciliation of `GET /{page-id}/subscribed_apps` against the registry. A dead token produces no error anywhere — Reception simply stops replying |
| 12 | **Budget exhausted** | ledger | Per `budget_exhausted_policy`; the validator requires the canned response when the policy is `canned` |
| 13 | **Snapshot schema newer than the reader** | `schema_version` assertion | **503**. Compiler supports N and N−1 for one deploy cycle |
| 14 | **Config edited to something valid but wrong** | **nothing catches this** | Mitigations only: immutable snapshots with one-click rollback, `delivery_mode='shadow'` for a soak, a rendered-prompt diff at publish, a probe re-run when a gating section changed, and `config_audit` naming the actor. Stated plainly as unsolved |
| 15 | **Quality layer writes config directly** | `config_audit` anomaly | It writes proposals, never config, and `target_table` is constrained to content tables. `service_role` could of course write anywhere — RLS is not evaluated for it and `FORCE ROW LEVEL SECURITY` does not change that — so this is a chokepoint-and-audit control, not a database control, and must be described as one. A config write with `origin='quality_ai'` and no approved proposal is alertable |
| 16 | **Two tenants in one warm lambda** | the acceptance test (§1.13) | Nothing module-scope holds tenant content without a `(tenant_id, version)` key |
| 17 | **Alert fatigue** | — | Healthy tenants must generate zero routine alerts. #6b is the mechanism; without it #3 and #10 are lost in the noise |

---

### 1.12 RLS and ACL posture for these tables

Detail belongs to the security section; the per-table expectations belong here, because each table must be verified **independently** — the last failure next door was partial, one of four tables, and a spot check on the correct one confirmed the wrong conclusion (`docs/security-audit-2026-08-23.md`, step 1).

**Class A — `anon` and `authenticated` hold ZERO privileges:** `tenants` · `channel_bindings` · `channel_secrets` · `tenant_capabilities` · `platform_capabilities` · `tenant_config_snapshots` · `tenant_prompt_overrides` · `config_audit` · `config_change_proposals` · `webhook_events` · `probe_runs` · `forbidden_phrasings` · `disclosure_rules` · `model_tiers` · `outbound_policies`.

**Class B — tenant-owner readable, writable only where the owner legitimately authors the content** (`services`, `service_variants`, `staff`, `tenant_facts`, `business_hours`, `canned_responses` drafts, volatile sections):

```sql
create policy services_read on services for select to authenticated
  using (tenant_id = any ((select public.current_tenant_ids())::uuid[]));

create policy services_write on services for update to authenticated
  using      (tenant_id = any ((select public.current_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select public.current_tenant_ids())::uuid[]));
```

Three properties, all measured: the role is **named** (`to authenticated`), so the policy is not evaluated for `anon` at all; the predicate is wrapped in `(select …)`, worth ~15× when it cannot become an index condition (224 ms → 15 ms on 200k rows); and it uses `= any (array)`, which is index-eligible, rather than `array @> array[col]`, which is not (7 ms vs 55 ms). `current_tenant_ids()` is `SECURITY DEFINER` with `set search_path = ''`, because a policy that joins `tenant_members` runs that join under `tenant_members`'s **own** RLS — and a deny-all there makes the outer query return zero rows with no error, in 3.6 seconds, HTTP 200, `error: null`. That is the plausible-empty failure class, reproduced inside RLS itself.

**`WITH CHECK` must repeat the tenant predicate.** Omitting it on an `UPDATE` policy is a tenant-hopping write: `update … set tenant_id = <other tenant>` hands the row away.

**Class C — server-asserted, `SELECT`-only to clients, with per-command restrictive denies:**

```sql
create policy snap_no_insert on tenant_config_snapshots
  as restrictive for insert to anon, authenticated with check (false);
create policy snap_no_update on tenant_config_snapshots
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy snap_no_delete on tenant_config_snapshots
  as restrictive for delete to anon, authenticated using (false);
```

**Never `as restrictive for all using (true) with check (false)`.** That is the sibling's `_no_client_writes` shape, and it was verified by execution that **`DELETE` goes straight through it** — `DELETE` has no `WITH CHECK` clause and is governed by `USING`, which is `true`. It is masked next door by two accidents (no permissive write policy, no `DELETE` grant); remove either mask and deletes work. Do not copy the pattern forward. And never collapse to `for all using (false)`, which applies `USING` to `SELECT` and silently blinds the dashboard.

**Revoke the other privileges too.** `revoke insert, update, delete` is not "cannot write": `TRUNCATE` bypasses RLS entirely and was verified emptying a table under a restrictive `with check (false)` policy. `REFERENCES`, `TRIGGER`, and PG17's `MAINTAIN` sit in the same bucket. Enumerate the ACL with both null-traps closed:

```sql
select c.relname,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind in ('r','p')
group by 1,2 order by 1,2;
```

`coalesce(relacl, acldefault(...))` matters because a table created and never `GRANT`ed carries a **null** ACL and a bare `aclexplode` reports zero rows — another plausible-empty answer. `grantee = 0` matters because `pg_get_userbyid(0)` returns the string `'unknown (OID=0)'` rather than erroring, so a grant to `PUBLIC` (which `anon` inherits) appears under a nonsense name and gets skimmed past.

**`information_schema.role_table_grants` is banned in this codebase.** Verified live, same database, same instant: 72 `aclexplode` rows against 0 view rows for a non-participating role.

Two config-specific assertions belong in the same pack:

```sql
select datname, datcollate, datctype, pg_encoding_to_char(encoding)
from pg_database where datname = current_database();
-- must be UTF8; datcollate must NOT be 'C' or 'POSIX'

select extname from pg_extension where extname = 'unaccent';   -- must be empty
```

And the two structural checks that catch the entire class of the `20260817` failure — a table nobody remembered to migrate — must return **zero rows in CI**: every `public` table has RLS enabled and at least one policy (or sits on a written allow-list); every tenant-scoped table carries `tenant_id` **and** `tenant_id` leads an index.

**The honest statement that must accompany all of it.** RLS protects the dashboard. **It protects nothing on the inbound path.** Webhook → tenant lookup → Anthropic → send has no user session at any point and runs as `service_role` end to end; `service_role` carries `BYPASSRLS`, and `FORCE ROW LEVEL SECURITY` does not change that (it subjects the *table owner*, not a `BYPASSRLS` role). What substitutes, in order: the tenant derived server-side from a verified signal; the single chokepoint that both scopes and meters; **the constraints, foreign keys, unique indexes and triggers, which are the only database controls that still bind `service_role`**; and `tenant_id` on every log line and every key.

That is also why the composite foreign keys are not decoration:

```sql
create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  unique (tenant_id, id)
);
create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  conversation_id uuid not null,
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id)
);
```

A child row can never cross tenants, and referential-integrity checks are not subject to RLS — so this keeps working under any policy, which is exactly what is wanted against a service-role bug.

---

### 1.13 What this replaces in the ancestor — named removals

| # | What must go | Where it is now | Replacement |
|---|---|---|---|
| 1 | **Module-scope prompt cache** — the highest-severity multi-tenancy defect, invisible at one tenant | `lib/salonBrain.js:142` `let cachedBasePrompt = null`, built from the build-time `clientData` imported at `:11` | snapshot cache keyed `(tenant_id, version)`; prompt cache keyed `content_hash` |
| 2 | **Build-time tenant import** | `lib/salonBrain.js:11`, `lib/salonIntents.js:17`, `api/chat.js:9` | per-request snapshot from `TenantContext` |
| 3 | **`SALON_NAME` in every log line** — stamps the *build's* tenant, not the request's | `lib/salonBrain.js:46`, used at `lib/messengerProcess.js:80, 88, 117` | `slug` from the resolved context |
| 4 | **Credential fallback** — tenant B's message on tenant A's token | `lib/messengerClient.js:67-69` | required argument from `channel_secrets` by `binding_id`; missing ⇒ refuse |
| 5 | **`/me/messages`** — a token/tenant mismatch *succeeds* and posts as the wrong salon | `lib/messengerClient.js:10` | `/{external_id}/messages` |
| 6 | **`entry[].id` never read** — tenant routing does not exist | `api/messenger.js:164-180`; `FACEBOOK_PAGE_ID` at `:165` is only a self-echo guard | `resolveChannel(provider, entry.id)`, **per entry** |
| 7 | **Instagram silently dropped** | `api/messenger.js:99` — `object !== 'page'` ⇒ bare 200 | `channel_provider` enum + object→adapter dispatch |
| 8 | **Un-namespaced Redis keys** | `msgr:hist:<psid>` (`lib/conversationStore.js:88`), `msgr:done:<mid>` (`:53`) | `{slug}:msgr:hist:{psid}` — PSIDs are page-scoped, and a collision across tenants is not a thing to bet chat history on |
| 9 | **The deliberate omission encoded in code, twice** | `lib/salonBrain.js:70-72` plus a second copy at `systemPromptBuilder.js:135`, plus a comment at `currentClient.js:34-35` | one `disclosure_rules` row + one `canned_responses` row + `forbidden_phrasings` from the probe run |
| 10 | **Three hardcoded staff buckets with no `else`** | `systemPromptBuilder.js:69-84` | `staff_groups` + FK, failing loudly on an unknown group |
| 11 | **The deposit table as prose in a shared template** | `systemPromptBuilder.js:138-149` | `booking_requirements` keyed on the same axes; GS Auto is `not_applicable` |
| 12 | **Prices as display strings**, `number \| string`, axes hidden in the name | `currentClient.js:38-41`, branched at `systemPromptBuilder.js:18-23` and again at `:106-110` | `price_axes` + `service_variants` + `price_kind` |
| 13 | **Clarification rules as hand-written prose** | `systemPromptBuilder.js:131-132` | generated from `price_axes.clarify_before_quoting` |
| 14 | **A default closure shipped in code** | `config/closures.js:40-52` | no default, ever; `tenant_closures` rows |
| 15 | **A Mongolia-only timezone constant** | `config/closures.js:32` | `tenants.timezone`, IANA |
| 16 | **Closures as env vars** | `config/closures.js:140-151` | rows |
| 17 | **`QPay-ээр` and «урьдчилгаа төлбөр» hardcoded** | `lib/salonBrain.js:79-81` | `canned_responses['booking_direction']` |
| 18 | **Model id per deployment; one with a date suffix** | `lib/salonBrain.js:19`, `api/chat.js:13` | `model_tiers` + plan attribute + the date-suffix check |
| 19 | **«салон» in the platform's input filter; the Russian vowel set** | `lib/validator.js:224`, `:201` | the filter is **deleted** (§1.9); budget gate + length/rate checks |
| 20 | **Unanchored substring matchers over user text** | `lib/salonIntents.js:21, 26, 41` | `topic_examples` as compiler input, not a runtime matcher |
| 21 | **Another tenant's persona still in the bundle** | `api/chat.js:337-383`, reachable only via `:385-387`, which nothing calls | deleted; §1.8's expiry and budget rules are the defence against recurrence |
| 22 | **An unenforced type that has already drifted** | `types/clientConfig.ts:20, 38-47`; consumers hand-defend at `systemPromptBuilder.js:56-63` and `api/chat.js:339-345` | check constraints, FKs, and the publish validator — **one shape, validated at write time** |
| 23 | **Onboarding is a git branch** | `CLIENT_ONBOARDING.md:7-9, 52-56` — edit `currentClient.js`, `npm run build:react`, redeploy | one document, one publish route, no deploy |

#### What must be carried across unchanged

Five properties are hard-won and must survive the port intact, because each encodes an incident.

1. **Fast-ACK before any slow work** (`api/messenger.js:109-154`) — the thing standing between you and a silently unsubscribed tenant.
2. **Ambiguous failure ≠ failure** (`api/messenger.js:118-133`) — a timed-out enqueue may have landed; retrying it inline double-replies the customer. Promote the instinct into a real idempotency key rather than losing it in the rewrite.
3. **Raw-body HMAC with `timingSafeEqual`, failing closed on a missing secret** (`lib/messengerClient.js:25-42`, raw body preserved by `bodyParser: false` at `api/messenger.js:16-20`). In the App Router the equivalent is `await req.text()` before any parse, with no middleware consuming the stream first.
4. **`null` ≠ `[]` for history availability** (`lib/conversationStore.js:84-101`, consumed at `lib/messengerProcess.js:50-60`) — the greeting fires only when history is *confirmed* empty, so a Redis hiccup mid-conversation cannot make the bot greet an existing customer from scratch. The plausible-empty defence, already correctly implemented once in this codebase.
5. **Send first, mark handled second, one atomic send** (`lib/messengerProcess.js:96-99, 111-116`) — a failed send leaves nothing delivered and the retry is clean.

#### The acceptance tests for this section

Offline, with an injected clock and two fake tenants in one process. (An injected clock, because the ancestor's only test suite has been red for six weeks — `tests/closures.test.js:204` and `:226` assert the shipped default Naadam closure is active, it ended 2026-07-17, and the tests read the real wall clock.)

1. Process an event for tenant A, then tenant B, in the same warm instance. **B's reply must contain none of A's prices, staff names, phone number or booking URL** — assert on the rendered `prompt_blocks` hash, not on the reply text.
2. Publish a config change to A. B's snapshot version, `content_hash` and compiled prompt must be byte-identical before and after.
3. Bind a Page id to A, then attempt the same `(provider, external_id)` on B. Assert `23505`, and assert the admin route returns the actionable message rather than a 500.
4. Suspend A with `suspension_reply='canned'` and delete `suspended_notice`. Assert **silence**, an alert, and **zero** Anthropic calls.
5. Set A `lifecycle='active'` with `live_config_version = null` **by direct SQL**. Assert the check constraint refuses the statement.
6. Same, with `probe_run_id = null`. Assert refusal.
7. Publish a **volatile-only** change to A. Assert `content_hash` and `version` are unchanged and the compiled stable prefix is byte-identical.
8. Configure GS Auto with `booking_requirements = not_applicable`. Assert the compiler emits the positive statement, **zero** entries in `omitted_sections`, and **zero** alerts.
9. Attempt an `UPDATE` on a published snapshot as `service_role`. Assert the trigger raises.

Tests 5, 6 and 9 matter most, because they test the constraint rather than the code — and the audit's whole postscript is about the gap between those two things.

---

### 1.14 Verified vs. assumed

**Verified by reading the file this session** (every `path:line` above): `/home/user/Matrix-Chatbot/` — `config/currentClient.js`, `config/closures.js`, `types/clientConfig.ts`, `lib/systemPromptBuilder.js`, `lib/salonBrain.js`, `lib/salonIntents.js`, `lib/messengerProcess.js`, `lib/messengerClient.js`, `lib/messengerQueue.js`, `lib/conversationStore.js`, `lib/validator.js`, `lib/cors.js`, `api/messenger.js`, `api/messenger-worker.js`, `api/chat.js`, `MESSENGER_SETUP.md`, `CLIENT_ONBOARDING.md` — and `/home/user/dalatech-english/src/lib/aiRouteGuard.ts`, `docs/security-audit-2026-08-23.md`, `docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`.

**Verified by execution this session** (Node 22, against the real ancestor modules): the greeting false positive on «Уучлаарай…»; the location false positive on «Facebook хаяг байна уу»; NFD suppressing the greeting match that NFC produces; `/\bзасалт\b/` and `/\bзасалт\b/u` both false while `/\p{L}+/u` is true; `'Й'` decomposing under NFD while `'Ө'` and `'Ү'` do not; `Intl.Segmenter` segmenting Mongolian correctly; and the compiled Matrix base prompt measuring **7,824 UTF-16 units / 7,818 code points / 12,866 bytes** — three different numbers for one string, and the reason every length budget in this design names its unit.

**Carried from the research packets with their marks intact, re-checkable, and not re-run here:** the Postgres behaviours (restrictive-`for-all` letting `DELETE` through; `TRUNCATE` bypassing RLS; `relacl IS NULL` yielding zero `aclexplode` rows; `pg_get_userbyid(0)`; `unaccent` mapping `Ё→Е`; `C` collation not folding Cyrillic; the `(select …)` and index timings) were verified by execution on a local **PG 16.13**, while Supabase production next door is **PG 17.6**, where the ACL residue is `Dxtm` (with `MAINTAIN`), not `Dxt`. The Meta facts (`entry[].id` semantics per auth flavour, the 24-hour window, the 2026-04-27 tag retirement, the ~1h unsubscription threshold, error `190`) come from a session in which **`developers.facebook.com` was unreachable at the network layer**; the highest-value item to re-verify before code is what `entry[].id` is under each Instagram auth flavour, because tenant routing depends on it and the secondary sources disagreed with production code.

**Assumed, and flagged:**
- **Every GS Auto Center value** in §1.4 — services, axes, price kinds, hours, staff groups, the out-of-scope topic. The vertical is real; the values are invented illustration. The *structure* is the deliverable.
- That the founder wants tenant owners to have a dashboard login at all. §1.12's Class B exists only to serve one.
- That one person may hold more than one tenant. `current_tenant_ids()` returns an array on that assumption — cheap now, expensive later.
- Token counts for a compiled Mongolian prompt. `prompt_tokens` exists in the snapshot precisely so this stops being an estimate.

**Not verified and load-bearing:** that Vercel's function timeout on the target plan exceeds the pipeline's deadlines. `UPSTREAM_TIMEOUT_MS = 25000` (`lib/salonBrain.js:38`) and `INLINE_DEADLINE_MS = 12000` (`api/messenger.js:27`) both exceed the 10 s Hobby default, and `vercel.json` carries no `functions` block. Confirm against the actual plan before sizing anything.

---

### 1.15 Open questions — the founder's call

1. **Does a tenant owner get a login in v1?** All of §1.12's Class B — the membership table, `current_tenant_ids()`, the own-tenant write policies — exists to serve a dashboard. If Matrix and GS Auto get a weekly report instead, RLS-for-humans is dead weight and the entire security budget belongs on the service-role inbound path, where all the volume and all the spend are. **The single highest-leverage decision in this section**, because it decides whether half these tables need policies at all. It also decides whether a volatile section (§1.7.4) — today's special, a mechanic on leave — is self-serve or a founder task, which is the whole point of having volatile sections.

2. **What is a tenant's monthly dollar ceiling, and what happens at the ceiling?** Hard stop (Messenger goes silent mid-conversation on a Saturday), degrade to `budget_exhausted_notice`, or auto-overage-bill. §1.5's gate cannot be finished without the number, and the default `budget_exhausted_policy` is a pricing decision, not an engineering one. My recommendation is `canned` — a customer should not experience a billing dispute as a black hole — but that is commercial.

3. **How do Matrix's existing 40 flat price rows get modelled onto axes at migration?** Zero axes is legal, so Matrix can port verbatim and decompose later. But *what the axes actually are* — is «Эмэгтэй тайралт» a service with a gender axis, or two services? — is a judgment about the salon's own catalogue that needs the owner and a native speaker, not an engineer. Porting flat is safe and cheap; decomposing unlocks generated clarification and normalised deposits. This is the only place where a critique exposed a question I cannot settle: both answers are defensible and the cost falls on someone else's afternoon.

4. **Does Customer Care ship as SMS-only, or does Dalatech commit to Meta's Utility Template approval track?** The tags it would have used died 2026-04-27 (error `100`); `HUMAN_AGENT` survives but forbids AI-authored text and Meta says it detects misuse. The compliant Messenger path is template-approved Utility Messages — approval-gated, category-constrained, possibly per-message priced, and possibly unavailable in Mongolia. §1.5 makes it a row either way, but the answer decides whether `platform_capabilities['customer_care']` is ever flipped, or whether Customer Care means the SIP trunk and nothing else.

5. **Does the tenant own the "never quote this" list, or does the founder?** `disclosure_rules` is valuable and dangerous: a tenant who sets one carelessly gets a bot that refuses to sell. My recommendation is founder-approved-only in v1. Note that §1.3.2 already removes most of the pressure — "no price exists yet" is now a `price_kind` the tenant owns freely — so the founder gate now covers only the genuinely dangerous case.

6. **Is the probe run a hard blocker on activation?** `active_requires_probe_run` is a check constraint, so it cannot be skipped under deadline pressure. That is the point, and it is also the cost: an afternoon and a few dollars of metered spend per tenant, and no "just turn it on for them today". The alternative is making it a warning, which means it will be skipped, which means the forbid-rules that make the bake-off technique work will not exist for that tenant.

7. **Are the platform-default `out_of_scope_topics` a Dalatech product opinion?** Shipping `clinical_advice` and `per_customer_job_status` as inherited defaults means every tenant refuses those by default and must opt *out*. That is the safe direction, and it is also Dalatech deciding what its customers' bots will not talk about.

8. **Do Matrix's pinned Mongolian strings get re-reviewed on migration?** They were native-speaker reviewed for *that* prompt in *that* context (`lib/salonBrain.js:48-51` records why they exist). Moving them into `canned_responses` and changing the surrounding prompt changes the conditions they were validated under. `reviewed_by` forces the question to be answered rather than assumed; someone still has to answer it.

9. **One Meta app, or a small number sharded by tenant cohort?** One app is the design premise and is right on cost and operations — but it means one app secret, one App Review verdict, one shared app-level rate budget, and one blast radius: a policy strike takes down Matrix and GS Auto simultaneously. `channel_bindings.app_id` accommodates both regardless. The schema does not force the decision; the App Review timeline might.

10. **Does Matrix's website chatbot survive?** `api/chat.js` plus the `public/` + `src/` widget is a third channel; `web_widget` is in the enum on the assumption it does. If it survives it needs the same metering — it is currently an open, unauthenticated Anthropic proxy whose only gate is `lib/cors.js`, which allows any request with **no `Origin` header** (`originAllowed = allowAnyOrigin || !origin || …`), i.e. every curl and every script.

11. **Cutover or parallel run?** Matrix is live on the ancestor today, and one Page is subscribed to one app's webhook at a time, so "both at once" is not really available for Messenger. Is this one Page, one moment, one rollback plan — with `delivery_mode='shadow'` first — or does GS Auto onboard onto Dala AI while Matrix stays on the old deployment until Advanced Access clears?