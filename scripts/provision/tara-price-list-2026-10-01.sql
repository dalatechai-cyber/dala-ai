-- NOT APPLIED. Tara Salon — Яармаг (slug matrix-eco-salon): the price list of 2026-10-01, the
-- children's services, and the new phone number (D-167); the founder's decisions of the same day
-- (D-168): old services and prices gone from the knowledge, the FAQ and the reply cases, «охин»
-- for the girls' haircut, and the Messenger like answered by fixed replies.
--
-- Source of truth: the salon's price list received 2026-10-01 (5 pages, transcribed; same prices
-- for both branches) and the founder's instructions of the same day:
--   1. Every service and price comes from the price list. TARA Lumi is the price list's
--      350,000 / 460,000 / 510,000₮, not the 380,000–460,000₮ in the owner's text. The owner's
--      TARA Lumi description goes into the knowledge, without its price line (prices are served
--      from the rows only).
--   2. Children's services now exist: the `children_services` disclosure rule and its
--      `refusal_topic` line are removed. No knowledge document says children are not served.
--   3. 91005498 replaces 80905498 everywhere. 76001888 stays, and is now the shared main line of
--      both branches (config/branch-groups.json `allow_phones`).
-- No new customer-facing sentence is written here. Every body below is an approved row with only a
-- number, a price or a service name changed, the owner's own TARA Lumi text, or a row removed.
--
-- WHAT IS READ WHEN (why this file and the publish go together):
--   * services, service_variants, knowledge_documents, faqs: compiled into the prefix, so they
--     reach customers only at publish.
--   * canned_responses: read live AND hashed into the snapshot. From this commit until the
--     publish, every reply refuses as `canned_stale` (D-163). Apply this file, then run the dry
--     run and the publish straight away, at a quiet hour. If the dry run refuses, apply
--     tara-price-list-2026-10-01-revert.sql at once.
--   * deterministic_replies, contact_points, disclosure_rules, reply_cases: read live.
--
-- Services on the old list and not on the new one are switched off (active = false), never
-- deleted: nothing here drops a row the founder may want back. Their price rows stay as they were.
--
-- Run it as one transaction (Supabase SQL editor, or psql -v ON_ERROR_STOP=1 -f). It refuses,
-- and writes nothing, unless the rows are exactly what was read on 2026-10-01.
begin;

set local dala.canned_edit = 'republish';

-- ---------------------------------------------------------------------------
-- 0. Preconditions: the rows this file rewrites are the ones read on 2026-10-01.
-- ---------------------------------------------------------------------------
do $$
declare
  t uuid;
  n int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  select count(*) into n from canned_responses where tenant_id = t and body like '%80905498%';
  if n <> 6 then raise exception 'expected 6 canned rows carrying 80905498, found %', n; end if;
  select count(*) into n from deterministic_replies where tenant_id = t and body like '%80905498%';
  if n <> 1 then raise exception 'expected 1 fixed reply carrying 80905498 (salon_phone), found %', n; end if;
  if not exists (select 1 from contact_points where tenant_id = t and kind = 'phone' and value = '76001888, 80905498') then
    raise exception 'contact_points phone is not «76001888, 80905498»';
  end if;
  if not exists (select 1 from disclosure_rules where tenant_id = t and topic_key = 'children_services') then
    raise exception 'children_services rule not found';
  end if;
  if exists (select 1 from service_variants where tenant_id = t and refusal_topic = 'children_services') then
    raise exception 'a price row still points at children_services';
  end if;
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'refusal_topic'
                 and body = 'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу.') then
    raise exception 'refusal_topic line is not the children line read on 2026-10-01';
  end if;
  -- Another rule of this tenant needing the refusal_topic line would refuse every reply once it
  -- is gone (kindsRequiredByRules).
  select count(*) into n from (
    select response_kind from disclosure_rules where tenant_id = t and topic_key <> 'children_services'
    union all select response_kind from out_of_scope_topics where tenant_id = t) r
   where r.response_kind = 'refusal_topic';
  if n <> 0 then raise exception '% other rule(s) still use refusal_topic', n; end if;
  -- The price-row swap below deletes variants; per-branch prices would cascade with them.
  if exists (select 1 from branch_variant_prices where tenant_id = t) then
    raise exception 'branch_variant_prices rows exist for this tenant; the revert could not restore them';
  end if;
  -- D-168: the documents and the FAQ this file rewrites are the ones read on 2026-10-01.
  select count(*) into n from knowledge_documents where tenant_id = t
     and (title in ('Сор, Оффис колор, омбре', 'CICA ба CMC — эмчилгээ, хими биш')
          or (title = 'Химийн үйлчилгээний төрлүүд' and body like '%Шулуун хими (сеттинг) нь%'));
  if n <> 3 then raise exception 'expected the 3 knowledge documents read on 2026-10-01, found %', n; end if;
  if not exists (select 1 from faqs where tenant_id = t and question = 'CICA нэг удаагийн эмчилгээ хэдэн тэжээлийн тостой тэнцэх вэ?') then
    raise exception 'the CICA / тэжээлийн тос FAQ is not there';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'greeting' and enabled
                 and body = 'Сайн байна уу! Tara Salon-д тавтай морил. Танд юугаар туслах вэ?') then
    raise exception 'the welcome row (greeting) is not the approved line read on 2026-10-01';
  end if;
  if exists (select 1 from deterministic_replies where tenant_id = t and intent = 'like_welcome') then
    raise exception 'like_welcome already present';
  end if;
  if exists (select 1 from knowledge_documents where tenant_id = t and title = 'TARA Lumi – үүсгэлттэй будалт') then
    raise exception 'TARA Lumi document already present: this file has been applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Phones: 91005498 replaces 80905498. 76001888 is unchanged.
