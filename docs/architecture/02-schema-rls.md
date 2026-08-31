## 2. Database schema, RLS, and grants

*Dala AI — foundational architecture document. Section 2 of N.*

---

## 2.0 What this section is, and how to read the marks

This section specifies the complete Postgres schema for a **new Supabase project** (`dala-ai-prod`), with RLS, grants, and a verification protocol correct from migration `0001`. It is written so the founder can re-derive every decision without me.

Four marks are used, and the difference is load-bearing:

| Mark | Meaning |
|---|---|
| **VERIFIED (file)** | I opened the file on this machine and read the line. Cited `path:line`. |
| **VERIFIED (SQL)** | Executed **this session** against a live PostgreSQL 16.13 cluster on this machine. Output quoted. Re-runnable in minutes. |
| **VERIFIED (research)** | Executed in the research pass that precedes this document, with output quoted there. Re-runnable; re-run it. |
| **ASSUMED** | Inference or vendor-doc recall not confirmed. **Do not build on it without checking.** All listed again in §2.15. |

The single most important thing carried over from next door: **two obvious sources of truth lie by returning a plausible answer instead of an error** (`docs/security-audit-2026-08-23.md:363-364`). That failure shape recurs **six** more times in this section — in `information_schema`, in a join against an RLS-protected table, in `aclexplode(NULL)`, in a policy attached to a table whose RLS is off, in a reference table whose RLS was enabled without a policy, and in `UPDATE 0` / `DELETE 0`. Learn the shape, not the six instances.

