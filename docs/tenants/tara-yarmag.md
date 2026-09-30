# Tara Salon — Яармаг (tenant #1, slug `matrix-eco-salon`)

The slug is an identifier and keeps the old Matrix name on purpose. Customer-facing name:
«Tara Salon». A separate branch, «Tara Salon — Парк Од», is its own tenant (D-157); nothing
below is copied to it.

## Rows that type a fact, and must change with it

A `deterministic_replies` body is sent verbatim with no model, so a fact typed there is a
second copy nothing re-derives. Change these in the same change as the fact.

| Fact | Where it is typed |
|---|---|
| Booking domain `matrixecosalon.org` | `tenant_booking.booking_url`; `canned_responses.booking_line`; `deterministic_replies.booking` (2026-09-30) |
| Address and map link | `contact_points` (`address`, `maps_url`); `deterministic_replies.address` (2026-09-30) |
| Phone numbers 76001888, 80905498 | `contact_points` (`phone`); most `canned_responses` refusal rows and `handoff` (search the bodies); `deterministic_replies.salon_phone` (Яармаг only, 2026-09-30); `deterministic_replies.holiday_hours_note` (76001888) |

## Rebrand checklist

- [ ] **The day the new Tara domain goes live** (founder, 2026-09-30): replace
  `matrixecosalon.org` in the three places in the first row above, in one SQL transaction
  (`set local dala.canned_edit = 'republish'` for the `booking_line` row, D-163), then publish
  Tara at once (`scripts/publish/tenant.ts --slug matrix-eco-salon`). Check
  `config/external-fact-copies.json` for copies outside this repo.

## History

Applied data changes are in `scripts/provision/` (files named `tara-*` and `matrix-*`).
