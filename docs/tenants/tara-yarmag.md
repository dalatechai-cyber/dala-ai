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
| Address and map link | `contact_points` (`address`, `maps_url`); `deterministic_replies.address` (2026-09-30); `reply_cases` «Хаяг хаана вэ». Moving in November 2026: `scripts/provision/tara-yarmag-move-2026-11.sql` |
| Парк Од's address, Page and the shared line (D-170) | KB «Салбарууд»; `deterministic_replies.park_od_branch`; `config/branch-groups.json` `allow_addresses` (must equal Парк Од's address row) |
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

D-169 (founder, 2026-10-01): SPECIAL's deposit is Мастер's, «SPECIAL үсчин: 20,000₮»;
«тонирование» in the knowledge is Өнгөлөгч будаг and now says so; the stylist-level reply and
document naming all three levels wait for the founder's approval of
`prompt/drafts/tara_stylist_levels.mn.txt` (`scripts/provision/tara-stylist-levels-2026-10-01.sql`).

D-170 (founder, 2026-10-01): Парк Од is open. `tara-branches-2026-10-01.sql` (waits for the
founder's approval of `prompt/drafts/tara_branches.mn.txt`) makes «Салбарууд» say Tara has two
branches with Парк Од's address and the shared line, and adds the fixed reply `park_od_branch`
(address, 76001888, Парк Од's Facebook Page). `tara-yarmag-move-2026-11.sql` is ready for the day
Яармаг moves to Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар (date to
come); it changes the address row and the fixed address reply and drops the map link. The
branch keeps the name «Яармаг салбар» after the move (founder, 2026-10-01).

Still open: the matcher word
«хими»/«himi» points at Эмчилгээний хими (now the men's perm).

## History

Applied data changes are in `scripts/provision/` (files named `tara-*` and `matrix-*`).