-- ---------------------------------------------------------------------------
-- Six approved canned lines (handoff, refusal_no_promotion, refusal_price_unlisted,
-- refusal_staff_schedule, refusal_suitability, refusal_topic); refusal_topic is deleted in §2.
-- Re-signed in the same statement (0075): the founder approved the number change 2026-10-01.
update canned_responses c
   set body = replace(c.body, '80905498', '91005498'), reviewed_by = 'founder', reviewed_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.body like '%80905498%'
   and c.kind <> 'refusal_topic';

update deterministic_replies d
   set body = replace(d.body, '80905498', '91005498')
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'salon_phone';

update contact_points c
   set value = '76001888, 91005498'
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'phone';

-- holiday_hours_note carries 76001888 only, the shared line: unchanged.

update reply_cases r
   set expected_body = 'Та 76001888 эсвэл 91005498 дугаараар холбогдоно уу.'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message = 'Утас хэд вэ';

-- ---------------------------------------------------------------------------
-- 2. Children's services exist: the rule and its line go.
-- ---------------------------------------------------------------------------
delete from disclosure_rules d using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.topic_key = 'children_services';

delete from canned_responses c using tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'refusal_topic';

-- A model case, so the dry run with --with-model shows whether Дали now quotes a child's price.
-- Ш1's signed salon example still says a children's price is never quoted (a founder draft to
-- change it is in prompt/drafts/sh1_refusal_topics_children.salon.mn.txt); this case is how
-- that risk is measured, not assumed.
insert into reply_cases (tenant_id, customer_message, must_include, note)
select t.id, '8 настай хүүгийн үс тайралт хэд вэ?', array['33,000']::text[],
       'D-167 (founder 2026-10-01): children''s services exist; a boy of 8 is «Хүүхдийн тайралт (эрэгтэй, 0–13 нас)», 33,000₮'
  from tenants t
 where t.slug = 'matrix-eco-salon';

-- ---------------------------------------------------------------------------
-- 3. The price list.
-- ---------------------------------------------------------------------------
-- 3a. Off the list: switched off, rows kept.
update services s
   set active = false
  from tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id
   and s.name in ('Сахал засах', 'Тэжээлийн тос', 'Угаалт', 'Үс хусах', 'Дунд үсний будаг', 'Урт үсний будаг',
                  'Омбре', 'Оффис колор', 'Сор', 'Цайруулалт', 'CMC тэжээл', 'Хими арчилт',
                  'Тэжээл', 'CICA нөхөн сэргээх эмчилгээ');