Two versions to hold in mind: the verification cluster is PG16.13; **Supabase production is PG17**, which adds the `MAINTAIN` privilege (so ACL residue reads `Dxtm`, four privileges, not PG16's `Dxt`) and provides `UNIQUE NULLS NOT DISTINCT` (PG15+), which this schema depends on.

---

## 2.1 Premises, and what the ancestor proves

Six facts from the single-tenant ancestor set the schema's requirements. All **VERIFIED (file)**, re-read this session.

1. **The tenant is a module import.** `lib/salonBrain.js:11` and `lib/salonIntents.js:17` both `import { clientData } from '../config/currentClient.js'` at module load. The knowledge base is a 121-line committed object literal. `CLIENT_ONBOARDING.md:7-9` documents onboarding as "open `/config/currentClient.js` and update the following sections" — a code edit and a redeploy.

2. **The tenant is cached in a module-scope singleton.** `lib/salonBrain.js:142` — `let cachedBasePrompt = null`, populated once per warm process, with the comment explaining that only the *closure* section is kept out of it. At two tenants on one warm Vercel lambda this is a cross-tenant data leak, not a bug. The schema's job is to make the *only* way to get a prompt be "load rows for a `tenant_id` derived server-side", so this defect class has nowhere to live.

3. **Knowledge is the wrong shape to be data.** `config/currentClient.js:38` stores a price as `"66,000 – 88,000"` (a display string with an en dash) beside `55000` at `:39`. `:18-28` encodes a service line as a gender (`gender: "manicure"`), and `lib/systemPromptBuilder.js:69-84` renders exactly three hardcoded buckets — a staff member with any other group value **silently vanishes from the prompt**, because there is no `else`. GS Auto Center's mechanics cannot be expressed at all. `:91` stores `<br><br><a href=…>` inside an FAQ answer — channel presentation baked into knowledge, which `lib/messengerText.js` then strips back out.

4. **The deliberate omission is code, not data.** `lib/salonBrain.js:66-72` pins `CHILDREN_REPLY` with the comment *"Children's haircuts are deliberately not served through the bot (salon decision): a child-related ask must get NO price, only the salon phone."* The same decision also exists as a comment in `config/currentClient.js:34-35` and as a second copy of the sentence in the prompt template. Three copies of one business decision, none of them a row.

5. **Nothing meters spend.** `grep` for cost/budget/quota/ledger symbols across `/home/user/Matrix-Chatbot` returns nothing.

6. **No NFC normalisation exists anywhere.** `grep -rn "normalize(" --include=*.js` over the whole repo returns **zero hits** (re-confirmed this session). Every regex over customer text therefore matches or fails depending on which IME the customer used.

Two more that shape the send path and the queue, both **VERIFIED (file)** this session:

7. `lib/messengerClient.js:10` — `const SEND_URL = https://graph.facebook.com/${GRAPH_VERSION}/me/messages`. With `/me`, a token/tenant mismatch **succeeds and posts as the wrong salon**. There is no error to catch.
8. `lib/messengerClient.js:67-69` — `function pageToken(explicit) { return explicit || process.env.PAGE_ACCESS_TOKEN; }`. That `||` is the forbidden fallback to a default credential; multi-tenant it means tenant B's message goes out on tenant A's token. (`:79` gets the important half right: `authorization: Bearer ${token}` with the comment *"token in header, never in the URL"* — carry that unchanged.)

**Premise for this section:** the database is where the tenant becomes real. If `tenant_id` is not derivable server-side, not enforced by a constraint, and not present in every key, none of the application-layer discipline above it matters.

---

## 2.2 The isolation model

### Decision: shared schema, `tenant_id uuid not null` on every tenant-scoped table, RLS per tenant.

Not schema-per-tenant, not database-per-tenant. The decisive argument is not performance — it is the hard test. **Schema-per-tenant makes onboarding a DDL operation**: `create schema`, replay N migrations, re-grant, re-policy. That is writing code to onboard client #3, in the most dangerous possible form, and it multiplies the exact failure recorded next door — `20260817` applied to *one of four* tables, invisible for weeks (`security-audit-2026-08-23.md:291-302`) — by the number of tenants, along a new axis (per-tenant drift) that no catalog query you write today will think to check.

Two Dala-AI-specific reasons on top:

- **Analytics AI and the Quality layer are inherently cross-tenant.** `group by tenant_id` in a shared schema; dynamic SQL over `information_schema` in schema-per-tenant.
- **The webhook path has no session at all.** A Meta POST carries no JWT. Inbound runs as `service_role` end to end and derives the tenant from `entry[].id`. **RLS is not what protects the inbound path in any of the three models** (§2.7.4). Schema-per-tenant buys nothing where the volume and the spend actually are.

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

This costs one redundant unique index per parent and buys the only defence that survives `BYPASSRLS`: a service-role route that resolved `conversation_id` correctly but stamped the wrong `tenant_id` is **refused by the database**. PostgreSQL's own docs: *"Operations that apply to the whole table, such as TRUNCATE and REFERENCES, are not subject to row security."* Referential integrity is not filtered by policy, so this keeps enforcing under any policy state, including for `service_role`.

**The rule to write down:** *inside Postgres, the only things that bind `service_role` are constraints, foreign keys, and triggers. Policies do not.*

**The spine must be complete, and in the draft it was not.** The tenant-leak critique is right: `spend_ledger` had `id bigint … primary key` with **no `unique (tenant_id, id)`**, so `messages.ledger_id`, `quality_reviews.ledger_id` and `analytics_reports.ledger_id` were bare integers with no FK of any kind, and `outbound_messages` had no ledger link at all. That is a hole exactly where money is attributed: a worker handling two events in one warm invocation can write tenant A's Anthropic cost onto tenant B's ledger row, consume B's ceiling with A's traffic, and nothing in the database refuses. The append-only trigger does not help — it forbids `UPDATE`/`DELETE`, not a wrong `INSERT`. §2.4-E adds `unique (tenant_id, id)` and makes every ledger reference composite. Negative test 10 (§2.11) proves it.

**A generalised check replaces per-table diligence.** V15 (§2.11) finds every FK between two tables that both carry `tenant_id` where the FK does not include it. **VERIFIED (SQL)** — it correctly flagged a deliberately-planted single-column FK and nothing else.

### Append-only tables may not be the referencing side of a cascading FK

This is a new finding, verified this session, that neither critique caught in full. The draft's `spend_ledger` had `tenant_id references tenants(id) on delete cascade` *and* `foreign key (tenant_id, conversation_id) references conversations(tenant_id, id) on delete set null`, plus a `before update or delete` append-only trigger. **Referential actions execute as ordinary DML on the child and fire its row triggers.** Both directions fail. **VERIFIED (SQL):**

```
=== ON DELETE SET NULL on a conversation ===
ERROR:  append-only spend_ledger: UPDATE not permitted
CONTEXT: SQL statement "UPDATE ONLY "public"."spend_ledger"
         SET "tenant_id" = NULL, "conversation_id" = NULL WHERE …"

=== ON DELETE CASCADE from tenants (the offboarding purge) ===
ERROR:  append-only spend_ledger: DELETE not permitted
CONTEXT: SQL statement "DELETE FROM ONLY "public"."spend_ledger" WHERE $1 = "tenant_id""
```

Note the first one also tries to null `tenant_id`, which is `not null` — the composite FK's `SET NULL` nulls *every* column of the key. So as drafted, deleting a conversation (retention, or a customer erasure request) and offboarding a tenant were both impossible, and §2.8's "prove deletion by querying" was unrunnable.

**The rule:** an append-only table may be *referenced* with `NO ACTION`, but may **reference nothing** with `CASCADE`, `SET NULL`, or `SET DEFAULT`. Its cross-table tenant checks are done by a **validating `BEFORE INSERT` trigger** instead — which binds `service_role` exactly as an FK does, and creates no RI-driven mutation:

```sql
create or replace function ops.ledger_tenant_check() returns trigger
language plpgsql as $$
begin
  if new.conversation_id is not null
     and not exists (select 1 from public.conversations c
                     where c.tenant_id = new.tenant_id and c.id = new.conversation_id) then
    raise exception 'spend_ledger.conversation_id % does not belong to tenant %',
      new.conversation_id, new.tenant_id using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;
create trigger spend_ledger_tenant_check before insert on spend_ledger
  for each row execute function ops.ledger_tenant_check();
```

V14 (§2.11) asserts the rule mechanically. **VERIFIED (SQL)** — it flagged both offending constraints by `confdeltype`.

---

## 2.3 Conventions

| Convention | Choice | Why |
|---|---|---|
| Primary keys | `uuid` + `gen_random_uuid()` | No cross-tenant information in an id; no sequence to leak row counts. Append-only ledgers use `bigint generated always as identity` because ordering matters. |
| Timestamps | `timestamptz`, `default now()`, never `timestamp` | Mongolia is UTC+8. `config/closures.js:32` hardcodes `SALON_UTC_OFFSET_MINUTES = 8 * 60` — a Mongolia-only platform constant. Tenants carry an IANA zone instead. |
| Money | `numeric(14,6)` for USD spend; `bigint` MNT for tenant prices | Never `float` for money. MNT has no practical minor unit; store whole tugrik and keep `currency` explicit. |
| Closed sets | `text` + `check (col in (...))` | An enum change is a migration and a lock; a check constraint is one line and shows its full body in `pg_constraint`, so the fingerprint can read it. |
| Sets a tenant extends | lookup table + FK | e.g. `staff_groups`. Adding one is an `insert`. |
| Text | `text` + `check (length(col) <= n)` | Never `varchar(n)`. `length()` counts **characters**; Mongolian Cyrillic is 2 bytes/char, so a `varchar(n)` sized from ASCII intuition is ~1.9× too small. VERIFIED (research): `length('Үс засалт')` = 9, `octet_length` = 17. |
| Normalisation | `check (col is normalized)` on every stored user/tenant text column | PG13+ `IS NORMALIZED` (NFC by default) is cheap because checking is faster than converting. The constraint the ancestor never had (premise 6). |
| Nullable uniqueness | `unique nulls not distinct (...)` | See §2.4-A. Plain `UNIQUE` treats NULLs as distinct and permits duplicates. |
| Schemas | `public` for PostgREST-visible tables; `app` for policy helpers; `ops` for purge/export/trigger machinery and expected-state tables | `app` and `ops` are never added to PostgREST's exposed schemas. |

---

## 2.4 The table catalog

Every table is `tenant_id`-scoped unless marked **[global]**. DDL is abbreviated to load-bearing columns, keys, and indexes.

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
  retention_days_messages   int not null default 90 check (retention_days_messages between 30 and 730),
  retention_days_raw_events int not null default 7  check (retention_days_raw_events between 1 and 30),
  suspended_reason         text,
  purged_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index on tenants (status) where status <> 'purged';
```

`slug`'s check uses an ASCII class **deliberately**: a slug is a machine identifier appearing in URLs, cache keys and log lines. Rule #4 ("no `[a-z]` classes") governs patterns over **user text**. Say which one you are writing, every time.

**A `tenants` row is never deleted; it is purged in place** (§2.9). That is what removes the cascade-vs-append-only collision of §2.2 while keeping the 7-year financial record, and it makes `tenants` its own tombstone.

#### `tenant_members` **[global]** — which humans may see which tenant's dashboard. **Server-owned.**

```sql
create table tenant_members (
  tenant_id  uuid not null references tenants(id),
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

The draft classified this as tenant-authored with own-tenant CRUD. **The catalog critique is right that this is a privilege-escalation hole**: under `for all` own-tenant CRUD a `staff` member can `update tenant_members set role = 'owner'` and delete the owner's row. It moves to the server-owned class; membership changes go through a service-role route that writes `audit_log`.

One person **may** hold two tenants (an agency, or the founder during onboarding). `app.current_tenant_ids()` returns a **set**, never a scalar.

#### `tenant_channels` — the tenant routing registry. **The most security-critical table in the schema.**

```sql
create table channel_providers (            -- [global] lookup, so adding one is data
  key           text primary key check (key in ('facebook_page','instagram','sms')),
  adapter_key   text not null,
  send_host     text not null,
  send_path_tpl text not null               -- '/{external_id}/messages' — NEVER '/me/messages'
);

create table tenant_channels (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  provider      text not null references channel_providers(key),
  external_id   text not null,              -- Page ID, or IG professional account ID
  auth_flavour  text not null default 'facebook_login'
                check (auth_flavour in ('facebook_login','instagram_login','n_a')),
  meta_app_id   text,                       -- which Meta app; supports >1 app later
  business_id   text,
  granted_scopes    text[] not null default '{}',
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

Direct replacement for three defects, all **VERIFIED (file)**:
- `api/messenger.js:164-180` iterates `body.entry` and **never reads `entry.id`** — tenant routing does not exist.
- `api/messenger.js:98-101` — *"Only Page messaging events are relevant; acknowledge and ignore anything else"* returns a bare `200` for `object !== 'page'`, so Instagram is silently discarded with an HTTP 200.
- `lib/messengerClient.js:10` — `/me/messages`. `channel_providers.send_path_tpl` exists so that line cannot be written again.

**`'web'` is removed from `channel_providers`.** The tenant-leak critique is right: the draft shipped a `web` provider with no verified tenant signal defined anywhere. A widget request has no `X-Hub-Signature-256`, so the tenant could only come from the embed — i.e. from the request. The ancestor shows where that ends: `lib/cors.js:16-17` treats a missing `Origin` as allowed, so the *existing* web endpoint is an open Anthropic proxy. Re-add `'web'` when a section specifies its verified signal, not before.

**Failure modes.** *Unknown `external_id`*: `200` + drop + `webhook.unrouted` counter + alert; never auto-create. *Two rows claiming one Page*: impossible. *Token expired* (Graph `190`): `status='authorization_error'`, stop all sends for that tenant, alert; never retry. *Dead channel*: `last_webhook_at` is the watchdog — a tenant Meta silently unsubscribed produces the **absence** of requests, which nothing throws on.

#### `tenant_secrets` — per-tenant Meta page tokens. Envelope-encrypted.

```sql
create table tenant_secrets (
  tenant_id   uuid not null references tenants(id),
  channel_id  uuid,
  kind        text not null check (kind in ('meta_page_token','ig_user_token',
                                            'sip_password','webhook_shared_secret')),
  ciphertext  bytea not null,       -- AES-256-GCM(secret, DEK); iv || tag || ct
  wrapped_dek bytea not null,       -- AES-256-GCM(DEK, KEK);  iv || tag || ct
  kek_version int  not null,
  aad_fingerprint bytea not null,   -- sha256(tenant_id || kind || channel_id)
  status      text not null default 'active' check (status in ('active','rotating','revoked')),
  last_ok_at  timestamptz,
  last_error_code text,             -- Meta's NUMERIC code only. NEVER the token, never a message.
  rotated_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique nulls not distinct (tenant_id, kind, channel_id),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id)
);
alter table tenant_secrets enable row level security;
-- NO policy for anon/authenticated, and no privilege either (§2.6).
```

**The draft's key was not valid SQL, and the obvious repair opens a hole.** `primary key (tenant_id, kind, coalesce(channel_id, '000…'::uuid))` — **VERIFIED (SQL)**: `ERROR: syntax error at or near "("`. PRIMARY KEY and UNIQUE table constraints take column names, never expressions. The natural edit is `unique (tenant_id, kind, channel_id)`, and **VERIFIED (SQL)** two `meta_page_token` rows with `channel_id IS NULL` for one tenant both insert (`duplicate_default_tokens = 2`), because SQL uniqueness treats NULLs as distinct. "Which token do we send Matrix's reply with" then becomes whichever row the query happens to return — a nondeterministic credential selection on the send path, which is the `/me/messages` failure reintroduced one layer down. `UNIQUE NULLS NOT DISTINCT` (PG15+, so available on Supabase PG17) rejects the duplicate — **VERIFIED (SQL)**: `duplicate key value violates unique constraint … Key (tenant_id, kind, channel_id)=(…, meta_page_token, null) already exists`.

**Key management: envelope encryption, KEK in the Vercel environment; not Supabase Vault.** The deciding argument is blast radius under the likelier incident. Vault and envelope encryption are equivalent against a stolen database backup. They are *not* equivalent against a **leaked `sb_secret_` key**: `vault.decrypted_secrets` decrypts on read for `service_role`, so one leaked key yields every tenant's token in plaintext. Envelope encryption splits the capability across two vendors. For a solo founder on a public repo, the leaked-key incident is the more likely one. (Secondary: pgsodium is pending deprecation and Vault is `public alpha` — VERIFIED (research) from Supabase's own docs.)

`aad_fingerprint` records the GCM additional-authenticated-data binding: pass `tenant_id || kind || channel_id` as AAD so copying row A's ciphertext onto row B **fails authentication** instead of decrypting into the wrong tenant's send path.

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

**Decision: no `tenant_config` table.** A single `tenant_config jsonb` passes the "filling in a config" test superficially and fails it three ways: there is no write-time validation, so a typo in a key produces a *silently absent* prompt section — exactly the `systemPromptBuilder.js:69-84` failure where an unrecognised group makes a staff member vanish with no error; the Quality layer proposes **field-level** changes for approval, and diffing a blob is worse than diffing a row; and the admin form is generated from the schema, which a blob does not have.

Tenant scalars are columns on `tenants`; everything else is typed child tables. One narrow escape hatch: `tenants.settings jsonb not null default '{}'`, validated at write time against a stored JSON Schema (`pg_jsonschema` availability on Supabase is **ASSUMED**). Nothing the prompt builder reads may live there.

```sql
create table staff_groups (             -- replaces the 3 hardcoded buckets at systemPromptBuilder.js:69-84
  tenant_id  uuid not null references tenants(id),
  key        text not null check (length(key) between 1 and 40),
  label      text not null check (label is normalized),   -- «Эмэгтэй үсчид» / «Мотор»
  sort_order int not null default 0,
  primary key (tenant_id, key)
);

create table staff_members (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  group_key  text not null,
  full_name  text not null check (full_name is normalized),
  tier_key   text,
  active     boolean not null default true,
  sort_order int not null default 0,
  foreign key (tenant_id, group_key) references staff_groups (tenant_id, key),
  unique (tenant_id, id)
);

create table service_tiers (            -- 'Мастер' / '1-р зэрэг'; GS Auto may declare none
  tenant_id uuid not null references tenants(id),
  key       text not null,
  label     text not null check (label is normalized),
  sort_order int not null default 0,
  primary key (tenant_id, key)
);

create table service_items (            -- prices as VALUES, not display strings
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  category       text,
  canonical_name text not null check (canonical_name is normalized),
  tier_key       text,
  price_min      bigint,                                  -- NULL = deliberately unpriced
  price_max      bigint,
  currency       text not null default 'MNT' check (currency ~ '^[A-Z]{3}$'),
  unit           text not null default 'service',
  deposit_amount bigint,                                  -- was systemPromptBuilder.js prose
  quotable       boolean not null default true,           -- false ⇒ never state a price
  active         boolean not null default true,
  search_key     text generated always as (app.mn_search_fold(canonical_name)) stored,
  check (price_min is null or price_max is null or price_min <= price_max),
  check (not quotable or price_min is not null),          -- quotable ⇒ has a price
  foreign key (tenant_id, tier_key) references service_tiers (tenant_id, key),
  unique nulls not distinct (tenant_id, canonical_name, tier_key),
  unique (tenant_id, id)
);
create index on service_items (tenant_id) where active;
create index on service_items using gin (search_key gin_trgm_ops);
```

The draft wrote `unique (tenant_id, canonical_name, coalesce(tier_key,''))` — **VERIFIED (SQL)**: syntax error, same class as `tenant_secrets`. `unique nulls not distinct` is the correct form.

```sql
create table service_aliases (          -- «гель маникюр» → «Гелэн будалт»
  tenant_id  uuid not null references tenants(id),
  alias      text not null check (alias is normalized),
  service_id uuid not null,
  alias_key  text generated always as (app.mn_search_fold(alias)) stored,
  primary key (tenant_id, alias_key),
  foreign key (tenant_id, service_id) references service_items (tenant_id, id) on delete cascade
);

create table disambiguation_pairs (     -- «Сор» means two things
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ambiguous_term text not null check (ambiguous_term is normalized),
  term_key text generated always as (app.mn_search_fold(ambiguous_term)) stored,
  unique (tenant_id, term_key),
  unique (tenant_id, id)
);

create table disambiguation_candidates (   -- was a uuid[]; the spine cannot reach an array element
  tenant_id  uuid not null references tenants(id),
  pair_id    uuid not null,
  service_id uuid not null,
  primary key (tenant_id, pair_id, service_id),
  foreign key (tenant_id, pair_id)    references disambiguation_pairs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id) references service_items        (tenant_id, id) on delete cascade
);
```

The tenant-leak critique is right that `candidate_service_ids uuid[]` was a hole: Postgres cannot foreign-key an array element, so a foreign tenant's `service_items.id` could sit in the array and be rendered into the disambiguation question. A child table with composite FKs closes it. The `>= 2 candidates` invariant moves to a deferred constraint trigger or an application check — a real, small loss, and the right trade.

```sql
create table refusal_rules (            -- children's haircuts, as DATA
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
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

`forbidden_phrases` is the transferable finding from the model bake-off (`docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`, "the technique that worked"): *a rule that only describes the right answer loses to a model's disposition; a rule that forbids the specific wrong answer does not.* Taking Sonnet from 0/3 to 3/3 required promoting the rule to a first-line gate with an explicit decision step **and** naming the observed failure openings as forbidden. For Matrix, "refer to the salon phone" will lose; `forbidden_phrases = {'ойролцоогоор','баримжаагаар'}` plus a first-line gate will hold. The column exists so hardening a tenant is an `update`, and so the founder can only fill it in **after measuring the failure**.

```sql
create table canned_responses (         -- every pinned Mongolian sentence, natively reviewed
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  slot        text not null check (slot in ('closing','handoff','fallback','booking',
                                            'refusal','greeting','closure')),
  variant_key text not null default 'default',
  locale      text not null default 'mn-MN',
  body        text not null check (body is normalized and length(body) between 1 and 900),
  reviewed_by uuid references auth.users(id),     -- SERVER-WRITTEN. See §2.5.
  reviewed_at timestamptz,                        -- SERVER-WRITTEN.
  active      boolean not null default true,
  unique (tenant_id, slot, variant_key, locale),
  unique (tenant_id, id)
);
create index on canned_responses (tenant_id) where active;
```

This is `CLOSING_LINE` (`lib/salonBrain.js:52`), `HANDOFF_REPLY` (`:57-59`), `FALLBACK_REPLY`, `CHILDREN_REPLY` (`:70-72`) and `BOOKING_LINE` (`:79-81`) as rows. The source comments record why they exist: *"the handoff apology is the other spot where the model improvises (and garbles) Mongolian — so it is pinned verbatim, like the closing line"* (`lib/salonBrain.js:54-56`). A human wrote each sentence and the model copies it letter for letter. Note `BOOKING_LINE` hardcodes `QPay-ээр` and `урьдчилгаа` — GS Auto Center may use neither.

**`reviewed_by`/`reviewed_at` are attestations, not content.** The catalog critique is right that the draft put the go-live gate on a column the tenant writes, reproducing the certificates/band-9 shape one table away from where the draft was looking. **VERIFIED (SQL)** that the naive repair is also useless: `revoke insert (reviewed_by) on cx from authenticated` against a table-level INSERT grant left `relacl` unchanged, left `has_column_privilege(...,'reviewed_by','insert') = true`, and the forged insert succeeded. The fix is a table-level revoke plus per-column grants (§2.6).

```sql
create table tenant_closures (          -- holiday breaks; replaces config/closures.js entirely
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  starts_on  date not null,
  ends_on    date not null,
  title      text not null check (title is normalized),
  verbatim_message text not null check (verbatim_message is normalized),
  reviewed_by timestamptz,
  created_at timestamptz not null default now(),
  check (starts_on <= ends_on),
  exclude using gist (tenant_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
```

**That exclusion constraint does not compile without `btree_gist`.** **VERIFIED (SQL)**: `ERROR: data type uuid has no default operator class for access method "gist"`. `create extension btree_gist` is required and is added to V0's required-extension list; with it, the constraint correctly rejects an overlapping closure (verified).

Three properties of `config/closures.js` are preserved and now enforced by schema rather than prose: the customer-facing sentence is **never composed by the model** (Mongolian date suffixes are not safely generated), the window is evaluated **per request** against the tenant's own timezone (`lib/salonBrain.js:138-152` deliberately keeps the closure outside the cached prompt, with the comment *"a warm lambda can outlive the end of the break"*), and a malformed closure is **ignored with a warning**. Two things change: `SALON_UTC_OFFSET_MINUTES` becomes `tenants.timezone`, and **there is no default closure** — `config/closures.js:40-52` ships a hardcoded Naadam 2026-07-11..17 break with Matrix's message that would otherwise apply to every tenant.

### C. Knowledge base

Structured facts (services, staff, hours, contact) are the typed tables above and are rendered directly into the prompt; free prose (intro, policies, FAQ bodies, uploads) is documents → chunks and is retrieved. Retrieval unions both.

```sql
create table knowledge_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
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
  reviewed_by uuid references auth.users(id),              -- SERVER-WRITTEN, as above
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, kind, title, locale, version)
);
create index on knowledge_documents (tenant_id, status) where status = 'published';

create table knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  document_id uuid not null,
  ord         int  not null,
  body        text not null check (body is normalized),
  body_fold   text generated always as (app.mn_search_fold(body)) stored,
  body_tsv    tsvector generated always as (to_tsvector('simple', app.mn_search_fold(body))) stored,
  embedding   vector(1536),
  embedding_model text,
  token_estimate int,
  created_at  timestamptz not null default now(),
  unique (tenant_id, document_id, ord),
  foreign key (tenant_id, document_id) references knowledge_documents (tenant_id, id) on delete cascade
);
create index on knowledge_chunks (tenant_id, document_id);
create index on knowledge_chunks using gin (body_tsv);
create index on knowledge_chunks using gin (body_fold gin_trgm_ops);
create index on knowledge_chunks using hnsw (embedding vector_cosine_ops);   -- see below
```

Three decisions worth defending:

1. **`body` is plain text; markup is never stored.** `config/currentClient.js:91` stores `<br><br><a href=…>` in an FAQ answer, which the website renders and `lib/messengerText.js` strips. Store the fact and the URL; let a per-channel renderer decide markup. The cost of getting this wrong is `lib/salonBrain.js:86-106`: a 3,163-character Messenger addendum, roughly half of which exists to *undo* website-specific formatting rules from the shared template.
2. **Retrieval, not full inlining.** The measured base prompt is 7,824 characters for **40 services and 9 staff**. GS Auto Center's parts-and-labour catalogue cannot be inlined.
3. **`vector(1536)` with an explicit `embedding_model`.** A dimension change is a migration plus a backfill; recording the model makes "these rows were embedded by a different model" a query rather than a mystery. pgvector availability is **ASSUMED**; assert it in V0.

#### The vector index is the one place the spine cannot reach — and the draft's V6 certified it green

The tenant-leak critique is right, and this is the most damaging finding against the draft. The HNSW index is the **only** index in the section that does not lead with `tenant_id`. Retrieval runs as `service_role`, so RLS is not evaluated; nothing in the schema makes an unscoped ANN query *fail*, it makes it *fast*. A retrieval query missing `.eq('tenant_id', …)` returns GS Auto Center's chunks into Matrix's system prompt, spoken to a member of the public on a channel Dala AI does not control. And a *correct* filtered query post-filters after `ef_search` candidates are drawn from the whole graph, so it can silently return too few rows and the bot says "I have no information" about a service that is in the KB — HTTP 200, no error.

The draft's V6 asked only whether *some* index leads with `tenant_id`; `knowledge_chunks (tenant_id, document_id)` satisfies it, so the pack certified the table while the index the money and the leak both flow through was unscoped.

Three fixes, in order of strength:

```sql
-- 1. The ONLY retrieval interface. The predicate cannot be forgotten because it is not a parameter.
create or replace function app.search_kb(p_tenant uuid, p_embedding vector(1536), p_k int)
returns table (chunk_id uuid, document_id uuid, body text, distance float4)
language sql stable security definer set search_path = '' as $$
  select c.id, c.document_id, c.body, (c.embedding <=> p_embedding)::float4
  from public.knowledge_chunks c
  join public.knowledge_documents d
    on d.tenant_id = c.tenant_id and d.id = c.document_id and d.status = 'published'
  where c.tenant_id = p_tenant and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit least(p_k, 50)
$$;
revoke execute on function app.search_kb(uuid, vector, int) from public, anon, authenticated;
```

2. **A CI grep banning `from('knowledge_chunks')` in application code** — the same guard shape as `scripts/check-supabase-nostore.mjs` next door.
3. **V6 strengthened** to *every* index on a tenant-scoped table must lead with `tenant_id` or be listed in `ops.expected_index_exemptions`. **VERIFIED (SQL)** that the strengthened query finds non-leading indexes correctly; it also flags every `id` primary key and `tenant_channels`'s deliberate `unique (provider, external_id)`, which is exactly why it needs the exemption table rather than a bare row count.

**Where the critique overstates:** it says hash-partitioning `knowledge_chunks` by `tenant_id` makes the post-filtering problem "disappear". It does not. Hash partitioning into N partitions still places many tenants in each partition, so filtered ANN still post-filters within a partition — it reduces the competing set by roughly N×, it does not eliminate it. LIST-partition-per-tenant *would* eliminate it and is rejected outright: it makes onboarding a DDL operation, which is the one thing this whole design forbids. The correctness fix for filtered ANN is pgvector 0.8's iterative index scan (`hnsw.iterative_scan`), set inside `app.search_kb` — **ASSUMED**, verify the project's pgvector version in V0. Hash partitioning stays available as a *scale* lever later, not as the isolation control.

`app.mn_search_fold()` is defined in §2.10.

### D. Conversation and delivery

#### `contacts` — the end customer. **PII.**

```sql
create table contacts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  channel_id   uuid not null,
  external_id  text not null,               -- PSID (page-scoped) or IGSID (IG-account-scoped)
  display_name text,                        -- PII
  phone_e164   text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  locale       text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  erasure_requested_at timestamptz,
  unique (tenant_id, channel_id, external_id),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id)
);
create index on contacts (tenant_id, last_seen_at desc);
```

The unique key is `(tenant_id, channel_id, external_id)` and **not** `external_id` alone: PSIDs are page-scoped and IGSIDs are Instagram-account-scoped, so the same human messaging Matrix and GS Auto is two identifiers, and identifiers from two providers must never be assumed disjoint.

#### `conversations` / `messages`

```sql
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  channel_id  uuid not null,
  contact_id  uuid not null,
  state       text not null default 'open' check (state in ('open','idle','handed_off','closed')),
  window_expires_at timestamptz,            -- Meta's 24h window
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  message_count int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id),
  foreign key (tenant_id, contact_id) references contacts        (tenant_id, id) on delete cascade
);
create index on conversations (tenant_id, last_inbound_at desc);
create unique index on conversations (tenant_id, contact_id) where state in ('open','idle');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
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

`model_id` is a per-message fact, not a deployment constant. In the ancestor it is `lib/salonBrain.js:19` (`claude-sonnet-5`) for Messenger and `api/chat.js:13` (`claude-haiku-4-5-20251001`, a stale date-suffixed id) for the website — two channels giving measurably different answers from one knowledge base, unrecorded per reply.

#### `webhook_events` — idempotency, and the layer the ancestor does not have.

```sql
create table webhook_events (
  id           bigint generated always as identity primary key,
  provider     text not null references channel_providers(key),
  dedup_key    text not null,               -- message.mid | comment value.id
  tenant_id    uuid references tenants(id) on delete cascade,   -- NULL ⇒ unrouted
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
create index on webhook_events (received_at) where tenant_id is null;   -- unrouted watchdog
```

**Uniqueness scope is global, not per-tenant.** Meta mids are opaque and globally unique, so a cross-tenant collision means a bug or an attack — and a per-tenant key would let one event be processed twice under two tenants, a double reply *and* double spend. The insert path is `insert … on conflict do nothing returning id`; if nothing is returned, read the existing row, and **if its `tenant_id` differs from the resolved tenant, raise `webhook.dedup_cross_tenant` and alert** rather than quietly dropping.

**`on delete cascade`, not `set null`.** The tenant-leak critique is right: the draft's `on delete set null` would have left up to 7 days of `raw_payload` — verbatim customer messages, PSIDs, display names — belonging to nobody after an offboarding, outside every retention window, while `select count(*) from messages where tenant_id = :t` returned 0 and the tombstone recorded a clean deletion that was false. Two additional rules follow: any row with `tenant_id is null` (an unrouted event from a Page that is **not a Dala AI tenant**) has `raw_payload` nulled at **48 hours** regardless of any tenant setting — the partial index already exists to drive it — and the offboarding proof list includes a `webhook_events` count.

This table closes a specific ancestor defect: `lib/conversationStore.js:49-58` returns `false` from `isAlreadyHandled` on any Redis error and `markHandled` silently no-ops. That is fail-open dedup, defensible at one tenant because QStash's `deduplicationId: event.mid` (`lib/messengerQueue.js:66`, **VERIFIED (file)**) sits underneath — but both layers fail together in the case that matters: the degraded inline path runs precisely when QStash is unconfigured or hard-failed. A DB unique constraint checked **before** the Anthropic call does not fail open.

#### The queue is a second request, and its body is not a tenant signal

The tenant-leak critique is right and this belongs in the schema section because it constrains what the queue body may contain. **VERIFIED (file)**: `lib/messengerQueue.js:57-67` publishes `{psid, text, mid}` as a JSON body, and `api/messenger-worker.js:45-52` verifies the QStash signature with the comment *"We intentionally do not pin the URL claim: only our QStash signing key can produce a valid signature."* One QStash account, one signing key, all tenants. That signature proves the body came from *your* QStash exactly as `X-Hub-Signature-256` proves the payload came from *your* Meta app — and it proves nothing about which tenant the job belongs to.

**Rule:** the queue body carries exactly one field, `webhook_event_id bigint`, minted server-side by the pre-ACK insert into `webhook_events`. The worker's first statement re-reads that row and derives `tenant_id`, `channel_id` and the payload from it. **A `tenant_id`, `page_id` or `psid` field in a queue body is banned and grep-guarded in CI**, at the same volume as the `?? DEFAULT_TENANT` ban.

#### `outbound_messages` — every outbound send. The SMS seam.

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
  tenant_id     uuid not null references tenants(id),
  channel_id    uuid,
  conversation_id uuid,
  contact_id    uuid,
  ledger_id     bigint,
  kind          text not null check (kind in ('reply','private_reply','comment_reply',
                                              'sms_reminder','sms_winback','sms_review_request')),
  dedup_key     text,                       -- e.g. the comment_id for a private reply
  to_phone_e164 text,                       -- PII; hashed after the retention window
  body          text check (body is null or body is normalized),
  template_id   text,
  state         text not null default 'draft'
                check (state in ('draft','refused','queued','sent','failed','expired')),
  refusal_code  text,                       -- 'policy_forbids'|'budget_exhausted'|'cost_unknown'|'window_closed'
  unit_cost_usd numeric(12,6),
  deadline_at   timestamptz,                -- private reply: comment created_at + 7d − margin
  scheduled_for timestamptz,
  sent_at       timestamptz,
  provider_message_id text,
  provider_error_code text,
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  check (state in ('draft','refused') or unit_cost_usd is not null),
  check (state <> 'refused' or refusal_code is not null),
  foreign key (tenant_id, channel_id)      references tenant_channels (tenant_id, id),
  foreign key (tenant_id, conversation_id) references conversations   (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id)      references contacts        (tenant_id, id) on delete cascade,
  foreign key (tenant_id, ledger_id)       references spend_ledger    (tenant_id, id)
);
create unique index on outbound_messages (tenant_id, kind, dedup_key) where dedup_key is not null;
create index on outbound_messages (state, scheduled_for) where state = 'queued';
```

`check (state in ('draft','refused') or unit_cost_usd is not null)` makes it **impossible for a row to reach `queued` or `sent` with an unknown price** — the same reasoning that set `BANK_BUILD_BUDGET_USD` to zero next door: a value that refuses without depending on an unreliable read.

The partial unique index makes a **private reply** safe. A comment-to-DM private reply is single-use, non-idempotent and expiring: exactly one per comment ever, within 7 days from the comment's creation. A duplicate queue delivery must hit a uniqueness violation, **not** a second Graph call, and certainly not a second Anthropic generation. `deadline_at` is checked *before* generation, because a free check that prevents spend belongs in the same fail-closed ordering as identity → entitlement → budget.

**Customer Care AI, plainly:** the legacy message tags it would have used were retired 2026-04-27 (requests carrying them return error `100`), and the surviving 7-day `HUMAN_AGENT` extension forbids AI-authored text. So `outbound_policies` ships with `messenger`/`instagram` rows carrying `free_form_outside_window = false`, `ai_authored_allowed = false`, `per_message_cost_usd = null`, and the `sms` row exists with `window_hours = null` but **no channel binding**, because the Mongolian SIP trunk does not exist. The seam is a row and two constraints. No code branches on it.

#### `booking_handoffs` — Reception AI hands over the link; it does not book.

```sql
create table booking_handoffs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  conversation_id uuid not null,
  contact_id      uuid not null,
  link_sent       text not null,
  service_id      uuid, staff_id uuid,
  deposit_quoted  bigint,
  outcome         text not null default 'link_sent'
                  check (outcome in ('link_sent','confirmed_by_tenant','no_show','abandoned','unknown')),
  outcome_source  text check (outcome_source in ('tenant_manual','tenant_import','inferred')),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id)      references contacts      (tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id)      references service_items (tenant_id, id),
  foreign key (tenant_id, staff_id)        references staff_members (tenant_id, id)
);
create index on booking_handoffs (tenant_id, created_at desc);
```

`outcome_source` exists so "bookings driven" can never silently blend an inferred number with a confirmed one. `outcome = 'unknown'` is the honest default and must be reported as unknown, not rounded to zero.

### E. Money — the tables that must never be wrong

```sql
create table spend_budgets (
  tenant_id     uuid not null references tenants(id),
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

```sql
create table spend_ledger (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id),          -- NO ACTION. §2.2.
  occurred_at   timestamptz not null default now(),
  provider      text not null check (provider in ('anthropic','openai','meta','sms','deepgram')),
  model_id      text,                                  -- 'claude-sonnet-5' — never a date suffix
  purpose       text not null check (purpose in ('reception_reply','quality_review',
                                                 'analytics_report','kb_embedding','outbound_compose')),
  conversation_id uuid,                                -- NO FK. Validated by trigger (§2.2).
  input_tokens  int, output_tokens int,
  cache_read_tokens int, cache_write_tokens int,
  cost_usd      numeric(14,6) not null check (cost_usd >= 0),
  pricing_version text not null,                       -- so a repricing cannot rewrite history
  request_id    text,
  unique (tenant_id, id)                               -- ← the spine anchor the draft omitted
);
create index on spend_ledger (tenant_id, occurred_at desc);
create index on spend_ledger (tenant_id, purpose, occurred_at desc);

create or replace function ops.deny_mutation() returns trigger
  language plpgsql as $$ begin
    raise exception 'append-only table %: % is not permitted', tg_table_name, tg_op
      using errcode = 'insufficient_privilege';
  end $$;

create trigger spend_ledger_append_only
  before update or delete on spend_ledger
  for each row execute function ops.deny_mutation();
create trigger spend_ledger_no_truncate            -- ← the draft was missing this
  before truncate on spend_ledger
  for each statement execute function ops.deny_mutation();
revoke truncate on spend_ledger from anon, authenticated, service_role;
```

**The row-level trigger does not fire on TRUNCATE, and `service_role` holds TRUNCATE.** The catalog critique is right, and it is the sharpest finding against the draft, because the draft *teaches* that TRUNCATE bypasses RLS and then builds its money-integrity control out of a mechanism TRUNCATE also bypasses. **VERIFIED (SQL):**

```
=== TRUNCATE against a row-level BEFORE UPDATE OR DELETE trigger ===
 rows_after_truncate = 0
=== after adding a STATEMENT-level BEFORE TRUNCATE trigger ===
ERROR:  append-only spend_ledger: TRUNCATE not permitted
 rows_after_guarded_truncate = 1
```

Both controls ship: the statement trigger (which binds the table owner too) *and* the revoke (which is what V5 can see). V14 asserts every append-only table carries both.

`model_pricing` **[global]** (`model_id, pricing_version, input_usd_per_mtok, output_usd_per_mtok, cache_read_multiplier, cache_write_multiplier, effective_from`) is reference data so a price change is an insert. The ledger stores the **computed** cost plus the `pricing_version` used.

The cache-token columns exist because a cache miss is invisible in the reply and quietly bills full price. `lib/salonBrain.js:249-253` already logs `cache_read / cache_creation / uncached`; carrying that instinct into a queryable column is the upgrade.

```sql
create table usage_counters (
  tenant_id    uuid not null references tenants(id),
  channel_id   uuid,                                    -- Meta's Page budget is per Page
  metric       text not null check (metric in ('ai_replies','ai_usd','inbound_events',
                                               'outbound_sms','kb_embeddings','graph_calls')),
  window_kind  text not null check (window_kind in ('minute','hour','day','month')),
  window_start timestamptz not null,
  value        numeric(16,6) not null default 0 check (value >= 0),
  updated_at   timestamptz not null default now(),
  primary key nulls not distinct (tenant_id, channel_id, metric, window_kind, window_start)
);

create table platform_counters (            -- [global] the SHARED budget tenants contend for
  metric       text not null check (metric in ('meta_app_calls','anthropic_calls')),
  window_kind  text not null check (window_kind in ('minute','hour','day')),
  window_start timestamptz not null,
  value        numeric(16,6) not null default 0 check (value >= 0),
  primary key (metric, window_kind, window_start)
);
```

**`platform_counters` is new, and the tenant-leak critique is right that its absence was a real gap.** Meta's app-level budget is `200 × app users` per hour **shared across every tenant**, and the Page budget is per Page. GS Auto Center's post goes viral, its comment-enrichment reads and replies burn the shared quota, GS Auto stays inside its own per-tenant counter the whole time so nothing refuses, and Meta starts returning `613` to the app — so **Matrix Eco Salon's replies fail**, for a tenant that sent nothing unusual and has budget remaining. Behaviour crossed the tenant boundary because the meter was at the wrong grain. A separate table (rather than a nullable `tenant_id`) keeps the policy predicates and the primary key clean.

Both are incremented only through `security definer` functions that increment and return the new value in one statement, so two concurrent replies cannot both read "under budget":

```sql
create or replace function app.bump_usage(p_tenant uuid, p_channel uuid, p_metric text,
                                          p_kind text, p_window timestamptz, p_delta numeric)
returns numeric language sql security definer set search_path = '' as $$
  insert into public.usage_counters (tenant_id, channel_id, metric, window_kind, window_start, value)
  values (p_tenant, p_channel, p_metric, p_kind, p_window, p_delta)
  on conflict (tenant_id, channel_id, metric, window_kind, window_start)
  do update set value = public.usage_counters.value + excluded.value, updated_at = now()
  returning value;
$$;
revoke execute on function app.bump_usage(uuid,uuid,text,text,timestamptz,numeric)
  from public, anon, authenticated;
```

**Every function is a migration file, no exceptions.** The sibling audit records `increment_chat_usage` / `increment_ielts_usage` as *invoked but defined nowhere in the repo* — "the database cannot be reproduced from the repo, and their `security definer` / `search_path` properties cannot be reviewed" (`security-audit-2026-08-23.md:232-234`). V10 catches exactly this.

**The failure mode that must never be written:** the quota helper returns 503 on any error and is never wrapped in `try { check() } catch { continue }`. That exact pattern was the HIGH finding next door. A 503 costs a retry; failing open costs money — and here it costs *another tenant's* money, which is worse because it is not yours to lose.

### F. Quality, analytics, and audit

```sql
create table quality_reviews (          -- internal only. Never client-facing.
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  conversation_id uuid, message_id uuid, ledger_id bigint,
  verdict       text not null check (verdict in ('ok','unanswered','wrong_fact','policy_breach',
                                                 'language_quality','price_leak')),
  severity      text not null default 'low' check (severity in ('low','medium','high')),
  rationale     text,
  reviewer      text not null check (reviewer in ('model','founder')),
  model_id      text,
  founder_agrees boolean,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, message_id)      references messages      (tenant_id, id) on delete cascade,
  foreign key (tenant_id, ledger_id)       references spend_ledger  (tenant_id, id)
);
create index on quality_reviews (tenant_id, created_at desc) where verdict <> 'ok';
```

#### `kb_change_proposals` — proposed KB updates. **Never auto-applied.**

```sql
create table kb_change_proposals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  target_kind  text not null check (target_kind in ('knowledge_document','service_item',
                                                    'canned_response','refusal_rule','service_alias')),
  -- ONE typed column per target, each carrying a composite FK. No polymorphic uuid.
  target_document_id       uuid,
  target_service_id        uuid,
  target_canned_response_id uuid,
  target_refusal_rule_id   uuid,
  target_alias_key         text,
  proposed_patch jsonb not null,
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected','applied','superseded')),
  proposed_by  text not null default 'quality_ai',
  approved_by  uuid references auth.users(id),
  approved_at  timestamptz, applied_at timestamptz, applied_audit_id bigint,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  check (status <> 'applied'  or (approved_by is not null and applied_at  is not null)),
  check (   (target_kind = 'knowledge_document' and target_document_id is not null)
         or (target_kind = 'service_item'       and target_service_id is not null)
         or (target_kind = 'canned_response'    and target_canned_response_id is not null)
         or (target_kind = 'refusal_rule'       and target_refusal_rule_id is not null)
         or (target_kind = 'service_alias'      and target_alias_key is not null)),
  foreign key (tenant_id, target_document_id)        references knowledge_documents (tenant_id, id),
  foreign key (tenant_id, target_service_id)         references service_items       (tenant_id, id),
  foreign key (tenant_id, target_canned_response_id) references canned_responses    (tenant_id, id),
  foreign key (tenant_id, target_refusal_rule_id)    references refusal_rules       (tenant_id, id),
  foreign key (tenant_id, target_alias_key)          references service_aliases (tenant_id, alias_key)
);
create index on kb_change_proposals (tenant_id, status) where status = 'pending';

