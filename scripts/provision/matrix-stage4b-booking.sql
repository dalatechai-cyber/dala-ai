-- Matrix Eco Salon — Stage 4b: the booking URL.
--
-- `matrix-stage4-kb.sql` deliberately left `tenant_booking` empty, and said why: the URL
-- was evidenced from the ANCESTOR'S production behaviour rather than from an answer the
-- salon gave, `tenant_booking` has no `provenance` column in which to record that
-- difference, and evidence from a live bot is not the business confirming a fact (D-020).
--
-- The founder closed that on 2026-09-07: «Booking URL confirmed: https://www.matrixecosalon.org/.
-- It's what their own bot sends today.» So the URL is now tenant-confirmed and the row is
-- written. Nothing about the withholding was wrong — it was resolved by asking.
--
-- ## What this row actually turns on
--
-- Two things beyond the obvious, both in `reception/load.ts`:
--
--   * `allowedUrls` is built from THIS column, and `urlsNotAllowed` (`guard/outbound.ts`)
--     refuses model text carrying any link not in it. Before this row, a reply that
--     paraphrased the booking line and kept the URL was refused as `outbound_url`.
--   * `scriptShareExclusions` includes it, so the URL's Latin characters stop counting
--     against the 50% Cyrillic floor. That is why `booking_line` scores 94.7% rather
--     than 71%.
--
-- ## What this file still does NOT write
--
-- `deposit_rules`. The 20,000₮ / 10,000₮ deposits remain evidenced from the ancestor and
-- unconfirmed by the salon, and a deposit is a price. D-042 is the reason to care: the
-- booking link is currently hostage to a deposit figure nobody asked for, and writing an
-- unconfirmed number here would harden that ordering around a guess.
--
-- Idempotent: inserted only where absent, with an assertion that the stored URL is the
-- confirmed one, so a divergence fails loudly.

begin;

insert into tenant_booking (tenant_id, mode, booking_url)
select t.id, 'link', 'https://www.matrixecosalon.org/'
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (select 1 from tenant_booking b where b.tenant_id = t.id);

do $$
declare
  v_mode text;
  v_url  text;
begin
  select b.mode, b.booking_url into v_mode, v_url
    from tenant_booking b join tenants t on t.id = b.tenant_id
   where t.slug = 'matrix-eco-salon';

  if v_url is distinct from 'https://www.matrixecosalon.org/' or v_mode is distinct from 'link' then
    raise exception 'stage 4b: tenant_booking holds (%, %), not the confirmed link', v_mode, v_url;
  end if;
end $$;

commit;
