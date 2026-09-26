-- DalaTech (tenant #0): two questions the model answered differently run to run, answered
-- from approved rows instead (D-134). Every body below is a line the founder already
-- approved; no new wording. Tara is not touched: every statement is keyed on slug 'dalatech'.
--
--  1. demo_timing — «Демо хэдэн цагт бэлэн болох вэ?». Nothing in the prefix says how long a
--     demo takes, so the model either gave the link, or said it did not know (the handoff
--     line, no link), or wrote a «24» the numeral guard refuses. The approved follow-up
--     already says it: «🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online». That
--     line, whole, is the answer. covers_message: served only when every word is «демо» or
--     a timing / filler word, so any other demo question still goes to the model.
--  2. callback_request — «Надад залгаж болох уу?». The approved callback line reached the
--     customer only when the model's reply let the sales line through (no question at the
--     end, no step link in it). The founder's rule is that the callback line applies when
--     the customer asks for a call, so it is the answer, as `demo_request` is for a demo.
--     A message carrying a number is still thanked first (`leadThanksFor` runs before any
--     row), and a complaint about calls («залгаад авахгүй») is never covered: «авахгүй» is
--     not a cover word.
--  3. purchase_request — «За тэгвэл Дали авъя. Яах вэ?». The model answered a purchase with
--     «холбоо барих мэдээллээ энд бичээрэй» one run and the approved callback line the next,
--     and once claimed Дали could be ordered at the DEMO link. The approved callback line is
--     the answer to "I'll take it, what now?", so it is served whole. covers_message: every
--     word must be a buying word, a product name or filler, so a purchase question that
--     also asks something else («Дали авъя, үнэ хэд вэ?») still goes to the model.
--  4. requires_empty_history = false on these rows AND on D-133's `thanks` and `greeting`.
--     The column defaults to true, the D-133 file did not set it, and so «Баярлалаа» was
--     answered from the row only as a conversation's FIRST message — a thank-you comes after
--     an answer, i.e. never. The founder's own «Баярлалаа → Тавтай морил!» was mid-chat.
--  5. The «Нэр» document (D-133) said «AI туслахын нэр: Дали.», which made «Дали» two
--     things, the assistant and the product. «daly gj yuve» (what is Дали?) was then answered
--     as «who are you?» — the assistant_identity line, with no word of what Дали does. A
--     first rewording («the assistant in this chat IS Дали») made it worse, 3 runs in 4. The
--     document now names the company only; the assistant's name lives in the approved
--     greeting and assistant_who rows, which is where the «Дала апп» greeting was fixed.
--     [prefix: republish]
begin;

do $$
begin
  if not exists (select 1 from tenants where slug = 'dalatech') then
    raise exception 'no tenant with slug dalatech';
  end if;
  if not exists (select 1 from sales_next_steps n join tenants t on t.id = n.tenant_id
                 where t.slug = 'dalatech' and n.kind = 'callback' and n.reviewed_at is not null) then
    raise exception 'dalatech has no reviewed callback line';
  end if;
end
$$;

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words, placement, provenance, requires_empty_history)
select t.id, 'demo_timing', normalize('🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online', NFC), true, 'covers_message',
       array['демо', 'demo']::text[],
       array['хэдэн', 'хэд', 'цагт', 'цаг', 'цагийн', 'цагаар', 'дотор', 'бэлэн', 'болох', 'болдог', 'болно', 'хийгдэх', 'хийгддэг',
             'хэзээ', 'удах', 'удаан', 'удах уу', 'хугацаа', 'хугацаанд', 'хэр', 'вэ', 'бэ', 'юм', 'нь',
             'heden', 'hed', 'tsagt', 'tsag', 'tsagiin', 'dotor', 'belen', 'boloh', 'boldog', 'bolno', 'hezee',
             'udah', 'udaan', 'hugatsaa', 'her', 've', 'be', 'yum', 'ni']::text[],
       'replace', 'tenant_confirmed', false