create table kb_proposal_evidence (      -- was evidence_review_ids uuid[]
  tenant_id   uuid not null references tenants(id),
  proposal_id uuid not null,
  review_id   uuid not null,
  primary key (tenant_id, proposal_id, review_id),
  foreign key (tenant_id, proposal_id) references kb_change_proposals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, review_id)   references quality_reviews     (tenant_id, id) on delete cascade
);
```

**The polymorphic `target_id uuid` was a genuine hole and the tenant-leak critique's scenario is exactly right.** The Quality layer reviews a batch spanning both tenants — that is its job. It emits a proposal with `tenant_id = matrix` and a `target_id` belonging to GS Auto because both were in its context window. Every draft constraint passed: they verify that *someone approved*, never that the target belongs to the proposal's tenant. The founder sees "Matrix — update handoff message", approves, and GS Auto's customers are told to call a hair salon, with an audit row recording a Matrix action. Typed columns with composite FKs make the database refuse it, at the one place a cross-tenant write is genuinely *expected* to be attempted.

The two status `check` constraints remain the founder-approval gate expressed as a constraint rather than as application discipline, plus a `before update` trigger forbidding `pending → applied` in one step. The Quality layer **cannot** auto-apply, even through a service-role bug.

```sql
create table analytics_reports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  period_start date not null, period_end date not null,
  conversations_total int not null, unique_contacts int not null,
  bookings_link_sent int not null, bookings_confirmed int not null,
  revenue_attributed_mnt bigint,
  attribution_basis text not null check (attribution_basis in ('tenant_confirmed','inferred','none')),
  ai_cost_usd  numeric(12,6) not null,
  narrative    text,
  model_id     text, ledger_id bigint,
  generated_at timestamptz not null default now(),
  unique (tenant_id, period_start, period_end),
  foreign key (tenant_id, ledger_id) references spend_ledger (tenant_id, id)
);

