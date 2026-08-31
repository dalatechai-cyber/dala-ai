## 5. Per-tenant spend ledger, hard ceilings, and Telegram alerts

## 5.0 What this section is defending against

Two failures, both already documented next door, both of which this section must make structurally impossible rather than merely unlikely.

**The sibling had no dollar ceiling at all.** `src/lib/quizBank.ts:38-44` says it in its own words: "This repo had NO dollar ceiling of any kind — no budget, no spend ledger, and `requested = Math.min(MAX_PER_RUN, deficit)` with no affordability term. The only thing bounding spend was the depth read, and the comment on that read says so outright: *the ONLY thing standing between this function and unbounded spend*." That read was a Supabase `GET` through a client that did not set `cache: 'no-store'`, so it could be pinned for up to a year to whatever it first returned (`src/lib/supabase/fetch.ts:9-15`). In the Chinese sibling the same shape returned `active: 0` against a populated table, HTTP 200 and `error: null`, three times, and cost $12.43.

**The ancestor has no ceiling either, and its exposure is worse.** `generateSalonReply` checks exactly one thing before spending — that the key exists (`lib/salonBrain.js:177-181`):

```js
export async function generateSalonReply({ message, history = [] }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
    }
```

There is no budget, no counter, no ledger and no rate limit anywhere on the Messenger path — `lib/rateLimiter.js` is an in-process `Map` wired only into `api/chat.js`, never into `lib/messengerProcess.js`. The token counts that would populate a ledger are already computed and then discarded into a log line (`lib/salonBrain.js:245-253`). The only bound on Matrix Eco Salon's Anthropic spend today is how fast a human can type into the Page, multiplied by QStash's three retries (`lib/messengerQueue.js:13`) — and on the retry path `lib/messengerProcess.js:101-105` rethrows on *any* brain failure, so a permanent condition burns four full generations before the fallback.

The rule this section enforces:

> **Every upstream call that costs money is preceded by an atomic reservation against a per-tenant ceiling, is gated by a compare-and-swap that lets exactly one attempt make the call, and is followed by a settled ledger row. A call that cannot reserve does not happen. A reservation that cannot be settled is never released.**

The ceiling is a hard ceiling, not a target, and §5.5 is what makes that true rather than asserted.

---

## 5.1 Money units, clocks, and one non-obvious constraint

**Money is `bigint` nano-USD (1e-9 USD) everywhere.** Not floats, not `numeric`, not micro-USD.

- Floats are out because the ceiling comparison must be exact and the estimate is computed in JavaScript.
- Micro-USD is out because a Haiku cache-read token costs $0.0000001 — it truncates to **zero** micro-USD. A ledger whose smallest unit rounds spend down to zero under-reports, which is `count ?? 0` aimed at the price. Nano-USD holds a single cache-read token at 0.1 nano, and `bigint` tops out around $9.2 billion.
- A view (`app.v_spend_usd`) divides by 1e9 for humans. Nothing in the enforcement path ever sees a float.

**Every period boundary is Ulaanbaatar time, computed in exactly one function.** The sibling already does this correctly (`src/lib/supabase/usageLimits.ts:38-52`, `ulaanbaatarDateISO` via `Intl.DateTimeFormat` on `TZ = 'Asia/Ulaanbaatar'`), and there is exactly one such function so "today" cannot mean two things. A salon's day ends when the salon closes; a UTC day boundary would reset a tenant's daily ceiling at 08:00 local, mid-morning.

**Trap: do not compute the period key as a Postgres generated column.** `to_char(occurred_at at time zone 'Asia/Ulaanbaatar', 'YYYY-MM')` is **STABLE, not IMMUTABLE** (named zones can be redefined), so Postgres refuses it in `generated always as … stored`. The obvious workaround — `at time zone interval '+08:00'`, which *is* immutable — hardcodes the assumption that Mongolia never re-adopts DST, which it had in 2015-2016. So `period_day` and `period_month` are **plain columns written by the application** from the one clock function.

**And they are written once, at reservation time.** `spend_ledger.period_day` / `period_month` are copied verbatim from `spend_reservations`, never recomputed at settle. A call reserved at 23:59:58 and settled at 00:00:03 books entirely against the day it was reserved against. Without this rule the counters — which `scopes_held` correctly decrements on the reserve-time day — and the ledger disagree permanently for every call that straddles midnight, and §5.13's daily reconciliation reports an artefact, which trains the founder to ignore the alarm that is supposed to catch a real leak. Same at month end, where it also corrupts §5.10's margin table.

---

## 5.2 The tables

Schema `app`. Every table carries `tenant_id`, and the composite-FK discipline applies throughout: a ledger row can never reference another tenant's conversation.

### 5.2.1 `app.model_prices` — the price table

```sql
create table app.model_prices (
  id                  bigint generated always as identity primary key,
  provider            text   not null,           -- 'anthropic' | 'openai' | 'elevenlabs' | 'deepgram' | 'sms_trunk'
  model               text   not null,           -- 'claude-sonnet-5' — NEVER a date suffix
  unit_kind           text   not null
    check (unit_kind in ('tokens','characters','seconds','messages')),
  -- nano-USD per 1,000,000 units. For tokens that is per-MTok, which is how
  -- Anthropic quotes it, so the number in the table matches the number on the
  -- pricing page with no arithmetic in between.
  input_nanousd_per_munit        bigint not null check (input_nanousd_per_munit  >= 0),
  output_nanousd_per_munit       bigint not null check (output_nanousd_per_munit >= 0),
  cache_read_nanousd_per_munit   bigint,
  cache_write_nanousd_per_munit  bigint,
  min_cacheable_prefix_tokens    int,            -- 4096 on Haiku 4.5; NULL = caching unsupported
  max_context_tokens             int    not null,
  effective_from      timestamptz not null,
  effective_to        timestamptz,               -- null = current
  source_note         text not null,             -- 'anthropic pricing page, read 2026-08-30 by <who>'
  created_at          timestamptz not null default now(),
  exclude using gist (provider with =, model with =,
                      tstzrange(effective_from, effective_to) with &&)
);
```

Seed (from the model table supplied for this session, 2026-08-30; **cache read = 0.1× input, cache write = 1.25× input**):

| model | in $/MTok | out $/MTok | cache read | cache write | ctx | min cacheable prefix |
|---|---|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 | 0.50 | 6.25 | 1M | model-dependent |
| `claude-sonnet-5` | 2.00 | 10.00 | 0.20 | 2.50 | 1M | model-dependent |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 0.30 | 3.75 | 1M | model-dependent |
| `claude-haiku-4-5` | 1.00 | 5.00 | 0.10 | 1.25 | 200K | **4096** |

`min_cacheable_prefix_tokens` is a *cost* fact, not a trivium: on Haiku a prompt under 4096 tokens silently fails to cache, `cache_control` is ignored, and the estimator's assumption becomes wrong in the expensive direction. The estimator reads this column and refuses to assume a hit below the threshold.

**The table is authoritative at runtime; a compiled constant map exists only to detect drift offline.**

```ts
// src/lib/pricing/knownPrices.ts — NOT used to compute cost.
export const KNOWN_PRICES = {
  'claude-sonnet-5': { in: 2_000_000n, out: 10_000_000n, cacheRead: 200_000n, cacheWrite: 2_500_000n },
  // …
} as const
```

`scripts/check-model-prices.mjs` runs in CI and fails the build if (a) any model id referenced anywhere in `src/` has no current row in `model_prices`, or (b) a current row disagrees with `KNOWN_PRICES`. Same shape as `scripts/check-supabase-nostore.mjs` next door: an offline guard in both directions, so a table edit nobody committed and a commit nobody applied are both caught.

**A model with no current price row is not callable.** Not "priced at zero", not "priced at the last known value" — refused, `503 price_unknown`, alert. An unknown price makes every ceiling infinite.

**When a price changes:** close the old row (`effective_to = now()`), insert a new one. Never `UPDATE` a price in place — ledger rows reference `price_id`, and rewriting a price silently rewrites history.

**How you find out that you missed a price change:** not from the price table. From the reconciliation variance alarm (§5.12) — the monthly ledger total against the provider's own reported cost. It is the only detector that does not depend on the thing being checked.

### 5.2.2 `app.tenant_budgets` — append-only policy, one *current* row per tenant

The draft had a single mutable row with `ceiling_set_by` / `ceiling_reason` columns. Two dashboard edits race, last-write-wins, and the audit trail holds exactly one entry — the last one. Budgets get the same shape as prices:

```sql
create table app.tenant_budgets (
  id                         bigint generated always as identity primary key,
  tenant_id                  uuid   not null references app.tenants(id),
  status                     text   not null default 'active'
    check (status in ('active','soft_suspended','suspended','offboarded')),
  monthly_ceiling_nanousd    bigint not null check (monthly_ceiling_nanousd > 0),
  daily_ceiling_nanousd      bigint not null check (daily_ceiling_nanousd  > 0),
  -- Message-count caps, not dollar caps: a runaway loop is a count problem and
  -- a count is legible to the founder in a way a dollar figure is not.
  conversation_reply_cap     int    not null default 25,
  contact_daily_reply_cap    int    not null default 40,
  -- Per-surface carve-outs, as FRACTIONS of the monthly ceiling, so raising a
  -- plan raises every sub-ceiling with no second edit. Asserted to sum <= 1.0.
  surface_month_fraction     jsonb  not null default
    '{"reception":0.80,"analytics":0.10,"quality":0.10,"care":0.00}'::jsonb,
  soft_threshold_pct         int    not null default 80 check (soft_threshold_pct between 50 and 99),
  on_exhaustion              text   not null default 'canned_handoff'
    check (on_exhaustion in ('canned_handoff','silent','notify_only')),
  set_by                     text   not null,   -- a person, never a job
  set_reason                 text   not null,
  effective_from             timestamptz not null default now(),
  effective_to               timestamptz,       -- null = current
  exclude using gist (tenant_id with =,
                      tstzrange(effective_from, effective_to) with &&)
);
create view app.tenant_budget_current as
  select * from app.tenant_budgets where effective_to is null;
```

Two properties that matter more than the columns:

1. **There is no default row and no lazy creation.** A tenant with no current row is `not_provisioned` and every cost-bearing call for it is refused with a distinct code, not a 500 and not a silent skip. This is a deliberate divergence from the sibling, whose `ensureRow` (`src/lib/supabase/usageLimits.ts:66-92`) does a read-then-insert in the hot path — and whose own guard comment names "a unique-violation race in `ensureRow` on a brand-new account" as one of the paths that used to skip the quota entirely (`src/lib/aiRouteGuard.ts:71-77`). Provisioning is an onboarding step with a name and a reason attached, not a side effect of the first customer message.
2. **`set_by` / `set_reason` are `not null` on every version.** A ceiling that changed with nobody's name on it is the `BANK_BUILD_BUDGET_USD` lesson ("Say who approved it in the commit", `src/lib/quizBank.ts:66`) expressed as a column — and now with history, so raising a ceiling at 02:00 and lowering it at 09:00 leaves both facts on the record.

### 5.2.3 `app.spend_counters` — the enforcement state

```sql
create table app.spend_counters (
  tenant_id            uuid   not null references app.tenants(id),
  scope                text   not null
    check (scope in ('platform','tenant','surface','contact','conversation')),
  scope_key            text   not null default '',-- surface name / hashed contact ref / conversation id
  period_kind          text   not null check (period_kind in ('day','month')),
  period_key           text   not null,           -- '2026-08-30' | '2026-08'  — UB clock, app-computed
  ceiling_nanousd      bigint not null,           -- refreshed on every bump; display == enforcement
  count_ceiling        int,                       -- null = no count cap on this scope
  reserved_nanousd     bigint not null default 0 check (reserved_nanousd >= 0),
  settled_nanousd      bigint not null default 0 check (settled_nanousd  >= 0),
  count_used           int    not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, scope, scope_key, period_kind, period_key)
);
create index on app.spend_counters (tenant_id, period_kind, period_key);
```

`period_kind` no longer offers `rolling24h`. A rolling window has no key, and `period_key` is part of the primary key — the draft specified something unimplementable. The calendar UB day is what a primary key can express and is close enough for a loop detector.