-- 3b. On the list: every service, created where new, switched on.
--     Gender, hair length, stylist level and age are price rows (variant_key), as the old list did
--     with «Мастер» / «1-р зэрэг»; a service the list gives for men only says so in its row.
insert into services (tenant_id, name, category, unit, active, launch_state)
select t.id, v.name, v.category, 'service', true, 'live'
  from tenants t,
       (values
         ('Эмэгтэй тайралт', 'Тайралт ба засалт'),
         ('Эрэгтэй тайралт', 'Тайралт ба засалт'),
         ('Хүүхдийн тайралт', 'Тайралт ба засалт'),
         ('Чёлк тайралт', 'Тайралт ба засалт'),
         ('Хэлбэржүүлэлт', 'Тайралт ба засалт'),
         ('Гоёлын засалт', 'Тайралт ба засалт'),
         ('Хуримын засалт', 'Тайралт ба засалт'),
         ('Бүтэн будалт', 'Үс будалт'),
         ('Энгийн будаг', 'Үс будалт'),
         ('Өнгөлөгч будаг', 'Үс будалт'),
         ('TARA Lumi', 'Үс будалт'),
         ('TARA BLEND', 'Үс будалт'),
         ('Хэсэгчилсэн сор', 'Үс будалт'),
         ('Бүтэн сор', 'Үс будалт'),
         ('Үсний угийн будаг', 'Үс будалт'),
         ('Бүтэн цайруулалт', 'Үс будалт'),
         ('Tara perm', 'Химийн үйлчилгээ'),
         ('Усан хими', 'Химийн үйлчилгээ'),
         ('Афро хими', 'Химийн үйлчилгээ'),
         ('Hippie & Jerry curl', 'Химийн үйлчилгээ'),
         ('Сэттинг хими', 'Химийн үйлчилгээ'),
         ('Шулуун хими', 'Химийн үйлчилгээ'),
         ('Эмчилгээний хими', 'Химийн үйлчилгээ'),
         ('Down perm', 'Химийн үйлчилгээ'),
         ('Хуйх цэвэрлэгээ', 'Эмчилгээ'),
         ('Үс оношлогоо, зөвлөгөө', 'Эмчилгээ'),
         ('Нөхөн сэргээх эмчилгээ', 'Эмчилгээ'),
         ('Үсний тэжээл', 'Эмчилгээ'),
         ('Үсний спа', 'Эмчилгээ'),
         ('CICA үсний гүний эмчилгээ', 'Эмчилгээ'),
         ('Эмчилгээний будаг', 'Эмчилгээ')
       ) as v(name, category)
 where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, name) do update set active = true, category = excluded.category;

