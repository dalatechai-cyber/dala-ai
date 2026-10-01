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
| Phone numbers 76001888, 91005498 (91005498 replaced 80905498 on 2026-10-01, D-167) | `contact_points` (`phone`); five `canned_responses` (`handoff`, `refusal_no_promotion`, `refusal_price_unlisted`, `refusal_staff_schedule`, `refusal_suitability`); `deterministic_replies.salon_phone` (Яармаг only); `deterministic_replies.holiday_hours_note` (76001888); `reply_cases` «Утас хэд вэ». 76001888 is the shared main line of both Tara branches (`config/branch-groups.json` `allow_phones`) |
| Prices (identical in both branches, D-157) | `services` and `service_variants`; `faqs` «Үс их хуурай…» (two treatment prices); `deterministic_replies.dye_prices` and `perm_types` name services in `quote_services`, and the two «usnii himi» `reply_cases` expect perm_types' rows |

## Rebrand checklist

- [ ] **The day the new Tara domain goes live** (founder, 2026-09-30): replace
  `matrixecosalon.org` in the three places in the first row above, in one SQL transaction
  (`set local dala.canned_edit = 'republish'` for the `booking_line` row, D-163), then publish
  Tara at once (`scripts/publish/tenant.ts --slug matrix-eco-salon`). Check
  `config/external-fact-copies.json` for copies outside this repo.

## The price list of 2026-10-01 (D-167)

`scripts/provision/tara-price-list-2026-10-01.sql` (with its `-revert.sql`) brings in the
salon's 2026-10-01 price list, the children's services and 91005498. Not applied when written:
it is applied by the founder immediately before the publish (`docs/publish-mac.md`).

Open for the founder, not changed by that file (each changes what Дали says):

- Services off the new list are switched off, not deleted: Сахал засах, Угаалт, Үс хусах,
  Тэжээлийн тос, CMC тэжээл, Хими арчилт, Омбре, Оффис колор, Сор, Цайруулалт, Дунд/Урт үсний
  будаг. Three knowledge documents still describe some of them: «Сор, Оффис колор, омбре», «CICA
  ба CMC — эмчилгээ, хими биш» (CMC), and «Химийн үйлчилгээний төрлүүд», which says «Шулуун хими
  (сеттинг)» while the list now has Сэттинг хими and Шулуун хими as two services. The owner's
  first TARA Lumi price (380,000–460,000₮) was Оффис колор's: if TARA Lumi and TARA BLEND are the
  new names of Оффис колор and Омбре, those documents need rewording, not removal.
- The list has a SPECIAL stylist level; the deposit rules and the «Мастер ба 1-р зэргийн
  үсчин» document and `stylist_tier` reply name only Мастер and 1-р зэрэг.
- The signed salon Ш1 block still uses a children's price as its example of a forbidden topic
  (draft: `prompt/drafts/sh1_refusal_topics_children.salon.mn.txt`).
- KB «Салбарууд» says Tara has one branch and a second «удахгүй нээгдэнэ».

## History

Applied data changes are in `scripts/provision/` (files named `tara-*` and `matrix-*`).