The platform counter lives here too, under a fixed sentinel `tenant_id` (`'00000000-0000-0000-0000-000000000000'`) with `scope='platform'`, so one function enforces every scope. A second code path is how one of them ends up unmaintained.

`spend_counters` is **derived state**: rebuildable in full from `spend_ledger` plus open reservations — which is only true because of the §5.5 rollback fix and the §5.1 period-key rule. That property is why the counter lives in Postgres rather than Redis: a Redis flush would silently reset a tenant's month to zero with no record to rebuild from.

### 5.2.4 `app.inbound_messages` — single-flight, and the marker that is not the reply

The draft conflated two different facts under one unique constraint: *seen* and *answered*. The ancestor is unambiguous — `isAlreadyHandled(mid)` is **checked** at `lib/messengerProcess.js:38` but `markHandled(mid)` is only **written** at `:116`, after the send at `:115`. The draft wrote the marker at check time, which silently disables every legitimate retry.

```sql
create table app.inbound_messages (
  tenant_id           uuid not null references app.tenants(id),
  provider_message_id text not null,          -- Meta mid, or comment value.id
  channel             text not null,
  conversation_id     uuid,
  contact_ref         text,                   -- hashed PSID/IGSID, never the raw id
  attempts            int  not null default 1,
  lease_until         timestamptz not null,   -- single-flight lease
  replied_at          timestamptz,            -- set AFTER the send lands
  reply_kind          text,                   -- 'model'|'shortcut'|'canned'|'notice'|'none'
  received_at         timestamptz not null default now(),
  primary key (tenant_id, provider_message_id),
  foreign key (tenant_id, conversation_id)
    references app.conversations (tenant_id, id)
);
```

Step 5 of §5.4 is a lease acquisition, not a marker write:

```sql
insert into app.inbound_messages
  (tenant_id, provider_message_id, channel, conversation_id, contact_ref, lease_until)
values ($1,$2,$3,$4,$5, now() + interval '90 seconds')
on conflict (tenant_id, provider_message_id) do update
   set attempts    = app.inbound_messages.attempts + 1,
       lease_until = now() + interval '90 seconds'
 where app.inbound_messages.replied_at is null
   and app.inbound_messages.lease_until < now()
returning attempts;
```

Zero rows means either *already answered* or *another worker holds the lease* — stop, no error. A row means this worker owns attempt N. This is what makes two concurrent deliveries of the same `mid` incapable of both generating, without Redis. `replied_at` is set after the send, exactly as the ancestor does.

### 5.2.5 `app.spend_reservations` — the pre-flight hold, one per *attempt*

```sql
create table app.spend_reservations (
  id                uuid   primary key default gen_random_uuid(),
  tenant_id         uuid   not null references app.tenants(id),
  idem_root         text   not null,      -- '{tenant}:{provider_message_id}:{step}'
  attempt           int    not null check (attempt >= 1),
  idem_key          text   not null,      -- idem_root || ':a' || attempt
  surface           text   not null,
  channel           text,
  provider          text   not null,
  model             text   not null,
  price_id          bigint not null references app.model_prices(id),
  estimate_nanousd  bigint not null check (estimate_nanousd > 0),
  estimate_basis    jsonb  not null,      -- the inputs to the upper bound, for post-hoc audit
  scopes_held       jsonb  not null,      -- the exact counter rows bumped, IN CANONICAL LOCK ORDER
  conversation_id   uuid,
  contact_ref       text,
  state             text   not null default 'open'
    check (state in ('open','settled','orphaned')),
  provider_call_started_at timestamptz,   -- the compare-and-swap gate
  provider_request_id      text,
  period_day        date   not null,
  period_month      text   not null,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz,
  unique (tenant_id, idem_key),
  foreign key (tenant_id, conversation_id)
    references app.conversations (tenant_id, id)   -- composite FK: cannot cross tenants
);
create index on app.spend_reservations (state, created_at) where state = 'open';
create index on app.spend_reservations (tenant_id, idem_root);
```

Three columns carry the weight:

- **`attempt` / `idem_key`.** Every provider call that actually happens gets its own hold and its own ledger row. The draft's single key per message made a legitimate retry either impossible or unmetered; see §5.4 for why neither extreme is acceptable.
- **`provider_call_started_at`.** The gate. See §5.4 step 9a.
- **`scopes_held`.** Settlement must decrement **exactly the counters the reservation incremented**, in the **same order**. If the settler recomputed which counters apply, a day boundary crossed between reserve and settle would decrement a different row than was incremented and leak budget in both directions; if it visited them in a different order, reserve and settle would deadlock against each other. Recording the scopes in canonical order at reserve time removes both classes.

### 5.2.6 `app.spend_ledger` — the record

```sql
create table app.spend_ledger (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid   not null references app.tenants(id),
  reservation_id     uuid   not null references app.spend_reservations(id),
  idem_key           text   not null,

  surface            text   not null
    check (surface in ('reception','analytics','quality','care','onboarding','platform')),
  channel            text
    check (channel is null or channel in
      ('messenger','instagram','fb_comment','ig_comment','sms','dashboard','batch')),
  provider           text   not null,
  model              text   not null,
  price_id           bigint not null references app.model_prices(id),
  model_mismatch     boolean not null default false,   -- model called <> model reserved

  unit_kind          text   not null,
  input_tokens       int    not null default 0,
  output_tokens      int    not null default 0,
  cache_read_tokens  int    not null default 0,
  cache_write_tokens int    not null default 0,
  units              numeric,                   -- non-token providers: chars, seconds, messages

  cost_nanousd       bigint not null,
  fx_mnt_per_usd     numeric(10,4) not null,    -- snapshot, so the MNT figure never moves
  cost_mnt           numeric(14,2) not null,

  estimated          boolean not null default false,  -- true = booked at the reservation estimate
  correction_of      bigint references app.spend_ledger(id),

  request_id         text,                      -- provider `request-id` response header
  conversation_id    uuid,
  contact_ref        text,
  period_day         date   not null,           -- COPIED from the reservation
  period_month       text   not null,           -- COPIED from the reservation
  occurred_at        timestamptz not null default now(),

  unique (tenant_id, idem_key, correction_of),  -- one primary row + at most one correction
  check (cost_nanousd >= 0 or correction_of is not null),
  foreign key (tenant_id, conversation_id)
    references app.conversations (tenant_id, id)
);

create index on app.spend_ledger (tenant_id, period_month);
create index on app.spend_ledger (tenant_id, period_day, surface);
create index on app.spend_ledger (occurred_at) where estimated;
```

Note the unique is on `(tenant_id, idem_key, correction_of)`, not `(tenant_id, idem_key)`. The draft's two-column unique is what made a late settlement after an orphan sweep a permanent, unresolvable dead-letter (§5.12). A correction row shares the idem key and is distinguished by pointing at the row it corrects; `correction_of is null` selects primary rows. In Postgres, nulls are distinct in a unique index, so at most one primary row exists per key — which is the constraint that matters.

**The ledger is append-only, and that is enforced in the ACL, not by convention.**

```sql
revoke all on app.spend_ledger from anon, authenticated, service_role;
grant  select, insert on app.spend_ledger to service_role;
grant  select on app.spend_ledger to app_founder_ro;
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and (PG17) MAINTAIN are all withheld.
```

`TRUNCATE` is called out explicitly because it bypasses RLS entirely — no policy stops it and `revoke insert, update, delete` does not cover it. Verify with `aclexplode(coalesce(relacl, acldefault('r', relowner)))` — never `information_schema.role_table_grants`, which is permission-filtered and returns empty silently — and verify **each table independently**, because the last failure next door was partial, one of four.

### 5.2.7 `app.fx_rates`, `app.job_runs`, `app.ledger_deadletter`, `app.alerts`

```sql
create table app.fx_rates (
  as_of        date primary key,
  mnt_per_usd  numeric(10,4) not null check (mnt_per_usd > 0),
  source       text not null            -- 'bank of mongolia mid-rate' + who entered it
);

-- One row per scheduled/manual job run. The unique is what stops a cron
-- double-fire and a concurrent manual re-run from both executing.
create table app.job_runs (
  job          text not null,
  period_key   text not null,           -- '2026-08' for the monthly analytics run
  run_id       uuid not null default gen_random_uuid(),
  forced       boolean not null default false,
  started_by   text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  outcome      text,                    -- 'ok' | 'refused_budget' | 'partial' | 'error'
  cost_nanousd bigint,
  primary key (job, period_key, forced, run_id)
);
create unique index job_runs_one_unforced on app.job_runs (job, period_key) where not forced;
```

`app.ledger_deadletter` holds the full settlement payload (reservation id, usage json, request id, model) plus `attempts` and `last_error`, so a failed settle is reconstructable from the database as well as from a structured log line. `app.alerts` is in §5.9.

---

## 5.3 How cost is computed

Settled cost, from real usage counts returned by the provider — never an estimate, never re-derived from character counts:

```ts
function costNanoUsd(p: PriceRow, u: AnthropicUsage): bigint {
  return (
      BigInt(u.input_tokens               ?? 0) * p.input_nanousd_per_munit
    + BigInt(u.output_tokens              ?? 0) * p.output_nanousd_per_munit
    + BigInt(u.cache_read_input_tokens    ?? 0) * p.cache_read_nanousd_per_munit
    + BigInt(u.cache_creation_input_tokens?? 0) * p.cache_write_nanousd_per_munit
  ) / 1_000_000n
}
```

Three details:

1. **`input_tokens` from Anthropic excludes cached tokens.** They are reported separately in `cache_read_input_tokens` and `cache_creation_input_tokens`. Adding all four at their own prices is correct; adding `input_tokens` at the full rate *and* the cache fields would double-count, and using only `input_tokens` would under-report by ~80% on a cached Reception reply. The ancestor already logs all three separately (`lib/salonBrain.js:249-253`) — it just discards them.
2. **`u.field ?? 0` is safe here and only here**, because a missing usage field on a *successful* response means the model did not use that mode. The same `?? 0` on a *ceiling* read is the bug this section exists to prevent. The distinction: this value is being recorded, not being used to authorise the next spend.
3. **If `usage` is absent or unparsable from a 2xx, the call settles at the reservation estimate with `estimated = true`.** Never at zero. A response we cannot price is one we must assume cost the maximum we reserved for it.

**Reception AI does not stream.** A Messenger reply is capped to one atomic Send call anyway (`lib/messengerText.js` / `lib/messengerProcess.js:96-99`), so streaming buys nothing and introduces a case — a disconnected stream that billed for tokens generated but returned no final `usage` — with no clean settlement. Surfaces that do stream settle at the estimate with `estimated = true` on a disconnect; that is a strictly worse accounting outcome and is the reason Reception avoids it.

### The estimate — an upper bound, not a projection

```ts
function estimateNanoUsd(plan: CallPlan, p: PriceRow): bigint {
  const prefix = plan.systemPromptTokens          // measured once per prompt version
  const cacheable = p.min_cacheable_prefix_tokens != null
                 && prefix >= p.min_cacheable_prefix_tokens

  // PESSIMISTIC ON EVERY AXIS.
  // Prefix: assume a cache WRITE (1.25x), never a read (0.1x). A miss is the
  // expensive branch and we cannot know before the call which we will get.
  const prefixCost = cacheable
    ? BigInt(prefix) * p.cache_write_nanousd_per_munit
    : BigInt(prefix) * p.input_nanousd_per_munit

  // Variable input (history + this message): bound by UTF-8 BYTES, not chars/4.
  // Mongolian Cyrillic is 2 bytes/char and is poorly represented in BPE
  // vocabularies; the Latin chars/4 rule of thumb under-reserves. Bytes is the
  // worst case even under byte-level fallback.
  const varCost = BigInt(plan.variableBytes) * p.input_nanousd_per_munit

  // Output: max_tokens is a parameter WE set, so this is a genuine hard bound.
  const outCost = BigInt(plan.maxTokens) * p.output_nanousd_per_munit

  return (prefixCost + varCost + outCost) / 1_000_000n
}
```

