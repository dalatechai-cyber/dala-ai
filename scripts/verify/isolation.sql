-- Behavioural tenant-isolation tests, executed AS THE WRITER ROLE.
--
-- The catalog pack proves the controls EXIST; this proves they BITE. Run against a
-- scratch database, never production.
--
-- ## Why every assertion runs as `service_role`, and why that role must bypass RLS
--
-- This suite and `rls.sql` test two different halves and must not be confused.
-- `rls.sql` runs as `anon` and `authenticated` and proves the POLICIES bite. Nothing
-- here is about policies. The inbound path writes as `service_role`, which holds
-- BYPASSRLS on Supabase (verified: `rolbypassrls = true` on both `postgres` and
-- `service_role`), so on that path RLS is not what keeps one tenant out of another's
-- rows. The composite-FK spine, the unique identity index, the CHECK constraints and
-- the ALWAYS triggers are. None of those is affected by BYPASSRLS, which is precisely
-- why they were chosen.
--
-- **Running these assertions under a role where RLS is live would break them, not
-- strengthen them.** Measured on PostgreSQL 16.13 with a non-bypassing role holding
-- the same table grants: the T1 cross-tenant insert is refused with `42501 new row
-- violates row-level security policy` — the policy refuses first and the foreign key
-- is never reached. T1 would report PASS while the spine went completely untested.
-- That is a check that is green for the wrong reason, so T0 asserts the opposite of
-- the usual instinct: the role under test MUST bypass RLS, or the suite fails loudly.
--
-- Each block re-asserts `current_user` before the statement it is about, so deleting a
-- `set local role` line fails the test instead of silently running as the connecting
-- superuser — which is what this suite did until 2026-09-05.
\set ON_ERROR_STOP on

-- Wrapped and rolled back, so the suite is repeatable and leaves nothing behind.
-- A test that can only be run once is a test that stops being run.
begin;

-- T0: the premise every other test rests on. If `service_role` stops bypassing RLS, or
-- RLS stops being enabled and forced, the refusals below would start coming from the
-- wrong mechanism and every one of them would still say PASS.
do $$
declare bypass boolean; unprotected text;
begin
  select rolbypassrls into bypass from pg_roles where rolname = 'service_role';
  if bypass is null then raise exception 'T0 FAILED: no service_role in this database'; end if;
  if not bypass then
    raise exception 'T0 FAILED: service_role does not bypass RLS here, so a refusal below '
                    'may be a policy rather than the constraint under test';
  end if;
  select string_agg(relname, ', ' order by relname) into unprotected
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('services','service_variants','spend_ledger','tenants','channel_identity')
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if unprotected is not null then
    raise exception 'T0 FAILED: RLS not enabled+forced on %', unprotected;
  end if;
  raise notice 'T0 PASS: assertions run as service_role, which bypasses RLS — so what refuses below is the constraint, not a policy';
end $$;

-- The seed is written by the writer too: if service_role could not insert these, the
-- inbound path could not either, and that is worth finding here rather than in
-- production.
set local role service_role;

insert into tenants (id, slug, display_name, vertical, timezone) values
  ('11111111-1111-1111-1111-111111111111','tenant-a','Тенант А','salon','Asia/Ulaanbaatar'),
  ('22222222-2222-2222-2222-222222222222','tenant-b','Тенант Б','auto_service','Asia/Ulaanbaatar');

