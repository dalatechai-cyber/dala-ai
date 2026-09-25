-- A `matcher` row can match without stems (D-126, follow-up to 0048).
--
-- `enabled_rule_can_match` (0005) says an enabled deterministic row must carry stems, because
-- until 0048 stems were the only thing a row matched on. A `match_mode = 'matcher'` row
-- matches on `matcher` and carries no stems, so the CHECK refused the first real one. It now
-- asks the question it was written to ask — can this enabled row match anything — for both
-- kinds: stems, or a matcher (which 0048 already requires exactly in matcher mode).
--
-- WIDENS a CHECK and narrows nothing: every row that passed the old one passes this one.

alter table deterministic_replies
  drop constraint if exists enabled_rule_can_match;
alter table deterministic_replies
  add constraint enabled_rule_can_match
  check (not enabled or cardinality(stems) > 0 or (match_mode = 'matcher' and matcher is not null));
