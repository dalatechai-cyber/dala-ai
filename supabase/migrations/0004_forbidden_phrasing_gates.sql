-- `forbidden_phrasings` cannot be matched, so the guard check that reads it is inert.
--
-- ## What is missing and why it matters
--
-- §6.7 item 7 is the outbound guard's per-gate forbidden-vocabulary check, and the
-- section calls it "the prompt rule AND the production detector" — the thing that turns
-- boundary hardening from a hope written into a prompt into a measured rate per tenant per
-- gate. It is also how you learn that hardening quietly stopped working after a model
-- version bump, which is otherwise invisible.
--
-- The table it reads has a single `phrase` column and no gate. Two consequences:
--
--   1. **No gate means the list must be flat**, and §6.7(a) is explicit that flattening
--      breaks it: «Санаа зоволтгүй» is forbidden for a health question and also fires on
--      «Санаа зоволтгүй, зогсоол манай барилгын ард байгаа» — a perfectly good parking
--      answer that would be replaced by the handoff line. Worse, a real breach and a
--      benign reply then increment the same counter, which destroys the rate the check
--      exists to produce.
--   2. **No stems means whole-phrase matching**, and §6.7(b) measured that this catches
--      roughly one inflection in six: `цаг авлаа` misses «Таны цагийг маргааш 15:00-д
--      авлаа», four words apart.
--
-- So the loader has been passing an empty map and the check has never been able to fire —
-- a guard that is built, tested, merged, and unreachable.
--
-- ## Both columns are nullable, deliberately
--
-- A row may exist purely to record evidence: `rationale`, `observed_at` and `evidence` are
-- the table's other half, and a phrasing observed but not yet reduced to stems is worth
-- keeping. `phrasing_is_matchable_or_documentary` makes the two states explicit rather
-- than letting a half-filled row look enforceable.
--
-- Additive: two nullable columns and one CHECK. No data is rewritten.

alter table forbidden_phrasings
  add column if not exists gate  text,
  add column if not exists stems text[];

-- Ordered stem sequences, matched within a 40-character window (§6.7b). An entry is
-- either enforceable (both set) or documentary (neither), never half of one.
alter table forbidden_phrasings
  drop constraint if exists phrasing_is_matchable_or_documentary;
alter table forbidden_phrasings
  add constraint phrasing_is_matchable_or_documentary
  check ((gate is null) = (stems is null));

-- A gate key is Ш0-Ш9. Written as an explicit list rather than a pattern so that a typo
-- fails at write time instead of producing a rule that silently matches no gate.
alter table forbidden_phrasings
  drop constraint if exists phrasing_gate_is_known;
alter table forbidden_phrasings
  add constraint phrasing_gate_is_known
  check (gate is null or gate in ('Ш0','Ш1','Ш2','Ш3','Ш4','Ш5','Ш6','Ш7','Ш8','Ш9'));

-- An enforceable row needs at least one stem: an empty array matches nothing and would
-- read as "this phrasing is guarded" while guarding nothing.
alter table forbidden_phrasings
  drop constraint if exists phrasing_stems_not_empty;
alter table forbidden_phrasings
  add constraint phrasing_stems_not_empty
  check (stems is null or cardinality(stems) > 0);