insert into services (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Эмэгтэй тайралт');

reset role;

-- T1: a child of tenant B may not attach to tenant A's parent. This is the control
-- that still works when the writer is service_role and has a scoping bug — so it is
-- run as service_role, which is the only way that sentence is a measurement.
do $$
declare c text;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T1 FAILED: ran as %, not service_role', current_user; end if;
  begin
    insert into service_variants (tenant_id, service_id, price_kind, price_min)
    values ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','exact',1000);
    raise exception 'T1 FAILED: cross-tenant child insert was accepted';
  exception
    when foreign_key_violation then
      get stacked diagnostics c = CONSTRAINT_NAME;
      if c <> 'service_variants_tenant_id_service_id_fkey' then
        raise exception 'T1 FAILED: refused by %, not by the composite-FK spine', c;
      end if;
      raise notice 'T1 PASS: cross-tenant child insert refused by %, as service_role', c;
    when insufficient_privilege then
      raise exception 'T1 FAILED: refused by RLS (%), not by the spine — the writer role is wrong', SQLERRM;
  end;
  reset role;
end $$;

-- T2: one live channel identity routes to exactly one tenant, across all tenants.
do $$
declare c text;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T2 FAILED: ran as %, not service_role', current_user; end if;
  insert into tenant_channels (id, tenant_id, provider, external_id)
    values ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','facebook_page','PAGE_1');
  insert into tenant_channels (id, tenant_id, provider, external_id)
    values ('cccccccc-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','facebook_page','PAGE_1');
  insert into channel_identity (tenant_id, channel_id, provider, external_id)
    values ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001','facebook_page','PAGE_1');
  begin
    insert into channel_identity (tenant_id, channel_id, provider, external_id)
    values ('22222222-2222-2222-2222-222222222222','cccccccc-0000-0000-0000-000000000002','facebook_page','PAGE_1');
    raise exception 'T2 FAILED: a second tenant claimed a live Page id';
  exception when unique_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'channel_identity_live_key' then
      raise exception 'T2 FAILED: refused by %, not by the live-identity unique index', c;
    end if;
    raise notice 'T2 PASS: a live channel identity cannot be claimed twice — refused by %, as service_role', c;
  end;
  reset role;
end $$;

-- T3: the spend ledger is append-only for the role that bypasses RLS — which is the
-- role that writes it. An UPDATE the policies would never see is the whole point.
do $$
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T3 FAILED: ran as %, not service_role', current_user; end if;
  insert into spend_ledger (tenant_id, surface, budget_bucket, model_id, cost_nanousd, fx_mnt_per_usd, cost_mnt)
    values ('11111111-1111-1111-1111-111111111111','reception','reception','claude-sonnet-5',5000,3500,0.02);
  begin
    update spend_ledger set cost_nanousd = 0;
    raise exception 'T3 FAILED: the ledger was rewritten';
  exception when restrict_violation then
    raise notice 'T3 PASS: ledger UPDATE refused, as service_role';
  end;
  begin
    delete from spend_ledger;
    raise exception 'T3 FAILED: the ledger was deleted';
  exception when restrict_violation then
    raise notice 'T3 PASS: ledger DELETE refused, as service_role';
  end;
  reset role;
end $$;

-- T4: a tenant cannot go active without a published config, AND cannot go active
-- without a passing probe. Two constraints, so two tests: a tenant missing both is
-- refused by whichever Postgres evaluates first, and asserting only `check_violation`
-- cannot tell them apart. It could not before — the old single test printed "refused
-- without a published config" while the refusal actually came from
-- `active_requires_probe_run`, and dropping `active_requires_published_config`
-- outright left it green. Each half now sets up the other precondition, so exactly
-- one constraint can fire and the test names it.
do $$
declare c text;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T4a FAILED: ran as %, not service_role', current_user; end if;
  -- probe present, config absent
  update tenants set probe_passed_at = now() where slug = 'tenant-a';
  begin
    update tenants set status = 'active' where slug = 'tenant-a';
    raise exception 'T4a FAILED: tenant went active with a probe but no published config';
  exception when check_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'active_requires_published_config' then
      raise exception 'T4a FAILED: refused by %, not by active_requires_published_config', c;
    end if;
    raise notice 'T4a PASS: activation refused by %, as service_role', c;
  end;
  reset role;
end $$;

do $$
declare c text; rev uuid;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T4b FAILED: ran as %, not service_role', current_user; end if;
  -- config present, probe absent
  insert into config_revisions (tenant_id, seq, status, published_at)
    values ('22222222-2222-2222-2222-222222222222', 1, 'published', now())
    returning id into rev;
  update tenants set live_revision_id = rev where slug = 'tenant-b';
  begin
    update tenants set status = 'active' where slug = 'tenant-b';
    raise exception 'T4b FAILED: tenant went active with a config but no passing probe';
  exception when check_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'active_requires_probe_run' then
      raise exception 'T4b FAILED: refused by %, not by active_requires_probe_run', c;
    end if;
    raise notice 'T4b PASS: activation refused by %, as service_role', c;
  end;
  reset role;
end $$;

-- T5: an unpriced variant may not carry a number. `unpriced_variant_names_its_refusal`
-- fires on the same row, so accepting any `check_violation` left this green when
-- `unpriced_carries_no_number` was dropped outright. The refusal is named.
do $$
declare c text;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T5 FAILED: ran as %, not service_role', current_user; end if;
  begin
    insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min)
    values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','child','none',30000);
    raise exception 'T5 FAILED: an unpriced variant carried a price';
  exception when check_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'unpriced_carries_no_number' then
      raise exception 'T5 FAILED: refused by %, not by unpriced_carries_no_number', c;
    end if;
    raise notice 'T5 PASS: unpriced variant may not carry a number — refused by %, as service_role', c;
  end;
  reset role;
