-- DalaTech (tenant #0): the price change the founder approved on 2026-09-27 (D-148).
--
-- The figures are the founder's. Every Mongolian line below is a DRAFT until the founder
-- signs it (CLAUDE.md, "Customer-visible Mongolian"); run this file only after that, and
-- with the wording exactly as signed.
--
--   Setup fee: 50,000₮ for every AI staff member (Дали was 150,000₮).
--   Дали 250,000₮/сар (Facebook, Instagram and the client's own website on one plan).
--   Нова 150,000₮/сар, 1,000 SMS included, 50₮ per extra SMS.
--   Вира 350,000₮/сар. Ора 250,000₮/сар, 1,500 messages; extra 500 messages 49,000₮;
--   extra users 200,000₮ / 175,000₮ / 150,000₮. Эхо: no price yet.
--   Website 750,000₮ one-time; hosting 150,000₮/year; QPay +200,000₮; online booking +300,000₮.
--   Website + Дали bundle 800,000₮ = website + Дали setup + Дали's first month at 50%.
--   Annual prepay: 10 months buys 12. Multi-staff: 2 → 10%, 3 → 15%, 4+ → 20%. No stacking.
--   Minimum contract 3 months. No VAT (DalaTech is not VAT-registered).
--
-- Where each part lands, and when a customer sees it:
--   1. service_variants — the only place a price is a number (D-075). Read per request:
--      live on commit.
--   2. deterministic_replies.price_overview — the 💬/🌐/🎁/⏳ answer. Live on commit.
--   3. reply_cases — the cases that quote the overview or a changed figure.
--   4. faqs and knowledge_documents — counts, conditions and discounts, never a ₮ figure
--      (a figure in the prompt is a permission, D-075). These reach customers at the next
--      PUBLISH (`scripts/publish/tenant.ts`), which the founder runs.
--
-- Вира's knowledge document is NOT changed here: the plan the founder listed (videos,
-- posts, boost management) is a marketing role, and every row still calls Вира
-- «Бизнес аналитик». That is a question for the founder, not a line to guess.
begin;

create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
do $$ begin
  if (select count(*) from dt) <> 1 then raise exception 'tenant dalatech not found exactly once'; end if;
end $$;

-- ---------------------------------------------------------------- 1. price rows

create temp table svc on commit drop as
select s.id, s.name from services s join dt on dt.id = s.tenant_id;

-- Setup fee: 50,000₮ for every staff member that has one.
update service_variants v set price_min = 50000, confirmed_at = now()
  from svc where v.service_id = svc.id
   and v.variant_key = normalize('Нэг удаагийн суурилуулалт', NFC)
   and svc.name in (normalize('Дали — AI хүлээн авагч', NFC), normalize('Вира — Бизнес аналитик', NFC),
                    normalize('Нова — Харилцагчийн менежер', NFC), normalize('Ора — Хувийн туслах', NFC));

-- Monthly fees.
update service_variants v set price_min = x.amount, confirmed_at = now()
  from svc, (values ('Дали — AI хүлээн авагч', 250000), ('Вира — Бизнес аналитик', 350000),
                    ('Нова — Харилцагчийн менежер', 150000), ('Ора — Хувийн туслах', 250000)) x(name, amount)
 where v.service_id = svc.id and svc.name = normalize(x.name, NFC)
   and v.variant_key = normalize('Сарын төлбөр', NFC);

-- Эхо has no price yet: no row, so no figure can be served for it (the price path answers
-- `no_variant` and the turn falls through; the knowledge document says it is not announced).
delete from service_variants v using svc
 where v.service_id = svc.id and svc.name = normalize('Эхо — Утасны оператор', NFC);

-- The website's one-time price gets a label, so it sits under the same 💬 header as its extras.
update service_variants v set variant_key = normalize('Нэг удаагийн төлбөр', NFC), price_min = 750000, confirmed_at = now()
  from svc where v.service_id = svc.id and svc.name = normalize('Ухаалаг вэбсайт', NFC) and v.variant_key = '';

update service_variants v set price_min = 800000, confirmed_at = now()
  from svc where v.service_id = svc.id and svc.name = normalize('Вэбсайт + Дали багц', NFC) and v.variant_key = '';

-- New priced options. Labels carry no digits: a count lives in the knowledge document, so
-- the only number on a served row is its price.
insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min, confirmed_at)
select dt.id, svc.id, normalize(x.label, NFC), 'exact', x.amount, now()
  from dt, svc, (values
    ('Нова — Харилцагчийн менежер', 'Нэмэлт SMS тутам', 50),
    ('Ора — Хувийн туслах', 'Нэмэлт мессежийн багц', 49000),
    ('Ора — Хувийн туслах', 'Нэмэлт хэрэглэгч, эхнийх', 200000),
    ('Ора — Хувийн туслах', 'Нэмэлт хэрэглэгч, хоёр дахь', 175000),
    ('Ора — Хувийн туслах', 'Нэмэлт хэрэглэгч, гурав дахь', 150000),
    ('Ухаалаг вэбсайт', 'Хостинг, жилд', 150000),
    ('Ухаалаг вэбсайт', 'QPay холболт', 200000),
    ('Ухаалаг вэбсайт', 'Онлайн цаг захиалга', 300000)
  ) x(name, label, amount)
 where svc.name = normalize(x.name, NFC);

