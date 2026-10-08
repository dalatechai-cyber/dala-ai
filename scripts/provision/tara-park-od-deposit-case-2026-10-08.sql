-- Парк Од (tara-park-od): her reply case «Урьдчилгаа төлбөр хэд вэ» judges what its note says.
-- Before her first publish (runbook B9, rerun of 2026-10-08). Changes ONE reply case of hers and
-- nothing a customer is sent: no canned line, fixed reply, FAQ or price, so her content_hash
-- (d867eed12db06ee8…) does not move.
--
-- Why. The case came from Яармаг's answers of 2026-10-04 (its twin there is case 162) with the
-- note «the deposit AMOUNT is not answered with the deduction line». The failure it was written
-- against is the fixed reply `deposit_deducted` («Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж
-- тооцогдоно.») answering an amount question instead of the amount (that file's header: «Урьдчилгаа
-- төлбөр хэд вэ» (the amount) reaches none of the new matchers). It was written as «the reply must
-- not contain хасагдаж тооцогдоно», which also fails the right answer: the amount, then the same
-- approved sentence beside it, the way your own `deposit_required` answer and the website say it.
-- Fed the same reply text, both branches give the same result (local replica, 2026-10-08):
--   «Урьдчилгаа төлбөр 20,000₮. Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.» →
--   her row «Урьдчилгаа төлбөр: SPECIAL болон Мастер үсчин: 20,000₮» + the approved sentence: FAILED
--   the old case, passes this one;
--   the deduction sentence alone (no amount): failed the old case, FAILS this one too.
-- So the case now requires the amount, 20,000₮ (all her deposits: docs/tenants/tara-park-od.md), and no
-- longer forbids the approved sentence. It is never looser on the amount: a reply without it fails.
-- Яармаг's case 162 has the same flaw; the same change for her is proposed, not applied, in
-- tara-yarmag-price-twins-2026-10-08.sql (your go).
--
-- Run as ONE file in the SQL editor. Refuses a second run, and refuses (changing nothing) unless she
-- has exactly 115 active cases afterwards, the count B6 left. Undo: the -revert.sql beside it.
begin;

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  select count(*) into n from reply_cases
   where tenant_id = t and customer_message = 'Урьдчилгаа төлбөр хэд вэ' and expected_body is null
     and must_include = '{}'::text[] and must_not_include = '{"хасагдаж тооцогдоно"}'::text[];
  if n <> 1 then
    raise exception 'expected exactly one unchanged «Урьдчилгаа төлбөр хэд вэ» case for tara-park-od, found % (already applied?)', n;
  end if;
end $$;

update reply_cases
   set must_include = '{"20,000₮"}'::text[],
       must_not_include = '{}'::text[],
       note = 'answers 2026-10-04 (model), corrected 2026-10-08: the deposit AMOUNT is answered (20,000₮); the approved deduction sentence beside it is allowed'
 where tenant_id = (select id from tenants where slug = 'tara-park-od')
   and customer_message = 'Урьдчилгаа төлбөр хэд вэ' and expected_body is null
   and must_include = '{}'::text[] and must_not_include = '{"хасагдаж тооцогдоно"}'::text[];

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  select count(*) into n from reply_cases
   where tenant_id = t and customer_message = 'Урьдчилгаа төлбөр хэд вэ'
     and must_include = '{"20,000₮"}'::text[] and must_not_include = '{}'::text[] and active;
  if n <> 1 then raise exception 'read-back: expected the corrected active case once, found %', n; end if;
  select count(*) into n from reply_cases where tenant_id = t and active;
  if n <> 115 then raise exception 'read-back: expected 115 active cases for tara-park-od, found %', n; end if;
end $$;

commit;
