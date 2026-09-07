-- Matrix Eco Salon — the spend ceiling for the 14-day shadow run.
--
-- Founder-approved 2026-09-07: daily $2.00, monthly $20.00, alert at 80%,
-- `on_exhausted = canned_reply`, and the two circuit-breakers left at tenant #0's 25/40.
-- Money movement is a founder-gated category; these numbers are theirs, not mine.
--
-- Applied AFTER `matrix-cache-1h.sql`, deliberately: the ceilings were sized against the
-- cached per-reply cost, so a budget landing first would have been sized for a state the
-- tenant was no longer in.
--
-- ## Where the numbers come from
--
-- D-016 measured the ancestor at 60.5 replies/day (six days, range 28-94) and $0.0090 per
-- reply — a CACHED figure, since the ancestor sets a 1h TTL. Matrix's compiled prefix is
-- 12,313 characters against the ancestor's 11,321, so 1.088x, plus ~1,016 uncached tokens
-- of canned section that the ancestor carries inside its cached block. That gives roughly
-- $0.012 per reply cached, and ~$0.022 uncached.
--
--   * DAILY $2.00 is ~167 replies at $0.012 — 1.8x the busiest day in six days of measured
--     production logs, and 2.8x the mean. It exists to cap a loop, not to shape a week.
--   * MONTHLY $20.00 covers the whole 14-day run (~$10 at the mean, ~$16 if every day were
--     a peak day) and still sits UNDER the ₮80,000 ≈ $22.86 commercial ceiling, so the
--     shadow cannot cost more than the plan it exists to prove.
--
-- `per_conversation_replies_24h` and `per_contact_replies_24h` stay at 25/40. They are
-- circuit-breakers against a loop, not budget shaping — the budget is the budget.
--
-- `set_by` is null because `platform_admins` is empty; the approval is in this file's git
-- history instead, which is worse and is the third column now waiting on that table.
--
-- Idempotent, and asserts the end state rather than assuming the insert landed.

begin;

insert into tenant_budgets
  (tenant_id, effective_from, monthly_ceiling_nanousd, daily_ceiling_nanousd,
   per_conversation_replies_24h, per_contact_replies_24h,
   alert_threshold_pct, on_exhausted, ceiling_reason, set_by)
select t.id, now(), 20000000000, 2000000000,
       25, 40, 80, 'canned_reply', '14-day shadow run, D-016 volume', null
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (select 1 from tenant_budgets b where b.tenant_id = t.id);

do $$
declare b record;
begin
  select bb.* into b
    from tenant_budgets bb join tenants t on t.id = bb.tenant_id
   where t.slug = 'matrix-eco-salon'
   order by bb.effective_from desc limit 1;

  if b is null then raise exception 'budget: no row for matrix-eco-salon'; end if;
  if b.daily_ceiling_nanousd <> 2000000000 then
    raise exception 'budget: daily is % nanoUSD, not the approved $2.00', b.daily_ceiling_nanousd;
  end if;
  if b.monthly_ceiling_nanousd <> 20000000000 then
    raise exception 'budget: monthly is % nanoUSD, not the approved $20.00', b.monthly_ceiling_nanousd;
  end if;
  if b.on_exhausted <> 'canned_reply' then
    raise exception 'budget: on_exhausted is %, not canned_reply — a hard stop is not the §5.7 ladder', b.on_exhausted;
  end if;
  -- The daily ceiling must divide into the monthly one sensibly: a daily above the monthly
  -- is a ceiling that can never bind, and a monthly below one day's spend is a tenant that
  -- dies on day one. Neither is a state anyone would notice from reading the two numbers.
  if b.daily_ceiling_nanousd > b.monthly_ceiling_nanousd then
    raise exception 'budget: the daily ceiling exceeds the monthly one';
  end if;
end $$;

commit;
