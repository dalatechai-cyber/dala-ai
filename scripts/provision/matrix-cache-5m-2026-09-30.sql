-- Tara Salon — Яармаг (slug matrix-eco-salon): prompt cache 1h -> 5m (founder, 2026-09-30,
-- approving docs/reports/2026-09-30-tara-spend.md lever 1). Supersedes matrix-cache-1h.sql.
--
-- Why: live traffic (25-30 Sep) was 2-5 conversations a day, so most conversations started
-- cold whatever the TTL. A cold call writes the whole ~16.5k-token prefix, and 88% of live
-- spend was those writes. A 1h write costs 2x the input rate; a 5m write costs 1.25x
-- (model_prices). Expected: about 37% off cache-write cost. Risk: turns more than 5 minutes
-- apart inside one conversation now miss where 1h would have hit.
--
-- `prompt_cache_mode` is read per request (worker/reception.ts, website/messageJob.ts) and by
-- settle.ts to price the write, so this is live the moment it commits; no republish.
-- Measured for two weeks in the daily report's cache line (D-161).
begin;

update tenants set prompt_cache_mode = '5m'
where slug = 'matrix-eco-salon' and prompt_cache_mode = '1h';

do $$
begin
  if (select prompt_cache_mode from tenants where slug = 'matrix-eco-salon') <> '5m' then
    raise exception 'matrix-eco-salon prompt_cache_mode is not 5m';
  end if;
end
$$;

commit;
