# Tara Salon — Яармаг (tenant #1, slug `matrix-eco-salon`)

The slug is an identifier and keeps the old Matrix name on purpose. Customer-facing name:
«Tara Salon». A separate branch, «Tara Salon — Парк Од», is its own tenant (D-157); nothing
below is copied to it.

## Rows that type a fact, and must change with it

A `deterministic_replies` body is sent verbatim with no model, so a fact typed there is a
second copy nothing re-derives. Change these in the same change as the fact.

| Fact | Where it is typed |
|---|---|
| Welcome line (greeting) | `deterministic_replies.greeting` and its copy `like_welcome` (D-168): change both together |
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

The founder's decisions of 2026-10-01 (D-168) are in the same file:

- Old services and prices are gone from what Дали reads. The «Сор, Оффис колор, омбре» document
  is deleted; «CICA ба CMC» becomes «CICA — эмчилгээ, хими биш» without its CMC, тэжээлийн тос
  and course sentences; «Шулуун хими (сеттинг)» becomes «Шулуун хими» (Сэттинг хими is its own
  service); the CICA / тэжээлийн тос FAQ is deleted; four earlier turns in the reply cases'
  recorded history carry today's list. Services off the list stay switched off, not deleted.
- «Хүүхдийн тайралт (охин)»: the women's-section children's haircut is the girls' haircut.
- The Messenger like: the row `like_welcome` (the welcome row's own bytes, empty history only)
  and the stem `like` on `acknowledgement`.
- The salon Ш1 block no longer uses a children's price as its example (migration 0076).

Still open: the SPECIAL level has no deposit row (founder, 2026-10-01: left out until an amount
is given); the «Мастер ба 1-р зэргийн үсчин» document and `stylist_tier` reply name only Мастер
and 1-р зэрэг; KB «Салбарууд» says a second branch «удахгүй нээгдэнэ»; the matcher word
«хими»/«himi» points at Эмчилгээний хими (now the men's perm); the knowledge still names
«мелировка», «OTG будаг» and «тонирование» (techniques and products, not list services; whether
тонирование is Өнгөлөгч будаг is a language question for the founder).

## History

Applied data changes are in `scripts/provision/` (files named `tara-*` and `matrix-*`).
