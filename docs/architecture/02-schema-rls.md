> **The DDL in this file is superseded.** It was one of eight independently written
> proposals, and [`09-reconciliation.md`](09-reconciliation.md) arbitrated the twenty-three
> places they contradicted each other. The schema is
> [`../schema.md`](../schema.md) + `supabase/migrations/0001_initial_schema.sql`, which
> is applied and verified; where this file disagrees with either, this file is stale.
> The reasoning here is still live — it is why the schema is shaped as it is.

## 2. Database schema, RLS, and grants

*Dala AI — foundational architecture document. Section 2 of N.*

---

## 2.0 What this section is, and how to read the marks

This section specifies the complete Postgres schema for a **new Supabase project** (`dala-ai-prod`), with RLS, grants, and a verification protocol correct from migration `0001`. It is written so the founder can re-derive every decision without me.

Four marks are used, and the difference is load-bearing:

| Mark | Meaning |
|---|---|
| **VERIFIED (file)** | I opened the file on this machine and read the line. Cited `path:line`. |
| **VERIFIED (executed)** | I ran it **this session** against a PostgreSQL 16.13 cluster I initialised at `initdb --locale=C.UTF-8 -E UTF8`, with roles `anon` / `authenticated` / `service_role` (`BYPASSRLS`) modelling Supabase. Transcript excerpts are quoted inline. |
| **VERIFIED (research)** | Executed in the research pass preceding this document, output quoted there. Re-runnable. |
| **ASSUMED** | Inference or vendor-doc recall not confirmed. **Do not build on it without checking.** All listed again in §2.14. |

**Version gap to hold in mind:** my cluster is PG 16.13; Supabase production is PG 17.x, which adds the `MAINTAIN` privilege — so ACL residue there is `Dxtm` (four privileges), not PG16's `Dxt` (three). Every verification query below is written version-agnostically for that reason.

The single most important thing carried over from next door: **two obvious sources of truth lie by returning a plausible answer instead of an error** (`docs/security-audit-2026-08-23.md:363-364`). That failure shape recurs **seven** more times in this section — in `information_schema`, in a join against an RLS-protected table, in `aclexplode(NULL)`, in a view over an RLS table, in `has_schema_privilege` versus a schema ACL that visibly changed, in `pg_default_acl`, and in a stored generated column whose function was replaced. Learn the shape, not the eight instances.

---

## 2.1 Premises, and what the ancestor proves

Six facts from the single-tenant ancestor set the schema's requirements. All **VERIFIED (file)**.

1. **The tenant is a module import.** `lib/salonBrain.js:11` and `lib/salonIntents.js:17` both `import { clientData } from '../config/currentClient.js'` at module load. The knowledge base is a 121-line committed object literal (`config/currentClient.js:5-120`). `CLIENT_ONBOARDING.md:7-9` documents onboarding as "open `/config/currentClient.js` and update the following sections" — a code edit and a redeploy.

2. **The tenant is cached in a module-scope singleton.** `lib/salonBrain.js:142` — `let cachedBasePrompt = null`, populated once per warm process from build-time `clientData`. Two tenants on one warm Vercel lambda is a cross-tenant data leak, not a bug. The schema's job is to make the *only* way to get a prompt be "load rows for a `tenant_id` derived server-side", so this class of defect has nowhere to live.

3. **Knowledge is already the wrong shape to be data.** `config/currentClient.js:38` stores a price as `"66,000 – 88,000"` (a display string with an en dash) beside `55000` at `:39`. `:18-28` encodes a service line as a gender (`gender: "manicure"`), and `lib/systemPromptBuilder.js:69-84` renders three hardcoded buckets — a staff member with any other group value **silently vanishes from the prompt**, because there is no `else`. GS Auto Center's mechanics cannot be expressed at all. `:91` stores `<br><br><a href=…>` inside an FAQ answer, which `lib/messengerText.js` then strips back out.

4. **The deliberate omission is code, not data.** The children's-price refusal exists as a comment at `config/currentClient.js:34-35`, as a pinned constant at `lib/salonBrain.js:70-72`, and as a *second copy of the same sentence* in the prompt template at `lib/systemPromptBuilder.js:135`. Three copies of one business decision, none of them a row.

5. **Nothing meters spend.** `grep` for cost/budget/quota/ledger symbols across `/home/user/Matrix-Chatbot` returns nothing. `api/chat.js:13` pins a stale dated model id (`'claude-haiku-4-5-20251001'`).

6. **No NFC normalisation exists anywhere.** `grep -rn "normalize(" --include=*.js` over the whole repo returns zero hits. Every regex over customer text there matches or fails depending on which IME the customer used.

**Premise for this section:** the database is where the tenant becomes real. If `tenant_id` is not derivable server-side, not enforced by a constraint, and not present in every key, none of the application-layer discipline above it matters.

---

## 2.2 The isolation model

### Decision: shared schema, `tenant_id uuid not null` on every tenant-scoped table, RLS per tenant.

Not schema-per-tenant, not database-per-tenant. The decisive argument is not performance — it is the hard test. **Schema-per-tenant makes onboarding a DDL operation**: `create schema`, replay N migrations, re-grant, re-policy. That is writing code to onboard client #3, in the most dangerous possible form, and it multiplies the failure already recorded next door — `20260817` applied to *one of four* tables, invisible for weeks (`security-audit-2026-08-23.md:291-302`) — by the number of tenants, along a new axis (per-tenant drift) no catalog query you write today will think to check.

Two Dala-AI-specific reasons on top:

- **Analytics AI and the Quality layer are inherently cross-tenant.** `group by tenant_id` in a shared schema; dynamic SQL over `information_schema` in schema-per-tenant.
- **The webhook path has no session at all.** A Meta POST carries no JWT. Inbound runs as `service_role` end to end and derives the tenant from `entry[].id`. **RLS is not what protects the inbound path in any of the three models** (§2.7). Schema-per-tenant buys nothing where the volume and the spend actually are.

### The composite-FK spine

Every foreign key between tenant-scoped tables carries `tenant_id`:

```sql
create table conversations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  ...
  unique (tenant_id, id)                      -- makes the composite FK below possible
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null,
  ...
  foreign key (tenant_id, conversation_id)
    references conversations (tenant_id, id) on delete cascade
);
```

This costs one redundant unique index per parent and buys the only defence that survives `BYPASSRLS`: a service-role route that resolved `conversation_id` correctly but stamped the wrong `tenant_id` is **refused by the database**. It keeps enforcing under any policy state, because PostgreSQL's docs are explicit: *"Operations that apply to the whole table, such as TRUNCATE and REFERENCES, are not subject to row security."*

**Write this down as the rule:** *inside Postgres, the only things that bind `service_role` are constraints, foreign keys, and triggers. Policies do not.*

### Three named exceptions to the spine — because a rule with unwritten exceptions is not a rule

The first review found that the draft silently violated its own spine in three places. Two are now fixed; the third is a genuine exception and is written down here so the verification query in §2.11 (V16) can require a justification for every `*_id` column with no FK.

**(a) `uuid[]` columns are cross-tenant pointers a foreign key cannot bind — removed.** The draft had `disambiguation_pairs.candidate_service_ids uuid[]` (client-writable, tenant-authored class) and `kb_change_proposals.evidence_review_ids uuid[]`. Postgres cannot put an FK on an array element. A GS Auto owner could insert a row on his own `tenant_id` — every policy and every `WITH CHECK` passes — carrying Matrix's `service_items` uuids, and the natural prompt-builder query `select … from service_items where id = any($1)` runs as `service_role` with RLS off and renders Matrix's «Сор» pricing into GS Auto's prompt. Both array columns become child tables with composite FKs (§2.4-B, §2.4-F). **Any `uuid[]` / `bigint[]` id column on a tenant-scoped table is a finding.**

**(b) `ledger_id` had no foreign key at all — added.** `messages.ledger_id`, `quality_reviews.ledger_id`, `analytics_reports.ledger_id` and `kb_change_proposals.applied_audit_id` were plain `bigint` with nothing referencing anything, and the composite FK was not even *expressible* because `spend_ledger` declared `id … primary key` with no `unique (tenant_id, id)`. A warm-worker off-by-one — the exact defect class `lib/salonBrain.js:142` proves these authors write — attributes tenant A's $0.31 Opus call to tenant B's monthly report and, under `on_exhausted = 'overage_bill'`, to tenant B's invoice. Fixed by adding `unique (tenant_id, id)` to `spend_ledger` and `audit_log` and composite FKs on all four.

> **Where the review was wrong (1/5).** The proposed fix was `foreign key (tenant_id, ledger_id) references spend_ledger (tenant_id, id) **on delete set null**`. That is itself a tenant-leak. **VERIFIED (executed):** a composite FK's `ON DELETE SET NULL` nulls the *entire* referencing column set, `tenant_id` included —
> ```
> ERROR:  null value in column "tenant_id" of relation "spend_ledger" violates not-null constraint
> CONTEXT: SQL statement "UPDATE ONLY "public"."spend_ledger"
>          SET "tenant_id" = NULL, "conversation_id" = NULL WHERE ..."
> ```
> — and with `tenant_id` nullable it succeeds and erases the scoping silently (`tenant_erased | conv_erased` → `t | t`). Every composite FK in this schema is therefore `on delete cascade` (child dies with parent) or `on delete no action` / `restrict`. **`ON DELETE SET NULL` is banned on any composite FK whose column list includes `tenant_id`**, unless written PG15+ column-scoped as `on delete set null (other_column)` — verified to preserve `tenant_id` (`t | f` → tenant kept, pointer nulled).

**(c) `spend_ledger.conversation_id` carries no FK — a deliberate, written exception.** This is my finding, not the review's, and it is the reason the draft's design could not have been deployed.

**VERIFIED (executed).** With the draft's exact DDL — `spend_ledger` with `foreign key (tenant_id, conversation_id) references conversations(tenant_id, id) on delete set null` and a `before update or delete … for each row` append-only trigger:

```
=== delete a conversation (retention purge / contact erasure) ===
ERROR: append-only table spend_ledger: UPDATE is not permitted
CONTEXT: SQL statement "UPDATE ONLY spend_ledger SET tenant_id=NULL, conversation_id=NULL ..."

=== delete the tenant (offboarding) ===
ERROR: append-only table spend_ledger: DELETE is not permitted
CONTEXT: SQL statement "DELETE FROM ONLY spend_ledger WHERE $1 = tenant_id"
```

**Foreign-key referential actions are executed as ordinary UPDATE/DELETE statements and fire user row triggers.** So the draft's append-only trigger made retention, per-person erasure, and tenant offboarding *all impossible* — a hard error at the first purge run, months after launch, at the moment a privacy promise comes due. Column-scoping the SET NULL does not help: it still issues an UPDATE, which still fires the trigger.

The resolution is to accept the asymmetry rather than fight it. **Financial records outlive conversations by design.** So:

- `spend_ledger.conversation_id uuid` — **no FK**. Written exception, justified: an FK either forbids the purge or requires a mutation the append-only trigger must refuse.
- The binding that actually matters runs the other way and *is* enforced: `messages.ledger_id` → `spend_ledger (tenant_id, id)` `on delete no action`. A message can never be billed to another tenant's ledger row. Deleting a message is a child delete and is unaffected.
- `spend_ledger.tenant_id` and `audit_log.tenant_id` reference `tenants` **`on delete restrict`**, not `cascade` — because `delete from tenants` is not the offboarding mechanism (§2.8), and a `cascade` there is a loaded gun.
- `service_items` and `staff_members` are **never hard-deleted** (`active = false`); `booking_handoffs`'s FKs to them are `on delete restrict` so a hard delete fails loudly rather than orphaning attribution.

---

## 2.3 Conventions

| Convention | Choice | Why |
|---|---|---|
| Primary keys | `uuid` + `gen_random_uuid()` | No cross-tenant information in an id; no sequence to leak row counts. Exception: append-only ledgers use `bigint generated always as identity` **plus** `unique (tenant_id, id)`, because ordering matters and the spine needs a composite target. |
| Timestamps | `timestamptz`, `default now()`, never `timestamp` | Mongolia is UTC+8. `config/closures.js:32` hardcodes `SALON_UTC_OFFSET_MINUTES = 8 * 60` — a Mongolia-only platform constant. Tenants carry an IANA zone instead. |
| Money | `numeric(14,6)` for USD spend; `bigint` MNT for tenant prices | Never `float`. MNT has no practical minor unit; store whole tugrik and keep `currency` explicit. |
| Closed sets | `text` + `check (col in (...))` | An enum change is a migration and a lock; a check constraint is one line and shows its full body in `pg_constraint`, so the pack can read it. |
| Sets a tenant extends | lookup table + FK | e.g. `staff_groups`. Adding a group is an `insert`. |
| Text | `text` + `check (length(col) <= n)` | Never `varchar(n)`. `length()` counts **characters**; Mongolian Cyrillic is 2 bytes/char, so any `varchar(n)` sized from an ASCII intuition is ~1.9× too small. VERIFIED (research): `length('Үс засалт')` = 9, `octet_length` = 17. |
| Normalisation | `check (col is normalized)` on every stored user/tenant text column | PG13+ `IS NORMALIZED` (NFC default) is cheap because checking is faster than converting. The constraint the ancestor never had. |
| Uniqueness over a nullable column | generated stored column, or `unique nulls not distinct` | Never a bare `unique (a, b, nullable_c)` — see §2.4-A. |
| Schemas | `public` for PostgREST-visible tables; `app` for helper functions; `ops` for classification, purge and export machinery | `app` and `ops` are never in PostgREST's exposed schemas, so nothing there is reachable over the Data API even if a grant slips. |

---

## 2.4 The table catalog

Every table is `tenant_id`-scoped unless marked **[global]**. DDL is abbreviated to the load-bearing columns, keys, and indexes. **Every DDL block below compiles on PG 16.13** — three blocks in the draft did not, and are corrected here with the transcript.

### A. Tenancy and identity

#### `tenants` **[global]** — one row per business.

```sql
create table tenants (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null unique
                           check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  display_name             text not null check (length(display_name) between 1 and 120
                                                and display_name is normalized),
  timezone                 text not null default 'Asia/Ulaanbaatar',
  default_locale           text not null default 'mn-MN',
  -- SERVER-OWNED from here down: the tenant must never assert any of these.
  status                   text not null default 'provisioning'
                           check (status in ('provisioning','active','suspended','offboarding','purged')),
  plan                     text not null default 'none'
                           check (plan in ('none','reception','reception_care','full')),
  plan_effective_from      timestamptz,
  retention_days_messages  int  not null default 90 check (retention_days_messages between 30 and 730),
  retention_days_raw_events int not null default 7  check (retention_days_raw_events between 1 and 30),
  suspended_reason         text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index on tenants (status) where status <> 'purged';
```

`slug`'s check uses an ASCII class **deliberately**: a slug is a machine identifier appearing in URLs, cache keys and log lines. Rule #4 ("no `[a-z]` classes") governs patterns over **user text**. Say which one you are writing every time.

> **`tenants` scopes on `id`, not `tenant_id` — and that blinded the draft's verification pack.** V6 tested `attname = 'tenant_id'` and would have reported `has_tenant_id = false`, landing `tenants` on the "written allow-list" the draft invited. V7 flags any client policy whose `qual` lacks the literal string `tenant_id`, so the *correct* policy `using (id = any(...))` is flagged as unscoped — and a real `using (true)` on the same table arrives among known-benign noise and gets waved through. A GS Auto owner then reads Dalatech's entire customer list, every competitor's plan tier, and who is suspended and why, with every catalog check passing. Fixed structurally in §2.11 by driving V6/V7 from `ops.tenant_scope`, a declared registry, rather than from a hardcoded column name.

#### `tenant_members` **[global]** — which humans may see which tenant's dashboard. **Server-owned.**

```sql
create table tenant_members (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner','staff')),
  status     text not null default 'active' check (status in ('active','revoked')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, user_id)
);
create index on tenant_members (user_id) where status = 'active';
```

