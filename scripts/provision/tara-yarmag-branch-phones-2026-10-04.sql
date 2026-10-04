-- NOT APPLIED. Tara Яармаг (matrix-eco-salon). Founder's correction, 2026-10-04 (final):
-- Яармаг's numbers are 76001888 and 91005498; Парк Од's ONLY number is 99076874; 76001888 is
-- NOT shared with Парк Од. Two of Яармаг's rows said otherwise:
--
--   KB «Салбарууд»          «Хоёр салбарын нийтлэг утас: 76001888.» becomes two lines:
--                           «Яармаг салбарын утас: 76001888, 91005498.»
--                           «Парк Од салбарын утас: 99076874.»
--                           Every other line stays as it is.
--   fixed reply park_od_branch  «Утас: 76001888» becomes «Утас: 99076874» (address and Page unchanged).
--
-- The three Page reply cases that expect park_od_branch's text expect the new text.
-- The branch gate allows Парк Од's 99076874 in these two rows only (config/branch-groups.json
-- `say_phones` with `other_branch_in`).
--
-- ORDER: after tara-yarmag-stylist-names-2026-10-03.sql (this file pins «Салбарууд» as that file
-- leaves it, Oyunaa included) and tara-yarmag-answers-2026-10-04.sql, BEFORE the publish:
-- «Салбарууд» reaches customers only through the compiled prompt, so publish Яармаг at once
-- (launch step 12). park_od_branch is read at request time.
--
-- Undo: the -revert.sql beside it, then publish again.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд' and body like '%99076874%')
     or exists (select 1 from deterministic_replies where tenant_id = t and intent = 'park_od_branch' and body like '%99076874%') then
    raise exception 'this file is already applied';
  end if;
  -- «Салбарууд» exactly as the stylist-names file leaves it (read 2026-10-04, then «Оюунаа» → «Oyunaa»).
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and md5(body) = 'a5fb708c7349d0d573b95331f19aea5a') then
    raise exception '«Салбарууд» is not the text the stylist-names file leaves (apply tara-yarmag-stylist-names-2026-10-03.sql first, or read it again)';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'park_od_branch'
                 and md5(body) = '492f99169295fc68c8418ea5d08d48ad') then
    raise exception 'park_od_branch is not the text read on 2026-10-04';
  end if;
  if (select count(*) from reply_cases where tenant_id = t
        and expected_body = (select body from deterministic_replies where tenant_id = t and intent = 'park_od_branch')) <> 3 then
    raise exception 'three reply cases expecting park_od_branch were read on 2026-10-04; read them again';
  end if;
end $$;

update reply_cases r
   set expected_body = replace(r.expected_body, E'\nУтас: 76001888\n', E'\nУтас: 99076874\n')
  from tenants t, deterministic_replies d
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and d.tenant_id = t.id
   and d.intent = 'park_od_branch' and r.expected_body = d.body;

update deterministic_replies d
   set body = replace(d.body, E'\nУтас: 76001888\n', E'\nУтас: 99076874\n')
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'park_od_branch';

update knowledge_documents k
   set body = replace(k.body, 'Хоёр салбарын нийтлэг утас: 76001888.',
                      E'Яармаг салбарын утас: 76001888, 91005498.\nПарк Од салбарын утас: 99076874.'),
       updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Салбарууд';

-- Read back.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and md5(body) = '1cb0ac13e3b639dbf4eb3f01f53783db') then
    raise exception 'read-back: «Салбарууд»';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'park_od_branch'
                 and md5(body) = 'bc7b65a3f711d16be007d6ffceddcfc7') then
    raise exception 'read-back: park_od_branch';
  end if;
  if (select count(*) from reply_cases r join deterministic_replies d on d.tenant_id = r.tenant_id and d.intent = 'park_od_branch'
       where r.tenant_id = t and r.expected_body = d.body) <> 3 then
    raise exception 'read-back: the three park_od_branch cases';
  end if;
  if exists (select 1 from knowledge_documents where tenant_id = t and body like '%нийтлэг утас%') then
    raise exception 'read-back: «нийтлэг утас» must be gone';
  end if;
end $$;

commit;
