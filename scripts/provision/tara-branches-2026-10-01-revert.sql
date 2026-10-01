-- ONLY IF NEEDED. Undoes tara-branches-2026-10-01.sql (D-170): «Салбарууд» back to the text
-- read on 2026-10-01, the Парк Од fixed reply and its reply cases removed. Then publish.
begin;

update knowledge_documents k
   set body = 'Matrix Eco Salon одоо Tara Salon нэртэй болсон.
Tara Salon одоогоор нэг салбартай: Яармаг салбар.
Хоёр дахь салбар удахгүй нээгдэнэ.
Энэ хуудас бол Яармаг салбарын хуудас.
Оюунаа Яармаг салбарт ажилладаг.',
       source = 'founder 2026-09-24', updated_at = timestamptz '2026-09-27 04:08:22.939159+00'
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Салбарууд';

delete from deterministic_replies d using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'park_od_branch';

delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id
   and r.customer_message in ('Парк Од салбар хаана байдаг вэ?', 'park od haana baidag ve', 'Танай хэдэн салбартай вэ?', 'Паркинг байна уу?');

commit;
