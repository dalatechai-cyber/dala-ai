-- NOT APPLIED. Tara Яармаг (matrix-eco-salon). Founder, 2026-10-04: two fixed replies and the
-- reply cases for the photo-question fix. Парк Од gets the same rows in her own file
-- (tara-park-od-after-onboarding.sql, D-157: never copied from this tenant's rows).
--
-- 1. deposit_required (wording APPROVED by the founder on 2026-10-04 as written, both branches:
--    prompt/drafts/tara_deposit_required.mn.txt).
--    The founder's fact: the deposit is required only for online booking. Tara wants customers
--    to book online, so the reply never invites a phone call:
--      «Онлайнаар цаг захиалахад урьдчилгаа төлбөр төлж, цагаа баталгаажуулна. Урьдчилгаа
--       төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно. Цагаа эндээс захиална уу: <booking link>»
--    The link is read from `tenant_booking.booking_url` (the shared booking link) when the file
--    runs, and the row is on the domain-move list (docs/tenants/tara-yarmag.md «Booking domain»),
--    so it changes with the tarasalon.org move. Answers «Заавал эхлээд урьдчилгаа хийх үү?» and
--    its shapes, Cyrillic and Latin. Not: a deduction question (`deposit_deducted`), a refund
--    question, or the amount («хэд»): those go where they went before.
-- 2. stylist_tier_after_deposits (NO NEW WORDING). «Аль нь илүү юм» right after the deposit list
--    (live, 2026-10-04 03:49 UTC) asks which LEVEL is better and names none, so `stylist_tier`
--    (which needs «мастер» or «special») never fired; the model answered and was replaced by the
--    hand-off line. This row serves `stylist_tier`'s approved body, copied from that row as it is
--    now, when the bot's previous reply was the deposit list (`after_reply`, new in this round's
--    code) and the customer asks which one / the difference.
-- 3. Reply cases: the three «Tara perm урт» shapes after the photo question (the code fix in
--    `reception/photoPrice.ts`; the crossing-window timing itself is covered by the unit tests,
--    since a case carries no timing), and exact cases for 1 and 2 with their controls.
--
-- ORDER (each step refuses or misfires if skipped):
--   1. dala-ai's code with `after_reply` deployed to Production (READY). Before it, the code does
--      not know `after_reply` and skips row 2 as a bad matcher (no harm, no answer).
--   2. (Done: the founder approved row 1's wording on 2026-10-04.)
--   3. This file, in one SQL editor run.
--   4. Publish matrix-eco-salon: dry run, the --with-model dry run (the three photo cases reach
--      the model), then --publish. The rows are read at request time; the FAQ is compiled.
-- Undo: the -revert.sql beside it, then publish again.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from deterministic_replies where tenant_id = t and intent in ('deposit_required', 'stylist_tier_after_deposits')) then
    raise exception 'this file is already applied';
  end if;
  -- The wording names this link; a different booking link needs the wording read again.
  if not exists (select 1 from tenant_booking where tenant_id = t and booking_url = 'https://www.matrixecosalon.org/') then
    raise exception 'tenant_booking.booking_url is not https://www.matrixecosalon.org/ (the link in the approved wording)';
  end if;
  -- `stylist_tier` as approved and read on 2026-10-04: its body is what row 2 serves.
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'stylist_tier' and enabled
                   and provenance = 'tenant_confirmed'
                   and body = 'SPECIAL, Мастер болон 1-р зэргийн үсчний ялгаа нь зэрэглэл болон үнэд байдаг. Аль зэрэглэлийн үсчинд үйлчлүүлэхээ та өөрөө сонгоно. Ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.') then
    raise exception 'stylist_tier is not the approved line read on 2026-10-04';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'deposit_deducted' and enabled) then
    raise exception 'apply tara-yarmag-answers-2026-10-04.sql first (deposit_deducted)';
  end if;
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'photo_price_question' and reviewed_at is not null) then
    raise exception 'apply tara-yarmag-photo-question-2026-10-04.sql first (the photo question the cases follow)';
  end if;
  if exists (select 1 from faqs where tenant_id = t and ordinal = 15) then
    raise exception 'FAQ ordinal 15 is taken; read the FAQs again';
  end if;
end $$;