-- 3c. Their price rows: the old ones are replaced by the list's.
create temp table tara_prices (service text, variant text, price numeric) on commit drop;
insert into tara_prices values
  -- 1. Эмэгтэй засалт
  ('Эмэгтэй тайралт', 'SPECIAL', 120000),
  ('Эмэгтэй тайралт', 'Мастер', 99000),
  ('Эмэгтэй тайралт', '1-р зэрэг', 66000),
  ('Хүүхдийн тайралт', 'охин', 44000),  -- «Тайралт хүүхэд» in the women's section: girls (founder, D-168)
  ('Чёлк тайралт', '', 22000),
  ('Хэлбэржүүлэлт', 'өдөр тутмын', 44000),
  ('Хэлбэржүүлэлт', 'гоёлын', 60000),
  ('Гоёлын засалт', 'бүтэн', 99000),
  ('Гоёлын засалт', 'хагас', 75000),
  ('Хуримын засалт', '', 180000),
  ('Гоёлын засалт', 'эрэгтэй', 33000),
  -- 2. Эрэгтэй засалт
  ('Эрэгтэй тайралт', 'SPECIAL', 89000),
  ('Эрэгтэй тайралт', '', 69000),
  ('Хүүхдийн тайралт', 'эрэгтэй, 14–18 нас', 44000),
  ('Хүүхдийн тайралт', 'эрэгтэй, 0–13 нас', 33000),
  ('Бүтэн будалт', 'эрэгтэй', 88000),
  ('Эмчилгээний хими', 'эрэгтэй', 189000),
  ('Down perm', 'эрэгтэй', 125000),
  ('Бүтэн цайруулалт', 'эрэгтэй', 450000),
  ('Хэсэгчилсэн сор', 'эрэгтэй', 195000),
  -- Хуйх(ны) цэвэрлэгээ 33,000 and Нөхөн сэргээх эмчилгээ 66,000 are in §2 and §3 alike.
  -- 3. Үйлчилгээ
  ('Хуйх цэвэрлэгээ', '', 33000),
  ('Үс оношлогоо, зөвлөгөө', '', 33000),
  ('Нөхөн сэргээх эмчилгээ', '', 66000),
  ('Үсний тэжээл', '', 88000),
  ('Үсний спа', '', 154000),
  ('CICA үсний гүний эмчилгээ', '', 198000),
  ('Эмчилгээний будаг', '', 88000),
  -- 4. Эмэгтэй хими
  ('Tara perm', 'богино', 220000), ('Tara perm', 'дунд', 250000), ('Tara perm', 'урт', 290000),
  ('Усан хими', 'богино', 120000), ('Усан хими', 'дунд', 160000), ('Усан хими', 'урт', 200000),
  ('Афро хими', 'богино', 450000), ('Афро хими', 'дунд', 500000), ('Афро хими', 'урт', 550000),
  ('Hippie & Jerry curl', 'богино', 450000), ('Hippie & Jerry curl', 'дунд', 500000), ('Hippie & Jerry curl', 'урт', 550000),
  ('Сэттинг хими', 'богино', 450000), ('Сэттинг хими', 'дунд', 500000), ('Сэттинг хими', 'урт', 550000),
  ('Шулуун хими', 'богино', 450000), ('Шулуун хими', 'дунд', 500000), ('Шулуун хими', 'урт', 550000),
  -- 5. Эмэгтэй будаг
  ('Энгийн будаг', 'богино', 160000), ('Энгийн будаг', 'дунд', 180000), ('Энгийн будаг', 'урт', 210000),
  ('Өнгөлөгч будаг', 'богино', 160000), ('Өнгөлөгч будаг', 'дунд', 180000), ('Өнгөлөгч будаг', 'урт', 210000),
  ('TARA Lumi', 'богино', 350000), ('TARA Lumi', 'дунд', 460000), ('TARA Lumi', 'урт', 510000),
  ('TARA BLEND', 'богино', 550000), ('TARA BLEND', 'дунд', 630000), ('TARA BLEND', 'урт', 720000),
  ('Хэсэгчилсэн сор', 'эмэгтэй', 150000),
  ('Бүтэн сор', '', 210000),
  ('Үсний угийн будаг', '', 99000);

delete from service_variants v
 using services s, tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and v.service_id = s.id
   and s.name in (select service from tara_prices);

insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min, price_max, confirmed_at)
select t.id, s.id, p.variant, 'exact', p.price, null, now()
  from tara_prices p
  join tenants t on t.slug = 'matrix-eco-salon'
  join services s on s.tenant_id = t.id and s.name = p.service;

-- 3d. Fixed replies that quote the price rows by service name (composeQuoted refuses to answer
--     when a named service is missing, so they follow the list).
update deterministic_replies d
   set quote_services = array['Энгийн будаг', 'Үсний угийн будаг']::text[]
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'dye_prices';

update deterministic_replies d
   set quote_services = array['Tara perm', 'Усан хими', 'Афро хими', 'Hippie & Jerry curl', 'Сэттинг хими', 'Шулуун хими', 'Эмчилгээний хими']::text[]
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'perm_types';

-- The two «usnii himi» cases expect perm_types' answer, which is the rows above then its question.
update reply_cases r
   set expected_body = 'Tara perm (богино): 220,000₮
Tara perm (дунд): 250,000₮
Tara perm (урт): 290,000₮
Усан хими (богино): 120,000₮
Усан хими (дунд): 160,000₮
Усан хими (урт): 200,000₮
Афро хими (богино): 450,000₮
Афро хими (дунд): 500,000₮
Афро хими (урт): 550,000₮
Hippie & Jerry curl (богино): 450,000₮
Hippie & Jerry curl (дунд): 500,000₮
Hippie & Jerry curl (урт): 550,000₮
Сэттинг хими (богино): 450,000₮
Сэттинг хими (дунд): 500,000₮
Сэттинг хими (урт): 550,000₮
Шулуун хими (богино): 450,000₮
Шулуун хими (дунд): 500,000₮
Шулуун хими (урт): 550,000₮
Эмчилгээний хими (эрэгтэй): 189,000₮

