-- Tara Яармаг's five fixed replies, approved by the founder 2026-09-30 in chat, with the price
-- line changed to «Та ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.». Drafts and evidence:
-- prompt/drafts/tara_fixed_replies.mn.txt, docs/reports/2026-09-30-tara-model-questions.md.
-- Address is option A. The phone reply is Яармаг's only; no other branch gets this row.
--
-- No republish: deterministic rows are read at request time, not compiled into the prefix.
-- A `deterministic_replies` body is sent verbatim with no model and no `reviewed_at` gate, so
-- the founder's approval is this row's only review; `provenance` records it.
--
-- REBRAND: the booking body types matrixecosalon.org (as `booking_line` and
-- `tenant_booking.booking_url` do). Update all three the day the new Tara domain goes live
-- (docs/tenants/tara-yarmag.md). The address body types contact_points' address and maps_url:
-- change it with them.
begin;

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'address', 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16', true, 'covers_message',
       array['хаяг', 'байршил', 'байрла', 'хаана', 'hayag', 'hayg', 'xayg', 'bairshil', 'bairla', 'baishil', 'haana', 'haan']::text[],
       array['уу', 'үү', 'вэ', 'бэ', 'ве', 'юу', 'сайн', 'байна', 'бна', 'бну', 'бнуу', 'танайх', 'танай', 'салон', 'салоны', 'байдаг', 'бдаг', 'тодорхой', 'явуулаад', 'өгөөч', 'өгөөрэй', 'чинь', 'хаашаа', 'болсон', 'uu', 'vv', 'we', 've', 'be', 'yu', 'sain', 'bna', 'bnu', 'bnuu', 'sn', 'hi', 'hello', 'tanaih', 'tanai', 'tanaah', 'salon', 'salonii', 'baidag', 'bdag', 'bdg', 'todorhoi', 'ywuulaad', 'yvuulaad', 'yavuulaad', 'ogooch', 'ogoorei', 'chin', 'haashaa', 'bolson']::text[],
       false, 'tenant_confirmed', 'replace', '{}'
  from tenants t
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'address');

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'booking', 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.', true, 'covers_message',
       array['авах', 'авья', 'авъя', 'авий', 'авмаар', 'авдаг', 'захиалах', 'захиалъя', 'захиалья', 'захиалмаар', 'захиалдаг', 'awah', 'avah', 'awhuu', 'avahuu', 'avhuu', 'awii', 'avii', 'awya', 'avya', 'awdag', 'avdag', 'awmaar', 'avmaar', 'zahialah', 'zahialya', 'zahialmaar', 'zahialdag']::text[],
       array['цаг', 'цагаа', 'гэсэн', 'юм', 'би', 'танайх', 'танайд', 'онлайн', 'яаж', 'уу', 'үү', 'вэ', 'бэ', 'ве', 'юу', 'сайн', 'байна', 'бна', 'бну', 'бнуу', 'tsag', 'tsagaa', 'gesen', 'gsn', 'yum', 'bi', 'tanaih', 'tanaid', 'online', 'onlain', 'yaaj', 'uu', 'vv', 'we', 've', 'be', 'yu', 'sain', 'bna', 'bnu', 'bnuu', 'sn', 'hi', 'hello']::text[],
       false, 'tenant_confirmed', 'replace', '{}'
  from tenants t
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'booking');

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'acknowledgement', 'Өөр асуух зүйл байвал бичээрэй.', true, 'whole_message',
       array['ok', 'okey', 'okay', 'ок', 'окей', 'за', 'заа', 'за за', 'аан за', 'аа за', 'за ойлголоо', 'ойлголоо', 'oilgoloo', 'za', 'zaa', 'aan za', 'aa za', 'ok za']::text[],
       '{}'::text[],
       false, 'tenant_confirmed', 'replace', '{}'
  from tenants t
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'acknowledgement');

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'salon_phone', 'Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.', true, 'covers_message',
       array['утас', 'утсаа', 'утсыг', 'утасны', 'дугаар', 'utas', 'utsaa', 'utsiig', 'utasnii', 'dugaar']::text[],
       array['холбогдох', 'салбарын', 'яармаг', 'салоны', 'танайх', 'өгөөч', 'өгөөрэй', 'хэд', 'уу', 'үү', 'вэ', 'бэ', 'ве', 'юу', 'сайн', 'байна', 'бна', 'бну', 'бнуу', 'holbogdoh', 'salbariin', 'yarmag', 'salonii', 'tanaih', 'ogooch', 'ogoorei', 'hed', 'hedve', 'hedbe', 'uu', 'vv', 'we', 've', 'be', 'yu', 'sain', 'bna', 'bnu', 'bnuu', 'sn', 'hi', 'hello']::text[],
       false, 'tenant_confirmed', 'replace', '{}'
  from tenants t
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'salon_phone');

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, requires_empty_history, provenance, placement, quote_services)
select t.id, 'price_which_service', 'Та ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.', true, 'covers_message',
       array['үнэ', 'үнийн', 'үнэтэй', 'vne', 'une', 'vniin', 'uniin', 'unetei', 'vnetei']::text[],
       array['мэдээлэл', 'авья', 'авъя', 'авий', 'авах', 'хэд', 'хэдэн', 'ямар', 'танайх', 'уу', 'үү', 'вэ', 'бэ', 'ве', 'юу', 'сайн', 'байна', 'бна', 'бну', 'бнуу', 'medeelel', 'awii', 'avii', 'awya', 'avya', 'awah', 'avah', 'hed', 'hedve', 'hedbe', 'heden', 'yamar', 'ymar', 'tanaih', 'uu', 'vv', 'we', 've', 'be', 'yu', 'sain', 'bna', 'bnu', 'bnuu', 'sn', 'hi', 'hello']::text[],
       true, 'tenant_confirmed', 'replace', '{}'
  from tenants t
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'price_which_service');

-- Reply cases: every build and publish now checks these rows still answer, word for word.
-- The price row needs an empty history, which a single-message case has. Booking has no
-- exact case: the reply path puts the deposit rows above the booking line (`withDeposits`),
-- so its full text is not this row's body.
insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, m.msg, m.body, 'Tara fixed replies (founder 2026-09-30)'
  from tenants t
  cross join (values
         ('Хаяг хаана вэ', 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16'),
         ('Ok', 'Өөр асуух зүйл байвал бичээрэй.'),
         ('Утас хэд вэ', 'Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.'),
         ('Үнэ', 'Та ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.')) as m(msg, body)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = m.msg and r.active);

commit;
