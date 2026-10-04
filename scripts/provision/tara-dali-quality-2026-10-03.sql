-- NOT APPLIED. Draft for the founder (quality round of 2026-10-03,
-- docs/reports/2026-10-03-tara-dali-quality.md). Reply cases only: no row Дали reads changes,
-- no customer-facing sentence is added.
--
-- Five cases from this week's live replies. Every one needs the model, so the reply-case gate
-- lists them as not run until the founder's one `--with-model` dry run, where they prove the two
-- code fixes in src/lib/reception/handle.ts on the real model:
--   - a set row's question with no price, to a customer who asked a price, is served as the set
--     row (`set_question_unpriced`);
--   - an approved line adapted inside a longer reply at 0.9+ of the row gets that row, not the
--     hand-off line (`EMBEDDED_CERTAIN_SHARE`).
--
-- Considered and dropped (independent review, 2026-10-03): new booking stems «авч / awch / avch».
-- They also cover «bring» («avchirch boloh uu») and «buy» («онлайн авч болох уу»), so the booking
-- link would answer questions that are not about a time. The live «Tsag awch ochih uu» is covered
-- by the second code fix instead (the model wrote the booking line; it is now served).
--
-- Round 2 (2026-10-04): the cases that must not get the hand-off line name both its old bytes
-- («хариулж чадахгүй») and the new ones (tara-yarmag-answers-2026-10-04.sql, «манай ажилтан
-- танд хариулна»), so they hold whichever file is applied first.
--
-- Undo: tara-dali-quality-2026-10-03-revert.sql.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from reply_cases where tenant_id = t and note like 'quality 2026-10-03%') then
    raise exception 'this file is already applied';
  end if;
end $$;

insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, v.msg, null, v.inc::text[], v.exc::text[], v.note
  from tenants t,
       (values ('Us budahad hed gdg ve?', array['160,000₮'], array[]::text[],
                'quality 2026-10-03 (model): live 2026-10-01 a dye price question got the colour question and no price; the set rows are served'),
               ('ene budalt hed ve', array['160,000₮'], array[]::text[],
                'quality 2026-10-03 (model): live 2026-10-03 the same; the set rows are served'),
               ('Tsag awch ochih uu', array['https://www.matrixecosalon.org/', 'Урьдчилгаа төлбөр — '], array['хариулж чадахгүй', 'манай ажилтан танд хариулна'],
                'quality 2026-10-03 (model): live 2026-10-01 the booking line at 0.992 was replaced by the hand-off line'),
               ('unuudur hiilgeh tsag bga yu', array['https://www.matrixecosalon.org/'], array['хариулж чадахгүй', 'манай ажилтан танд хариулна'],
                'quality 2026-10-03 (model): live 2026-10-03 the booking line at 0.984 was replaced by the hand-off line'),
               ('Manikur hiilgewel', array['хумсны үйлчилгээ үзүүлэхгүй'], array['хариулж чадахгүй', 'манай ажилтан танд хариулна'],
                'quality 2026-10-03 (model): live 2026-09-30 the no-nails line at 0.982 was replaced by the hand-off line'))
         as v(msg, inc, exc, note)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = v.msg);

-- Read back inside the transaction.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from reply_cases where tenant_id = t and note like 'quality 2026-10-03%') <> 5 then
    raise exception 'read-back: five quality cases expected';
  end if;
end $$;

commit;
