-- A deterministic reply row may use the gate's own matcher (founder, 2026-09-25, live on Matrix).
--
-- Measured: «Hi margaash tanaih ajilahu» (are you open tomorrow?) was answered with the whole
-- week's hours, and «Margaash … bvh niitiin amraltiin udur ym bn» (tomorrow is a public
-- holiday, isn't it?) with the price refusal. The right answers need two words together —
-- TOMORROW and WORKING (or HOLIDAY) — and no deterministic mode could say "and": every mode
-- here is "any stem" or "only these words".
--
-- `match_mode = 'matcher'`: the row fires when `matcher` fires, and `matcher` is exactly the
-- jsonb the gate's rules use (`gate/match.ts`: has_word, contains_stem, all_of, not, …), so
-- one tested parser decides both. A matcher that does not parse never fires — here a bad
-- row costs a model call, never a wrong answer.
--
-- Additive: one nullable column, one value added to a CHECK, and a CHECK that holds for
-- every existing row (none uses the new mode, and all of them have a null matcher).

alter table deterministic_replies
  add column if not exists matcher jsonb;

comment on column deterministic_replies.matcher is
  'D-126. The gate matcher (gate/match.ts MatcherSpec) for match_mode = matcher. Null for every other mode.';

alter table deterministic_replies
  drop constraint if exists deterministic_match_mode_known;
alter table deterministic_replies
  add constraint deterministic_match_mode_known
  check (match_mode in ('whole_message', 'contains_stem', 'covers_message', 'on_topic', 'on_correction', 'matcher'));

alter table deterministic_replies
  drop constraint if exists deterministic_matcher_only_in_matcher_mode;
alter table deterministic_replies
  add constraint deterministic_matcher_only_in_matcher_mode
  check ((match_mode = 'matcher') = (matcher is not null));
