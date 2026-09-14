-- Matrix Eco Salon — `service_aliases` seed (D-075 step 1).
--
-- NOT APPLIED. Read the header before running it.
--
-- `service_aliases` has existed since `0001` with zero rows and no reader in `src/`.
-- `src/lib/services/match.ts` is the reader; these are the rows it reads. An alias is a
-- PHRASE, and every token in it must occur in the customer's message for the alias to
-- match — so a two-word alias is a stronger claim than a one-word one, and that is the
-- point rather than an accident.
--
-- Aliases are matcher stems, not customer-visible strings, so they are not gated on the
-- reading evening (D-067). What holds this file back is different: the `services` table's
-- eight rows and the salon's confirmed price list DISAGREE ABOUT THE NAMES, and an alias
-- points at a `service_id`. Measured 2026-09-15 against the confirmed list:
--
--     Афро хими  Омбре  Сор  Шулуун хими        four names match exactly
--     Office өнгө        confirmed list says «Оффис колор /Сор/»
--     CMC тос            confirmed list says «CMC тэжээл»      (тос = oil, тэжээл = nutrition)
--     CICA эмчилгээ      on the confirmed list as neither «Хими эмэгтэй / CICA»
--                        nor «CICA нөхөн сэргээх эмчилгээ»
--     Эмчилгээний хими   on the confirmed list at all — and it is the row nearest to the
--                        name the salon said does not exist
--
-- So four rows can take aliases today and four cannot, because a rename or a delete moves
-- the id they would point at. Section 2 is held for that reason and not because the
-- spellings are in doubt.

begin;

-- ---------------------------------------------------------------------------
-- 1. Safe to apply — the four names the confirmed list agrees with.
-- ---------------------------------------------------------------------------

insert into service_aliases (tenant_id, service_id, alias)
select t.id, s.id, v.alias
from tenants t
join services s on s.tenant_id = t.id
join (values
  -- Latin spellings. `containsStem` is a token-PREFIX match, so one stored form covers the
  -- inflections built on it: `sor` catches `sortoi`. No transliteration engine (D-067).
  ('Сор',         'sor'),
  ('Омбре',       'ombre'),
  ('Афро хими',   'afro khimi'),
  ('Шулуун хими', 'shuluun khimi'),
  -- Cyrillic short forms a customer plausibly types.
  ('Афро хими',   'афро'),
  ('Шулуун хими', 'шулуун хими')
) as v(service_name, alias) on v.service_name = s.name
where t.display_name = 'Matrix Eco Salon'
on conflict (tenant_id, alias) do nothing;

-- ---------------------------------------------------------------------------
-- 2. HELD — do not run until the salon has settled the names.
-- ---------------------------------------------------------------------------
--
-- «Оффис колор /Сор/» needs these, and needs them more than any other row on the list:
-- the parenthetical is bookkeeping, and requiring «сор» as a token means the natural
-- «оффис колор» reaches NOTHING. Measured: none before the alias, unique after it.
--
--   ('Office өнгө', 'оффис колор'),
--   ('Office өнгө', 'офис колор'),      -- one ф; the commoner spelling
--   ('Office өнгө', 'office ongo'),
--
-- «Хими эмэгтэй / CICA» has the same shape — «cica хими» reaches nothing without it:
--
--   ('CICA эмчилгээ', 'cica хими'),     -- IF that row is the one the price list calls
--                                       -- «Хими эмэгтэй / CICA». It may be neither.
--
-- And nothing is proposed for «Эмчилгээний хими» while it may not be a service.

commit;
