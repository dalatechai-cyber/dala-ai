-- Revert tara-yarmag-price-twins-2026-10-08.sql: removes the four price twins and puts Яармаг's
-- case 162 back as it was. Refuses when that file is not applied.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from reply_cases where tenant_id = t and note like 'price twins 2026-10-08%') then
    raise exception 'tara-yarmag-price-twins-2026-10-08.sql is not applied';
  end if;
end $$;

delete from reply_cases
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and note like 'price twins 2026-10-08%';

update reply_cases
   set must_include = '{}'::text[],
       must_not_include = '{"хасагдаж тооцогдоно"}'::text[],
       note = 'answers 2026-10-04 (model): the deposit AMOUNT is not answered with the deduction line'
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
   and customer_message = 'Урьдчилгаа төлбөр хэд вэ' and must_include = '{"10,000₮","20,000₮"}'::text[];

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from reply_cases where tenant_id = t and note like 'price twins 2026-10-08%') then
    raise exception 'read-back: price twins left behind';
  end if;
  select count(*) into n from reply_cases
   where tenant_id = t and customer_message = 'Урьдчилгаа төлбөр хэд вэ'
     and must_include = '{}'::text[] and must_not_include = '{"хасагдаж тооцогдоно"}'::text[];
  if n <> 1 then raise exception 'read-back: case 162 is not back (found %)', n; end if;
end $$;

commit;
