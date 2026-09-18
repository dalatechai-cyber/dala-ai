-- The website channel's identity spine (docs/website-channel.md, D-086).
--
-- ## The question this answers, and why 0001 refused to answer it
--
-- `0001` seeded the `web` provider row DISABLED, with this note:
--
--     'Undesigned in v1. The one surface where the tenant-identity rule has no answer.'
--
-- That was right, and it is worth being precise about WHY, because the obvious
-- constructions all look fine until you name what rule 1 is actually made of.
--
-- Rule 1 says the tenant is derived server-side from a registry with a unique key, never
-- from a request body, a header or an env var. What makes the Meta path legal under it is
-- NOT that the Page id arrives in the URL rather than the body — it arrives in the BODY,
-- at `entry[].id`. It is that `route.ts` reads the raw bytes at step 1 and runs
-- `verifyMetaSignature` at step 2, BEFORE `JSON.parse` at step 3, against a secret only
-- Meta holds; and `signature.ts` returns `matchedAppSlug`, the slug whose secret actually
-- verified. The rule's operative content is **derive the tenant from an ATTESTED signal**.
--
-- A browser holds no secret by construction. Every field of a widget request — a site key,
-- the Origin header, the Host, a path segment, a cookie — is chosen by the caller and
-- attested by nothing. `Matrix-Chatbot/lib/cors.js` says the same thing in its first ten
-- lines about the one control people reach for: *"CORS is a browser control... It is NOT
-- an authorization gate and must never be relied on as one."* So a public site key is
-- IDENTIFICATION DRESSED AS DERIVATION: anyone who reads the page source can mint as that
-- tenant and spend that tenant's budget, which is rule 2's stated harm — another tenant's
-- money — reached through rule 1's hole.
--
-- ## The construction chosen (founder, 2026-09-18)
--
-- **The tenant's own server mints.** It signs a session-mint request with a per-tenant
-- secret; the platform derives the tenant from WHICH secret verified, exactly as
-- `verifyMetaSignature` does. The browser never names a tenant — it receives an opaque
-- token that the platform itself issued, and every later message derives the tenant by
-- looking that token up here. That is a registry with a unique key, server-side, attested.
--
-- Note what this makes of `tenant_channels.live_requires_active_token`: a website channel's
-- "token" IS the mint secret, so the existing constraint is already correct for this
-- surface rather than an obstacle to work around. No constraint is loosened here.
--
-- The cost is stated rather than discovered: a client with no server of their own — a
-- salon on Wix — cannot do this, and the answer for them is a Dala-hosted chat page, which
-- is a separate build and is NOT this migration.
--
-- ## Checklist for a table added after 0001 (see 0030 for the full reasoning)
--
--   1. `enable row level security`                       — V2
--   2. `force row level security`                        — V3
--   3. THREE per-command restrictive deny-write policies. Never a single `for all` — V17
--   4. a row in `ops.tenant_scope`                       — V7, V8
--   5. a row in `ops.table_security_class`
--   6. `grant all … to service_role` — 0001:1636 is a ONE-TIME bulk grant, so a later
--      table is absent from PostgREST's schema cache and every `.from()` 404s. V35 and
--      `scripts/verify/postgrest.ts` are what catch it.
--
-- Both tables below take all six.

-- ---------------------------------------------------------------------------------------
-- web_sessions — the registry rule 1 demands
-- ---------------------------------------------------------------------------------------

create table web_sessions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  channel_id     uuid not null,

  -- The SHA-256 of the token, never the token. A read of this table must not yield a
  -- usable session: the same reasoning that stops a password column existing. The unique
  -- index on it is the "registry with a unique key" rule 1 asks for — one live token
  -- routes to exactly one tenant, across all tenants, which is what
  -- `channel_identity_live_key` does for Pages.
  token_sha256   bytea not null,

  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  last_seen_at   timestamptz,

  -- A per-SESSION bound on turns, so one visitor cannot consume the tenant's day.
  -- The spend ceiling is per tenant per surface per DAY (`effectiveDailyCeiling`), and a
  -- website session shares `reception` with the tenant's DM traffic by design — same
  -- staff, same budget. Without a session bound, one anonymous visitor in a loop is
  -- indistinguishable from a busy day and eats the DM allowance. `turn_cap` has no default
  -- for the reason D-020 gives about `provenance`: a caller that cannot say what bound it
  -- wants must be made to answer rather than be quietly given a generous one.
  turns          integer not null default 0,
  turn_cap       integer not null check (turn_cap > 0),

  -- Salted hash, never the address. It exists for the rate limiter and for abuse
  -- forensics, and an IP is PII that `ops.purge_expired` would then have to reason about.
  -- Hashing it means the retention question is answered by deleting the row.
  client_ip_hash bytea,

  revoked_at     timestamptz,

  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade,
  constraint web_sessions_expires_after_issue check (expires_at > issued_at),
  constraint web_sessions_turns_within_cap check (turns <= turn_cap)
);

