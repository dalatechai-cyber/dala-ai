-- APPLIED 2026-09-30 14:36 UTC (D-165). Tara Яармаг's take-back line (D-164), approved by the founder 2026-09-30, option (b):
--   «Уучлаарай, хүлээлгэсэнд. Би үргэлжлүүлэн туслая. Танд юугаар туслах вэ?»
-- This row switches the staff-hold reclaim ON for this tenant only: with no reviewed
-- `handover_reclaim` row the sweep is inert (`no_reviewed_line`). DalaTech gets no row.
--
-- `handover_reclaim` is a model-invisible kind (MODEL_INVISIBLE_KINDS), so the row does not
-- move `canned_hash`, the 0074 trigger allows it, and no republish is needed.
--
-- To switch it off again: delete this row (or set reviewed_at = null).
begin;

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'handover_reclaim', t.default_locale,
       'Уучлаарай, хүлээлгэсэнд. Би үргэлжлүүлэн туслая. Танд юугаар туслах вэ?',
       'founder', now()
  from tenants t
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from canned_responses c
                    where c.tenant_id = t.id and c.kind = 'handover_reclaim' and c.locale = t.default_locale);

commit;