from tenants t where t.slug = 'dalatech'
on conflict (tenant_id, intent) do update set body = excluded.body, stems = excluded.stems, cover_words = excluded.cover_words,
  enabled = true, match_mode = excluded.match_mode, placement = excluded.placement, provenance = excluded.provenance,
  requires_empty_history = false;

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words, placement, provenance, requires_empty_history)
select t.id, 'callback_request', n.body, true, 'covers_message',
       array['залга', 'zalga']::text[],
       array['надад', 'над', 'намайг', 'руу', 'та', 'нар', 'та нар', 'бид', 'болох', 'болно', 'уу', 'үү', 'юу', 'вэ', 'одоо',
             'эргээд', 'гуйя', 'хүсье', 'хүсэж', 'байна', 'боломжтой', 'боломж',
             'nadad', 'nad', 'namaig', 'ruu', 'ta', 'nar', 'bid', 'boloh', 'bolno', 'uu', 'yu', 've', 'odoo',
             'ergeed', 'guiya', 'husye', 'husej', 'baina', 'bna', 'bolomjtoi', 'bolomj', 'please', 'me', 'call', 'can', 'you']::text[],
       'replace', 'tenant_confirmed', false
from tenants t join sales_next_steps n on n.tenant_id = t.id and n.kind = 'callback'
where t.slug = 'dalatech'
on conflict (tenant_id, intent) do update set body = excluded.body, stems = excluded.stems, cover_words = excluded.cover_words,
  enabled = true, match_mode = excluded.match_mode, placement = excluded.placement, provenance = excluded.provenance,
  requires_empty_history = false;

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words, placement, provenance, requires_empty_history)
select t.id, 'purchase_request', n.body, true, 'covers_message',
       array['авъя', 'авмаар', 'захиалъя', 'захиалмаар', 'худалдаж', 'avya', 'avii', 'avmaar', 'zahialya', 'zahialmaar']::text[],
       array['за', 'тэгвэл', 'тэгээд', 'тэгье', 'тэгэх', 'дали', 'далийг', 'вира', 'вираг', 'эхо', 'эхог', 'нова', 'новаг', 'ора', 'ораг',
             'вэбсайт', 'вэбсайтаа', 'багц', 'багцыг', 'ажилтан', 'ажилтныг', 'нэгийг', 'би', 'бид', 'манайд', 'надад', 'одоо',
             'яах', 'яаж', 'хэрхэн', 'хийх', 'вэ', 'бэ', 'юу', 'уу', 'үү', 'гэсэн', 'байна', 'хүсэж', 'хүсэн', 'ok', 'ок',
             'za', 'tegvel', 'tegeed', 'tegye', 'dali', 'daliig', 'vira', 'eho', 'echo', 'nova', 'ora', 'websait', 'website', 'bagts',
             'ajiltan', 'bi', 'bid', 'nadad', 'odoo', 'yah', 'yaj', 'herhen', 'hiih', 've', 'be', 'yu', 'uu', 'gesen', 'baina', 'bna']::text[],
       'replace', 'tenant_confirmed', false
from tenants t join sales_next_steps n on n.tenant_id = t.id and n.kind = 'callback'
where t.slug = 'dalatech'
on conflict (tenant_id, intent) do update set body = excluded.body, stems = excluded.stems, cover_words = excluded.cover_words,
  enabled = true, match_mode = excluded.match_mode, placement = excluded.placement, provenance = excluded.provenance,
  requires_empty_history = false;

update deterministic_replies d set requires_empty_history = false
from tenants t where d.tenant_id = t.id and t.slug = 'dalatech' and d.intent in ('thanks', 'greeting');

update knowledge_documents k
set body = normalize(E'- Манай компанийн нэр: DalaTech.\n- Компани, бүтээгдэхүүн, ажилтанд өөр нэр зохиож хэрэглэхгүй.', NFC)
from tenants t where k.tenant_id = t.id and t.slug = 'dalatech' and k.title = 'Нэр';

commit;