-- One live token, one tenant. Not partial: an expired or revoked token must still collide,
-- or a re-issue could duplicate a hash and make the lookup ambiguous.
create unique index web_sessions_token_key on web_sessions (token_sha256);

-- The sweep in ops.purge_expired reads this order.
create index web_sessions_expiry on web_sessions (expires_at);

comment on table web_sessions is
  'Opaque browser sessions minted by the platform after a tenant server authenticated the '
  'mint with its own secret. The tenant is derived by looking a token up HERE — never from '
  'anything the browser sent. See docs/website-channel.md and D-086.';

comment on column web_sessions.token_sha256 is
  'SHA-256 of the session token. The token itself is returned once, at mint, and never stored.';

alter table web_sessions enable row level security;
alter table web_sessions force row level security;

create policy web_sessions_no_client_insert on web_sessions
  as restrictive for insert to anon, authenticated with check (false);
create policy web_sessions_no_client_update on web_sessions
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy web_sessions_no_client_delete on web_sessions
  as restrictive for delete to anon, authenticated using (false);

insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'web_sessions', 'tenant_id');

insert into ops.table_security_class (table_schema, table_name, class, note)
values ('public', 'web_sessions', 'server_owned',
        'browser session registry; holds a token hash and a hashed IP, never either in clear');

revoke all on web_sessions from anon, authenticated;
grant all on web_sessions to service_role;

-- ---------------------------------------------------------------------------------------
-- web_rate_counters — the shared counter this platform has never had
-- ---------------------------------------------------------------------------------------
--
-- `dala-ai` has no rate limiter of any kind. Every `rate_limit` match in `src/` is about
-- HANDLING a provider's 429 (`Anthropic.RateLimitError`, Meta error 613), not about
-- imposing one of our own — because until now every inbound request was signed by Meta.
--
-- It must not be in-process. `dalatech-chatbot/lib/rateLimiter.js` is a module-scope
-- `new Map()`, which on Vercel is one counter per warm instance rather than one counter,
-- and its own second line says to use shared storage in production. We have shared storage:
-- this is it.
--
-- Tenant-scoped, because under the chosen construction the mint is authenticated BEFORE a
-- counter is touched, so the tenant is always known — an unscoped counter would be a table
-- outside the tenant spine for no reason. The platform-wide backstop already exists and is
-- a different mechanism: `PLATFORM_HARD_CAP_USD_PER_DAY`.

create table web_rate_counters (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- What is being limited and for whom, e.g. 'mint:<ip_hash>' or 'turn:<session_id>'.
  -- Opaque here on purpose: the shape belongs to the code that writes it, and a CHECK
  -- constraint enumerating bucket kinds would need a migration to add the next one.
  bucket_key   text not null,
  -- The window's START, floored by the caller. A counter whose period can move is a limit
  -- that can be spent twice — D-063's lesson about a ceiling being a number AND a period.
  window_start timestamptz not null,
  count        integer not null default 0 check (count >= 0),
  primary key (tenant_id, bucket_key, window_start)
);

create index web_rate_counters_window on web_rate_counters (window_start);

comment on table web_rate_counters is
  'Shared per-window counters for anonymous website traffic. Postgres rather than memory: '
  'a module-scope Map on Vercel is one counter per warm instance, which is no limit at all.';

alter table web_rate_counters enable row level security;
alter table web_rate_counters force row level security;

create policy web_rate_counters_no_client_insert on web_rate_counters
  as restrictive for insert to anon, authenticated with check (false);