`systemPromptTokens` is measured **once per `(tenant_id, prompt_version)`** with `/v1/messages/count_tokens` and stored on `app.tenant_prompt_versions`. If the count is missing for a version, the call is refused (`503 prompt_not_measured`) — the KB publish step is where that gets fixed, not the customer's message.

**That measurement is itself a provider call, and it goes through the ledger.** A KB edit bumps `prompt_version`, and the Quality layer's approve→publish cycle drives KB edits by design, so the trigger is tenant-controlled. It runs through `withTenantSpend()` on the `onboarding` surface with a count-only reservation (amount 0, count 1) and lands in the ledger. No CI exemption: an exemption inside the guard that enforces "no unmetered provider calls" is the hole the guard exists to close. *(Assumption flagged: that `count_tokens` is billed at $0. It is certainly rate-limited, and a rate limit consumed outside the ledger is invisible to every control here — which is reason enough to meter it by count even if the dollar amount is zero.)*

*Verified by running it:* `buildSystemPrompt(clientData)` is **7,824 characters / 12,866 UTF-8 bytes**, plus a 3,163-character `MESSENGER_ADDENDUM` (`lib/salonBrain.js:86-106`). *Not verified:* its token count. Nobody has ever measured it, though the number is printed in production on every reply (`lib/salonBrain.js:249-253`). Everything numeric in §5.6 uses a planning figure of **7,000 tokens** and is labelled as such.

### The invariant, and the four ways to break it

Because the estimate bounds every component from above, the reservation is taken *before* the call against `reserved + settled + amount ≤ ceiling`, and settlement can only *reduce* the held amount:

> Settled spend can never exceed the ceiling. It can only undershoot it.

There are four ways to break that, and each is closed:

