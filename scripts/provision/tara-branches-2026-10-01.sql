-- NOT APPLIED. WAITS FOR THE FOUNDER'S APPROVAL OF THE WORDING (D-170).
-- Tara Salon — Яармаг: Дали says Tara has two branches and gives Парк Од's address, the shared
-- line and Парк Од's Facebook Page. Wording: prompt/drafts/tara_branches.mn.txt.
--
-- Why this passes the branch gate (D-157 says each Page gives only its own branch's details;
-- the founder makes this one exception): config/branch-groups.json lists «Парк Од» in
-- `allow_names` and Парк Од's address, exactly as below, in `allow_addresses`; 76001888 is in
-- `allow_phones`. Every other Парк Од detail (her own phone, staff, a map link) is still refused
-- in Яармаг's rows. The gate does not read Facebook links.
--
-- No canned row changes: no `canned_stale` window. The fixed reply is live at COMMIT; the
-- document reaches customers at the publish. Run it, then the dry run and publish at once.
-- Undo: tara-branches-2026-10-01-revert.sql.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and body = 'Matrix Eco Salon одоо Tara Salon нэртэй болсон.
Tara Salon одоогоор нэг салбартай: Яармаг салбар.
Хоёр дахь салбар удахгүй нээгдэнэ.
Энэ хуудас бол Яармаг салбарын хуудас.
Оюунаа Яармаг салбарт ажилладаг.') then
    raise exception '«Салбарууд» is not the document read on 2026-10-01 (or this file is applied)';
  end if;
  if exists (select 1 from deterministic_replies where tenant_id = t and intent = 'park_od_branch') then
    raise exception 'park_od_branch already present';
  end if;
end $$;

update knowledge_documents k
   set body = 'Matrix Eco Salon одоо Tara Salon нэртэй болсон.
Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.
Энэ хуудас бол Яармаг салбарын хуудас.
Оюунаа Яармаг салбарт ажилладаг.
Парк Од салбарын хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот.
Хоёр салбарын нийтлэг утас: 76001888.
Парк Од салбар өөрийн Фэйсбүүк хуудастай.',
       source = 'founder 2026-10-01', updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Салбарууд';

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'park_od_branch',
'Парк Од салбарын хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот
Утас: 76001888
Фэйсбүүк хуудас: https://www.facebook.com/profile.php?id=100067391025472',
       true, 'covers_message',
       array['парк', 'park', 'паркод', 'parkod']::text[],
       array['од', 'od', 'молл', 'moll', 'салбар', 'салбарын', 'салбарт', 'salbar', 'salbariin', 'хаана', 'хаяг', 'хаягаа',
             'байдаг', 'байрладаг', 'бдаг', 'утас', 'утсаа', 'дугаар', 'фэйсбүүк', 'фэйсбүүкийн', 'хуудас', 'хуудсаа',
             'haana', 'hayag', 'hayg', 'baidag', 'bdag', 'bairladag', 'utas', 'utsaa', 'dugaar', 'facebook', 'fb', 'page',
             'танай', 'танайх', 'вэ', 'бэ', 'ве', 'уу', 'үү', 'юу', 'сайн', 'байна', 'бна', 'бну', 'өгөөч', 'өгөөрэй',
             'tanai', 'tanaih', 've', 'we', 'be', 'uu', 'vv', 'yu', 'sain', 'bna', 'bnu', 'ogooch', 'ogoorei']::text[],
       false, 'tenant_confirmed', 'replace', '{}'
  from tenants t
 where t.slug = 'matrix-eco-salon';

insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, v.msg, d.body, 'D-170 (founder 2026-10-01): a question about Парк Од gets its address, the shared line and its Page, no model'
  from tenants t
  join deterministic_replies d on d.tenant_id = t.id and d.intent = 'park_od_branch',
       (values ('Парк Од салбар хаана байдаг вэ?'), ('park od haana baidag ve')) as v(msg)
 where t.slug = 'matrix-eco-salon';

-- The model, from the document: two branches, never «удахгүй нээгдэнэ».
insert into reply_cases (tenant_id, customer_message, must_include, must_not_include, note)
select t.id, 'Танай хэдэн салбартай вэ?', array['Парк Од']::text[], array['удахгүй']::text[],
       'D-170: Tara has two branches, Яармаг and Парк Од (model case)'
  from tenants t where t.slug = 'matrix-eco-salon';

commit;
