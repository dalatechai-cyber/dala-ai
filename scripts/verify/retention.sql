-- Retention suite: does `ops.purge_expired` actually purge, and actually stop?
--
-- Written because a purge job is the easiest thing in this schema to get silently wrong.
-- A function that returns `{"payloads_purged": 0}` on every run looks identical to a
-- database with nothing due, and the retention promise it backs would be false for months
-- before anybody noticed. Every check below therefore asserts on ROWS, not on the return
-- value — the return value is the thing under test.
--
-- Runs as the migration owner. `rls.sql` covers who may call it; this covers what it does.

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
         then 'PASS' else 'FAIL' end,
    format('reported payloads_purged=%s rows_deleted=%s, expected 2 and 1',
           v->>'payloads_purged', v->>'rows_deleted'));

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
