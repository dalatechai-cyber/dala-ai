-- Undo tara-yarmag-deposit-and-level-2026-10-04.sql for Tara Яармаг (matrix-eco-salon): the two
-- fixed replies, the FAQ and the seventeen reply cases go. Then publish Яармаг again (the FAQ is
-- in the compiled prompt).
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from deterministic_replies where tenant_id = t and intent in ('deposit_required', 'stylist_tier_after_deposits')) <> 2 then
    raise exception 'tara-yarmag-deposit-and-level-2026-10-04.sql is not applied';
  end if;
end $$;

delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'deposit and level 2026-10-04%';

delete from faqs f using tenants t, deterministic_replies d
 where t.slug = 'matrix-eco-salon' and f.tenant_id = t.id and f.ordinal = 15
   and d.tenant_id = t.id and d.intent = 'deposit_required' and f.answer = d.body;

delete from deterministic_replies d using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent in ('deposit_required', 'stylist_tier_after_deposits');

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from deterministic_replies where tenant_id = t and intent in ('deposit_required', 'stylist_tier_after_deposits'))
     or exists (select 1 from faqs where tenant_id = t and ordinal = 15)
     or exists (select 1 from reply_cases where tenant_id = t and note like 'deposit and level 2026-10-04%') then
    raise exception 'read-back: something of the file is left';
  end if;
end $$;

commit;
