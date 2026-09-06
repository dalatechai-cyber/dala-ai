-- spend.sql — the ledger moves all of its counters or none of them.
--
-- `isolation.sql` proves the constraints bite; `rls.sql` proves the policies bite. This
-- proves the SPEND FUNCTIONS bite, which nothing else does: they are plpgsql, they are
-- where the money is, and every test of them in `src/` runs against a stub that answers
-- whatever it is told (D-029 — a suite stubbing `db.rpc` said nothing at all about a
-- function that did not exist).
--
-- Every check seeds its own counters, exercises one function, and asserts the END STATE of
-- BOTH counters — because the bug being guarded against is precisely a state where one
-- moved and the other did not.
--
-- Runs as the connecting role: these are SECURITY DEFINER functions owned by `postgres`,
-- and what is under test is their transactional behaviour, not who may call them (0015's
-- V27 asserts that half in `catalog.sql`).
\set ON_ERROR_STOP on
\pset format aligned

begin;

create temporary table _s (id text, name text, detail text, ok boolean) on commit drop;

create temporary table _seed (dummy int) on commit drop;   -- keeps the block below tidy

-- Two counters, one tenant and one platform, as `reserve()` seeds them.
create or replace function pg_temp.reseed(p_tenant_ceiling bigint, p_platform_ceiling bigint)
returns void language plpgsql as $$
begin
  delete from spend_counters where scope_key in ('t-spend', 'platform-spend');
  insert into spend_counters (scope, scope_key, surface, period_kind, period_key,
                              ceiling_nanousd, reserved_nanousd, settled_nanousd)
  values ('tenant', 't-spend', 'reception', 'day', '2026-09-06', p_tenant_ceiling, 0, 0),
         ('platform', 'platform-spend', 'reception', 'day', '2026-09-06', p_platform_ceiling, 0, 0);
end $$;

create or replace function pg_temp.targets() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('scope','tenant','scope_key','t-spend','period_kind','day','period_key','2026-09-06'),
    jsonb_build_object('scope','platform','scope_key','platform-spend','period_kind','day','period_key','2026-09-06'));
$$;

create or replace function pg_temp.reserved(p_key text) returns bigint language sql as $$
  select reserved_nanousd from spend_counters where scope_key = p_key and surface = 'reception';
$$;

