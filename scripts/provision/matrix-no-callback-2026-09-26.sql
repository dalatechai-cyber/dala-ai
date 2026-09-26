-- Tara (matrix-eco-salon): the salon's staff do not call customers back (founder, 2026-09-26).
--
--  - The callback and lead_thanks steps are removed entirely (they had been disabled since
--    2026-09-25; their approved words stay in scripts/provision/sales-wording-approved-2026-09-26.sql
--    as history). Дали never asks a Tara customer for a phone number.
--  - Tara's only next step is booking: «Цаг захиалах бол:» + the approved booking line (unchanged).
--  - Leads route nowhere: lead_route = 'none' (0053). The Page inbox label route is retired;
--    nothing in the platform ever created a Meta label, so there is nothing to remove on Meta's side.
-- DalaTech's callback and lead_thanks rows are untouched.
-- Run AFTER the code that parses 'none' is deployed: the shadow of an older build refuses an
-- unknown route and records nothing for Tara (the reply itself is never affected).
begin;

delete from sales_next_steps s using tenants t
 where t.id = s.tenant_id and t.slug = 'matrix-eco-salon' and s.kind in ('callback', 'lead_thanks');

update sales_playbooks p set lead_route = 'none', updated_at = now()
  from tenants t where t.id = p.tenant_id and t.slug = 'matrix-eco-salon';

do $$ begin
  if exists (select 1 from sales_next_steps s join tenants t on t.id = s.tenant_id
              where t.slug = 'matrix-eco-salon' and s.kind <> 'booking') then
    raise exception 'Tara still has a next-step row other than booking';
  end if;
  if not exists (select 1 from sales_next_steps s join tenants t on t.id = s.tenant_id
                  where t.slug = 'matrix-eco-salon' and s.kind = 'booking' and s.is_default and s.enabled
                    and s.reviewed_at is not null and s.body like 'Цаг захиалах бол: %') then
    raise exception 'Tara''s booking step is not the reviewed default';
  end if;
  if (select count(*) from sales_next_steps s join tenants t on t.id = s.tenant_id
       where t.slug = 'dalatech' and s.kind in ('callback', 'lead_thanks') and s.enabled and s.reviewed_at is not null) <> 2 then
    raise exception 'DalaTech''s callback and lead_thanks must be untouched';
  end if;
end $$;

commit;
