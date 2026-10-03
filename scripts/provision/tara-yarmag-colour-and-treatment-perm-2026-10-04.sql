-- NOT APPLIED. DRAFT ROWS, AWAITING the founder's approval of their wording
-- (prompt/drafts/tara_quality_2026-10-03.mn.txt, items 8 and 9). Tara Яармаг (matrix-eco-salon).
--
-- Founder's decision, 2026-10-04 (D-177): women's «Эмчилгээний хими» and «өнгө гаргалт» are not
-- services Tara offers. The price-page rows (`price_page_treatment_perm`, `price_page_color`), the
-- «Үнийн хуудас» contact and the website change for them are dropped. Instead:
--
--   treatment_perm_women  A woman asking for «Эмчилгээний хими» is told it is not offered. The
--                         founder asked for the approved «service unavailable» line
--                         (`refusal_service_unavailable`), but Tara's line names nails («Манай
--                         салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна.»), so it cannot be
--                         sent here as it is. The body below is that line with the service
--                         changed: NEW WORDING, awaiting approval. Men's «Эмчилгээний хими»
--                         (189,000₮, the price list) is unchanged: this row needs «эмэгтэй».
--   colour_lift           «Өнгө гаргалт» (6+ chats a week) is NEVER told it is not offered. The
--                         reply is the salon's related colour rows, read from the price list at
--                         send time (`quote_services`, so this file holds no price), then the
--                         tenant's own approved `salon_phone` line, byte for byte. No new
--                         sentence; the composition is new, so it awaits approval too.
--
-- Same rows as Парк Од's (`tara-park-od-after-onboarding.sql`, branch claude/tara-park-od-tenant),
-- except `colour_lift`'s body, which is each tenant's own `salon_phone` line (Яармаг: «Та 76001888
-- эсвэл 80905498 …»; Парк Од: «Та 76001888 …»).
--
-- Both rows go in DISABLED and `seeded` (a `seeded` row never answers, D-020), with their reply
-- cases inactive. Step 2 (below) switches them on after the founder approves the wording. Rows
-- are read at request time: no publish is needed.
--
-- Undo: the -revert.sql beside it.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from deterministic_replies where tenant_id = t and intent in ('treatment_perm_women', 'colour_lift')) then
    raise exception 'this file is already applied';
  end if;
  -- `colour_lift` quotes these by name; a missing one would make it never answer.
  if (select count(distinct s.name) from services s
       where s.tenant_id = t and s.name in ('Хэсэгчилсэн сор', 'Бүтэн сор', 'Бүтэн цайруулалт')) <> 3 then
    raise exception 'the price list lacks a colour service colour_lift quotes (apply tara-price-list-2026-10-01.sql first)';
  end if;
end $$;

-- 1. The two rows, disabled.
insert into deterministic_replies (tenant_id, intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
select t.id, v.* from tenants t, (values
 ('treatment_perm_women', 'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', false, 'seeded', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["эмчилгээний", "emchilgeenii", "emchilgeeni", "emchilgenii"]}, {"mode": "contains_stem", "stems": ["хими", "himi"]}, {"mode": "contains_stem", "stems": ["эмэгтэй", "emegtei", "emegtey"]}]}'::jsonb, false),
 ('colour_lift', 'Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.', false, 'seeded', 'contains_stem', 'replace', '{"өнгө гаргал","өнгө гаргуул","өнгөө гаргуул","ungu gargal","ungu gargul","ongo gargal","ongo gargul","vngv gargal"}'::text[], '{}'::text[], array['Хэсэгчилсэн сор', 'Бүтэн сор', 'Бүтэн цайруулалт']::text[], NULL::jsonb, false)
) as v(intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
 where t.slug = 'matrix-eco-salon';

-- Reply cases, INACTIVE until step 2.
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note, active)
select t.id, v.msg, null, v.inc, v.exc, v.note, false
  from tenants t, (values
  ('ungu gargalt hed ve',
   array['Хэсэгчилсэн сор', 'Бүтэн сор', 'Бүтэн цайруулалт', '150,000₮', '210,000₮', '76001888']::text[],
   array['хийдэггүй', 'үзүүлэхгүй', 'боломжгүй', 'хийхгүй']::text[],
   'D-177: «өнгө гаргалт» gets the related colour rows and the phone line, never «not offered» (founder 2026-10-04)'),
  ('Өнгө гаргуулмаар байна, үнэ хэд вэ',
   array['Хэсэгчилсэн сор', 'Бүтэн сор', '76001888']::text[],
   array['хийдэггүй', 'үзүүлэхгүй', 'боломжгүй', 'хийхгүй']::text[],
   'D-177: «өнгө гаргалт», Cyrillic'),
  ('emegtei emchilgeenii himi hed ve',
   array['Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.']::text[],
   array['189,000₮', 'хумс']::text[],
   'D-177: women''s «Эмчилгээний хими» is not offered (founder 2026-10-04); never the men''s price, never the nail line'),
  ('Эмэгтэй эмчилгээний хими хийдэг үү',
   array['Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.']::text[],
   array['189,000₮', 'хумс']::text[],
   'D-177: women''s «Эмчилгээний хими», Cyrillic'),
  ('eregtei emchilgeenii himi hed ve',
   array['189,000₮']::text[],
   array['үзүүлэхгүй']::text[],
   'D-177: men''s «Эмчилгээний хими» stays as it is (189,000₮)')
  ) as v(msg, inc, exc, note)
 where t.slug = 'matrix-eco-salon';

commit;

-- 2. AFTER the founder approves items 8 and 9 (the same day for Парк Од):
-- begin;
-- update deterministic_replies d set enabled = true, provenance = 'tenant_confirmed'
--   from tenants t
--  where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent in ('treatment_perm_women', 'colour_lift');
-- update reply_cases r set active = true
--   from tenants t
--  where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'D-177:%';
-- commit;
-- Then run the tenant's reply cases (scripts/replycases) and read the two answers once in a test chat.
