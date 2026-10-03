-- NOT APPLIED. Draft for the founder (quality round of 2026-10-03,
-- docs/reports/2026-10-03-tara-dali-quality.md). No customer-facing sentence is added or changed:
-- matcher words and reply cases only.
--
-- 1. The fixed `booking` reply also answers «цаг авч …» («Tsag awch ochih uu», live 2026-10-01,
--    which was served the hand-off line). New stems авч / awch / avch / абч / abch and cover words
--    очих / ochih / очиж / ochij / болох / boloh / bolh. `covers_message` still needs EVERY word of the
--    message to be a stem or a cover word, so «мэдээлэл авч болох уу» (information, not a time)
--    is not covered and goes on to the model as before. A three-letter stem («авч», «абч») is
--    matched as a whole word only (`coversMessage`, MIN_STEM_CHARS).
-- 2. Reply cases for every fix of this round. The two booking cases need no model. The other four
--    need the model, so the reply-case gate lists them as not run until the founder's one
--    `--with-model` dry run; they prove the code fixes in src/lib/reception/handle.ts
--    (set question with no price; a near-certain adaptation of an approved line).
--
-- Deterministic rows are read at request time: live at COMMIT, no publish needed for (1).
-- Undo: tara-dali-quality-2026-10-03-revert.sql.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'booking'
                 and match_mode = 'covers_message' and 'авах' = any (stems)) then
    raise exception 'the booking row is not the one read on 2026-10-03';
  end if;
  if exists (select 1 from deterministic_replies where tenant_id = t and intent = 'booking' and 'awch' = any (stems)) then
    raise exception 'this file is already applied';
  end if;
end $$;

update deterministic_replies d
   set stems = d.stems || array(select w from unnest(array['авч', 'awch', 'avch', 'абч', 'abch']) w
                                where not (w = any (d.stems))),
       cover_words = d.cover_words || array(select w from unnest(array['очих', 'ochih', 'очиж', 'ochij', 'болох', 'boloh', 'bolh']) w
                                            where not (w = any (d.cover_words)))
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'booking';

-- No model: the booking row answers, the deposits are added above the link at the draft.
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, v.msg, null, array['https://www.matrixecosalon.org/', 'Урьдчилгаа төлбөр — ']::text[],
       array['хариулж чадахгүй']::text[], v.note
  from tenants t,
       (values ('Tsag awch ochih uu', 'quality 2026-10-03: live 2026-10-01 a booking request got the hand-off line; the booking row answers (no model)'),
               ('цаг авч болох уу', 'quality 2026-10-03: «цаг авч» is a booking request; the booking row answers (no model)')) as v(msg, note)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = v.msg);

-- Need the model (founder's one --with-model dry run).
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, v.msg, null, v.inc::text[], v.exc::text[], v.note
  from tenants t,
       (values ('Us budahad hed gdg ve?', array['160,000₮'], array[]::text[],
                'quality 2026-10-03 (model): live 2026-10-01 a dye price question got the colour question and no price; the set rows are served'),
               ('ene budalt hed ve', array['160,000₮'], array[]::text[],
                'quality 2026-10-03 (model): live 2026-10-03 the same; the set rows are served'),
               ('unuudur hiilgeh tsag bga yu', array['https://www.matrixecosalon.org/'], array['хариулж чадахгүй'],
                'quality 2026-10-03 (model): live 2026-10-03 the booking line at 0.984 was replaced by the hand-off line'),
               ('Manikur hiilgewel', array['хумсны үйлчилгээ үзүүлэхгүй'], array['хариулж чадахгүй'],
                'quality 2026-10-03 (model): live 2026-09-30 the no-nails line at 0.982 was replaced by the hand-off line'))
         as v(msg, inc, exc, note)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = v.msg);

-- Read back inside the transaction.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'booking'
                 and 'awch' = any (stems) and 'ochih' = any (cover_words)) then
    raise exception 'read-back: booking stems not updated';
  end if;
  if (select count(*) from reply_cases where tenant_id = t and note like 'quality 2026-10-03%') <> 6 then
    raise exception 'read-back: six quality cases expected';
  end if;
end $$;

commit;
