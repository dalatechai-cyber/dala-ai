-- NOT APPLIED. Tara Яармаг (matrix-eco-salon). Founder's decisions, 2026-10-04 (D-177): women's
-- «Эмчилгээний хими» and «өнгө гаргалт» are not services Tara offers; the price-page rows, the
-- «Үнийн хуудас» contact and any website change for them are dropped.
--
--   treatment_perm_women  APPROVED 2026-10-04 as written: a woman asking for «Эмчилгээний хими»
--                         is told it is not offered. (Tara's `refusal_service_unavailable` line
--                         names nails, so the founder approved this sentence instead.) Needs
--                         «эмэгтэй/emegtei»; men's «Эмчилгээний хими» (189,000₮) is unchanged.
--                         Lands ENABLED.
--   colour_lift           «Өнгө гаргалт», a woman or anyone who does not say «эрэгтэй»: the
--                         header «Манай өнгөний үйлчилгээний үнэ:», the women's colour rows
--                         (Хэсэгчилсэн сор (эмэгтэй), Бүтэн сор), then Яармаг's approved
--                         `salon_phone` line (76001888 and 91005498, D-167). Never «not offered».
--   colour_lift_men       «Өнгө гаргалт» with «эрэгтэй/eregtei»: the same header, the men's rows
--                         (Хэсэгчилсэн сор (эрэгтэй), Бүтэн цайруулалт (эрэгтэй)), then the same
--                         line. «Бүтэн цайруулалт» is shown to men only (its only price is the men's).
--                         Both APPROVED 2026-10-04 (dala-ai#284 approvals file 08) and land ENABLED.
--
-- The colour rows are the price list's own rows, byte for byte («Name (variant): price₮», the
-- compiled list's format). `quote_services` cannot pick one gender's variant of «Хэсэгчилсэн
-- сор», so the rows are typed; the fact-consistency gate (scripts/facts/gate.ts) checks every
-- stored copy against the price rows at each publish, so a price change cannot leave them stale.
--
-- Same rows as Парк Од's (`tara-park-od-after-onboarding.sql`, branch claude/tara-park-od-tenant),
-- except the colour rows' last line, which is each tenant's own `salon_phone` line (Яармаг: «Та
-- 76001888 эсвэл 91005498 …»; Парк Од: «Та 76001888 …»). Rows are read at request time: no
-- publish is needed.
--
-- Undo: the -revert.sql beside it.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from deterministic_replies where tenant_id = t and intent in ('treatment_perm_women', 'colour_lift', 'colour_lift_men')) then
    raise exception 'this file is already applied';
  end if;
  -- The colour rows end with Яармаг's phone line as D-167 left it (91005498, not the old
  -- 80905498): stop unless that file is applied.
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'salon_phone'
                   and body = 'Та 76001888 эсвэл 91005498 дугаараар холбогдоно уу.') then
    raise exception 'salon_phone is not D-167''s line (apply tara-price-list-2026-10-01.sql first)';
  end if;
  -- The colour rows type these prices; stop if the price list says otherwise.
  if (select count(*) from services s join service_variants v on v.service_id = s.id
       where s.tenant_id = t and (s.name, v.variant_key, v.price_min) in
             (('Хэсэгчилсэн сор', 'эмэгтэй', 150000), ('Бүтэн сор', '', 210000),
              ('Хэсэгчилсэн сор', 'эрэгтэй', 195000), ('Бүтэн цайруулалт', 'эрэгтэй', 450000))) <> 4 then
    raise exception 'the price list does not hold the four colour prices these rows type (apply tara-price-list-2026-10-01.sql first)';
  end if;
end $$;

