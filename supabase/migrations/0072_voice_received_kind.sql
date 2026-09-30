-- A voice message is answered with a reviewed line, never silence (Дали standard G4).
--
-- A voice message has no text, so `meta/extract.ts` skips it and the worker only recorded it
-- as dropped: DalaTech had eight by 2026-09-19, none answered and nobody told. The worker
-- now always tells a person (`handover/needsPerson.ts`) and sends the tenant's
-- `voice_received` row when it is reviewed. The wording is the founder's
-- (`prompt/drafts/voice_received.mn.txt`); NO ROW IS INSERTED here.
--
-- The kind is in `MODEL_INVISIBLE_KINDS` (`gate/match.ts`) and must be DEPLOYED before any
-- tenant has a row of it: a row the compiled prefix does not expect moves `canned_hash` on
-- one side only and refuses every DM reply for that tenant until a republish (0033's order).
--
-- Additive: one row in a lookup table.

insert into canned_response_kinds (kind, description) values
  ('voice_received',
   'Дали G4. Sent when a customer sends a voice message with no text; the bot cannot play it. Served whole by the worker, never by the model. A person is told either way.')
on conflict (kind) do nothing;
