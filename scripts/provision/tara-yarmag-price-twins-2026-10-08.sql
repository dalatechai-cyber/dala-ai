-- PROPOSAL, NOT APPLIED. Tara Яармаг (matrix-eco-salon): the reply cases that caught Парк Од's
-- B9 failures (2026-10-08), so Яармаг is tested on the same questions. Run only on the founder's
-- go. Changes reply cases only: nothing a customer is sent, no canned line, so no republish and
-- Яармаг's content_hash (651594a8…4fbd) does not move.
--
-- 1. Her case 162 «Урьдчилгаа төлбөр хэд вэ» judges what its note says: the amount is answered.
--    Today it forbids «хасагдаж тооцогдоно», which also fails the right answer (the deposit rows,
--    then the approved deduction sentence beside them). Fed the same reply text, Яармаг and
--    Парк Од give the same result (local replica, 2026-10-08), so this case fails Яармаг exactly
--    as it failed Парк Од the day the model adds that sentence. New: both of her amounts,
--    10,000₮ (1-р зэрэг) and 20,000₮ (SPECIAL, Мастер), must be in the reply.
-- 2. Four model cases Яармаг never had, the twins of Парк Од's onboarding cases 201, 206, 207, 208
--    («the price of X as the client stated it»): a named service's price question gets every one
--    of its prices. Same prices in both branches (the branch gate checks it). Today's Яармаг is
--    exposed exactly as Парк Од was: her prefix carries the same price rows, and on 2026-10-01 (an
--    earlier revision) her model answered «Tara lumi» with a question and no price. The platform fix
--    (`named_service_unpriced`, handle.ts) covers both branches once deployed; these cases prove
--    it at Яармаг's next --with-model run (they are model cases: no build runs them, and they
--    cost nothing until that run).
--
-- Run as ONE file in the SQL editor. Refuses a second run. Undo: the -revert.sql beside it.
begin;

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  select count(*) into n from reply_cases
   where tenant_id = t and customer_message = 'Урьдчилгаа төлбөр хэд вэ' and expected_body is null
     and must_include = '{}'::text[] and must_not_include = '{"хасагдаж тооцогдоно"}'::text[];
  if n <> 1 then raise exception 'expected exactly one unchanged «Урьдчилгаа төлбөр хэд вэ» case for matrix-eco-salon, found % (already applied?)', n; end if;
  if exists (select 1 from reply_cases where tenant_id = t and note like 'price twins 2026-10-08%') then
    raise exception 'tara-yarmag-price-twins-2026-10-08.sql is already applied';
  end if;
end $$;

update reply_cases
   set must_include = '{"10,000₮","20,000₮"}'::text[],
       must_not_include = '{}'::text[],
       note = 'answers 2026-10-04 (model), corrected 2026-10-08: the deposit AMOUNTS are answered; the approved deduction sentence beside them is allowed'
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
   and customer_message = 'Урьдчилгаа төлбөр хэд вэ' and expected_body is null
   and must_include = '{}'::text[] and must_not_include = '{"хасагдаж тооцогдоно"}'::text[];

insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, v.msg, null, v.inc::text[], '{}'::text[], v.note
  from tenants t, (values
  ('Хүүхдийн тайралт хэд вэ?', '{"44,000₮","33,000₮"}',
   'price twins 2026-10-08 (model): every price of «Хүүхдийн тайралт» (Парк Од''s case 201)'),
  ('TARA BLEND хэд вэ?', '{"550,000₮","630,000₮","720,000₮"}',
   'price twins 2026-10-08 (model): every length of «TARA BLEND» (Парк Од''s case 206)'),
  ('TARA Lumi хэд вэ?', '{"350,000₮","460,000₮","510,000₮"}',
   'price twins 2026-10-08 (model): every length of «TARA Lumi» (Парк Од''s case 207)'),
  ('Бүтэн будалт хэд вэ?', '{"88,000₮"}',
   'price twins 2026-10-08 (model): «Бүтэн будалт» is the men''s full dye, 88,000₮ (Парк Од''s case 208)')
  ) as v(msg, inc, note)
 where t.slug = 'matrix-eco-salon';

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  select count(*) into n from reply_cases where tenant_id = t and note like 'price twins 2026-10-08%' and active;
  if n <> 4 then raise exception 'read-back: expected 4 active price twins, found %', n; end if;
  select count(*) into n from reply_cases
   where tenant_id = t and customer_message = 'Урьдчилгаа төлбөр хэд вэ' and must_include = '{"10,000₮","20,000₮"}'::text[];
  if n <> 1 then raise exception 'read-back: case 162 not corrected (found %)', n; end if;
end $$;

commit;