end $$;

-- T6: Cyrillic is stored NFC. A decomposed string is refused at the boundary, so two
-- visually identical rows can never fail to match each other.
do $$
declare c text;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T6 FAILED: ran as %, not service_role', current_user; end if;
  begin
    insert into services (tenant_id, name)
    values ('11111111-1111-1111-1111-111111111111', normalize('Сайн байна уу', nfd));
    raise exception 'T6 FAILED: a decomposed Cyrillic string was stored';
  exception when check_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'services_name_check' then
      raise exception 'T6 FAILED: refused by %, not by the IS NORMALIZED check on services.name', c;
    end if;
    raise notice 'T6 PASS: non-NFC text refused by %, as service_role', c;
  end;
  reset role;
end $$;

-- T7: the folding projection maps the real keyboard confusions and nothing else. Run as
-- service_role because a function the writer cannot EXECUTE is a function the inbound
-- path cannot call, and that failure looks identical to a wrong answer from here.
do $$
declare v text;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T7 FAILED: ran as %, not service_role', current_user; end if;
  select app.mn_search_fold('ӨНГӨ ҮС') into v;
  if v <> 'онго ус' then raise exception 'T7 FAILED: fold produced %', v; end if;
  reset role;
  raise notice 'T7 PASS: mn_search_fold(ӨНГӨ ҮС) = %, called as service_role', v;
end $$;

