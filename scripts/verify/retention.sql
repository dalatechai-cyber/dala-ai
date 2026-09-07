-- Retention suite: does `ops.purge_expired` actually purge, and actually stop?
--
-- Written because a purge job is the easiest thing in this schema to get silently wrong.
-- A function that returns `{"payloads_purged": 0}` on every run looks identical to a
-- database with nothing due, and the retention promise it backs would be false for months
-- before anybody noticed. Every check below therefore asserts on ROWS, not on the return
-- value — the return value is the thing under test.
--
-- P1-P12 run as the migration owner and cover WHAT THE FUNCTION DOES. P13-P14 run as
-- `service_role` through `public.purge_expired` and cover WHETHER THE PRODUCTION CALLER CAN
-- MAKE IT BITE — which is a different question, and the one this file did not ask until
-- 2026-09-07.
--
-- The gap was not hypothetical. `webhook_events` carries `relforcerowsecurity`, which strips
-- the table owner of its usual RLS exemption; the function survives that only because it is
-- SECURITY DEFINER owned by a role holding BYPASSRLS. Every part of that sentence is a thing
-- that could change in a migration, and until P13 existed, changing any of it would have
-- produced a purge that runs, returns 200, writes an audit row saying zero, and quietly keeps
-- customer payloads for ever. Zeros from a blocked run and zeros from an empty queue are the
-- same bytes.

\set ON_ERROR_STOP on
begin;

create temporary table r(check_name text, status text, detail text) on commit drop;

-- --------------------------------------------------------------------------
-- Fixtures: one tenant with a 3-day payload retention, and events at chosen ages.
-- --------------------------------------------------------------------------
insert into tenants (id, slug, display_name, vertical, timezone, retention_days_raw_events)
values ('aa000000-0000-4000-8000-000000000001', 'retention-fixture', 'Retention Fixture',
        'salon', 'Asia/Ulaanbaatar', 3);

insert into tenant_channels (id, tenant_id, provider, external_id, app_slug)
values ('aa000000-0000-4000-8000-0000000000c1', 'aa000000-0000-4000-8000-000000000001',
        'facebook_page', '900000000000001', 'dalatech');

-- age_days, routing, tenant
insert into webhook_events (provider, dedup_key, source, routing, tenant_id, channel_id,
                            entry_id, state, raw_payload, received_at)
values
  -- routed, 1 day old: inside the tenant's 3-day retention. Must be untouched.
  ('facebook_page', 'k_fresh', 'meta', 'routed', 'aa000000-0000-4000-8000-000000000001',
   'aa000000-0000-4000-8000-0000000000c1', '900000000000001', 'processed',
   '{"text":"fresh"}'::jsonb, now() - interval '1 day'),
  -- routed, 5 days old: past 3, inside 30. Payload nulled, ROW SURVIVES.
  ('facebook_page', 'k_stale', 'meta', 'routed', 'aa000000-0000-4000-8000-000000000001',
   'aa000000-0000-4000-8000-0000000000c1', '900000000000001', 'processed',
   '{"text":"stale"}'::jsonb, now() - interval '5 days'),
  -- UNROUTED, 2 days old: belongs to nobody, so the 1-day FLOOR applies, not the
  -- platform default of 7. This is the row most likely to hold PII we may not keep.
  ('facebook_page', 'k_unrouted', 'meta', 'unrouted', null, null,
   '900000000000001', 'received', '{"text":"somebody elses customer"}'::jsonb,
   now() - interval '2 days'),
  -- routed, 40 days old: past 30. Row deleted entirely.
  ('facebook_page', 'k_ancient', 'meta', 'routed', 'aa000000-0000-4000-8000-000000000001',
   'aa000000-0000-4000-8000-0000000000c1', '900000000000001', 'processed',
   '{"text":"ancient"}'::jsonb, now() - interval '40 days');

-- A conversation and two messages: one past the fixture tenant's 90-day default, one
-- inside it. `messages.tenant_id` is NOT NULL, so unlike webhook_events there is no
-- ownerless case here and no floor.
insert into contacts (id, tenant_id, channel_id, external_id)
values ('aa000000-0000-4000-8000-0000000000e1', 'aa000000-0000-4000-8000-000000000001',
        'aa000000-0000-4000-8000-0000000000c1', 'PSID-RETENTION');
insert into conversations (id, tenant_id, contact_id, channel_id)
values ('aa000000-0000-4000-8000-0000000000f1', 'aa000000-0000-4000-8000-000000000001',
        'aa000000-0000-4000-8000-0000000000e1', 'aa000000-0000-4000-8000-0000000000c1');
insert into messages (id, tenant_id, conversation_id, direction, body, at)
values ('aa000000-0000-4000-8000-000000000a01', 'aa000000-0000-4000-8000-000000000001',
        'aa000000-0000-4000-8000-0000000000f1', 'inbound', 'past retention', now() - interval '120 days'),
       ('aa000000-0000-4000-8000-000000000a02', 'aa000000-0000-4000-8000-000000000001',
        'aa000000-0000-4000-8000-0000000000f1', 'inbound', 'inside retention', now() - interval '10 days');