-- 1 and 2. The fixed replies.
insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, matcher, requires_empty_history, provenance, placement, quote_services)
select t.id, 'deposit_required',
       normalize('Онлайнаар цаг захиалахад урьдчилгаа төлбөр төлж, цагаа баталгаажуулна. Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно. Цагаа эндээс захиална уу: ' || b.booking_url, NFC),
       true, 'matcher', '{}'::text[], '{}'::text[],
       '{"mode": "all_of", "matchers": [
          {"mode": "contains_stem", "stems": ["урьдчил", "урьчил", "урдчил", "uridchil", "urichil", "urdchil", "uridchl"]},
          {"mode": "contains_stem", "stems": ["заавал", "zaaval", "zaawal", "эхлээд", "ehleed", "exleed",
                                              "урьдчилгаагүй", "урдчилгаагүй", "uridchilgaagui", "urdchilgaagui", "uridchilgaagvi",
                                              "төлөхгүй", "tuluhgui", "tulhgui", "tulukhgui", "хийхгүй", "hiihgui",
                                              "ёстой", "yostoi", "yostoy", "шаардлагатай", "shaardlagatai", "шаарддаг", "shaarddag"]},
          {"mode": "not", "matcher": {"mode": "contains_stem", "stems": ["хасагд", "хасах", "хасна", "хасаад", "хасаж", "hasagd", "hasah", "hasna", "hasaad", "hasaj", "xasagd",
                                                                          "тооцогд", "тооцох", "тооцно", "тооцож", "tootsogd", "tootsoh", "tootsno", "tootsoj", "үнэнд", "unend", "vnend"]}},
          {"mode": "not", "matcher": {"mode": "contains_stem", "stems": ["буцаа", "butsaa", "буцааг", "butsaag"]}},
          {"mode": "not", "matcher": {"mode": "has_word", "words": ["хэд", "хэдэн", "хэдээр", "hed", "heden", "hedeer", "hedve", "hedbe"]}}]}'::jsonb,
       false, 'tenant_confirmed', 'replace', '{}'::text[]
  from tenants t join tenant_booking b on b.tenant_id = t.id
 where t.slug = 'matrix-eco-salon';

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, matcher, requires_empty_history, provenance, placement, quote_services)
select t.id, 'stylist_tier_after_deposits', s.body, true, 'matcher', '{}'::text[], '{}'::text[],
       '{"mode": "all_of", "matchers": [
          {"mode": "after_reply", "matcher": {"mode": "all_of", "matchers": [
             {"mode": "contains_stem", "stems": ["урьдчилгаа"]},
             {"mode": "contains_stem", "stems": ["мастер", "special"]}]}},
          {"mode": "has_word", "words": ["аль", "al", "ali", "ялгаа", "ялгаатай", "yalgaa", "yalgaatai", "yalgaatay"]},
          {"mode": "not", "matcher": {"mode": "contains_stem", "stems": ["салбар", "salbar", "хаяг", "hayag", "хаана", "haana", "өдөр", "udur", "odor",
                                                                          "будаг", "budag", "хими", "himi", "засалт", "zasalt", "тайралт", "tairalt",
                                                                          "үйлчилгээ", "uilchilgee", "үнэтэй", "unetei"]}},
          {"mode": "not", "matcher": {"mode": "has_word", "words": ["цаг", "цагаа", "tsag", "tsagaa", "хэд", "hed", "үнэ", "une"]}}]}'::jsonb,
       false, 'tenant_confirmed', 'replace', '{}'::text[]
  from tenants t join deterministic_replies s on s.tenant_id = t.id and s.intent = 'stylist_tier'
 where t.slug = 'matrix-eco-salon';

-- The same fact as an FAQ, so the model has it when a question has several parts (compiled at
-- publish). On the domain-move list with the row.
insert into faqs (tenant_id, question, answer, ordinal, provenance)
select t.id, normalize('Заавал эхлээд урьдчилгаа төлөх үү?', NFC), d.body, 15, 'tenant_confirmed'
  from tenants t join deterministic_replies d on d.tenant_id = t.id and d.intent = 'deposit_required'
 where t.slug = 'matrix-eco-salon';

-- 3. Reply cases. Expected bodies are read from the rows, so the cases move with them.
-- (a) After the photo question: «Tara perm урт» names one listed service and gets its price,
--     never the hand-off (founder, 2026-10-04 06:03 UTC). They reach the model.
insert into reply_cases (tenant_id, history, customer_message, expected_body, must_include, must_not_include, note)
select t.id, jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'Сайн байна уу'),
                               jsonb_build_object('role', 'assistant', 'content', q.body)),
       v.msg, null, array['290,000₮']::text[], array['ажилтан үзээд', 'Таны илгээсэн зураг']::text[], v.note
  from tenants t
  join canned_responses q on q.tenant_id = t.id and q.kind = 'photo_price_question'
  join (values
    ('Tara perm урт', 'deposit and level 2026-10-04: «Tara perm урт» after the photo question gets the price, not staff (live 06:03 UTC)'),
    ('Tara perm, урт', 'deposit and level 2026-10-04: «Tara perm, урт» after the photo question gets the price'),
    ('tara perm urt', 'deposit and level 2026-10-04: «tara perm urt», Latin, after the photo question gets the price')
  ) as v(msg, note) on true
 where t.slug = 'matrix-eco-salon';

