-- Revert of dalatech-ora-bonus-2026-10-01.sql (D-173): every row back to what it held before.
begin;

create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
do $$ begin
  if (select count(*) from dt) <> 1 then raise exception 'tenant dalatech not found exactly once'; end if;
end $$;

delete from reply_cases r using dt where r.tenant_id = dt.id and r.note = 'D-173: Ора''s new-customer gift, fixed reply.';

update reply_cases r
   set expected_body = null,
       must_include = array[normalize('500 асуулт', NFC), normalize('эхний сар', NFC)],
       note = nullif(replace(r.note, ' Exact from 2026-10-01: answered by ora_new_user_bonus (D-173).', ''), '')
  from dt where r.tenant_id = dt.id and r.note like '% Exact from 2026-10-01: answered by ora_new_user_bonus (D-173).%';

delete from deterministic_replies d using dt where d.tenant_id = dt.id and d.intent = 'ora_new_user_bonus';

update deterministic_replies d
   set items = (select jsonb_agg(case
                  when e.item ->> 'body' = 'Ора'
                  then jsonb_set(e.item, '{words}', (e.item -> 'words') - 'орад' - 'orad')
                  else e.item end order by e.ord)
                  from jsonb_array_elements(d.items) with ordinality e(item, ord))
  from dt where d.tenant_id = dt.id and d.intent in ('coming_soon_status', 'coming_soon_in_reply');

do $$
declare tid uuid := (select id from tenants where slug = 'dalatech');
begin
  if exists (select 1 from deterministic_replies where tenant_id = tid and intent = 'ora_new_user_bonus')
     or exists (select 1 from deterministic_replies d, jsonb_array_elements(d.items) e(item)
                 where d.tenant_id = tid and e.item ->> 'body' = 'Ора' and ((e.item -> 'words') ? 'орад' or (e.item -> 'words') ? 'orad'))
     or exists (select 1 from reply_cases where tenant_id = tid and note like '%D-173%') then
    raise exception 'the revert did not restore every row';
  end if;
end $$;

commit;
