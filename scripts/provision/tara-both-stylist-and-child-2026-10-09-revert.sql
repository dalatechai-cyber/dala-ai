-- Revert tara-both-stylist-and-child-2026-10-09.sql: the six «stylist named» cases removed and the
-- four child's-cut cases back to no must_not_include, the hairdresser answer OFF again
-- (`reply_style` back to {"max_emoji": 1}). Refuses when not applied.
begin;

do $$
begin
  if not exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
                 where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'stylist named 2026-10-09%') then
    raise exception 'tara-both-stylist-and-child-2026-10-09.sql is not applied';
  end if;
end $$;

update tenants set reply_style = reply_style - 'stylist_named'
 where slug in ('matrix-eco-salon', 'tara-park-od');

delete from reply_cases r using tenants t
 where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'stylist named 2026-10-09%';

update reply_cases r set must_not_include = '{}'::text[]
  from tenants t
 where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od') and r.active
   and r.customer_message in ('8 настай хүүгийн үс тайралт хэд вэ?', '15 настай хүүгийн үс тайралт хэд вэ?')
   and r.must_not_include = ARRAY['оношлогоо'];

do $$
begin
  if exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
             where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'stylist named 2026-10-09%')
     or exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
                where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.must_not_include = ARRAY['оношлогоо'])
     or (select count(*) from tenants where slug in ('matrix-eco-salon', 'tara-park-od') and reply_style = '{"max_emoji": 1}'::jsonb) <> 2 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