-- 1. The three rows, all approved and on.
insert into deterministic_replies (tenant_id, intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
select t.id, v.* from tenants t, (values
 ('treatment_perm_women', E'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["эмчилгээний", "emchilgeenii", "emchilgeeni", "emchilgenii"]}, {"mode": "contains_stem", "stems": ["хими", "himi"]}, {"mode": "contains_stem", "stems": ["эмэгтэй", "emegtei", "emegtey"]}]}'::jsonb, false),
 ('colour_lift', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮\n\nТа 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["өнгө гаргал", "өнгө гаргуул", "өнгөө гаргуул", "ungu gargal", "ungu gargul", "ongo gargal", "ongo gargul", "vngv gargal"]}, {"mode": "not", "matcher": {"mode": "contains_stem", "stems": ["эрэгтэй", "eregtei", "eregtey"]}}]}'::jsonb, false),
 ('colour_lift_men', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эрэгтэй): 195,000₮\nБүтэн цайруулалт (эрэгтэй): 450,000₮\n\nТа 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["өнгө гаргал", "өнгө гаргуул", "өнгөө гаргуул", "ungu gargal", "ungu gargul", "ongo gargal", "ongo gargul", "vngv gargal"]}, {"mode": "contains_stem", "stems": ["эрэгтэй", "eregtei", "eregtey"]}]}'::jsonb, false)
) as v(intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
 where t.slug = 'matrix-eco-salon';

-- Reply cases, all active (every row is approved and on).
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note, active)
select t.id, v.msg, v.exp, v.inc, v.exc, v.note, v.active
  from tenants t, (values
  ('emegtei emchilgeenii himi hed ve', 'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', '{}'::text[], '{}'::text[],
   'D-177: women''s «Эмчилгээний хими» is not offered (founder 2026-10-04, approved line)', true),
  ('Эмэгтэй эмчилгээний хими хийдэг үү', 'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', '{}'::text[], '{}'::text[],
   'D-177: women''s «Эмчилгээний хими», Cyrillic', true),
  ('ungu gargalt hed ve', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮\n\nТа 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', '{}'::text[], array['эрэгтэй', 'Бүтэн цайруулалт', 'хийдэггүй', 'үзүүлэхгүй', 'боломжгүй', 'хийхгүй']::text[],
   'D-177: «өнгө гаргалт», no gender given: the women''s colour rows and the phone line, never «not offered»', true),
  ('Өнгө гаргуулмаар байна, үнэ хэд вэ', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮\n\nТа 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', '{}'::text[], array['эрэгтэй', 'Бүтэн цайруулалт', 'хийдэггүй', 'үзүүлэхгүй', 'боломжгүй', 'хийхгүй']::text[],
   'D-177: «өнгө гаргалт», Cyrillic, women''s rows', true),
  ('eregtei hun ungu gargalt hed ve', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эрэгтэй): 195,000₮\nБүтэн цайруулалт (эрэгтэй): 450,000₮\n\nТа 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', '{}'::text[], array['эмэгтэй', 'Бүтэн сор', 'хийдэггүй', 'үзүүлэхгүй', 'боломжгүй', 'хийхгүй']::text[],
   'D-177: «өнгө гаргалт» from a man: the men''s rows only (founder 2026-10-04)', true),
  ('Эрэгтэй хүн өнгө гаргуулж болох уу', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эрэгтэй): 195,000₮\nБүтэн цайруулалт (эрэгтэй): 450,000₮\n\nТа 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', '{}'::text[], array['эмэгтэй', 'Бүтэн сор', 'хийдэггүй', 'үзүүлэхгүй', 'боломжгүй', 'хийхгүй']::text[],
   'D-177: «өнгө гаргалт» from a man, Cyrillic', true),
  ('eregtei emchilgeenii himi hed ve', null, array['189,000₮']::text[], array['үзүүлэхгүй']::text[],
   'D-177: men''s «Эмчилгээний хими» stays as it is (189,000₮)', true)
  ) as v(msg, exp, inc, exc, note, active)
 where t.slug = 'matrix-eco-salon';

commit;

-- Nothing to switch on later: every row and case lands on. Read the answers once in a test chat.