-- --------------------------------------------------------------------------
do $$
declare v jsonb; n int; b bool;
begin
  v := ops.purge_expired();

  -- P1 --------------------------------------------------------------------
  select (raw_payload is not null and raw_purged_at is null) into b
    from webhook_events where dedup_key = 'k_fresh';
  insert into r values ('P1', case when b then 'PASS' else 'FAIL' end,
    'a payload inside the tenant retention is untouched');

  -- P2 -- the property the whole design turns on -----------------------------
  select count(*) into n from webhook_events
   where dedup_key = 'k_stale' and raw_payload is null and raw_purged_at is not null;
  insert into r values ('P2', case when n = 1 then 'PASS' else 'FAIL' end,
    'past retention: payload nulled, marker set, AND THE ROW WITH ITS DEDUP KEY SURVIVES');

  -- P3 -- the floor for rows belonging to nobody -----------------------------
  select count(*) into n from webhook_events
   where dedup_key = 'k_unrouted' and raw_payload is null and raw_purged_at is not null;
  insert into r values ('P3', case when n = 1 then 'PASS' else 'FAIL' end,
    'an UNROUTED payload is purged at the 1-day floor, not the 7-day default');

  -- P4 --------------------------------------------------------------------
  select count(*) into n from webhook_events where dedup_key = 'k_ancient';
  insert into r values ('P4', case when n = 0 then 'PASS' else 'FAIL' end,
    'a row past 30 days is deleted outright');

  -- P5 -- counts are real, not hopeful ---------------------------------------
  insert into r values ('P5',
    case when (v->>'payloads_purged')::int = 2 and (v->>'rows_deleted')::int = 1
          and (v->>'bodies_redacted')::int = 1
         then 'PASS' else 'FAIL' end,
    format('reported payloads_purged=%s rows_deleted=%s bodies_redacted=%s, expected 2, 1 and 1 '
           '— three disjoint counts, no row in two of them',
           v->>'payloads_purged', v->>'rows_deleted', v->>'bodies_redacted'));

  -- P6 -- every run leaves evidence, including a no-op one --------------------
  v := ops.purge_expired();
  select count(*) into n from audit_log where action = 'retention.purge_expired';
  insert into r values ('P6', case when n = 2 then 'PASS' else 'FAIL' end,
    format('two runs wrote two audit rows (found %s) — "ran and found nothing" is not "did not run"', n));

  -- P7 -- the second run is a no-op, so purging is not re-counted for ever ----
  insert into r values ('P7',
    case when (v->>'payloads_purged')::int = 0 and (v->>'rows_deleted')::int = 0
         then 'PASS' else 'FAIL' end,
    'a second run purges nothing: raw_purged_at is what makes it idempotent');

  -- P8 -- the ceiling is reported, because a purge falling behind is silent ---
  insert into webhook_events (provider, dedup_key, source, routing, tenant_id, channel_id,
                              entry_id, state, raw_payload, received_at)
  select 'facebook_page', 'k_bulk_' || g, 'meta', 'routed',
         'aa000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-0000000000c1',
         '900000000000001', 'processed', '{"text":"bulk"}'::jsonb, now() - interval '9 days'
    from generate_series(1, 5) g;
  v := ops.purge_expired(2);
  insert into r values ('P8',
    case when (v->>'ceiling_hit')::boolean and (v->>'payloads_purged')::int = 2
         then 'PASS' else 'FAIL' end,
    format('bounded at 2 and said so: purged=%s ceiling_hit=%s',
           v->>'payloads_purged', v->>'ceiling_hit'));

  -- P9 -- a nonsense bound refuses rather than doing nothing quietly ----------
  begin
    v := ops.purge_expired(0);
    insert into r values ('P9', 'FAIL', 'p_max_rows=0 returned instead of raising');
  exception when others then
    insert into r values ('P9', 'PASS', 'p_max_rows below 1 raises rather than no-oping');
  end;

  -- P10 -- the D-029 check: the name the RUNTIME will ask for must resolve ----
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'purge_expired';
  insert into r values ('P10', case when n = 1 then 'PASS' else 'FAIL' end,
    'public.purge_expired exists — a function only in `ops` is unreachable over PostgREST');

  -- P11 -- and anon must not be able to call it ------------------------------
  select has_function_privilege('anon', 'public.purge_expired(int)', 'execute') into b;
  insert into r values ('P11', case when not b then 'PASS' else 'FAIL' end,
    'anon holds no EXECUTE: PUBLIC is revoked, so the Data API cannot delete inbound history');

  -- P12 -- decided_at now tells the truth ------------------------------------
  insert into kb_change_proposals (tenant_id, target_kind, proposed, rationale)
  values ('aa000000-0000-4000-8000-000000000001', 'faqs', '{}'::jsonb, 'fixture');
  select count(*) into n from kb_change_proposals where state = 'open' and decided_at is null;
  insert into r values ('P12', case when n = 1 then 'PASS' else 'FAIL' end,
    'an OPEN proposal has a null decided_at rather than reading as decided at creation');
