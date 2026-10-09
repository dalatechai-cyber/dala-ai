-- Revert tara-both-nearest-branch-2026-10-09.sql: the fixed reply and its fourteen cases removed on both
-- branches (the question goes back to the model). Refuses when not applied.
begin;

do $$
begin
  if not exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
                 where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'nearest_branch') then
    raise exception 'tara-both-nearest-branch-2026-10-09.sql is not applied';
  end if;
end $$;

delete from reply_cases r using tenants t
 where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'nearest branch 2026-10-09%';
delete from deterministic_replies d using tenants t
 where t.id = d.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'nearest_branch';

do $$
begin
  if exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
             where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'nearest_branch')
     or exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
                where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'nearest branch 2026-10-09%') then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
