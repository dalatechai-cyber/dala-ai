-- A refusal that lacks a JUDGEMENT is not a refusal that lacks a FACT.
--
-- Measured 2026-09-21, turn 14 of Matrix's first real side-by-side. The customer wrote
-- «dund zergiin usend shuluun himi hedeer hiih ve» — *how much is straightening
-- chemistry for medium-length hair*. The model answered «Шулуун хими 430,000₮–510,000₮
-- байна.», which is the `Шулуун хими` row to the tögrög and is what the ancestor sent.
-- The outbound guard threw it away and the customer got the generic handoff.
--
-- The chain: `out_of_scope_topics.suitability_lat_himi` is a `stem_sequence` over
-- ["usend","himi"] within 40 codepoints, so "…usend shuluun himi hedeer…" fires it.
-- `reception/load.ts` then gave that rule `quotePrice: false` — because the table had no
-- column to say otherwise — which sets `refusedTopicBlocksPrice` and hands the guard an
-- EMPTY allow-list. Every numeral in the reply is then refused.
--
-- ## Why the blanket default was wrong, stated precisely
--
-- The blanket is justified in `outbound.ts` by Ш1's rule: on a refused topic, mention no
-- number at all, whatever its provenance — because a customer who writes «Хүүхдийн үс
-- 33,000₮ мөн үү?» has supplied the number that would make an echo read as confirmation
-- of the very thing the topic exists to refuse. That reasoning is sound and is kept.
--
-- It is reasoning about Ш1. `refusal_suitability` does not map to Ш1. It is absent from
-- `GATE_BY_RESPONSE_KIND` entirely, so it falls to `DEFAULT_GATE = 'Ш8'` — "not in the
-- knowledge base" — and «Шулуун хими» IS in the knowledge base, with a confirmed price.
-- So a rule written for one gate's semantics was being applied under a gate whose own
-- rule does not ask for it, for want of a column.
--
-- The distinction the column now lets a tenant express:
--
--   * We lack a FACT      — `photo_consultation`. We cannot see the picture, so we
--                           cannot know which service it is, so we must not price it.
--                           `quote_price = false`, and it stays false.
--   * We lack a JUDGEMENT — `suitability_*`. We know exactly what «Шулуун хими» costs;
--                           what we cannot say is whether it suits this person's hair.
--                           Refusing the judgement does not require refusing the price.
--
-- ## This migration changes NO behaviour on any tenant
--
-- The default is `false`, which is precisely what `toRules` already substituted for the
-- absent column. Every existing row keeps the semantics it has today and every reply
-- stays byte-identical. What changes is only that a tenant CAN now say otherwise.
--
-- Whether Matrix's five `suitability_*` rows should say otherwise is the founder's call
-- and is deliberately not made here: flipping them lets a suitability refusal carry a
-- price, and a price beside "I can't judge whether it suits you" can read as an
-- endorsement the guard cannot see. This migration hands him the switch, not the
-- decision. D-063's addendum is the reason the default is the conservative one: a
-- backfill default retroactively decides the semantics of every row already there, and
-- those rows are exactly the ones that motivated the change.
alter table out_of_scope_topics
  add column if not exists quote_price boolean not null default false;

comment on column out_of_scope_topics.quote_price is
  'May a reply on this refused topic still quote an approved price? Default false: a '
  'topic refused for want of a FACT (we cannot see the photograph) must not carry a '
  'number. Set true only where the refusal is a want of JUDGEMENT — the service is '
  'named and priced in the knowledge base, and only its suitability is unknowable. '
  'Read by reception/load.ts into GateRule.quotePrice; false is what empties the '
  'outbound guard allow-list.';