-- (b) deposit_required, exact, no model; and its controls.
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, v.msg, case when v.exact then d.body end, v.inc::text[], v.exc::text[], v.note
  from tenants t
  join deterministic_replies d on d.tenant_id = t.id and d.intent = 'deposit_required'
  join (values
    ('Заавал эхлээд урьдчилгаа хийх үү?', true, '{}', '{}', 'deposit and level 2026-10-04 (exact): the deposit is for online booking (founder)'),
    ('Асуулт буруу явуулчлаа заавал эхлээд урьдчилгаа хийхүү', true, '{}', '{}', 'deposit and level 2026-10-04 (exact): the live phrasing of 03:51 UTC'),
    ('Урьдчилгаа заавал төлөх ёстой юу', true, '{}', '{}', 'deposit and level 2026-10-04 (exact): «ёстой»'),
    ('Урьдчилгаагүй цаг авч болох уу', true, '{}', '{}', 'deposit and level 2026-10-04 (exact): «урьдчилгаагүй»'),
    ('uridchilgaa zaaval tuluh uu', true, '{}', '{}', 'deposit and level 2026-10-04 (exact): Latin'),
    ('zaaval ehleed urdchilgaa hiih yostoi yu', true, '{}', '{}', 'deposit and level 2026-10-04 (exact): Latin, «urdchilgaa»'),
    ('Урьдчилгаа төлбөр буцаагддаг уу', false, '{}', '{"Онлайнаар цаг захиалахад"}', 'deposit and level 2026-10-04 (control): a refund question is not this row'),
    ('Заавал урьдчилгаа хэд вэ', false, '{}', '{"Онлайнаар цаг захиалахад"}', 'deposit and level 2026-10-04 (control): the amount is not this row'),
    ('Хими хийлгэвэл заавал будах уу', false, '{}', '{"Онлайнаар цаг захиалахад"}', 'deposit and level 2026-10-04 (control): «заавал» without the deposit (live 2026-10-03)')
  ) as v(msg, exact, inc, exc, note) on true
 where t.slug = 'matrix-eco-salon';

-- (c) stylist_tier_after_deposits, exact after the deposit list; its controls. The history's
--     reply is the deposit list as served on 2026-10-04 (its rows; the booking line after it is
--     not what the row reads).
insert into reply_cases (tenant_id, history, customer_message, expected_body, must_include, must_not_include, note)
select t.id, jsonb_build_array(jsonb_build_object('role', 'user', 'content', v.asked),
                               jsonb_build_object('role', 'assistant', 'content', v.before)),
       v.msg, case when v.exact then s.body end, '{}'::text[], v.exc::text[], v.note
  from tenants t
  join deterministic_replies s on s.tenant_id = t.id and s.intent = 'stylist_tier'
  join (values
    ('Оюунаад цаг авч болох уу?', E'Урьдчилгаа төлбөр — 1-р зэргийн үсчин: 10,000₮\nУрьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮\nУрьдчилгаа төлбөр — Мастер үсчин: 20,000₮',
     'Аль нь илүү юм', true, '{}', 'deposit and level 2026-10-04 (exact): «Аль нь илүү юм» after the deposit list (live 03:49 UTC)'),
    ('Оюунаад цаг авч болох уу?', E'Урьдчилгаа төлбөр — 1-р зэргийн үсчин: 10,000₮\nУрьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮\nУрьдчилгаа төлбөр — Мастер үсчин: 20,000₮',
     'al ni deer ve', true, '{}', 'deposit and level 2026-10-04 (exact): Latin, after the deposit list'),
    ('Оюунаад цаг авч болох уу?', E'Урьдчилгаа төлбөр — 1-р зэргийн үсчин: 10,000₮\nУрьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮\nУрьдчилгаа төлбөр — Мастер үсчин: 20,000₮',
     'Ялгаа нь юу вэ', true, '{}', 'deposit and level 2026-10-04 (exact): «ялгаа» after the deposit list'),
    ('Оюунаад цаг авч болох уу?', E'Урьдчилгаа төлбөр — 1-р зэргийн үсчин: 10,000₮\nУрьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮\nУрьдчилгаа төлбөр — Мастер үсчин: 20,000₮',
     'Аль салбар нь ойр вэ', false, '{"зэрэглэл болон үнэд"}', 'deposit and level 2026-10-04 (control): a branch question after the deposit list is not this row'),
    ('ungu gargalt hed ve', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮',
     'Аль нь илүү юм', false, '{"зэрэглэл болон үнэд"}', 'deposit and level 2026-10-04 (control): «Аль нь илүү юм» after the colour rows is not about levels')
  ) as v(asked, before, msg, exact, exc, note) on true
 where t.slug = 'matrix-eco-salon';

-- Read back.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'deposit_required' and enabled
                   and body = 'Онлайнаар цаг захиалахад урьдчилгаа төлбөр төлж, цагаа баталгаажуулна. Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно. Цагаа эндээс захиална уу: https://www.matrixecosalon.org/') then
    raise exception 'read-back: deposit_required';
  end if;
  if (select count(*) from deterministic_replies d join deterministic_replies s on s.tenant_id = d.tenant_id and s.intent = 'stylist_tier'
       where d.tenant_id = t and d.intent = 'stylist_tier_after_deposits' and d.enabled and d.body = s.body) <> 1 then
    raise exception 'read-back: stylist_tier_after_deposits must serve stylist_tier''s body';
  end if;
  if (select count(*) from faqs where tenant_id = t and ordinal = 15) <> 1
     or (select count(*) from reply_cases where tenant_id = t and note like 'deposit and level 2026-10-04%' and active) <> 17 then
    raise exception 'read-back: the FAQ and seventeen reply cases';
  end if;
end $$;

commit;
-- NOW publish matrix-eco-salon (dry run, --with-model dry run, then --publish).