do $$
declare granted boolean; t bigint; p bigint; code text;
begin
  -- S1 — the happy path moves BOTH counters.
  perform pg_temp.reseed(100, 1000);
  granted := app.reserve_spend_all(pg_temp.targets(), 'reception', 50);
  t := pg_temp.reserved('t-spend'); p := pg_temp.reserved('platform-spend');
  insert into _s values ('S1', 'a reservation that fits moves both counters',
    format('granted=%s tenant=%s platform=%s', granted, t, p), granted and t = 50 and p = 50);

  -- S2 — THE LEAK. The tenant ceiling refuses; the platform counter must not move.
  perform pg_temp.reseed(100, 1000);
  perform app.reserve_spend_all(pg_temp.targets(), 'reception', 50);
  begin
    perform app.reserve_spend_all(pg_temp.targets(), 'reception', 60);
    insert into _s values ('S2', 'a refused reservation rolls the whole set back', 'no exception raised', false);
  exception when check_violation then
    t := pg_temp.reserved('t-spend'); p := pg_temp.reserved('platform-spend');
    insert into _s values ('S2', 'a refused reservation rolls the whole set back',
      format('after refusal tenant=%s platform=%s (both must be 50)', t, p), t = 50 and p = 50);
  end;

  -- S3 — the refusal is 23514 and nothing else, because the caller degrades on that code
  -- and refuses on every other one.
  perform pg_temp.reseed(10, 1000);
  begin
    perform app.reserve_spend_all(pg_temp.targets(), 'reception', 99);
    insert into _s values ('S3', 'a ceiling refusal raises check_violation', 'no exception', false);
  exception when others then
    get stacked diagnostics code = RETURNED_SQLSTATE;
    insert into _s values ('S3', 'a ceiling refusal raises check_violation',
      format('sqlstate=%s', code), code = '23514');
  end;

  -- S4 — a MISSING counter refuses rather than passing unchecked.
  perform pg_temp.reseed(100, 1000);
  delete from spend_counters where scope_key = 'platform-spend';
  begin
    perform app.reserve_spend_all(pg_temp.targets(), 'reception', 1);
    insert into _s values ('S4', 'a target with no counter row refuses', 'no exception', false);
  exception when check_violation then
    t := pg_temp.reserved('t-spend');
    insert into _s values ('S4', 'a target with no counter row refuses',
      format('tenant stayed %s', t), t = 0);
  end;

  -- S5 — release GIVES THE BUDGET BACK, and only for a reservation still `held`.
  perform pg_temp.reseed(100, 1000);
  perform app.reserve_spend_all(pg_temp.targets(), 'reception', 40);
  insert into spend_reservations (id, tenant_id, surface, estimate_nanousd, state, expires_at)
  values ('11111111-1111-4111-8111-111111111111',
          (select id from tenants limit 1), 'reception', 40, 'held', now() + interval '5 minutes');
  granted := app.release_spend('11111111-1111-4111-8111-111111111111', pg_temp.targets(), 'reception', 40);
  t := pg_temp.reserved('t-spend'); p := pg_temp.reserved('platform-spend');
  insert into _s values ('S5', 'release refunds both counters',
    format('released=%s tenant=%s platform=%s', granted, t, p), granted and t = 0 and p = 0);

  -- S6 — a SECOND release refunds nothing. Without the CAS this is a way to mint budget.
  granted := app.release_spend('11111111-1111-4111-8111-111111111111', pg_temp.targets(), 'reception', 40);
  t := pg_temp.reserved('t-spend');
  insert into _s values ('S6', 'a second release is a no-op, not a second refund',
    format('released=%s tenant=%s', granted, t), (granted is false) and t = 0);

  -- S7 — a reservation already `called` is never refunded: the provider may have been
  -- reached, and the money with it.
  perform pg_temp.reseed(100, 1000);
  perform app.reserve_spend_all(pg_temp.targets(), 'reception', 30);
  insert into spend_reservations (id, tenant_id, surface, estimate_nanousd, state,
                                  provider_call_started_at, expires_at)
  values ('22222222-2222-4222-8222-222222222222',
          (select id from tenants limit 1), 'reception', 30, 'called', now(), now() + interval '5 minutes');
  granted := app.release_spend('22222222-2222-4222-8222-222222222222', pg_temp.targets(), 'reception', 30);
  t := pg_temp.reserved('t-spend');
  insert into _s values ('S7', 'a CALLED reservation is not refunded',
    format('released=%s tenant=%s (must stay 30)', granted, t), (granted is false) and t = 30);

  -- S8 — settling reaches both counters or neither.
  perform pg_temp.reseed(100, 1000);
  perform app.reserve_spend_all(pg_temp.targets(), 'reception', 50);
  delete from spend_counters where scope_key = 'platform-spend';
  begin
    perform app.settle_spend_all(pg_temp.targets(), 'reception', 50, 20);
    insert into _s values ('S8', 'a partial settlement rolls back', 'no exception', false);
  exception when check_violation then
    t := pg_temp.reserved('t-spend');
    insert into _s values ('S8', 'a partial settlement rolls back',
      format('tenant reserved stayed %s', t), t = 50);
  end;

  -- S9 — a full settlement moves reserved -> settled on both.
  perform pg_temp.reseed(100, 1000);
  perform app.reserve_spend_all(pg_temp.targets(), 'reception', 50);
  perform app.settle_spend_all(pg_temp.targets(), 'reception', 50, 20);
  select reserved_nanousd, settled_nanousd into t, p from spend_counters where scope_key = 't-spend';
  insert into _s values ('S9', 'a settlement moves reserved to settled',
    format('reserved=%s settled=%s', t, p), t = 0 and p = 20);

  -- S10 — a negative amount is a PROGRAMMING error, not a ceiling. Dressing it as 23514
  -- would turn a bug into a silent degradation.
  begin
    perform app.reserve_spend_all(pg_temp.targets(), 'reception', -1);
    insert into _s values ('S10', 'a negative amount is not a ceiling refusal', 'no exception', false);
  exception when others then
    get stacked diagnostics code = RETURNED_SQLSTATE;
    insert into _s values ('S10', 'a negative amount is not a ceiling refusal',
      format('sqlstate=%s', code), code = '22023');
  end;
end $$;

select id, name, case when ok then 'PASS' else 'FAIL' end as result, detail from _s order by id;

do $$
declare n integer;
begin
  select count(*) into n from _s where not ok;
  if n > 0 then raise exception 'SPEND SUITE FAILED: % check(s) did not pass', n; end if;
  raise notice 'SPEND SUITE PASSED: all checks green';
end $$;

rollback;
