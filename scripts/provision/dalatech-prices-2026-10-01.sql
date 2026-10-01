-- DalaTech (tenant #0): the price and description change of 2026-10-01 (D-171).
--
-- The figures and facts are the founder's (2026-10-01). Every Mongolian line below is a
-- DRAFT until the founder signs it (CLAUDE.md, "Customer-visible Mongolian"); run this file
-- only after that, and with the wording exactly as signed.
--
--   Вира 250,000₮/сар (was 350,000₮). Videos and posts are made to the customer's wishes
--   under the monthly content plan; no fixed counts (was 3 short videos and 8 posts).
--   Ора: a monthly usage allowance shown as a percentage. 100% ≈ 50 everyday questions a
--   day; Мэргэн and large files use more. An extra «+25%» pack costs 49,000₮. This replaces
--   the 1,500 messages a month and the 500-message pack (same price, 49,000₮).
--
-- Where each part lands, and when a customer sees it:
--   1. service_variants: Вира's month, and the pack's label (its price is unchanged). Read
--      per request: live on commit. The label carries no digits (D-075, D-148): «+25%» is
--      in the knowledge document, so the only number on a served row is its price.
--   2. reply_cases: every active case that quotes Вира's 350,000₮, and new model cases for
--      the new facts (they run only with --with-model).
--   3. knowledge_documents: Вира's and Ора's documents, both launch states of each. These
--      reach customers at the next PUBLISH (`scripts/publish/tenant.ts`).
--
-- Not touched, because nothing there carries these facts (read off the project 2026-10-01):
-- faqs, deterministic_replies (the price overview's {{soon}}/{{live}} lines render from
-- service_variants), canned_responses.
begin;

create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
do $$ begin
  if (select count(*) from dt) <> 1 then raise exception 'tenant dalatech not found exactly once'; end if;
end $$;

create temp table svc on commit drop as
select s.id, s.name from services s join dt on dt.id = s.tenant_id;

-- ---------------------------------------------------------------- 1. price rows

update service_variants v set price_min = 250000, confirmed_at = now()
  from svc where v.service_id = svc.id and svc.name = normalize('Вира — маркетинг менежер', NFC)
   and v.variant_key = normalize('Сарын төлбөр', NFC) and v.price_min = 350000;

update service_variants v set variant_key = normalize('Нэмэлт ашиглалтын багц', NFC), confirmed_at = now()
  from svc where v.service_id = svc.id and svc.name = normalize('Ора — хувийн туслах', NFC)
   and v.variant_key = normalize('Нэмэлт мессежийн багц', NFC) and v.price_min = 49000;

-- ---------------------------------------------------------------- 2. reply cases

update reply_cases r set must_include = array_replace(r.must_include, '350,000', '250,000'),
       note = coalesce(r.note, '') || ' Вира 250,000₮/сар from 2026-10-01 (D-171).'
  from dt where r.tenant_id = dt.id and r.active and '350,000' = any(r.must_include);

update reply_cases r set expected_body = replace(replace(r.expected_body,
         normalize('Вира сард 350,000₮', NFC), normalize('Вира сард 250,000₮', NFC)),
         normalize('Вира — маркетинг менежер: сард 350,000₮', NFC), normalize('Вира — маркетинг менежер: сард 250,000₮', NFC)),
       note = coalesce(r.note, '') || ' Вира 250,000₮/сар from 2026-10-01 (D-171).'
  from dt where r.tenant_id = dt.id and r.active and r.expected_body like '%350,000₮%';

insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active)
select dt.id, 'facebook_page', normalize(x.q, NFC), null, x.inc, x.nots, x.note, true
  from dt, (values
    ('Ора сард хэдэн мессеж бичих боломжтой вэ?', array['100%', '50'], array['1,500', '500 мессеж'],
     'D-171: Ора has a monthly allowance in percent, 100% ≈ 50 everyday questions a day; never the old 1,500 messages.'),
    ('Орагийн нэмэлт багц хэд вэ?', array['25%', '49,000'], array['500 мессеж'],
     'D-171: the extra pack is +25% for 49,000₮; never the old 500 messages.'),
    ('Вира сард хэдэн пост хийдэг вэ?', array[]::text[], array['8 пост', '3 богино видео', '350,000'],
     'D-171: Вира has no fixed counts; posts and videos follow the monthly content plan.')
  ) x(q, inc, nots, note)
 where not exists (select 1 from reply_cases r where r.tenant_id = dt.id and r.active
                      and r.customer_message = normalize(x.q, NFC));

-- ---------------------------------------------------------------- 3. documents