create table audit_log (                -- [global] append-only, RANGE-partitioned by month
  id          bigint generated always as identity,
  at          timestamptz not null default now(),
  actor_kind  text not null check (actor_kind in ('user','service','founder','system','trigger')),
  actor_user_id uuid,
  tenant_id   uuid,                     -- plain uuid, NO FK: this table outlives everything
  action      text not null,
  target_table text, target_id text,
  before_snapshot jsonb, after_snapshot jsonb,
  request_id  text, ip_hash bytea,      -- hashed, never raw
  check (before_snapshot::text !~ 'EAA[A-Za-z0-9_-]{30,}'),   -- no Meta token may be logged
  check (after_snapshot::text  !~ 'EAA[A-Za-z0-9_-]{30,}'),
  primary key (at, id)
) partition by range (at);
create index on audit_log (tenant_id, at desc);
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function ops.deny_mutation();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function ops.deny_mutation();
revoke truncate on audit_log from anon, authenticated, service_role;
```

**Partitioning `audit_log` by month is how append-only and a 2-year retention coexist.** An append-only trigger makes `delete from audit_log where at < …` impossible; **VERIFIED (SQL)**: the delete raises, while `alter table audit_log detach partition …; drop table …` succeeds and removes the rows, because DDL does not fire DML triggers. `spend_ledger` is deliberately *not* partitioned — its retention is 7 years with no deletion, and partitioning would force the partition key into `unique (tenant_id, id)` and break the spine. `webhook_events` is not partitioned either, because its `unique (provider, dedup_key)` must stay global.

The two `EAA…` check constraints are a deliberate, narrow ASCII pattern against a **machine credential shape**, and the direct answer to the sibling's still-open finding that `lib/qpay.ts` logs full bank details on error (`security-audit-2026-08-23.md:235-236`). A constraint that refuses the insert is stronger than a code review that asks people to remember.

```sql
create table channel_health (           -- the watchdog for silently-unsubscribed pages
  channel_id uuid primary key, tenant_id uuid not null,
  last_webhook_at timestamptz, last_send_ok_at timestamptz,
  last_error_code text, last_error_at timestamptz,
  consecutive_send_failures int not null default 0,
  subscription_verified_at timestamptz,
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade
);

create table contact_erasure_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contact_id uuid, external_id text,
  source text not null check (source in ('meta_callback','tenant_request','customer_direct')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz, rows_deleted int
);

create table tenant_offboardings (      -- [global] proof of deletion. No PII, ever.
  tenant_id uuid primary key references tenants(id),
  export_manifest_sha256 bytea,
  scheduled_purge_at timestamptz not null,
  purged_at timestamptz,
  row_counts jsonb not null,            -- {"messages": 14231, "contacts": 604, ...}
  requested_by uuid, confirmed_by uuid
);
```

Because a `tenants` row is purged in place rather than deleted (§2.4-A), `tenant_offboardings` can and does carry a real FK.

### Onboarding client #3 — the falsifiable test

GS Auto Center, end to end, touching **zero lines of code**:

```sql
insert into tenants (slug, display_name, timezone)
  values ('gs-auto','GS Auto Center','Asia/Ulaanbaatar');
insert into tenant_channels (tenant_id, provider, external_id, auth_flavour)
  values (:t,'facebook_page','1029…','facebook_login');
-- token via the admin route → tenant_secrets (encrypted; never a column, never an env var)
insert into staff_groups  values (:t,'engine','Мотор',1),(:t,'chassis','Явах анги',2),(:t,'electrical','Цахилгаан',3);
insert into service_tiers values (:t,'std','Стандарт',1);
insert into service_items (tenant_id, canonical_name, tier_key, price_min, price_max)
  values (:t,'Тос солих','std',35000,55000);
insert into canned_responses (tenant_id, slot, body) values (:t,'handoff','…');
insert into knowledge_documents (tenant_id, kind, title, body, status)
  values (:t,'intro','Танилцуулга','…','published');
insert into spend_budgets values (:t,'monthly_usd',25.00,'canned_reply');
```

No `gender` field abused for a service line. No hardcoded headings. No deposit table in a shared template. If client #3 needs something these tables cannot express, **add a column — never a branch**.

---

## 2.5 Server-owned tables, and why ownership RLS is not enough

### The principle

Row-Level Security answers exactly one question: *does this row belong to this caller?* It has no opinion about **what the row says**. From `security-audit-2026-08-23.md:126-130`:

> **Read-only** (`usage_limits`, `progress`, `test_history`, `certificates`) — the row is an *assertion about the user* that the product treats as true. Ownership is not integrity: an own-row policy checks *who* the row belongs to, never *what it says*.

Next door, a user with an own-row `INSERT`/`UPDATE` policy on `certificates` could write themselves a band-9 IELTS result on their own row. Every policy passed. Every row belonged to the person who wrote it. The system was still lying.

Dala AI's versions: a tenant sets `usage_counters.value = 0` and gets unlimited replies; sets `tenants.plan = 'full'`; writes `analytics_reports.revenue_attributed_mnt = 9_000_000` and shows an investor; sets `spend_ledger.cost_usd = 0`; **or writes `canned_responses.reviewed_by = <the founder's uuid>` and clears the go-live gate the founder is relying on.** That last one is the catalog critique's finding and it is correct — **VERIFIED (SQL)** that with ownership RLS correctly enabled and a tenant-authored `for all` policy in force, a tenant inserts a row attesting to a review that never happened.

**Rule:** if the *server* derives the value, the client gets `SELECT` and nothing else — regardless of whose row it is. And when a mostly-tenant-authored table carries even one server-derived column, the client's write grant is **per column**, not per table.

### The classification

| Class | Tables | Client rights |
|---|---|---|
| **Server-owned** | `tenants`, `tenant_members`, `spend_ledger`, `spend_budgets`, `usage_counters`, `platform_counters`, `analytics_reports`, `quality_reviews`, `kb_proposal_evidence`, `webhook_events`, `outbound_messages`, `booking_handoffs`, `messages`, `conversations`, `contacts`, `audit_log`, `channel_health`, `tenant_offboardings`, `contact_erasure_requests`, `knowledge_chunks` | `SELECT` own tenant only, **plus per-command restrictive denies** |
| **Secret** | `tenant_secrets` | **nothing at all**; not even `SELECT`. `service_role` reaches it via `BYPASSRLS`. |
| **Platform reference** | `channel_providers`, `model_pricing`, `outbound_policies` | RLS **on**, `SELECT`-to-`authenticated` policy `using (true)` — never "RLS off" |
| **Platform admin** | `platform_admins` | admin-read-only |
| **Tenant-authored, whole-row** | `service_items`, `service_tiers`, `service_aliases`, `staff_groups`, `staff_members`, `tenant_closures`, `disambiguation_pairs`, `disambiguation_candidates` | own-tenant CRUD with `WITH CHECK` repeating the predicate |
| **Tenant-authored, column-split** | `knowledge_documents`, `canned_responses` | own-tenant CRUD on content columns only; `reviewed_by`/`reviewed_at`/`status`/`published_at` are server-written |
| **Approval-gated** | `refusal_rules`, `kb_change_proposals`, `tenant_channels` | `SELECT` own tenant; writes only via a service-role route using `tenantFromSession` (§2.7) |

