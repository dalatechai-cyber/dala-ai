-- NOT APPLIED. DRAFT WORDING (awaiting the founder): Tara Яармаг (matrix-eco-salon) points a
-- customer to the website's price page for the two prices the list does not hold (founder,
-- 2026-10-04, answer 4): women's «Эмчилгээний хими» and «өнгө гаргалт». Never a price.
--
-- The same two rows as Парк Од's (`tara-park-od-after-onboarding.sql`, branch
-- claude/tara-park-od-tenant), BYTE FOR BYTE: intent, body, matcher, append placement, and
-- DISABLED. The branch gate wants the two branches' shared facts equal, and the founder wants one
-- price page for both. The line is appended after whatever else the reply says (for women's
-- «Эмчилгээний хими», after the men's row the model or `perm_types` gives).
--
-- Why disabled: today https://www.matrixecosalon.org/services.html still serves the OLD Matrix
-- site and its old prices. Switch both rows on (step 2 below, both branches the same day) only
-- once the new site is live at that address; at the domain move both bodies (and the booking
-- links) change to https://tarasalon.org/services.html in the move-day SQL for BOTH tenants.
--
-- CHECK BEFORE SWITCHING ON: the new site's price page (matrix_website data/services.json, list of
-- 2026-10-01) has NEITHER price either: «Эмчилгээний хими» only under men, no «өнгө гаргалт». The
-- line says «Үнийн мэдээллийг … үзнэ үү», so a customer will look for a price that is not there.
-- The founder decides: add both prices to the website (and then to both branches' price rows),
-- or keep the pointer as it is.
--
-- The link is also declared (dali.md B1) by a `price_page` contact row (`0083`, labelled
-- «Үнийн хуудас» in the prefix), inserted in step 2 with the switch: the model is shown an
-- appended line before it is added, and a model reply that repeats an undeclared link is
-- refused by the URL guard (outbound check 1) and replaced by the hand-off line. Step 2 needs
-- `0083` applied and a publish (contacts are compiled). Proposed for Парк Од too (NOTES.md).
--
-- Undo: the -revert.sql beside it.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if exists (select 1 from deterministic_replies where tenant_id = t and intent like 'price_page_%') then
    raise exception 'this file is already applied';
  end if;
end $$;

-- 1. The two rows, disabled.
insert into deterministic_replies (tenant_id, intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
select t.id, v.* from tenants t, (values
 ('price_page_color', 'Үнийн мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/services.html хуудаснаас үзнэ үү.', false, 'tenant_confirmed', 'contains_stem', 'append', '{"өнгө гаргал","өнгө гаргуул","өнгөө гаргуул","ungu gargal","ungu gargul","ongo gargal","ongo gargul","vngv gargal"}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('price_page_treatment_perm', 'Үнийн мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/services.html хуудаснаас үзнэ үү.', false, 'tenant_confirmed', 'matcher', 'append', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["эмчилгээний", "emchilgeenii", "emchilgeeni", "emchilgenii"]}, {"mode": "contains_stem", "stems": ["хими", "himi"]}, {"mode": "contains_stem", "stems": ["эмэгтэй", "emegtei", "emegtey"]}]}'::jsonb, false)
) as v(intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
 where t.slug = 'matrix-eco-salon';

-- Reply cases, INACTIVE until step 2 (a disabled row answers nothing). Deterministic once on:
-- the appended line is the row's own bytes.
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note, active)
select t.id, v.msg, null, array['https://www.matrixecosalon.org/services.html']::text[], '{}'::text[], v.note, false
  from tenants t, (values
  ('ungu gargalt hed ve', 'price page 2026-10-04: «өнгө гаргалт» gets the price page appended (founder, answer 4)'),
  ('emegtei emchilgeenii himi hed ve', 'price page 2026-10-04: women''s «Эмчилгээний хими» gets the price page appended (founder, answer 4)')
  ) as v(msg, note)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = v.msg);

commit;

-- 2. GO-LIVE STEP, only when the new site is live at https://www.matrixecosalon.org/services.html
--    (and `0083` is applied). Run for both branches the same day, then publish both.
--
-- begin;
-- update deterministic_replies d set enabled = true from tenants t
--  where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent like 'price_page_%';
-- insert into contact_points (tenant_id, kind, value)
-- select t.id, 'price_page', 'https://www.matrixecosalon.org/services.html' from tenants t where t.slug = 'matrix-eco-salon'
-- on conflict (tenant_id, kind) do update set value = excluded.value;
-- update reply_cases r set active = true from tenants t
--  where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'price page 2026-10-04%';
-- commit;