The draft classified this **tenant-authored** and both reviews caught it. `tenant_members` is the sole input to `app.current_tenant_ids()` — **it is the authorization table**. Under an own-tenant `for all` policy a `staff` member can `update tenant_members set role='owner'` on their own row and `delete` the owner's, and no `audit_log` row is written. That directly contradicts §2.5's governing sentence applied to the most server-owned value in the system. It is now **server-owned**: `SELECT` own tenant only, plus the three restrictive denies. Invitations and revocations go through a service-role route that writes `audit_log`. (Consequence for the founder: there is no self-serve "invite a colleague" button in v1 without that route — see §2.15 Q8.)

One person **may** hold two tenants (an agency; the founder acting as a tenant owner during onboarding). That decision costs almost nothing now and changes every dashboard URL later, so it is made here: `app.current_tenant_ids()` returns a **set**, never a scalar.

#### `tenant_channels` — the tenant routing registry. **The single most security-critical table in the schema.**

```sql
create table channel_providers (            -- [global] lookup, so adding one is data
  key           text primary key check (key in ('facebook_page','instagram','sms','web')),
  adapter_key   text not null,
  send_host     text not null,
  send_path_tpl text not null               -- '/{external_id}/messages' — NEVER '/me/messages'
);

create table tenant_channels (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  provider      text not null references channel_providers(key),
  external_id   text not null,              -- Page ID, or IG professional account ID
  auth_flavour  text not null default 'facebook_login'
                check (auth_flavour in ('facebook_login','instagram_login','n_a')),
  meta_app_id   text,                       -- which Meta app; supports >1 app later
  business_id   text,
  granted_scopes    text[] not null default '{}',   -- opaque strings, not ids: no FK needed
  subscribed_fields text[] not null default '{}',
  graph_version_override text,
  status        text not null default 'pending'
                check (status in ('pending','active','authorization_error','disabled')),
  last_webhook_at timestamptz,
  last_send_ok_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (provider, external_id),                       -- ← the whole point
  unique (tenant_id, id)
);
create index on tenant_channels (tenant_id, provider);
create index on tenant_channels (status) where status <> 'active';
```

**`unique (provider, external_id)` is the security control.** A Page ID or IG account ID maps to **exactly one** tenant, enforced by the database; an unknown identity has nowhere to go but the drop path. Never `upsert` a tenant from a webhook. Never accept a tenant hint from a request body.

This replaces three defects, all **VERIFIED (file)**:
- `api/messenger.js:164-180` iterates `body.entry` and **never reads `entry.id`** — tenant routing does not exist.
- `api/messenger.js:99-101` returns a bare `200` for anything that is not `object === 'page'`, so Instagram events are silently discarded with an HTTP 200 — the "plausible success instead of an error" shape again.
- `lib/messengerClient.js:10` — `SEND_URL = .../me/messages`. With `/me`, a token/tenant mismatch **succeeds and posts as the wrong salon.** There is no error to catch. `channel_providers.send_path_tpl` exists so that line cannot be written again.

`granted_scopes` and `subscribed_fields` stay arrays: they hold opaque provider strings, not references to tenant-scoped rows, so exception (a) in §2.2 does not apply.

**Failure modes.** *Unknown `external_id`*: `200` + drop + `webhook.unrouted` counter + alert; never auto-create. *Two rows claiming one Page*: impossible, unique constraint refuses. *Token expired* (Graph `190`): `status='authorization_error'`, stop all sends for that tenant, alert; never retry. *Dead channel*: `last_webhook_at` is the watchdog — a tenant Meta silently unsubscribed produces the **absence** of requests, which nothing throws on.

#### `tenant_secrets` — per-tenant Meta page tokens. Envelope-encrypted.

The draft's DDL did not compile. **VERIFIED (executed):**

```
primary key (tenant_id, kind, coalesce(channel_id,'000…'::uuid));
  ERROR:  syntax error at or near "("
```

`PRIMARY KEY` and `UNIQUE` table constraints take a **column list**, never an expression. The two obvious hasty fixes are both dangerous: `primary key (tenant_id, kind)` permits only one Meta token per tenant and breaks a tenant with a Page *and* an IG account; a bare `unique (tenant_id, kind, channel_id)` with `channel_id` nullable permits duplicates — **VERIFIED (executed):** two identical `('…','meta_page_token', null)` rows inserted successfully, `duplicate_token_rows = 2`. On the *secret* table that is "the send path picks a token nondeterministically, possibly a revoked one", which silences a live tenant while a valid token sits in the row next to it.

```sql
create table tenant_secrets (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  channel_id  uuid,
  channel_key uuid generated always as
              (coalesce(channel_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  kind        text not null check (kind in ('meta_page_token','ig_user_token',
                                            'sip_password','webhook_shared_secret')),
  ciphertext  bytea not null,       -- AES-256-GCM(secret, DEK); iv || tag || ct
  wrapped_dek bytea not null,       -- AES-256-GCM(DEK, KEK);  iv || tag || ct
  kek_version int  not null,
  aad_fingerprint bytea not null,   -- sha256(tenant_id || kind || channel_id)
  status      text not null default 'active' check (status in ('active','rotating','revoked')),
  last_ok_at  timestamptz,
  last_error_code text
              check (last_error_code is null or last_error_code ~ '^[0-9]{1,6}$'),
  rotated_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, kind, channel_key),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade
);
alter table tenant_secrets enable row level security;
-- NO policy for anon/authenticated at all, and no privilege either (§2.6).
```

Both fixes verified: the generated-column PK creates cleanly, and `unique nulls not distinct (tenant_id, kind, channel_id)` (PG15+, available on Supabase) is the equivalent one-liner — it correctly rejected the duplicate token row. Either is acceptable; the generated column also gives you a real PK and works on any version.

The `last_error_code` allow-list is a direct upgrade over the draft. The column was annotated *"NEVER the token, never a message"* and carried no constraint at all. An allow-list regex is unbypassable where a deny-list is not (§2.4-F).

**Key management (recommended: envelope encryption, KEK in the Vercel environment; not Supabase Vault).** Vault and envelope encryption are equivalent against a stolen database backup. They are *not* equivalent against a **leaked `sb_secret_` key**: `vault.decrypted_secrets` decrypts on read for `service_role`, so one leaked key yields every tenant's token in plaintext. Envelope encryption splits the capability across two vendors — the attacker needs a Supabase secret key *and* the Vercel project environment. For a solo founder on a public repo the leaked-key incident is the likelier one. (Secondary: pgsodium is pending deprecation and Vault is `public alpha`, VERIFIED (research) from Supabase's own docs.)

`aad_fingerprint` records the GCM additional-authenticated-data binding: pass `tenant_id || kind || channel_id` as AAD so copying row A's ciphertext onto row B **fails authentication** instead of decrypting into the wrong tenant's send path.

This replaces `lib/messengerClient.js:67-69`:

```js
function pageToken(explicit) { return explicit || process.env.PAGE_ACCESS_TOKEN; }
```

That `||` is the forbidden "fallback to a default credential"; multi-tenant, it means **tenant B's message goes out on tenant A's token**. The token becomes a required argument resolved from `tenant_secrets`; missing → refuse with a distinct code (`tenant_not_provisioned`), never fall back. Carry `lib/messengerClient.js:79` unchanged — token in the `Authorization` header, never a URL.

**Failure modes.** *KEK env var missing at boot*: refuse to start / 503. Never a plaintext column, never a default. *Unwrap fails*: 503 for that tenant only; never fall through to another tenant's secret. *GCM tag mismatch*: treat as tampering, alert, never decrypt-and-hope. *No row*: `tenant_not_provisioned` (503), not 500, not a silent skip.

#### `platform_admins` **[global]** — the founder's cross-tenant identity. Argued in §2.7.

```sql
create table platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  granted_by  uuid references auth.users(id),
  can_read_message_bodies boolean not null default false,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
```

### B. Configuration — typed rows, not one JSON blob

**Decision: no `tenant_config` table.** A single `tenant_config jsonb` passes the "filling in a config" test superficially and fails it three ways: no write-time validation, so a typo in a key produces a *silently absent* prompt section — exactly the `systemPromptBuilder.js:69-84` failure where an unrecognised group value makes a staff member vanish with no error; the Quality layer proposes **field-level** KB changes and diffing a blob is worse than diffing a row; and the founder-facing admin form is generated from the schema, which a blob does not have.

Tenant scalars are columns on `tenants`; everything else is typed child tables. One narrow escape hatch remains — `tenants.settings jsonb not null default '{}'` — validated at write time against a stored JSON Schema (`pg_jsonschema` on Supabase — **ASSUMED**, §2.14). Nothing the prompt builder reads may live there.

```sql
create table staff_groups (             -- replaces the 3 hardcoded buckets at systemPromptBuilder.js:69-84
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null check (length(key) between 1 and 40),
  label      text not null check (label is normalized),   -- «Эмэгтэй үсчид» / «Мотор»
  sort_order int  not null default 0,
  primary key (tenant_id, key)
);

create table staff_members (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  group_key  text not null,
  full_name  text not null check (full_name is normalized),
  tier_key   text,
  active     boolean not null default true,
  sort_order int not null default 0,
  foreign key (tenant_id, group_key) references staff_groups (tenant_id, key),
  unique (tenant_id, id)
);

create table service_tiers (            -- 'Мастер' / '1-р зэрэг'; GS Auto may declare none
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null,
  label      text not null check (label is normalized),
  sort_order int not null default 0,
  primary key (tenant_id, key)
);

create table service_items (            -- prices as VALUES, not display strings
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  category       text,
  canonical_name text not null check (canonical_name is normalized),
  tier_key       text,
  tier_norm      text generated always as (coalesce(tier_key,'')) stored,   -- ← see below
  price_min      bigint,                                  -- NULL = deliberately unpriced
  price_max      bigint,
  currency       text not null default 'MNT' check (currency ~ '^[A-Z]{3}$'),
  unit           text not null default 'service',
  deposit_amount bigint,                                  -- was systemPromptBuilder.js:138-149 prose
  quotable       boolean not null default true,           -- false ⇒ never state a price
  active         boolean not null default true,
  search_key     text generated always as (app.mn_search_fold(canonical_name)) stored,
  check (price_min is null or price_max is null or price_min <= price_max),
  check (not quotable or price_min is not null),
  foreign key (tenant_id, tier_key) references service_tiers (tenant_id, key),
  unique (tenant_id, canonical_name, tier_norm),
  unique (tenant_id, id)
);
create index on service_items (tenant_id) where active;
create index on service_items using gin (search_key gin_trgm_ops);
```

`unique (tenant_id, canonical_name, coalesce(tier_key,''))` was the draft's second non-compiling block — **VERIFIED (executed):** `ERROR: syntax error at or near "("`. The `tier_norm` stored generated column fixes it and is visible in the catalog.

`price_min/price_max/currency` replaces `"66,000 – 88,000"` (`config/currentClient.js:38`). The en-dash string cannot be compared, summed, or validated — and Analytics AI must attribute revenue against these figures.

```sql
create table service_aliases (          -- «гель маникюр» → «Гелэн будалт» (systemPromptBuilder.js:136)
  tenant_id  uuid not null references tenants(id) on delete cascade,
  alias      text not null check (alias is normalized),
  service_id uuid not null,
  alias_key  text generated always as (app.mn_search_fold(alias)) stored,
  primary key (tenant_id, alias_key),
  foreign key (tenant_id, service_id) references service_items (tenant_id, id) on delete cascade
);

create table disambiguation_pairs (     -- «Сор» means two things (systemPromptBuilder.js:134)
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  ambiguous_term text not null check (ambiguous_term is normalized),
  term_key       text generated always as (app.mn_search_fold(ambiguous_term)) stored,
  unique (tenant_id, term_key),
  unique (tenant_id, id)
);

-- The uuid[] column is gone. This is the spine exception (a) from §2.2, closed.
create table disambiguation_candidates (
  tenant_id  uuid not null,
  pair_id    uuid not null,
  service_id uuid not null,
  sort_order int  not null default 0,
  primary key (tenant_id, pair_id, service_id),
  foreign key (tenant_id, pair_id)    references disambiguation_pairs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id) references service_items        (tenant_id, id) on delete cascade
);
```

`quotable = false` plus `price_min is null` is how "we deliberately do not price this" becomes a *value*. The refusal behaviour needs its own table:

```sql
create table refusal_rules (            -- children's haircuts, as DATA
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  topic_key     text not null,                    -- 'children_services'
  match_terms   text[] not null,                  -- NFC + folded at write time
  verbatim_response_id uuid not null,             -- → canned_responses
  quote_price   boolean not null default false,
  forbidden_phrases text[] not null default '{}', -- ← the bake-off technique, as a column
  active        boolean not null default true,
  approved_by   uuid references auth.users(id),
  approved_at   timestamptz,
  unique (tenant_id, topic_key),
  foreign key (tenant_id, verbatim_response_id) references canned_responses (tenant_id, id)
);
```

`match_terms` and `forbidden_phrases` are arrays of **text the model must not emit** — opaque strings, not row references, so they are outside exception (a).

`forbidden_phrases` is the transferable finding from the model bake-off (`docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`): *a rule that only describes the right answer loses to a model's disposition; a rule that forbids the specific wrong answer does not.* Taking Sonnet from 0/3 to 3/3 required promoting the rule to a first-line gate with an explicit decision step **and** naming the observed failure openings as forbidden. For Matrix, "refer to the salon phone" will lose; `forbidden_phrases = {'ойролцоогоор','баримжаагаар'}` plus a first-line gate will hold. The column exists so hardening a tenant is an `update`, and so the founder can only fill it in **after measuring the failure** — which is the actual discipline.

```sql
create table canned_responses (         -- every pinned Mongolian sentence, natively reviewed
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  slot        text not null check (slot in ('closing','handoff','fallback','booking',
                                            'refusal','greeting','closure')),
  variant_key text not null default 'default',
  locale      text not null default 'mn-MN',
  body        text not null check (body is normalized and length(body) between 1 and 900),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  active      boolean not null default true,
  unique (tenant_id, slot, variant_key, locale),
  unique (tenant_id, id)
);
create index on canned_responses (tenant_id) where active;
```

This is `CLOSING_LINE` (`lib/salonBrain.js:52`), `HANDOFF_REPLY` (`:57-59`), `FALLBACK_REPLY` (`:63-65`), `CHILDREN_REPLY` (`:70-72`) and `BOOKING_LINE` (`:79-81`) as rows. The reason they exist is in the source comments at `:48-51` and `:54-56`: live replies contained garbled Mongolian and an invented Russian word (`дополнительн`) in filler and apology positions, so **a human wrote each sentence and the model copies it letter for letter**. `reviewed_by`/`reviewed_at` exist because that human review is the whole value. Note `BOOKING_LINE` hardcodes `QPay-ээр` and `урьдчилгаа` (deposit); GS Auto Center may use neither.

```sql
create extension if not exists btree_gist;   -- REQUIRED for the constraint below

create table tenant_closures (          -- holiday breaks; replaces config/closures.js entirely
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  title      text not null check (title is normalized),
  verbatim_message text not null check (verbatim_message is normalized),
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (starts_on <= ends_on),
  exclude using gist (tenant_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
```

The draft's third non-compiling block. **VERIFIED (executed):** without `btree_gist`, `ERROR: data type uuid has no default operator class for access method "gist"`. With it, the table creates. `btree_gist` joins the required-extension list in V0.

Three properties of `config/closures.js` are preserved and now enforced by schema rather than prose: the customer-facing sentence is **never composed by the model** (`:22-26` — Mongolian date suffixes are not safely generated); the window is evaluated **per request** against the tenant's own timezone (`lib/salonBrain.js:139-155` deliberately keeps the closure section outside the cached prompt because a warm lambda can outlive the end of a break); and a malformed closure is **ignored with a warning** rather than announcing a wrong break (`:113-121`). Two things change: `SALON_UTC_OFFSET_MINUTES` becomes `tenants.timezone`, and **there is no default closure** — `config/closures.js:40-52` ships a hardcoded Naadam 2026-07-11..17 break with Matrix's message, which under multi-tenancy would apply to every tenant that did not override it.

### C. Knowledge base

Structured facts (services, staff, hours, contact) are the typed tables above and render directly into the prompt; free prose (intro, policies, FAQ bodies, uploads) is documents → chunks and is retrieved. Retrieval unions both.