-- «хостинг хэд вэ» should reach the website's rows.
insert into service_aliases (tenant_id, service_id, alias, provenance)
select dt.id, svc.id, normalize(a, NFC), 'tenant_confirmed'
  from dt, svc, unnest(array['хостинг', 'hosting']) a
 where svc.name = normalize('Ухаалаг вэбсайт', NFC)
   and not exists (select 1 from service_aliases x where x.service_id = svc.id and x.alias = normalize(a, NFC));

-- ---------------------------------------------------------------- 2. the price overview

create temp table ov on commit drop as
select d.body as old_body,
       normalize(E'💬 Дали — AI хүлээн авагч: сард 250,000₮ (суурилуулалт 50,000₮)\n🌐 Ухаалаг вэбсайт: 750,000₮\n🎁 Вэбсайт + Дали багц: 800,000₮\n⏳ Удахгүй: Вира сард 350,000₮, Нова сард 150,000₮, Ора сард 250,000₮, Эхо — урьдчилан бүртгэл авч байна', NFC) as new_body
  from deterministic_replies d join dt on dt.id = d.tenant_id where d.intent = 'price_overview';

-- ---------------------------------------------------------------- 3. reply cases

update reply_cases r set expected_body = replace(r.expected_body, ov.old_body, ov.new_body)
  from dt, ov where r.tenant_id = dt.id and r.active and position(ov.old_body in r.expected_body) = 1;

update deterministic_replies d set body = ov.new_body
  from dt, ov where d.tenant_id = dt.id and d.intent = 'price_overview';

-- One staff member's price: Дали's setup is 50,000₮ now, Вира's month 350,000₮.
update reply_cases r set must_include = array_replace(r.must_include, '150,000', '50,000'),
       note = r.note || ' Setup 50,000₮ from 2026-09-27 (D-148).'
  from dt where r.tenant_id = dt.id and r.active and r.customer_message = normalize('Далигийн үнэ хэд вэ?', NFC)
   and '150,000' = any(r.must_include);
update reply_cases r set must_include = array_replace(r.must_include, '150,000', '350,000'),
       note = r.note || ' Вира 350,000₮/сар from 2026-09-27 (D-148).'
  from dt where r.tenant_id = dt.id and r.active and r.customer_message = normalize('Вирагийн үнэ хэд вэ?', NFC)
   and '150,000' = any(r.must_include);
update reply_cases r set note = replace(r.note, '(setup 150,000₮ may follow)', '(setup 50,000₮ may follow)')
  from dt where r.tenant_id = dt.id and r.note like '%(setup 150,000₮ may follow)%';

-- New cases for the new facts (model cases: they run only with --with-model).
insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active)
select dt.id, 'facebook_page', normalize(x.q, NFC), null, x.inc, x.nots, x.note, true
  from dt, (values
    ('Хостинг хэд вэ?', array['150,000'], array['750,000₮/сар'], 'D-148: hosting 150,000₮ a year.'),
    ('Жилээр төлбөл хямдрах уу?', array['10 сар', '12 сар'], array[]::text[], 'D-148: annual prepay, 10 months buys 12.'),
    ('НӨАТ орсон уу?', array['НӨАТ'], array[]::text[], 'D-148: prices carry no VAT; DalaTech is not VAT-registered.'),
    ('Гэрээ хамгийн багадаа хэдэн сар вэ?', array['3 сар'], array[]::text[], 'D-148: minimum contract 3 months.'),
    ('Эхогийн үнэ хэд вэ?', array['урьдчилан'], array['250,000', '200,000', '150,000'], 'D-148: Эхо has no price yet; never an old figure.')
  ) x(q, inc, nots, note);