`messages`, `conversations` and `contacts` are server-owned even though they are "the tenant's customers": the tenant did not author a customer's message, the platform recorded it. A tenant that can edit `messages.body` can fabricate a conversation, which breaks Quality, breaks Analytics, and breaks any dispute.

**Platform reference tables get RLS *on* with a read policy, not RLS off.** **VERIFIED (SQL)**: a table with RLS enabled and no policy returns `reference_rows_visible = 0` to `authenticated` — silently, HTTP 200 — so blanket-enabling RLS without a paired policy is itself the plausible-empty failure. This is why §2.6's catalog-driven enable loop must be paired with `ops.expected_rls` (§2.11), not run alone.

### The lockdown, and the exact shape

Two facts change the shape from what the sibling shipped, both **VERIFIED (research)**:

**Fact 1 — `as restrictive for all using (true) with check (false)` does not stop `DELETE`.** `DELETE` has no `WITH CHECK`; it is governed by `USING` alone, which is `true`. Next door the hole is masked twice (no permissive write policy, and no `DELETE` grant), so it is **not a live finding there** — but it must not be copied forward unexamined.

**Fact 2 — `for all` applies `USING` to `SELECT`.** So `as restrictive for all using (false)` would silently blind the dashboard. Never collapse the three.

```sql
-- ops/lock_server_owned.sql — THIS ARRAY IS A SECURITY BOUNDARY.
do $$
declare t text;
  server_owned text[] := array[
    'tenants','tenant_members','spend_ledger','spend_budgets','usage_counters','platform_counters',
    'analytics_reports','quality_reviews','kb_proposal_evidence','webhook_events','outbound_messages',
    'booking_handoffs','messages','conversations','contacts','audit_log','channel_health',
    'contact_erasure_requests','tenant_offboardings','knowledge_chunks',
    'refusal_rules','kb_change_proposals','tenant_channels'
  ];
begin
  foreach t in array server_owned loop
    execute format('alter table public.%I enable row level security', t);

    -- Idempotent, and drops by NAME so a re-run cannot leave a stale permissive write policy.
    execute format('drop policy if exists %I on public.%I', t||'_no_client_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_no_client_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_no_client_delete', t);
    execute format('drop policy if exists %I on public.%I', t||'_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t||'_update_own', t);
    execute format('drop policy if exists %I on public.%I', t||'_delete_own', t);

    execute format($f$create policy %I on public.%I
      as restrictive for insert to anon, authenticated with check (false)$f$, t||'_no_client_insert', t);
    execute format($f$create policy %I on public.%I
      as restrictive for update to anon, authenticated using (false) with check (false)$f$, t||'_no_client_update', t);
    execute format($f$create policy %I on public.%I
      as restrictive for delete to anon, authenticated using (false)$f$, t||'_no_client_delete', t);

    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
```

The explicit `drop policy … _insert_own` lines exist because the sibling's exact regression was a `schema.sql` policy loop that **recreated** the permissive own-row write policies the lockdown had revoked (`security-audit-2026-08-23.md:111-113`), so any environment provisioned from that file reproduced the original findings intact. Idempotence is not enough; the loop must actively remove the shapes it forbids.

---

## 2.6 The grant model

### Migration `0001`, before any table exists

Supabase's bootstrap runs `grant all on all tables in schema public to anon, authenticated` and sets matching **default privileges**. That is the documented source of the residue found next door (`security-audit-2026-08-23.md:418-419`): after two lockdown migrations revoked `INSERT/UPDATE/DELETE`, the raw ACL still read

```
{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=rDxtm/postgres,service_role=arwdDxtm/postgres}
```

`Dxtm` = **TRUNCATE, REFERENCES, TRIGGER, MAINTAIN** — four privileges nobody revoked, on the four most sensitive tables, for months. **VERIFIED (research)**: with a restrictive `with check (false)` policy in force and `authenticated` holding TRUNCATE, `truncate conversations;` succeeded and emptied the table; after `revoke truncate, references, trigger`, the same statement returned `permission denied`. The only thing standing between `authenticated` and an empty table was PostgREST declining to expose the verb — an API-surface decision, not a privilege boundary.

```sql
-- Default privileges are per-creating-role. CLI migrations run as postgres.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public;  -- ← added

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke execute on all functions in schema public from public;          -- ← added

-- anon has NO business in this product: there is no anonymous data surface.
revoke usage on schema public from anon;      -- necessary on Supabase, and NOT sufficient
revoke usage on schema public from public;    -- ← the one that actually closes it
grant  usage on schema public to authenticated, service_role, postgres;

create schema app;  create schema ops;
revoke all on schema app, ops from anon, authenticated, public;
grant usage on schema app to authenticated;   -- policy helpers only; app is NOT PostgREST-exposed
```

**On the catalog critique's finding here: the conclusion is right, the stated reason is wrong for this project.** It reports that `revoke usage on schema public from anon` "names a role that never held it" — true on a vanilla cluster, where **VERIFIED (SQL)** `nspacl` reads `{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}` and `has_schema_privilege('anon','public','usage')` is already `true` via `PUBLIC`. But Supabase's bootstrap *does* grant USAGE on `public` to `anon` directly, so on a real Dala AI project that revoke is necessary. It is simply not **sufficient**, because `PUBLIC` holds USAGE independently. Both lines ship, and V13 is what proves it, since no draft V-query read `nspacl` at all.

Same shape for functions: **VERIFIED (SQL)** a function created in `public` carries `{=X/postgres,postgres=X/postgres}` — `PUBLIC` holds EXECUTE — and `revoke … from anon, authenticated` does not touch it. Any future SECURITY DEFINER helper placed in `public` would be anon-executable and invisible to the draft's V11, which read `app` only.

### Column-split grants for the two attestation tables

```sql
revoke insert, update on canned_responses    from authenticated;
grant  insert (tenant_id, slot, variant_key, locale, body, active),
       update (slot, variant_key, locale, body, active) on canned_responses to authenticated;

revoke insert, update on knowledge_documents from authenticated;
grant  insert (tenant_id, kind, title, locale, body, source_uri, checksum),
       update (title, body, source_uri, checksum)       on knowledge_documents to authenticated;
```

**Column-level `REVOKE` against a table-level grant is a no-op.** **VERIFIED (SQL)**, isolated: after `grant insert on cx to authenticated; revoke insert (reviewed_by) on cx from authenticated;`, `relacl` was unchanged (`authenticated=a/postgres`), `has_column_privilege(…,'reviewed_by','insert')` was still `true`, and the forged insert landed. The table-level revoke must come first, then per-column grants. **VERIFIED (SQL)** that the resulting shape refuses the forged insert with `permission denied for table` while a legitimate insert of content columns succeeds.

### The resulting invariants — one line each, and all three now checkable

1. `anon` appears in **zero** ACL rows (table, column, function or schema) and **zero** policies anywhere. Strictly stronger than what next door reached after three migrations, and free on day one.
2. `PUBLIC` (grantee OID 0) appears in **zero** rows of V3, V11 or V13.
3. No client role holds any table-level privilege other than `SELECT`; any INSERT/UPDATE it holds is column-scoped and enumerated in `ops.expected_column_acl`.

`service_role` keeps the full set on everything **except `TRUNCATE` on the two append-only tables**, which is revoked.

### Supabase's 2026 key model

Start on the new keys on day one. Legacy `anon`/`service_role` JWTs work until end-2026, but `sb_publishable_…` / `sb_secret_…` are **individually named and revocable**, and you can mint **one secret key per backend component**: `webhook-ingest`, `worker`, `analytics`, `admin`, `purge`, `ci`. A leak from the webhook path then forces **one** rotation, not a full-project one. Do the JWT-signing-keys migration at project creation. (VERIFIED (research) from Supabase docs; gotcha: new keys go on the `apikey` header — sent as `Authorization: Bearer` they are parsed as a JWT and rejected.)

---

## 2.7 The RLS policy set

### 2.7.1 Helper functions

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

revoke execute on function app.current_tenant_ids(), app.is_platform_admin() from public, anon;
grant  execute on function app.current_tenant_ids(), app.is_platform_admin() to authenticated;
```

`set search_path = ''` is **mandatory** on any `SECURITY DEFINER` function — without it the function is a privilege-escalation primitive, and every object reference must be schema-qualified.

**Why `SECURITY DEFINER` and not an inline `EXISTS` join.** A policy that joins `tenant_members` evaluates that join **under `tenant_members`'s own RLS**. If `tenant_members` has RLS enabled and no `authenticated` policy — which it now does, since it moved to the server-owned class — the join returns nothing and **the outer query returns zero rows with no error**. VERIFIED (research):

```
 Seq Scan on perf_rows (actual rows=0 loops=1)
   Rows Removed by Filter: 200000
   SubPlan 2
     ->  Seq Scan on tenant_members tm (actual rows=0 loops=1)
           Filter: (false AND (user_id = …))    -- the deny-all policy collapsed to false
 Execution Time: 3599.326 ms
```

An empty dashboard, 3.6 seconds, HTTP 200, `error: null`.

### 2.7.2 The predicate shape

VERIFIED (research), 200k rows, PG 16.13:

| Policy predicate | Index? | Plan | Time |
|---|---|---|---|
| `tenant_id = (auth.jwt()->>'tenant_id')::uuid` | no | Seq Scan | 224.5 ms |
| `tenant_id = (select (auth.jwt()->>'tenant_id')::uuid)` | no | Seq Scan + InitPlan | 15.1 ms |
| `tenant_id = (select …)` | yes | Index Only Scan | 8.8 ms |
| **`tenant_id = any ((select app.current_tenant_ids())::uuid[])`** | yes | **Index Only Scan** | **7.0 ms** |
| `(select app.current_tenant_ids()) @> array[tenant_id]` | yes | **Seq Scan** | 54.7 ms |

The `(select …)` wrap is free and sometimes worth 15× (Supabase lint `0003_auth_rls_initplan`); it is not the 100× folklore claims, but you cannot predict which query loses its index. `= scalar` and `= ANY(array)` are index conditions; `array @> array[col]` is not — so `@>`, which reads more elegantly, forces a sequential scan. And `tenant_id` must lead an index on every tenant-scoped table. One parenthesisation trap: `= any ((select f()))` is parsed as `= ANY (subquery)` and fails with `operator does not exist: uuid = uuid[]`; the `::uuid[]` cast forces the array reading.

**Name the role in every policy.** `to authenticated` means the policy is not evaluated for other roles.

### 2.7.3 The policies

```sql
-- 1. Server-owned: read own tenant, plus the three restrictive denies from §2.5.
create policy conversations_select_own on conversations
  for select to authenticated
  using (tenant_id = any ((select app.current_tenant_ids())::uuid[]));

-- 2. Tenant-authored: CRUD, with WITH CHECK repeating the predicate.
create policy service_items_rw_own on service_items
  for all to authenticated
  using      (tenant_id = any ((select app.current_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.current_tenant_ids())::uuid[]));

-- 3. Platform reference: RLS on, read-all.
create policy channel_providers_read on channel_providers for select to authenticated using (true);
```

**Omitting `WITH CHECK` on an `UPDATE`/`ALL` policy is a tenant-hopping write.** `USING` gates which rows you may *touch*; `WITH CHECK` gates what they may *become*. Without it, `update service_items set tenant_id = '<other tenant>'` hands the row away. V7 flags any write policy missing it.

#### The founder's cross-tenant read, and the gate the draft made inert

```sql
create policy conversations_select_admin on conversations
  for select to authenticated using ((select app.is_platform_admin()));
```

For `messages`, **no generic admin policy exists**, and the body gate is **RESTRICTIVE**:

```sql
create policy messages_select_own on messages for select to authenticated
  using (tenant_id = any ((select app.current_tenant_ids())::uuid[])
         or (select app.is_platform_admin()));

create policy messages_admin_body_gate on messages as restrictive for select to authenticated
  using (tenant_id = any ((select app.current_tenant_ids())::uuid[])
         or exists (select 1 from platform_admins a
                    where a.user_id = (select auth.uid())
                      and a.revoked_at is null and a.can_read_message_bodies));
