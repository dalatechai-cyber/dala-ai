-- NOT APPLIED. DRAFT for the founder (2026-10-05): MONEY — the founder decides and runs it.
-- Tara Salon — Парк Од (slug tara-park-od): the Reception entitlement and her spend ceiling.
--
-- Without the entitlement every reply of hers is refused (rule 2: identity, then entitlement,
-- then budget). Onboarding never grants spend (scripts/onboard/tenant.ts «What it will not do»).
--
-- The numbers are Яармаг's current row, read 2026-10-05 (read-only), unchanged:
--   daily $2.00 (2,000,000,000 nano-USD) × Reception's 0.95 share = $1.90 a day, the binding cap
--   (the compiled per-tenant surface cap is $2.00; the platform cap $10.00 a day across all
--   tenants: DalaTech $2.00 + Яармаг $1.90 + Парк Од $1.90 = $5.80, inside it);
--   monthly $28.57 (an intention, no reader: D-051, D-159); alert at 80 %; the 25/40
--   circuit-breakers; on_exhausted canned_reply (no reader either).
-- Change a figure here before running if Парк Од should differ; the read-back asserts the daily.
--
-- ORDER: any time after onboarding, before the publish (docs/runbooks/park-od-dali-2026-10-05.md).
-- Revert: delete from tenant_roles where tenant_id = (select id from tenants where slug = 'tara-park-od')
-- and role = 'reception'; (tenant_budgets is append-only: insert a row with daily 0 to stop spend.)
begin;

insert into tenant_roles (tenant_id, role, state, price_mnt, config, granted_by)
select t.id, 'reception', 'active', null, '{}'::jsonb, null
  from tenants t
 where t.slug = 'tara-park-od'
   and not exists (select 1 from tenant_roles r where r.tenant_id = t.id and r.role = 'reception');

insert into tenant_budgets
  (tenant_id, effective_from, monthly_ceiling_nanousd, daily_ceiling_nanousd,
   per_conversation_replies_24h, per_contact_replies_24h, surface_fractions,
   alert_threshold_pct, on_exhausted, ceiling_reason, set_by)
select t.id, now(), 28570000000, 2000000000, 25, 40,
       '{"care": 0.00, "analytics": 0.02, "reception": 0.95}'::jsonb,
       80, 'canned_reply', 'Парк Од: Яармаг''s ceiling as of 2026-10-05 (founder sets it)', null
  from tenants t
 where t.slug = 'tara-park-od'
   and not exists (select 1 from tenant_budgets b where b.tenant_id = t.id);

do $$
declare v_state text; v_status text; b record;
begin
  select tr.state, r.status into v_state, v_status
    from tenant_roles tr join tenants t on t.id = tr.tenant_id join roles r on r.role = tr.role
   where t.slug = 'tara-park-od' and tr.role = 'reception';
  if v_state is null or v_state not in ('active', 'trial') then
    raise exception 'read-back: tara-park-od has no active reception entitlement';
  end if;
  if v_status <> 'available' then
    raise exception 'read-back: the reception ROLE is %, so the platform gate outranks the grant', v_status;
  end if;
  select bb.* into b from tenant_budgets bb join tenants t on t.id = bb.tenant_id
   where t.slug = 'tara-park-od' order by bb.effective_from desc limit 1;
  if b is null or b.daily_ceiling_nanousd <> 2000000000 then
    raise exception 'read-back: tara-park-od''s daily ceiling is not $2.00';
  end if;
end $$;

commit;