Та аль химийг хийлгэх вэ?'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message in ('usnii himi', 'us bish usnii himi');

-- 3d'. Matcher words (service_aliases, read live; not customer text). Words of a switched-off
--      service move to its successor on the list; the new names get their Latin and short forms.
update service_aliases a
   set service_id = s.id
  from tenants t, services s
 where t.slug = 'matrix-eco-salon' and a.tenant_id = t.id and s.tenant_id = t.id
   and ((a.alias in ('CICA нөхөн сэргээх', 'CICA эмчилгээ', 'cica', 'цика') and s.name = 'CICA үсний гүний эмчилгээ')
     or (a.alias in ('тэжээл', 'tejeel') and s.name = 'Үсний тэжээл')
     or (a.alias in ('цайруул', 'tsairuul') and s.name = 'Бүтэн цайруулалт')
     or (a.alias in ('сор', 'sor') and s.name = 'Хэсэгчилсэн сор'));

insert into service_aliases (tenant_id, service_id, alias, provenance)
select t.id, s.id, v.alias, 'seeded'
  from tenants t
  join (values
         ('TARA Lumi', 'lumi'), ('TARA Lumi', 'луми'),
         ('TARA BLEND', 'blend'), ('TARA BLEND', 'бленд'),
         ('Tara perm', 'тара перм'),
         ('Hippie & Jerry curl', 'hippie'), ('Hippie & Jerry curl', 'jerry curl'),
         ('Сэттинг хими', 'сеттинг'), ('Сэттинг хими', 'сэттинг'), ('Сэттинг хими', 'setting'),
         ('Хүүхдийн тайралт', 'хүүхэд'), ('Хүүхдийн тайралт', 'хүүхд'), ('Хүүхдийн тайралт', 'huuhed'), ('Хүүхдийн тайралт', 'huuhd'),
         ('Өнгөлөгч будаг', 'өнгөлөгч'),
         ('Үс оношлогоо, зөвлөгөө', 'оношлого'),
         ('Down perm', 'down perm')
       ) as v(service, alias) on true
  join services s on s.tenant_id = t.id and s.name = v.service
 where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, alias) do nothing;

-- 3e. The FAQ that typed the old treatment prices: the same answer, with the treatments that are
--     still on the list under their new names and prices (Тэжээлийн тос and CMC тэжээл are off
--     the list; the course price is gone).
update faqs f
   set answer = 'Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна:
CICA үсний гүний эмчилгээ: 198,000₮
Үсний тэжээл: 88,000₮
Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө.'
  from tenants t
 where t.slug = 'matrix-eco-salon' and f.tenant_id = t.id and f.question = 'Үс их хуурай, хугарч гэмтсэн бол юу хийлгэх вэ?';

-- ---------------------------------------------------------------------------
-- 4. TARA Lumi in the knowledge: the owner's text, without its price line.
-- ---------------------------------------------------------------------------
insert into knowledge_documents (tenant_id, title, body, source)
select t.id, 'TARA Lumi – үүсгэлттэй будалт',
'- Үсний өнгийг зөөлөн, уусалттай харагдуулна
- Нүүрний өнгө төрхөд тохируулан өнгө сонгоно
- Үндэс ургах үед огцом ялгарахгүй, арчилгаа хялбар
- Зэсэрсэн, жигд бус өнгийг илүү зөөлөн, цэвэрхэн харагдуулна
- Үсэнд хэмжээс, гэрэл сүүдэр үүсгэж илүү өтгөн, амьд харагдуулна
- Өөрт тань тохирсон өнгөний шийдлийг зөвлөгөөний дагуу сонгоно
Үсний урт, өтгөн шингэн болон өмнөх будалтын байдлаас шалтгаалан үнэ өөрчлөгдөж болно.',
       'Tara Salon, 2026-10-01, эзний тайлбар'
  from tenants t
 where t.slug = 'matrix-eco-salon';

-- ---------------------------------------------------------------------------
-- 4b. D-168: nothing Дали reads may name an old service or an old price.
-- ---------------------------------------------------------------------------
-- Оффис колор and Омбре are off the list: their document goes.
delete from knowledge_documents k using tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Сор, Оффис колор, омбре';