```sql
create table knowledge_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('intro','faq','policy','service_notes','upload','web_page')),
  title       text not null check (title is normalized),
  locale      text not null default 'mn-MN',
  body        text not null check (body is normalized),   -- PLAIN TEXT. No HTML.
  source_uri  text,
  version     int  not null default 1,
  status      text not null default 'draft' check (status in ('draft','published','archived')),
  checksum    bytea not null,                              -- sha256(body) — drives re-chunking
  published_at timestamptz,
  created_by  uuid references auth.users(id),
  reviewed_by uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, kind, title, locale, version)
);
create index on knowledge_documents (tenant_id, status) where status = 'published';

create table knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  document_id uuid not null,
  ord         int  not null,
  body        text not null check (body is normalized),
  body_fold   text     generated always as (app.mn_search_fold(body)) stored,
  body_tsv    tsvector generated always as (to_tsvector('simple', app.mn_search_fold(body))) stored,
  embedding   vector(1536),
  embedding_model text,
  token_estimate int,
  created_at  timestamptz not null default now(),
  unique (tenant_id, document_id, ord),
  foreign key (tenant_id, document_id) references knowledge_documents (tenant_id, id) on delete cascade
);
create index on knowledge_chunks (tenant_id, document_id);
create index on knowledge_chunks (tenant_id) where embedding is not null;
create index on knowledge_chunks using gin (body_tsv);
create index on knowledge_chunks using gin (body_fold gin_trgm_ops);
```

Three decisions worth defending:

1. **`body` is plain text; markup is never stored.** `config/currentClient.js:91` stores `<br><br><a href=…>` inside an FAQ answer, which the website renders and `lib/messengerText.js` strips back out. Store the fact and the URL; let a per-channel renderer decide markup. The cost of getting this wrong is visible at `lib/salonBrain.js:86-106`: a 3,163-character Messenger addendum, roughly half of which exists to *undo* website-specific rules in the shared template. Two channels partially cancelling each other does not survive four AI roles.

2. **Retrieval, not full inlining.** The measured base prompt is 7,824 characters (12,866 bytes) for **40 services and 9 staff**. GS Auto Center's parts-and-labour catalogue cannot be inlined.

3. **No global HNSW index at launch, and retrieval only through a chokepoint function.** This is the review's sharpest finding and it is correct. The draft declared `create index on knowledge_chunks using hnsw (embedding vector_cosine_ops)` — one index spanning every tenant — and routed model retrieval through it on the path that runs as `service_role` with RLS off, outside the `withTenant()` chokepoint (which cannot express an ANN query). A hand-written `select body from knowledge_chunks order by embedding <=> $1 limit 8` is correct with one tenant and leaks Matrix's KB into a GS Auto customer's reply with two. Unlike every *write* path in this schema there is no FK, no trigger and no policy that fires; the first signal is a customer screenshot.

```sql
create or replace function app.search_kb(p_tenant uuid, p_embedding vector(1536), p_k int)
returns table (chunk_id uuid, body text, score real)
language sql stable security definer set search_path = '' as $$
  select c.id, c.body, (c.embedding <=> p_embedding)::real
  from public.knowledge_chunks c
  where c.tenant_id = p_tenant and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit least(greatest(p_k,1), 20)
$$;
revoke execute on function app.search_kb(uuid, vector, int) from public, anon, authenticated;
grant  execute on function app.search_kb(uuid, vector, int) to service_role;
```

and a CI grep — modelled on the sibling's `scripts/check-supabase-nostore.mjs` — banning `<=>`, `hnsw`, `gin_trgm_ops` and `to_tsvector` anywhere outside `supabase/migrations/` and the two search functions.

> **Where the review was wrong (2/5).** Its proposed remedy included a *"partial-index strategy"*. A per-tenant partial index is per-tenant DDL and fails the hard test — it is the schema-per-tenant mistake wearing an index's clothes. The correct escalation, when a tenant crosses roughly 50k chunks, is **hash partitioning `knowledge_chunks` on `tenant_id` with a per-partition HNSW**: the partition count is a fixed platform constant, so onboarding client #3 is still an insert. Until then, an exact scan inside the tenant is both correct and faster than a post-filtered ANN scan, which under-returns for small tenants and invites exactly the "raise the limit and filter in JS" fix that drops the predicate.

`vector(1536)` with an explicit `embedding_model`: a dimension change is a migration plus a backfill; recording the model makes "these rows were embedded by a different model" a query rather than a mystery. pgvector availability is **ASSUMED** — assert in V0.

### D. Conversation and delivery

#### `contacts` — the end customer. **PII.**

```sql
create table contacts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  channel_id   uuid not null,
  external_id  text not null,               -- PSID (page-scoped) or IGSID (IG-account-scoped)
  display_name text,                        -- PII, optional, from Graph
  phone_e164   text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  locale       text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  erasure_requested_at timestamptz,
  unique (tenant_id, channel_id, external_id),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade
);
create index on contacts (tenant_id, last_seen_at desc);
```

The unique key is `(tenant_id, channel_id, external_id)` and **not** `external_id` alone, because PSIDs are page-scoped and IGSIDs are Instagram-account-scoped: the same human messaging Matrix and GS Auto is two different identifiers, and identifiers from two providers must never be assumed disjoint.

#### `conversations` / `messages`

```sql
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  channel_id  uuid not null,
  contact_id  uuid not null,
  state       text not null default 'open' check (state in ('open','idle','handed_off','closed')),
  window_expires_at timestamptz,            -- Meta's 24h window
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  message_count int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references contacts        (tenant_id, id) on delete cascade
);
create index on conversations (tenant_id, last_inbound_at desc);
create unique index on conversations (tenant_id, contact_id) where state in ('open','idle');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null,
  direction       text not null check (direction in ('inbound','outbound')),
  author          text not null check (author in ('contact','ai','human','system')),
  provider_message_id text,                 -- Meta mid; NULL for internal
  body            text check (body is null or body is normalized),   -- PII; NULLed at retention
  body_redacted_at timestamptz,
  answered_by     text check (answered_by in ('shortcut','model','canned','human')),
  model_id        text,
  ledger_id       bigint,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, ledger_id)       references spend_ledger  (tenant_id, id)   -- NO ACTION
);
create index on messages (tenant_id, conversation_id, created_at);
create unique index on messages (tenant_id, provider_message_id) where provider_message_id is not null;
create index on messages (tenant_id, created_at) where body is not null;  -- drives the purge
```

`model_id` is a per-message fact, not a deployment constant. In the ancestor, model tier is `lib/salonBrain.js:19` (`claude-sonnet-5`) for Messenger and `api/chat.js:13` (`claude-haiku-4-5-20251001`, a stale date-suffixed id) for the website — two channels giving measurably different answer quality from one knowledge base, with the choice unrecorded per reply.

#### `webhook_events` — idempotency, and the deletion-proof fix

```sql
create table webhook_events (
  id           bigint generated always as identity primary key,
  provider     text not null references channel_providers(key),
  dedup_key    text not null,               -- message.mid | comment value.id
  tenant_id    uuid references tenants(id) on delete cascade,
  routing      text not null default 'routed' check (routing in ('routed','unrouted')),
  check ((routing = 'unrouted') = (tenant_id is null)),
  channel_id   uuid,
  event_type   text not null,
  raw_payload  jsonb,                       -- PII; purged at tenants.retention_days_raw_events
  raw_purged_at timestamptz,
  signature_ok boolean not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  outcome      text check (outcome in ('replied','shortcut','dropped_unrouted',
                                       'dropped_policy','duplicate','error')),
  unique (provider, dedup_key)              -- GLOBAL, deliberately
);
create index on webhook_events (tenant_id, received_at desc);
create index on webhook_events (received_at) where raw_payload is not null;
create index on webhook_events (received_at) where routing = 'unrouted';   -- the watchdog
```

The draft had `tenant_id … on delete set null` and the review is right that it was a disaster: at offboarding, up to 30 days of `webhook_events` rows containing verbatim customer conversations would survive `delete from tenants` with their `tenant_id` erased, the deletion-proof query `select count(*) … where tenant_id = :t` would return `0` **because the discriminator was just deleted**, and the former tenant's customer PII would land permanently in the unrouted-events queue the founder reviews for routing failures. `on delete cascade` plus an explicit `routing` discriminator closes both halves. (Under §2.8 the tenant row is never deleted at all, so the cascade is belt-and-braces — which is the right posture for a table holding raw PII.)

**The uniqueness scope is a real decision.** `unique (provider, dedup_key)` is global, not per-tenant. Meta mids are opaque and globally unique, so a collision across tenants means a bug or an attack — and a per-tenant key would let the same event be processed twice under two tenants, which is a double reply *and* double spend. The insert path is `insert … on conflict do nothing returning id`; if nothing returns, read the existing row, and **if its `tenant_id` differs from the resolved tenant, raise `webhook.dedup_cross_tenant` and alert** rather than quietly dropping.

This closes a specific ancestor defect: `lib/conversationStore.js:49-58` — `isAlreadyHandled` returns `false` on any Redis error, and `markHandled` (`:64-72`) silently no-ops. Fail-open dedup, defensible at one tenant because QStash's `deduplicationId: event.mid` (`lib/messengerQueue.js:66`) sits underneath — but both layers fail together in the case that matters: the degraded inline path (`api/messenger.js:147-154`) runs precisely when QStash is unconfigured or hard-failed, which is when there is no `deduplicationId` either. A DB unique constraint checked **before** the Anthropic call is the layer that does not fail open.

#### `outbound_messages` — every send, across every channel. The SMS seam.

```sql
create table outbound_policies (            -- [global] reference data
  channel               text primary key references channel_providers(key),
  window_hours          int,                -- 24 for messenger/instagram, NULL for sms
  free_form_outside_window boolean not null default false,
  template_required     boolean not null default true,
  ai_authored_allowed   boolean not null default true,
  per_message_cost_usd  numeric(12,6)       -- NULL means UNKNOWN, and unknown must REFUSE
);

create table outbound_messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  channel_id    uuid, conversation_id uuid, contact_id uuid,
  kind          text not null check (kind in ('reply','private_reply','comment_reply',
                                              'sms_reminder','sms_winback','sms_review_request')),
  dedup_key     text,                       -- e.g. the comment_id for a private reply
  to_phone_e164 text,                       -- PII; hashed after the retention window
  body          text check (body is null or body is normalized),
  template_id   text,
  state         text not null default 'draft'
                check (state in ('draft','refused','queued','sent','failed','expired')),
  refusal_code  text,   -- 'policy_forbids'|'budget_exhausted'|'cost_unknown'|'window_closed'
  unit_cost_usd numeric(12,6),
  deadline_at   timestamptz,                -- private reply: comment created_at + 7d − margin
  scheduled_for timestamptz, sent_at timestamptz,
  provider_message_id text, provider_error_code text
                check (provider_error_code is null or provider_error_code ~ '^[0-9]{1,6}$'),
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  check (state in ('draft','refused') or unit_cost_usd is not null),
  check (state <> 'refused' or refusal_code is not null),
  foreign key (tenant_id, channel_id)      references tenant_channels (tenant_id, id) on delete cascade,
  foreign key (tenant_id, conversation_id) references conversations   (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id)      references contacts        (tenant_id, id) on delete cascade
);
create unique index on outbound_messages (tenant_id, kind, dedup_key) where dedup_key is not null;
create index on outbound_messages (state, scheduled_for) where state = 'queued';
```

`check (state in ('draft','refused') or unit_cost_usd is not null)` makes it **impossible for a row to reach `queued` or `sent` with an unknown price** — the same reasoning that set `BANK_BUILD_BUDGET_USD` to zero next door: a value that refuses without depending on an unreliable read. `outbound_policies.per_message_cost_usd IS NULL` means "we do not know what Meta charges", and unknown must refuse, never default to zero.

The partial unique index on `(tenant_id, kind, dedup_key)` is what makes a **private reply** safe: single-use, non-idempotent, expiring — exactly one per comment ever, within 7 days clocked from the comment's creation. A duplicate queue delivery hits a database uniqueness violation, **not** a second Graph call and certainly not a second Anthropic generation. `deadline_at` is checked *before* generation, because a free check that prevents spend belongs in the same fail-closed ordering as identity → entitlement → budget.

**Customer Care AI, plainly:** the legacy message tags it would have used were retired 2026-04-27 (requests carrying them return error `100`), and the surviving 7-day `HUMAN_AGENT` extension forbids AI-authored text. So `outbound_policies` ships with `messenger`/`instagram` rows carrying `free_form_outside_window = false`, `ai_authored_allowed = false`, `per_message_cost_usd = null` — and the SMS row exists with `window_hours = null` but **no channel binding**, because the Mongolian SIP trunk does not exist. The seam is a row and two constraints. No code branches on it.

#### `booking_handoffs`

```sql
create table booking_handoffs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null, contact_id uuid not null,
  link_sent       text not null,
  service_id      uuid, staff_id uuid, deposit_quoted bigint,
  outcome         text not null default 'link_sent'
                  check (outcome in ('link_sent','confirmed_by_tenant','no_show','abandoned','unknown')),
  outcome_source  text check (outcome_source in ('tenant_manual','tenant_import','inferred')),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id)      references contacts      (tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id)      references service_items (tenant_id, id) on delete restrict,
  foreign key (tenant_id, staff_id)        references staff_members (tenant_id, id) on delete restrict
);
create index on booking_handoffs (tenant_id, created_at desc);
```

`outcome_source` exists so Analytics AI's "bookings driven" figure can never silently blend an inferred number with a confirmed one. `outcome = 'unknown'` is the honest default when the tenant's booking site tells us nothing — and it must be reported as unknown, not rounded to zero.

### E. Money — the tables that must never be wrong

#### `spend_budgets`

```sql
create table spend_budgets (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  scope         text not null check (scope in ('monthly_usd','daily_usd','per_conversation_usd')),
  limit_usd     numeric(12,6) not null check (limit_usd >= 0),
  on_exhausted  text not null default 'canned_reply'
                check (on_exhausted in ('hard_stop','canned_reply','overage_bill')),
  effective_from timestamptz not null default now(),
  set_by        uuid references auth.users(id),
  primary key (tenant_id, scope)
);
```

`limit_usd >= 0`, not `> 0`: **zero is a legal, meaningful value** — the one that refuses without depending on any read.

#### `spend_ledger` — append-only, one row per upstream call

```sql
create table spend_ledger (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id) on delete restrict,   -- NOT cascade (§2.2c)
  occurred_at   timestamptz not null default now(),
  provider      text not null check (provider in ('anthropic','openai','meta','sms','deepgram')),
  model_id      text,                                  -- 'claude-sonnet-5' — never a date suffix
  purpose       text not null check (purpose in ('reception_reply','quality_review',
                                     'analytics_report','kb_embedding','outbound_compose')),
  conversation_id uuid,                                -- DENORMALISED, no FK. Written exception (§2.2c).
  input_tokens  int, output_tokens int,
  cache_read_tokens int, cache_write_tokens int,
  cost_usd      numeric(14,6) not null check (cost_usd >= 0),
  pricing_version text not null,                       -- so a repricing cannot rewrite history
  request_id    text check (request_id is null or request_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  unique (tenant_id, id)                               -- makes the composite FK expressible
);
create index on spend_ledger (tenant_id, occurred_at desc);
create index on spend_ledger (tenant_id, purpose, occurred_at desc);
```

#### The append-only guarantee — what it actually is, after the review

The draft claimed: *"triggers fire for every role, superusers included … this is the honest answer to what is the last line of defence."* Half of that was false, and the half that was false was the important half.

**VERIFIED (executed), the draft's exact DDL:**

```
set role service_role;
update spend_ledger set cost_usd = 0;
  ERROR:  append-only table spend_ledger: UPDATE is not permitted     ← trigger works
truncate spend_ledger;
  TRUNCATE TABLE                                                       ← no error
select count(*) from spend_ledger;  →  0
```

A `before update or delete … for each row` trigger **does not fire on TRUNCATE**, and §2.6 left `TRUNCATE` in `service_role`'s grant — the section spent a page proving `revoke insert, update, delete` is not "cannot write" and then applied the lesson only to `anon`/`authenticated`. A leaked `sb_secret_worker` key, or one bad line in the purge job, erases the entire spend ledger and audit log in one statement; nothing raises, nothing is logged (the audit log is the thing being truncated), and the catalog afterwards is byte-identical to a healthy system. **Every V-query in the draft passed.**

The fix, all four parts **VERIFIED (executed)**:

