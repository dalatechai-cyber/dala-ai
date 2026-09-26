-- A tenant's reply LOOK, as a row (founder, 2026-09-26, D-133).
--
-- DalaTech approved a look for its price answers — the staff member's name once as a header,
-- then one line per price — and at most one emoji in the model's own words, none on a
-- complaint or a refusal. Tara is not affected. A look differs by tenant, so it is data:
-- `src/lib/reception/style.ts` reads it, and a tenant with no row (NULL) gets exactly what
-- it got before.
--
--   { "price_header": "💬 {service}", "price_line": "💰 {option}: {price}", "max_emoji": 1 }
--
-- Additive: one nullable column, no default, nothing existing changes. The templates only
-- re-lay rows that are already the tenant's price list; no number is ever typed from here.
alter table tenants add column reply_style jsonb;
comment on column tenants.reply_style is
  'The tenant''s reply look: price_header ({service}), price_line ({option}, {price}), max_emoji. NULL = none. D-133.';
