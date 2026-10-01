-- NOT APPLIED. WAITS FOR THE FOUNDER'S APPROVAL (D-170 addendum).
-- A question about how many branches Tara has, or which, is answered by a fixed reply: the
-- already-approved sentence from «Салбарууд», byte for byte, with no model. The --with-model dry
-- run of 2026-10-01 showed the model does not name the branches the same way every time
-- (case «Танай хэдэн салбартай вэ?» failed: «Парк Од» missing, flag fact_restated).
--
-- Matches only messages made of «салбар…» plus question words («Танай хэдэн салбартай вэ?»,
-- «Өөр салбар бий юу?», «hed salbartai ve»). A message naming a branch or asking where, a phone
-- or a price is not covered and goes to its own row (park_od_branch, address, salon_phone) or the
-- model. Run after tara-branches-2026-10-01.sql; live at COMMIT (no publish needed for the row;
-- publish anyway, the «Салбарууд» document is waiting on it). Undo: the -revert.sql beside it.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and body like '%Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.%') then
    raise exception 'apply tara-branches-2026-10-01.sql first';
  end if;
  if exists (select 1 from deterministic_replies where tenant_id = t and intent = 'branch_count') then
    raise exception 'branch_count already present';
  end if;
end $$;

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'branch_count', 'Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.', true, 'covers_message',
       array['салбар', 'salbar']::text[],
       array['танай', 'танайх', 'tanai', 'tanaih', 'хэдэн', 'хэд', 'heden', 'hed', 'өөр', 'oor', 'uur', 'бий', 'bii',
             'байдаг', 'baidag', 'bdag', 'бдаг', 'вэ', 'бэ', 'ве', 'уу', 'үү', 'юу', 've', 'we', 'be', 'uu', 'vv', 'yu',
             'tara', 'тара', 'salon', 'салон', 'салоны', 'сайн', 'байна', 'бна', 'sain', 'bna']::text[],
       false, 'tenant_confirmed', 'replace', '{}'
  from tenants t where t.slug = 'matrix-eco-salon';

-- The failing model case becomes an exact case: the row answers it, no model.
update reply_cases r
   set expected_body = 'Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.', must_include = '{}', must_not_include = '{}',
       note = 'D-170: Tara has two branches; answered by the fixed reply branch_count (founder 2026-10-01)'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message = 'Танай хэдэн салбартай вэ?';

insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, v.msg, 'Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.', 'D-170: branch_count (founder 2026-10-01)'
  from tenants t, (values ('hed salbartai ve'), ('Өөр салбар бий юу?')) as v(msg)
 where t.slug = 'matrix-eco-salon';

commit;
