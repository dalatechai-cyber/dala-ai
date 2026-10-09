-- NOT APPLIED. Both Tara branches (matrix-eco-salon = Яармаг, tara-park-od = Парк Од): «Аль салбар нь
-- ойр вэ» / «al salbar ni oir ve» gets BOTH branches' addresses, Яармаг's Maps link (Парк Од has none
-- yet) and a question where the customer is coming from, as a fixed reply (no model). Founder, 2026-10-09.
-- Today it reaches the model, which answered with Яармаг's address only.
--
-- RUN ONLY AFTER the founder has signed prompt/drafts/tara_nearest_branch_2026-10-09.mn.txt (its last
-- line is new wording) and the pull request that adds `say_links` to config/branch-groups.json is
-- deployed (without it the branch gate refuses Парк Од's publish: Яармаг's Maps link in her rows).
-- The same bytes on both branches. A fixed reply is read per message: no publish is needed for it,
-- but publish both afterwards anyway if the dry run says the prefix changed.
-- Expected after it (with tara-both-stylist-and-child-2026-10-09.sql applied first): reply gate
-- matrix-eco-salon 73/73 · 15 need the model, tara-park-od 74/74 · 51; prefixes unchanged
-- («Nothing to publish»); branch gate clean on both (needs `say_links`; without it: LEAK).
-- Refuses a second run. Undo: the -revert.sql beside it.
begin;

do $$
begin
  if exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
             where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'nearest_branch') then
    raise exception 'tara-both-nearest-branch-2026-10-09.sql is already applied';
  end if;
  -- The facts it repeats, as they read today (2026-10-09): each branch's own address row, Яармаг's Maps link.
  if (select count(*) from contact_points c join tenants t on t.id = c.tenant_id
      where (t.slug = 'matrix-eco-salon' and c.kind = 'address' and c.value = 'Яармагийн Номин Хайпермаркетын баруун талд')
         or (t.slug = 'matrix-eco-salon' and c.kind = 'maps_url' and c.value = 'https://maps.app.goo.gl/ckEXBLoq4FnxJHq16')
         or (t.slug = 'tara-park-od' and c.kind = 'address' and c.value = 'Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот')) <> 3 then
    raise exception 'the addresses or the Maps link differ from 2026-10-09: rewrite the reply from today''s rows';
  end if;
  if exists (select 1 from contact_points c join tenants t on t.id = c.tenant_id where t.slug = 'tara-park-od' and c.kind = 'maps_url') then
    raise exception 'Парк Од now has a Maps link: add it to the reply before running this';
  end if;
end $$;

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, requires_empty_history, provenance, placement, matcher)
select t.id, 'nearest_branch', 'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16
Парк Од салбарын хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот
Та аль хэсгээс ирэх вэ?', true, 'matcher', '{}'::text[], false, 'tenant_confirmed', 'replace',
       '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["салбар", "salbar"]}, {"mode": "has_word", "words": ["ойр", "ойрхон", "ойрын", "ойролцоо", "oir", "oirhon", "oirxon", "oirkhon", "oirolcoo"]}]}'::jsonb
  from tenants t where t.slug in ('matrix-eco-salon', 'tara-park-od');

insert into reply_cases (tenant_id, customer_message, expected_body, note, active, channel)
select t.id, m.msg, 'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16
Парк Од салбарын хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот
Та аль хэсгээс ирэх вэ?', 'nearest branch 2026-10-09 (exact): ' || m.why, true, 'facebook_page'
  from tenants t
 cross join (values
    ('Аль салбар нь ойр вэ', 'the founder''s message; the model gave Яармаг''s address only'),
    ('al salbar ni oir ve', 'Latin'),
    ('Аль салбар нь ойрхон бэ?', '«ойрхон»')
  ) as m(msg, why)
 where t.slug in ('matrix-eco-salon', 'tara-park-od');

do $$
begin
  if (select count(distinct d.body) from deterministic_replies d join tenants t on t.id = d.tenant_id
      where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'nearest_branch' and d.enabled) <> 1
     or (select count(*) from deterministic_replies d join tenants t on t.id = d.tenant_id
         where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'nearest_branch') <> 2
     or (select count(*) from reply_cases r join tenants t on t.id = r.tenant_id
         where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'nearest branch 2026-10-09%' and r.active) <> 6 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