-- ---------------------------------------------------------------- 4. faqs and documents

update faqs f set answer = normalize('Хоёр ажилтан −10%, гурав −15%, дөрөв ба түүнээс дээш −20%. Хөнгөлөлт сарын төлбөрт хамаарна. Хөнгөлөлтүүд хоорондоо нэмэгдэхгүй.', NFC),
       provenance = 'tenant_confirmed'
  from dt where f.tenant_id = dt.id and f.question = normalize('Багийн хөнгөлөлт байдаг уу?', NFC);

update faqs f set answer = normalize('Вэбсайт: гэрээ байгуулахад 50%, хүлээлгэн өгөхөд 50%; хостинг жил бүр. AI ажилтан: суурилуулалт нэг удаа, сарын төлбөр сар бүрийн эхэнд.', NFC),
       provenance = 'tenant_confirmed'
  from dt where f.tenant_id = dt.id and f.question = normalize('Төлбөрийн нөхцөл ямар вэ?', NFC);

insert into faqs (tenant_id, question, answer, ordinal, provenance)
select dt.id, normalize(x.q, NFC), normalize(x.a, NFC), x.o, 'tenant_confirmed'
  from dt, (values
    ('Жилээр төлбөл хөнгөлөлттэй юу?', 'Тийм. Жилийн төлбөрөө урьдчилж төлбөл 10 сарын төлбөрөөр 12 сар ажиллуулна. Бусад хөнгөлөлттэй нэмэгдэхгүй.', 20),
    ('Гэрээний доод хугацаа хэд вэ?', 'Гэрээний доод хугацаа 3 сар.', 21),
    ('Үнэд НӨАТ орсон уу?', 'Манай үнэд НӨАТ нэмэгдэхгүй: DalaTech НӨАТ төлөгчөөр бүртгэлгүй.', 22)
  ) x(q, a, o)
 where not exists (select 1 from faqs f where f.tenant_id = dt.id and f.question = normalize(x.q, NFC));

create temp table doc_edits (title text, old_line text, new_line text) on commit drop;
insert into doc_edits values
  ('Бүтээгдэхүүн: вэбсайт',
   '- Вэбсайт + Дали багцаар авах боломжтой.',
   E'- Хостинг жил бүр тусдаа төлбөртэй. QPay төлбөр, онлайн цаг захиалгыг нэмэлт төлбөрөөр суулгана.\n- Вэбсайт + Дали багцад вэбсайт, Далигийн суурилуулалт, Далигийн эхний сарын төлбөрийн 50% хөнгөлөлт багтана. Хоёр дахь сараас Далигийн сарын төлбөр бүтэн.'),
  ('Дали — AI хүлээн авагч (ИДЭВХТЭЙ, одоо ажиллаж байна)',
   '- Захиалга, цаг товлолтыг бүртгэнэ. Шөнө ирсэн зурваст ч хариулна.',
   E'- Захиалга, цаг товлолтыг бүртгэнэ. Шөнө ирсэн зурваст ч хариулна.\n- Танай вэбсайтад ч ажиллана: Facebook, Instagram, вэбсайт нэг л төлбөрт багтана.'),
  ('Нова — Харилцагчийн менежер (УДАХГҮЙ, урьдчилан бүртгэл авч байна)',
   '- Ирэхээ больсон харилцагчийг эргүүлэн дуудна.',
   E'- Ирэхээ больсон харилцагчийг эргүүлэн дуудна.\n- Сарын төлбөрт 1,000 SMS багтана; түүнээс илүү SMS тус бүр нэмэлт төлбөртэй.'),
  ('Ора — Хувийн туслах (УДАХГҮЙ, урьдчилан бүртгэл авч байна)',
   '- Мессенжер биш, зөвхөн танд нээгддэг чатаар ажиллана.',
   E'- Мессенжер биш, зөвхөн танд нээгддэг чатаар ажиллана.\n- Сард 1,500 мессеж багтана. Нэмэлт 500 мессежийн багц, нэмэлт хэрэглэгч тусдаа төлбөртэй.'),
  ('Эхо — Утасны оператор (УДАХГҮЙ, урьдчилан бүртгэл авч байна)',
   '- Минутын үнийг хараахан зарлаагүй.',
   '- Үнийг хараахан зарлаагүй.');

