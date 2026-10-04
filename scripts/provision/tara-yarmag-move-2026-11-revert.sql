-- NOT APPLIED. Undo tara-yarmag-move-2026-11.sql (if the move is postponed after running it):
-- Яармаг's address row, map link, fixed address reply and its reply cases, and Парк Од's two rows
-- that name Яармаг's address, back to the text read on 2026-10-01 / written 2026-10-04. Then
-- publish both tenants:
--     node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
--     node scripts/publish/tenant.ts --slug tara-park-od --publish     (if she is published)
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from contact_points where tenant_id = t and kind = 'address'
                 and value = 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар') then
    raise exception 'tara-yarmag-move-2026-11.sql is not applied (the address row is not the new one)';
  end if;
  if exists (select 1 from contact_points where tenant_id = t and kind = 'maps_url') then
    raise exception 'a map link was added after the move: decide by hand which one stays';
  end if;
end $$;

-- How many of Парк Од's rows give the moved address line: exactly these must give the old one.
create temp table parkod_revert_expect on commit drop as
select count(*)::int as expected from (
  select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'tara-park-od' and k.title = 'Салбарууд'
     and k.body like '%Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар.%'
  union all
  select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
   where t.slug = 'tara-park-od' and d.intent = 'yarmag_branch'
     and d.body like '%Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар%') x;

update contact_points c
   set value = 'Яармагийн Номин Хайпермаркетын баруун талд'
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'address';

insert into contact_points (tenant_id, kind, value)
select t.id, 'maps_url', 'https://maps.app.goo.gl/ckEXBLoq4FnxJHq16' from tenants t where t.slug = 'matrix-eco-salon';

update deterministic_replies d
   set body = E'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд\nБайршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16'
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'address';

update reply_cases r
   set expected_body = E'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд\nБайршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id
   and r.expected_body = 'Хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар';

update reply_cases r
   set history = (
         select jsonb_agg(case when e ? 'content'
                               then jsonb_set(e, '{content}', to_jsonb(replace(e->>'content',
                                      'Хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар',
                                      E'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд\nБайршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16')))
                               else e end order by x.ord)
           from jsonb_array_elements(r.history) with ordinality as x(e, ord))
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.history::text like '%VIP Center 2 давхар%';

update reply_cases r
   set expected_body = replace(r.expected_body, 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар', 'Яармагийн Номин Хайпермаркетын баруун талд'),
       history = replace(r.history::text, 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар', 'Яармагийн Номин Хайпермаркетын баруун талд')::jsonb
  from tenants t
 where t.slug = 'tara-park-od' and r.tenant_id = t.id
   and (r.expected_body like '%VIP Center 2 давхар%' or r.history::text like '%VIP Center 2 давхар%');

update deterministic_replies d
   set web_body = replace(d.web_body, 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар', 'Яармагийн Номин Хайпермаркетын баруун талд')
  from tenants t
 where t.slug = 'tara-park-od' and d.tenant_id = t.id and d.web_body like '%VIP Center 2 давхар%';

update knowledge_documents k
   set body = replace(k.body, 'Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар.',
                              'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд.'),
       updated_at = now()
  from tenants t
 where t.slug = 'tara-park-od' and k.tenant_id = t.id and k.title = 'Салбарууд';

update deterministic_replies d
   set body = replace(d.body, 'Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар',
                              'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд')
  from tenants t
 where t.slug = 'tara-park-od' and d.tenant_id = t.id and d.intent = 'yarmag_branch';

do $$
declare t uuid; n int;
begin
  for t in select id from tenants where slug in ('matrix-eco-salon', 'tara-park-od') loop
    select count(*) into n from (
      select value as x from contact_points where tenant_id = t
      union all select body from deterministic_replies where tenant_id = t
      union all select body from canned_responses where tenant_id = t
      union all select body from knowledge_documents where tenant_id = t
      union all select answer from faqs where tenant_id = t
      union all select history::text || coalesce(expected_body, '') from reply_cases where tenant_id = t) y
     where y.x like '%VIP Center 2 давхар%';
    if n <> 0 then raise exception '% row(s) still give the VIP Center address', n; end if;
  end loop;
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'address'
                 and md5(body) = 'f871279d84f053ea069ae0a909befc3f') then
    raise exception 'read-back: the fixed address reply is not the text read on 2026-10-01';
  end if;
  if not exists (select 1 from contact_points where tenant_id = t and kind = 'address'
                 and md5(value) = 'd2bc506dccc3778320c9acec608ba6d9')
     or not exists (select 1 from contact_points where tenant_id = t and kind = 'maps_url'
                 and md5(value) = '392922821a95e12cba19c8d8c9206823') then
    raise exception 'read-back: the address and map link rows are not the ones read on 2026-10-01';
  end if;
  select id into t from tenants where slug = 'tara-park-od';
  if t is not null and (select count(*) from (
        select body from knowledge_documents where tenant_id = t and title = 'Салбарууд'
        union all select body from deterministic_replies where tenant_id = t and intent = 'yarmag_branch') y
       where y.body like '%Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд%')
     <> (select expected from parkod_revert_expect) then
    raise exception 'read-back: tara-park-od''s rows that gave the moved address must give the old one again';
  end if;
end $$;

commit;
