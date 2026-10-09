-- TEMPLATE, NOT APPLIED. Switches OFF the staff hand-off ping for ONE branch: removes its
-- Telegram target. Fill in the slug ('matrix-eco-salon' = Яармаг, 'tara-park-od' = Парк Од).
-- Takes effect at once. The `handoffs` / `staff_notifications` history is kept.
begin;

create temporary table _target on commit drop as select 'REPLACE_WITH_BRANCH_SLUG'::text as slug;

do $$
begin
  if (select slug from _target) not in ('matrix-eco-salon', 'tara-park-od') then
    raise exception 'set the branch slug (matrix-eco-salon or tara-park-od)';
  end if;
  if not exists (select 1 from handoff_targets h join tenants t on t.id = h.tenant_id join _target x on x.slug = t.slug where h.kind = 'telegram') then
    raise exception 'this branch has no Telegram target (already off)';
  end if;
end $$;

delete from handoff_targets h using tenants t, _target x
 where t.id = h.tenant_id and t.slug = x.slug and h.kind = 'telegram';

commit;