| Break | Closed by |
|---|---|
| An estimate that is not an upper bound | Pessimistic on every axis; `max_tokens` at the call site comes from the same constant the estimator reads, asserted in CI |
| Extended thinking exceeding `max_tokens` | **Reception AI does not use extended thinking.** A salon price question does not need it, and until it is verified that adaptive thinking output is bounded by `max_tokens`, using it would void the bound. Quality/Analytics may use it with a correspondingly larger reservation. *(Assumption flagged for verification.)* |
| **A model substituted at the call site** — e.g. an overload fallback from Sonnet 5 to Opus 5, which bills at 2.5× the hold | `settle_spend` compares the model actually used against `spend_reservations.model`. A mismatch still writes a truthful ledger row (priced from the *actual* model's current row, `model_mismatch = true`) and fires a 🔴 — truth in the ledger beats a clean invariant — and the CI guard asserts the model id, alongside `max_tokens`, comes from the reserved plan. The invariant therefore reads: *settled spend cannot exceed the ceiling unless a call site substitutes a model, and that case is loud.* |
| Releasing an orphaned reservation | Orphans are **never released** — they convert to `estimated = true` spend (§5.12) |

**Holds are larger than actuals, and that is the price of a hard ceiling.** At the §5.6 planning figures a Reception hold is ≈$0.030 while a blended actual reply is ≈$0.0083. So momentary headroom is ~$0.03 lower per in-flight call, and a tenant can be refused at the ceiling by *held* budget while its *settled* total is well under. Holds release in seconds, so at salon traffic this is invisible; it is written down so nobody discovers it as a mystery.

---

## 5.4 The order of operations

A ceiling checked after the call is not a ceiling. Money steps in bold; nothing costs anything until step 9b.

```
 1. Webhook receives POST. Read RAW BYTES first (lib/rawBody.js pattern) —
    HMAC is over the exact bytes Meta signed.
 2. Verify X-Hub-Signature-256, constant-time, fail closed on a missing secret.
    (lib/messengerClient.js:25-42 — carry verbatim.)
 3. Persist the raw entry to app.webhook_events. ACK 200 IMMEDIATELY.
    Everything below runs in the worker. A slow 200 gets the Page unsubscribed
    after ~1h — this is the one path that fails OPEN (§5.8).

    ---- worker, per entry, per messaging event ----

 4. TENANT. Resolve (object, entry[].id) -> tenant_id through channel_identity.
    Server-side, exact match, PK-enforced. No match => 200 + drop + alert.
    NEVER a default tenant. NEVER a tenant hint from the body.
 5. SINGLE-FLIGHT + ATTEMPT. The lease upsert of §5.2.4. Zero rows => stop
    (already answered, or another worker owns it). A row yields `attempt`.
    Any error OTHER than "no rows" => idempotency_unavailable, 503, fail closed.
 6. FREE GATES, in order, cheapest first:
      a. tenant status suspended/offboarded    -> stop, send nothing
      b. deterministic shortcut (location / greeting / hours) -> answer, cost 0
      c. private-reply 7-day deadline, if a comment -> expired: stop
      d. refusal-topic match (children's prices) -> verbatim canned reply, cost 0
    Any of b/d sets replied_at after the send and finishes here.
 7. PLAN. model, prompt version, systemPromptTokens, max_tokens, variableBytes.
    Look up the CURRENT price row. No row => 503 price_unknown, stop.
 8. **RESERVE.** app.reserve_spend(..., idem_root, attempt, compiled caps, ...)
    ONE round trip, atomic, all scopes. Verdict is one of:
      allowed | exceeded | not_provisioned | suspended | attempts_exhausted
      | already_reserved
    Only `allowed` continues. An EXCEPTION is `reserve_unavailable`, NOT
    `continue` (§5.8).
 9a. **CLAIM THE CALL.**
      update app.spend_reservations set provider_call_started_at = now()
       where id = $1 and state = 'open' and provider_call_started_at is null
      returning id;
     Zero rows => `indeterminate`: somebody already made this call. DO NOT CALL.
     Dead-letter, let the sweeper settle it. This is the gate, not step 8.
 9b. CALL ANTHROPIC. Capture `usage` and the `request-id` response header.
10. **SETTLE.** app.settle_spend(reservation_id, model, usage, request_id) in ONE
    transaction: insert the ledger row, decrement reserved, increment settled,
    set state='settled'. If this write fails, the spend already happened:
    dead-letter it (§5.12). NEVER release the reservation.
11. Send the reply via the Graph API (free, but rate-limited per Page).
12. Set inbound_messages.replied_at AFTER the send lands — carry
    lib/messengerProcess.js:115-116 exactly.
```

### Why `already_reserved` is not permission to call

Both critiques found this and they were right: the draft said *"anything but `allowed` or `already_reserved`: DO NOT CALL THE MODEL"*, which makes every re-arrival a second Anthropic call recorded as one ledger row. The unique constraint prevented a duplicate *row*, not a duplicate *charge* — it was hiding the overspend, not preventing it. On the Analytics path, where the only re-arrival gate is the founder pressing the button again, twenty debugging re-runs would have been $8 spent and $0.40 recorded, with every ceiling reporting green.

**The two critiques proposed opposite fixes and I take neither extreme.** One said "make each attempt its own hold so retries stay metered"; the other said "an open reservation means the outcome is unknown, so never call again — dead-letter it." Never calling again loses the customer's reply on the single most common partial failure in the system, which is the harm the same critique identified two findings earlier. The resolution is:

- **`attempt` is part of the idem key**, so every provider call that actually happens has its own hold, its own ledger row, and its own place in the ceiling. Retries stay honest instead of invisible.
- **`reserve_spend` refuses beyond `max_attempts`** for an `idem_root` — Reception gets **2 generations**, after which the QStash retry sends the canned fallback with no model call. That also fixes the ancestor's four-generations-on-a-permanent-401 burn (`lib/messengerProcess.js:101-105`), independently of the retryable/terminal classification.
- **The compare-and-swap at 9a is the actual gate**, not the reservation verdict. `already_reserved` now means only "two deliveries of the same attempt raced"; the CAS resolves it, and exactly one of them calls.
- **Duplicate-*reply* suppression is at the send step**, via `replied_at` — but the critique's version of that fix, on its own, would let two concurrent workers both generate. The §5.2.4 lease is required as well.

### Two orderings that deserve their own note

**Single-flight before reservation (5 before 8).** If reservation came first, a duplicate delivery would take a second hold, and even though the ledger unique would stop a second charge, the hold would sit open until the sweeper converted it to estimated spend — a duplicate delivery consuming real budget for a call that never happened. Meta webhooks are at-least-once and QStash retries three times (`lib/messengerQueue.js:13`, with the attempt number on the `Upstash-Retried` header, `api/messenger-worker.js:67-68`); duplicates are the normal case.

**Free gates before reservation (6 before 8).** A location question, a greeting, a canned refusal and an expired private-reply window all cost zero and must keep working when the budget is spent. The ancestor already has this structure (`lib/messengerProcess.js:53-91`), and it becomes the degradation ladder in §5.7.

---

## 5.5 The race, and what solving it costs

**The race.** Two customers message Matrix Eco Salon in the same second. The tenant has $0.004 of daily budget left; each reply holds $0.030 worst case. Both workers read the counter, both see room, both call Anthropic. Classic check-then-act — and not hypothetical: `api/messenger.js:114-116` fans out with `Promise.allSettled` over every event in one webhook, and one POST can carry several.

**The solution: a single atomic conditional UPDATE per counter, inside `SECURITY DEFINER` functions, in Postgres.** Three things the draft got wrong are fixed here.

```sql
-- Raises DA001 (over ceiling) or DA002 (row vanished). Never returns a verdict:
-- a plpgsql function that RETURNS commits, and the draft's version therefore
-- committed the platform increment even when the tenant scope refused.
create or replace function app.bump_counter(
  p_tenant uuid, p_scope text, p_scope_key text,
  p_period_kind text, p_period_key text,
  p_ceiling_nanousd bigint,      -- resolved INSIDE reserve_spend, never by the app
  p_count_ceiling int,
  p_amount_nanousd bigint,
  p_count int
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_held bigint;
begin
  -- The counter row is DERIVED state, so creating it here is safe and race-free.
  -- The tenant's POLICY row is not — a missing policy refuses in reserve_spend.
  -- `do update` refreshes the ceiling every call, so what is DISPLAYED (digest,
  -- soft threshold, alert denominator) is always what is ENFORCED.
  insert into app.spend_counters
    (tenant_id, scope, scope_key, period_kind, period_key, ceiling_nanousd, count_ceiling)
  values (p_tenant, p_scope, p_scope_key, p_period_kind, p_period_key,
          p_ceiling_nanousd, p_count_ceiling)
  on conflict (tenant_id, scope, scope_key, period_kind, period_key)
  do update set ceiling_nanousd = excluded.ceiling_nanousd,
                count_ceiling   = excluded.count_ceiling;

  update app.spend_counters
     set reserved_nanousd = reserved_nanousd + p_amount_nanousd,
         count_used       = count_used + p_count,
         updated_at       = now()
   where tenant_id = p_tenant and scope = p_scope and scope_key = p_scope_key
     and period_kind = p_period_kind and period_key = p_period_key
     and reserved_nanousd + settled_nanousd + p_amount_nanousd <= ceiling_nanousd
     and (count_ceiling is null or count_used + p_count <= count_ceiling)
  returning reserved_nanousd + settled_nanousd into v_held;

  if v_held is not null then return v_held; end if;

  -- ZERO ROWS UPDATED IS AMBIGUOUS: EITHER "over ceiling" OR "the row is gone".
  -- Treating it as the former would silently mask the latter — a plausible
  -- answer instead of an error, the exact failure class this architecture is
  -- built against. Distinguish them explicitly, on different SQLSTATEs.
  perform 1 from app.spend_counters
   where tenant_id = p_tenant and scope = p_scope and scope_key = p_scope_key
     and period_kind = p_period_kind and period_key = p_period_key;
  if not found then
    raise exception 'counter_row_missing scope=% key=% period=%',
      p_scope, p_scope_key, p_period_key using errcode = 'DA002';
  end if;
  raise exception 'ceiling_exceeded scope=% key=%', p_scope, p_scope_key
    using errcode = 'DA001';
end $$;

revoke execute on function app.bump_counter from public, anon, authenticated;
grant  execute on function app.bump_counter to service_role;
```

`set search_path = ''` is mandatory on every `SECURITY DEFINER` function; without it the function is a privilege-escalation primitive.

**Fix 1 — the ceiling is no longer a caller-supplied parameter.** `reserve_spend` reads `app.tenant_budget_current` **inside its own transaction** and computes the ceilings itself. The application may pass only the *compiled* caps, and those can only lower:

```sql
create or replace function app.reserve_spend(
  p_tenant uuid, p_surface text, p_channel text,
  p_idem_root text, p_attempt int, p_max_attempts int,
  p_provider text, p_model text, p_price_id bigint,
  p_estimate_nanousd bigint, p_estimate_basis jsonb,
  p_conversation_id uuid, p_contact_ref text,
  p_period_day date, p_period_month text,
  p_compiled_surface_day_cap_nanousd  bigint,   -- NOT NULL. From code. May only lower.
  p_compiled_platform_day_cap_nanousd bigint    -- NOT NULL. From code. May only lower.
) returns table (verdict text, reservation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  b record; v_id uuid; v_used int; v_key text;
begin
  if p_compiled_surface_day_cap_nanousd is null
     or p_compiled_platform_day_cap_nanousd is null then
    raise exception 'compiled_cap_missing' using errcode = 'DA003';
  end if;

  select * into b from app.tenant_budget_current where tenant_id = p_tenant;
  if not found then return query select 'not_provisioned', null::uuid; return; end if;
  if b.status in ('suspended','offboarded') then
    return query select 'suspended', null::uuid; return;
  end if;

  select count(*) into v_used from app.spend_reservations
   where tenant_id = p_tenant and idem_root = p_idem_root;
  if v_used >= p_max_attempts then
    return query select 'attempts_exhausted', null::uuid; return;
  end if;

  v_key := p_idem_root || ':a' || p_attempt;

  begin      -- sub-block == implicit savepoint. A DA001 anywhere rolls back
             -- the reservation insert AND every counter bump already made.
    insert into app.spend_reservations
      (tenant_id, idem_root, attempt, idem_key, surface, channel, provider, model,
       price_id, estimate_nanousd, estimate_basis, scopes_held, conversation_id,
       contact_ref, period_day, period_month)
    values (p_tenant, p_idem_root, p_attempt, v_key, p_surface, p_channel,
            p_provider, p_model, p_price_id, p_estimate_nanousd, p_estimate_basis,
            app.canonical_scopes(p_tenant, p_surface, p_conversation_id,
                                 p_contact_ref, p_period_day, p_period_month),
            p_conversation_id, p_contact_ref, p_period_day, p_period_month)
    on conflict (tenant_id, idem_key) do nothing
    returning id into v_id;

    if v_id is null then
      return query select 'already_reserved',
        (select id from app.spend_reservations
          where tenant_id = p_tenant and idem_key = v_key);
      return;
    end if;

    -- CANONICAL LOCK ORDER: narrowest first, PLATFORM LAST.
    -- Count-only scopes carry ceiling 0 and amount 0 (0+0+0 <= 0 passes);
    -- the count condition is what binds there.
    perform app.bump_counter(p_tenant,'conversation', p_conversation_id::text,
              'day', p_period_day::text, 0, b.conversation_reply_cap, 0, 1);
    perform app.bump_counter(p_tenant,'contact', p_contact_ref,
              'day', p_period_day::text, 0, b.contact_daily_reply_cap, 0, 1);
    perform app.bump_counter(p_tenant,'surface', p_surface,
              'day', p_period_day::text,
              p_compiled_surface_day_cap_nanousd, null, p_estimate_nanousd, 0);
    perform app.bump_counter(p_tenant,'surface', p_surface,
              'month', p_period_month,
              floor(b.monthly_ceiling_nanousd
                    * coalesce((b.surface_month_fraction->>p_surface)::numeric, 0))::bigint,
              null, p_estimate_nanousd, 0);
    perform app.bump_counter(p_tenant,'tenant','', 'day', p_period_day::text,
              b.daily_ceiling_nanousd,   null, p_estimate_nanousd, 0);
    perform app.bump_counter(p_tenant,'tenant','', 'month', p_period_month,
              b.monthly_ceiling_nanousd, null, p_estimate_nanousd, 0);
    perform app.bump_counter(app.platform_tenant(), 'platform','', 'day',
              p_period_day::text,
              least(app.platform_daily_ceiling(), p_compiled_platform_day_cap_nanousd),
              null, p_estimate_nanousd, 0);
    perform app.bump_counter(app.platform_tenant(), 'platform','', 'month',
              p_period_month, app.platform_monthly_ceiling(), null,
              p_estimate_nanousd, 0);

  exception when sqlstate 'DA001' then
    return query select 'exceeded', null::uuid; return;
    -- DA002 (counter_row_missing) and DA003 deliberately ESCAPE, so the caller
    -- sees an exception and maps it to reserve_unavailable -> 503.
  end;

  return query select 'allowed', v_id;
end $$;
```

**Fix 2 — a refusal rolls everything back.** The draft's `bump_counter` returned `(false, held)` on the over-ceiling branch, so the transaction committed. With platform first, every refused message permanently consumed platform budget for a call that never happened, there was no reservation row for the sweeper to reclaim, and — since a tenant sitting at its ceiling is the *normal* end state — ~810 refused messages would have driven the $17 platform daily ceiling to zero and taken GS Auto Center, at 16% of its own budget, to state 2. The sub-block turns a refusal into a subtransaction rollback.

**Fix 3 — platform is locked LAST.** The draft locked the one globally shared row first and held it across four further updates and an insert, so every reservation for every tenant queued behind a single row. The written-down contention limit was the wrong one: the binding constraint was per-deployment, not per-tenant, and the offered remedy (shard `scope_key`) is tenant-shaped and would not have helped. Narrowest-first, platform-last gives the same atomicity with the shortest hold on the hottest row.

**And settle uses the same order.** `scopes_held` is stored as a JSON array already in canonical order (`app.canonical_scopes()` builds it), and `settle_spend` iterates it in array order. Reserve and settle obtaining counter locks in different orders is a textbook deadlock that would surface as random `40P01` → `reserve_unavailable` → 503 → customers getting the handoff line for no reason.

**Why the conditional UPDATE is correct.** It takes a row-level lock. A second concurrent transaction touching the same counter blocks until the first commits, then re-evaluates its `WHERE` against the *committed* value. There is no window in which both see the same balance. Postgres gives this for free in READ COMMITTED; no advisory lock, no `SERIALIZABLE`, no retry loop.

### What we traded

| Option | Verdict |
|---|---|
| **Postgres conditional UPDATE** (chosen) | One source of truth. Counters rebuildable from the ledger by summation, so an eviction or restart cannot silently zero a tenant's month. Atomic without extra machinery. Costs one round trip (~30-60ms Vercel→Supabase same region) in front of a 2-8 second call — under 2% of latency. |
| **Redis `INCRBY` + Lua** | Faster (~10ms) and Upstash is already in the stack. **Rejected**: no durable record, so a flush, an eviction or a plan change resets the counter to zero and a tenant gets a free month with no way to detect it. Rebuilding from Postgres on a cache miss re-introduces exactly one read whose "missing" must not read as "zero" — `count ?? 0` in the one place it must never appear. The sibling's ceilings are Redis-only (`checkAiDailyLimit`, `src/lib/rateLimit.ts`); this is where Dala AI deliberately diverges. |
| **Advisory lock around read-modify-write** | Three round trips and a lock you must remember to release, for the same guarantee. |
| **Optimistic version column + retry** | More code, more failure modes, no benefit at this concurrency. |

Remaining real limit: all spend for one tenant in one period serialises on one counter row. At tens of messages an hour that is invisible; at hundreds per second for one tenant it is a hot row, and the fix then is period-sharding (`scope_key` gets a shard suffix, ceiling divided N ways, summed on read). The platform row, if it ever contends, shards into N fixed shards with `ceiling/N`.

Redis still has jobs — per-minute burst limiting, the Meta per-Page token bucket, conversation history, alert dedupe. It never decides whether money may be spent.

---

## 5.6 The tiers of ceiling

Six layers. Each catches a different failure; none is redundant.

| # | Ceiling | Catches |
|---|---|---|
| 1 | **Platform monthly / daily** | Per-tenant accounting broken: a misidentified tenant, spend attributed to no tenant, a bug in the reserve path |
| 2 | **Tenant monthly** | This tenant has become unprofitable; a slow leak |
| 3 | **Tenant daily** | A runaway, caught within hours instead of within a month |
| 4 | **Tenant × surface** (monthly fraction; daily compiled cap) | A Quality or Analytics batch eating Reception's budget |
| 5 | **Per-conversation reply cap (count)** | A loop; the bot answering itself; one customer in an infinite thread |
| 6 | **Per-contact daily reply cap (count)** | A single abusive end customer, or a script pointed at the Page |

**Tiers 5 and 6 are now actually enforced.** In the draft they had columns (`count_used`, `count_ceiling`) that `bump_counter` never touched, so the only thing implementing them was prose — and they are the *only* control sized for the failure they exist for. The scenario: the bot answers its own outbound message. The ancestor guards this three ways (`api/messenger.js:169-173` — `is_echo`, delivery/read receipts, sender-is-the-Page), but all three are *filters*, none is a *meter*, and on Instagram echoes are load-bearing for routing so the filter cannot simply be tightened. With only dollar ceilings, ~600 replies land before anything refuses. With the per-conversation count cap, 25 do. `bump_counter` now carries `p_count` alongside `p_amount_nanousd`, both conditions in the same `WHERE`, one row lock covering both.

**Counts are never decremented** — not on settle, not on orphan sweep. A reply happened; the count is a record of that.

### Deriving the numbers

Per-reply cost at the planning figure of a **7,000-token** cached Mongolian system prompt (character count measured, token count not — §5.3), ~600 tokens of variable input, ~250 output tokens on **Sonnet 5** ($2.00 / $10.00 per MTok):

| | cache hit | cache miss (write) |
|---|---:|---:|
| prefix | 7,000 × $0.20/M = **$0.00140** | 7,000 × $2.50/M = **$0.01750** |
| variable input | 600 × $2.00/M = $0.00120 | $0.00120 |
| output | 250 × $10.00/M = $0.00250 | $0.00250 |
| **per reply** | **$0.0051** | **$0.0212** |
| | ≈ **₮17.9** | ≈ **₮74.2** |

Blended at 20% miss: **≈ $0.0083/reply ≈ ₮29**. The *hold* is larger — cache write + 1,200 variable bytes + `MAX_TOKENS = 1024` (`lib/salonBrain.js:20`) at output price ≈ **$0.030**.

FX: **₮3,500/USD** throughout, labelled as a *planning* rate and an **assumption**; the live figure comes from `app.fx_rates`. Volume, also an assumption and the one most worth checking against Matrix's actual Page: **300-600 inbound conversations/month, ~5 model replies each** = 1,500-3,000 replies = **$12-25/month ≈ ₮42,000-88,000** per salon.

### The formula that should set the monthly ceiling

Not expected usage — the margin floor, the spend level at which serving this tenant stops being worth doing:

```
monthly_ceiling_usd = (subscription_price_mnt × (1 − target_gross_margin)) / fx_mnt_per_usd
```

At ₮250,000/month and a 70% target margin: `250,000 × 0.30 / 3,500` = **$21.43/month**. That is *below* the top of the expected range, which is exactly the signal a ceiling should give: at 600 conversations a month this tenant needs a bigger plan, and the ceiling tells you rather than the Anthropic invoice. **The subscription price and the target margin are the founder's call; the formula is not.**

### Starting numbers — founder's call, every one of them

| Ceiling | USD | MNT (@3,500) | Reasoning |
|---|---:|---:|---|
| **Tenant monthly** | **$25** | ₮87,500 | ~1.3× the expected busy month; ≈70% margin at a ₮250k plan. Trips only on real growth or a leak. |
| **Tenant daily** | **$3** | ₮10,500 | 3.6× an average day ($25/30 = $0.83). The real runaway control: caps a loop at $3/day, not $25/hour. Three consecutive daily trips = a plan conversation. |
| **Surface fraction (monthly)** | reception 80% / analytics 10% / quality 10% / care 0% | — | Care is **0** until the SIP trunk exists and a per-message price is known — an unknown price refuses, it does not default to zero. |
| **Per-conversation replies / UB day** | **25** | — | A salon conversation is 3-8 turns. 25 is ~3× the tail; beyond it is unmistakably a loop or an abuser. |
| **Per-contact replies / UB day** | **40** | — | A genuine customer re-engaging several times stays well under; a script does not. Keyed on a **hashed** PSID/IGSID (page-scoped stable person identifiers — PII). |
| **Platform monthly** | **$120** | ₮420,000 | `1.25 × Σ(tenant monthly) + $20` = 1.25 × $50 + $20 at two tenants. Deliberately *above* the sum so it binds **only when per-tenant accounting has failed** — its entire purpose. Recomputed at each onboarding, in the database, as config. |
| **Platform daily** | **$17** | ₮59,500 | `1.25 × Σ(tenant daily) + $5` = 1.25 × $6 + $5. |

### The two controls that do not depend on any read

Everything above is a database read, and this document's founding lesson is that the read can lie.

**(a) Compiled caps.** Carried from `BANK_BUILD_BUDGET_USD` (`src/lib/quizBank.ts:68`, refused at `:433-438` *before an Anthropic client is constructed*):

```ts
// src/lib/spend/caps.ts
// PER TENANT, PER SURFACE, PER UB DAY. A stop no query, cache, table or
// credential can change. Effective ceiling = min(this, the DB value): the DB
// can only ever LOWER. Raising any of these is a spending decision — say who
// approved it in the commit.
export const SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY = {
  reception:  8,
  analytics:  5,
  quality:    5,
  care:       0,   // ZERO until the SIP trunk exists and per-message price is known
} as const

// PLATFORM-WIDE, PER UB DAY. NOT derived from the tenant count — it is an
// absolute "we would never intend to spend more than this in a day, full stop"
// figure, reviewed quarterly. Deriving it from tenant count would make every
// onboarding a code change, which fails the config test.
export const PLATFORM_HARD_CAP_USD_PER_DAY = 50
```

**Objection answered.** One critique could not tell whether the per-surface compiled cap is per-tenant or platform-wide, and argued that if it is per-tenant then $8/day sitting above the $3 DB daily ceiling makes it decoration. It is per-tenant, and sitting above the DB ceiling is precisely its job: it binds **only when the DB ceiling read is wrong** — a stale row, a misparsed JSON fraction, a `?? Infinity` somebody wrote for a local test. A control that binds in normal operation is a second daily ceiling; a control that binds only when the first one is broken is the one that survives a total logic failure. The platform figure is separated out and made count-independent for the config-test reason above.

**(b) A provider-side spend limit.** Set a hard monthly spend limit **at Anthropic**, on the workspace or key Dala AI uses, at ~1.5× the platform monthly ceiling. It survives a total logic failure in this codebase, costs nothing, and lives outside the repository. *(Assumption flagged: that Anthropic Console supports per-workspace spend limits. If it does not, hold Dala AI's credit balance deliberately small and top it up monthly — same effect.)*

### Two switches, on purpose

| Switch | Direction | Latency | Audit |
|---|---|---|---|
| `app.tenant_budgets` new version / `app.platform_kill_switch` | Can only **lower** | Instant, no deploy | Append-only row with `set_by`, `set_reason`, effective range |
| Compiled caps in `caps.ts` | Can only **cap** | Requires a deploy | Requires a commit naming the approver |

The DB switch exists because at 02:00 you need to stop spend without a deploy. The compiled cap exists because a table row can be changed in a dashboard with no diff, no review and no record — which is exactly why the sibling made its budget a constant.

---

## 5.7 What happens at the ceiling

### The degradation ladder

Reception AI has five states, and the customer only ever sees Mongolian.

| State | Trigger | What the customer gets | Cost |
|---|---|---|---|
| **0 — normal** | under all ceilings | full model reply | metered |
| **1 — soft warn (80%)** | `settled+reserved ≥ 80%` of monthly or daily | **nothing changes.** Founder is told; the customer is not. | metered |
| **2 — zero-cost only** | daily, monthly or platform ceiling reached | deterministic shortcuts still answer (location, greeting, hours); refusal-topic canned replies still answer; the closure message still answers. Anything needing the model gets the budget handoff line, **once per conversation**. | $0 |
| **3 — contact/conversation capped** | per-contact or per-conversation count cap hit | the cap line, once, then ACK-and-drop in silence | $0 |
| **4 — suspended / offboarded** | `tenant_budget_current.status` | nothing sent at all. Inbound events still verified and persisted, so no history is lost. | $0 |

State 2 is the part worth defending. The ancestor's shortcut layer (`lib/messengerProcess.js:53-91`) already answers "where are you" and a first-message greeting with no model call. A salon that can still tell customers its address and hours when the budget is spent is meaningfully alive; one that goes silent is not.

### The Mongolian copy

These are **per-tenant rows** in `app.canned_responses` with `reviewed_by` / `reviewed_at`, because the entire reason the ancestor pins its Mongolian verbatim is that a human checked it (`lib/salonBrain.js:48-51` records the actual failures: garbled phrases and an invented Russian word `дополнительн` in filler positions). The strings below are **seed values for Matrix Eco Salon** and must be re-reviewed by a native speaker before they ship, because they are moving into a new surrounding context. They reuse clauses already native-reviewed in production (`FALLBACK_REPLY`, `lib/salonBrain.js:63-65`).

**`budget_exhausted`** — state 2:

```
Уучлаарай, яг одоо би Танд хариулж чадахгүй байна. 🙏
Манай ажилтан Танд туслахад бэлэн байна. Та 7741-7777 дугаараар холбогдоно уу.
```

**`contact_capped`** — state 3, where the customer is not experiencing an outage and should not be told there is one:

```
Уучлаарай, энэ яриаг үргэлжлүүлэх боломжгүй боллоо.
Та 7741-7777 дугаараар холбогдож лавлана уу.
```

Four properties, of the design rather than the wording:

1. **Never English, never a status code, never silence.** The sibling's `UNAVAILABLE_MESSAGE` (`src/lib/aiRouteGuard.ts:8`) is Mongolian for exactly this reason.
2. **Never mention budgets, quotas, AI, or the bot.** "The salon's AI budget ran out" is a sentence a salon owner never wants a customer to read.
3. **Always a phone number, from the tenant's own config.** `HUMAN_PHONE` is hardcoded at `lib/salonBrain.js:41` *and separately* in `config/currentClient.js:107` in a different format — one fact, two copies. One row, one format, interpolated.
4. **Sent once per conversation, then silence.** **The marker is a Postgres column on the conversation row (`last_notice_kind`, `last_notice_at`), not a Redis key.** The draft put it in Redis with a 24h TTL, and then claimed elsewhere that a Redis outage leaves Reception working normally. It does not: with Redis down, every inbound message in state 2 re-sends the handoff line — the "reads as broken" outcome the design names — and needlessly consumes the Page's Meta send-rate budget. The write is free alongside the conversation turn append.

For GS Auto Center these are different rows with a different phone number and possibly a different register. **No code branch.** That is the config test.

### Soft vs hard

| | Soft (80%) | Hard (100%) |
|---|---|---|
| Customer impact | none | state 2 |
| Founder impact | one Telegram message, once per period | one Telegram message, once per period, marked 🔴 |
| Reversible by | nothing needed | a new `tenant_budgets` version, or the daily reset at UB midnight |
| Logged as | `spend_soft_threshold` | `spend_ceiling_reached` |

The soft threshold is per-period and per-scope: a tenant can be at 82% of month and 40% of day, and only the monthly warning fires. Both are computed from `spend_counters.ceiling_nanousd`, which `bump_counter` refreshes on every call — so after a mid-period ceiling change the alert quotes the number that is actually binding, not a stale copy.

---

## 5.8 Fail closed

Every step in §5.4 refuses on error, each with a distinct code:

```
tenant_unknown          → 200 to Meta, drop, alert.  NEVER a default tenant.
already_answered        → stop, no error.
lease_held              → stop, no error (another worker owns this attempt).
idempotency_unavailable → 503, alert. The lease upsert failed for a reason other
                          than "no rows". NEVER fall through to a reservation
                          with no dedupe in front of it.
tenant_not_provisioned  → 503, alert. NEVER auto-create a budget with a default.
tenant_suspended        → stop, send nothing.
price_unknown           → 503, alert. NEVER price at zero.
prompt_not_measured     → 503, alert. NEVER guess the prefix token count.
attempts_exhausted      → canned fallback, no model call.
budget_exceeded         → state 2 (canned handoff), alert once per period.
indeterminate           → do NOT call, do NOT send; dead-letter, sweeper settles.
reserve_unavailable     → 503, alert. The DB could not be consulted: refuse.
```

**`reserve_unavailable` is the important one.** A thrown exception from `reserve_spend` — including `DA002 counter_row_missing` and `DA003 compiled_cap_missing`, which deliberately escape the sub-block — is *not* a reason to proceed. It is treated identically to `exceeded`.

### The forbidden pattern, named

```ts
// FORBIDDEN. This exact shape was the HIGH finding in the 2026-08-13 audit next
// door, and its own guard documents the consequence: "any error reaching the
// usage table — a DB blip, a service-role hiccup, a unique-violation race in
// ensureRow on a brand-new account — skipped the quota entirely and went
// straight to the paid model call."  (src/lib/aiRouteGuard.ts:71-77)
try { await reserveSpend(...) } catch { /* continue */ }
```

Forbidden here for a reason the sibling did not have: **the money being risked is not only ours.** Failing open spends against the founder's Anthropic account *and* mis-states a tenant's invoice. A 503 costs a retry; failing open costs money that has to be explained to somebody.

CI enforces it. `scripts/check-spend-guard.mjs` fails the build on: a `catch` within N lines of a `reserveSpend` / `settleSpend` / `bumpCounter` call site; any Anthropic/OpenAI/ElevenLabs/Deepgram client constructed outside `withTenantSpend()` (no exemptions — including `count_tokens`); and any call site whose `model` or `max_tokens` does not come from the same plan object the estimator read. Same shape as `scripts/check-supabase-nostore.mjs`, which guards the caching trap offline and in both directions.

### `FAIL_OPEN` — the documented exception list

Modelled on `src/lib/rateLimit.ts:84-114`, and like it, **adding a key is a security decision that must be justified in the comment block.**

```ts
// Default posture is FAIL CLOSED. These are the deliberate exceptions, because
// refusing them causes more harm than the abuse it prevents. NONE carries
// upstream spend — that is the test for membership.
const FAIL_OPEN: ReadonlySet<Step> = new Set([
  // 1. WEBHOOK_ACK. A non-200 to Meta risks the Page being UNSUBSCRIBED after
  //    ~1h of failures — a silent, total, per-tenant outage that surfaces as the
  //    ABSENCE of requests, which nothing alerts on by default. The ack spends
  //    nothing; it only says "received".
  'webhook_ack',

  // 2. INBOUND_PERSIST (app.webhook_events only). Losing the customer's message
  //    is worse than losing the audit row. Note this is NOT the single-flight
  //    lease, which fails CLOSED — the lease is what stops a duplicate charge.
  'inbound_persist',

  // 3. ALERT_DELIVERY. Telegram is a transport, not a control. A failed alert
  //    must never block a reply, a reservation, or a settlement.
  'alert_delivery',

  // 4. FX_SNAPSHOT. A missing app.fx_rates row degrades REPORTING only: the
  //    ledger row is written with the last known rate and flagged. USD cost —
  //    the denomination of every ceiling — is unaffected.
  'fx_snapshot',

  // 5. ANALYTICS_READ. Read-only dashboard queries. No spend.
  'analytics_read',
])
// Everything else fails closed. In particular NOT: the model call, the SMS send,
// the comment private reply, the single-flight lease, the reservation, the
// provider-call CAS, or the settlement.
```

The sibling's list includes QPay routes because a customer who has already paid must still receive their code (`src/lib/rateLimit.ts:91-95`). Dala AI has no analogue — no path where refusing costs a customer something they already bought — so the list is shorter, and it was re-derived rather than copied.

### Non-production behaviour

The sibling allows through when Redis is simply unconfigured in development (`src/lib/rateLimit.ts:245`), so local work needs no Upstash. Dala AI does **not** copy that for the spend path. A local dev environment with a real `ANTHROPIC_API_KEY` and no ceiling is exactly the configuration that spends money unattended. Local dev requires a local Supabase with a seeded `tenant_budgets` row ($1/month), or `ANTHROPIC_API_KEY` is absent and the brain returns a canned reply. The friction is deliberate.

---

## 5.9 The Telegram alert path

**Stated plainly, first: an alert is not a control.** The ceiling stops spend; the alert only says it happened. If every alert here is dropped, no tenant spends a cent more than its ceiling. If the alerts fire perfectly and the ceilings are broken, the money is gone. Nothing may be arranged so that an alert is load-bearing.

There is no Telegram integration in the sibling (verified by grep). This is greenfield.

### Env vars

```
TELEGRAM_BOT_TOKEN            # BotFather token. Never logged, never in a logged URL.
TELEGRAM_ALERT_CHAT_ID        # founder's private chat, or a private channel id (negative)
TELEGRAM_ALERT_CHAT_ID_CRIT   # optional second target for 🔴 only
ALERTS_ENABLED                # default "true"; "false" only in dev/CI
ALERT_MAX_PER_HOUR            # default 20 — the global alert budget
ALERT_DIGEST_HOUR_UB          # default 9 — the daily heartbeat, UB local
```

The Telegram Bot API puts the token **in the URL path** (`https://api.telegram.org/bot<TOKEN>/sendMessage`), so **the URL must never be logged** — not on success, not on error, not in a stack trace. This is the direct analogue of the sibling's open finding that QPay logs bank details, and the ancestor gets the equivalent right by putting the page token in a header rather than a query string (`lib/messengerClient.js:79`).

### What triggers an alert

| # | Trigger | Sev | Dedupe key | Window |
|---|---|---|---|---|
| 1 | Soft threshold (80%) crossed, monthly or daily | 🟠 | `soft:{tenant}:{scope}:{period}` | once per period |
| 2 | Hard ceiling reached | 🔴 | `hard:{tenant}:{scope}:{period}` | once per period |
| 3 | **Platform** ceiling reached | 🔴🔴 | `platform:{period}` | once per period |
| 4 | Compiled hard cap hit (a DB ceiling was above it) | 🔴🔴 | `compiledcap:{tenant}:{surface}:{day}` | once per day |
| 5 | Page/IG token expired (Graph error `190`) | 🔴 | `token:{tenant}:{external_id}` | on state transition only |
| 6 | Unknown `entry[].id` — event for a page we do not know | 🟠 | `unrouted:{object}:{external_id}` | 1h |
| 7 | Ledger/counter unavailable (reserve threw) | 🔴 | `ledger_down` | 15 min, **global** |
| 8 | Spike: 1h spend > 4× the trailing 7-day same-hour median | 🟠 | `spike:{tenant}:{hour}` | 1h |
| 9 | Orphaned reservations swept to `estimated` | 🟠 | `orphans:{day}` | once per day |
| 10 | Reconciliation variance > 5% vs provider-reported cost | 🔴 | `variance:{month}` | once per day |
| 11 | Ledger write failed after a successful model call | 🔴 | `deadletter:{day}` | 1h |
| 12 | `indeterminate` refusals (a call was claimed but never settled) | 🟠 | `indeterminate:{day}` | once per day |
| 13 | `model_mismatch` on a settled row | 🔴 | `modelmismatch:{day}` | 1h |
| 14 | Scheduled job started / refused / finished | 🔵 | `job:{job}:{run_id}` | per run |
| 15 | Tenant suspended / offboarded / budget version created | 🔵 | `admin:{tenant}:{action}:{ts}` | none |
| 16 | Daily digest | 🔵 | `digest:{day}` | once per day |

Trigger 5 fires on a **state transition**, not on every failing call — a dead token produces one `190` per inbound message, which without transition-gating is one alert per customer message for as long as it stays broken. Trigger 6 never auto-creates a tenant.

### What the message says

Four things, always: **which tenant, which surface, the number, and what action is needed.** A message the founder cannot act on is noise; noise gets muted; a muted channel is worse than no channel.

```
🟠 BUDGET 80%  ·  Matrix Eco Salon
surface: reception  ·  period: 2026-08 (monthly)
spent: $20.14 / $25.00      (₮70,490 / ₮87,500)
pace:  on track for ~$28 by 31 Aug — will hit the ceiling around 27 Aug
action: none yet. If this is real growth, raise the plan; the ceiling formula
        at 70% margin on ₮250,000 is $21.43.
```

```
🔴 CEILING REACHED  ·  GS Auto Center
surface: reception  ·  period: 2026-08-30 (daily)
spent: $3.00 / $3.00        (₮10,500 / ₮10,500)
effect: Reception is answering from canned replies only. Customers asking
        anything the shortcuts do not cover are being handed to +976 xxxx-xxxx.
        Location, hours and the greeting still answer normally.
top conversation: 24 replies to one contact in 4h — one away from the
        per-conversation cap. Check for a loop.
resets: 2026-08-31 00:00 +08 (in 6h 12m)
action: raise the daily ceiling, or leave it and let it reset.
```

```
🔴🔴 LEDGER UNAVAILABLE  ·  platform
Reservations have been failing for 3 min. ALL model calls are being refused
(503) across every tenant. Customers are receiving the handoff line.
last error: could not connect to Supabase (app.reserve_spend)
action: check Supabase status. NOTHING IS OVERSPENDING — this is fail-closed
        working as designed.
```

That last line matters. An operator told "the ledger is down" at 02:00 who does not know whether that means *refusing* or *leaking* will do the wrong thing.

**Never in an alert:** a page access token, an API key, a customer's message text, a raw PSID/IGSID, a bank detail. Tenant name, surface, counts and dollar figures only; contact references hashed and truncated.

### Deduplication, so a runaway does not send 500 messages

1. **Per-trigger dedupe key with a window** (table above). Redis `SET key 1 NX EX <window>` — the alerter is one place Redis *is* appropriate, because losing a dedupe key causes a duplicate alert, not a duplicate charge.
2. **A global alert budget, `ALERT_MAX_PER_HOUR` (default 20).** Beyond it, alerts are written to `app.alerts` but not sent; one aggregated message goes out instead:
   ```
   ⚠️ 47 alerts suppressed in the last hour (budget 20/h).
   worst: 🔴 CEILING REACHED · GS Auto Center (daily)
   by type: hard×3, spike×11, unrouted×33
   full list: dashboard → Alerts
   ```
   Suppression is logged with the dedupe key, so a suppressed alert is recoverable rather than lost.
3. **State-transition gating** on anything derived from a repeating condition (token status, ceiling state, ledger availability). Alert on the edge, not the level.

### `app.alerts` — Telegram is a transport, not the record

```sql
create table app.alerts (
  id            bigint generated always as identity primary key,
  tenant_id     uuid references app.tenants(id),   -- null for platform alerts
  kind          text not null,
  severity      text not null check (severity in ('info','warn','crit','fatal')),
  dedupe_key    text not null,
  payload       jsonb not null,      -- structured; the rendered text is derived
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  delivery_error text,
  attempts      int not null default 0,
  suppressed    boolean not null default false
);
create index on app.alerts (delivered_at) where delivered_at is null and not suppressed;
```

Every alert is written here **first**, then delivered. The record does not depend on Telegram being up.

### When Telegram itself is down

- Send is fire-and-forget with a **3s timeout**, never awaited on the customer path, never able to throw into it (`alert_delivery` is on the fail-open list).
- Failures increment `attempts`, record `delivery_error`, leave `delivered_at` null.
- A sweep retries undelivered alerts with backoff for 24h — a plain DB read plus an HTTPS POST, no Anthropic, so it may be scheduled (§5.11).
- Undelivered alerts appear as a banner in the founder dashboard.
- **The heartbeat is the real defence.** The daily digest arrives every day whether or not anything is wrong. Its *absence* is the signal that the alert path is dead — the only way to detect a silent alerting failure, and the same reasoning as the per-tenant "last webhook received at" watchdog: you find out from the absence of messages, not from a message.

```
🔵 DAILY DIGEST  ·  2026-08-30
Matrix Eco Salon   $0.71 / $3.00 day  ·  $18.40 / $25.00 month (74%)  ·  142 replies
GS Auto Center     $0.22 / $3.00 day  ·  $ 4.10 / $25.00 month (16%)  ·   38 replies
platform           $0.93 / $17.00 day ·  $22.50 / $120.00 month
uncorrected estimated rows: 0   orphans swept: 0   indeterminate: 0   deadletter: 0
token status: matrix=ok  gs=ok
```

A second, independent path — an email digest via a different provider, so one vendor's outage does not silence both — is worth having eventually. Not v1.

---

## 5.10 Attribution back to the business

The view that lets the founder price the product.

```sql
with m as (
  select to_char(now() at time zone 'Asia/Ulaanbaatar', 'YYYY-MM') as period_month
),
fx as (select mnt_per_usd from app.fx_rates order by as_of desc limit 1),
cost as (
  select l.tenant_id,
         sum(l.cost_nanousd)                                            as total_nano,
         sum(l.cost_nanousd) filter (where l.surface = 'reception')     as reception_nano,
         sum(l.cost_nanousd) filter (where l.surface = 'analytics')     as analytics_nano,
         sum(l.cost_nanousd) filter (where l.surface = 'quality')       as quality_nano,
         sum(l.cost_nanousd) filter (where l.surface = 'care')          as care_nano,
         count(*) filter (where l.surface = 'reception'
                            and l.correction_of is null)                as model_replies,
         count(distinct l.conversation_id)                              as conversations,
         count(distinct l.contact_ref)                                  as contacts,
         -- The honesty columns: estimated rows that no correction has replaced.
         count(*) filter (where l.estimated and not exists (
                 select 1 from app.spend_ledger c where c.correction_of = l.id))
                                                                        as unreconciled_rows,
         sum(l.cost_nanousd) filter (where l.estimated and not exists (
                 select 1 from app.spend_ledger c where c.correction_of = l.id))
                                                                        as unreconciled_nano
  from app.spend_ledger l, m
  where l.period_month = m.period_month          -- copied from the reservation, §5.1
  group by 1                                     -- corrections included: they NET
)
select
  t.name                                                                as tenant,
  s.plan, s.price_mnt                                                   as revenue_mnt,
  round(c.total_nano / 1e9::numeric, 4)                                 as cost_usd,
  round(c.total_nano / 1e9::numeric * fx.mnt_per_usd)                   as cost_mnt,
  round(s.price_mnt - c.total_nano / 1e9::numeric * fx.mnt_per_usd)     as gross_profit_mnt,
  round(100 * (1 - (c.total_nano / 1e9::numeric * fx.mnt_per_usd)
                   / nullif(s.price_mnt, 0)), 1)                        as gross_margin_pct,
  c.conversations, c.model_replies,
  round(c.total_nano / 1e9::numeric * fx.mnt_per_usd
        / nullif(c.conversations, 0), 1)                                as mnt_per_conversation,
  round(c.total_nano / 1e9::numeric * fx.mnt_per_usd
        / nullif(c.model_replies, 0), 2)                                as mnt_per_reply,
  round(100 * c.reception_nano / nullif(c.total_nano, 0))               as pct_reception,
  round(100 * c.analytics_nano / nullif(c.total_nano, 0))               as pct_analytics,
  round(100 * c.quality_nano   / nullif(c.total_nano, 0))               as pct_quality,
  round(b.monthly_ceiling_nanousd / 1e9::numeric, 2)                    as ceiling_usd,
  round(100 * c.total_nano / nullif(b.monthly_ceiling_nanousd, 0), 1)   as pct_of_ceiling,
  c.unreconciled_rows,
  round(c.unreconciled_nano / 1e9::numeric, 4)                          as unreconciled_usd
from cost c
  join app.tenants t              on t.id = c.tenant_id
  join app.tenant_budget_current b on b.tenant_id = c.tenant_id
  left join app.tenant_subscriptions s on s.tenant_id = c.tenant_id and s.active
  cross join fx
order by gross_margin_pct nulls last;
```

Reading it:

- **`gross_margin_pct`** decides whether the product is priced right. Sorted ascending, the worst tenant is at the top.
- **`mnt_per_conversation`** decides *how* to price. At ₮180 a per-conversation plan is viable; if it swings 5× between Matrix and GS Auto it is not, and a flat subscription with a ceiling is the right shape.
- **`pct_of_ceiling`** is the operational number: consistently above 80% needs a bigger plan; consistently below 20% is over-charged relative to cost and a churn risk when a competitor prices closer to marginal cost.
- **`unreconciled_usd`** is the honesty column — the portion of reported cost that is an estimate rather than a measurement, now correctly excluding estimated rows a later correction has replaced. If it is not near zero, none of the other numbers should be trusted, and that should be visible in the same table rather than a footnote.
- Corrections are included in the sums (that is the point of a compensating row) and excluded from the reply *count*.

Cost centres belonging to no tenant — platform experiments — go to the sentinel tenant with `surface='platform'` and appear as a separate line. **They are never silently divided among tenants**: a fixed cost allocated by fiat corrupts exactly the per-tenant margin figure this query exists to produce.

---

## 5.11 Nothing spends on a schedule without a ceiling and a kill switch

The sibling's rule, verbatim from its own comment (`src/lib/quizBank.ts:60-63`): "The hourly cron schedule has also been removed from vercel.json. The route is kept so the bank can be filled deliberately, but a manual trigger now refuses too — which is the point: the route was reachable by hand with nothing at all bounding what it would spend."

Dala AI has two scheduled spenders. Neither is scheduled until the ledger is live and verified against the running system.

### `/api/jobs/analytics/monthly`

```ts
// Compiled kill switch. Zero refuses BEFORE an Anthropic client is constructed —
// no read, no table, no cache can change that answer. This is the shape of
// BANK_BUILD_BUDGET_USD (src/lib/quizBank.ts:68, refused at :433-438).
export const ANALYTICS_RUN_BUDGET_USD  = 0    // ← raise deliberately; name the approver
export const ANALYTICS_PER_TENANT_USD  = 0.40
export const ANALYTICS_RUN_BUDGET_MS   = 220_000   // cf. RUN_BUDGET_MS, quizBank.ts:76
export const ANALYTICS_MAX_TENANTS     = 25
```

Guards, in order:

1. `Bearer $CRON_SECRET`, constant-time compare. Missing secret → 401, never "skip".
2. `if (ANALYTICS_RUN_BUDGET_USD <= 0) { log('analytics_budget_closed'); return 200 }` — **before** constructing any client.
3. **Claim the run.** `insert into app.job_runs (job, period_key, forced, started_by)` — the partial unique index `job_runs_one_unforced` means a cron double-fire, or a manual re-run over a scheduled one that looked stuck, gets a unique violation and stops. This is the first statement of the run, before any estimate.
4. **Reserve the whole-run budget as a real counter**, `scope='surface'`, `scope_key='analytics_run'`, through `bump_counter` — not a read-and-compare. The draft's version was a check-then-act, the one pattern §5.5 exists to kill, and two invocations would both have passed it. If the summed per-tenant estimate does not fit, refuse the *entire run* rather than half-completing it: a half-run leaves some tenants with a report and some without, which is worse than none and invisible without reading the ledger.
5. Per tenant: a normal `reserve_spend` against that tenant's `analytics` surface ceiling. A tenant that cannot afford its own report is skipped, named in the run summary, and does not consume the run budget.
6. Wall-clock budget: stop *starting* new tenants past `ANALYTICS_RUN_BUDGET_MS` rather than being killed mid-tenant — the reasoning at `quizBank.ts:70-76`.
7. Every call goes through the same `withTenantSpend()` chokepoint as Reception. **There is no second spend path.**
8. Alert on start, on refusal, and on finish with the actual cost.

**Re-runs are metered, not free.** The idem root is `analytics:{tenant}:{period_month}` — **without `prompt_version`**. The draft included it, which meant a tenant editing their KB on the 3rd silently made a re-run a brand-new key and a second full charge, in the same paragraph that claimed re-running was a no-op. Instead: the job skips a tenant that already has a report for the month unless the founder passes `force=true`, which creates a `forced` job-run row and a new `attempt` — costing money, visibly, on purpose.

### `/api/jobs/quality/review`

Same structure, plus three of its own:

- `QUALITY_RUN_BUDGET_USD = 0` — same kill switch.
- **A row ceiling, not just a dollar ceiling**: `QUALITY_MAX_CONVERSATIONS_PER_RUN = 200`. A dollar ceiling alone is satisfied by a cheap model reading 50,000 conversations, which is a latency and rate-limit problem even when affordable.
- **The Quality layer is cross-tenant by nature**, making it the most likely place for a tenant-scoping bug. Two mitigations: it runs under a scoped read-only identity rather than `service_role` where possible, so a scoping bug shows up as a missing row rather than a cross-tenant leak; and every proposal row carries `tenant_id` with a composite FK to the conversation it came from, so a proposal cannot reference another tenant's conversation.
- Its spend is attributed **per tenant**, to that tenant's `quality` surface. Hiding it in a platform bucket would understate that tenant's true COGS in §5.10.

### The rule for `vercel.json`

Only jobs that provably touch no paid provider may be scheduled before the ledger is verified live:

- `/api/jobs/alerts/retry` — DB read + Telegram POST.
- `/api/jobs/reservations/sweep` — DB only (§5.12).
- `/api/jobs/reconcile` — DB + one provider *usage* API read, not a generation.
- `/api/jobs/meta/subscription-audit` — Graph reads, free, rate-limited.
- `/api/jobs/digest` — DB read + Telegram POST.

Analytics and Quality are **manual-trigger-only** (`Bearer $CRON_SECRET`) until: the ledger has produced correct settled rows for a full week of Reception traffic; a reconciliation run has come in under 5% variance; and the founder has raised the budget constant in a commit that names them. That order is the point — the sibling scheduled first and discovered the missing ceiling afterwards.

---

## 5.12 Failure modes, consolidated

| Failure | What happens | Detection | Response |
|---|---|---|---|
| **Worker dies between reserve and the call** | Nothing spent; budget held | Sweep every 15 min over `state='open' and created_at < now() - interval '20 minutes'` | Sweeper's update is a **compare-and-swap**: `set state='orphaned' where id=$1 and state='open' returning id`. No row → do nothing. Then convert to `estimated = true` spend. **Do not release.** Releasing fails open on the exact case where the call may have happened and we have no record; the conservative reading is that it did. Reconciliation corrects it. Alert daily on the count (trigger 9). |
| **Settlement arrives after the sweeper** | The reservation is `orphaned`; the estimate is already booked | `settle_spend` branches on `spend_reservations.state` | `orphaned` → insert a **correction row** with `correction_of` pointing at the estimated row, adjusting `settled` by the delta only (which may be negative — the `cost_nanousd >= 0` check exempts corrections). `settled` → no-op. This is the case `correction_of` exists for. The draft had no state branch, so this path was guaranteed to violate `check (reserved_nanousd >= 0)`, dead-letter, and fire a 🔴 for the *expected* outcome of any slow worker — which is how a 🔴 gets ignored. |
| **Ledger write fails after a successful model call** | Money spent, no row — but the **reservation is still open and still holding budget**, so the ceiling is intact. This is precisely why reserving first is not optional. | The settle path catches its own error | Write the full settlement payload to `app.ledger_deadletter` **and** a structured log line, so the row is reconstructable from either. Alert (trigger 11). A sweep retries; settlement is idempotent on `(tenant_id, idem_key, correction_of)`. **Never release the reservation.** |
| **Retry re-calls the model** | Metered, bounded, or refused | — | The provider-call CAS on `provider_call_started_at` lets exactly one worker call per attempt. A genuine retry gets a **new attempt** with its own hold and its own ledger row, bounded by `max_attempts` (2 for Reception). Beyond that, the canned fallback with no generation — which also fixes the ancestor's four-generations-on-a-permanent-401 burn (`lib/messengerProcess.js:101-105`). |
| **Two deliveries of the same message race** | — | Cannot both proceed | The §5.2.4 lease upsert. QStash's `deduplicationId` (`lib/messengerQueue.js:66`, ~10-minute window) and Meta's at-least-once delivery both land on a durable DB constraint that outlives it. |
| **A model is substituted at the call site** | Real cost up to 2.5× the hold; the upper-bound invariant is void | `settle_spend` compares model used vs model reserved | Write the truthful ledger row priced from the *actual* model's current row, set `model_mismatch = true`, fire 🔴 (trigger 13). Truth in the ledger beats a clean invariant. CI forbids the substitution at source. |
| **Streamed call disconnects** | Tokens billed, no final `usage` | Missing usage on a non-error termination | Settle at the reservation estimate with `estimated = true`. Reception does not stream, so this cannot arise there. |
| **Ledger total diverges from provider-reported cost** | Our numbers are wrong in an unknown direction | Monthly reconciliation | Alert above 5% (trigger 10). Causes in likelihood order: a stale price row; orphans booked at estimate; uncorrected `estimated` rows; a path bypassing `withTenantSpend()`. *(Assumption flagged: that Anthropic's Admin API exposes a usage/cost report suitable for this. If not, the input is the Console figure entered by hand monthly — worse, still mandatory.)* |
| **Tenant offboarded mid-month** | — | `status = 'offboarded'` | `reserve_spend` returns `suspended` immediately, so spend stops at the transition, not at the next period. **Counters and ledger are retained** — they are the final invoice. Inbound webhooks still verified and persisted; nothing sent. |
| **Tenant misidentified** | Spend charged to the wrong tenant; §5.10's margins corrupted | Daily assertion: `select count(*) from spend_ledger l join conversations c on c.id = l.conversation_id where c.tenant_id <> l.tenant_id` | Must be **0**. Structurally prevented by the composite FK, but asserted anyway — a constraint you never test is a constraint you are trusting. Upstream, `channel_identity`'s PK on `(provider, external_id)` makes one identity → one tenant. **No `?? DEFAULT_TENANT` anywhere, ever** — that fallback, written for local testing, is the single most likely origin of this failure. |
| **Ledger and counter disagree on a period** | Reconciliation reports an artefact | Daily assertion `ledger.period_day = reservation.period_day` for all rows | Must be **0**. Guaranteed by §5.1's copy rule; asserted because the artefact would train the founder to ignore the alarm that catches real leaks. |
| **Counter row missing mid-flight** | `bump_counter` raises `DA002` | The explicit re-read distinguishes it from `exceeded` | Escapes the sub-block → `reserve_unavailable` → 503, alert. A zero-row `UPDATE … RETURNING` is ambiguous, and treating ambiguity as a decision is how the sibling lost weeks to an unapplied migration. |
| **Redis down** | Alert dedupe degrades to "send it"; per-minute burst limiting degrades. **This is a spend-INCREASE event, not a neutral one.** | Digest's cost-per-reply moves | No ceiling depends on Redis, so nothing overspends its ceiling. But `getHistory` returns `null`, and the ancestor's deliberate `null ≠ []` rule (`lib/messengerProcess.js:47-60`) then treats every message as mid-conversation, suppressing the **greeting** shortcut — so first messages that would have been free reach the model. Bounded (the location shortcut still fires, and the state-2 notice marker is in Postgres, §5.7), but the direction must be stated so the digest is read correctly during an outage. |
| **Supabase down** | `reserve_spend` throws | Trigger 7 | Every model call refused, every customer gets the Mongolian handoff line, nothing overspends. **Say which way it failed in the alert.** |
| **`ANTHROPIC_API_KEY` missing or credit exhausted** | 401/429 | — | Settle at **$0 with `estimated = false`** (no tokens billed); customer gets the fallback. Classify: 5xx/429/timeout retryable; 4xx auth and budget-exhausted terminal, straight to the fallback with no further attempt. |
| **Cache write charged as read, or vice versa** | Estimate/actual mismatch | Settlement records all four token classes separately | Immaterial: the estimate assumes the expensive branch and settlement corrects to the truth. |

---

## 5.13 Verification — how you know any of this is real

The founding lesson next door is that a plausible answer from a source that cannot see the truth is worse than no answer.

**After every migration touching `app.spend_*`, `app.model_prices`, `app.tenant_budgets` or `app.inbound_messages`, run the catalog pack and read every row:**

- `pg_class.relrowsecurity` per table — RLS on.
- `pg_policies` — restrictive per-command denies exist (`for insert`, `for update`, `for delete` **separately**; never `for all using(true) with check(false)`, which lets `DELETE` through because `DELETE` has no `WITH CHECK`).
- `aclexplode(coalesce(relacl, acldefault('r', relowner)))` — `anon` and `authenticated` hold nothing on `spend_ledger`, `spend_counters`, `spend_reservations`, `tenant_budgets`; `service_role` holds `SELECT, INSERT` on the ledger and **not** `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, or PG17's `MAINTAIN`. Handle grantee OID 0 (`PUBLIC`) explicitly — `pg_get_userbyid(0)` returns the string `'unknown (OID=0)'` rather than erroring.
- `pg_proc.prosecdef` and `proconfig` on `bump_counter`, `reserve_spend`, `settle_spend` — all `SECURITY DEFINER` with `search_path=`.
- **Each table independently.** The last failure next door was partial — one of four — and a spot check on the one that happened to be correct confirmed the wrong conclusion.
- Never `information_schema.role_table_grants`; never `supabase_migrations.schema_migrations`.

**Offline guards in CI:**

- `scripts/check-model-prices.mjs` — table vs `KNOWN_PRICES`, and every model id referenced in `src/` has a current row.
- `scripts/check-spend-guard.mjs` — no `catch` swallowing reserve/settle/bump; no provider client constructed outside `withTenantSpend()` (no exemptions); `model` and `max_tokens` at every call site come from the plan the estimator read.
- `scripts/check-supabase-nostore.mjs` — ported unchanged. **A cached ceiling read is a ceiling that stopped counting.**

**Tests that must exist before the first tenant:**

1. Twenty concurrent reservations against a balance that fits one → exactly one `allowed`, nineteen `exceeded`.
2. A tenant over its daily ceiling: **the platform counter does not move.** (The draft's partial-commit bug would have taken every tenant down after ~810 refused messages.)
3. Reserve → kill the process → sweep → reservation `orphaned`, estimated spend appears, counter did **not** go down.
4. Settle arriving after the sweep → one correction row, no dead-letter, no 🔴.
5. Two workers, same `mid`, same instant → one lease, one reservation, one Anthropic call.
6. Retry after a post-call crash → `attempt 2`, its own hold, its own ledger row; a third → `attempts_exhausted`, canned fallback, no call.
7. Same attempt delivered twice concurrently → `already_reserved`, CAS fails for one, exactly one call.
8. Settle twice with the same idem key → one primary ledger row.
9. Day boundary crossed between reserve and settle → the counter decremented is the one that was incremented, and `ledger.period_day = reservation.period_day`.
10. Ceiling reached → the location shortcut still answers; the model is not called; the Mongolian handoff line is sent exactly once per conversation **with Redis stopped**.
11. Conversation reply cap → the 26th reply is refused with the model never called.
12. Missing `tenant_budget_current` row → `not_provisioned`, no call, no auto-create.
13. `reserve_spend` called with a null compiled cap → exception, mapped to 503, not a silent unbounded ceiling.
14. **Two tenants processed in the same warm lambda cannot influence each other** — prompt, counter, ledger row, lease key, log line. The ancestor's module-scope `cachedBasePrompt` (`lib/salonBrain.js:142`) is why this test exists.
15. **All tests inject the clock.** The ancestor's suite is red today — 16 pass, 2 fail — because `tests/closures.test.js` asserts against a shipped default closure that ended six weeks ago and reads the real clock. A period-boundary test that reads `now()` is time-bombed the day it is written.

---

## 5.14 Environment variables introduced by this section

```
# --- Alerts ---
TELEGRAM_BOT_TOKEN
TELEGRAM_ALERT_CHAT_ID
TELEGRAM_ALERT_CHAT_ID_CRIT        # optional
ALERTS_ENABLED                      # default true
ALERT_MAX_PER_HOUR                  # default 20
ALERT_DIGEST_HOUR_UB                # default 9

# --- Jobs ---
CRON_SECRET                         # bearer for every /api/jobs/* route
ANTHROPIC_ADMIN_API_KEY             # read-only, reconciliation only — NOT the generation key
```

Ceilings and budgets are **not** environment variables. They live either in `app.tenant_budgets` (append-only, auditable, lowering-only, instant) or in a compiled constant (requires a commit naming the approver). An env var is the worst of both: mutable from a dashboard, invisible in a diff, with no record of who changed it.

Per-tenant Meta page tokens are per-tenant *data* and belong to the key-management section — but the same rule applies to anything here: never hardcoded, never logged, never a fallback to a default credential. The ancestor's `explicit || process.env.PAGE_ACCESS_TOKEN` (`lib/messengerClient.js:67-69`) is exactly the fallback this project forbids, and in a multi-tenant build it means tenant B's message goes out on tenant A's token.

---

## 5.15 Separating verified from assumed

**Verified by reading the file (cited, re-checked this session):**

- Ancestor spends with only a key-presence check, no budget — `lib/salonBrain.js:177-181`.
- `claude-sonnet-5`, `MAX_TOKENS = 1024`, `CACHE_TTL = '1h'`, `UPSTREAM_TIMEOUT_MS = 25000` — `lib/salonBrain.js:18, 20, 34, 37`; the Sonnet-over-Haiku rationale ("haiku occasionally slips on free-form Mongolian") — `:15-17`.
- Cache breakpoint at the end of the system prompt, customer history deliberately outside it — `lib/salonBrain.js:210-222`.
- All three cache token counts computed and discarded into a log line — `lib/salonBrain.js:245-253`.
- Rethrow on any brain failure → QStash retries — `lib/messengerProcess.js:101-105`; `MAX_RETRIES = 3` — `lib/messengerQueue.js:13`; `deduplicationId: event.mid` — `:66`; attempt number from `upstash-retried` — `api/messenger-worker.js:67-68`.
- `isAlreadyHandled` checked at `lib/messengerProcess.js:38`; `markHandled` written at `:116`, **after** the send at `:115`.
- `null ≠ []` for history availability, and the greeting shortcut gated on confirmed-empty — `lib/messengerProcess.js:47-60`.
- Sibling: `BANK_BUILD_BUDGET_USD = 0` at `src/lib/quizBank.ts:68` with the full rationale at `:37-67`; refusal before constructing a client at `:433-438`; `RUN_BUDGET_MS = 220_000` at `:76`; `MAX_PER_RUN = 50` at `:33`; Haiku price constants at `:23-24`.
- Sibling guard order and 503-on-error — `src/lib/aiRouteGuard.ts:28-67, 81-96`; the `try/catch/continue` history — `:71-77`; `UNAVAILABLE_MESSAGE` in Mongolian — `:8`.
- `FAIL_OPEN_KEYS` and its justification block — `src/lib/rateLimit.ts:84-114`; `@upstash/ratelimit`'s `timeout` failing open, converted at `:226-228`; `onUnavailable` — `:240-248`.
- `ensureRow` read-then-insert — `src/lib/supabase/usageLimits.ts:66-92`; UB clock `TZ = 'Asia/Ulaanbaatar'` — `:38-52`.
- The Next caching trap in full, including that `force-dynamic` does not stop it and that writes were unaffected because the cache key hashes the body — `src/lib/supabase/fetch.ts:1-60`.
- **Measured by running it:** `buildSystemPrompt(clientData)` = **7,824 characters / 12,866 UTF-8 bytes**.
- **Verified by grep:** no Telegram integration exists anywhere in `dalatech-english`.

**Assumed — not presented as fact, load-bearing where marked:**

- **Token count of the Mongolian system prompt (~7,000).** Never measured. Every dollar figure in §5.6 scales with it. It is already in production logs; one line settles it. **Measure before committing a ceiling.**
- **₮3,500/USD.** Illustrative. The live value is `app.fx_rates`.
- **300-600 conversations/month/salon at ~5 replies each.** A guess. Matrix's actual Page has the answer.
- **That Anthropic's Admin API exposes a usage/cost report** suitable for monthly reconciliation. If not, the input is the Console figure entered by hand — worse, still mandatory.
- **That Anthropic Console supports a per-workspace hard spend limit.** If not, hold the account balance low deliberately.
- **That `/v1/messages/count_tokens` is billed at $0.** It is metered by count here regardless, because rate limits consumed outside the ledger are invisible.
- **That adaptive thinking output is bounded by `max_tokens`.** If not, the upper-bound property breaks for any surface using it. Reception does not use it, so Reception is safe either way — Quality and Analytics must not until this is checked.
- **Cache-hit rate on a working salon Page.** The 1h TTL reasoning at `lib/salonBrain.js:22-33` is sound and derived from real gap distributions, but the resulting hit rate was never measured. The ledger measures it from month one — `cache_read_tokens` vs `cache_write_tokens` per tenant.

---

## Open questions — the founder's call

1. **What is the subscription price, and what gross margin is the target?** Everything numeric in §5.6 is downstream of these two via the ceiling formula. Until they exist the ceilings are placeholders, and a placeholder ceiling nobody revisits is how the sibling ended up with none.

2. **When a tenant hits its ceiling on a Saturday afternoon, what should happen?** The design defaults to `canned_handoff` — Messenger stops answering new questions and hands customers to the phone, mid-trading-day. The alternatives are `silent` (worse for the customer, better for the salon's brand) and auto-overage billing (best for the customer, and it turns a hard ceiling into a soft one, which is the thing this section exists to prevent). A *contract* question: the tenant needs the answer before it happens.

3. **Are ceilings per-plan or per-tenant?** Per-plan is simpler to sell and keeps onboarding to "fill in a config". Per-tenant is more accurate and makes every onboarding a judgement call. The schema supports both.

4. **How many generation attempts is a customer's reply worth?** `max_attempts = 2` for Reception is my choice, and it is a trade the founder should see: at 1, a transient Anthropic 529 means that customer silently gets the canned fallback; at 3, a persistent-but-retryable fault costs 3× per message. The ancestor effectively ran at 4 with no meter.

5. **Should a tenant see its own spend?** A "74% of this month's AI allowance" panel makes the ceiling legible and pre-empts the Saturday surprise. It also exposes your COGS to a customer who may then reason about your margin. The RLS work supports it (`spend_ledger` `SELECT`-only to a scoped reader); the question is whether you want it.

6. **Who is woken at 02:00, and by what?** Telegram to the founder's phone is the assumption. If the phone is on silent the ceiling still holds — that is what "an alert is not a control" means — but a dead page token means one salon silently stops answering until someone looks. Is there a promised time-to-restore in the tenant contract? If yes, the alert path needs a second channel and an escalation; if no, say so in the contract.

7. **Does `care` get a budget above zero before the SIP trunk exists?** The design says no: `care: 0` in the compiled caps, and an unknown per-message price refuses rather than defaults. Piloting Care over Messenger Utility Templates in the meantime is a new metered surface whose per-message price must be known *before* the first send; the schema already carries non-token units, the compiled caps do not.

8. **Is a $0.005 reply worth Sonnet 5?** Reception answers salon price questions from a fixed knowledge base. Haiku 4.5 is half the price, and its 4096-token minimum cacheable prefix is comfortably cleared by a ~7,000-token prompt, so caching *is* available. Sonnet was chosen in the ancestor for Mongolian language quality with a comment recording that Haiku "occasionally slips on free-form Mongolian" (`lib/salonBrain.js:15-17`) — a judgement, not a measurement. A bake-off would settle it, and the ledger is what makes the comparison a fact rather than an opinion. The answer changes every ceiling in §5.6 by a factor of two, so run it before the numbers go into contracts.

9. **When a `model_mismatch` row appears, does the ceiling hold or does the truth hold?** The design chooses truth: the ledger records the real cost even though it may push the counter past the ceiling, and fires a 🔴. The alternative — refusing to settle and dead-lettering — keeps the ceiling arithmetically clean at the price of a spend that exists nowhere in the books. I believe truth is right and CI should make the case unreachable, but it is the one place the design deliberately lets a ceiling be exceeded, and the founder should know that.