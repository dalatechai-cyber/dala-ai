## 1. Tenant model and configuration

### 1.1 The shape of the answer

Everything that distinguishes one Dala AI customer from another is a **row**. There is one codebase, one deployment, one Meta app (§1.18 Q6), one Supabase project. A tenant is a `tenants` row plus rows in ~20 tenant-scoped tables; a *live* tenant is additionally an immutable **compiled config snapshot** that the runtime reads and the prompt cache is keyed by. Onboarding client #3 is: create a tenant, bind a channel through the admin API, fill in the knowledge tables, publish, activate. No branch, no deploy, no migration.

The ancestor is the counter-example and it is worth stating precisely what it is, because the design is largely a list of its inversions. `config/currentClient.js` is a 121-line JS object literal imported **at module load time** by four modules (`lib/salonBrain.js:11`, `lib/salonIntents.js:17`, `api/chat.js:9`, `src/clientConfig.js:9`), rendered by a template that hardcodes the salon's own policy (`lib/systemPromptBuilder.js:114-188`), and cached in a module-scope singleton (`lib/salonBrain.js:142`). Its own onboarding guide says: *"Open `/config/currentClient.js` and update the following sections"*, then `npm run build:react` and redeploy (`CLIENT_ONBOARDING.md:9, 52-56`). That guide is also already **wrong about the shape** — it documents `productList` / `faqList` / `contactInfo` (`:22, :31, :39`) while the file it points at uses `knowledge.priceList` / `knowledge.faqs` / `knowledge.contact` (`config/currentClient.js:36, 88, 106`). A config format that drifts out of sync with its own documentation in one tenant will not survive three.

Three properties carry the whole section:

1. **Tenant is derived server-side, per webhook entry, from a registry with a unique key.** Never from a request body, never from an env var, never with a default.
2. **The compiler turns rows into a rendered prompt, and the rendered text — not the template — is what is hashed, reviewed, and served.** A config that cannot be rendered is a publish-blocking error, never a silently empty string.
3. **The wrong answer is kept out of the context window rather than forbidden in prose.** This is the bake-off's hardening result (`docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`, "the technique that worked"): a rule that describes the right answer loses to the model's disposition; a rule that forbids the specific wrong answer holds; and a *fact that is not in the prompt at all* cannot be quoted. Both critiques converged on this independently and it is the strongest single idea either of them contributed.

---

### 1.2 `tenants` — identity, lifecycle, suspension

```sql
create table tenants (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique
                          check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  display_name          text not null check (display_name is normalized),
  timezone              text not null,              -- IANA, e.g. 'Asia/Ulaanbaatar'
  primary_locale        text not null default 'mn-MN',
  vertical              text not null references verticals(key),
  plan_id               text not null references plans(id),
  lifecycle             text not null default 'onboarding'
                          check (lifecycle in ('onboarding','active','suspended','churned')),
  suspension_reason     text,                       -- 'nonpayment' | 'policy' | 'founder_hold'
  suspension_reply      text not null default 'silent'
                          check (suspension_reply in ('silent','canned')),
  booking_mode          text not null
                          check (booking_mode in ('link','phone','structured_handoff')),
  booking_url           text,
  message_retention_days int not null default 90 check (message_retention_days between 7 and 730),
  live_config_version   int,
  created_at            timestamptz not null default now(),

  constraint active_requires_published_config
    check (lifecycle <> 'active' or live_config_version is not null),
  constraint booking_link_requires_url
    check (booking_mode <> 'link' or booking_url is not null),
  constraint live_version_is_a_real_snapshot
    foreign key (id, live_config_version)
      references tenant_config_snapshots (tenant_id, version)
);
```

`slug` is ASCII-constrained **on purpose**: it is a machine key that appears in Redis keys, log lines and ledger rows, and the Mongolian rules of §1.12 govern *user text*, not identifiers. `display_name` is Cyrillic and carries an `is normalized` constraint — Postgres has `IS NORMALIZED` and checking is cheaper than converting.

`live_version_is_a_real_snapshot` is a composite FK, not a plain one: it makes it structurally impossible for tenant A's live pointer to name tenant B's snapshot. That is the one class of scoping bug the database still catches when the writer is `service_role` (§1.15).

**Lifecycle semantics at the inbound path** — each state is a *behaviour*, not a label:

| State | Persist inbound | Spend | Send | Alert |
|---|---|---|---|---|
| `onboarding` | yes | no | no | **yes, urgent** — a real customer reached a Page bound to a non-live tenant; that is an onboarding bug |
| `active` | yes | yes | yes | — |
| `suspended` | yes | no | only `suspended_notice`, per below | on first inbound after suspension |
| `churned` | **no — drop the body** | no | no | **page the founder**: Dalatech is receiving a former customer's private messages on a channel that should have been released |

**Suspension reply is deliberately three-way gated.** Sending `suspension_reply='canned'` requires *all* of: the reviewed `suspended_notice` row exists in the right locale **and** channel; the binding's `token_status='active'`. Any one missing ⇒ **silence**, plus an alert. A suspended tenant is by definition one whose config you have stopped trusting, and improvising a Mongolian sentence at that moment is the failure the ancestor spent three pinned strings avoiding (`lib/salonBrain.js:48-51` records the actual incident: garbled Mongolian and an invented Russian word, `дополнительн`, in filler positions).

**Failure modes.** Config row missing ⇒ `tenant_not_provisioned`, a distinct code, never a 500 and never a silent skip (onboarding is incomplete and that is an operator-visible state). `timezone` invalid ⇒ refused at write time against `pg_timezone_names`, not discovered at 23:00 UTC when a closure flips a day early. `lifecycle='active'` with a null `live_config_version` ⇒ impossible; the constraint refuses the statement, which is the point of testing the constraint rather than the code that is supposed to honour it.

---

### 1.3 Channel identity — the registry that routes an event to a tenant

```sql
create table channel_providers (            -- a LOOKUP TABLE, not a Postgres enum
  key            text primary key,          -- 'facebook_page' | 'instagram' | 'web_widget' | 'sms'
  enabled        bool not null default true,
  send_host      text not null,             -- graph.facebook.com | graph.instagram.com
  send_path_tmpl text not null,             -- '/{version}/{external_id}/messages'
  webhook_object text                       -- 'page' | 'instagram' | null
);

create table channel_bindings (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  provider           text not null references channel_providers(key),
  external_id        text not null,          -- Page ID, or IG professional account ID
  auth_flavour       text not null check (auth_flavour in ('facebook_login','instagram_login','none')),
  app_id             text,                   -- which Meta app; null for web_widget
  verified_name      text,                   -- fetched live from Graph at onboarding
  name_confirmed_by  uuid,
  name_confirmed_at  timestamptz,
  enabled            bool not null default false,
  token_status       text not null default 'unprovisioned'
                       check (token_status in ('unprovisioned','active','revoked','error')),
  subscribed_fields  text[] not null default '{}',
  granted_scopes     text[] not null default '{}',
  graph_version_override text,
  last_webhook_at    timestamptz,
  created_at         timestamptz not null default now(),

  unique (provider, external_id),                        -- ONE identity → exactly ONE tenant
  unique (tenant_id, id),                                -- enables composite FKs from children
  constraint enabled_requires_name_confirmation
    check (not enabled or name_confirmed_at is not null)
);
```

`unique (provider, external_id)` is global and unconditional, not partial on `enabled`. A disabled binding still *reserves* the identity, so releasing a Page to another tenant is an explicit delete, not an accident. `provider` is in the key because a Page ID and an IG professional-account ID live in different namespaces and must not collide.

**`channel_providers` is a table, not an enum** — critique A's minor point, accepted. `alter type … add value` cannot run in a transaction with the DDL around it and cannot be rolled back; a lookup table also gives every provider an `enabled` flag, so pausing Instagram platform-wide is a row rather than a deploy.

**On the "wrong tenant, right page id" soft misbinding.** Critique A is right that the drafted defence — alert when `verified_name` shares no token with `display_name` — is *worse than free*: Matrix's `display_name` is Latin (`config/currentClient.js:7`), a Mongolian SMB's Page name is routinely Cyrillic or carries a branch suffix, token overlap is zero, every correct tenant trips the alarm on its first customer, and the alarm gets muted before the one real misbinding arrives. Worse, "shares a token" needs a tokeniser over Mongolian text and the obvious one uses `\b`/`\w`, which §1.12 forbids and which does not match Cyrillic in JavaScript at all. It is replaced by onboarding-time confirmation: the admin route calls `GET /{page-id}?fields=name` with that tenant's own token, shows the founder the real Page name, and stores `verified_name` + `name_confirmed_by/at`.

**One correction to that critique, because its mechanism does not work:** it proposes extending `active_requires_published_config` so `lifecycle='active'` also requires `name_confirmed_at is not null` — but `name_confirmed_at` lives on `channel_bindings` and a `check` constraint cannot span tables; the constraint therefore goes on `channel_bindings` as `enabled_requires_name_confirmation`, which is strictly stronger because it is per-binding rather than per-tenant.

**Routing rule — per entry, never per request.**

```
for each entry in body.entry:                     # ONE POST can carry two tenants
    key      = entry.id                           # Page ID | IG professional account ID
    binding  = resolve_channel(body.object, key)  # server-side, exact match, enabled only
    if binding is null:  200 + drop + counter + alert      # NEVER auto-create a tenant
    for m in entry.messaging or []:               # write it as a loop regardless
        expected = m.message?.is_echo ? m.sender.id : m.recipient.id
        if expected != key: counter('entry_id_mismatch'); prefer `expected`
```

The cross-check exists because Chatwoot — production, multi-tenant, thousands of installs — does **not** route Instagram by `entry.id` alone; it resolves from `messaging.recipient.id` (or `sender.id` for echoes). Treat the "same value everywhere" invariant as something to measure, not to trust. This is also the single highest-value item on the Meta re-verification list (§1.17).

