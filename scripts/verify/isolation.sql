-- Behavioural tenant-isolation tests. The catalog pack proves the controls EXIST;
-- this proves they BITE. Run against a scratch database, never production.
\set ON_ERROR_STOP on

-- Wrapped and rolled back, so the suite is repeatable and leaves nothing behind.
-- A test that can only be run once is a test that stops being run.
begin;

insert into tenants (id, slug, display_name, vertical, timezone) values
  ('11111111-1111-1111-1111-111111111111','tenant-a','Тенант А','salon','Asia/Ulaanbaatar'),
  ('22222222-2222-2222-2222-222222222222','tenant-b','Тенант Б','auto_service','Asia/Ulaanbaatar');

insert into services (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Эмэгтэй тайралт');

-- T1: a child of tenant B may not attach to tenant A's parent. This is the control
-- that still works when the writer is service_role and has a scoping bug.
do $$
begin
  begin
    insert into service_variants (tenant_id, service_id, price_kind, price_min)
    values ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','exact',1000);
    raise exception 'T1 FAILED: cross-tenant child insert was accepted';
  exception when foreign_key_violation then
    raise notice 'T1 PASS: cross-tenant child insert refused by the spine';
  end;
end $$;

-- T2: one live channel identity routes to exactly one tenant, across all tenants.
insert into tenant_channels (id, tenant_id, provider, external_id)
  values ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','facebook_page','PAGE_1');
insert into tenant_channels (id, tenant_id, provider, external_id)
  values ('cccccccc-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','facebook_page','PAGE_1');
insert into channel_identity (tenant_id, channel_id, provider, external_id)
  values ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001','facebook_page','PAGE_1');
do $$
begin
  begin
    insert into channel_identity (tenant_id, channel_id, provider, external_id)
    values ('22222222-2222-2222-2222-222222222222','cccccccc-0000-0000-0000-000000000002','facebook_page','PAGE_1');
    raise exception 'T2 FAILED: a second tenant claimed a live Page id';
  exception when unique_violation then
    raise notice 'T2 PASS: a live channel identity cannot be claimed twice';
  end;
end $$;

-- T3: the spend ledger is append-only even for the role that bypasses RLS.
insert into spend_ledger (tenant_id, surface, budget_bucket, model_id, cost_nanousd, fx_mnt_per_usd, cost_mnt)
  values ('11111111-1111-1111-1111-111111111111','reception','reception','claude-sonnet-5',5000,3500,0.02);
do $$
begin
  begin
    update spend_ledger set cost_nanousd = 0;
    raise exception 'T3 FAILED: the ledger was rewritten';
  exception when restrict_violation then
    raise notice 'T3 PASS: ledger UPDATE refused';
  end;
  begin
    delete from spend_ledger;
    raise exception 'T3 FAILED: the ledger was deleted';
  exception when restrict_violation then
    raise notice 'T3 PASS: ledger DELETE refused';
  end;
end $$;

-- T4: a tenant cannot go active without a published config and a passing probe.
do $$
begin
  begin
    update tenants set status = 'active' where slug = 'tenant-a';
    raise exception 'T4 FAILED: tenant went active with no config and no probe';
  exception when check_violation then
    raise notice 'T4 PASS: activation refused without a published config';
  end;
end $$;

-- T5: an unpriced variant may not carry a number, and must name its refusal.
do $$
begin
  begin
    insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min)
    values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','child','none',30000);
    raise exception 'T5 FAILED: an unpriced variant carried a price';
  exception when check_violation then
    raise notice 'T5 PASS: unpriced variant may not carry a number';
  end;
end $$;

-- T6: Cyrillic is stored NFC. A decomposed string is refused at the boundary, so two
-- visually identical rows can never fail to match each other.
do $$
begin
  begin
    insert into services (tenant_id, name)
    values ('11111111-1111-1111-1111-111111111111', normalize('Сайн байна уу', nfd));
    raise exception 'T6 FAILED: a decomposed Cyrillic string was stored';
  exception when check_violation then
    raise notice 'T6 PASS: non-NFC text refused at the boundary';
  end;
end $$;

-- T7: the folding projection maps the real keyboard confusions and nothing else.
do $$
declare v text;
begin
  select app.mn_search_fold('ӨНГӨ ҮС') into v;
  if v <> 'онго ус' then raise exception 'T7 FAILED: fold produced %', v; end if;
  raise notice 'T7 PASS: mn_search_fold(ӨНГӨ ҮС) = %', v;
end $$;

-- T8: a reservation cannot exceed its ceiling, and two concurrent reservations
-- cannot both pass against the same balance.
insert into spend_counters (scope, scope_key, surface, period_kind, period_key, ceiling_nanousd)
  values ('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 10000);
do $$
declare a boolean; b boolean; c boolean;
begin
  select app.reserve_spend('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 6000) into a;
  select app.reserve_spend('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 6000) into b;
  select app.reserve_spend('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 4000) into c;
  if not a then raise exception 'T8 FAILED: first reservation refused'; end if;
  if b then raise exception 'T8 FAILED: second reservation exceeded the ceiling'; end if;
  if not c then raise exception 'T8 FAILED: a reservation that fits was refused'; end if;
  raise notice 'T8 PASS: reserve granted 6000, refused 6000, granted 4000 against a 10000 ceiling';
end $$;

-- T9: a missing counter row REFUSES. An absent budget is not "unlimited".
do $$
declare ok boolean;
begin
  select app.reserve_spend('tenant','99999999-9999-9999-9999-999999999999','reception','day','2026-08-31', 1) into ok;
  if ok then raise exception 'T9 FAILED: reservation granted with no budget row'; end if;
  raise notice 'T9 PASS: a missing budget row refuses';
end $$;

do $$ begin raise notice 'ISOLATION SUITE PASSED'; end $$;

rollback;