create policy web_rate_counters_no_client_update on web_rate_counters
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy web_rate_counters_no_client_delete on web_rate_counters
  as restrictive for delete to anon, authenticated using (false);

insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'web_rate_counters', 'tenant_id');

insert into ops.table_security_class (table_schema, table_name, class, note)
values ('public', 'web_rate_counters', 'server_owned',
        'rate-limit counters for anonymous traffic; server-written only');

revoke all on web_rate_counters from anon, authenticated;
grant all on web_rate_counters to service_role;

-- ---------------------------------------------------------------------------------------
-- bump_web_rate — increment and read in ONE statement
-- ---------------------------------------------------------------------------------------
--
-- Read-then-write lets two concurrent requests both see `limit - 1` and both proceed, which
-- is a limiter that mostly works, i.e. not a limiter. The upsert's `returning` gives the
-- count AFTER this request, so the caller compares a value nobody else can have changed
-- underneath it.
--
-- It lives in `public` and NOT in `app`. D-029's third bug: every client in
-- `supabase/clients.ts` is built with no `db: { schema }` option, so PostgREST resolves
-- against the `public` profile, and `db.rpc('reserve_spend')` asking for a function that
-- lived in `app` refused every reply for every tenant with `guard_unavailable`. The unit
-- tests stubbed `db.rpc` and answered true, so a green suite said nothing about it.
-- `scripts/verify/postgrest.ts` is what catches this class now; the placement is what stops
-- it arising.

create or replace function public.bump_web_rate(
  p_tenant_id uuid,
  p_bucket_key text,
  p_window_start timestamptz
)
returns integer
language sql
security definer
set search_path = 'public', 'pg_temp'
as $$
  insert into web_rate_counters (tenant_id, bucket_key, window_start, count)
  values (p_tenant_id, p_bucket_key, p_window_start, 1)
  on conflict (tenant_id, bucket_key, window_start)
    do update set count = web_rate_counters.count + 1
  returning count;
$$;

revoke all on function public.bump_web_rate(uuid, text, timestamptz) from public;
grant execute on function public.bump_web_rate(uuid, text, timestamptz) to postgres, service_role;

-- ---------------------------------------------------------------------------------------
-- The purge has to KNOW about them, or they are a leak that looks like a table
-- ---------------------------------------------------------------------------------------
--
-- `ops.purge_expired` enumerates its targets by hand; `ops.tenant_scope` is the tenant
-- spine, not a purge registry, so a row there does NOT make a table swept. D-064's rule is
-- "when you find a column, ask who writes it" — this is the same question asked of a
-- TABLE: a session table nobody sweeps accumulates hashed IPs for ever, and it would read
-- as retained-on-purpose rather than as forgotten.
--
-- Clauses (d) and (e) are ADDITIVE. Neither can touch a row that existed before this
-- migration, because both tables are created by it.

create or replace function ops.purge_expired(p_max_rows int default 50000)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_payloads_purged int := 0;
  v_rows_deleted    int := 0;
  v_bodies_redacted int := 0;
  v_sessions_purged int := 0;
  v_counters_purged int := 0;
  v_ceiling_hit     boolean := false;
  v_result          jsonb;