update knowledge_documents k
   set body = replace(k.body, normalize(e.old_line, NFC), normalize(e.new_line, NFC)),
       source = 'founder 2026-09-27', updated_at = now()
  from dt, doc_edits e
 where k.tenant_id = dt.id and k.title = normalize(e.title, NFC);

insert into knowledge_documents (tenant_id, title, body, source)
select dt.id, normalize('Үнийн нөхцөл', NFC), normalize(E'- Жилийн төлбөрөө урьдчилж төлбөл 10 сарын төлбөрөөр 12 сар ажиллуулна.\n- Олон ажилтны хөнгөлөлт: 2 ажилтан 10%, 3 ажилтан 15%, 4 ба түүнээс дээш 20%.\n- Хөнгөлөлтүүд хоорондоо нэмэгдэхгүй.\n- Гэрээний доод хугацаа 3 сар.\n- Суурилуулалтын төлбөр AI ажилтан бүрт ижил.\n- Манай үнэд НӨАТ нэмэгдэхгүй: DalaTech НӨАТ төлөгчөөр бүртгэлгүй.', NFC), 'founder 2026-09-27'
  from dt
 where not exists (select 1 from knowledge_documents k where k.tenant_id = dt.id and k.title = normalize('Үнийн нөхцөл', NFC));

-- ---------------------------------------------------------------- refuse a partial write

do $$
declare n int;
begin
  -- Exactly the approved figures, and nothing else, on every variant.
  select count(*) into n from service_variants v join tenants t on t.id = v.tenant_id
   where t.slug = 'dalatech' and v.variant_key = normalize('Нэг удаагийн суурилуулалт', NFC) and v.price_min <> 50000;
  if n <> 0 then raise exception 'a setup fee is not 50,000'; end if;
  select count(*) into n from service_variants v join tenants t on t.id = v.tenant_id
   where t.slug = 'dalatech' and v.variant_key = normalize('Нэг удаагийн суурилуулалт', NFC);
  if n <> 4 then raise exception 'expected 4 setup rows (Дали, Вира, Нова, Ора), found %', n; end if;
  select count(*) into n from service_variants v join services s on s.id = v.service_id
   where s.name = normalize('Эхо — Утасны оператор', NFC);
  if n <> 0 then raise exception 'Эхо still has a price row'; end if;
  select count(*) into n from service_variants v join tenants t on t.id = v.tenant_id
   where t.slug = 'dalatech' and v.confirmed_at is null;
  if n <> 0 then raise exception '% unconfirmed DalaTech price rows', n; end if;
  select count(*) into n from service_variants v join tenants t on t.id = v.tenant_id where t.slug = 'dalatech';
  if n <> 18 then raise exception 'expected 18 DalaTech price rows, found %', n; end if;
  -- The overview changed, and no active case still quotes the old one.
  if exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
              where t.slug = 'dalatech' and r.active and r.expected_body like '%суурилуулалт 150,000₮%') then
    raise exception 'an active case still quotes the 150,000₮ setup fee';
  end if;
  if not exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
                  where t.slug = 'dalatech' and d.intent = 'price_overview' and d.body like '%суурилуулалт 50,000₮%') then
    raise exception 'price_overview was not updated';
  end if;
  -- Every document edit found its line; the old ones are gone.
  select count(*) into n from doc_edits e
   where (select count(*) from knowledge_documents k join tenants t on t.id = k.tenant_id
           where t.slug = 'dalatech' and k.title = normalize(e.title, NFC)
             and position(normalize(e.new_line, NFC) in k.body) > 0) <> 1;
  if n <> 0 then raise exception '% document edits did not find their line', n; end if;
  if not exists (select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
                  where t.slug = 'dalatech' and k.title = normalize('Үнийн нөхцөл', NFC)) then
    raise exception 'Үнийн нөхцөл was not written';
  end if;
end $$;

-- Read back.
select s.name, v.variant_key, v.price_min from service_variants v join services s on s.id = v.service_id
  join tenants t on t.id = v.tenant_id where t.slug = 'dalatech' order by 1, 3 desc;

commit;
