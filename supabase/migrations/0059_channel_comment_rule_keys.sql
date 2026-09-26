-- Which of the tenant's comment rules a channel reads (D-145, founder 2026-09-26).
--
-- Comment rules are per tenant. DalaTech's Instagram answers «1» and nothing else until the
-- founder decides what a real question on Instagram should get, while its Facebook Page
-- keeps every rule it has today. So a channel may name the rules it reads: when
-- `comment_rule_keys` is set, only those rules classify its comments, and every other comment
-- is unclassified — silent, and recorded for the to-do list.
--
-- Additive. NULL (every existing row) means every rule, which is today's behaviour.

alter table tenant_channels
  add column if not exists comment_rule_keys text[];

comment on column tenant_channels.comment_rule_keys is
  'D-145. When set, only these comment_rules (by rule_key) classify this channel''s comments; everything else is unclassified. NULL: every rule.';
