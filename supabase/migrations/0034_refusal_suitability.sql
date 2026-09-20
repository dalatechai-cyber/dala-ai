-- "Will this work on MY hair?" is a question this platform must never answer.
--
-- 2026-09-20. A live Matrix customer asked whether office colour takes on black-dyed hair.
-- The knowledge base does not say — measured, all seven documents read. What it does carry
-- is two adjacent true facts: office colour is «30 хувийн цайруулалт» (a technique), and
-- black-dyed hair «хоёр удаагийн будалтаар бор өнгөтэй болгож болно» (a different outcome).
-- The model bridged them and produced THREE different answers in 26 seconds — «Тийм ээ…
-- боломжтой», then a qualified yes, then «шууд орохгүй байх магадлалтай» — with a real
-- bleach percentage attached to the first.
--
-- **That is the price failure on a chemical surface**: a real number bound to an invented
-- relationship. Ш8 refuses what is "not in the knowledge base" and structurally cannot
-- catch it, because the parts ARE in the knowledge base and only the join is invented.
--
-- ## Why a refusal and not a better knowledge row
--
-- The honest answer to "does this suit my hair" is that nobody can know without seeing the
-- hair. A knowledge row would move the guess upstream, not remove it; the salon's own
-- reply to every such question is to have a stylist look. So the row sends them to a
-- person, full stop. Founder's wording, 2026-09-20.
--
-- A guard was considered and rejected for D-033's reason: there is no allow-list of true
-- claims, and a Mongolian deny-list of them is the input-filter fallacy `guard/outbound.ts`
-- rejects in its own header. The fix has to be upstream of the model.

insert into canned_response_kinds (kind, description) values
  ('refusal_suitability',
   'Whether a chemical service suits THIS customer''s hair — unanswerable without seeing it, so it goes to a person')
on conflict (kind) do nothing;
