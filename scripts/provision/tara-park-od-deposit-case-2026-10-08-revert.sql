-- Revert tara-park-od-deposit-case-2026-10-08.sql: her «Урьдчилгаа төлбөр хэд вэ» case back to
-- what it was (no required amount; the deduction sentence forbidden). Refuses when that file is
-- not applied.
begin;

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  select count(*) into n from reply_cases
   where tenant_id = t and customer_message = 'Урьдчилгаа төлбөр хэд вэ'
     and must_include = '{"20,000₮"}'::text[] and must_not_include = '{}'::text[];
  if n <> 1 then raise exception 'tara-park-od-deposit-case-2026-10-08.sql is not applied (found % corrected cases)', n; end if;
end $$;

update reply_cases
   set must_include = '{}'::text[],
       must_not_include = '{"хасагдаж тооцогдоно"}'::text[],
       note = 'answers 2026-10-04 (model): the deposit AMOUNT is not answered with the deduction line'
 where tenant_id = (select id from tenants where slug = 'tara-park-od')
   and customer_message = 'Урьдчилгаа төлбөр хэд вэ'
   and must_include = '{"20,000₮"}'::text[] and must_not_include = '{}'::text[];

do $$
declare n int;
begin
  select count(*) into n from reply_cases
   where tenant_id = (select id from tenants where slug = 'tara-park-od') and customer_message = 'Урьдчилгаа төлбөр хэд вэ'
     and must_include = '{}'::text[] and must_not_include = '{"хасагдаж тооцогдоно"}'::text[];
  if n <> 1 then raise exception 'read-back: the original case is not back (found %)', n; end if;
end $$;

commit;