-- CMC, Тэжээлийн тос and the CICA course are off the list: their sentences go, nothing is added.
update knowledge_documents k
   set title = 'CICA — эмчилгээ, хими биш',
       body = 'CICA эмчилгээний хими гэсэн үйлчилгээ БАЙХГҮЙ. Эмчилгээний хими бол ургамлын гаралтай зөөлөн хими.
CICA бол тусдаа сэргээх эмчилгээ.
CICA нь үсний гэмтсэн давхаргад ажиллана.
Будалт болон мелировканд тэжээллэг найрлага ордоггүй.',
       updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'CICA ба CMC — эмчилгээ, хими биш';

-- Шулуун хими and Сэттинг хими are two services on the list, no longer one.
update knowledge_documents k
   set body = replace(k.body, 'Шулуун хими (сеттинг) нь', 'Шулуун хими нь'), updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Химийн үйлчилгээний төрлүүд';

delete from faqs f using tenants t
 where t.slug = 'matrix-eco-salon' and f.tenant_id = t.id
   and f.question = 'CICA нэг удаагийн эмчилгээ хэдэн тэжээлийн тостой тэнцэх вэ?';

-- The reply cases' recorded history carries three earlier turns with old services and prices
-- (the old FAQ answer, the old dye-price answer, two past «Усны / Усан хими» answers), which the model
-- reads when a case runs. Each becomes the same turn with today's list: the FAQ's new answer,
-- dye_prices' new rows, and the same wrong-name answer with Усан хими's new range.
create temp table tara_history_turns (old text, new text) on commit drop;
insert into tara_history_turns values
  ('Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна:
CICA нөхөн сэргээх эмчилгээ: 198,000₮ (курсээр 154,000₮)
Тэжээлийн тос: 49,500₮
CMC тэжээл: 132,000₮
Тэжээл: 44,000–88,000₮
Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө.',
   'Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна:
CICA үсний гүний эмчилгээ: 198,000₮
Үсний тэжээл: 88,000₮
Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө.'),
  ('Үсний угийн будаг: 135,000₮
Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮
Урт үсний будаг (мөр давсан урттай үс): 200,000₮

Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?',
   'Энгийн будаг (богино): 160,000₮
Энгийн будаг (дунд): 180,000₮
Энгийн будаг (урт): 210,000₮
Үсний угийн будаг: 99,000₮

Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?'),
  ('Усны хими 132,000₮–154,000₮ байна.', 'Усны хими 120,000₮–200,000₮ байна.'),
  ('Буруу ойлголоо. Усан хими 132,000₮–154,000₮ байна.', 'Буруу ойлголоо. Усан хими 120,000₮–200,000₮ байна.');

update reply_cases r
   set history = (
         select jsonb_agg(case when h.new is null then e else jsonb_set(e, '{content}', to_jsonb(h.new)) end order by x.ord)
           from jsonb_array_elements(r.history) with ordinality as x(e, ord)
           left join tara_history_turns h on h.old = x.e->>'content')
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id
   and exists (select 1 from jsonb_array_elements(r.history) e join tara_history_turns h on h.old = e->>'content');

-- ---------------------------------------------------------------------------
-- 4c. D-168: the Messenger like (src/lib/inbound/like.ts turns it into the text «👍 (like)»).
-- ---------------------------------------------------------------------------
-- First message, or the first after a day's silence (a new conversation): the welcome row's
-- own approved bytes, copied from it rather than typed again.
insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select g.tenant_id, 'like_welcome', g.body, true, 'whole_message', array['like']::text[], '{}'::text[],
       true, 'tenant_confirmed', 'replace', '{}'
  from deterministic_replies g join tenants t on t.id = g.tenant_id
 where t.slug = 'matrix-eco-salon' and g.intent = 'greeting';

-- Right after Дали's answer: the «ок / за» row.
update deterministic_replies d
   set stems = array_append(d.stems, 'like')
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'acknowledgement'
   and not ('like' = any (d.stems));

insert into reply_cases (tenant_id, customer_message, history, expected_body, note)
select t.id, '👍 (like)', '[]'::jsonb, g.body,
       'D-168 (founder 2026-10-01): a like as the first message gets the welcome line, no model'
  from tenants t join deterministic_replies g on g.tenant_id = t.id and g.intent = 'greeting'
 where t.slug = 'matrix-eco-salon';

insert into reply_cases (tenant_id, customer_message, history, expected_body, note)
select t.id, '👍 (like)',
       jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'Хаяг хаана вэ'),
                         jsonb_build_object('role', 'assistant', 'content', a.body)),
       k.body,
       'D-168 (founder 2026-10-01): a like right after Дали''s answer is «ок / за»: the acknowledgement line'
  from tenants t
  join deterministic_replies a on a.tenant_id = t.id and a.intent = 'address'
  join deterministic_replies k on k.tenant_id = t.id and k.intent = 'acknowledgement'
 where t.slug = 'matrix-eco-salon';