**Failure modes.** Unknown identity ⇒ 200 + drop + persist tenant-less (§1.14 #1). Registry unreadable ⇒ **500**, not 200 (§1.13). Two tenants claiming one identity ⇒ impossible; the *attempt* raises `23505` on the onboarding write and the admin route must translate it into "Page 1234 is already bound to tenant `matrix-eco`", never a 500. `enabled` binding with no `last_webhook_at` movement ⇒ watchdog (§1.14 #11).

---

### 1.4 Per-tenant credentials

Non-negotiable #7 says secrets come from the environment. A Meta Page token is **per-tenant data** and cannot; that is its own key-management problem and it is solved explicitly with envelope encryption.

```sql
create table channel_secrets (
  tenant_id     uuid not null,
  binding_id    uuid not null,
  kind          text not null,           -- 'page_token' | 'ig_token' | 'sip_password'
  ciphertext    bytea not null,          -- AES-256-GCM(secret, DEK), iv||tag||ct
  wrapped_dek   bytea not null,          -- AES-256-GCM(DEK, KEK), KEK from Vercel env
  kek_version   int  not null,
  status        text not null default 'active' check (status in ('active','rotating','revoked')),
  last_ok_at    timestamptz,
  last_error_code int,                   -- Meta's numeric code. NEVER the token, never a message body.
  primary key (tenant_id, binding_id, kind),
  foreign key (tenant_id, binding_id) references channel_bindings (tenant_id, id)
);
```

Four decisions, each load-bearing:

- **Envelope, not Supabase Vault.** Both are equivalent against a stolen database backup. They are *not* equivalent against a leaked `sb_secret_…` key — Vault's `decrypted_secrets` view decrypts on read for the same credential that already has full data access, whereas the KEK lives in Vercel's environment and a Supabase key does not grant Vercel env access. For a public repo with a solo operator, a leaked service key is the likelier incident. (Vault also sits at `public alpha` and is mid-reimplementation away from the deprecated `pgsodium`; that is a secondary reason, not the argument.)
- **AAD binds ciphertext to its row.** Pass `tenant_id || binding_id || kind` as GCM additional authenticated data, so copying row A's ciphertext onto row B fails authentication instead of decrypting as the wrong salon's token.
- **Decrypt per request, hold for the request only.** No module-scope cache. Vercel reuses warm lambdas across tenants and a module-level `let token` is a cross-tenant credential leak with a 15-minute half-life — the same defect class as `lib/salonBrain.js:142`.
- **Never log the plaintext, the ciphertext, or the wrapped DEK.** Log `tenant_id`, `kind`, `kek_version`, and Meta's numeric error code. The ancestor gets the header-not-query-string half right already (`lib/messengerClient.js:79`) and must keep it.

**KEK rotation** touches no plaintext: add `META_TOKEN_KEK_V2` alongside V1, unwrap-by-`kek_version`, a resumable admin job re-wraps each DEK, then confirm `select count(*) from channel_secrets where kek_version <> 2` is `0` **by querying the database**, not by the job reporting success — the sibling's whole postscript is about that distinction.

**Failure modes.** KEK env var missing at boot ⇒ refuse to start / 503 the route; never a default, never a plaintext column. Unwrap fails ⇒ 503 *for that tenant*, alert, and never fall through to another tenant's secret or to an env var. GCM tag mismatch ⇒ treat as tampering, alert. Graph `190` ⇒ `status='revoked'`, `token_status='revoked'`, stop **all** outbound on that binding, keep persisting inbound, alert, and **never retry** — retrying a 190 in a queue is how one tenant earns a rate-limit ban on the shared Meta app. Per-*binding*, not per-tenant: Messenger can die while Instagram lives.

---

### 1.5 Capabilities, plans, and the entitlement gate

Three levels, checked in this order, each failing closed:

```sql
create table platform_capabilities (            -- global kill switch, founder-only
  key      text primary key,                    -- 'reception_messenger','reception_instagram',
  enabled  bool not null default false,         -- 'reception_comments','customer_care_sms',
  reason   text                                 -- 'analytics_monthly','quality_review','voice'
);

create table plans (
  id                   text primary key,
  model_tier           text not null references model_tiers(key),
  monthly_usd_ceiling  numeric(10,2) not null,
  budget_exhausted_policy text not null
                         check (budget_exhausted_policy in ('silent','canned','overage')),
  cache_ttl            text not null default '1h'
);

create table tenant_capabilities (
  tenant_id  uuid not null references tenants(id),
  capability text not null references platform_capabilities(key),
  enabled    bool not null,                     -- NO DEFAULT: onboarding must state it
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  primary key (tenant_id, capability)
);
```

`quality_review` is in this table as an **opt-in** capability, per critique B. A dental clinic will not sign a contract letting the platform read every DM to propose KB updates, and no salon should be opted in by accident. One refinement the critique did not make: an opt-out must still permit **metadata-only** quality review — counts of unanswered questions, refusal rates, handoff rates, with no message bodies — otherwise the tenant most likely to need a KB fix is the one whose KB never improves. So `quality_review` takes three values, not two: `off | metadata | full`.

`voice` exists in `platform_capabilities` with `enabled=false` and no code behind it. That is the Phase-4 seam: a row, not a stub.

`customer_care_sms` is the gated one. The Meta outbound path it would otherwise have used is closed — `CONFIRMED_EVENT_UPDATE` / `ACCOUNT_UPDATE` / `POST_PURCHASE_UPDATE` were retired 2026-04-27 and now return error `100`; `HUMAN_AGENT` survives but forbids AI-authored text and Meta says it detects misuse. So outbound eligibility is data, not tags:

```sql
create table outbound_policies (
  channel                 text primary key,
  window_hours            int,           -- 24 messenger/instagram, null sms
  free_form_outside_window bool not null, -- false everywhere on Meta today
  template_required       bool not null,
  ai_authored_allowed     bool not null,
  per_message_cost_usd    numeric(10,6)  -- NULL means "unknown price"
);
```

A send is refused unless the policy permits it **and** the tenant's ledger can afford `per_message_cost_usd`. `NULL` **refuses** — it does not default to zero. Same reasoning that made `BANK_BUILD_BUDGET_USD` zero next door: a value that refuses without depending on an unreliable read.

**Model tiers** are a plan attribute, not a per-deployment constant:

```sql
create table model_tiers (
  key                  text primary key,   -- 'reception','quality','analytics'
  model_id             text not null
                         check (model_id in ('claude-opus-5','claude-sonnet-5','claude-haiku-4-5')
                                and model_id !~ '-20[0-9]{6}$'),   -- no date suffix, ever
  max_output_tokens    int not null,
  min_cacheable_tokens int not null,        -- 4096 on Haiku: a short prompt silently fails to cache
  effort               text                 -- output_config.effort / thinking:{type:'adaptive'};
);                                          -- budget_tokens is REJECTED with 400 on Opus 5 / Sonnet 5
```

The date-suffix check exists because the ancestor already has one: `api/chat.js:13` pins `'claude-haiku-4-5-20251001'` while `lib/salonBrain.js:19` pins `'claude-sonnet-5'` — two channels, two models, one of them stale.

**Budget.** The ledger's mechanics belong to the metering section; what belongs here is the tenant-side shape and the ordering. Every upstream call is attributed to a `tenant_id` and charged against `tenant_budgets(tenant_id, month, ceiling_usd, reserved_usd, spent_usd)` **before** it is made — a reservation at request start, reconciled against actual `usage` on response. The helper returns **503 on any error**. Never `try { check() } catch { continue }`; that exact pattern was the HIGH finding in the sibling's 2026-08-13 audit. A 503 costs a retry; failing open costs money — and here it costs *another tenant's* money, which is worse because it is not yours to lose.

One per-tenant cost line that only appears at N tenants: **prompt-cache economics are per tenant.** Each tenant's compiled prompt is a distinct cache entry, and a cache write bills 1.25×. The ancestor chose `CACHE_TTL='1h'` from measured inter-message gaps for *one busy Page* (`lib/salonBrain.js:23-33`) — the reasoning is right and the constant is not portable. `plans.cache_ttl` is the default; a low-traffic tenant whose observed gap exceeds the TTL should have caching *off*, and that is a computed setting with an alert, not a guess.

**Failure modes.** `platform_capabilities` unreadable ⇒ 503 (checked before tenant resolution, so a platform-wide outage does not become a per-tenant mystery). `tenant_capabilities` row absent ⇒ **not entitled** — there is no default, which is why the column has none. Budget check errors ⇒ 503. Budget exhausted ⇒ `budget_exhausted_policy`; `canned` requires the reviewed response to exist or the validator blocks publish.

---

### 1.6 The knowledge base as data

The ancestor's knowledge is 121 lines of object literal rendered by a 189-line template that hardcodes the salon's policy. Below is the same information as typed rows. Columns marked **†** exist because a second or third vertical needs them and Matrix does not; every one of them is null/empty/false for Matrix, so Matrix's behaviour is unchanged.

#### 1.6.1 Services and prices

```sql
create table services (
  tenant_id     uuid not null references tenants(id),
  id            uuid not null default gen_random_uuid(),
  category_id   uuid,
  name          text not null check (name is normalized),
  aliases       text[] not null default '{}',    -- «гель маникюр» → «Гелэн будалт»
  duration_value int,          duration_unit text                      -- †
                   check (duration_unit in ('minutes','hours','days')),
  turnaround_text text,                                                -- † verbatim, never composed
  ordinal       int not null default 0,
  active        bool not null default true,
  primary key (tenant_id, id),
  unique (tenant_id, name)
);

create table price_qualifiers (            -- † what a price depends on, beyond the service
  tenant_id  uuid not null references tenants(id),
  id         uuid not null default gen_random_uuid(),
  key        text not null,                -- 'make','model','year','insurance_status'
  label      text not null,                -- Mongolian, shown to the customer
  verbatim_question text not null,         -- reviewed Mongolian; the model asks THIS
  required   bool not null default true,
  ordinal    int not null default 0,
  primary key (tenant_id, id)
);
create table service_price_qualifiers (
  tenant_id uuid not null, service_id uuid not null, qualifier_id uuid not null,
  primary key (tenant_id, service_id, qualifier_id),
  foreign key (tenant_id, service_id)   references services (tenant_id, id),
  foreign key (tenant_id, qualifier_id) references price_qualifiers (tenant_id, id)
);

create table service_prices (
  tenant_id     uuid not null,
  id            uuid not null default gen_random_uuid(),
  service_id    uuid not null,
  variant_key   text,                       -- 'master' | 'grade_1' | null
  price_kind    text not null check (price_kind in ('fixed','range','from','on_request')),
  amount_min    numeric(12,2), amount_max numeric(12,2),
  currency      text not null default 'MNT',
  unit          text,                       -- 'per_nail', 'per_hour', null
  quotable      bool not null,              -- ← NO DEFAULT. onboarding must state it per row.
  refusal_key   text,                       -- canned_responses key when quotable = false
  valid_until   timestamptz,                -- †
  source_updated_at timestamptz not null default now(),   -- †
  primary key (tenant_id, id),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  constraint range_needs_two_ends
    check (price_kind <> 'range' or (amount_min is not null and amount_max is not null)),
  constraint unquotable_needs_a_reviewed_refusal
    check (quotable or refusal_key is not null)
);
```

Four things this fixes, in order of how much money they save:

**Prices are values, not display strings.** The ancestor stores `55000` and `"66,000 – 88,000"` in the same array (`config/currentClient.js:38-39`), branched on twice (`lib/systemPromptBuilder.js:18-23` and again at `:106-110`). An en-dashed display string cannot be compared, summed, validated, or attributed to revenue by Analytics AI.

**`quotable` has no default and the compiler never renders an amount for a false row.** This is critique B's strongest point and it is a structural application of the bake-off result. At Matrix, quotability is an exception carved out of a "quote everything" default (one topic in forty). At GS Auto the ratio inverts: diagnostics and oil change are quotable, brakes and bodywork are "хараад хэлнэ". Encoding thirty exceptions as thirty prose rules means the founder writes one generic rule instead — and one generic rule loses, on every ambiguous turn, to a `ҮНИЙН ЖАГСААЛТ` section that lists thirty services with numbers beside them and a rule at `lib/systemPromptBuilder.js:129` that literally instructs the model to answer from it. A non-quotable row renders as its name plus its bound verbatim refusal, **with no figure anywhere in the context window**.

**`valid_until` makes staleness representable.** When it has passed, the compiler drops the row to the non-quotable path and raises the same alert as an omitted section. That is `formatPriceList`'s existing instinct — *"refuse to render prices rather than risk serving a category the official list doesn't carry"* (`lib/systemPromptBuilder.js:36-38`) — applied to time instead of shape. Null for Matrix; essential for parts prices that move with the MNT/USD rate.

**Qualifiers are a table, not an array.** Critique B proposed `services.price_depends_on text[]`. I take the shape and not the container: a bare array has nowhere to put the reviewed Mongolian label or the reviewed question, and an English qualifier key (`make`, `year`) rendered into a Mongolian prompt is exactly the leak §1.12 forbids. With rows, the compiler emits *"before quoting, you must ask: «Таны машин ямар маркийн вэ?»"* using text a human wrote.

The qualifier table also repairs a rule that would otherwise be a lobotomy at the second vertical. `lib/salonBrain.js:98` says *"Тодруулга асуухдаа зөвхөн жагсаалтад яг байгаа ялгааг ашигла"* — clarify **only** using distinctions literally present in the price list. Ported as a constant, that forbids Reception AI from asking what car you drive, because make and model are not rows in `service_prices`. So the compiler *derives* it: with zero qualifiers it emits Matrix's exact current sentence; with qualifiers it emits "ask for these, and do not quote until you have them."

#### 1.6.2 Staff

```sql
create table staff_groups (
  tenant_id uuid not null, id uuid not null default gen_random_uuid(),
  label     text not null check (label is normalized),   -- «Эмэгтэй үсчид» | «Мотор»
  ordinal   int not null default 0,
  customer_selectable bool not null,     -- † may a customer ask for a named person?
  affects_price       bool not null,     -- † does the person's tier change the price?
  primary key (tenant_id, id)
);
create table staff (
  tenant_id uuid not null, id uuid not null default gen_random_uuid(),
  group_id  uuid not null, name text not null check (name is normalized),
  role_label text not null,
  price_variant_key text,               -- links a person to service_prices.variant_key
  active bool not null default true,
  primary key (tenant_id, id),
  foreign key (tenant_id, group_id) references staff_groups (tenant_id, id)
);
```

`lib/systemPromptBuilder.js:69-84` is three `filter` calls on `gender === 'female' | 'male' | 'manicure'` with fixed Mongolian headings and **no `else`** — a staff member with any other value silently vanishes from the prompt, and `types/clientConfig.ts:20` encodes a service line as a gender. GS Auto's mechanics cannot be expressed at all. Groups are tenant-declared; a member whose group is missing is now a **publish-blocking error**, not a silent disappearance.

The two booleans are critique B's: when every group has both false, the compiler **omits the staff section entirely** and omits the tier-lookup rule with it, because at GS Auto a rendered roster invites "can Батболд do it?" — which the shop cannot honour — and costs cache-write tokens on every publish. Matrix sets both true and is byte-identical to today.

#### 1.6.3 Canned responses, and what `reviewed_by` has to mean

```sql
create table canned_response_keys (key text primary key, required bool not null);
-- 'closing_line','handoff_to_human','model_unavailable','booking_direction',
-- 'suspended_notice','budget_exhausted_notice','out_of_scope', …

create table canned_responses (
  tenant_id  uuid not null references tenants(id),
  key        text not null references canned_response_keys(key),
  locale     text not null default 'mn-MN',
  channel    text not null default '*',
  template   text not null check (template is normalized),  -- may contain placeholders
  rendered   text,                                          -- filled by the compiler
  reviewed_by uuid, reviewed_at timestamptz,
  primary key (tenant_id, key, locale, channel)
);
```

`CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY` and `BOOKING_LINE` (`lib/salonBrain.js:52-81`) exist *because a human checked the Mongolian*. `reviewed_by` is therefore not decoration — and it only means something if it attests to the **rendered** bytes a customer actually sees. `BOOKING_LINE` hardcodes `QPay-ээр` and «урьдчилгаа төлбөр»; both become tenant data.

#### 1.6.4 The closed placeholder grammar — the fix for the plausible-empty prompt

Critique A found the sharpest live bug in the ancestor and it generalises. `priceOf` (`lib/systemPromptBuilder.js:106-110`) looks a price up by an **exact literal Mongolian service name** and returns `''` on a miss; `womenMasterPrice` at `:111` feeds three example dialogues at `:153, :159`. Rename "Эмэгтэй тайралт (Мастер)" in the config — a pure data edit, the kind this design promises is safe — and the shipped prompt reads **`Мастер үсчин ₮`**: a few-shot example teaching the model to quote an empty price. The identical hazard sits at `lib/salonBrain.js:80`, `clientData.knowledge?.contact?.website || ''`, producing «Та манай вэбсайтаар () онлайнаар…». Both fail silently into a customer-facing sentence with a hole. The comment at `:103-105` explains *why* the indirection is there — a literal figure would be a second copy of a fact that can drift — and the instinct is right; only the empty-string fallback is wrong.

So placeholders are a **closed grammar**, resolved by the compiler against the snapshot:

```
{{phone}}  {{booking_url}}  {{price:<service name>:<variant|*>}}  {{staff:<name>:role}}
{{hours:<weekday>}}  {{closure.message}}
```

Three rules, and they are the whole point:
1. An unresolvable placeholder is a **publish-blocking validator error naming the exact path** — never an empty string, never a best-effort render.
2. The **rendered** text is stored in the snapshot and covered by `content_hash`. Templates are inputs; rendered bytes are the artifact.
3. `reviewed_by` attaches to the rendered bytes. Change a price that a reviewed line interpolates, and the review flag clears and re-review is required before publish. Otherwise `reviewed_by` attests to a string no customer ever sees.

#### 1.6.5 Disclosure rules — and they are not only about price

```sql
create table disclosure_rules (
  tenant_id  uuid not null references tenants(id),
  id         uuid not null default gen_random_uuid(),
  kind       text not null check (kind in ('price','clinical_advice','legal','safety','availability')),
  subject_kind text not null check (subject_kind in ('topic','service','category')),
  subject_ref  text not null,                 -- topic key, or a services.id
  match_terms  text[] not null default '{}',  -- NFC + folded at write time (§1.12)
  response_key text not null references canned_response_keys(key),
  quote_price  bool not null default false,
  primary key (tenant_id, id)
);
```

The children's-haircut omission is one row here plus one `canned_responses` row. Today it lives in **three** places and none of them is data: a comment (`config/currentClient.js:34-35`), `CHILDREN_REPLY` (`lib/salonBrain.js:70-72`), and a second copy inside the shared template (`lib/systemPromptBuilder.js:135`), reinforced by a third instruction at `lib/salonBrain.js:98`.

`kind` exists because critique B is right that a clinic's dangerous question involves no price at all. *"Шүд минь шөнөжин өвдлөө, ямар эм уувал дээр вэ?"* matches no price rule; the model, told to answer from the KB and be helpful, offers a painkiller and a dose. That is a harm-and-liability failure that lands on Dalatech as the platform, and the same shape appears at a restaurant (allergens) and a gym (injury advice). One enum column generalises the mechanism that already exists.

#### 1.6.6 Answer rules — the conditional behaviour that is neither a fact nor a canned string

Critique A is right that roughly half the ancestor's prompt value has no home in the schema as drafted, and would therefore have landed in a free-text override table. `lib/salonBrain.js:95-98` carries: *a working-hours question is not a booking request*; *no stylist has a personal price, price follows tier only*; *use the handoff reply in exactly these two cases and no others*; *never ask "adult or child"*. GS Auto needs its own set. So:

```sql
create table answer_rules (
  tenant_id  uuid not null references tenants(id),
  id         uuid not null default gen_random_uuid(),
  kind       text not null check (kind in (
               'not_the_same_intent',      -- (A) is not (B)
               'price_depends_only_on',    -- price follows X and nothing else
               'use_canned_only_when',     -- the canned reply's exact admissible cases
               'never_ask',                -- a clarifying question that must never be asked
               'answer_from_kb_first')),
  subject_ref text, object_ref text,
  rule_text   text not null check (rule_text is normalized),   -- reviewed Mongolian
  channel     text not null default '*', locale text not null default 'mn-MN',
  reviewed_by uuid, reviewed_at timestamptz,
  primary key (tenant_id, id)
);
```

The enum is closed on purpose: a new *rule* is a row; a new *kind* is a platform change that adds a compiler section. That boundary is what stops this table becoming free-text prose.

#### 1.6.7 Example dialogues

```sql
create table example_dialogues (
  tenant_id uuid not null references tenants(id),
  id        uuid not null default gen_random_uuid(),
  channel   text not null default '*', locale text not null default 'mn-MN',
  ordinal   int not null default 0,
  turns     jsonb not null,        -- [{role:'user',text},{role:'assistant',text}] with placeholders
  rendered  jsonb,                 -- compiler output; hashed; what reviewed_by attests to
  reviewed_by uuid, reviewed_at timestamptz,
  primary key (tenant_id, id)
);
```

Five worked dialogues at `lib/systemPromptBuilder.js:151-165` name Оюунсүрэн and Г. Мөнхзаяа, quote live prices, and end every booking in a website button CTA — which does not exist on Messenger, and which `lib/salonBrain.js:93` then spends prompt tokens contradicting. They are per-tenant, per-vertical, per-channel content, and they are the part of the prompt that most determines behaviour. With no table they end up in the compiler (a code change per tenant) or in an unbounded override. `channel` on the row is what removes the two-channels-cancelling-each-other pattern: `MESSENGER_ADDENDUM` is 3,163 characters of which roughly half exists to *undo* website rules in the base template, and that does not scale to four AI roles.

#### 1.6.8 Booking

```sql
create table booking_handoff_fields (   -- † only for booking_mode='structured_handoff'
  tenant_id uuid not null, id uuid not null default gen_random_uuid(),
  key text not null, verbatim_question text not null,
  required bool not null default true, ordinal int not null default 0,
  primary key (tenant_id, id)
);
create table booking_requirements (     -- deposits; GS Auto has ZERO rows
  tenant_id uuid not null, id uuid not null default gen_random_uuid(),
  applies_to text not null check (applies_to in ('service','category','staff_group')),
  ref uuid not null, amount numeric(12,2) not null, currency text not null default 'MNT',
  note_key text references canned_response_keys(key),
  primary key (tenant_id, id)
);
```

`tenants.booking_mode` is critique B's, accepted. Making the booking *sentence* per-tenant fixes the QPay leak but leaves the *shape* fixed at "emit a sentence", and a tenant with no booking site gets "call us" — a dead end at 22:40, which is the one thing Reception AI is sold to prevent, and which Analytics AI then reports as "bookings driven: 0" with no way to tell failure from vertical. `structured_handoff` collects the fields and writes a row a human reads. It also gives §1.6.1's qualifiers somewhere to land: the vehicle you must ask about to *refuse* a quote is the same vehicle you must ask about to *book*.

The deposit table currently sits as prose in a shared template (`lib/systemPromptBuilder.js:138-149`) — 20,000₮ master, 10,000₮ 1st-degree, manicure/pedicure splits. Pure business policy in platform code.

#### 1.6.9 Time — and one explicit non-goal

`business_hours(tenant_id, weekday, opens, closes, closed)`; `tenant_closures(tenant_id, id, starts_on, ends_on, title, verbatim_message, reviewed_by)`.

Three properties of `config/closures.js` are carried exactly: the customer-facing sentence is **never composed by the model** (`:22-26` — Mongolian date suffixes are not safely generated); the closure is evaluated **per request**, not cached with the base prompt, because a warm lambda can outlive the end of a break (`lib/salonBrain.js:139-155`); and a malformed closure is ignored with an alert rather than announcing a wrong break (`:113-121`). Three things change: there is **no default closure shipped in code** (`config/closures.js:40-52` ships Matrix's Naadam 2026-07-11..17, which would apply to any tenant that failed to override it), closures are rows rather than `SALON_CLOSURE_*` env vars (`:140-151`), and the timezone comes from `tenants.timezone` rather than `SALON_UTC_OFFSET_MINUTES = 8 * 60` (`:32`).

`services.duration_value` / `turnaround_text` exist because the ancestor has **no** duration or turnaround concept anywhere — its implicit model is that a service is an appointment that fits inside a day. Ask a body shop *"Өнөөдөр өгвөл маргааш авч болох уу?"* and nothing in the prompt contradicts a cheerful yes. When both are null and a customer asks about timing, the compiler emits the handoff refusal rather than leaving a gap for the model to fill.

**Explicit non-goal: capacity.** "We're booked until Thursday" is live state, not config. It is not in this schema, and `tenant_closures` **must not** be used for it — stated here because the second person to read this schema will otherwise try.

---

### 1.7 The same schema at GS Auto Center, and at a dental clinic

Every value below is **assumed** — invented illustration. The vertical is real; the structure is the deliverable.

| Concept | Matrix Eco Salon | GS Auto Center | Dental clinic |
|---|---|---|---|
| `vertical` | `salon` | `auto_service` | `dental` |
| `staff_groups` | Эмэгтэй үсчид / Эрэгтэй үсчид / Маникюр баг; `customer_selectable=true`, `affects_price=true` | Мотор / Явах анги / Цахилгаан; **both false** ⇒ staff section omitted | Эмч нар; selectable true, affects_price false |
| `price_qualifiers` | none | `make`, `model`, `year` — with reviewed Mongolian questions | `insurance_status` |
| `service_prices.quotable` | true on all 40 rows; children's has **no row at all** | true on diagnostics + oil change; **false** on brakes, bodywork, suspension, each bound to a refusal | true on cleaning; false on anything after examination |
| `valid_until` | null | set on parts-bearing rows | null |
| `duration` / `turnaround_text` | null (fits a day) | `turnaround_text` on body work: «Бүрэн засварт 3-5 хоног…» | `duration_value=45 minutes` |
| `booking_mode` | `link` + `matrixecosalon.org` | `structured_handoff` — make/model/year/symptom/preferred day | `link` |
| `booking_requirements` | 6 rows (deposits) | **zero rows** | 1 row |
| `disclosure_rules` | 1 × `kind='price'` (children's) | ~4 × `kind='price'` topic-level + 1 × `safety` (warranty claims) | 1 × `price`, **2 × `clinical_advice`** |
| `answer_rules` | «цагийн хуваарь ≠ цаг авах»; «price follows tier only»; «never ask adult/child» | «оношилгооны үнэ ≠ засварын үнэ»; «never quote labour hours for an unlisted model» | «шинж тэмдэг ≠ онош» |
| `quality_review` | `full` | `full` | **`metadata`** |
| `message_retention_days` | 90 | 90 | 30 |

Not one row of code differs. What differs is: which columns are null, which booleans are false, and how many rows are in each table.

**Vertical templates** — critique B's, accepted, and it is the only structural answer to "onboarding is filling in a config":

```sql
create table vertical_templates (vertical text, target_table text, payload jsonb, ordinal int);
```

At tenant creation the founder picks a vertical and the template's `disclosure_rules` + `canned_responses` rows are **copied into the tenant's draft**, editable. A blank config is not neutral — in a regulated vertical it is unsafe by default, and a clinic that starts empty starts with a bot willing to give a dose. A template is still data, and the copy is per-tenant rows, not a shared reference.

---

### 1.8 Versioned snapshots and the compiler

```sql
create table tenant_config_snapshots (
  tenant_id       uuid not null references tenants(id),
  version         int  not null,
  schema_version  int  not null,          -- the compiler contract, not the DB migration
  content_hash    text not null,          -- sha256 over the canonical rendered blocks
  prompt_blocks   jsonb not null,         -- RENDERED text, keyed (channel, locale)
  prompt_chars    int not null,
  prompt_tokens   int,                    -- from the API's usage, not an estimate
  omitted_sections jsonb not null default '[]',
  source_digest   jsonb not null,         -- per source table: row count + max(updated_at)
  compiled_at     timestamptz not null default now(),
  compiled_by     uuid not null,
  primary key (tenant_id, version)
);
```

A snapshot is **immutable**. There is no update path: publishing inserts version N+1 and flips `tenants.live_config_version`. Rollback is one write of an integer. The runtime never reads the knowledge tables — it reads the snapshot named by the live pointer, so a half-finished edit cannot reach a customer.

**`content_hash` is the prompt-cache key**, replacing `lib/salonBrain.js:142`'s module-scope singleton — the highest-severity multi-tenancy defect in the ancestor and invisible at one tenant, because two tenants on one warm lambda means tenant B answered with tenant A's prices, staff and phone number. It also means the Anthropic cache entry is per snapshot, so a publish is a deliberate cache-write cost the founder can see.

**Compiler rules that are derived from data, not written per tenant:**

| Data condition | Compiled output |
|---|---|
| `price_qualifiers` empty | Matrix's exact "clarify only using distinctions in the list" sentence |
| `price_qualifiers` non-empty | "you must ask ⟨verbatim_question⟩ before quoting; do not quote until answered" — and the above is suppressed |
| `quotable = false`, or `valid_until` passed | service name + bound refusal; **no amount anywhere in the prompt** |
| all `staff_groups` non-selectable and non-pricing | staff section and tier-lookup rule both omitted |
| `booking_mode='structured_handoff'` | "collect these fields, then hand off with them attached" |
| `duration` and `turnaround_text` both null, timing asked | the handoff refusal, rather than silence for the model to fill |
| a closure is active | the closure block, evaluated **per request**, never cached with the base |
| an optional section cannot render | omitted, recorded in `omitted_sections`, **alert** — never rendered with a guess |

**Prompt size is now a real constraint, not a footnote.** Matrix's base prompt is 7,824 characters / 12,866 UTF-8 bytes for **40 services and 9 staff**; the full cached Messenger block is 10,987 characters / 18,450 bytes. Mongolian Cyrillic is 2 bytes per character and is thinly represented in BPE vocabularies. GS Auto's parts-and-labour catalogue cannot be inlined whole. `prompt_tokens` is a column precisely so this stops being an estimate — the ancestor already logs the true number on every call (`lib/salonBrain.js:249-253`) and one line from a Vercel log gives it. When a tenant's compiled prompt exceeds the plan's budget, the compiler must fall back to **retrieval over the tenant's knowledge store**, and the retrieval boundary needs the same hardening the pinned lines got. That is a design consequence to size for now, not a v1 deliverable.

**Failure modes.** `schema_version` newer than the reader ⇒ **503**, never a best-effort read of an unknown shape; the compiler supports N and N−1 for one deploy cycle. Snapshot read fails ⇒ 503, never fall back to reading the live tables. And the snapshot read must go through the shared Supabase client with `cache: 'no-store'` — a route handler exporting only `GET` caches every Supabase read for a **year**, `export const dynamic = 'force-dynamic'` does *not* stop it, and here the specific hazard is a config or channel-binding read returning a stale **other tenant's** value. Port `src/lib/supabase/fetch.ts` and `scripts/check-supabase-nostore.mjs` on day one.

---

### 1.9 The publish validator

Publish is refused, with the exact path named, when any of these hold:

1. A required `canned_response_keys` row is missing for the tenant's locale × any enabled channel.
2. `budget_exhausted_policy='canned'` and `budget_exhausted_notice` is absent; same for `suspension_reply='canned'` and `suspended_notice`.
3. Any placeholder is unresolvable (§1.6.4) — including one inside an `example_dialogues` turn.
4. `service_prices.quotable = false` with no `refusal_key` (also a check constraint; the validator gives the readable message).
5. A `staff` row references a missing group; a `disclosure_rules.subject_ref` names a missing service.
6. `booking_mode='structured_handoff'` with zero `booking_handoff_fields`; `booking_mode='link'` with no `booking_url`.
7. Any Cyrillic text column is not NFC-normalised (also a check constraint).
8. A reviewed row's rendered bytes changed since `reviewed_at` — re-review required.
9. The compiled prompt exceeds the plan's token budget, or falls **below** the model tier's `min_cacheable_tokens` while caching is on (a short prompt silently fails to cache on Haiku's 4096 minimum, which is invisible in the reply and just bills full price).
10. Zero enabled `channel_bindings` while `lifecycle='active'` is requested.

Warnings, not blockers: an empty optional section; a price older than 180 days with no `valid_until`; a `tenant_prompt_overrides` row inside 14 days of expiry.

**The publish response includes a rendered-prompt diff against the live snapshot.** The founder approves the customer-facing change, not a row count.

---

### 1.10 The escape hatch, and the proposal path

**Overrides are bounded.** Free-text prompt overrides are inevitable; unbounded ones are `config/currentClient.js` again with worse ergonomics.

```sql
create table tenant_prompt_overrides (
  tenant_id  uuid not null references tenants(id),
  id         uuid not null default gen_random_uuid(),
  section    text not null check (section in ('channel','language','answering','booking')),
  text       text not null check (text is normalized),
  justification text not null,
  expires_at timestamptz not null,           -- REQUIRED. no perpetual overrides.
  created_by uuid not null,
  primary key (tenant_id, id)
);
```

Founder-only. `expires_at` mandatory. A standing weekly report lists every live override; an override that keeps getting renewed is a **missing platform feature**, and the report is how it gets built instead of accumulated. (The ancestor's cautionary case is `api/chat.js:337-383` — ~50 lines of a *previous* tenant's B2B sales persona, reachable only through `:385-387`, which nothing calls, still shipping in the production bundle.)

**The Quality layer writes proposals, never config** — and the drafted proposal table was a generic "apply arbitrary DML described in JSON" engine authored by an LLM that reads attacker-controlled customer text. Critique A is right; four constraints close it:

```sql
create table config_change_proposals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  origin       text not null check (origin in ('quality_ai','founder','tenant_owner')),
  target_table text not null check (target_table in (
                 'services','service_prices','staff','tenant_facts','canned_responses',
                 'disclosure_rules','answer_rules','example_dialogues',
                 'business_hours','tenant_closures')),        -- CONTENT tables only
  target_pk    jsonb not null,
  operation    text not null check (operation in ('insert','update','delete')),
  proposed     jsonb not null,
  evidence     jsonb,                       -- conversation ids that motivated it
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected','applied')),
  decided_by   uuid, decided_at timestamptz, applied_version int,
  created_at   timestamptz not null default now(),

  constraint quality_ai_may_not_delete
    check (origin <> 'quality_ai' or operation <> 'delete'),
  constraint quality_ai_content_only
    check (origin <> 'quality_ai' or target_table in
             ('canned_responses','tenant_facts','answer_rules','disclosure_rules'))
);
```

Plus, and these are the load-bearing halves: **the apply path derives tenant scope from `config_change_proposals.tenant_id` and rejects any `target_pk` naming a different tenant**; and **the publish validator runs against `proposed` at insert time**, so an invalid or out-of-scope proposal cannot exist to be approved. Without the allow-list, `target_table='tenant_capabilities'` was an expressible row — a self-granted capability — and `target_pk` naming another tenant was a cross-tenant config write inside the one subsystem whose entire premise is that tenants cannot touch each other. No `23505` fires, no composite FK is involved, and `service_role` bypasses RLS.

**Approval writes the draft; it does not publish.** Publishing stays a separate, explicit founder act. That is what "never auto-applies" means mechanically: two human steps, both audited. `config_audit(tenant_id, at, actor, via, target, operation, before, after, config_version_after)` records every one, and never a secret column. A config write with `origin='quality_ai'` and no approved proposal is alertable — but it is a chokepoint-and-audit control, not a database control, and must be described as one, because `service_role` can write anywhere and `FORCE ROW LEVEL SECURITY` does not change that.

---

### 1.11 The admin surface — what onboarding client #3 actually is

Critique A's first finding is the most important one in either critique: the section claimed onboarding becomes "insert rows, publish, no deploy", but the write path described cannot be executed by inserting rows. `channel_secrets` holds envelope ciphertext whose KEK lives only in the Vercel environment, so it cannot be produced from the Supabase SQL editor. A binding needs a live `GET /{page-id}?fields=name` and a `POST /{page-id}/subscribed_apps`. Without a named admin surface, onboarding is a developer task by construction — and dashboard-applied SQL leaves no ledger, so nobody could later tell whether tenant #3's `tenant_capabilities` rows were written or forgotten.

The admin API is therefore a **deliverable of this section**, not a later concern. All routes are founder-authenticated, export `POST` (which also sidesteps the GET-caching trap), use the `no-store` client, and write `config_audit`:

| Route | Does |
|---|---|
| `POST /api/admin/tenants` | creates in `onboarding`; copies the vertical template into the draft |
| `POST /api/admin/tenants/{id}/channels` | **one server-side transaction:** acquire the Page/IG token (System User or Business Login), `GET /{external_id}?fields=name` → `verified_name`, envelope-encrypt into `channel_secrets`, `POST /{page-id}/subscribed_apps`, insert the binding **disabled** |
| `POST /api/admin/channels/{binding_id}/confirm` | founder confirms the fetched Page name → `name_confirmed_by/at` → `enabled=true` |
| `POST /api/admin/tenants/{id}/config/import` | paste/CSV price list and staff roster → draft rows, with a preview |
| `POST /api/admin/tenants/{id}/config/validate` | dry run: validator errors + the rendered prompt + a diff against live |
| `POST /api/admin/tenants/{id}/config/publish` | snapshot N+1, then flip the live pointer |
| `POST /api/admin/tenants/{id}/config/rollback` | set `live_config_version` to a prior version |
| `POST /api/admin/tenants/{id}/activate` | `onboarding → active`; refuses without a published config and ≥1 enabled binding |
| `POST /api/admin/tenants/{id}/suspend` \| `/churn` | lifecycle + reason; churn also releases bindings |
| `POST /api/admin/proposals/{id}/approve` \| `/reject` | writes the draft only (§1.10) |

**Failure modes.** The channel route is the one that can half-succeed: a token minted and stored but the `subscribed_apps` call failing leaves a tenant that will never receive a webhook. It must be idempotent on `(provider, external_id)`, must roll the binding back to `unprovisioned` on any step failure, and must **never** leave `enabled=true` with `token_status <> 'active'`. Meta rate-limits or a `190` during onboarding surface as the actual Graph code, not a generic 500. A duplicate identity returns the actionable message from §1.3, not a 23505 dump.

---

### 1.12 Mongolian text rules that bind this schema

Mongolian Cyrillic is the primary text and the schema encodes that, because these failures are silent.

- **NFC at every input boundary** — webhook body, admin form, CSV import — and nowhere else. `normalize(x, NFC)` in SQL, `.normalize('NFC')` in JS, plus `check (col is normalized)` on every Cyrillic column. `й`, `Й`, `ё`, `Ё` have canonical decompositions (`ө` and `ү` do not), so two visually identical KB entries can never match each other. The ancestor has **zero** normalisation calls anywhere, which is why `'Байна уу'.normalize('NFD')` fails its own greeting matcher while the NFC form passes.
- **No `\b`, no `\w`, no `[a-z]` in any JavaScript regex over user text.** Postgres regexes are locale-aware; JavaScript's are not, and the `u` flag does not fix `\b` because `\w` is permanently `[A-Za-z0-9_]`. Use `\p{L}`/`\p{N}` with `u`, or `Intl.Segmenter` tokens. Enforce with a CI grep — this gets reintroduced by copy-paste six months out.
- **No unanchored substring matchers over user text.** `GREETING_REGEX = /^(сайн|байна|уу|hi|hello|hey)/i` (`lib/salonIntents.js:26`) has no right boundary, so `Уучлаарай асуумаар байна` — one of the commonest Mongolian service openers — is classified as a greeting and the customer's real question is never answered. `LOCATION_REGEX` (`:21`) matches `хаяг` anywhere, so "Facebook хаяг байна уу" returns a Google Maps card; the email carve-out at `:25` is a hand-patched symptom of the same disease. `disclosure_rules.match_terms` is a token list matched over segmented tokens, never a regex.
- **`unaccent` must not be installed.** It maps `Ё → Е` and `ё → е` while leaving `Й`, `Ө`, `Ү` untouched — *partially* destructive on Mongolian, so it looks harmless in nine tests of ten. `Ё` is a full letter (ёстой, Ёндон, ёс).
- **Folding is an explicit table you own**, applied only to a derived search column, never to stored canonical text: `ө→о`, `ү→у`, `й→и`, `ё→е` — the real Mongolian layout confusions, which are typing errors and not diacritics. Trigram similarity collapses without it (`similarity('өнгө','онго') = 0`).
- **`citext` is not used**; its folding depends on `LC_CTYPE`, which is fixed at database creation. Use `lower(normalize(x, NFC))` in a **stored generated column** — indexable, deterministic, and visible in the catalog, so you can *see* the rule rather than trust every writer applied it.
- **Characters, bytes and code units are three different things.** `'Үс засалт'` is 9 characters and 17 bytes. Meta's 2000-character cap is characters; a `varchar(n)` sized by eye is ~1.9× too small. JS `.slice()` is UTF-16 code units and will split an emoji — salon DMs are full of them; use `Array.from(s).slice(n).join('')`. The ancestor already guards a button title against a split surrogate (`lib/messengerClient.js:156-158`) but not the message chunker.
- **`hasBusinessContext = /салон|үйлчилгээ|үнэ|цаг|хаана|service|price/i`** (`lib/validator.js:224`) puts one tenant's vertical in the platform's input filter; the gibberish class `/^[^аеёиоуыэюя\s]{20,}$/i` (`:201`) is the **Russian** vowel set, missing `ө` and `ү` — so strings of exactly the two letters that most distinguish Mongolian from Russian are classified as *having no vowels*. Any such filter becomes tenant-declared terms, and a rejection it causes must be observable and reviewable (that is what the Quality layer is for), never a silent HTTP 200 refusal as at `api/chat.js:58-73`.
- **Two catalog assertions in the verification pack**, because one is unfixable in place: `datcollate` must not be `C`/`POSIX` (verified: `lower('ҮС ЗАСАЛТ' collate "C")` returns `ҮС ЗАСАЛТ`, unchanged, silently) and cannot be changed after database creation; and `select extname from pg_extension where extname='unaccent'` must be empty.
- **Sorting** any user-visible staff or service list needs an ICU collation (`mn-MN-x-icu`, else `und-x-icu`); byte order puts `Ө` (U+04E8) and `Ү` (U+04AE) after all basic Cyrillic instead of in their alphabet positions.

---

### 1.13 The chokepoint and the failure-code table

One function scopes and meters, and route code should not be *able* to build a query without it — the `guardAiRoute()` lesson: one gate, no local re-implementations.

```ts
withTenantEntry(rawBody, signature, entry, async (ctx: TenantContext) => { … })

type TenantContext = {
  tenant_id: string; slug: string; lifecycle: string; timezone: string; locale: string;
  binding: { id: string; provider: string; external_id: string; token_status: string };
  snapshot: { version: number; content_hash: string; prompt_blocks: …; schema_version: number };
  db: ScopedClient;        // every query pre-bound to tenant_id
  spend: LedgerHandle;     // reserve/settle, 503 on any error
  log: (msg, fields) => void;   // tenant_id + binding_id stamped, always
};
```

Order, each step failing closed: **signature → platform capability → tenant resolution → lifecycle → tenant capability → snapshot → budget.**

| Code | HTTP (webhook) | HTTP (admin) | Behaviour |
|---|---|---|---|
| `signature_invalid` | 401 | — | Missing app secret is **401, never "skip verification"**. Verified over raw bytes before any parse, `timingSafeEqual`. |
| `capability_platform_disabled` | 200 + drop | 403 | Checked before tenant resolution. |
| `channel_unresolved` | **200 + drop** | 404 | Persist raw envelope with `tenant_id = null`; counter `webhook.unrouted{provider}`; alert at ≥3/hour for one `external_id`. **Never auto-create a tenant.** |
| `registry_unavailable` | **500** | 503 | Deliberately not 200 — see below. |
| `tenant_not_active` | 200 + policy | 409 | Per §1.2. |
| `capability_not_entitled` | 200 + drop | 403 | |
| `config_not_published` | 200 + persist | 409 | Alert — a customer reached a Page bound to a non-live tenant. |
| `config_schema_unsupported` | **503** | 503 | Never best-effort an unknown snapshot shape. |
| `credential_missing` / `credential_revoked` | 200 + persist | 409 | Stop outbound on that binding. Never retry a Graph `190`. |
| `budget_exhausted` | 200 + policy | 429 | Canned or silent per plan. |
| `tenant_not_provisioned` | 200 + persist | 409 | Distinct from 500 and from a silent skip. |

**The one asymmetry worth staring at: `channel_unresolved` is 200, `registry_unavailable` is 500.** An unknown channel is *permanent* — retrying cannot help, and sustained non-200s get the asset unsubscribed after ~1h, losing a tenant rather than a message. An unreadable registry is *transient* — a 200 drops the event forever; a 500 gets it redelivered. Getting these the same way round costs either one message or one tenant's entire subscription. This is the same instinct the ancestor already got right at one tenant: *"A timeout is ambiguous: the publish may actually have landed at QStash. Only DEFINITIVE (hard) failures are processed inline"* (`api/messenger.js:118-120`). Promote it to a first-class rule.

**Per entry, never per request.** A request resolving three entries to three tenants produces three independent contexts, three ledger charges, three sets of log lines. The ancestor never notices because `extractActionableEvents` iterates `body.entry` and **never reads `entry.id`** (`api/messenger.js:164-180`) — `FACEBOOK_PAGE_ID` at `:165` is only a self-echo guard. Tenant routing does not exist in it at all.

---

### 1.14 Failure modes

| # | Failure | Detection | Response |
|---|---|---|---|
| 1 | Tenant not found for an inbound event | resolver returns zero rows | ACK **200** (a 4xx risks unsubscription). Persist the raw envelope with `tenant_id = null`, flagged `unrouted`, 7-day retention, founder-read-only — the only tenant-less data in the system. **Never auto-create a tenant. Never a `?? DEFAULT_TENANT` fallback**, not even for local testing: that line, written once for convenience, is the single most likely source of a cross-tenant leak. |
| 2 | Registry unreachable | resolver throws | **500**, accept the retry (§1.13). |
| 3 | Tenant `onboarding` | lifecycle | Persist, no AI, no send, **alert** — urgent. |
| 4 | Tenant `suspended` | lifecycle | Persist, no AI. Canned notice only under the three-way gate of §1.2; otherwise silent + alert. |
| 5 | Tenant `churned` | lifecycle | Drop, do **not** persist the body, **page the founder**. |
| 6 | A required field is missing at serve time | validator | Cannot occur — `active_requires_published_config` plus the snapshot model. At publish it is a blocking error naming the exact path. An *optional* unrenderable section is omitted, recorded in `omitted_sections`, alerted — **never rendered with a guess** (`lib/systemPromptBuilder.js:36-38`, generalised). |
| 7 | Two tenants claiming one channel | `unique (provider, external_id)` | Impossible; the attempt raises `23505` and the admin route returns the actionable message. |
| 8 | Right page id, wrong tenant | no constraint catches this | Onboarding-time name confirmation (§1.3) + `enabled_requires_name_confirmation`. |
| 9 | **Tenant misidentified** (catastrophic) | layered | (a) the resolver is the only path and takes its key from the *verified* envelope; (b) `entry.id` cross-checked against `recipient.id`/`sender.id` with a mismatch counter; (c) the send path takes a `binding_id`, fetches the token by it, and posts to `/{external_id}/messages` — **never `/me/messages`** — so a mismatch fails instead of succeeding as the wrong salon; (d) `tenant_id` on every log line, Redis key, rate-limit key and ledger row; (e) prompt cache keyed by `content_hash`. |
| 10 | Page token expired/revoked | Graph `190` | `token_status='revoked'`, stop **all** outbound on that binding, keep persisting inbound, alert, never retry. Per-binding. |
| 11 | Token dies silently and nobody notices | absence of traffic | `last_webhook_at` watchdog per binding + periodic reconciliation of `GET /{page-id}/subscribed_apps` against the registry. A dead token throws nothing anywhere — Reception simply stops replying. The reconciliation job is scheduled, so it needs a ceiling and an alert path and must not touch Anthropic. |
| 12 | Budget exhausted | ledger | Per plan policy; validator guarantees the canned response exists when required. |
| 13 | Snapshot schema newer than reader | `schema_version` assertion | **503.** Compiler supports N and N−1 for one deploy cycle. |
| 14 | Config edited to something valid but wrong | **nothing catches this** | Mitigations only: immutable snapshots + one-click rollback, a shadow delivery mode for a soak, a rendered-prompt diff at publish, `config_audit` naming the actor. Stated plainly as unsolved. |
| 15 | Quality layer writes config directly | `config_audit` anomaly | Constrained by §1.10's allow-list and tenant-scope derivation; a write with `origin='quality_ai'` and no approved proposal is alertable. Chokepoint-and-audit, not a database control. |
| 16 | Two tenants in one warm lambda | acceptance test 1 | Nothing module-scope holds tenant content without a `(tenant_id, version)` key. |
| 17 | Retry burns a fresh generation | worker | Distinguish retryable (5xx, 429, timeout) from terminal (4xx auth, budget exhausted, `190`, private-reply subcode `2534014`). Retry the **send**, never re-enter generation — the reply is already generated and already paid for. |

---

### 1.15 RLS and ACL posture for these tables

Detail belongs to the security section; the per-table expectations belong here, because non-negotiable #3 requires each table verified **independently** — the last failure next door was partial, one of four tables, and a spot check on the correct one confirmed the wrong conclusion.

**Class A — `anon` and `authenticated` hold ZERO privileges:** `tenants` · `channel_providers` · `channel_bindings` · `channel_secrets` · `tenant_capabilities` · `platform_capabilities` · `plans` · `model_tiers` · `tenant_config_snapshots` · `tenant_prompt_overrides` · `config_change_proposals` · `config_audit` · `webhook_events`.

**Class B — tenant-owner readable, writable only where the owner legitimately authors the content** (`services`, `service_prices`, `staff`, `tenant_facts`, `business_hours`, `canned_responses` drafts):

```sql
create policy services_read on services for select to authenticated
  using (tenant_id = any ((select public.current_tenant_ids())::uuid[]));

create policy services_write on services for update to authenticated
  using      (tenant_id = any ((select public.current_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select public.current_tenant_ids())::uuid[]));
```

Three details, each measured rather than assumed: name the role (`to authenticated` means the policy is not evaluated for `anon`); wrap in `(select …)` (~15× when the predicate cannot become an index condition, ~1.5× when it can — do it anyway, you cannot predict which query loses its index); and use `= any (…::uuid[])`, **not** `@> array[col]`, because containment is not an index condition (7 ms vs 55 ms on 200k rows). The `SECURITY DEFINER` helper with `set search_path = ''` is mandatory — a policy that joins `tenant_members` runs that join under `tenant_members`'s own RLS, and a deny-all there makes the outer query return **zero rows with no error**: an empty dashboard, HTTP 200, `error: null`. That is the plausible-empty failure class, inside RLS itself.

**`WITH CHECK` must repeat the tenant predicate.** `USING` gates which rows you may touch; `WITH CHECK` gates what they may become. Omitting it on an UPDATE policy is a tenant-hopping write: `update … set tenant_id = <other tenant>`.

**Class C — server-asserted, `SELECT`-only to clients, with per-command restrictive denies:**

```sql
create policy snap_no_insert on tenant_config_snapshots
  as restrictive for insert to anon, authenticated with check (false);
create policy snap_no_update on tenant_config_snapshots
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy snap_no_delete on tenant_config_snapshots
  as restrictive for delete to anon, authenticated using (false);
```

**Never `as restrictive for all using (true) with check (false)`** — the sibling's `_no_client_writes` shape. It was verified by execution that **`DELETE` goes straight through it**: `DELETE` has no `WITH CHECK` clause and is governed by `USING`, which is `true`. It is masked next door by two accidents (no permissive write policy, no DELETE grant); remove either mask and deletes work. And do not collapse into `for all using (false)` either — `for all` applies `USING` to `SELECT` and silently blinds the dashboard.

**`revoke insert, update, delete` is not "cannot write."** `TRUNCATE` bypasses RLS entirely and was verified emptying a table under a restrictive `with check (false)` policy; `REFERENCES` and `TRIGGER` sit in the same bucket, and PG17 adds `MAINTAIN`. Enumerate the ACL with both null-traps closed:

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

`coalesce(relacl, acldefault(...))` because a table created and never `GRANT`ed carries a **null** ACL and a bare `aclexplode` reports zero rows — another plausible-empty answer. `grantee = 0` because `pg_get_userbyid(0)` returns the string `'unknown (OID=0)'` rather than erroring, so a grant to `PUBLIC` (which `anon` inherits) appears under a nonsense name and gets skimmed past.

**`information_schema.role_table_grants` is banned in this codebase.** Verified live, same database, same instant: 72 `aclexplode` rows versus 0 view rows for a non-participating role.

Two structural checks must return **zero rows in CI**, because together they catch the entire class of the sibling's `20260817` failure — a table nobody remembered to migrate:

```sql
-- (a) every public table has RLS on and at least one policy, or is on a written allow-list
select n.nspname||'.'||c.relname,
       case when not c.relrowsecurity then 'RLS DISABLED' else 'RLS ON, NO POLICIES' end
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relkind in ('r','p')
  and (not c.relrowsecurity
       or not exists (select 1 from pg_policy p where p.polrelid = c.oid));

-- (b) every tenant-scoped table carries tenant_id AND tenant_id leads an index
select c.relname, (a.attname is not null) as has_tenant_id,
       exists (select 1 from pg_index i where i.indrelid=c.oid and i.indkey[0]=a.attnum) as leads_index
from pg_class c join pg_namespace n on n.oid=c.relnamespace
  left join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id'
   and a.attnum>0 and not a.attisdropped
where n.nspname='public' and c.relkind in ('r','p') order by 1;
```

**And the honest statement that must accompany all of it: RLS protects the dashboard and protects nothing on the inbound path.** Webhook → tenant lookup → Anthropic → send has no user session at any point and runs as `service_role` end to end; `service_role` carries `BYPASSRLS`, and `FORCE ROW LEVEL SECURITY` does not change that (it subjects the *table owner*, not a `BYPASSRLS` role). What substitutes, in order: the tenant derived server-side from a verified signal; the single chokepoint that both scopes and meters; the composite FKs carrying `tenant_id`, which are the one check the database still enforces against a service-role bug; and `tenant_id` on every log line and key. Also: mint **separate named `sb_secret_…` keys** per component — `webhook-ingest`, `worker`, `analytics`, `admin` — so a leak on the webhook path forces one rotation, not a full-project one, and do the JWT signing-keys migration at project creation when there is nothing to break.

---

### 1.16 What this replaces in the ancestor, what carries across, and how it is tested

| # | What must go | Where it is now | Replacement |
|---|---|---|---|
| 1 | **Module-scope prompt cache** — highest-severity multi-tenancy defect, invisible at one tenant | `lib/salonBrain.js:142` `let cachedBasePrompt = null`, built from the build-time `clientData` imported at `:11` | snapshot cache keyed `(tenant_id, version)`; prompt cache keyed `content_hash` |
| 2 | **Build-time tenant import** | `lib/salonBrain.js:11`, `lib/salonIntents.js:17`, `api/chat.js:9`, `src/clientConfig.js:9` | per-request snapshot from `TenantContext` |
| 3 | **`SALON_NAME` in every log line** — stamps the *build's* tenant, not the request's | `lib/salonBrain.js:46`, used at `lib/messengerProcess.js:80, 88, 117` | `ctx.slug` |
| 4 | **Credential fallback** — tenant B's message on tenant A's token | `lib/messengerClient.js:67-69` `explicit \|\| process.env.PAGE_ACCESS_TOKEN` | required argument resolved from `channel_secrets` by `binding_id`; missing ⇒ refuse |
| 5 | **`/me/messages`** — a token/tenant mismatch *succeeds* and posts as the wrong salon | `lib/messengerClient.js:10` | `/{external_id}/messages` from `channel_providers.send_path_tmpl` |
| 6 | **`entry[].id` never read** | `api/messenger.js:164-180` | `resolve_channel(object, entry.id)`, **per entry** |
| 7 | **Instagram silently dropped** | `api/messenger.js:99` — `object !== 'page'` ⇒ bare 200 | object→adapter dispatch over `channel_providers` |
| 8 | **Un-namespaced Redis keys** | `msgr:hist:<psid>` (`lib/conversationStore.js:88`), `msgr:done:<mid>` (`:53`) | `{slug}:msgr:hist:{psid}` — PSIDs are page-scoped and a collision across tenants is not a thing to bet chat history on |
| 9 | **The deliberate omission encoded in code, three times** | `lib/salonBrain.js:70-72` + `lib/systemPromptBuilder.js:135` + a comment at `config/currentClient.js:34-35` | one `disclosure_rules` row + one `canned_responses` row |
| 10 | **Three hardcoded staff buckets with no `else`** | `lib/systemPromptBuilder.js:69-84` | `staff_groups` + FK + publish-blocking error |
| 11 | **The deposit table as prose in a shared template** | `lib/systemPromptBuilder.js:138-149` | `booking_requirements`; GS Auto has zero rows |
| 12 | **Prices as display strings** (`number \| string` union) | `config/currentClient.js:38-39`, branched at `lib/systemPromptBuilder.js:18-23` and `:106-110` | `price_kind` + `amount_min/max` + `currency` + `quotable` |
| 13 | **Example dialogues that interpolate a lookup that returns `''` on a miss** | `lib/systemPromptBuilder.js:106-111, 151-165`; same shape at `lib/salonBrain.js:80` | `example_dialogues` + the closed placeholder grammar (§1.6.4) |
| 14 | **Conditional answering rules as prose** | `lib/salonBrain.js:95-98` | `answer_rules` with a closed `kind` enum |
| 15 | **A default closure shipped in code** | `config/closures.js:40-52` | no default, ever; `tenant_closures` rows |
| 16 | **A Mongolia-only timezone constant** | `config/closures.js:32` | `tenants.timezone`, IANA |
| 17 | **Closures as env vars** | `config/closures.js:140-151` | rows |
| 18 | **`QPay-ээр` and «урьдчилгаа төлбөр» hardcoded** | `lib/salonBrain.js:79-81` | `canned_responses['booking_direction']` + `booking_mode` |
| 19 | **Model id per deployment; one with a date suffix** | `lib/salonBrain.js:19`, `api/chat.js:13` | `model_tiers` + plan attribute + a date-suffix check constraint |
| 20 | **`салон` in the platform's input filter; the Russian vowel set** | `lib/validator.js:224`, `:201` | tenant-declared terms; §1.12's fold pipeline |
| 21 | **Unanchored substring matchers** | `lib/salonIntents.js:21, 26, 41` | token matching over `Intl.Segmenter`, NFC-normalised |
| 22 | **Another tenant's persona still in the bundle** | `api/chat.js:337-383`, reachable only via `:385-387`, which nothing calls | deleted; §1.10's expiry rule is the defence against recurrence |
| 23 | **An unenforced type that has already drifted** | `types/clientConfig.ts:20, 38-47`; consumers hand-defend at `lib/systemPromptBuilder.js:56-63` | check constraints + FKs + the publish validator: **one shape, validated at write time** |
| 24 | **Onboarding is a git branch — and its own guide documents a shape the code abandoned** | `CLIENT_ONBOARDING.md:9, 52-56`; `:22/:31/:39` say `productList`/`faqList`/`contactInfo` while `config/currentClient.js:36/88/106` uses `knowledge.priceList`/`faqs`/`contact` | the admin API of §1.11 |

**What must be carried across unchanged.** Five properties are hard-won and each encodes an incident:

1. **Fast-ACK before any slow work** (`api/messenger.js:109-154`) — it is what stands between you and a silently unsubscribed tenant.
2. **Ambiguous failure ≠ failure** (`api/messenger.js:118-133`) — a timed-out enqueue may have landed; retrying it inline double-replies the customer. Promote it into a real DB-unique idempotency key on `message.mid` / comment `value.id`, checked **before** the Anthropic call.
3. **Raw-body HMAC with `timingSafeEqual`, failing closed on a missing secret** (`lib/messengerClient.js:25-42`; raw body preserved at `api/messenger.js:16-20`). In App Router that is `await req.text()` before `JSON.parse`, with nothing consuming the stream first.
4. **`null` ≠ `[]` for history availability** (`lib/conversationStore.js:84-101, :100`, consumed at `lib/messengerProcess.js:50-60`) — the greeting fires only when history is *confirmed* empty, so a Redis hiccup mid-conversation cannot make the bot greet an existing customer from scratch. The plausible-empty defence, already correctly implemented once in this codebase.
5. **Send first, mark handled second, one atomic send** (`lib/messengerProcess.js:96-99, 111-116`) — a failed send leaves nothing delivered and the retry is clean.

**Acceptance tests.** Offline, with an injected clock — the ancestor's own suite is red today (16 pass, 2 fail) because `tests/closures.test.js:204, 226` assert against the shipped Naadam closure that ended six weeks ago, reading the real clock. It was time-bombed the day it was written and nothing noticed.

1. Process an event for tenant A then tenant B in the same warm instance. **B's rendered `prompt_blocks` must contain none of A's prices, staff names, phone or booking URL** — assert on the block hash, not the reply text.
2. Publish a config change to A. B's version, `content_hash` and prompt must be byte-identical before and after.
3. Bind a Page id to A, then attempt the same `(provider, external_id)` on B. Assert `23505` **and** that the admin route returns the actionable message, not a 500.
4. Suspend A with `suspension_reply='canned'` and delete `suspended_notice`. Assert **silence**, an alert, and **zero** Anthropic calls.
5. Set A `lifecycle='active'` with `live_config_version = null` by direct SQL. Assert the check constraint refuses the statement. This one matters most because it tests the *constraint* rather than the code meant to honour it — and the sibling's whole postscript is about that gap.
6. **The onboarding test.** A person with no shell, no SQL editor and no repo checkout takes tenant #3 from zero to first live reply using only the §1.11 routes. Because a real Page token cannot be minted in CI, this splits in two: an automated run against a fake Graph server that asserts the full route sequence, the transaction boundaries and the idempotency; plus a one-page manual runbook executed once per real onboarding, whose completion is recorded in `config_audit`. Critique A is right that this, not test 5, is the test of the founder's hard test — the automated half just cannot be the whole of it.
7. Rename a service that a reviewed example dialogue interpolates. Assert publish is **blocked** with the exact path named, and that no prompt containing `₮` with no number in front of it can be produced.

---

### 1.17 Verified vs assumed

**Verified by reading the file this session** — every `path:line` above in `/home/user/Matrix-Chatbot/`: `config/currentClient.js`, `config/closures.js`, `types/clientConfig.ts`, `CLIENT_ONBOARDING.md`, `lib/systemPromptBuilder.js`, `lib/salonBrain.js`, `lib/salonIntents.js`, `lib/messengerClient.js`, `lib/conversationStore.js`, `lib/validator.js`, `api/messenger.js`. Also the sibling's `CLAUDE.md` in full.

**Carried from the research packets with their marks intact, and re-checkable.** The Postgres behaviours — restrictive-`for-all` letting `DELETE` through; `TRUNCATE` bypassing RLS; `relacl IS NULL` yielding zero `aclexplode` rows; `pg_get_userbyid(0)`; `unaccent` mapping `Ё→Е`; `C` collation not folding Cyrillic; the `(select …)` and `= any` timings; the `EXISTS`-join silent-empty — were verified by execution on a local **PG 16.13**, while Supabase production next door is **PG 17.6**, where the ACL residue is `Dxtm` (4 privileges) rather than `Dxt` (3). The Meta facts — `entry[].id` semantics per auth flavour, the 24-hour window, the 2026-04-27 tag retirement, the ~1h unsubscription threshold, error `190`, private-reply subcode `2534014` — come from a session in which **`developers.facebook.com` was unreachable**. The highest-value item to re-verify before code is what `entry[].id` is under each Instagram auth flavour, because tenant routing depends on it and the secondary sources disagreed with production code.

**Assumed, and flagged as such.** Every GS Auto Center and dental-clinic value in §1.7 — services, prices, hours, staff groups, disclosure rules. The verticals are real; the values are invented illustration and the *structure* is the deliverable. That the founder wants tenant owners to have a dashboard login at all (§1.15 Class B exists only to serve one). That one person may hold more than one tenant (`current_tenant_ids()` returns an array on that assumption, which costs almost nothing now and is expensive to add later). Token counts for a compiled Mongolian prompt: the ancestor's cached block measures 10,987 characters / 18,450 UTF-8 bytes, but no token count was taken; `prompt_tokens` is a column precisely so this stops being an estimate.

**Not verified and load-bearing.** That Vercel's function timeout on the target plan exceeds the pipeline's deadlines: `UPSTREAM_TIMEOUT_MS = 25000` (`lib/salonBrain.js:38`) and `INLINE_DEADLINE_MS = 12000` (`api/messenger.js:27`) both exceed the 10 s Hobby default, and `vercel.json` carries no `functions` block. Confirm against the actual plan before sizing anything. Also unverified: whether a Page token derived from a System User token inherits never-expiry, which determines whether a token-refresh path is needed at all.

---

### 1.18 Open questions — the founder's call

1. **Does a tenant owner get a login in v1?** Everything in §1.15 Class B — the membership join, `current_tenant_ids()`, the own-tenant write policies — exists to serve a dashboard. If Matrix and GS Auto get a weekly report instead, RLS-for-humans is dead weight and the whole security budget belongs on the service-role inbound path, where all the volume and all the spend actually are. **The single highest-leverage decision in this section**, because it determines whether half these tables need policies at all.

2. **What is a tenant's monthly dollar ceiling, and what happens at it?** Hard stop (Messenger goes silent mid-conversation on a Saturday), degrade to `budget_exhausted_notice`, or auto-overage-bill. §1.5's gate cannot be finished without the number, and the default `budget_exhausted_policy` is a pricing decision. My recommendation is `canned` — the salon's customer should not experience a billing dispute as a black hole — but that is commercial.

3. **Does the tenant own the "never quote this" list, or does the founder?** `disclosure_rules` and `service_prices.quotable` are genuinely valuable and genuinely dangerous: a tenant who sets one carelessly gets a bot that refuses to sell. My recommendation is founder-approved-only in v1 — same tables, RLS forbids tenant writes — with a proposal flow later. But it is a product decision about how much rope the customer gets, and §1.6.1's `quotable`-with-no-default forces someone to answer it per row at onboarding either way.

4. **Does Customer Care ship SMS-only, or does Dalatech commit to Meta's Utility Template approval track?** The tags it would have used died 2026-04-27 (error `100`); `HUMAN_AGENT` survives but forbids AI-authored text and Meta says it detects misuse; its availability on Instagram is contested between sources. The compliant Messenger path is template-approved Utility Messages — approval-gated, category-constrained, possibly per-message priced, possibly unavailable in Mongolia. §1.5 makes it a row either way, but the answer determines whether `platform_capabilities['customer_care_sms']` is ever joined by a Meta sibling.

5. **Do Matrix's pinned Mongolian strings get re-reviewed on migration?** They were native-speaker reviewed for *that prompt in that context* — `lib/salonBrain.js:48-51` records the incident that produced them. Moving them into `canned_responses` and changing the surrounding prompt changes the conditions they were validated under. `reviewed_by` forces the question to be answered rather than assumed; someone still has to answer it, and it costs a native speaker's afternoon.

6. **One Meta app, or a small number sharded by tenant cohort?** One app is the premise and is right on cost and operations — but it means one app secret, one App Review verdict, one shared app-level rate budget (`200 × app users` per hour, shared across every tenant, and Meta will not fair-share for you), and one blast radius: a policy strike takes down Matrix and GS Auto simultaneously. `channel_bindings.app_id` accommodates both regardless, and Chatwoot's production code supports per-channel app secrets precisely because real deployments end up wanting this. The schema does not force the decision; the App Review timeline might.

7. **Does Matrix's website chatbot survive?** `api/chat.js` plus the `public/` + `src/` widget is a third channel. `web_widget` is in `channel_providers` on the assumption it does. If it is retired, that row and one renderer branch come out. If it survives, it needs the same metering — it is currently an open, unauthenticated Anthropic proxy whose only gate is `lib/cors.js`, which allows any request with no `Origin` header, and which does no prompt caching at all.

8. **Cutover or parallel run?** Matrix Eco Salon is live on the ancestor today. One Page is subscribed to one app's webhook in practice, so "both at once" is not really available for Messenger. Is this one Page, one moment, one rollback plan — with a shadow soak first — or does GS Auto onboard onto Dala AI while Matrix stays on the old deployment until Advanced Access clears? Note the dependency: Business Verification of a Mongolian legal entity plus ~20-day App Review gates *any* tenant whose Page Dalatech does not own.