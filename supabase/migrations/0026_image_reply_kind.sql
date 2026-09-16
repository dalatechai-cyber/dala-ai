-- A customer who sends a photograph gets an answer.
--
-- `meta/extract.ts` skips an attachment with no text, and between 2026-09-15 and
-- 2026-09-16 that dropped FOUR real photographs sent to a hair salon — recorded as
-- `inbound_dropped` rows with `attachments: ["image"]` and no `sticker_ids`, which is
-- exactly the case D-070 predicted and built the instrument to expose.
--
-- The ancestor answers these with one fixed line and has done for weeks, so the silence
-- is a measured regression against the bot this platform replaces. `image_received` is
-- the row that ends it: served whole by `inbound/imageReply.ts`, never generated, so
-- nothing can be inferred from a picture the model cannot see.
--
-- Adding the KIND only. The tenant's sentence is founder-gated Mongolian and arrives as
-- a `canned_responses` row with `reviewed_at` null until the reading evening; the path
-- refuses to serve an unreviewed row, so this migration is inert on its own.
insert into canned_response_kinds (kind, description) values
  ('image_received',
   'Sent when a customer''s message is only a photograph: says the assistant cannot see images and asks for the request in words. Never model-generated.')
on conflict (kind) do nothing;
