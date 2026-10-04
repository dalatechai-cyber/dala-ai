-- Undo tara-yarmag-branch-phones-2026-10-04.sql for Tara Яармаг (matrix-eco-salon): «Салбарууд»,
-- park_od_branch and its three reply cases go back to the text read on 2026-10-04. Then publish
-- Яармаг again («Салбарууд» reaches customers only through the compiled prompt).
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and md5(body) = '1cb0ac13e3b639dbf4eb3f01f53783db')
     or not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'park_od_branch'
                 and md5(body) = 'bc7b65a3f711d16be007d6ffceddcfc7') then
    raise exception 'tara-yarmag-branch-phones-2026-10-04.sql is not applied, or its rows changed since';
  end if;
end $$;

update reply_cases r
   set expected_body = replace(r.expected_body, E'\nУтас: 99076874\n', E'\nУтас: 76001888\n')
  from tenants t, deterministic_replies d
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and d.tenant_id = t.id
   and d.intent = 'park_od_branch' and r.expected_body = d.body;

update deterministic_replies d
   set body = replace(d.body, E'\nУтас: 99076874\n', E'\nУтас: 76001888\n')
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'park_od_branch';

update knowledge_documents k
   set body = replace(k.body, E'Яармаг салбарын утас: 76001888, 91005498.\nПарк Од салбарын утас: 99076874.',
                      'Хоёр салбарын нийтлэг утас: 76001888.'),
       updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Салбарууд';

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and md5(body) = 'a5fb708c7349d0d573b95331f19aea5a')
     or not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'park_od_branch'
                 and md5(body) = '492f99169295fc68c8418ea5d08d48ad')
     or (select count(*) from reply_cases r join deterministic_replies d on d.tenant_id = r.tenant_id and d.intent = 'park_od_branch'
          where r.tenant_id = t and r.expected_body = d.body) <> 3 then
    raise exception 'read-back: not the text read on 2026-10-04';
  end if;
end $$;

commit;
