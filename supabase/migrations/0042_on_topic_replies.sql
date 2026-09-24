-- A reply row that follows a gate topic rather than the customer's words.
--
-- Founder, 2026-09-24, on hair-suitability questions: *"list the relevant services with
-- prices, then say the stylist decides what suits their hair. Refuse only when the answer
-- would be advice the salon's data doesn't contain."* The "then say" part is a line added
-- after the answer — an `append` row (0041) — and WHEN to add it is exactly when one of
-- the tenant's suitability rules fired. Those rules match ordered stem pairs
-- (`stem_sequence`), which no deterministic mode can express, and copying their stems into a
-- second table would be two lists of one fact.
--
-- So `match_mode = 'on_topic'`: `stems` holds `out_of_scope_topics.topic_key` /
-- `disclosure_rules.topic_key` values, and the row fires when any of those topics fired on
-- this message. The gate stays the one place that decides what the message is about.
--
-- Additive: one value added to a CHECK. No row changes.

alter table deterministic_replies
  drop constraint if exists deterministic_match_mode_known;
alter table deterministic_replies
  add constraint deterministic_match_mode_known
  check (match_mode in ('whole_message', 'contains_stem', 'covers_message', 'on_topic'));
