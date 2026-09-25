-- Tenant #0 (dalatech) rows the founder approved on 2026-09-25, after reading
-- docs/reports/2026-09-25-tenant0-data.md. Applied the same day through the SQL tool.
-- Not in the prompt until tenant #0 is republished (scripts/publish/tenant.ts), except
-- price_overview, a deterministic row read per request, which is live on write.
begin;

-- 1. Twelve price rows, as written (§3), every one exact and confirmed now.
with t as (select '919e21d4-224d-44b3-bb62-273caa6237ce'::uuid as id),
s as (
  insert into services (tenant_id, name) select t.id, n from t, unnest(array[
    'Дали — Хүлээн авагч', 'Вира — Бизнес аналитик', 'Эхо — Утасны оператор',
    'Нова — Харилцагчийн менежер', 'Ора — Хувийн туслах', 'Ухаалаг вэбсайт', 'Вэбсайт + Дали багц'
  ]) as n
  returning id, name, tenant_id
)
insert into service_variants (tenant_id, service_id, variant_key, price_kind, price_min, confirmed_at)
select s.tenant_id, s.id, v.variant_key, 'exact', v.price, now()
from s join (values
  ('Дали — Хүлээн авагч', 'Сарын төлбөр', 250000), ('Дали — Хүлээн авагч', 'Нэг удаагийн суурилуулалт', 150000),
  ('Вира — Бизнес аналитик', 'Сарын төлбөр', 150000), ('Вира — Бизнес аналитик', 'Нэг удаагийн суурилуулалт', 150000),
  ('Эхо — Утасны оператор', 'Сарын төлбөр', 250000), ('Эхо — Утасны оператор', 'Нэг удаагийн суурилуулалт', 200000),
  ('Нова — Харилцагчийн менежер', 'Сарын төлбөр', 150000), ('Нова — Харилцагчийн менежер', 'Нэг удаагийн суурилуулалт', 150000),
  ('Ора — Хувийн туслах', 'Сарын төлбөр', 250000), ('Ора — Хувийн туслах', 'Нэг удаагийн суурилуулалт', 150000),
  ('Ухаалаг вэбсайт', '', 750000), ('Вэбсайт + Дали багц', '', 800000)
) as v(name, variant_key, price) on v.name = s.name;

-- The aliases (§3): the old names the site chatbot already accepts.
insert into service_aliases (tenant_id, service_id, alias, provenance)
select s.tenant_id, s.id, a.alias, 'tenant_confirmed'
from services s join (values
  ('ара', 'Дали — Хүлээн авагч'), ('ara', 'Дали — Хүлээн авагч'), ('dali', 'Дали — Хүлээн авагч'),
  ('веда', 'Вира — Бизнес аналитик'), ('veda', 'Вира — Бизнес аналитик'), ('vira', 'Вира — Бизнес аналитик'),
  ('echo', 'Эхо — Утасны оператор'), ('eho', 'Эхо — Утасны оператор'),
  ('nova', 'Нова — Харилцагчийн менежер'), ('ora', 'Ора — Хувийн туслах'),
  ('вэбсайт', 'Ухаалаг вэбсайт'), ('website', 'Ухаалаг вэбсайт'), ('сайт', 'Ухаалаг вэбсайт'),
  ('багц', 'Вэбсайт + Дали багц'), ('bundle', 'Вэбсайт + Дали багц')
) as a(alias, name) on a.name = s.name
where s.tenant_id = '919e21d4-224d-44b3-bb62-273caa6237ce';

-- 3. price_overview gains the website and bundle line (live on write).
update deterministic_replies
set body = body || E'\nВэбсайт: Ухаалаг вэбсайт 750,000₮, Вэбсайт + Дали багц 800,000₮.'
where tenant_id = '919e21d4-224d-44b3-bb62-273caa6237ce' and intent = 'price_overview'
  and body not like '%Ухаалаг вэбсайт%';

-- 4. Address and the chatbot's domain.
insert into contact_points (tenant_id, kind, value) values
  ('919e21d4-224d-44b3-bb62-273caa6237ce', 'address', 'Улаанбаатар, Монгол');
insert into tenant_domains (tenant_id, host, verified_at) values
  ('919e21d4-224d-44b3-bb62-273caa6237ce', 'dalatech-chatbot.vercel.app', now());

-- 5. Budget: the full $2 a day for Reception (0.95 x 2.11 = 2.0045, clipped to 2.00 by the
--    compiled cap). Monthly carried over unchanged: nothing reads it (D-072).
insert into tenant_budgets (tenant_id, monthly_ceiling_nanousd, daily_ceiling_nanousd, ceiling_reason)
values ('919e21d4-224d-44b3-bb62-273caa6237ce', 5000000000, 2110000000,
        'founder 2026-09-25: the full $2 a day for Reception (Facebook Page and website together)');

-- 6. comment_public_reply: the founder is its reviewer.
update canned_responses set reviewed_by = 'founder'
where tenant_id = '919e21d4-224d-44b3-bb62-273caa6237ce' and kind = 'comment_public_reply' and reviewed_by is null;

-- 7. FAQ 4 (founder, later the same evening). FAQ 6's discounts confirmed as they stand.
update faqs set answer = 'AI ажилтан 1–2 долоо хоногт ажиллаж эхэлнэ.'
where tenant_id = '919e21d4-224d-44b3-bb62-273caa6237ce' and answer = 'AI ажилтан 3–5 хоногт ажиллаж эхэлнэ.';

commit;