create temp table doc_edits (title_prefix text, old_line text, new_line text) on commit drop;
insert into doc_edits values
  ('Вира — маркетинг менежер (',
   E'- Пост бодох ажлаас таныг чөлөөлнө: сар бүр 3 богино видео, 8 пост, сурталчилгаа (boost) удирдлага.\n- Багцад мөн контент төлөвлөгөө, 7 хоног тутмын тайлан багтана. Сурталчилгааны төсөв ороогүй.',
   E'- Пост бодох ажлаас таныг чөлөөлнө: сарын контент төлөвлөгөөний дагуу видео, постыг таны хүссэнээр бэлтгэж, сурталчилгаа (boost)-г удирдана.\n- Видео, постын тоо тогтмол биш: сар бүрийн төлөвлөгөөгөөр тохирно.\n- Багцад мөн 7 хоног тутмын тайлан багтана. Сурталчилгааны төсөв ороогүй.'),
  ('Ора — хувийн туслах (',
   '- Сард 1,500 мессеж багтана. Хэрэглэгч бүр өөрийн 1,500 мессежтэй; нэмэлт хэрэглэгч бүр сар бүр тусдаа төлбөртэй. Нэмэлт 500 мессежийн багц тусдаа төлбөртэй.',
   E'- Сар бүрийн ашиглалтын эрх хувиар харагдана: 100% нь өдөрт ойролцоогоор 50 энгийн асуулттай тэнцэнэ. Мэргэн болон том файл илүү их хувь зарцуулна.\n- Хэрэглэгч бүр өөрийн эрхтэй; нэмэлт хэрэглэгч бүр сар бүр тусдаа төлбөртэй.\n- Эрх дуусвал нэмэлт +25% ашиглалтын багц авч болно, тусдаа төлбөртэй.');

update knowledge_documents k
   set body = replace(k.body, normalize(e.old_line, NFC), normalize(e.new_line, NFC)),
       source = 'founder 2026-10-01', updated_at = now()
  from dt, doc_edits e
 where k.tenant_id = dt.id and starts_with(k.title, normalize(e.title_prefix, NFC))
   and position(normalize(e.old_line, NFC) in k.body) > 0;

-- ---------------------------------------------------------------- refuse a partial write

do $$
declare n int;
begin
  select count(*) into n from service_variants v join services s on s.id = v.service_id join tenants t on t.id = v.tenant_id
   where t.slug = 'dalatech' and s.name = normalize('Вира — маркетинг менежер', NFC)
     and v.variant_key = normalize('Сарын төлбөр', NFC) and v.price_min = 250000;
  if n <> 1 then raise exception 'Вира''s month is not 250,000 on exactly one row (%)', n; end if;
  select count(*) into n from service_variants v join services s on s.id = v.service_id join tenants t on t.id = v.tenant_id
   where t.slug = 'dalatech' and s.name = normalize('Ора — хувийн туслах', NFC)
     and v.variant_key = normalize('Нэмэлт ашиглалтын багц', NFC) and v.price_min = 49000;
  if n <> 1 then raise exception 'Ора''s pack row was not relabelled (%)', n; end if;
  select count(*) into n from service_variants v join tenants t on t.id = v.tenant_id where t.slug = 'dalatech';
  if n <> 18 then raise exception 'expected 18 DalaTech price rows, found %', n; end if;
  if exists (select 1 from service_variants v join tenants t on t.id = v.tenant_id
              where t.slug = 'dalatech' and (v.price_min = 350000 or v.variant_key like '%мессеж%')) then
    raise exception 'an old figure or label is still on a DalaTech price row';
  end if;
  -- Four documents edited (each role in both launch states); no old fact left anywhere.
  select count(*) into n from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'dalatech' and k.source = 'founder 2026-10-01';
  if n <> 4 then raise exception 'expected 4 edited documents, found %', n; end if;
  if exists (select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
              where t.slug = 'dalatech' and (k.body like '%1,500%' or k.body like '%500 мессеж%'
                                             or k.body like '%8 пост%' or k.body like '%3 богино видео%')) then
    raise exception 'a document still carries an old count';
  end if;
  if exists (select 1 from faqs f join tenants t on t.id = f.tenant_id
              where t.slug = 'dalatech' and (f.answer like '%1,500%' or f.answer like '%350,000%' or f.answer like '%8 пост%'))
     or exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
              where t.slug = 'dalatech' and (d.body like '%1,500%' or d.body like '%350,000%' or d.body like '%8 пост%')) then
    raise exception 'an FAQ or fixed reply carries an old figure';
  end if;
  if exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
              where t.slug = 'dalatech' and r.active
                and (coalesce(r.expected_body, '') like '%350,000%' or '350,000' = any(r.must_include))) then
    raise exception 'an active case still expects 350,000';
  end if;
end $$;

-- Read back.
select s.name, v.variant_key, v.price_min from service_variants v join services s on s.id = v.service_id
  join tenants t on t.id = v.tenant_id where t.slug = 'dalatech' and s.name ~ '^(Вира|Ора)' order by 1, 3 desc;

commit;
