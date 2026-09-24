-- A reply for a customer who says the bot misunderstood (founder, 2026-09-24, live on Matrix).
--
-- Measured: «usnii himi» (hair perm, in general) was answered «Усны хими 132,000₮–154,000₮»,
-- the customer wrote «us bish usnii himi» (not water — hair perm), and the bot answered
-- «Буруу ойлголоо. Усан хими 132,000₮–154,000₮» — the same answer, apology included.
--
-- `match_mode = 'on_correction'`: a row that never answers a message by itself. Its `stems`
-- are the tenant's own correction words («биш», «буруу», …). When the customer's message
-- carries one of them AND the reply about to be sent says what the previous reply said —
-- the same text, or the same prices — its `body` is sent instead. The words are data, so a
-- tenant writing in another language brings its own.
--
-- Additive: one value added to a CHECK. No row changes.

alter table deterministic_replies
  drop constraint if exists deterministic_match_mode_known;
alter table deterministic_replies
  add constraint deterministic_match_mode_known
  check (match_mode in ('whole_message', 'contains_stem', 'covers_message', 'on_topic', 'on_correction'));
