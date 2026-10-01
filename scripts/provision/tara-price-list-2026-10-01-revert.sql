-- ONLY IF NEEDED. Puts Tara Яармаг's rows back as they were read on 2026-10-01 (same content;
-- the restored price rows get new ids, which nothing references), before
-- tara-price-list-2026-10-01.sql (D-167). Run it when that file was applied and the dry run then
-- refused: until either the publish or this revert, every reply refuses as `canned_stale`.
-- After this file the canned rows hash to the live snapshot again (3531d677…41bd), so replies
-- resume with no publish. Proven on a replica of the live rows: forward, revert, then a dry run
-- shows nothing to publish but the prompt trim.
begin;

set local dala.canned_edit = 'republish';

do $$
declare
  t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'TARA Lumi – үүсгэлттэй будалт') then
    raise exception 'tara-price-list-2026-10-01.sql is not applied: nothing to revert';
  end if;
end $$;

-- Phones, with the original signatures.
update canned_responses c
   set body = replace(c.body, '91005498', '80905498'), reviewed_by = 'founder',
       reviewed_at = case c.kind when 'refusal_suitability' then timestamptz '2026-09-20 17:31:54.989221+00'
                                 else timestamptz '2026-09-19 23:03:31.169279+00' end
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.body like '%91005498%';

update deterministic_replies d set body = replace(d.body, '91005498', '80905498')
  from tenants t where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'salon_phone';

update contact_points c set value = '76001888, 80905498'
  from tenants t where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'phone';

update reply_cases r set expected_body = 'Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.'
  from tenants t where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message = 'Утас хэд вэ';

-- The children's rule and its line.
insert into disclosure_rules (topic_key, tenant_id, matcher, decision_question, response_kind, quote_price,
                              forbidden_outputs, deterministic_shortcircuit, approved_by, provenance)
select 'children_services', t.id, '{"mode": "contains_stem", "stems": ["хүүхэд", "хүүхд"]}'::jsonb,
       'Хүүхдийн үйлчилгээ, хүүхдийн үнийн тухай асууж байна уу?', 'refusal_topic', false,
       '{}', false, null, 'tenant_confirmed'
  from tenants t where t.slug = 'matrix-eco-salon';

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'refusal_topic', 'mn-MN',
       'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу.',
       'founder', timestamptz '2026-09-19 23:03:31.169279+00'
  from tenants t where t.slug = 'matrix-eco-salon';

delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message = '8 настай хүүгийн үс тайралт хэд вэ?';

-- Matcher words moved to a new service go back first (deleting the new services below would
-- otherwise take them with it); the words the file added go with their services.
update service_aliases a
   set service_id = s.id
  from tenants t, services s
 where t.slug = 'matrix-eco-salon' and a.tenant_id = t.id and s.tenant_id = t.id
   and ((a.alias in ('CICA нөхөн сэргээх', 'CICA эмчилгээ', 'cica', 'цика') and s.name = 'CICA нөхөн сэргээх эмчилгээ')
     or (a.alias in ('тэжээл', 'tejeel') and s.name = 'CMC тэжээл')
     or (a.alias in ('цайруул', 'tsairuul') and s.name = 'Цайруулалт')
     or (a.alias in ('сор', 'sor') and s.name = 'Сор'));

-- The price list: services the file created go; the old ones come back on, with their old rows.
delete from services s using tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id
   and s.name in ('Хүүхдийн тайралт', 'Бүтэн будалт', 'Энгийн будаг', 'Өнгөлөгч будаг', 'TARA Lumi', 'TARA BLEND',
                  'Хэсэгчилсэн сор', 'Бүтэн сор', 'Бүтэн цайруулалт', 'Tara perm', 'Hippie & Jerry curl',
                  'Сэттинг хими', 'Down perm', 'Үс оношлогоо, зөвлөгөө', 'Нөхөн сэргээх эмчилгээ', 'Үсний тэжээл',
                  'Үсний спа', 'CICA үсний гүний эмчилгээ', 'Эмчилгээний будаг');