-- Children's prices, by the model (they run with --with-model only).
insert into reply_cases (tenant_id, customer_message, must_include, note)
select t.id, v.msg, array[v.price]::text[], v.note
  from tenants t,
       (values ('Охины үс тайралт хэд вэ?', '44,000', 'D-168: a girl''s haircut is «Хүүхдийн тайралт (охин)», 44,000₮'),
               ('15 настай хүүгийн үс тайралт хэд вэ?', '44,000', 'D-168: a boy of 15 is «Хүүхдийн тайралт (эрэгтэй, 14–18 нас)», 44,000₮')
       ) as v(msg, price, note)
 where t.slug = 'matrix-eco-salon';

-- ---------------------------------------------------------------------------
-- 5. Postconditions.
-- ---------------------------------------------------------------------------
do $$
declare
  t uuid;
  n int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  select count(*) into n from (
    select body from canned_responses where tenant_id = t
    union all select body from deterministic_replies where tenant_id = t
    union all select value from contact_points where tenant_id = t
    union all select answer from faqs where tenant_id = t
    union all select body from knowledge_documents where tenant_id = t) x
   where x.body like '%80905498%';
  if n <> 0 then raise exception '% row(s) still carry 80905498', n; end if;
  select count(*) into n from canned_responses where tenant_id = t and body like '%91005498%' and reviewed_at is not null;
  if n <> 5 then raise exception 'expected 5 signed canned rows with 91005498, found %', n; end if;
  select count(*) into n from service_variants v join services s on s.id = v.service_id
   where s.tenant_id = t and s.active;
  if n <> 60 then raise exception 'expected 60 price rows on active services, found %', n; end if;
  select count(*) into n from services where tenant_id = t and active;
  if n <> 31 then raise exception 'expected 31 active services, found %', n; end if;
  -- Nothing Дали reads names an old service or carries an old price (D-168).
  select count(*) into n from (
    select body as x from knowledge_documents where tenant_id = t
    union all select title from knowledge_documents where tenant_id = t
    union all select question || ' ' || answer from faqs where tenant_id = t
    union all select body from deterministic_replies where tenant_id = t and enabled
    union all select body from canned_responses where tenant_id = t
    union all select history::text || customer_message || coalesce(expected_body, '') from reply_cases where tenant_id = t and active) y
   where y.x ~ '(Оффис|Офис|Омбре|CMC|Тэжээлийн тос|Хими арчилт|Угаалт|Сахал засах|Үс хусах|сеттинг|курс|49,500|132,000|154,000₮–|176,000|135,000)';
  if n <> 0 then raise exception '% row(s) Дали reads still name an old service or price', n; end if;
  if (select count(*) from reply_cases where tenant_id = t and history::text like '%CICA үсний гүний эмчилгээ: 198,000₮%') <> 4 then
    raise exception 'expected the 4 reply-case histories to carry the new FAQ answer';
  end if;
  if exists (select 1 from service_variants v join services s on s.id = v.service_id
              where s.tenant_id = t and s.active and v.confirmed_at is null) then
    raise exception 'an active price row is unconfirmed';
  end if;
end $$;

commit;

-- Then, at once (scripts/publish/tenant.ts; see docs/tenants/tara-yarmag.md):
--   dry run:  node scripts/publish/tenant.ts --slug matrix-eco-salon --with-model
--   publish:  node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
