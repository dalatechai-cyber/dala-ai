-- A service the business USED to offer is a third kind of "no", and it had no row.
--
-- Matrix stopped doing nails (founder, 2026-09-21). The eleven `Маникюр`/`Педикюр`
-- services are deactivated, so the price list no longer carries them — and a customer who
-- asks «Маникюр хэд вэ?» then falls to `refusal_price_unlisted`: *"I don't have price
-- information for this service."* That is true about the price and WRONG about the salon:
-- it implies the service exists and only its price is missing, so the customer rings up to
-- book something that is gone.
--
-- The three existing "no" kinds each say something different and none of them says this:
--
--   refusal_price_unlisted  — we do it; the price is not in my knowledge base
--   refusal_out_of_scope    — we cannot know the answer
--   refusal_topic           — a deliberate omission bound to a disclosure rule
--   refusal_service_unavailable (new) — we do not offer this at all
--
-- Adding the KIND only. The sentence is a tenant `canned_responses` row and is
-- founder-gated: «Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна.» was approved
-- 2026-09-21, and the path refuses an unreviewed row, so a tenant that has not written one
-- is unaffected by this migration.
--
-- It is deliberately NOT mapped in `GATE_BY_RESPONSE_KIND`, so it falls to `DEFAULT_GATE`
-- (Ш8). That is correct here rather than a gap: Ш8's forbidden vocabulary is hedging
-- («магадгүй», «ихэвчлэн»), which is exactly what must not appear beside "we no longer
-- offer this".
insert into canned_response_kinds (kind, description) values
  ('refusal_service_unavailable',
   'A service the business does not offer AT ALL — discontinued or never offered. Distinct from refusal_price_unlisted, which says the service exists and only its price is unknown.')
on conflict (kind) do nothing;
