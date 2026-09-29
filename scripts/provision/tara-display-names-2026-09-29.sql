-- Founder's brief of 2026-09-29: the Tara Salon tenants are named per branch.
--
-- The salon is two businesses under one brand. `tenants.display_name` is the name Bilguun
-- reads (daily report, flaw report, Telegram alerts, billing alerts, onboarding documents),
-- and the live one still said «Matrix Eco Salon»:
--
--   «Tara Salon — Яармаг»  slug matrix-eco-salon, Page «Tara salon яармаг салбар» (live)
--   «Tara Salon — Парк Од» not a tenant yet; onboarding creates it with
--                          `scripts/onboard/tenant.ts … --display-name "Tara Salon — Парк Од"`
--
-- Only the name. The slug, the id, every channel, the prompt and every sentence a customer
-- reads are untouched: nothing on the reply path or in the compiled prompt reads
-- `display_name` (the Mongolian «Tara Salon» the bot says lives in `canned_responses`, the
-- KB and the prompt, all unchanged). `former_names` already holds «Matrix» and «Матрикс».
--
-- Guarded by id AND slug, so it cannot touch another row; idempotent; refuses if the row
-- is not exactly where it should end up.
begin;
update tenants
   set display_name = normalize('Tara Salon — Яармаг', NFC)
 where id = '8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06' and slug = 'matrix-eco-salon'
   and display_name is distinct from normalize('Tara Salon — Яармаг', NFC);

do $$ declare n int; begin
  select count(*) into n from tenants
   where id = '8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06' and slug = 'matrix-eco-salon'
     and display_name = normalize('Tara Salon — Яармаг', NFC);
  if n <> 1 then raise exception 'Yarmag tenant not renamed (% rows)', n; end if;
  select count(*) into n from tenants where display_name ilike '%matrix%';
  if n <> 0 then raise exception '% tenants still named Matrix', n; end if;
end $$;
commit;