update services s set active = true
  from tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id
   and s.name in ('Сахал засах', 'Тэжээлийн тос', 'Угаалт', 'Үс хусах', 'Дунд үсний будаг', 'Урт үсний будаг',
                  'Омбре', 'Оффис колор', 'Сор', 'Цайруулалт', 'CMC тэжээл', 'Хими арчилт',
                  'Тэжээл', 'CICA нөхөн сэргээх эмчилгээ');

update services s set category = 'Тайралт ба засалт'
  from tenants t where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and s.name = 'Хуйх цэвэрлэгээ';

create temp table tara_old_prices (service text, variant text, kind text, lo numeric, hi numeric, confirmed timestamptz) on commit drop;
insert into tara_old_prices values
  ('Афро хими', '', 'range', 430000.00, 510000.00, '2026-09-21 00:00:00+00'),
  ('Гоёлын засалт', '', 'range', 71500.00, 99000.00, '2026-09-21 00:00:00+00'),
  ('Усан хими', '', 'range', 132000.00, 154000.00, '2026-09-21 00:00:00+00'),
  ('Хуйх цэвэрлэгээ', '', 'exact', 88000.00, null, '2026-09-21 00:00:00+00'),
  ('Хуримын засалт', '', 'range', 154000.00, 198000.00, '2026-09-21 00:00:00+00'),
  ('Хэлбэржүүлэлт', '1-р зэрэг', 'exact', 33000.00, null, '2026-09-21 00:00:00+00'),
  ('Хэлбэржүүлэлт', 'Мастер', 'range', 33000.00, 50000.00, '2026-09-21 00:00:00+00'),
  ('Чёлк тайралт', '', 'exact', 33000.00, null, '2026-09-21 00:00:00+00'),
  ('Шулуун хими', '', 'range', 430000.00, 510000.00, '2026-09-21 00:00:00+00'),
  ('Эмчилгээний хими', '', 'range', 220000.00, 255000.00, '2026-09-21 00:00:00+00'),
  ('Эмэгтэй тайралт', '1-р зэрэг', 'exact', 55000.00, null, '2026-09-21 00:00:00+00'),
  ('Эмэгтэй тайралт', 'Мастер', 'range', 66000.00, 88000.00, '2026-09-21 00:00:00+00'),
  ('Эрэгтэй тайралт', '1-р зэрэг', 'exact', 49500.00, null, '2026-09-21 00:00:00+00'),
  ('Эрэгтэй тайралт', 'Мастер', 'exact', 66000.00, null, '2026-09-21 00:00:00+00'),
  ('Үсний угийн будаг', '', 'exact', 135000.00, null, '2026-09-21 16:48:51.946743+00');

delete from service_variants v using services s, tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and v.service_id = s.id
   and s.name in (select service from tara_old_prices);

insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min, price_max, confirmed_at)
select t.id, s.id, p.variant, p.kind, p.lo, p.hi, p.confirmed
  from tara_old_prices p
  join tenants t on t.slug = 'matrix-eco-salon'
  join services s on s.tenant_id = t.id and s.name = p.service;

update deterministic_replies d set quote_services = array['Үсний угийн будаг', 'Дунд үсний будаг', 'Урт үсний будаг']::text[]
  from tenants t where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'dye_prices';
update deterministic_replies d set quote_services = array['Усан хими', 'Эмчилгээний хими', 'Шулуун хими', 'Афро хими']::text[]
  from tenants t where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'perm_types';

update reply_cases r
   set expected_body = 'Усан хими: 132,000₮–154,000₮
Эмчилгээний хими: 220,000₮–255,000₮
Шулуун хими: 430,000₮–510,000₮
Афро хими: 430,000₮–510,000₮

Та аль химийг хийлгэх вэ?'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message in ('usnii himi', 'us bish usnii himi');

update faqs f
   set answer = 'Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна:
CICA нөхөн сэргээх эмчилгээ: 198,000₮ (курсээр 154,000₮)
Тэжээлийн тос: 49,500₮
CMC тэжээл: 132,000₮
Тэжээл: 44,000–88,000₮
Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө.'
  from tenants t
 where t.slug = 'matrix-eco-salon' and f.tenant_id = t.id and f.question = 'Үс их хуурай, хугарч гэмтсэн бол юу хийлгэх вэ?';

delete from knowledge_documents k using tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'TARA Lumi – үүсгэлттэй будалт';

commit;