```

**The tenant-leak critique is right that the draft's version was inert.** Permissive policies OR together, so a generic `using (is_platform_admin())` on `messages` alongside a narrower `can_read_message_bodies` policy means the loose one wins. **VERIFIED (SQL)**: two permissive `SELECT` policies, `using (true)` and `using (false)`, returned the row (`gate inert? | GS customer message`); replacing the second with `as restrictive … using (false)` returned `rows_visible_with_restrictive_gate = 0`. V7b asserts that no table carries more than one permissive `SELECT` policy naming `is_platform_admin`.

#### How is "admin" established?

| Option | Always current? | Blast radius if wrong | Verdict |
|---|---|---|---|
| **A. Postgres role** (`dala_admin` selected by the JWT `role` claim) | yes | **total** — a misconfigured claim locks you out or grants a customer admin | **Rejected for v1.** |
| **B. JWT claim** `app_metadata.is_founder` via the access token hook | **no** — stale until refresh (default 1h) | revocation takes up to an hour | **Adopted as a cache** for edge/middleware gating only. |
| **C. Table** `platform_admins` + `SECURITY DEFINER` helper | yes | one `update` revokes instantly; the grant is a row, so it is auditable | **Adopted as the authority.** |

If the hook is used at all: the claim goes in **`app_metadata`, never `user_metadata`** — `user_metadata` is user-writable through `auth.updateUser()`, so a `tenant_id` or `is_founder` there is a self-service privilege-escalation button. And the hook must be trivially simple: it runs inside the Auth server's transaction, so if it throws, **token issuance fails for everyone**.

**Admin access is read-only by policy.** There is no admin write policy anywhere. Founder writes (approving a proposal, suspending a tenant) go through service-role routes that write `audit_log`. Fetching a raw customer thread goes through an RPC that writes an `audit_log` row, because a policy cannot log and "the founder read a salon's customer conversations" is exactly the event that should leave a trace.

### 2.7.4 `service_role`, `FORCE ROW LEVEL SECURITY`, and the real last line of defence

VERIFIED (research), by execution:

| Question | Answer |
|---|---|
| Does `service_role` bypass RLS? | **Yes, completely** — it holds `BYPASSRLS`. It read both tenants' rows and inserted into the *other* tenant while a policy scoped the table to one. |
| Does `alter table … force row level security` fix that? | **No.** Still saw all rows. |
| What does `FORCE` change? | It subjects the **table owner** to RLS. Owner saw 1 row before, 0 after. |

PostgreSQL's docs: *"Superusers and roles with the BYPASSRLS attribute always bypass the row security system."* So `relforcerowsecurity` stays `false`, matching the sibling's finding at `security-audit-2026-08-23.md:391-393`.

**Therefore: there is no last line of defence inside Postgres for a service-role scoping bug except constraints, foreign keys, and triggers.** Dala AI's entire inbound path — webhook → tenant lookup → Anthropic → send — has no user session and runs as `service_role` end to end. **RLS protects the dashboard and protects essentially nothing on the path that carries all the volume and all the spend.** Every "we have RLS" reassurance must be read against that sentence.

What substitutes, in order:

1. **Exactly two functions may mint a `tenant_id`, and nothing else may.** The draft specified only the first, and the tenant-leak critique is right that this left the "approval-gated" class — `refusal_rules`, `kb_change_proposals`, `tenant_channels` — moved off RLS with nothing put in its place, so a signed-in GS Auto owner could `POST` a body naming Matrix's `tenant_id` and silence Matrix's Messenger with no policy violation, because no policy ran.

   - `tenantFromWebhook(req)` — verify `X-Hub-Signature-256` over raw bytes *before* parsing (the ancestor already does this correctly: `lib/messengerClient.js:25-42`, constant-time, failing closed when the secret is absent, with raw bytes preserved by `bodyParser: false` at `api/messenger.js:16-20`; carry it wholesale), then `(provider, external_id) → tenant_id` through `tenant_channels`'s unique index, **per `entry[]`, never per request**.
   - `tenantFromSession(req)` — `app.current_tenant_ids()` for the caller's JWT, intersected with any requested id. A platform admin is the only identity that may name a tenant it is not a member of, and that write goes to `audit_log`.
   - **`tenant_id` read from `req.body` or `req.query` is banned and grep-guarded in CI**, alongside `?? DEFAULT_TENANT`, which is the single biggest tenant-misidentification risk and is always written for local testing.

1b. **The queue body carries `webhook_event_id` and nothing else** (§2.4-D). The QStash signature is not a tenant signal.

2. **Note what a signature does not prove.** One Meta app means one app secret, so every subscribed Page signs under the same key. A valid signature proves the payload is untampered and came from someone holding your app secret. Only the registry lookup identifies the tenant.

3. **The composite-FK spine** (§2.2), now complete through the ledger and the Quality layer.

4. **Append-only triggers plus the TRUNCATE statement trigger and revoke**; the approval `check` constraints on `kb_change_proposals`; the validating `BEFORE INSERT` trigger on `spend_ledger`.

5. **One chokepoint** — `withTenant(req, handler)` resolving the tenant, opening the ledger, and returning a client with `tenant_id` pre-bound. Route code should not be *able* to build a query without it. The `guardAiRoute()` lesson: one gate, no local re-implementations. `app.search_kb()` is the same idea for retrieval.

6. **`tenant_id` on every log line and every cache/rate-limit key.** In the ancestor, `lib/messengerProcess.js:80,88,117` stamp every log line with `SALON_NAME`, a module constant (`lib/salonBrain.js:46`) — the *build's* tenant, not the *request's* — and Redis keys are `msgr:hist:<psid>` / `msgr:done:<mid>` with no tenant at all.

7. **Negative tests in CI** (§2.11). The catalog proves configuration; only a test proves enforcement.

---

## 2.8 Verification: what the pack must query, and why the draft's version passed a broken schema

Three findings from the catalog critique are correct and severe, and all three are about what the pack **did not** query.

### 2.8.1 A policy on a table with RLS off is created, looks perfect, and is never evaluated

The draft enabled RLS only inside §2.5's hand-written array (20 tables) plus `tenant_secrets`. **Fourteen tables — `tenant_members`, `staff_groups`, `staff_members`, `service_tiers`, `service_items`, `service_aliases`, `disambiguation_pairs`, `canned_responses`, `tenant_closures`, `knowledge_documents`, `platform_admins`, `channel_providers`, `model_pricing`, `outbound_policies` — had a policy and no `enable row level security` anywhere.** These are precisely the tables the dashboard must write, so a DML grant is the *first* thing added when the dashboard 403s.

**VERIFIED (SQL)**, reproducing it exactly:

```
 tablename | policyname | cmd | has_qual | has_check      ← V9 reads perfect
 si        | si_rw_own  | ALL | t        | t
 relname | relrowsecurity
 si      | f
 cross-tenant read | GS: Тос солих
 after cross-tenant write | GS: Тос солих | 1             ← tenant B rewrote tenant A's price
```

V7 returned zero hits and V9 displayed a textbook tenant-scoped policy while the cross-tenant write landed.

**Fix, in two parts.** Drive the enable off the catalog, not an array — and pair it with an expected-state table, because blanket-enabling silently blinds any reference table that has no policy (§2.5, verified):

```sql
do $$ declare t regclass; begin
  for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p')
  loop execute format('alter table %s enable row level security', t); end loop;
end $$;
```

plus new query **V2b** — policies on tables where RLS is off; must return zero rows. **VERIFIED (SQL)**: it returned exactly the planted row.

### 2.8.2 V12, the deploy gate, was blind to every control that binds `service_role`

The draft's fingerprint covered `relrowsecurity`, `pg_policies`, `relacl` and `pg_proc` in `('public','app')` — i.e. exactly the things that do *not* bind `service_role`, and none of the things that do. No `pg_constraint`, no `pg_trigger`, no `pg_index`, no `ops` schema, and no function **body**. Production could lose `unique (provider, external_id)`, lose the spine, lose the append-only trigger, and have `ops.deny_mutation()` silently redefined to `return new`, and the gate would report staging and production byte-identical. The critique demonstrated four such drifts producing an unchanged digest. §2.11's V12 adds constraints, triggers, indexes, the `ops` schema and `md5(prosrc)`.

### 2.8.3 The ACL queries read one of four privilege surfaces

`relacl` is one of four. **VERIFIED (SQL)** for each of the other three: `nspacl` shows `PUBLIC` holding USAGE on `public` (§2.6); `proacl` shows `PUBLIC` holding EXECUTE on a `public` function; and column grants are entirely invisible —

```
 V3/V5 (relacl)              | SELECT
 attacl (unread by the pack) | body      | {authenticated=aw/postgres}
 attacl (unread by the pack) | slot      | {authenticated=aw/postgres}
 attacl (unread by the pack) | tenant_id | {authenticated=a/postgres}
```

V3 says `SELECT`; `authenticated` in fact holds INSERT and UPDATE on those columns. Since §2.6 now *depends* on column grants for the attestation tables, a pack that cannot read `attacl` cannot verify its own design. New query **V13** covers all three.

### 2.8.4 The pack produced output, not a verdict

V2 was specified as "must return zero rows or be on a written allow-list" with no allow-list written — while `tenant_secrets` is *designed* to sit permanently in V2's output. V5's `having … <> 'SELECT'` flags every legitimately tenant-writable table by construction, and there are ten of them. **A check that always returns rows is a check nobody reads** — the exact mechanism cited for the sibling's failure. Expected state is checked in as data in `ops`, and CI asserts a **symmetric** diff:

```sql
create table ops.expected_rls (relname text primary key, rls boolean not null, min_policies int not null);
create table ops.expected_acl (relname text, grantee text, privs text, primary key (relname, grantee));
create table ops.expected_column_acl (relname text, attname text, grantee text, privs text,
                                      primary key (relname, attname, grantee));
create table ops.expected_index_exemptions (indexname text primary key, reason text not null);
-- CI: (actual EXCEPT expected) UNION ALL (expected EXCEPT actual) must be empty, both directions.
```

`ops.expected_index_exemptions` is what makes the strengthened V6 usable: `tenant_channels`'s `unique (provider, external_id)` is *required* not to lead with `tenant_id`, and every `id` primary key is identity rather than an access path. Each exemption carries a written `reason`.

---

## 2.9 PII: what is stored, for how long, and how it leaves

### What is PII here

| Table.column | Content | Sensitivity |
|---|---|---|
| `messages.body` | The customer's own words to a salon | **High.** The bulk of the risk. |
| `contacts.display_name`, `contacts.external_id` | Facebook display name; PSID/IGSID | Medium |
| `contacts.phone_e164`, `outbound_messages.to_phone_e164` | Real phone numbers, once SMS exists | **High** |
| `webhook_events.raw_payload` | Everything above, unredacted | **High** |
| `audit_log.before/after_snapshot` | May contain KB text; never a token (constrained) | Medium |
| `quality_reviews.rationale` | AI commentary that may quote a customer | Medium |
| `spend_ledger`, `usage_counters`, `analytics_reports` | **Counts and money only — no content, by construction** | Low |

The ledger and counters carrying no content is what makes long financial retention safe. It is a schema property, not a promise.

### Retention

| Data | Default | Configurable | Mechanism |
|---|---|---|---|
| `webhook_events.raw_payload`, routed | **7 days** | `tenants.retention_days_raw_events`, 1–30 | `NULL` it, set `raw_purged_at`. The row survives for idempotency. |
| `webhook_events.raw_payload`, **unrouted** (`tenant_id is null`) | **48 hours, not configurable** | no | There is no tenant to configure it, and this is PII for a business Dalatech has no relationship with. |
| `webhook_events` row | 30 days | no | Delete. |
| `messages.body` | **90 days** | `tenants.retention_days_messages`, 30–730 | `NULL` it, set `body_redacted_at`. |
| `messages` row | 730 days | no | Delete. |
| `contacts` | 12 months after `last_seen_at`, no live conversation | no | Delete (cascades). |
| `outbound_messages.to_phone_e164` | 90 days after `sent_at` | no | Replace with `sha256(phone ‖ per-tenant salt)`. |
| `spend_ledger`, `usage_counters` | 7 years | no | Retain. No content. Never deleted (append-only). |
| `analytics_reports` | indefinite | no | Aggregates only. |
| `audit_log` | 2 years | no | **DROP PARTITION**, not `DELETE` (§2.4-F). |

Redaction-before-deletion is deliberate: nulling `body` destroys the PII while preserving referential integrity, message counts, and the ledger linkage Analytics and any billing dispute depend on. A hard row delete would silently change historical report figures.

### The purge job

One nightly job, `ops.purge_expired(p_max_rows int default 50000)`. Three non-negotiable properties: **it touches no upstream provider** (no Anthropic, no Meta — rule #6's ceiling here is rows, not dollars); **it is bounded per run and alerts when it hits the ceiling**, because a purge silently falling behind is how retention promises become false; and **it reports what it deleted** into `audit_log` with counts per table.

### Per-person erasure

`contact_erasure_requests` accepts `meta_callback` (Facebook apps must expose a Data Deletion Request callback — **ASSUMED**), `tenant_request`, and `customer_direct`. Fulfilment deletes the `contacts` row, cascading through `conversations` → `messages` → `booking_handoffs` → `outbound_messages`. `webhook_events` rows are *not* cascaded — they carry no FK to `contacts` — so the purge additionally nulls any `raw_payload` whose `dedup_key` belongs to that contact's messages. That asymmetry is why `raw_payload`'s default retention is only 7 days.

### Tenant offboarding — export, then prove deletion

**A `tenants` row is purged in place, never deleted.** That is what resolves the append-only collision of §2.2 and preserves the 7-year financial record the retention table promises.

1. **Export** — `ops.export_tenant(tenant_id)` writes JSONL per table plus a manifest with a SHA-256 per file. Run by the founder with an explicit confirmation token; writes `audit_log`. **Secrets are never exported.**
2. **Grace** — a `tenant_offboardings` row with `scheduled_purge_at = now() + 30 days`, `tenants.status = 'offboarding'`, all sends stopped, inbound events still recorded.
3. **Purge** — delete PII in dependency order (`contacts` → cascade; `webhook_events`; `outbound_messages`; `knowledge_*`; `tenant_secrets`), then set `tenants.status = 'purged'`, `purged_at = now()`, and null every column except `id`, `slug`, `display_name`. `spend_ledger`, `usage_counters`, `analytics_reports` and `audit_log` survive; they carry no content.
4. **Prove it** — `select count(*)` **per PII table, independently**, including `webhook_events`. Not by the job reporting success. Row counts and the export checksum go into the tombstone.

That last point is the same discipline as the KEK rotation check and as §2.11: **confirm by querying the database, never by the job's own claim.**

---

## 2.10 Mongolian Cyrillic: collation, indexing, search

### Collation — assert it, because it cannot be changed later

VERIFIED (research):

| Test | Result |
|---|---|
| `lower('ҮС ЗАСАЛТ')` under `C.UTF-8` / `en_US.UTF-8` | `үс засалт` ✓ |
| `'Үс Засалт' ILIKE '%засалт%'` | `true` ✓ |
| `lower('ҮС ЗАСАЛТ' collate "C")` | **`ҮС ЗАСАЛТ`** — unchanged ✗ |
| `('Үс' collate "C") ILIKE ('%үс%' collate "C")` | **`false`** ✗ |

Plain `C`/`POSIX` silently breaks Cyrillic case folding; `en_US.UTF-8` (Supabase's default) handles it. Since `datcollate` **cannot be changed after database creation**, this is V0.

### `unaccent` is banned

VERIFIED (research): `unaccent` maps **`Ё → Е` and `ё → е`** while `Й`, `Ө`, `Ү` pass through untouched. `Ё` is a full letter of the Mongolian alphabet (ёстой, Ёндон, ёс), not a decoration. The *mixture* is what makes it dangerous — harmless in nine tests out of ten, then silently conflating a small set of words. **Do not create the extension.** V0 asserts its absence.

### The folding function you own instead

The real Mongolian confusions are keyboard-layout errors, not diacritics: `ө`↔`о`, `ү`↔`у`, `й`↔`и`, `ё`↔`е`. VERIFIED (research): `similarity('үс засалт','ус засалт') = 0.538`, but `similarity('өнгө','онго') = 0` — trigram similarity collapses when *every* character differs.

```sql
create or replace function app.mn_search_fold(t text)
returns text language sql immutable parallel safe as $$
  select translate(lower(normalize(coalesce(t,''), NFC)), 'өүйёӨҮЙЁ', 'оуиеоуие');
