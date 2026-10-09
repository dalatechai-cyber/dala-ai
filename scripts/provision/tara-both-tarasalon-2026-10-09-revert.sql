-- Revert tara-both-tarasalon-2026-10-09.sql: every address back to https://www.matrixecosalon.org/
-- on both branches, in one transaction, then publish BOTH. Refuses unless that file is applied.
begin;

set local dala.canned_edit = 'republish';

do $$
declare n int;
begin
  select count(*) into n from tenant_booking b join tenants t on t.id = b.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and b.booking_url = 'https://www.tarasalon.org/';
  if n <> 2 then raise exception 'tara-both-tarasalon-2026-10-09.sql is not applied (found % booking links on tarasalon.org)', n; end if;
end $$;

update tenant_booking b set booking_url = 'https://www.matrixecosalon.org/'
  from tenants t where t.id = b.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and b.booking_url = 'https://www.tarasalon.org/';

update contact_points c set value = 'https://www.matrixecosalon.org/products.html'
  from tenants t where t.id = c.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and c.kind = 'website' and c.value = 'https://www.tarasalon.org/products.html';

-- The old line is the one the founder approved before; signed again in the same statement (D-163).
update canned_responses c
   set body = replace(c.body, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/'),
       reviewed_by = 'founder', reviewed_at = now()
  from tenants t where t.id = c.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and c.kind = 'booking_line' and c.body like '%https://www.tarasalon.org/%';

update deterministic_replies d
   set body = replace(d.body, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/')
  from tenants t where t.id = d.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and d.body like '%https://www.tarasalon.org/%';

update faqs f
   set answer = replace(f.answer, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/')
  from tenants t where t.id = f.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and f.answer like '%https://www.tarasalon.org/%';

update sales_next_steps s
   set body = replace(s.body, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/'),
       link = replace(s.link, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/'),
       reviewed_at = now()
  from tenants t where t.id = s.tenant_id and t.slug = 'matrix-eco-salon'
   and (s.body like '%https://www.tarasalon.org/%' or s.link like '%https://www.tarasalon.org/%');

update reply_cases r
   set expected_body = replace(r.expected_body, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/'),
       must_include = array(select replace(x, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/') from unnest(r.must_include) x),
       must_not_include = array(select replace(x, 'https://www.tarasalon.org/', 'https://www.matrixecosalon.org/') from unnest(r.must_not_include) x)
  from tenants t where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and (r.expected_body like '%https://www.tarasalon.org/%' or array_to_string(r.must_include, '|') like '%https://www.tarasalon.org/%'
        or array_to_string(r.must_not_include, '|') like '%https://www.tarasalon.org/%');

do $$
declare n int;
begin
  select count(*) into n from (
    select b.tenant_id from tenant_booking b where b.booking_url like '%tarasalon.org%'
    union all select c.tenant_id from contact_points c where c.value like '%tarasalon.org%'
    union all select c.tenant_id from canned_responses c where c.body like '%tarasalon.org%'
    union all select d.tenant_id from deterministic_replies d where d.body like '%tarasalon.org%'
    union all select f.tenant_id from faqs f where f.answer like '%tarasalon.org%'
    union all select s.tenant_id from sales_next_steps s where s.body like '%tarasalon.org%' or s.link like '%tarasalon.org%'
    union all select r.tenant_id from reply_cases r where r.expected_body like '%tarasalon.org%' or array_to_string(r.must_include, '|') like '%tarasalon.org%'
  ) x where x.tenant_id in (select id from tenants where slug in ('matrix-eco-salon', 'tara-park-od'));
  if n <> 0 then raise exception 'read-back: % row(s) still name tarasalon.org', n; end if;
end $$;

commit;
-- NOW publish BOTH.