-- T8: a reservation cannot exceed its ceiling, and two concurrent reservations
-- cannot both pass against the same balance.
do $$
declare a boolean; b boolean; c boolean;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T8 FAILED: ran as %, not service_role', current_user; end if;
  insert into spend_counters (scope, scope_key, surface, period_kind, period_key, ceiling_nanousd)
    values ('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 10000);
  select app.reserve_spend('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 6000) into a;
  select app.reserve_spend('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 6000) into b;
  select app.reserve_spend('tenant','11111111-1111-1111-1111-111111111111','reception','day','2026-08-31', 4000) into c;
  if not a then raise exception 'T8 FAILED: first reservation refused'; end if;
  if b then raise exception 'T8 FAILED: second reservation exceeded the ceiling'; end if;
  if not c then raise exception 'T8 FAILED: a reservation that fits was refused'; end if;
  reset role;
  raise notice 'T8 PASS: reserve granted 6000, refused 6000, granted 4000 against a 10000 ceiling, as service_role';
end $$;

-- T9: a missing counter row REFUSES. An absent budget is not "unlimited".
do $$
declare ok boolean;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T9 FAILED: ran as %, not service_role', current_user; end if;
  select app.reserve_spend('tenant','99999999-9999-9999-9999-999999999999','reception','day','2026-08-31', 1) into ok;
  if ok then raise exception 'T9 FAILED: reservation granted with no budget row'; end if;
  reset role;
  raise notice 'T9 PASS: a missing budget row refuses, called as service_role';
end $$;

-- T10: the writer cannot switch the triggers off underneath itself.
-- `session_replication_role = replica` suppresses ORIGIN-enabled triggers, which is the
-- one documented way a writer holding INSERT/UPDATE could dodge an append-only guard.
-- service_role must not be able to set it.
do $$
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T10 FAILED: ran as %, not service_role', current_user; end if;
  begin
    set local session_replication_role = 'replica';
    reset role;
    raise exception 'T10 FAILED: service_role set session_replication_role and can now bypass ORIGIN triggers';
  exception when insufficient_privilege then
    raise notice 'T10 PASS: service_role may not set session_replication_role';
  end;
  reset role;
end $$;

-- T11: and even a role that CAN set it does not get past the guard, because the
-- triggers are ENABLE ALWAYS rather than plain ENABLE. `catalog.sql` V9 asserts the
-- flag; this asserts the behaviour the flag is for. Runs as the connecting role, and
-- reports a SKIP as a skip when that role may not set the parameter.
do $$
declare may_set boolean := true;
begin
  begin
    set local session_replication_role = 'replica';
  exception when insufficient_privilege then
    may_set := false;
  end;
  if not may_set then
    raise notice 'T11 SKIP: % may not set session_replication_role, so the ALWAYS path is untested here', current_user;
  else
    begin
      update spend_ledger set cost_nanousd = 0;
      set local session_replication_role = 'origin';
      raise exception 'T11 FAILED: the ledger was rewritten under session_replication_role=replica — the trigger is ENABLE, not ENABLE ALWAYS';
    exception when restrict_violation then
      raise notice 'T11 PASS: append-only still bites under session_replication_role=replica (ENABLE ALWAYS)';
    end;
    set local session_replication_role = 'origin';
  end if;
end $$;

-- T12: A SECOND PUBLISH SURVIVES ITS OWN SUPERSEDE STEP.
--
-- `publishRevision` supersedes the outgoing revision with a bare
-- `update … set status = 'superseded'`, leaving `published_at` in place. Against the
-- original `published_has_a_time` — `(status = 'published') = (published_at is not null)`
-- — that UPDATE was refused for every revision that had ever been live, so every tenant's
-- SECOND publish failed at step 3, after the snapshot insert and the CAS had already
-- committed: two rows claiming 'published' and the pointer still on the old one.
--
-- Nothing caught it for two reasons worth keeping in view. `publish.test.ts` runs against
-- a stubbed client that accepts any update — the D-029 shape, a green suite that could not
-- have said anything. And no tenant had published twice, so production agreed with the
-- tests. This check is here rather than in `catalog.sql` because the constraint's SHAPE was
-- never the question: it read as correct. Only running the transition finds it.
do $$
declare
  v_t   uuid := '11111111-1111-4111-8111-111111111111';
  v_r1  uuid := '22222222-2222-4222-8222-222222222221';
  v_r2  uuid := '22222222-2222-4222-8222-222222222222';
begin
  insert into tenants (id, slug, display_name, vertical, default_locale, timezone)
  values (v_t, 't12-publish', 'T12', 'salon', 'mn-MN', 'Asia/Ulaanbaatar');

  insert into config_revisions (id, tenant_id, seq, status, published_at)
  values (v_r1, v_t, 1, 'published', now());
  insert into config_revisions (id, tenant_id, seq, status)
  values (v_r2, v_t, 2, 'draft');

  -- publishRevision step 2: the CAS onto the new revision.
  update config_revisions set status = 'published', published_at = now()
   where tenant_id = v_t and id = v_r2 and status = 'draft';

  -- publishRevision step 3: supersede the outgoing one. THIS is the statement that failed.
  update config_revisions set status = 'superseded'
   where tenant_id = v_t and status = 'published' and id <> v_r2;

  if (select status from config_revisions where id = v_r1) <> 'superseded' then
    raise exception 'T12 FAILED: the outgoing revision was not superseded';
  end if;
  if (select published_at from config_revisions where id = v_r1) is null then
    raise exception 'T12 FAILED: superseding erased the time the revision went live';
  end if;
  if (select count(*) from config_revisions where tenant_id = v_t and status = 'published') <> 1 then
    raise exception 'T12 FAILED: % rows claim published', (select count(*) from config_revisions where tenant_id = v_t and status = 'published');
  end if;
  raise notice 'T12 PASS: a second publish supersedes the first, and the first keeps its published_at';
end $$;

-- T13: and the half of the old rule that was right is still enforced — a draft may not
-- claim a publication time. Widening a CHECK is only safe if you say what it still refuses.
do $$
begin
  begin
    update config_revisions set status = 'draft'
     where tenant_id = '11111111-1111-4111-8111-111111111111' and status = 'superseded';
    raise exception 'T13 FAILED: a draft was allowed to carry a published_at';
  exception when check_violation then
    raise notice 'T13 PASS: a draft carrying a published_at is still refused';
  end;
end $$;

-- T14: expects_traffic_since is stamped by BOTH paths, and never cleared.
--
-- The column is only useful if it cannot be forgotten. `0012` learned that for
-- `went_live_at` and shipped two triggers; this asserts the same for the mode set that
-- includes `shadow_routing`, which is the path Matrix actually took — its row was INSERTED
-- in that mode, so an UPDATE-only trigger would never have fired.
do $$
declare
  v_t   uuid := '33333333-3333-4333-8333-333333333331';
  v_c1  uuid := '44444444-4444-4444-8444-444444444441';
  v_c2  uuid := '44444444-4444-4444-8444-444444444442';
  v_a   timestamptz;
  v_b   timestamptz;
begin
  insert into tenants (id, slug, display_name, vertical, default_locale, timezone)
  values (v_t, 't14-expects', 'T14', 'salon', 'mn-MN', 'Asia/Ulaanbaatar');

  -- (a) INSERTED straight into a traffic-expecting mode: stamped on the way in.
  insert into tenant_channels (id, tenant_id, provider, external_id, auth_flavour, app_slug, status, delivery_mode, token_status)
  values (v_c1, v_t, 'facebook_page', 't14-a', 'facebook_login', 'dalatech', 'pending', 'shadow_routing', 'unprovisioned');
  select expects_traffic_since into v_a from tenant_channels where id = v_c1;
  if v_a is null then
    raise exception 'T14 FAILED: a channel inserted at shadow_routing was not stamped';
  end if;

  -- (b) INSERTED at `off`, then moved: not stamped until it expects traffic.
  insert into tenant_channels (id, tenant_id, provider, external_id, auth_flavour, app_slug, status, delivery_mode, token_status)
  values (v_c2, v_t, 'facebook_page', 't14-b', 'facebook_login', 'dalatech', 'pending', 'off', 'unprovisioned');
  if (select expects_traffic_since from tenant_channels where id = v_c2) is not null then
    raise exception 'T14 FAILED: a channel at off was stamped — every decommissioned channel would be watched';
  end if;

  update tenant_channels set delivery_mode = 'shadow' where id = v_c2;
  select expects_traffic_since into v_b from tenant_channels where id = v_c2;
  if v_b is null then
    raise exception 'T14 FAILED: the transition into shadow did not stamp';
  end if;

  -- Never cleared, and never moved by a later transition. The question is "has this ever
  -- been expected to work", not "how long has this attempt been running".
  update tenant_channels set delivery_mode = 'off' where id = v_c2;
  update tenant_channels set delivery_mode = 'shadow_routing' where id = v_c2;
  if (select expects_traffic_since from tenant_channels where id = v_c2) is distinct from v_b then
    raise exception 'T14 FAILED: a later transition moved the timestamp';
  end if;

  raise notice 'T14 PASS: stamped on insert and on transition, never cleared, never re-stamped';
end $$;

-- T15: a branch's rows cannot attach to ANOTHER tenant's branch or price (0047, D-125).
-- The four branch tables are new, so the spine they rely on is new too: a per-branch price
-- that could point at another tenant's variant would put one salon's price in another's
-- prompt at the next publish. Run as service_role, like T1, for T1's reason.
do $$
declare c text; v_variant uuid; v_branch_a uuid; v_branch_b uuid;
begin
  set local role service_role;
  if current_user <> 'service_role' then raise exception 'T15 FAILED: ran as %, not service_role', current_user; end if;

  insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min)
    values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','t15','exact',30000)
    returning id into v_variant;
  insert into tenant_branches (tenant_id, name, provenance)
    values ('11111111-1111-1111-1111-111111111111','Салбар А','tenant_confirmed') returning id into v_branch_a;
  insert into tenant_branches (tenant_id, name, provenance)
    values ('22222222-2222-2222-2222-222222222222','Салбар Б','tenant_confirmed') returning id into v_branch_b;

  begin
    insert into branch_contact_points (tenant_id, branch_id, kind, value)
      values ('22222222-2222-2222-2222-222222222222', v_branch_a, 'address', 'Хаяг');
    raise exception 'T15 FAILED: tenant B wrote a contact point onto tenant A''s branch';
  exception when foreign_key_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'branch_contact_points_tenant_id_branch_id_fkey' then
      raise exception 'T15 FAILED: refused by %, not by the composite spine', c;
    end if;
  end;

  begin
    insert into branch_variant_prices (tenant_id, branch_id, variant_id, price_kind, price_min, confirmed_at)
      values ('22222222-2222-2222-2222-222222222222', v_branch_b, v_variant, 'exact', 1000, now());
    raise exception 'T15 FAILED: tenant B''s branch priced tenant A''s variant';
  exception when foreign_key_violation then
    get stacked diagnostics c = CONSTRAINT_NAME;
    if c <> 'branch_variant_prices_tenant_id_variant_id_fkey' then
      raise exception 'T15 FAILED: refused by %, not by the composite spine', c;
    end if;
  end;

  -- D-020: a branch that does not say where it came from is refused, not credited.
  begin
    insert into tenant_branches (tenant_id, name) values ('11111111-1111-1111-1111-111111111111','Салбар В');
    raise exception 'T15 FAILED: a branch with no provenance was accepted';
  exception when not_null_violation then null;
  end;

  reset role;
  raise notice 'T15 PASS: branch rows cannot cross tenants, and a branch must say where it came from';
end $$;

do $$ begin raise notice 'ISOLATION SUITE PASSED'; end $$;

rollback;