$$;
```

`immutable` is required for the generated columns. The mapping is pinned **in the migration**, so changing it is a migration plus a reindex — a real, visible cost, which is correct. Applied to search columns only, **never** to stored canonical text.

### Search strategy per surface

| Surface | Method |
|---|---|
| KB retrieval for the model | pgvector embeddings via `app.search_kb()` + trigram on `body_fold` as a lexical backstop |
| Service-name lookup | `service_aliases.alias_key` exact match, then `pg_trgm` on `service_items.search_key` |
| Dashboard free-text | `to_tsvector('simple', app.mn_search_fold(…))`, config named **explicitly at every call site** |
| Staff/service ordering | `order by … collate "mn-MN-x-icu"` (**ASSUMED**; fall back to `und-x-icu`) |

Never rely on `default_text_search_config` — a generated `tsvector` depending on a session GUC is a bug waiting for a config change. VERIFIED (research): `english` and `simple` produce identical output on pure Mongolian but **diverge on mixed text**, which is what a salon actually receives. `simple` has no Mongolian stop-word list, so particles (`нь`, `ба`, `юм`, `вэ`, `бол`) index as content — a month-two tuning task from your own corpus.

### What breaks under an ASCII assumption

VERIFIED (research): **Postgres regexes are locale-aware; JavaScript regexes are not.**

| Expression | Postgres | JavaScript |
|---|---|---|
| `\w` on `'үс засалт'` | **true** | **false** |
| word boundary on `засалт` | `\yзасалт\y` → **true** | `/\bзасалт\b/` → **false** |
| same, with the `u` flag | n/a | **still false** |
| `\p{L}+` with `u` | n/a | **true** |

A validation regex ported from SQL to Node, or written by someone who tested it in `psql`, **changes meaning**. `u` does not fix `\b`: in JavaScript `\b` is defined in terms of `\w`, and `\w` is permanently `[A-Za-z0-9_]`. Write `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with `u`, or do not use word boundaries.

The ancestor demonstrates both halves failing in production. VERIFIED (research, by running the real modules):

- `lib/salonIntents.js:26` — `/^(сайн|байна|уу|hi|hello|hey)/i` is unanchored at the right edge, so `detectShortcutIntent('Уучлаарай асуумаар байна', {hasHistory:false})` returns `'greeting'`. **`Уучлаарай`** ("excuse me") is one of the commonest openers in Mongolian customer service.
- `lib/salonIntents.js:21` matches `хаяг` anywhere, so `'Facebook хаяг байна уу'` returns `'location'` — the customer asked for the Facebook page and gets a Google Maps card. The email special-case at `:25` is a hand-patched symptom.
- Because nothing normalises, `'Байна уу'.normalize('NFD')` returns `null` where the NFC form returns `'greeting'`.
- `lib/validator.js:201` — `/^[^аеёиоуыэюя\s]{20,}$/i`, commented "without Mongolian vowels", uses the **Russian** vowel set and omits **ө** and **ү**.

**The rules this produces, for `CLAUDE.md` on day one:**

1. NFC-normalise at every input boundary and nowhere else. `check (col is normalized)` on the columns that matter — `Й`/`й`/`Ё`/`ё` have canonical decompositions, `Ө`/`Ү` do not, so two visually identical KB entries can otherwise never match.
2. No `\b`, `\w`, or `[a-z]` in any JavaScript regex over user text. `\p{L}`/`\p{N}` with `u`, or nothing. CI grep.
3. No unanchored regex over user text where the consequence is a wrong intent or a prompt injection. The sibling audit is blunt that `sanitizeForPrompt` is "a fixed-phrase regex strip … trivially bypassed … not a security control" (`security-audit-2026-08-23.md:228-231`).
4. Length budgets in **characters** (`Array.from(s).length` for emoji safety), byte budgets with `Buffer.byteLength`. Never interchange them.
5. ASCII classes are permitted **only** for machine identifiers (slug, currency code, E.164 phone, the `EAA…` token guard). Say which you are writing, every time.

---

## 2.11 Migrations and the verification protocol

### Recommendation: Supabase CLI, with a real ledger, from migration `0001`. Never the dashboard SQL editor.

`supabase_migrations.schema_migrations` on the sibling project contains **exactly one row** while six migration files exist and the effects of at least two are live in the catalog (`security-audit-2026-08-23.md:309-317`). From `:324-328`:

> The ledger is not merely incomplete — it is *actively misleading*, because it is empty in the same way whether a migration was applied or not.

That gap hid an unapplied HIGH fix in production for weeks.

```
supabase/migrations/0001_bootstrap_grants.sql
                    0002_tenancy.sql …
supabase/verify/V0..V15.sql
supabase/tests/rls/*.sql
```

Local `supabase db reset` applies every migration from scratch, which alone catches the "provisioned from `schema.sql` reproduces the original vulnerabilities" class. CI on every PR resets a shadow database, applies all migrations, runs V0–V15 against the `ops.expected_*` tables, runs the negative tests, and fails on any asymmetric diff. Deploy runs the pack against staging and production and diffs the **fingerprints** (V12). Every migration PR carries the pack's output.

**What it costs, said plainly:** you may never touch the dashboard SQL editor again (one paste diverges the ledger permanently; if an emergency forces one, the runbook is paste → write the equivalent migration file → `supabase migration repair --status applied <version>` → re-run V0–V15 → record it in the PR); CI needs a dedicated named secret key it can revoke independently; `supabase db diff` is noisy against Supabase-managed schemas, so write migrations by hand and use `diff` only to check; branch databases cost money (**ASSUMED** — a CI shadow DB is the cheap substitute); and no hot-fixing at 2 a.m., which is the point and also the thing that will be violated first.

**The caveat that survives all of it: even with the CLI, the ledger is a *claim*.** The catalog is the only source of truth.

### Two sources banned in this codebase

**`information_schema.role_table_grants`** shows only rows where the current role is grantor, grantee, or a member of the grantee role, and **reports the absence as an empty result rather than an error**. VERIFIED (research), same database, same instant:

| Querying role | `role_table_grants` rows for `public` | rows naming `anon`/`authenticated` | `aclexplode` rows |
|---|---|---|---|
| `postgres` (superuser, grantor) | 67 | many | 72 |
| `auditor` (plain login role) | 5 | **0** | 72 |

**`supabase_migrations.schema_migrations`** — above.

### The pack

```sql
-- V0 — environment invariants that cannot be fixed later
select datname, datcollate, datctype, pg_encoding_to_char(encoding) from pg_database
where datname = current_database();          -- UTF8; datcollate NOT 'C'/'POSIX'
select extname, extversion from pg_extension order by 1;
-- REQUIRED: pgcrypto, pg_trgm, btree_gist, vector.  FORBIDDEN: unaccent.
-- Also record vector's version: hnsw.iterative_scan needs >= 0.8.0.
select collname from pg_collation where collname in ('mn-MN-x-icu','und-x-icu');

-- V1 — RLS state, per table
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p') order by 1;

-- V2 — RLS state vs ops.expected_rls. Symmetric diff MUST be empty.
with actual as (
  select c.relname, c.relrowsecurity as rls,
         (select count(*) from pg_policy p where p.polrelid=c.oid)::int as policies
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p'))
select 'unexpected' src, a.relname, a.rls::text, a.policies::text from actual a
  left join ops.expected_rls e on e.relname=a.relname
  where e.relname is null or e.rls <> a.rls or a.policies < e.min_policies
union all
select 'missing', e.relname, e.rls::text, e.min_policies::text from ops.expected_rls e
  left join actual a on a.relname=e.relname where a.relname is null;

-- V2b — POLICIES THAT ARE NOT ENFORCED. Must return zero rows, always.  [VERIFIED (SQL)]
select n.nspname, c.relname, p.polname
from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
where not c.relrowsecurity;

-- V3 — the TRUE table ACL, with both null-traps closed
select c.relname,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind in ('r','p')
group by 1,2 order by 1,2;

-- V5 — table ACL vs ops.expected_acl (symmetric diff), restricted to client roles + PUBLIC.
--      Replaces the draft's `having <> 'SELECT'`, which flagged ten legitimate tables forever.
--      Hard assertion on top: 'anon' and 'PUBLIC' must appear in ZERO rows of V3.

-- V6 — every index on a tenant-scoped table leads with tenant_id, or is exempted.  [VERIFIED (SQL)]
select i.indrelid::regclass as tbl, i.indexrelid::regclass as idx
from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and exists (select 1 from pg_attribute a where a.attrelid=i.indrelid
                and a.attname='tenant_id' and not a.attisdropped)
  and i.indkey[0] <> (select attnum from pg_attribute
                      where attrelid=i.indrelid and attname='tenant_id')
  and i.indexrelid::regclass::text not in (select indexname from ops.expected_index_exemptions)
order by 1,2;
-- This is the query that would have caught the unscoped HNSW index.

-- V7 — permissive client policies not tenant-scoped, and write policies missing WITH CHECK
select p.tablename, p.policyname, p.cmd, p.roles, p.qual, p.with_check
from pg_policies p
where p.schemaname='public' and p.permissive='PERMISSIVE'
  and p.roles && array['anon','authenticated','public']::name[]
  and ( coalesce(p.qual,'') !~ 'tenant_id|is_platform_admin'
        or coalesce(p.qual,'') in ('true','(true)')
        or (p.cmd in ('UPDATE','ALL','INSERT') and coalesce(p.with_check,'') !~ 'tenant_id') )
order by 1,2;

-- V7b — at most ONE permissive SELECT policy naming is_platform_admin per table.
select tablename, count(*) from pg_policies
where schemaname='public' and permissive='PERMISSIVE' and cmd in ('SELECT','ALL')
  and coalesce(qual,'') ~ 'is_platform_admin'
group by 1 having count(*) > 1;

-- V8 — who bypasses RLS. An unexpected role here means STOP.
select rolname, rolbypassrls, rolsuper from pg_roles where rolbypassrls or rolsuper order by 1;

-- V9 — full policy bodies, read every one
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname='public' order by 1,2;

-- V10 — SECURITY DEFINER functions and their search_path
select n.nspname, p.proname, p.prosecdef,
       coalesce(array_to_string(p.proconfig,','),'(none)') as config,
       pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','app','ops') order by p.prosecdef desc, 1, 2;
-- EVERY prosecdef=true row MUST show search_path=''. No exceptions.

-- V11 — function ACLs, ALL THREE schemas (the draft read 'app' only)
select n.nspname, p.proname,
       case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where n.nspname in ('public','app','ops') order by 1,2,3;

-- V13 — the three ACL surfaces relacl cannot see.  [all three VERIFIED (SQL)]
select 'schema' k, nspname o, nspacl::text a from pg_namespace where nspname in ('public','app','ops')
union all
select 'column', a.attrelid::regclass::text||'.'||a.attname, a.attacl::text
  from pg_attribute a join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and a.attacl is not null;
-- (functions are V11). Column rows are diffed against ops.expected_column_acl.

-- V14 — append-only integrity.  [VERIFIED (SQL)]
-- (a) FKs on an append-only table with a cascading/nulling delete action. MUST be zero rows.
select conrelid::regclass as append_only_table, conname, confdeltype
from pg_constraint
where contype='f' and confdeltype in ('c','n','d')
  and conrelid in (select tgrelid from pg_trigger
                   where tgname like '%append_only%' and not tgisinternal);
-- (b) every append-only table also carries a statement-level BEFORE TRUNCATE trigger
-- (c) no role other than the owner holds TRUNCATE on an append-only table (from V3)

-- V15 — spine coverage: FKs between two tenant-scoped tables that omit tenant_id.  [VERIFIED (SQL)]
select c.conrelid::regclass as child, c.confrelid::regclass as parent, c.conname
from pg_constraint c
where c.contype='f' and c.connamespace='public'::regnamespace
  and exists (select 1 from pg_attribute a where a.attrelid=c.conrelid
                and a.attname='tenant_id' and not a.attisdropped)
  and exists (select 1 from pg_attribute a where a.attrelid=c.confrelid
                and a.attname='tenant_id' and not a.attisdropped)
  and not ((select attnum from pg_attribute where attrelid=c.conrelid and attname='tenant_id')
           = any(c.conkey));

-- V12 — CATALOG FINGERPRINT. Now covers what actually binds service_role.
select md5(string_agg(line, E'\n' order by line)) as catalog_fingerprint from (
  select 'T|'||c.relname||'|'||c.relrowsecurity::text||'|'||c.relforcerowsecurity::text as line
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
  union all
  select 'P|'||p.tablename||'|'||p.policyname||'|'||p.permissive||'|'||p.cmd||'|'||
         array_to_string(p.roles,',')||'|'||coalesce(p.qual,'')||'|'||coalesce(p.with_check,'')
    from pg_policies p where p.schemaname='public'
  union all
  select 'A|'||c.relname||'|'||(case when a.grantee=0 then 'PUBLIC'
                                     else pg_get_userbyid(a.grantee) end)||'|'||a.privilege_type
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname='public' and c.relkind in ('r','p')
  union all
  select 'K|'||a.attrelid::regclass::text||'|'||a.attname||'|'||a.attacl::text
    from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and a.attacl is not null
  union all
  select 'S|'||nspname||'|'||coalesce(nspacl::text,'') from pg_namespace
    where nspname in ('public','app','ops')
  union all
  select 'C|'||conrelid::regclass::text||'|'||conname||'|'||pg_get_constraintdef(oid)
    from pg_constraint where connamespace='public'::regnamespace
      and contype in ('p','u','f','c','x')
  union all
  select 'G|'||tgrelid::regclass::text||'|'||tgname||'|'||pg_get_triggerdef(oid)
    from pg_trigger where not tgisinternal and tgrelid in (
      select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public')
  union all
  select 'I|'||indexrelid::regclass::text||'|'||pg_get_indexdef(indexrelid)
    from pg_index where indrelid in (
      select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public')
  union all
  select 'F|'||n.nspname||'.'||p.proname||'|'||p.prosecdef::text||'|'||
         coalesce(array_to_string(p.proconfig,','),'')||'|'||md5(p.prosrc)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app','ops')
) s;
```