```sql
create or replace function ops.deny_mutation() returns trigger
  language plpgsql as $$ begin
    raise exception 'append-only table %: % is not permitted', tg_table_name, tg_op
      using errcode = 'insufficient_privilege';
  end $$;

create trigger spend_ledger_append_only before update or delete on spend_ledger
  for each row       execute function ops.deny_mutation();
create trigger spend_ledger_no_truncate before truncate on spend_ledger
  for each statement execute function ops.deny_mutation();
alter table spend_ledger enable always trigger spend_ledger_append_only;
alter table spend_ledger enable always trigger spend_ledger_no_truncate;
revoke truncate on spend_ledger, audit_log from service_role;
-- identical block for audit_log
```

```
set role service_role; truncate spend_ledger;
  ERROR:  append-only table spend_ledger: TRUNCATE is not permitted     ← trigger
revoke truncate on spend_ledger from service_role;
set role service_role; truncate spend_ledger;
  ERROR:  permission denied for table spend_ledger                      ← privilege
select count(*) from spend_ledger;  →  1                                ← row survived
```

> **Where the review was wrong (3/5).** It also demonstrated `alter table … disable trigger` and inferred a `service_role` risk. **VERIFIED (executed):** as `service_role`, `alter table spend_ledger disable trigger spend_ledger_append_only` → `ERROR: must be owner of table spend_ledger`. `ALTER TABLE` requires ownership and `service_role` is not the owner. The `tgenabled` assertion and `ENABLE ALWAYS` are still worth having — they catch operator error and a `postgres`-level compromise, and `ALWAYS` survives `session_replication_role = 'replica'` — but the finding's teeth are entirely in TRUNCATE, and it is right that **no verification query in the draft covered triggers at all**. V12's fingerprint spanned RLS flags, policies, ACLs and functions; dropping both triggers produced an *identical* fingerprint. V13 (§2.11) fixes that.

**So the honest statement of the guarantee is:** `spend_ledger` and `audit_log` are append-only against `service_role` for UPDATE, DELETE and TRUNCATE, by trigger **and** by privilege, with the trigger state itself fingerprinted. They are not append-only against `postgres`. And because referential actions fire triggers (§2.2c), nothing may cascade or set-null into them — which is why `conversation_id` has no FK and `tenant_id` is `restrict`.

`model_pricing` **[global]** (`model_id, pricing_version, input_usd_per_mtok, output_usd_per_mtok, cache_read_multiplier, cache_write_multiplier, effective_from`) is a reference table so a price change is an insert. The ledger stores the **computed** cost plus the `pricing_version` used, so a repricing can never silently rewrite history. Cache-token columns exist because a cache miss is invisible in the reply and quietly bills full price; the ancestor already logs these at `lib/salonBrain.js:249-253` — carrying that instinct into a queryable column is the upgrade.

#### `usage_counters`, and the budget gate that actually refuses

```sql
create table usage_counters (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  metric       text not null check (metric in ('ai_replies','ai_usd','inbound_events',
                                               'outbound_sms','kb_embeddings')),
  window_kind  text not null check (window_kind in ('minute','day','month')),
  window_start timestamptz not null,
  value        numeric(16,6) not null default 0 check (value >= 0),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, metric, window_kind, window_start)
);
```

The draft's `app.bump_usage(...)` claimed *"increments and returns the new value in a single statement, so two concurrent replies cannot both read 'under budget'."* The review is right that this is false, and the reasoning is worth stating because it is the difference between having a ceiling and appearing to. **Atomicity of the increment buys nothing when the decision is a separate earlier `select`.** `bump_usage` took no limit and had no refusal branch. And `p_delta` cannot be the real cost, because output tokens are unknown until after the call — so the increment necessarily happens *after* the money is spent.

