-- `deterministic_replies` stores a reply and no way to decide when to send it.
--
-- The applied table is (tenant_id, intent, body, enabled): a sentence with no matcher.
-- §6.8 specifies match_mode, stems and requires_empty_history, and without them the
-- pre-model layer cannot exist — which matters because §6.3.8 prices the replies it would
-- absorb, where the model is paid to retype a canned row, at ₮26,300/tenant-month. That
-- is the largest single saving in the design and it was unreachable.
--
-- ## Every default is the safe direction
--
--   match_mode 'whole_message'      §6.8 rule 2: the only mode used for greetings, because
--                                   a greeting shortcut that fires on a PREFIX is a bug
--                                   factory. The ancestor's GREETING_REGEX is anchored
--                                   left and open right, so «Уучлаарай асуумаар байна» —
--                                   among the commonest openers in Mongolian customer
--                                   service — was classified as a greeting and that
--                                   customer's question was never answered.
--   stems '{}'                      A row with no stems matches nothing. New rows are
--                                   inert until somebody says when they fire.
--   requires_empty_history true     Greeting a customer mid-conversation is worse than
--                                   missing a greeting, and §6.8 rule 4 is explicit that a
--                                   missed greeting costs ₮39 while a stolen question
--                                   costs a customer.
--
-- ## An ENABLED row must be able to fire
--
-- `enabled_rule_can_match` makes "enabled with no matcher" impossible. Without it a row
-- reads as live on the dashboard, never fires, and the absence is invisible — the exact
-- shape of failure this repository keeps finding.
--
-- Additive: three columns with defaults, and one CHECK. No data is rewritten.

alter table deterministic_replies
  add column if not exists match_mode text not null default 'whole_message',
  add column if not exists stems text[] not null default '{}',
  add column if not exists requires_empty_history boolean not null default true;

alter table deterministic_replies
  drop constraint if exists deterministic_match_mode_known;
alter table deterministic_replies
  add constraint deterministic_match_mode_known
  check (match_mode in ('whole_message', 'contains_stem'));

alter table deterministic_replies
  drop constraint if exists enabled_rule_can_match;
alter table deterministic_replies
  add constraint enabled_rule_can_match
  check (not enabled or cardinality(stems) > 0);
