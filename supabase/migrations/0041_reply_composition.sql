-- Rows that compose a reply rather than replace it (founder, 2026-09-24).
--
-- Three things a tenant must be able to say in DATA, each measured on Matrix's comparison
-- run of 2026-09-24:
--
-- 1. A line that is ADDED to an answer, never put in its place. Matrix's Tara Salon line
--    was a `deterministic_replies` row, so «Хаана байрладаг вэ?» got the rebrand sentence
--    and no address. `placement = 'append'` keeps the row's matcher and review exactly as
--    they are and changes what the row DOES: the reply is produced as normal, then the
--    body is added at the end. `replace` is the behaviour every existing row already has,
--    so it is the default and nothing that exists changes.
--
-- 2. A reply for a message that is ABOUT one thing and nothing else. `covers_message`
--    fires when some word of the message starts with one of `stems` AND every word is
--    either such a word or appears exactly in `cover_words`. «Энэ Тара салон мөн үү?» is
--    about the name; «Tara salon hayag haana baidag ve?» is not, because «hayag» is not a
--    word the name row lists. Whole words, not prefixes, in `cover_words`: a prefix «та»
--    would cover «тайралт» and a haircut question would be answered with the name.
--
-- 3. Prices rendered FROM the price list, in the tenant's order. `quote_services` names
--    price-list services; the reply is their rows as the compiled price list writes them,
--    in the order listed here, then `body`. The prices live in one place — the price list
--    — so a price change cannot leave a stale copy in this table. A row naming a service
--    the list does not carry does not fire.
--
-- And one on `out_of_scope_topics`:
--
-- 4. `grounded_only`: when this rule fires, the model may say only what the tenant's own
--    data says. A reply that is not is replaced by the rule's refusal line. Matrix's
--    suitability rules fired on «…har usni ungute usend orohu» and the model answered
--    that Оффис колор suits dark hair, which is in no row the salon wrote.
--
-- Additive: four columns with defaults and one widened CHECK. No row is rewritten, and
-- every default reproduces today's behaviour.

alter table deterministic_replies
  add column if not exists placement text not null default 'replace',
  add column if not exists cover_words text[] not null default '{}',
  add column if not exists quote_services text[] not null default '{}';

alter table deterministic_replies
  drop constraint if exists deterministic_placement_known;
alter table deterministic_replies
  add constraint deterministic_placement_known
  check (placement in ('replace', 'append'));

alter table deterministic_replies
  drop constraint if exists deterministic_match_mode_known;
alter table deterministic_replies
  add constraint deterministic_match_mode_known
  check (match_mode in ('whole_message', 'contains_stem', 'covers_message'));

alter table out_of_scope_topics
  add column if not exists grounded_only boolean not null default false;