end $$;

do $$
declare n int;
begin
  -- P15 ------------------------------------------------------------------
  select count(*) into n from messages
   where id = 'aa000000-0000-4000-8000-000000000a01'
     and body is null and body_redacted_at is not null;
  insert into r values ('P15', case when n = 1 then 'PASS' else 'FAIL' end,
    'a message past the tenant retention is redacted, and THE ROW SURVIVES with its '
    'revision_id/prompt_hash link intact');

  -- P16 ------------------------------------------------------------------
  select count(*) into n from messages
   where id = 'aa000000-0000-4000-8000-000000000a02'
     and body is not null and body_redacted_at is null;
  insert into r values ('P16', case when n = 1 then 'PASS' else 'FAIL' end,
    'a message inside the tenant retention is untouched');

  -- P17 -- the pairing is the database's job, not the function's memory ----
  -- `redacted_or_present` refuses a nulled body with no marker. Asserting the constraint
  -- exists is what stops a future rewrite of the purge from half-redacting a row and
  -- leaving `readHistory` unable to tell a purged message from an empty one.
  select count(*) into n from pg_constraint
   where conrelid = 'public.messages'::regclass and conname = 'redacted_or_present';
  insert into r values ('P17', case when n = 1 then 'PASS' else 'FAIL' end,
    'redacted_or_present still exists — the CHECK is what makes a half-done redaction '
    'impossible to commit');
end $$;

-- ---------------------------------------------------------------------------
-- P13-P14: the PRODUCTION CALLER, not the owner
-- ---------------------------------------------------------------------------

-- P14 first, because it is P13's premise. In T0's spirit: if RLS stops being forced, P13
-- would go green for the wrong reason — it would be testing a table that no longer needs
-- the bypass it exists to prove.
do $$
declare forced boolean; bypass boolean; definer boolean;
begin
  select c.relforcerowsecurity into forced from pg_class c where c.relname = 'webhook_events';
  select p.prosecdef into definer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'purge_expired' and n.nspname = 'ops';
  select r.rolbypassrls into bypass from pg_roles r
   where r.rolname = pg_get_userbyid((select proowner from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'purge_expired' and n.nspname = 'ops'));
  -- SECURITY DEFINER is named here because it is what makes the OWNER's BYPASSRLS the
  -- relevant one. Drop it and the owner's attribute stops mattering — the caller's does,
  -- and the caller is whatever role the worker happens to connect as. P13 is what actually
  -- catches that; this row is the premise, so a reader can see which property moved.
  insert into r values ('P14', case when forced and bypass and definer then 'PASS' else 'FAIL' end,
    format('webhook_events forces RLS (%s), ops.purge_expired is SECURITY DEFINER (%s), and its '
           'owner holds BYPASSRLS (%s) — the three that let a purge see every tenant''s rows',
           forced, definer, bypass));
end $$;

-- A row that IS due: 9 days old, so past the fixture tenant's 3-day payload retention.
insert into webhook_events (provider, dedup_key, source, routing, tenant_id, channel_id,
                            entry_id, state, raw_payload, received_at)
values ('facebook_page', 'k_caller', 'meta', 'routed', 'aa000000-0000-4000-8000-000000000001',
        'aa000000-0000-4000-8000-0000000000c1', '900000000000001', 'processed',
        '{"text":"due, and the caller must be able to reach it"}'::jsonb, now() - interval '9 days');

-- Through the name PostgREST resolves, as the role the worker connects with. `supabase/
-- clients.ts` builds every client with no `db: { schema }`, so the runtime asks for
-- `public.purge_expired` as `service_role` — this line is that request, spelled out.
set local role service_role;
select public.purge_expired(50000);
reset role;

do $$
declare n int;
begin
  select count(*) into n from webhook_events
   where dedup_key = 'k_caller' and raw_payload is null and raw_purged_at is not null;
  insert into r values ('P13', case when n = 1 then 'PASS' else 'FAIL' end,
    'CALLED AS service_role THROUGH public.purge_expired, A DUE PAYLOAD IS ACTUALLY NULLED '
    '— the check that separates "nothing was due" from "the caller could not touch anything"');
end $$;

select check_name, status, detail from r order by
  (regexp_replace(check_name, '\D', '', 'g'))::int;

do $$
declare n int;
begin
  select count(*) into n from r where status <> 'PASS';
  if n > 0 then
    raise exception 'RETENTION SUITE FAILED: % check(s) red', n;
  end if;
  raise notice 'RETENTION SUITE PASSED: all checks green';
end $$;

rollback;