**V12 is the answer to "applied to staging but not production."** One string. Run it in both environments after every deploy; if the digests differ and the migration set is identical, something was applied in one place and not the other. Store each deploy's fingerprint in the release notes.

Two traps V3 closes that a naive version does not, both **VERIFIED (research and SQL)**: `relacl IS NULL` yields zero `aclexplode` rows for a table never explicitly `GRANT`ed, so `coalesce(relacl, acldefault('r', relowner))` is mandatory; and `PUBLIC` is grantee OID 0, where **VERIFIED (SQL)** `pg_get_userbyid(0)` returns the string `'unknown (OID=0)'` rather than erroring, so a `PUBLIC` grant would appear under a nonsense name and be skimmed past.

### Negative tests — the catalog proves configuration, not enforcement

`supabase/tests/rls/` runs against the shadow DB with two seeded tenants and three identities (owner A, owner B, founder). **The loop iterates table names read from `pg_class`, not a hand-written list** — that is what makes it immune to the sibling's partial-application failure. For **every** table, independently:

1. As owner B, `select` tenant A's rows → **0 rows**.
2. As owner B, `insert`/`update`/`delete` a row carrying tenant A's id → **error**, not `0 rows affected`.
3. As owner B, `update … set tenant_id = <tenant A>` on their own row → **error** (the `WITH CHECK` test).
4. As owner B, any write on every server-owned table → **error**.
5. As owner B, `truncate` every table → **permission denied**.
6. As owner B, `select` from `tenant_secrets` → **permission denied** (not "0 rows" — the privilege is absent).
7. As owner B, `insert into canned_responses(…, reviewed_by)` → **permission denied** (the column-grant test).
8. As the founder, `select` from both tenants → rows from both; any write → **error**; `select messages.body` with `can_read_message_bodies = false` → **0 rows**.
9. `insert` a `messages` row whose `tenant_id` disagrees with its `conversation_id`'s tenant → **FK violation**.
10. `insert` a `messages` row whose `ledger_id` belongs to another tenant → **FK violation**.
11. `insert` a `kb_change_proposals` row whose target belongs to another tenant → **FK violation**.
12. `update`/`delete`/`truncate` `spend_ledger` and `audit_log` → **exception**.
13. `delete from conversations` where a ledger row references it → **succeeds** (the §2.2 regression test).

**Tests 9–13 run as `service_role`.** That is the whole point: they are the only tests that prove anything about the path where all the money is spent. Test 13 exists because the draft's schema made it fail.

**Why "0 rows affected" is not success.** **VERIFIED (SQL)**: without a permissive write policy, `UPDATE`/`DELETE` return `UPDATE 0` / `DELETE 0` — silently, no error, row intact. Tests assert on the **error**, never on the row count.

---

## 2.12 Failure modes, consolidated

| Failure | Symptom | Correct behaviour |
|---|---|---|
| **Migration applied to staging, not production** | Everything looks fine; a policy, constraint or trigger silently absent in prod | V12 fingerprints differ; deploy gate fails. Never trust the ledger. |
| **New table shipped without RLS** | Any role with a grant reads everything | Catalog-driven enable loop + V2 symmetric diff + V2b. Plus `alter default privileges` means a new table has *no* client grant, so the window is closed twice. |
| **Policy written on a table whose RLS is off** | V7 and V9 read perfect; cross-tenant read and write both succeed | V2b. Must return zero rows, always. |
| **Policy spot-checked on one table, another missed** | The `20260817` failure | Every V-query enumerates every table; negative tests loop over `pg_class`, not a hand-written list. |
| **`revoke insert, update, delete` mistaken for "cannot write"** | `TRUNCATE` empties a table under a restrictive policy | V5 diffs against expected state and flags `Dxtm`; PG17's `MAINTAIN` is caught without an edit. |
| **Privilege hiding in a surface `relacl` cannot see** | V3 reports `SELECT`; the role holds column INSERT, or `PUBLIC` holds schema USAGE / function EXECUTE | V11 + V13. |
| **Service-role route with a tenant-scoping bug** | Cross-tenant read/write; RLS not evaluated | Composite FKs (V15) refuse mismatched writes; append-only triggers refuse ledger rewrites; tests 9–13 prove it as `service_role`. No policy helps. |
| **Retrieval query missing `.eq('tenant_id')`** | Another tenant's prices spoken to a stranger, unrecallable | `app.search_kb()` is the only interface; CI grep bans direct table access; V6 flags any non-leading index. |
| **Filtered ANN returns too few rows** | Bot says "I have no information" about a service in the KB, HTTP 200 | `hnsw.iterative_scan` inside `app.search_kb`; alert when the function returns fewer than `k` while chunks exist. |
| **Tenant misidentified from a webhook** | Reply posted as the wrong salon | `unique (provider, external_id)`; unknown → `200` + drop + alert, never auto-create. Never `/me/messages`. Never `?? DEFAULT_TENANT`. |
| **Tenant named in a request body or a queue body** | Any signed-in user or any signed publish acts as any tenant | Only `tenantFromWebhook` / `tenantFromSession` mint a tenant; the queue body carries `webhook_event_id` only. CI grep. |
| **Event delivered twice** | Duplicate reply, duplicate spend | `unique (provider, dedup_key)` checked **before** the Anthropic call. Cross-tenant collision alerts rather than drops. |
| **Ledger row written against the wrong tenant** | Tenant B's ceiling consumed by tenant A's traffic; B goes quiet on a Saturday | `unique (tenant_id, id)` + composite ledger FKs + the validating insert trigger; test 10. |
| **One tenant floods the shared Meta app budget** | A quiet tenant's replies start failing with `613` | `platform_counters` with a ceiling below Meta's, plus a per-tenant slice cap. Meta will not fair-share for you. |
| **Config missing for a tenant** | Bot answers from an empty knowledge base | `tenants.status = 'provisioning'` blocks sends; zero published documents is a hard refusal, not an empty prompt. Precedent: `lib/systemPromptBuilder.js:36-38` returns "no pricing information available" for an unrecognised price-list shape *rather than attempting to render*. |
| **Page token expired** | Reception AI goes silent for one tenant; **nothing throws** | `tenant_channels.status='authorization_error'` on Graph `190`; stop sends; alert. `channel_health.last_webhook_at` watchdog for a silent unsubscription. |
| **Budget spent** | — | `spend_budgets.on_exhausted` decides; the reply path refuses **before** the upstream call. Quota helpers return 503 on any error; never `try/catch { continue }`. |
| **Redis / limiter unreachable** | — | Fail closed on cost-bearing paths. The webhook **ACK** may fail open (a non-200 risks Meta disabling the subscription); the Graph call and the Anthropic call must not. |
| **Purge falls behind** | Retention promise quietly false | Row ceiling per run + alert on hitting it + counts in `audit_log`. |
| **Retention deletion blocked by an append-only trigger** | The purge job fails nightly, or offboarding is impossible | V14(a); `audit_log` retires by DROP PARTITION; `tenants` is purged in place, not deleted. |
| **KEK rotated, some rows missed** | Half the tenants undecryptable | `select count(*) from tenant_secrets where kek_version <> 2` must return 0 — **by querying**, not by the job reporting success. |
| **Two tenants in one warm lambda** | Tenant B answered with tenant A's prices | Prompt, history key, dedup key, rate-limit key, budget counter and log line must all carry `tenant_id`. Testable offline with a fake clock and two fake tenants — the test the ancestor could never write, because `lib/salonBrain.js:142` cached the prompt in a module-scope singleton. |

---

## 2.13 Where a critique was wrong or overstated

Recorded so the founder sees the objection and the answer, rather than an unexplained omission.

1. **"`revoke usage on schema public from anon` names a role that never held it."** True on a vanilla cluster (VERIFIED (SQL): `PUBLIC` holds `=U`), **false on Supabase**, whose bootstrap grants USAGE to `anon` directly. The line is necessary *and* insufficient; both revokes ship, and V13 is what proves the result. The critique's conclusion is right; its reason would mislead anyone reading only the diff.
2. **"Hash-partitioning `knowledge_chunks` makes the ANN post-filtering problem disappear."** Overstated. Hash partitioning puts many tenants in each partition, so filtered ANN still post-filters within a partition — it reduces the competing set, it does not remove it. LIST-partition-per-tenant would remove it and is rejected because it makes onboarding a DDL operation. The correctness fix is `hnsw.iterative_scan` inside `app.search_kb()`; partitioning stays a scale lever.
3. **"`revoke truncate … from service_role` fixes the append-only hole."** Necessary but not sufficient on its own: the table owner is not bound by a grant. The statement-level `BEFORE TRUNCATE` trigger is the stronger control (VERIFIED (SQL)) and both ship.
4. **"Change `spend_ledger.tenant_id` to `on delete no action`."** Correct in direction, incomplete: it does not address the `conversations` composite FK, whose `ON DELETE SET NULL` fires the append-only `BEFORE UPDATE` trigger and blocks the *retention* purge, not just offboarding (my own finding, VERIFIED (SQL)). The general rule in §2.2 covers both.
5. **A blanket "enable RLS on every table in `public`" loop, unaccompanied.** Correct and adopted, but on its own it silently blinds reference tables: VERIFIED (SQL) that RLS-on-with-no-policy returns zero rows to `authenticated` with no error. It must ship with `ops.expected_rls` and a paired read policy per reference table.

---

## 2.14 Assumptions restated — verify before these become code

1. **`pg_jsonschema`** available on Supabase for validating `tenants.settings` in a check constraint. If not, validate application-side and drop the constraint.
2. **`pgvector`** available; `vector(1536)` + HNSW is right; and the project's version is **≥ 0.8.0**, which `hnsw.iterative_scan` requires. Confirm all three from V0's output on the real project.
3. **ICU collation `mn-MN-x-icu`** exists. Fall back to `und-x-icu`; assert in V0.
4. **Supabase branch database pricing** versus a CI shadow DB.
5. **Meta's Data Deletion Request callback** is required for app review and must be wired to `contact_erasure_requests`.
6. **PG17 specifics** — the `MAINTAIN` privilege in the ACL, and that `UNIQUE NULLS NOT DISTINCT` and `IS NORMALIZED` behave as on the PG16 verification cluster. Both are PG15+/PG13+ features, so this is a formality, but V0 records the server version.
7. Everything the Meta research marked SINGLE-SOURCE or UNVERIFIED — in particular **what `entry[].id` is under each Instagram auth flavour**, on which `tenant_channels`'s entire routing model depends. Settle it from primary docs before the first webhook is written.

Everything else is **VERIFIED (file)** with a citation, **VERIFIED (SQL)** this session with the output quoted, or **VERIFIED (research)** and re-runnable in an afternoon.

---

## 2.15 Open questions — the founder's call, not mine

1. **Does a tenant owner get a login at all in v1?** Every policy in §2.7, `tenant_members`, `app.current_tenant_ids()` and half the verification pack exist to serve a dashboard. If Matrix and GS Auto get a monthly PDF instead, RLS-for-humans is dead weight in v1 and the entire security budget should go to §2.7.4 — the service-role path, where all the volume and all the spend actually are. **This is the single highest-leverage decision in this document.**

2. **What is a tenant's monthly dollar ceiling, and what happens when it is hit?** `spend_budgets.on_exhausted` offers `hard_stop` (Messenger goes silent mid-conversation, on a Saturday), `canned_reply` (a Mongolian "we'll get back to you", which costs nothing and is probably right), or `overage_bill` (which needs a billing relationship that does not exist). The fail-closed machinery cannot be finished without the number **and** the behaviour.

3. **Vault or envelope encryption for page tokens?** I recommend envelope on blast-radius grounds and the argument is not close for a public repo — but it is ~120 lines you own and must test, versus one Supabase function call. If you would rather ship and revisit, **say so explicitly in the commit**, the way `BANK_BUILD_BUDGET_USD = 0` records a decision rather than an accident. Migrating Vault → envelope later is a plaintext-touching operation.

4. **Is the founder's Quality-layer identity `service_role` or the scoped admin role?** Reviewing every tenant's conversations is inherently cross-tenant, so `service_role` is tempting — and doing so removes the last place RLS could catch a scoping bug in your own tooling. I recommend the scoped role with `can_read_message_bodies = false` by default; it costs two policies and one restrictive gate.

5. **Is `refusal_rules` self-serve or founder-approved?** "Never quote a price for X; say this instead" is the most valuable and most dangerous knob in the product. A tenant who sets it carelessly ships a bot that refuses to sell. The schema supports either; the class it sits in (§2.5) is your call.

6. **Do Matrix's pinned Mongolian sentences get re-reviewed on migration?** `CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY`, `BOOKING_LINE` were native-speaker reviewed **for that prompt, in that context** — `lib/salonBrain.js:54-56` records that the handoff apology is *"the other spot where the model improvises (and garbles) Mongolian"*. Moving them into `canned_responses` and changing the surrounding prompt changes the conditions they were validated under. `reviewed_by` will be `NULL` until someone re-reads them, and I would treat `NULL` as blocking go-live for that tenant.

7. **Retention: 90 days for message bodies — is that the promise you want to make?** Long enough for the Quality layer to find patterns, short enough to limit a breach. But it is a contractual statement to a salon about its customers' conversations, it appears in a privacy policy, and shortening it later destroys data the Quality layer was using. The ancestor's `PRIVACY_POLICY.md` already publishes a retention table describing a **different, localStorage-only architecture**; it is wrong the moment Dala AI stores a message server-side, and rewriting it is on the critical path.

8. **New, promoted from the critiques: does the Quality layer's cross-tenant review batch get to see two tenants at once?** The typed-target FKs (§2.4-F) stop a cross-tenant *proposal* reaching the database, but they do not stop tenant A's conversation text sitting in the same model context as tenant B's while the review runs. That is a per-tenant review pass (more calls, more cost, cleanly isolated) versus a batched pass (cheaper, and one prompt-construction bug leaks a salon's customer chat into another salon's review). It is a spend-versus-isolation trade at the product level, and it is yours.