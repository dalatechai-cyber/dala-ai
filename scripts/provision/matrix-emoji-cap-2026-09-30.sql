-- Tara Salon — Яармаг (slug matrix-eco-salon): at most one emoji in the model's own words
-- (founder, 2026-09-30, approving docs/reports/2026-09-30-spend-alerts.md decision 2).
--
-- Only `max_emoji`. No price templates, so her price layout is exactly as before. Approved rows
-- are served whole and never touched; on a complaint or a refusal every model emoji is removed
-- (`src/lib/reception/style.ts`). `reply_style` is read per request (`reception/load.ts`), so this
-- is live the moment it commits; no republish.
--
-- Evidence: her 17 reviewed rows carry at most one emoji; of 280 replies in the 30 days to
-- 2026-09-30, 3 carried two. Guarded on `reply_style is null` so it cannot overwrite a look set since.
begin;

do $$
begin
  if not exists (select 1 from tenants where slug = 'matrix-eco-salon') then
    raise exception 'no tenant with slug matrix-eco-salon';
  end if;
end
$$;

update tenants set reply_style = '{"max_emoji": 1}'::jsonb
where slug = 'matrix-eco-salon' and reply_style is null;

do $$
begin
  if (select reply_style from tenants where slug = 'matrix-eco-salon') is distinct from '{"max_emoji": 1}'::jsonb then
    raise exception 'matrix-eco-salon reply_style is not {"max_emoji": 1}';
  end if;
end
$$;

commit;
