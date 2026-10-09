-- Revert tara-both-alerts-and-thanks-2026-10-09.sql: the media hand-off alert OFF again on both
-- Tara branches (D-153 as it was) and the eight thanks cases removed. Refuses when not applied.
begin;

do $$
begin
  if not exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
                 where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'thanks as typed 2026-10-09%') then
    raise exception 'tara-both-alerts-and-thanks-2026-10-09.sql is not applied';
  end if;
end $$;

update tenants set media_handoff_alert = false where slug in ('matrix-eco-salon', 'tara-park-od');
delete from reply_cases r using tenants t
 where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'thanks as typed 2026-10-09%';

do $$
begin
  if (select count(*) from tenants where slug in ('matrix-eco-salon', 'tara-park-od') and media_handoff_alert) <> 0
     or exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
                where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'thanks as typed 2026-10-09%') then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