begin
  if p_max_rows < 1 then
    raise exception 'purge_expired: p_max_rows must be at least 1, got %', p_max_rows;
  end if;

  -- (a) Delete the webhook_events row at 30 days. NOT configurable (§2): below this the
  --     dedup key stops outliving Meta's redelivery window, and the floor is a correctness
  --     property rather than a privacy preference.
  --
  --     THIS RUNS FIRST, and the order is load-bearing for the counts rather than for the
  --     outcome. Nulling first meant a 40-day-old row was counted in `payloads_purged` and
  --     then again in `rows_deleted` — one row, two numbers, and an audit trail that
  --     overstates what a run did. Caught by P5 in `scripts/verify/retention.sql`.
  with due as (
    select id from webhook_events
     where received_at < now() - interval '30 days'
     order by received_at
     limit p_max_rows
  )
  delete from webhook_events e using due where e.id = due.id;
  get diagnostics v_rows_deleted = row_count;

  -- (b) NULL the payload at the tenant's own retention, for everything that survived (a).
  --     An UNROUTED event has tenant_id null — it belongs to nobody, and it is the row most
  --     likely to hold a third party's PII we were never entitled to store. It therefore
  --     gets the FLOOR (1 day), not the default.
  with due as (
    select e.id
      from webhook_events e
      left join tenants t on t.id = e.tenant_id
     where e.raw_payload is not null
       and e.raw_purged_at is null
       and e.received_at < now() - make_interval(
             days => case when e.tenant_id is null then 1
                          else coalesce(t.retention_days_raw_events, 7) end)
     order by e.received_at
     limit p_max_rows
  )
  update webhook_events e
     set raw_payload = null, raw_purged_at = now()
    from due
   where e.id = due.id;
  get diagnostics v_payloads_purged = row_count;

  -- (c) Redact message bodies past the tenant's own message retention.
  --
  --     `body_redacted_at` is set in the same statement, not as a follow-up: the
  --     `redacted_or_present` CHECK refuses the row otherwise, so a half-done redaction
  --     cannot commit. `messages.tenant_id` is NOT NULL, so unlike (b) there is no
  --     ownerless case and no floor — every message has a tenant whose policy applies.
  with due as (
    select m.id
      from messages m
      join tenants t on t.id = m.tenant_id
     where m.body is not null
       and m.body_redacted_at is null
       and m.at < now() - make_interval(days => coalesce(t.message_retention_days, 90))
     order by m.at
     limit p_max_rows
  )
  update messages m
     set body = null, body_redacted_at = now()
    from due
   where m.id = due.id;
  get diagnostics v_bodies_redacted = row_count;

  -- (d) Delete web sessions one day past expiry.
  --
  --     DELETE rather than redact, because unlike a message there is nothing here worth
  --     keeping: a token hash and a hashed IP answer no question once the session is over.
  --     The one-day lag is deliberate and is not a retention preference — it keeps a
  --     just-expired token resolvable long enough that a customer gets "your session
  --     ended" rather than a lookup miss, which is indistinguishable from a forged token
  --     and would be reported as one.
  with due as (
    select id from web_sessions
     where expires_at < now() - interval '1 day'
     order by expires_at
     limit p_max_rows
  )
  delete from web_sessions s using due where s.id = due.id;
  get diagnostics v_sessions_purged = row_count;

  -- (e) Delete rate-limit windows that closed a day ago. A counter outside its window can
  --     no longer refuse anything, so keeping it is storage with no reader.
  with due as (
    select tenant_id, bucket_key, window_start from web_rate_counters
     where window_start < now() - interval '1 day'
     order by window_start
     limit p_max_rows
  )
  delete from web_rate_counters c using due
   where c.tenant_id = due.tenant_id
     and c.bucket_key = due.bucket_key
     and c.window_start = due.window_start;
  get diagnostics v_counters_purged = row_count;

  v_ceiling_hit := (v_payloads_purged >= p_max_rows)
                or (v_rows_deleted >= p_max_rows)
                or (v_bodies_redacted >= p_max_rows)
                or (v_sessions_purged >= p_max_rows)
                or (v_counters_purged >= p_max_rows);

  v_result := jsonb_build_object(
    'payloads_purged', v_payloads_purged,
    'rows_deleted',    v_rows_deleted,
    'bodies_redacted', v_bodies_redacted,
    'sessions_purged', v_sessions_purged,
    'counters_purged', v_counters_purged,
    'ceiling_hit',     v_ceiling_hit,
    'max_rows',        p_max_rows
  );

  -- Always, including a run that did nothing: "the purge ran and found nothing" and "the
  -- purge did not run" are different facts, and only a row can tell them apart.
  insert into audit_log (tenant_id, actor, action, detail)
  values (null, null, 'retention.purge_expired', v_result);

  return v_result;
end $$;

revoke all on function ops.purge_expired(int) from public;
grant execute on function ops.purge_expired(int) to postgres, service_role;

-- The `web` provider stays DISABLED and no channel row is created here. Nothing changes
-- for any tenant: these two tables are empty, nothing reads them yet, and the surface
-- switches on when a tenant_channels row exists and a mint secret is provisioned.
--
-- Note for whoever reaches for `channel_providers.enabled` as that switch: it has NO
-- READER anywhere in `src/`. Flipping it today does nothing at all, which is D-064's
-- column-nobody-writes in its other form — a flag nobody reads.
