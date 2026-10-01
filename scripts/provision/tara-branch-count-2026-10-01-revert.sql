-- ONLY IF NEEDED. Undoes tara-branch-count-2026-10-01.sql: the row and its two cases go; case
-- «Танай хэдэн салбартай вэ?» returns to the model case it was.
begin;
delete from deterministic_replies d using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'branch_count';
delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message in ('hed salbartai ve', 'Өөр салбар бий юу?');
update reply_cases r
   set expected_body = null, must_include = array['Парк Од']::text[], must_not_include = array['удахгүй']::text[],
       note = 'D-170: Tara has two branches, Яармаг and Парк Од (model case)'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message = 'Танай хэдэн салбартай вэ?';
commit;