Concretely: Matrix at $24.90 of a $25.00 monthly budget, forty inbound events in two seconds (a viral post, or the ancestor's known duplicate delivery). All forty guards read $24.90, all forty pass, all forty call Sonnet 5, the tenant lands near $36, and `on_exhausted` is never consulted. Non-negotiable #5 is not satisfied.

Second, independent defect in the same object: `p_window timestamptz` was **caller-supplied and constrained by nothing**. `tenants.timezone` exists so a "month" is local, so a dashboard reading in `Asia/Ulaanbaatar` and a worker computing in UTC produce different `window_start` values and silently create two PK rows per tenant per period. **VERIFIED (executed):** `date_trunc('day', now() at time zone 'Asia/Ulaanbaatar') at time zone 'Asia/Ulaanbaatar'` = `2026-08-30 16:00:00+00`; the UTC equivalent = `2026-08-31 00:00:00+00`. Two different rows, half the ceiling each.

**Reserve-then-reconcile.** The decision and the increment are one statement, and the window is derived *inside* the database so caller disagreement is impossible:

```sql
create or replace function app.reserve_usage(p_tenant uuid, p_metric text, p_kind text,
                                             p_scope text, p_reserve numeric)
returns table (allowed boolean, new_value numeric, cap numeric)
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_window timestamptz; v_limit numeric; v_new numeric;
begin
  select t.timezone into strict v_tz from public.tenants t where t.id = p_tenant;
  v_window := (date_trunc(p_kind, (now() at time zone v_tz)) at time zone v_tz);
  select b.limit_usd into v_limit from public.spend_budgets b
   where b.tenant_id = p_tenant and b.scope = p_scope;
  if v_limit is null then                      -- no budget row ⇒ REFUSE, never default to 0
    return query select false, null::numeric, null::numeric; return;
  end if;
  insert into public.usage_counters as u (tenant_id, metric, window_kind, window_start, value)
  select p_tenant, p_metric, p_kind, v_window, p_reserve where p_reserve <= v_limit
  on conflict (tenant_id, metric, window_kind, window_start)
  do update set value = u.value + p_reserve, updated_at = now()
     where u.value + p_reserve <= v_limit
  returning u.value into v_new;
  if v_new is null then                        -- conditional DO UPDATE declined ⇒ over ceiling
    select u.value into v_new from public.usage_counters u
     where u.tenant_id=p_tenant and u.metric=p_metric
       and u.window_kind=p_kind and u.window_start=v_window;
    return query select false, coalesce(v_new,0::numeric), v_limit; return;
  end if;
  return query select true, v_new, v_limit;
end $$;
revoke execute on function app.reserve_usage(uuid,text,text,text,numeric) from public, anon, authenticated;
grant  execute on function app.reserve_usage(uuid,text,text,text,numeric) to service_role;
```

**VERIFIED (executed)**, $1.00 monthly ceiling, five successive `0.30` reservations:

```
 i | allowed | new_value |   cap
---+---------+-----------+----------
 1 | t       |  0.600000 | 1.000000
 2 | f       |  0.900000 | 1.000000      ← refuses at the ceiling
 3 | f       |  0.900000 | 1.000000
 …
=== no budget row for 'daily_usd' => refuse (fail closed) ===
 allowed | new_value | cap
 f       |           |
```

`insert … on conflict do update` takes a row lock, so concurrent calls on the same key serialise; the conditional `WHERE` on `DO UPDATE` is what makes zero-rows-returned mean *refused*, not *error*. The call sequence is: **reserve a worst-case estimate → make the upstream call → write `spend_ledger` with the real cost → reconcile the delta.** Any exception from `reserve_usage` is a **503**, never `try { check() } catch { continue }`. That exact pattern was the HIGH finding next door; here it costs *another tenant's* money, which is worse because it is not yours to lose.

**Every function is a migration file, no exceptions.** The sibling audit records `increment_chat_usage` / `increment_ielts_usage` as *invoked but defined nowhere in the repo* — "the database cannot be reproduced from the repo, and their `security definer` / `search_path` properties cannot be reviewed" (`security-audit-2026-08-23.md:232-234`). V10 catches exactly this.

### F. Quality, analytics, and audit

```sql
create table quality_reviews (          -- internal only. Never client-facing.
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  conversation_id uuid, message_id uuid,
  verdict       text not null check (verdict in ('ok','unanswered','wrong_fact','policy_breach',
                                                 'language_quality','price_leak')),
  severity      text not null default 'low' check (severity in ('low','medium','high')),
  rationale     text,                   -- MAY QUOTE A CUSTOMER — treated as PII (§2.7, §2.8)
  reviewer      text not null check (reviewer in ('model','founder')),
  model_id      text, ledger_id bigint,
  founder_agrees boolean,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, message_id)      references messages      (tenant_id, id) on delete cascade,
  foreign key (tenant_id, ledger_id)       references spend_ledger  (tenant_id, id)
);
create index on quality_reviews (tenant_id, created_at desc) where verdict <> 'ok';

create table kb_change_proposals (      -- proposed KB updates. NEVER auto-applied.
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  target_kind  text not null check (target_kind in ('knowledge_document','service_item',
                                   'canned_response','refusal_rule','service_alias','faq')),
  target_id    uuid,                    -- polymorphic: written exception in V16's allow-list
  proposed_patch jsonb not null,
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected','applied','superseded')),
  proposed_by  text not null default 'quality_ai',
  approved_by  uuid references auth.users(id), approved_at timestamptz, applied_at timestamptz,
  applied_audit_id bigint,
  created_at   timestamptz not null default now(),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  check (status <> 'applied'  or (approved_by is not null and applied_at  is not null)),
  unique (tenant_id, id),
  foreign key (tenant_id, applied_audit_id) references audit_log (tenant_id, id)
);
create index on kb_change_proposals (tenant_id, status) where status = 'pending';

-- evidence_review_ids uuid[] is gone: spine exception (a), closed.
create table kb_proposal_evidence (
  tenant_id   uuid not null,
  proposal_id uuid not null,
  review_id   uuid not null,
  primary key (tenant_id, proposal_id, review_id),
  foreign key (tenant_id, proposal_id) references kb_change_proposals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, review_id)   references quality_reviews     (tenant_id, id) on delete cascade
);
```

The two `check` constraints are the founder-approval gate expressed as a database constraint rather than application discipline. A row cannot be `applied` without an `approved_by`. Combined with a `before update` trigger forbidding `pending → applied` in one step, the Quality layer **cannot** auto-apply even through a service-role bug.

```sql
create table analytics_reports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  period_start date not null, period_end date not null,
  conversations_total int not null, unique_contacts int not null,
  bookings_link_sent int not null, bookings_confirmed int not null,
  revenue_attributed_mnt bigint,
  attribution_basis text not null check (attribution_basis in ('tenant_confirmed','inferred','none')),
  ai_cost_usd  numeric(12,6) not null,
  narrative    text, model_id text, ledger_id bigint,
  generated_at timestamptz not null default now(),
  unique (tenant_id, period_start, period_end),
  foreign key (tenant_id, ledger_id) references spend_ledger (tenant_id, id)
);

create table audit_log (                -- append-only. Who did what, when.
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_kind  text not null check (actor_kind in ('user','service','founder','system','trigger')),
  actor_user_id uuid,
  tenant_id   uuid references tenants(id) on delete restrict,   -- NULL for platform actions
  action      text not null,
  target_table text, target_id text,
  before_snapshot jsonb, after_snapshot jsonb,
  request_id  text, ip_hash bytea,      -- hashed, never raw
  check (before_snapshot::text !~ 'EAA[A-Za-z0-9_-]{30,}'),   -- TRIPWIRE, not a boundary
  check (after_snapshot::text  !~ 'EAA[A-Za-z0-9_-]{30,}'),
  unique (tenant_id, id)
);
create index on audit_log (tenant_id, at desc);
create index on audit_log (action, at desc);
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function ops.deny_mutation();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function ops.deny_mutation();
alter table audit_log enable always trigger audit_log_append_only;
alter table audit_log enable always trigger audit_log_no_truncate;

-- Snapshots are permitted ONLY for config/KB tables. Enforced, not asked for.
create or replace function ops.audit_snapshot_class_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c text;
begin
  if new.before_snapshot is null and new.after_snapshot is null then return new; end if;
  select k.class into c from ops.table_security_class k where k.table_name = new.target_table;
  if c is null or c not in ('tenant_authored','approval_gated') then
    raise exception 'audit snapshots are not permitted for target_table % (class %)',
      new.target_table, coalesce(c,'undeclared') using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger audit_log_snapshot_guard before insert on audit_log
  for each row execute function ops.audit_snapshot_class_guard();
```

> **Where the review was right, and where its conclusion overshoots (4/5).** It is correct that the `EAA…` check is a **deny-list** — base64, a split value, JSON nesting, or an Instagram-Login `IGA…` token all pass — and that the draft's sentence "a constraint that refuses the insert is stronger than a code review" describes it as a boundary. It is not a boundary; it is a tripwire, and it is kept as one, relabelled. But the review's implied conclusion — that a deny-list is the `sanitizeForPrompt` mistake — does not carry all the way: `sanitizeForPrompt` was *relied upon* as the control against an adversary who could see it (`security-audit-2026-08-23.md:228-231`), whereas this constraint guards against **your own future logging code**, which is not adversarial. A tripwire against your own mistakes is worth keeping; a tripwire against an attacker is not. The real fix is the one the review named and the draft omitted: **allow-lists where an allow-list exists** — now on `tenant_secrets.last_error_code`, `outbound_messages.provider_error_code` and `spend_ledger.request_id` — plus the snapshot class guard above, which *is* a boundary because it is an allow-list over a value the writer controls.

```sql
create table channel_health (
  channel_id      uuid primary key,
  tenant_id       uuid not null,
  last_webhook_at timestamptz, last_send_ok_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[0-9]{1,6}$'),
  last_error_at   timestamptz,
  consecutive_send_failures int not null default 0,
  subscription_verified_at timestamptz,
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade
);

create table contact_erasure_requests (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  contact_id uuid, external_id text,
  source     text not null check (source in ('meta_callback','tenant_request','customer_direct')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz, rows_deleted jsonb
);

create table tenant_offboardings (
  tenant_id     uuid primary key references tenants(id) on delete restrict,
  export_manifest_sha256 bytea,
  scheduled_purge_at timestamptz not null,
  purged_at     timestamptz,
  row_counts_before jsonb not null,     -- {"messages": 14231, "contacts": 604, ...}
  row_counts_after  jsonb,
  requested_by  uuid, confirmed_by uuid
);
```

`tenant_offboardings` now references `tenants` — because §2.8 no longer deletes the tenant row. The draft's detached tombstone existed only to survive a `delete from tenants` that turns out to be impossible anyway (§2.2c).

### Onboarding client #3 — the falsifiable test

GS Auto Center, end to end, touching **zero lines of code**:

```sql
insert into tenants (slug, display_name, timezone) values ('gs-auto','GS Auto Center','Asia/Ulaanbaatar');
insert into tenant_channels (tenant_id, provider, external_id, auth_flavour)
  values (:t,'facebook_page','1029…','facebook_login');
-- token via the admin route → tenant_secrets (encrypted; never a column, never an env var)
insert into staff_groups  values (:t,'engine','Мотор',1),(:t,'chassis','Явах анги',2),(:t,'electrical','Цахилгаан',3);
insert into service_tiers values (:t,'std','Стандарт',1);
insert into service_items (tenant_id, canonical_name, tier_key, price_min, price_max)
  values (:t,'Тос солих','std',35000,55000);
insert into canned_responses (tenant_id, slot, body, reviewed_by) values (:t,'handoff','…',:founder);
insert into knowledge_documents (tenant_id, kind, title, body, status)
  values (:t,'intro','Танилцуулга','…','published');
insert into spend_budgets values (:t,'monthly_usd',25.00,'canned_reply');
insert into ops.table_security_class ... -- nothing: classes are per-table, not per-tenant
```

No `gender` field abused for a service line. No hardcoded headings. No deposit table in a shared template. If client #3 needs something these tables cannot express, **add a column — never a branch**.

---

## 2.5 Server-owned tables, and why ownership RLS is not enough

### The principle

RLS answers exactly one question: *does this row belong to this caller?* It has no opinion about **what the row says**. That is the finding from next door, at `security-audit-2026-08-23.md:126-130`:

> **Read-only** (`usage_limits`, `progress`, `test_history`, `certificates`) — the row is an *assertion about the user* that the product treats as true. Ownership is not integrity: an own-row policy checks *who* the row belongs to, never *what it says*.

Concretely, next door: a user with an own-row write policy on `certificates` could write themselves a band-9 IELTS result. Every policy passed. Every row belonged to its writer. The system was still lying.

Dala AI's version: a tenant owner sets `usage_counters.value = 0` and gets unlimited AI replies; or `tenants.plan = 'full'`; or `analytics_reports.revenue_attributed_mnt = 9_000_000` to show an investor; or `spend_ledger.cost_usd = 0`. In every case ownership RLS is satisfied and the product is wrong.

**Rule:** if the *server* derives the value, the client gets `SELECT` and nothing else — regardless of whose row it is.

### The classification is a TABLE, not prose

This is the review's most structurally important finding and it is right. The draft carried the classification twice — once as a markdown table, once as a hand-maintained `server_owned text[]` inside a `DO` block — and the two had already drifted. Worse, **the verification pack had nowhere to compare the catalog to a declaration of intent.** V7 flags a policy only when its body *fails* to mention `tenant_id`; the dangerous policy mentions it in both clauses.

**Demonstrated by the review, and the mechanism is exact:** copy the §2.7 *tenant-authored* policy template onto `usage_counters` (the two templates differ by one word and sit four paragraphs apart), grant DML, and every check in the draft's pack passes — V2 returns zero rows, V7 does not flag it, V5 shows `usage_counters | authenticated | DELETE,INSERT,SELECT,UPDATE` indistinguishable from the eleven tables where that is correct — while `update usage_counters set value = 0` succeeds and `delete from usage_counters` empties the tenant's AI-spend counter.

So the classification becomes data, and it drives both the DDL and the gate:

```sql
create table ops.table_security_class (
  table_name text primary key,
  class      text not null check (class in ('server_owned','secret','platform',
                                            'tenant_authored','approval_gated')),
  note       text
);

create table ops.tenant_scope (          -- which column carries the tenant, per table
  table_name    text primary key references ops.table_security_class(table_name),
  tenant_column text not null            -- 'tenant_id' everywhere except tenants('id')
);
```

| Class | Tables | Client rights |
|---|---|---|
| **server_owned** — the row asserts something the server derived | `tenants`, `tenant_members`, `spend_ledger`, `spend_budgets`, `usage_counters`, `analytics_reports`, `quality_reviews`, `webhook_events`, `outbound_messages`, `booking_handoffs`, `messages`, `conversations`, `contacts`, `audit_log`, `channel_health`, `tenant_offboardings`, `contact_erasure_requests`, `knowledge_chunks` | `SELECT` own tenant only, **plus per-command restrictive denies** |
| **secret** — the row is a credential | `tenant_secrets` | **nothing at all**; not even `SELECT`. `service_role` reaches it via `BYPASSRLS`. |
| **platform** | `platform_admins`, `channel_providers`, `model_pricing`, `outbound_policies` | `SELECT` on the three reference tables; `platform_admins` admin-read-only. All four carry the restrictive denies. |
| **tenant_authored** | `knowledge_documents`, `service_items`, `service_tiers`, `service_aliases`, `staff_groups`, `staff_members`, `canned_responses`, `tenant_closures`, `disambiguation_pairs`, `disambiguation_candidates` | own-tenant CRUD with `WITH CHECK` repeating the tenant predicate |
| **approval_gated** | `refusal_rules`, `kb_change_proposals`, `kb_proposal_evidence`, `tenant_channels` | `SELECT` own tenant; writes via service-role routes only |

`messages`, `conversations` and `contacts` are server-owned even though they are "the tenant's customers". The tenant did not author a customer's message; the platform recorded it. A tenant that can edit `messages.body` can fabricate a conversation, which breaks Quality, breaks Analytics, and breaks any dispute.

`refusal_rules` is approval-gated on purpose: "never quote a price for X; say this instead" is simultaneously the most valuable and most dangerous knob in the product. §2.15 Q5 puts the self-serve-vs-approval choice to the founder; the schema supports either by moving one row in `ops.table_security_class` and changing nothing else. **That is now literally true** — the lockdown reads the table.

### The lockdown

Two facts change the shape from what the sibling shipped, both **VERIFIED (research)**:

**Fact 1 — `as restrictive for all using (true) with check (false)` does not stop `DELETE`.** With client DML grants and a permissive own-tenant write policy present: INSERT → error, UPDATE → error, **DELETE → `DELETE 1`**. `DELETE` has no `WITH CHECK`; it is governed by `USING`, and that policy's `USING` is `true`. Next door the hole is masked twice (no permissive write policy, no `DELETE` grant), so it is **not a live finding there** — but it must not be copied forward unexamined.

**Fact 2 — `for all` applies `USING` to `SELECT`.** So `as restrictive for all using (false)` would silently blind the dashboard. Never collapse the three.

```sql
-- ops/lock_by_class.sql — driven by ops.table_security_class, which IS the boundary.
do $$
declare r record;
begin
  for r in select table_name, class from ops.table_security_class
           where class in ('server_owned','secret','platform','approval_gated')
  loop
    execute format('alter table public.%I enable row level security', r.table_name);

    -- Actively remove the shapes this class forbids. Idempotence is not enough.
    execute format('drop policy if exists %I on public.%I', r.table_name||'_insert_own', r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name||'_update_own', r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name||'_delete_own', r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name||'_rw_own',     r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name||'_no_client_insert', r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name||'_no_client_update', r.table_name);
    execute format('drop policy if exists %I on public.%I', r.table_name||'_no_client_delete', r.table_name);

    execute format($f$create policy %I on public.%I
      as restrictive for insert to anon, authenticated with check (false)$f$,
      r.table_name||'_no_client_insert', r.table_name);
    execute format($f$create policy %I on public.%I
      as restrictive for update to anon, authenticated using (false) with check (false)$f$,
      r.table_name||'_no_client_update', r.table_name);
    execute format($f$create policy %I on public.%I
      as restrictive for delete to anon, authenticated using (false)$f$,
      r.table_name||'_no_client_delete', r.table_name);

    -- Privileges, not just policies. ALL of them, enumerated by the server.
    execute format('revoke all on public.%I from anon, authenticated', r.table_name);
    if r.class <> 'secret' then
      execute format('grant select on public.%I to authenticated', r.table_name);
    end if;
  end loop;
end $$;
```

The explicit `drop policy if exists … _rw_own` lines exist because the sibling's exact regression was a `schema.sql` policy loop that **recreated** the permissive own-row write policies the lockdown had revoked (`security-audit-2026-08-23.md:111-113`); any environment provisioned from that file alone reproduced the original CRITICAL and HIGH findings intact.

---

## 2.6 The grant model

### Migration `0001`, before any table exists

Supabase's bootstrap runs `grant all on all tables in schema public to anon, authenticated` and sets matching **default privileges**. That is the source of the residue found next door (`security-audit-2026-08-23.md:418-419`): after two lockdown migrations revoked `INSERT/UPDATE/DELETE`, the raw ACL still read

```
{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=rDxtm/postgres,service_role=arwdDxtm/postgres}
```

`Dxtm` = **TRUNCATE, REFERENCES, TRIGGER, MAINTAIN** — four privileges nobody revoked, on the four most sensitive tables, for months. `TRUNCATE` **bypasses RLS entirely** (VERIFIED (research)). The only thing standing between `authenticated` and an empty table was PostgREST declining to expose the verb — an API-surface decision, not a privilege boundary.

```sql
-- Default privileges are PER CREATING ROLE. CLI migrations run as postgres.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- anon has NO business in this product. Sign-in goes through GoTrue, not PostgREST.
revoke usage on schema public from public;                 -- ← the entry that ACTUALLY holds it
grant  usage on schema public to authenticated, service_role;

create schema app;  create schema ops;
revoke all on schema app, ops from public, anon, authenticated;
grant usage on schema app to authenticated;                -- policy helpers, evaluated as the caller
grant usage on schema app to service_role;                 -- ← WITHOUT THIS, EVERY BUDGET CHECK 500s
grant usage on schema ops to service_role;
```

Three corrections here, all from the review and all **VERIFIED (executed)**:

**(a) `revoke usage on schema public from anon` is a no-op.** The default `public` ACL carries `=U/pg_database_owner` — a grant to `PUBLIC`, which every role inherits.

```
nspacl before: {pg_database_owner=UC/…, =U/…, service_role=U/…, authenticated=U/…, anon=U/…}
revoke usage on schema public from anon;
nspacl after:  {pg_database_owner=UC/…, =U/…, service_role=U/…, authenticated=U/…}   ← visibly changed
has_schema_privilege('anon','public','USAGE')  →  t                                  ← unchanged
```

The ACL text moves and the privilege does not. That is the same "plausible answer" shape as `information_schema` and `aclexplode(NULL)`, and it is the reason V14 tests `has_schema_privilege()` and not the ACL string. `revoke … from public` then explicit grants gives `anon → f`, `authenticated → t`, `service_role → t`.

> **Where the review was slightly imprecise (5/5).** It said the draft's invariant "would be reported as satisfied forever". The *table*-level half of that invariant ("`anon` appears in zero ACL rows and zero policies") is genuinely checked by V3/V5/V9. The false and unchecked half is the schema-level statement. Practical blast radius on day one is small — no table grant survives — but the sentence was untrue and nothing tested it, which is exactly the failure this section is organised around.

**(b) `service_role` has no `USAGE` on a freshly created schema.** `service_role` is `BYPASSRLS`, not superuser, and a new schema grants nothing to anyone but its owner.

```
select nspacl is null from pg_namespace where nspname='app';   →  t   (owner-implicit, aclexplode returns 0 rows)
has_schema_privilege('service_role','app','USAGE');            →  f
set role service_role; select app.bump_usage(1);
  ERROR:  permission denied for schema app
```

Without the grant, **every budget check fails at runtime with a permission error**. Best case a hard 503 on every inbound message; worst case someone reaches for `try { bump() } catch { continue }` at 2 a.m., which is the exact HIGH finding this design exists to avoid. Note also that `app`/`ops` have a NULL `nspacl` — the same trap V3 closes for tables and the draft left open for schemas.

**(c) `pg_default_acl` is invisible.** VERIFIED (executed): zero rows before configuration and zero rows after `alter default privileges … revoke all`. The two states are indistinguishable, and a default-privilege entry left behind for a *different* creating role (`supabase_admin`, `supabase_auth_admin`) would be silently in force. V14b enumerates it.

**Operational caveat, and it is real:** `revoke usage on schema public from public` on a live Supabase project can disturb internal roles. Apply it on a branch or shadow database first, then run V14a for every Supabase role (`anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`, `dashboard_user`) and grant back explicitly what is needed. Doing this at `0001` is far cheaper than discovering it at tenant #3.

**The resulting invariant, now checkable in full:** *`anon` holds no privilege on any table, view, function or schema, and appears in no policy.* V5, V11 and V14a assert it.

### Supabase's 2026 key model

Start on the new keys on day one. Legacy `anon`/`service_role` JWTs work until end-2026, but `sb_publishable_…` / `sb_secret_…` are **individually named and revocable**, and you can mint **one secret key per backend component**: `webhook-ingest`, `worker`, `analytics`, `admin`, `purge`, `ci`. A leak from the Meta webhook path then forces **one** rotation, not a full-project one. Do the JWT-signing-keys migration at project creation, when there is nothing to break. (VERIFIED (research); note the gotcha: new keys go on the `apikey` header, and sending one as `Authorization: Bearer` is parsed as a JWT and rejected.)

---

## 2.7 The RLS policy set

### Helper functions

```sql
create or replace function app.current_tenant_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.tenant_id), '{}')
  from public.tenant_members m
  where m.user_id = (select auth.uid()) and m.status = 'active'
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins a
                 where a.user_id = (select auth.uid()) and a.revoked_at is null)
$$;

create or replace function app.admin_may_read_bodies() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins a
                 where a.user_id = (select auth.uid()) and a.revoked_at is null
                   and a.can_read_message_bodies)
$$;

revoke execute on function app.current_tenant_ids(), app.is_platform_admin(),
                           app.admin_may_read_bodies() from public, anon;
grant  execute on function app.current_tenant_ids(), app.is_platform_admin(),
                           app.admin_may_read_bodies() to authenticated;
```

`set search_path = ''` is **mandatory** on any `SECURITY DEFINER` function — without it the function is a privilege-escalation primitive, and every object reference must be schema-qualified.

**Why `SECURITY DEFINER` and not an inline `EXISTS` join.** A policy that joins `tenant_members` evaluates that join **under `tenant_members`'s own RLS**. If `tenant_members` has RLS enabled and no `authenticated` policy, the join returns nothing and **the outer query returns zero rows with no error**. VERIFIED (research):

```
 Seq Scan on perf_rows (actual rows=0 loops=1)
   Rows Removed by Filter: 200000
   SubPlan 2
     ->  Seq Scan on tenant_members tm (actual rows=0 loops=1)
           Filter: (false AND (user_id = …))    -- the deny-all policy collapsed to false
 Execution Time: 3599.326 ms
```

An empty dashboard, 3.6 seconds, HTTP 200, `error: null`. And note `tenant_members` is now server-owned (§2.4-A), which means it *has* a deny-all posture for writes — making the definer function not an optimisation but a correctness requirement.

### The predicate shape

VERIFIED (research), 200k rows, PG 16.13:

| Policy predicate | Index? | Plan | Time |
|---|---|---|---|
| `tenant_id = (auth.jwt()->>'tenant_id')::uuid` | no | Seq Scan | 224.5 ms |
| `tenant_id = (select (auth.jwt()->>'tenant_id')::uuid)` | no | Seq Scan + InitPlan | 15.1 ms |
| `tenant_id = (select …)` | yes | **Index Only Scan** | 8.8 ms |
| **`tenant_id = any ((select app.current_tenant_ids())::uuid[])`** | yes | **Index Only Scan** | **7.0 ms** |
| `(select app.current_tenant_ids()) @> array[tenant_id]` | yes | **Seq Scan** — containment is not an index condition | 54.7 ms |

Three rules. The `(select …)` wrap is free and sometimes worth 15× (Supabase lint `0003_auth_rls_initplan`); it is not the 100× folklore claims, but you cannot predict which query loses its index. `= scalar` and `= ANY(array)` are index conditions; `array @> array[col]` is not. And `tenant_id` must **lead** an index on every tenant-scoped table — `(tenant_id, created_at desc)` where you always filter twice.

One parenthesisation trap: `= any ((select f()))` parses as `= ANY (subquery)` and fails with `operator does not exist: uuid = uuid[]`. The `::uuid[]` cast forces the array-expression reading.

**Name the role in every policy.** `to authenticated` means the policy is not even evaluated for other roles.

### The policies

```sql
-- 1. Server-owned / platform / approval-gated: read own tenant, plus §2.5's three denies.
create policy conversations_select_own on conversations
  for select to authenticated
  using (tenant_id = any ((select app.current_tenant_ids())::uuid[]));

-- 1b. The one table whose tenant column is `id`, written out because it is the exception.
create policy tenants_select_own on tenants
  for select to authenticated
  using (id = any ((select app.current_tenant_ids())::uuid[]));

-- 2. Tenant-authored: full CRUD, with WITH CHECK repeating the predicate.
create policy service_items_rw_own on service_items
  for all to authenticated
  using      (tenant_id = any ((select app.current_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.current_tenant_ids())::uuid[]));
```

**Omitting `WITH CHECK` on an `UPDATE`/`ALL` policy is a tenant-hopping write.** `USING` gates which rows you may *touch*; `WITH CHECK` gates what they may *become*. Without it, `update service_items set tenant_id = '<other tenant>'` hands the row away. Every write policy repeats the predicate in both clauses; V7 flags any that does not.

```sql
-- 3. Founder cross-tenant read. Separate policies, so the audit reads cleanly.
create policy conversations_select_admin on conversations
  for select to authenticated using ((select app.is_platform_admin()));

-- 3b. PII-bearing tables carry the NARROWER admin gate. All three of them.
create policy messages_select_admin on messages for select to authenticated
  using ((select app.is_platform_admin()) and (select app.admin_may_read_bodies()));
create policy webhook_events_select_admin on webhook_events for select to authenticated
  using ((select app.is_platform_admin()) and (select app.admin_may_read_bodies()));
create policy quality_reviews_select_admin on quality_reviews for select to authenticated
  using ((select app.is_platform_admin()) and (select app.admin_may_read_bodies()));
```

The draft gated `can_read_message_bodies` on `messages` **only**, and the review is right that this made the control decorative for the window that matters most. `webhook_events.raw_payload` is *the same message text, unredacted, exactly as Meta sent it*, for the last 7–30 days — the freshest and most sensitive slice — and `quality_reviews.rationale` is AI commentary that quotes customers. `select raw_payload from webhook_events where tenant_id = <matrix> order by received_at desc limit 50` would have returned Matrix's customers' verbatim conversations with no gate, no audit row, and no way for Matrix to know. Making the gate a property of a *helper* rather than of one table is what makes it uniform, and V15 asserts it for every table §2.8 marks PII-bearing.

Two permissive `SELECT` policies OR together, which is exactly right: tenant owners see their own rows, the founder sees all, neither policy knows about the other.

### How "admin" is established

| Option | Always current? | Blast radius if wrong | Verdict |
|---|---|---|---|
| **A. Postgres role** (`dala_admin` selected by the JWT `role` claim) | yes | **total** — a misconfigured claim locks you out or grants a customer admin | **Rejected for v1.** |
| **B. JWT claim** `app_metadata.is_founder` via the custom access token hook | **no** — stale until refresh (default 1h) | revocation takes up to an hour | **Adopted as a cache only**, for edge/middleware gating. |
| **C. Table** `platform_admins` + `SECURITY DEFINER` helper | yes | one `update` revokes instantly; the grant is a row, so it is auditable | **Adopted as the authority.** |

Two hard constraints if the hook is used: the claim goes in **`app_metadata`, never `user_metadata`** — `user_metadata` is user-writable through `auth.updateUser()`, so a `tenant_id` or `is_founder` there is a self-service privilege-escalation button (the same shape as the `profiles.tier` freeze next door). And the hook must be trivially simple: it runs inside the Auth server's transaction, so if it throws, **token issuance fails for everyone**. That is fail-closed, which is correct, but it means one `select`, no network, no `pg_net`.

**Admin access is read-only by policy.** There is no admin write policy anywhere. Founder writes (approving a KB proposal, suspending a tenant, inviting a tenant member) go through service-role routes that write `audit_log`. For the day-to-day Quality workflow the founder reads `quality_reviews` verdicts; when the raw thread is genuinely needed it is fetched through an RPC that writes an `audit_log` row — because a policy cannot log, and "the founder read a salon's customer conversations" is exactly the event that should leave a trace. Running the Quality layer under a scoped admin identity rather than `service_role` also keeps the *last place RLS could still catch a scoping bug in your own tooling*.

### `service_role`, `FORCE ROW LEVEL SECURITY`, and the real last line of defence

VERIFIED (research), by execution:

| Question | Answer |
|---|---|
| Does `service_role` bypass RLS? | **Yes, completely** — `BYPASSRLS`. It read both tenants' rows and inserted into the *other* tenant while a policy scoped the table to one. |
| Does `alter table … force row level security` fix that? | **No.** Still saw all rows. |
| What does `FORCE` change? | It subjects the **table owner** to RLS. Owner saw 1 row before, 0 after. |

PostgreSQL's docs: *"Superusers and roles with the BYPASSRLS attribute always bypass the row security system."* So `relforcerowsecurity` stays `false` — matching `security-audit-2026-08-23.md:391-393`.

**Therefore: there is no last line of defence inside Postgres for a service-role scoping bug — except constraints, foreign keys, and triggers.** Dala AI's entire inbound path — webhook → tenant lookup → Anthropic → send — has no user session at any point and runs as `service_role` end to end. **RLS protects the dashboard and protects essentially nothing on the path that carries all the volume and all the spend.** Every "we have RLS" reassurance must be read against that sentence.

What substitutes, in order of strength:

1. **`tenant_id` derived from a verified signal only.** `X-Hub-Signature-256` verified over raw bytes *before* parsing (the ancestor already does this correctly — `lib/messengerClient.js:25-42`, constant-time, failing closed when the secret is absent at `:26`, raw bytes preserved by disabling the body parser at `api/messenger.js:16-20`; carry it wholesale), then `(provider, external_id) → tenant_id` through `tenant_channels`'s unique constraint. **The single biggest tenant-misidentification risk is a `?? DEFAULT_TENANT` fallback written for local testing.** Ban it; grep for it in CI.
2. **Note what the signature does *not* prove.** One Meta app means one app secret, so every subscribed Page signs under the same key. A valid signature proves the payload is untampered and came from someone holding your app secret. It proves **nothing** about which tenant the event belongs to.
3. **The composite-FK spine** (§2.2), with its three written exceptions and V16 to keep the exception list honest.
4. **Append-only triggers (UPDATE, DELETE *and* TRUNCATE, `ENABLE ALWAYS`) plus a TRUNCATE revoke** on `spend_ledger` and `audit_log`; the approval `check` constraints on `kb_change_proposals`; the snapshot class guard on `audit_log`.
5. **Two chokepoints, not one.** `withTenant(req, handler)` for relational access, and `app.search_kb()` for retrieval — because an ANN query cannot go through a pre-bound query builder, and that gap is where the highest-volume leak lives.
6. **`tenant_id` on every log line and every cache/rate-limit key.** In the ancestor, `lib/messengerProcess.js:80,88,117` stamps every log line with `SALON_NAME`, a module constant from `lib/salonBrain.js:46` — the *build's* tenant, not the *request's* — and Redis keys are `msgr:hist:<psid>` / `msgr:done:<mid>` (`lib/conversationStore.js:88,53`) with no tenant at all.
7. **Negative tests in CI** (§2.11). The catalog proves configuration; only a test proves enforcement.

---

## 2.8 PII: what is stored, for how long, and how it leaves

### What is PII here

| Table.column | Content | Sensitivity |
|---|---|---|
| `messages.body` | The customer's own words to a salon | **High.** The bulk of the risk. |
| `contacts.display_name`, `contacts.external_id` | Facebook display name; PSID/IGSID (pseudonymous, stable per person per page) | Medium |
| `contacts.phone_e164`, `outbound_messages.to_phone_e164` | Real phone numbers, once SMS exists | **High** |
| `webhook_events.raw_payload` | Everything above, unredacted, as Meta sent it | **High** |
| `quality_reviews.rationale` | AI commentary that may quote a customer | **High** (upgraded from the draft's "Medium" — it is gated by `admin_may_read_bodies` for the same reason) |
| `audit_log.before/after_snapshot` | KB/config text only, enforced by the class guard; never a token | Medium |
| `spend_ledger`, `usage_counters`, `analytics_reports` | **Counts and money only — no content, by construction** | Low |

The ledger and counters carrying no content is what makes long financial retention safe. It is a schema property, not a promise: there is no free-text customer column on those tables.

### Retention

| Data | Default | Configurable | Mechanism |
|---|---|---|---|
| `webhook_events.raw_payload` | **7 days** | `retention_days_raw_events`, 1–30 | `NULL` it, set `raw_purged_at`. Row survives for idempotency. |
| `webhook_events` row | 30 days | no | Delete (no append-only trigger on this table). |
| `messages.body` | **90 days** | `retention_days_messages`, 30–730 | `NULL` it, set `body_redacted_at`. Row survives so counts and the ledger link stay intact. |
| `messages` row | 730 days | no | Delete. |
| `contacts` | 12 months after `last_seen_at` with no live conversation | no | Delete (cascades). |
| `outbound_messages.to_phone_e164` | 90 days after `sent_at` | no | Replace with `sha256(phone ‖ per-tenant salt)`. |
| `spend_ledger`, `usage_counters` | 7 years | no | Retain. No content. |
| `analytics_reports` | indefinite | no | Aggregates only. |
| `audit_log` | **indefinite** | no | **Changed from the draft's "2 years — Delete", which the append-only trigger makes impossible.** See below. |

**`audit_log` is retained indefinitely.** The draft said "2 years — Delete" while also declaring the table append-only; those are contradictory, and the contradiction would have surfaced as a hard error the first time the purge ran. Given that the class guard now forbids customer-body snapshots, the table is small and carries no customer PII, so indefinite retention is honest and cheap. If volume ever forces trimming, the mechanism is **range-partition by month and `drop table` old partitions** — DDL, which fires no row trigger — decided in a migration, not in a nightly job. Note the limitation plainly: a tenant who contractually requires their *config/KB* text removed from the audit trail at offboarding cannot be served by a `delete`; that is a partition rebuild. §2.15 Q9.

Redaction-before-deletion is chosen deliberately: nulling `body` destroys the PII while preserving referential integrity, message counts, and the ledger linkage that Analytics and any billing dispute depend on. A hard row delete would silently change historical report figures — the "plausible answer" failure in a different costume.

### The purge job

One nightly job, `ops.purge_expired(p_max_rows int default 50000)`. Three non-negotiable properties:

- **It touches no upstream provider.** No Anthropic, no Meta. Rule #6's ceiling requirement is honoured — the ceiling here is rows, not dollars.
- **It is bounded per run** and **alerts when it hits the ceiling**, because hitting the ceiling means a backlog, and a purge silently falling behind is how retention promises become false.
- **It reports what it deleted** into `audit_log` with counts per table.

It touches only tables with no append-only trigger. Any attempt to extend it to `spend_ledger` or `audit_log` fails loudly by design.

### Per-person erasure

`contact_erasure_requests` accepts three sources: `meta_callback` (Facebook apps must expose a Data Deletion Request callback — **ASSUMED**, §2.14), `tenant_request`, `customer_direct`. Fulfilment deletes the `contacts` row, cascading through `conversations` → `messages` → `booking_handoffs` → `outbound_messages`. `webhook_events` rows are **not** cascaded — they carry no FK to `contacts` — so the job additionally nulls any `raw_payload` whose `dedup_key` belongs to that contact's messages. That asymmetry is easy to miss and is why `raw_payload`'s default retention is only 7 days. `rows_deleted jsonb` records per-table counts, because "the job said it worked" is not evidence.

### Tenant offboarding — export, then prove deletion. The tenant row is **not** deleted.

The draft's step 3 was `delete from tenants where id = …`, "because every tenant-scoped table's `tenant_id` FK is `on delete cascade`". **VERIFIED (executed): that statement raises**, because the cascade issues a DELETE against `spend_ledger` and the append-only trigger refuses it (`CONTEXT: SQL statement "DELETE FROM ONLY spend_ledger WHERE $1 = tenant_id"`). Offboarding as designed could not have run.

The resolution is also the better privacy design, because financial records legitimately outlive a customer relationship:

1. **Export** — `ops.export_tenant(tenant_id)` writes JSONL per table plus a manifest with a SHA-256 per file. Run by the founder with an explicit confirmation token; writes `audit_log`. Secrets are **never** exported.
2. **Count first** — record `row_counts_before` in `tenant_offboardings`, **including `webhook_events`**, *before* anything is deleted. (The draft's proof query would have run after the discriminator was already gone.)
3. **Grace** — `scheduled_purge_at = now() + 30 days`, `tenants.status = 'offboarding'`, all sends stopped, inbound events still recorded so nothing is lost if they change their mind.
4. **Purge** — delete `contacts` (cascades conversations, messages, booking_handoffs, outbound_messages), `webhook_events`, `knowledge_documents` (cascades chunks), the config tables, `quality_reviews`, `kb_change_proposals`, and `tenant_secrets` (the KEK-wrapped DEKs become undecryptable regardless). Then `tenants.status = 'purged'` and every column except `id`, `slug`, `display_name`, `status` set to defaults.
5. **Retained by design:** `spend_ledger`, `usage_counters`, `analytics_reports`, `audit_log`, and the `tenants` stub. All content-free with respect to customers.
6. **Prove it** — `row_counts_after` per table, obtained by **querying**: `select count(*) from messages where tenant_id = :t` must be 0, per table, independently. Not by the job reporting success. Same discipline as the KEK rotation check and as §2.11.

---

## 2.9 Mongolian Cyrillic: collation, indexing, search

### Collation — assert it, because it cannot be changed later

VERIFIED (research):

| Test | Result |
|---|---|
| `lower('ҮС ЗАСАЛТ')` under `C.UTF-8` / `en_US.UTF-8` | `үс засалт` ✓ |
| `'Үс Засалт' ILIKE '%засалт%'` under `C.UTF-8` | `true` ✓ |
| `lower('ҮС ЗАСАЛТ' collate "C")` | **`ҮС ЗАСАЛТ`** — unchanged ✗ |
| `('Үс' collate "C") ILIKE ('%үс%' collate "C")` | **`false`** ✗ |

Plain `C`/`POSIX` silently breaks Cyrillic case folding; `en_US.UTF-8` (Supabase's default) handles it, because glibc's ctype tables are not English-specific. `datcollate` **cannot be changed after database creation**, so this is V0.

### `unaccent` is banned

VERIFIED (research): `unaccent` maps **`Ё → Е` and `ё → е`**, while `Й`, `Ө`, `Ү` pass through untouched. `Ё` is a full letter of the Mongolian alphabet (ёстой, Ёндон, ёс), not a decoration. The *mixture* is what makes it dangerous — harmless in nine tests out of ten, then silently conflating a small set of words. **Do not create the extension.** V0 asserts its absence.

### The folding function you own instead

The real Mongolian confusions are keyboard-layout errors, not diacritics: `ө`↔`о`, `ү`↔`у`, `й`↔`и`, `ё`↔`е`. VERIFIED (research): `similarity('үс засалт','ус засалт') = 0.538` but `similarity('өнгө','онго') = 0` — trigram similarity collapses when *every* character differs, which is exactly what the `ө`→`о` typo produces.

```sql
create or replace function app.mn_search_fold(t text)
returns text language sql immutable parallel safe as $$
  select translate(lower(normalize(coalesce(t,''), NFC)), 'өүйёӨҮЙЁ', 'оуиеоуие');
$$;
```

`immutable` is required for the generated columns in §2.4-B/C. Applied to search columns only, **never** to stored canonical text.

**And here is a trap the draft got wrong and nobody caught.** It said "changing it is a migration plus a reindex — a real, visible cost". That is not the cost; the cost is worse and it is silent. **VERIFIED (executed):**

```
create function app.fold(t) ... lower(t);
create table kb (id, name, key text generated always as (app.fold(name)) stored);
insert into kb values (1,'ӨНГӨ');                       →  key = 'өнгө'

create or replace function app.fold(t) ... translate(lower(t),'өү','оу');
select id, key, app.fold(name) from kb;                 →  key = 'өнгө',  app.fold(name) = 'онго'
insert into kb values (2,'ӨНГӨ');                       →  key = 'онго'

select id, key from kb;
 1 | өнгө
 2 | онго          ← two rows, identical `name`, different `key`, no error anywhere

drop function app.fold(text);
  ERROR:  cannot drop function ... because column key of table kb depends on it
```

`CREATE OR REPLACE` on a function used by a **stored** generated column succeeds and does **not** recompute existing rows. `DROP` is blocked; `REPLACE` is not. Half your knowledge base is folded one way and half the other, permanently, and nothing signals it — the pure "plausible answer instead of an error" shape, inside your own search layer.

**Rules that follow:** the fold function may only be changed by `alter table … drop column search_key, add column search_key … generated always as (…) stored` on every dependent table in the same migration; and `md5(prosrc)` for every function in `app` is folded into V12's fingerprint, so a replace that skipped the rebuild shows up as a fingerprint drift in staging-versus-production.

### Search strategy per surface

| Surface | Method |
|---|---|
| KB retrieval for the model | `app.search_kb()` — pgvector, exact within-tenant at launch (§2.4-C), plus trigram on `body_fold` as a lexical backstop, also inside a definer function |
| Service-name lookup («гель маникюр» → «Гелэн будалт») | `service_aliases.alias_key` exact match, then `pg_trgm` on `service_items.search_key` |
| Dashboard free-text search | `to_tsvector('simple', app.mn_search_fold(…))`, config named **explicitly at every call site** |
| Staff/service list ordering | `order by … collate "mn-MN-x-icu"` (**ASSUMED** available; fall back to `und-x-icu`) |

Never rely on `default_text_search_config` — a generated `tsvector` that depends on a session GUC is a bug waiting for a config change. VERIFIED (research): `english` and `simple` produce *identical* output on pure Mongolian (the Snowball English stemmer does not touch Cyrillic tokens) but **diverge on mixed text**, which is what a salon actually receives. `simple` has no Mongolian stop-word list, so particles (`нь`, `ба`, `юм`, `вэ`, `бол`) index as content — a month-two tuning task from your own corpus, not a launch blocker.

### What breaks under an ASCII assumption

VERIFIED (research): **Postgres regexes are locale-aware; JavaScript regexes are not.**

| Expression | Postgres | JavaScript |
|---|---|---|
| `\w` on `'үс засалт'` | **true** | **false** |
| word boundary on `засалт` | `\yзасалт\y` → **true** | `/\bзасалт\b/` → **false** |
| same, with the `u` flag | n/a | **still false** |
| `\p{L}+` with `u` | n/a | **true** |

A validation regex ported from SQL to Node, or written by someone who tested it in `psql`, **changes meaning**. `u` does not fix `\b`: in JavaScript `\b` is defined in terms of `\w`, and `\w` is permanently `[A-Za-z0-9_]`. Write `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with `u`, or do not use word boundaries.

The ancestor demonstrates both halves failing in production. VERIFIED (research, by running the real module):

- `lib/salonIntents.js:26` — `GREETING_REGEX = /^(сайн|байна|уу|hi|hello|hey)/i` is unanchored at the right edge, so `detectShortcutIntent('Уучлаарай асуумаар байна', {hasHistory:false})` returns `'greeting'`. **`Уучлаарай`** ("excuse me") is one of the commonest openers in Mongolian customer service; that customer gets a canned welcome and their question is never answered.
- `lib/salonIntents.js:21` matches `хаяг` anywhere, so `'Facebook хаяг байна уу'` returns `'location'` — the customer asked for the Facebook page and gets a Google Maps card. The `EMAIL_CONTEXT_REGEX` at `:25` is a hand-patched symptom.
- Because nothing normalises, `'Байна уу'.normalize('NFD')` returns `null` where the NFC form returns `'greeting'`.
- `lib/validator.js:201` — `/^[^аеёиоуыэюя\s]{20,}$/i`, commented "without Mongolian vowels", uses the **Russian** vowel set and is missing **ө** and **ү**.

**Database-side rules, for `CLAUDE.md` on day one:**

1. NFC-normalise at every input boundary (webhook body, dashboard form, KB import) and nowhere else. `check (col is normalized)` on the columns that matter — `Й` and `Ё` have canonical decompositions, `Ө` and `Ү` do not, so two visually identical KB entries can otherwise never match.
2. No `\b`, `\w`, or `[a-z]` in any JavaScript regex over user text. `\p{L}`/`\p{N}` with `u`, or nothing. CI grep.
3. No unanchored regex over user text where the consequence is a wrong intent or a prompt injection. `sanitizeForPrompt` is "a fixed-phrase regex strip … trivially bypassed … not a security control" (`security-audit-2026-08-23.md:228-231`). Do not build the Mongolian version and then rely on it.
4. Length budgets in **characters** (`Array.from(s).length` for emoji safety), byte budgets with `Buffer.byteLength`. Never interchange them.
5. ASCII classes are permitted **only** for machine identifiers (slug, currency code, E.164 phone, numeric error codes, the `EAA…` tripwire). Say which you are writing, every time.

---

## 2.10 How migrations are applied to *this* project

### Recommendation: Supabase CLI, with a real ledger, from `0001`. Never the dashboard SQL editor.

`supabase_migrations.schema_migrations` on the sibling project contains **exactly one row** — `20260430154610 remote_schema` — while six migration files exist and the effects of at least two are demonstrably live in the catalog (`security-audit-2026-08-23.md:309-317`). Every migration there was pasted into the dashboard editor, which executes the statements and records nothing. The consequence, quoted from `:324-328`:

> The ledger is not merely incomplete — it is *actively misleading*, because it is empty in the same way whether a migration was applied or not.

That gap hid an unapplied HIGH fix in production for weeks, on the tables that permitted forged certificates and forged IELTS bands.

```
supabase/migrations/0001_bootstrap_grants.sql
                    0002_tenancy.sql · 0003_classes.sql · …
supabase/verify/V0..V16.sql          -- the pack in §2.11
supabase/tests/rls/*.sql             -- negative tests, §2.11
```

- Local: `supabase db reset` applies every migration from scratch, every time — which alone catches the "provisioned from `schema.sql` reproduces the original vulnerabilities" class (`security-audit-2026-08-23.md:117-120`).
- CI on every PR: reset a shadow database, apply all migrations, run V0–V16, run the negative tests, fail on any zero-rows gate that returns a row.
- Deploy: push to staging, run the pack, push to production, run the pack **again**, diff the two **fingerprints** (V12).
- Every migration PR carries the pack's output pasted in.

**What it costs — say it plainly, because the cost is why people fall back to the editor:**

1. **You may never touch the dashboard SQL editor again.** One paste diverges the ledger from reality silently and permanently. If an emergency forces one: paste → immediately write the equivalent migration file → `supabase migration repair --status applied <version>` → re-run V0–V16 → record it in the PR.
2. **CI needs credentials.** Mitigated by the new key model: mint a dedicated named `ci` key and revoke it independently.
3. **`supabase db diff` produces noisy diffs** against Supabase-managed schemas. Write migrations by hand; use `diff` only to check you did not miss something.
4. **Branch databases cost money** (**ASSUMED** — check pricing). A CI shadow DB is the cheap substitute.
5. **No hot-fixing at 2 a.m.** That is the point, and it is the thing that will be violated first.

**And the caveat that survives all of it: even with the CLI, the ledger is a *claim*.** It records what the CLI believes it applied. It cannot see a dashboard paste, a manual `psql` session, or a partially-failed transaction. **The catalog is the only source of truth.** The CLI makes the ledger *usually* right; §2.11 is what makes you *know*.

---

## 2.11 The verification protocol

Run after **every** migration that touches a grant, a policy, an RLS state, a trigger, or a function. Paste the output into the PR. Read **every row** — the sibling's failure was partial (one of four tables), and a spot check on the one that happened to be correct confirmed the wrong conclusion (`security-audit-2026-08-23.md:475-476`).

### Two sources banned in this codebase

**`information_schema.role_table_grants`** shows only rows where the current role is the grantor, the grantee, or a member of the grantee role — otherwise it filters everything out and **reports the absence as an empty result rather than an error**. VERIFIED (research), same database, same instant:

| Querying role | `role_table_grants` rows | rows naming `anon`/`authenticated` | `aclexplode` rows |
|---|---|---|---|
| `postgres` | 67 | many | 72 |
| `auditor` (plain login role) | 5 | **0** | 72 |

**`supabase_migrations.schema_migrations`** — §2.10.

### Structural rule: three things must be zero-rows gates, and the rest must be diffed

The draft's pack had exactly one zero-rows gate (V2); V3, V5, V7 and V9 all produce legitimate rows by design and could therefore only be "read carefully by a human" — which is precisely the review posture that produced `20260817`. The pack now has **six** gates, and they work because `ops.table_security_class` and `ops.tenant_scope` give the catalog something to be compared *to*.

```sql
-- V0 — environment invariants that cannot be fixed later
select datname, datcollate, datctype, pg_encoding_to_char(encoding) from pg_database
where datname = current_database();            -- UTF8; datcollate NOT 'C'/'POSIX'
select extname from pg_extension order by 1;
-- REQUIRED: pgcrypto, pg_trgm, btree_gist, vector.   BANNED: unaccent.

-- V1 — RLS state, per relation (views and matviews INCLUDED)
select c.relname, c.relkind, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') order by 1;

-- V2 — GATE: "which table did I forget"
select n.nspname||'.'||c.relname as table_name,
       case when not c.relrowsecurity then 'RLS DISABLED — wide open to any role with a grant'
            when not exists (select 1 from pg_policy p where p.polrelid = c.oid)
              then 'RLS ON, NO POLICIES — default-deny (intended? or forgotten?)' end as problem
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
  and (not c.relrowsecurity or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
order by 1;

-- V3 — the TRUE ACL, with both null-traps closed
select c.relname, c.relkind,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
group by 1,2,3 order by 1,3;

-- V4 — GATE: views and matviews (the whole class the draft could not see)
select n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) as owner, c.reloptions
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v','m')
  and (c.relkind = 'm'      -- matviews CANNOT be security_invoker: RLS never applies
       or coalesce(array_to_string(c.reloptions,','),'') !~ 'security_invoker=(true|on)');
-- MUST return zero rows. Materialised views over tenant-scoped tables are banned in `public`.

-- V5 — GATE: client roles holding anything other than SELECT; anon holding ANYTHING
select c.relname,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'))
group by 1,2
having pg_get_userbyid(max(a.grantee)) = 'anon'
    or string_agg(a.privilege_type, ',' order by a.privilege_type) <> 'SELECT'
order by 1,2;
-- Compares against the literal string 'SELECT', so it catches PG17 MAINTAIN and anything PG18 adds.

-- V6 — GATE: every declared tenant-scoped table carries its declared column, leading an index
select s.table_name, s.tenant_column,
       (a.attname is not null) as column_exists,
       exists (select 1 from pg_index i where i.indrelid = c.oid and i.indkey[0] = a.attnum)
         as leads_an_index
from ops.tenant_scope s
  join pg_class c on c.relname = s.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_attribute a on a.attrelid = c.oid and a.attname = s.tenant_column
                          and a.attnum > 0 and not a.attisdropped
where a.attname is null or not exists (select 1 from pg_index i
        where i.indrelid = c.oid and i.indkey[0] = a.attnum);

-- V7 — GATE: permissive client policies not scoped to the DECLARED tenant column,
--            and write policies missing WITH CHECK
select p.tablename, p.policyname, p.cmd, p.roles, p.qual, p.with_check
from pg_policies p join ops.tenant_scope s on s.table_name = p.tablename
where p.schemaname = 'public' and p.permissive = 'PERMISSIVE'
  and p.roles && array['anon','authenticated','public']::name[]
  and (  (p.cmd in ('SELECT','UPDATE','DELETE','ALL')
          and (coalesce(p.qual,'') !~ ('\m'||s.tenant_column||'\M|is_platform_admin')
               or coalesce(p.qual,'') in ('true','(true)')))
      or (p.cmd in ('INSERT','UPDATE','ALL')
          and coalesce(p.with_check,'') !~ ('\m'||s.tenant_column||'\M')) )
order by 1,2;
-- The INSERT branch no longer tests `qual`: an INSERT policy has qual = NULL by construction,
-- which made the draft's V7 flag every correct INSERT policy (VERIFIED, executed) and bury the real ones.

-- V8 — who bypasses RLS. An unexpected role here means STOP.
select rolname, rolbypassrls, rolsuper from pg_roles where rolbypassrls or rolsuper order by 1;

-- V9 — full policy bodies, read every one
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' order by 1,2;

-- V10 — GATE: SECURITY DEFINER functions without search_path = ''
select n.nspname, p.proname, p.prosecdef,
       coalesce(array_to_string(p.proconfig,','),'(none)') as config,
       pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','app','ops') and p.prosecdef
  and coalesce(array_to_string(p.proconfig,','),'') !~ 'search_path=(""|)$'
order by 1,2;
-- Catches exactly the sibling's unreviewable increment_* RPCs.

-- V11 — ACLs on helper functions (a policy calling a function the caller cannot EXECUTE fails loudly)
select n.nspname, p.proname,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where n.nspname in ('app','ops') order by 1,2,3;

-- V13 — GATE: triggers. The control the draft declared and never verified.
select n.nspname||'.'||c.relname as tbl, t.tgname, t.tgenabled, pr.proname,
       (t.tgtype & 32) > 0 as fires_on_truncate, pg_get_triggerdef(t.oid) as def
from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc pr on pr.oid = t.tgfoid
where not t.tgisinternal and n.nspname = 'public' order by 1,2;
-- Every append-only table MUST show BOTH triggers with tgenabled = 'A' (ENABLE ALWAYS).
-- Gate form: assert the expected (table, trigger, 'A') set exactly.

-- V14a — GATE: schema privileges, resolved through PUBLIC inheritance
select n.nspname, r.rolname,
       has_schema_privilege(r.rolname, n.nspname, 'USAGE')  as usage,
       has_schema_privilege(r.rolname, n.nspname, 'CREATE') as create_,
       coalesce(n.nspacl::text,'NULL (owner-implicit)')     as raw_acl
from pg_namespace n
  cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
where n.nspname in ('public','app','ops') order by 1,2;
-- REQUIRED: anon USAGE = f everywhere. service_role USAGE = t on public, app, ops.
-- Reads has_schema_privilege(), NOT the ACL text, because the ACL text lies (§2.6a).

-- V14b — GATE: default privileges, per creating role
select pg_get_userbyid(d.defaclrole) as for_role,
       coalesce(n.nspname,'(all schemas)') as schema, d.defaclobjtype,
       (select string_agg((case when a.grantee=0 then 'PUBLIC'
                                else pg_get_userbyid(a.grantee) end)||'='||a.privilege_type,
                          ',' order by 1) from aclexplode(d.defaclacl) a) as grants
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1,2;
-- MUST show no entry granting anything to anon/authenticated/PUBLIC, for ANY creating role.

-- V15a — GATE: every public table has a declared class
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p','v','m')
  and c.relname not in (select table_name from ops.table_security_class);

-- V15b — GATE: no PERMISSIVE client write policy on anything a client must not author
select p.tablename, p.policyname, p.cmd, k.class
from pg_policies p join ops.table_security_class k on k.table_name = p.tablename
where p.schemaname='public' and p.permissive='PERMISSIVE'
  and p.cmd in ('INSERT','UPDATE','DELETE','ALL')
  and p.roles && array['anon','authenticated','public']::name[]
  and k.class in ('server_owned','secret','platform','approval_gated');
-- This is the query that catches `usage_counters_rw_own`. V7 cannot, by construction.

-- V15c — GATE: every locked class actually carries all three restrictive denies
select k.table_name, v.cmd from ops.table_security_class k
cross join (values ('INSERT'),('UPDATE'),('DELETE')) v(cmd)
where k.class in ('server_owned','secret','platform','approval_gated')
  and not exists (select 1 from pg_policies p
      where p.schemaname='public' and p.tablename=k.table_name
        and p.permissive='RESTRICTIVE' and p.cmd=v.cmd
        and p.roles @> array['anon','authenticated']::name[]);

-- V15d — GATE: PII-bearing tables must gate the admin SELECT on admin_may_read_bodies
select p.tablename, p.policyname from pg_policies p
where p.schemaname='public' and p.permissive='PERMISSIVE' and p.cmd in ('SELECT','ALL')
  and p.tablename in ('messages','webhook_events','quality_reviews')
  and coalesce(p.qual,'') ~ 'is_platform_admin'
  and coalesce(p.qual,'') !~ 'admin_may_read_bodies';

-- V16 — GATE: *_id columns with no foreign key, minus a WRITTEN exception list
select c.relname, a.attname
from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
where n.nspname='public' and c.relkind='r'
  and a.attname ~ '_id$' and a.attname <> 'tenant_id'
  and not exists (select 1 from pg_constraint k
                  where k.conrelid=c.oid and k.contype='f' and a.attnum = any(k.conkey))
  and (c.relname, a.attname) not in (
        ('spend_ledger','conversation_id'),   -- §2.2c: ledger outlives the conversation
        ('kb_change_proposals','target_id'),  -- polymorphic by design
        ('webhook_events','channel_id'),      -- may be unrouted
        ('audit_log','actor_user_id'), ('audit_log','target_id'))
order by 1,2;
-- Also flag any uuid[]/bigint[] column whose name ends in _ids on a tenant-scoped table.

-- V12 — CATALOG FINGERPRINT. One digest of RLS + policies + ACLs + functions + TRIGGERS.
select md5(string_agg(line, E'\n' order by line)) as catalog_fingerprint from (
  select 'T|'||c.relname||'|'||c.relkind||'|'||c.relrowsecurity::text||'|'||
         c.relforcerowsecurity::text||'|'||coalesce(array_to_string(c.reloptions,','),'') as line
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','f')
  union all
  select 'P|'||p.tablename||'|'||p.policyname||'|'||p.permissive||'|'||p.cmd||'|'||
         array_to_string(p.roles,',')||'|'||coalesce(p.qual,'')||'|'||coalesce(p.with_check,'')
    from pg_policies p where p.schemaname='public'
  union all
  select 'A|'||c.relname||'|'||(case when a.grantee=0 then 'PUBLIC'
                                     else pg_get_userbyid(a.grantee) end)||'|'||a.privilege_type
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname='public' and c.relkind in ('r','p','v','m','f')
  union all
  -- prosrc hash included: catches a `create or replace` that skipped the generated-column rebuild (§2.9)
  select 'F|'||n.nspname||'.'||p.proname||'|'||p.prosecdef::text||'|'||
         coalesce(array_to_string(p.proconfig,','),'')||'|'||md5(p.prosrc)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app','ops')
  union all
  select 'G|'||c.relname||'|'||t.tgname||'|'||t.tgenabled||'|'||pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname='public'
  union all
  select 'S|'||n.nspname||'|'||r.rolname||'|'||
         has_schema_privilege(r.rolname,n.nspname,'USAGE')::text
    from pg_namespace n cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
    where n.nspname in ('public','app','ops')
  union all
  select 'C|'||k.table_name||'|'||k.class from ops.table_security_class k
) s;
```

**V12 is the answer to "applied to staging but not production."** One string, run in both after every deploy. The draft's version fingerprinted everything except the thing it called the only real control: dropping both append-only triggers and `ops.deny_mutation` produced an identical digest. `G|`, `S|`, `C|` and the `prosrc` hash close that.

Two traps V3 closes that a naive version does not, both VERIFIED (research):

- **`relacl IS NULL` yields zero `aclexplode` rows.** A table created and never explicitly `GRANT`ed carries a null ACL meaning "owner-implicit defaults"; a bare `aclexplode(c.relacl)` reports it as *no grants at all*. `coalesce(…, acldefault('r', c.relowner))` materialises it. The same trap applies to `pg_namespace.nspacl` — VERIFIED (executed) that `app`'s is NULL — which is why V14a uses `has_schema_privilege()`.
- **`PUBLIC` is grantee OID 0, and `pg_get_userbyid(0)` returns `'unknown (OID=0)'` — it does not error.**

### Negative tests — because the catalog proves configuration, not enforcement

`supabase/tests/rls/` runs against the shadow DB in CI, with two seeded tenants and three seeded identities (owner A, owner B, founder). The table list is **read from `ops.table_security_class`**, not hand-written, and the tenant column from `ops.tenant_scope`. For every table, independently:

1. As owner B, `select` from tenant A's rows → **0 rows**. *(Includes the explicit case: `select` from `tenants` returns exactly one row.)*
2. As owner B, `insert`/`update`/`delete` a row carrying tenant A's id → **error**, not `0 rows affected`.
3. As owner B, `update … set <tenant_column> = <tenant A>` on their own row → **error** (the `WITH CHECK` test).
4. As owner B, `insert`/`update`/`delete` on every server-owned / platform / approval-gated table → **error**.
5. As owner B, `truncate` every table → **permission denied**.
6. As owner B, `select` from `tenant_secrets` → **permission denied** (not "0 rows" — the privilege is absent).
7. As the founder with `can_read_message_bodies = false`, `select` from `messages`, `webhook_events` and `quality_reviews` → **0 rows**; from `conversations` → **rows from both tenants**; `insert`/`update` anywhere → **error**.
8. `insert` a `messages` row whose `tenant_id` disagrees with its `conversation_id`'s tenant → **FK violation** (the spine test).
9. **As `service_role`:** `update`, `delete` **and `truncate`** on `spend_ledger` and `audit_log` → **exception or permission denied**. Then `delete from tenants` → **must fail** (§2.2c), and `ops.purge_expired()` → **must succeed**.
10. As `service_role`, `select app.reserve_usage(...)` past a $0 ceiling → `allowed = false`; with no `spend_budgets` row → `allowed = false`. And `app.search_kb(tenant_A, …)` never returns a tenant-B chunk.
11. `insert into audit_log` with a `before_snapshot` and `target_table = 'messages'` → **exception** (the class guard).

Test 9 is the single most valuable line in the file: it is the only one that proves anything about the path where all the money is spent, and it is the one the draft's design would have failed.

**Why "0 rows affected" is not success.** VERIFIED (research): without a permissive write policy, `UPDATE` and `DELETE` return `UPDATE 0` / `DELETE 0` — silently, no error. Tests must assert on the **error**, not the row count.

---

## 2.12 Failure modes, consolidated

| Failure | Symptom | Correct behaviour |
|---|---|---|
| **Migration applied to staging, not production** | Everything looks fine; a policy silently absent in prod | V12 fingerprints differ; deploy gate fails. Never trust the ledger. |
| **New table shipped without RLS** | Any role with a grant reads everything | V2 and V15a return rows; CI fails. Plus `alter default privileges` means a new table has *no* client grant at all. |
| **New table shipped with a copy-pasted tenant-scoped write policy** | Tenant zeroes its own AI-spend counter; **every catalog check passes** | V15b, driven by the declared class. V7 cannot catch this, by construction. |
| **A dashboard convenience view is added** | Total cross-tenant leak; invisible to a `relkind in ('r','p')` pack | V4 gate + `security_invoker=true` required; matviews banned in `public`. |
| **Policy spot-checked on one table, another missed** | The exact `20260817` failure | V2/V3/V5/V15 enumerate every relation; the negative suite loops from the catalog, not a hand-written list. |
| **`revoke insert, update, delete` mistaken for "cannot write"** | `TRUNCATE` empties a table under a restrictive policy | V5 compares against the literal `'SELECT'`, so it catches PG17 `MAINTAIN` and anything PG18 adds. |
| **Append-only ledger truncated by a leaked worker key** | Ledger and audit log gone; catalog byte-identical to healthy | `BEFORE TRUNCATE` statement trigger + `ENABLE ALWAYS` + `revoke truncate from service_role`; V13 gate; `G\|` lines in V12. |
| **Retention / erasure / offboarding cannot run** | First purge raises `append-only table: UPDATE is not permitted` months after launch | No FK may cascade or set-null into an append-only table (§2.2c); `delete from tenants` is not the offboarding mechanism (§2.8); negative test 9 proves both. |
| **Composite FK `on delete set null`** | The child row's `tenant_id` is erased, or the delete fails | Banned. Use `cascade`, `no action`, or PG15+ `set null (specific_column)`. |
| **Service-role route with a tenant-scoping bug** | Cross-tenant read/write; RLS not evaluated | Composite FKs refuse mismatched writes; append-only triggers refuse ledger rewrites; `app.search_kb` is the only retrieval path. No policy helps. |
| **Vector retrieval written outside the chokepoint** | Matrix's prices quoted to a GS Auto customer; nothing throws | `app.search_kb()` + CI grep banning `<=>`/`hnsw`/`gin_trgm_ops` outside migrations. |
| **Tenant misidentified from a webhook** | Reply posted as the wrong salon | `unique (provider, external_id)`; unknown → `200` + drop + alert, never auto-create. Never `/me/messages`. Never `?? DEFAULT_TENANT`. |
| **Event delivered twice** | Duplicate reply, duplicate spend | `unique (provider, dedup_key)` checked **before** the Anthropic call. Cross-tenant collision alerts rather than silently drops. |
| **Budget spent / concurrent burst** | Forty simultaneous events blow through the ceiling | `app.reserve_usage()` — one statement, conditional, window derived server-side. Refuses when no budget row exists. Any error → 503, never `catch { continue }`. |
| **`service_role` cannot reach `app`** | Every budget check 500s on a permission error | V14a gate; `grant usage on schema app to service_role` in `0001`. |
| **Fold function replaced without rebuilding generated columns** | Half the KB folded one way, half the other; no error | V12's `prosrc` hash; the fold may only change via drop-and-re-add of every dependent column in one migration. |
| **Config missing for a tenant** | Bot answers from an empty knowledge base | `tenants.status = 'provisioning'` blocks sends; zero published documents is a hard refusal, not an empty prompt. Precedent: `lib/systemPromptBuilder.js:36-38` returns "no pricing information available" for an unrecognised price-list shape *rather than attempting to render*. |
| **Page token expired** | Reception AI goes silent for one tenant; **nothing throws** | `tenant_channels.status='authorization_error'` on Graph `190`; stop sends; alert. `channel_health.last_webhook_at` watchdog for a silent unsubscribe. |
| **Redis / limiter unreachable** | — | Fail closed on cost-bearing paths. The webhook **ACK** may fail open (a non-200 risks Meta disabling the subscription); the Graph call and the Anthropic call must not. |
| **Purge falls behind** | Retention promise quietly false | Row ceiling per run + alert on hitting it + per-table counts in `audit_log`. |
| **KEK rotated, some rows missed** | Half the tenants undecryptable | Confirm `select count(*) from tenant_secrets where kek_version <> 2` = 0 — **by querying**, not by the job reporting success. |
| **Two tenants in one warm lambda** | Tenant B answered with tenant A's prices | The acceptance test: prompt, history key, dedup key, rate-limit key, budget counter and log line all carry `tenant_id`. Testable offline with a fake clock and two fake tenants — the test the ancestor could never write, because `lib/salonBrain.js:142` cached the prompt in a module-scope singleton. |

---

## 2.13 Where the review was wrong, collected

Five items, each already stated inline; gathered here so the founder can see the objections and the answers together.

1. **"`service_role` can `ALTER TABLE … DISABLE TRIGGER`."** No — VERIFIED (executed): `ERROR: must be owner of table spend_ledger`. `ENABLE ALWAYS` and the `tgenabled` assertion are still adopted (they guard operator error and a `postgres`-level compromise), but the finding's teeth are entirely in TRUNCATE.
2. **"Fix `ledger_id` with `foreign key (tenant_id, ledger_id) … on delete set null`."** That fix is itself a tenant leak — VERIFIED (executed): a composite FK's SET NULL nulls the whole column list including `tenant_id`. Use `no action`, or PG15+ column-scoped SET NULL.
3. **"Use a `tenant_id`-leading partial-index strategy for vectors."** A per-tenant partial index is per-tenant DDL and fails the hard test. Exact within-tenant scan now; hash partitioning on `tenant_id` (fixed partition count) if scale demands it.
4. **"The `EAA…` check is the `sanitizeForPrompt` mistake."** Half right. A deny-list relied on against an adversary is that mistake; a deny-list guarding against *your own future logging code* is a useful tripwire. It stays, relabelled — and the real fix, allow-list constraints on every error-code column plus the audit snapshot class guard, is adopted.
5. **"The `anon` invariant would be reported as satisfied forever."** The table-level half genuinely is checked (V3/V5/V9). The schema-level half was false and unverified, and that half is now V14a.

---

## 2.14 Assumptions restated — verify before these become code

1. **`pg_jsonschema`** is available on Supabase for validating `tenants.settings` in a check constraint. If not, validate application-side and drop the constraint.
2. **`pgvector`** is available and `vector(1536)` is the right dimension. Confirm via V0's extension list on the real project.
3. **ICU collation `mn-MN-x-icu`** exists. Fall back to `und-x-icu`; assert in V0.
4. **Supabase branch database pricing** — the cost of a per-PR branch versus a CI shadow DB.
5. **Meta's Data Deletion Request callback** is required for app review and must be wired to `contact_erasure_requests`.
6. **`revoke usage on schema public from public` is safe on a live Supabase project.** It is the correct statement (VERIFIED (executed) as the only one that works), but Supabase's internal roles must be re-granted explicitly. Test on a branch first and run V14a for every Supabase role.
7. Everything the Meta research marked SINGLE-SOURCE or UNVERIFIED — in particular **what `entry[].id` is under each Instagram auth flavour**, on which `tenant_channels`'s entire routing model depends.
8. **PG16 vs PG17.** Every result marked VERIFIED (executed) was obtained on 16.13; Supabase is 17.x. The differences that matter — `MAINTAIN` in the ACL, and `unique nulls not distinct` (PG15+, so available in both) — are handled version-agnostically, but re-run V0–V16 on the real project before trusting any of it.

Everything else is either VERIFIED (file) with a citation, VERIFIED (executed) with a transcript above, or VERIFIED (research) and re-runnable in an afternoon.

---

## 2.15 Open questions — the founder's call, not mine

1. **Does a tenant owner get a login at all in v1?** Every policy in §2.7, `tenant_members`, `app.current_tenant_ids()`, `ops.tenant_scope` and most of the verification pack exist to serve a dashboard. If Matrix and GS Auto get a monthly PDF instead, RLS-for-humans is dead weight in v1 and the entire security budget should go to §2.7's substitution list — the service-role path, where all the volume and all the spend actually are. **This is the single highest-leverage decision in this document**, because it changes what half the schema is for.

2. **What is a tenant's monthly dollar ceiling, and what happens when it is hit?** `spend_budgets.on_exhausted` offers `hard_stop` (the salon's Messenger goes silent mid-conversation, on a Saturday), `canned_reply` (a Mongolian "we'll get back to you", which costs nothing and is probably right), or `overage_bill` (which requires a billing relationship that does not exist yet). `app.reserve_usage()` cannot be finished without the number **and** the behaviour. Related: what is the **worst-case reservation** per reply? Too low and bursts overshoot; too high and a tenant is refused with budget remaining.

3. **Vault or envelope encryption for page tokens?** I recommend envelope (§2.4-A) on blast-radius grounds and the argument is not close for a public repo — but it is ~120 lines you own and must test, versus one Supabase function call. If you would rather ship and revisit, **say so explicitly in the commit**, the way `BANK_BUILD_BUDGET_USD = 0` records a decision rather than an accident. Migrating Vault → envelope later is a plaintext-touching operation and genuinely harder than doing it now.

4. **Is the founder's Quality-layer identity `service_role` or the scoped admin role?** Reviewing every tenant's conversations is inherently cross-tenant, so `service_role` is tempting. Doing so removes the last place RLS could catch a scoping bug in your own tooling. I recommend the scoped role plus `can_read_message_bodies = false` by default; it costs four policies now that the gate covers `webhook_events` and `quality_reviews` too.

5. **Is `refusal_rules` self-serve or founder-approved?** "Never quote a price for X; say this instead" is the most valuable and most dangerous knob in the product. A tenant who sets it carelessly ships a bot that refuses to sell. Since the lockdown is now driven by `ops.table_security_class`, changing your mind is a one-row `update` plus a re-run of the pack.

6. **Do Matrix's pinned Mongolian sentences get re-reviewed on migration?** `CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY`, `BOOKING_LINE` (`lib/salonBrain.js:52-81`) were native-speaker reviewed **for that prompt, in that context**. Moving them into `canned_responses` and changing the surrounding prompt changes the conditions they were validated under. I would treat a `NULL` in `reviewed_by` as blocking go-live for that tenant.

7. **Retention: 90 days for message bodies — is that the promise you want to make?** Long enough for the Quality layer to find patterns, short enough to limit a breach. But it is a contractual statement to a salon about its customers' conversations, it appears in a privacy policy, and shortening it later destroys data the Quality layer was using. Note the ancestor's `PRIVACY_POLICY.md:83-89` already publishes a retention table describing a **localStorage-only architecture** — it will be wrong the moment Dala AI stores a message server-side, and rewriting it is on the critical path, not after launch.

8. **New — how does a tenant invite a colleague?** `tenant_members` had to move to the server-owned class (it is the authorization table; a `staff` row could otherwise promote itself to `owner` and delete the owner). That is correct, and it means there is no self-serve invite in v1 unless you build a service-role invite route with an `audit_log` write. Is a founder-mediated invite acceptable for the first ten tenants, or is the route in v1 scope?

9. **New — `audit_log` retention is now indefinite.** The draft's "2 years, delete" is incompatible with an append-only trigger (verified). Indefinite is honest and the table is small and customer-content-free by constraint. But it means a tenant who contractually demands their *config and KB text* removed from the audit trail at offboarding cannot be served by a `delete` — only by a partition rebuild. Do you want to pay for monthly range partitioning now, or accept that limitation and write it into the contract?

10. **New — what is the acceptable capability of a compromised `sb_secret_worker` key?** With the fixes above, that key can no longer rewrite or truncate the ledger, and can no longer decrypt a token without the Vercel KEK. It can still read every tenant's conversations and send as every tenant, because that is what the inbound path *is*. Minting one key per component (§2.6) narrows the blast radius; deciding **which components share a key** is a call only you can make, and it should be made before the first key is minted, not after a leak.