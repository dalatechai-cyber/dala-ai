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
| Hairdressers' names and levels (2026-10-03: short Latin names) | `staff_members` (`name`, `short_name`, `tier`, `active`); KB «Салбарууд» (Oyunaa) and «Үсчдийн нэр» (the old Cyrillic names); `deposit_rules` labels («SPECIAL үсчин», «Мастер үсчин», «1-р зэргийн үсчин») correspond to the tiers (not byte-equal: the tier reads «1-р зэрэг үсчин»); the website's `config/stylists.js` (matrix_website) |
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

D-170 (founder, 2026-10-01): Парк Од is open. `tara-branches-2026-10-01.sql` (wording approved
2026-10-01, with «Хоёр салбарын үнэ ижил.»; ready to apply) makes «Салбарууд» say Tara has two
branches with Парк Од's address and the shared line, and adds the fixed reply `park_od_branch`
(address, 76001888, Парк Од's Facebook Page). `tara-yarmag-move-2026-11.sql` is ready for the day
Яармаг moves to Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар (date to
come); it changes the address row and the fixed address reply and drops the map link. The
branch keeps the name «Яармаг салбар» after the move (founder, 2026-10-01).

Still open: the matcher word
«хими»/«himi» points at Эмчилгээний хими (now the men's perm).

Read 2026-10-03 (read-only): the price list, branches and stylist-level files above are
already applied on the project (the level document is titled «SPECIAL, Мастер ба 1-р зэргийн
үсчин», the fixed reply `park_od_branch` exists).

## The hairdressers' new names (2026-10-03, NOT applied)

The founder (2026-10-03): hairdressers are shown everywhere by short Latin names, exactly as
written, also inside Mongolian sentences. `scripts/provision/tara-yarmag-stylist-names-2026-10-03.sql`
(with its `-revert.sql`) waits for approval of `prompt/drafts/tara_stylist_names.mn.txt`:

| Now (live rows, read 2026-10-03) | After | Level |
|---|---|---|
| Оюунсүрэн (Оюунаа), Мастер үсчин | **Oyunaa** (Оюунаа) | SPECIAL үсчин (founder: she is SPECIAL; the owner) |
| Бадамцэцэг (Бадмаа) | **Badamaa** (Бадмаа) | Мастер үсчин, kept |
| Уянга | **Uyanga** (Уянга) | 1-р зэрэг үсчин, kept |
| Батзаяа | **Zaya** (Заяа) | 1-р зэрэг үсчин, kept |
| Ананд, inactive | **Anand** (Ананд), switched on, «Эрэгтэй үсчид», the only man | Мастер үсчин, kept |
| (no row) | **Chimgee** (Чимгээ; was Уранчимэг), added | 1-р зэрэг үсчин (the website's level; dala-ai had none) |
| Отгонжаргал, active | switched off: not in the founder's list (flagged) | — |
| Г. Мөнхзаяа, «Маникюр баг», active | switched off: manicure is off at Tara | — |

The Cyrillic in brackets is each person's `short_name`, the form customers type (0019; the
roster renders «Oyunaa (Оюунаа)»). The full old names (Оюунсүрэн, Бадамцэцэг, Батзаяа,
Уранчимэг) are in a new knowledge document «Үсчдийн нэр», and «Салбарууд»'s line «Оюунаа Яармаг
салбарт ажилладаг.» becomes «Oyunaa Яармаг салбарт ажилладаг.». No canned line, fixed reply,
FAQ, reply case, comment rule, topic or service alias names a hairdresser (read 2026-10-03), so
nothing else changes and the canned-edit guard is not engaged. Apply, then publish Яармаг at
once (`node scripts/publish/tenant.ts --slug matrix-eco-salon`, dry run, then `--publish`).
Proven on a local replica of her rows: it applies, refuses a second run, reverts to the bytes
read, re-applies; the branch and facts gates are clean.

Levels: dala-ai's rows agree with the website's for everyone kept (Бадамцэцэг Мастер; Батзаяа,
Уянга 1-р зэрэг; Ананд Мастер); Оюунсүрэн moves from Мастер to SPECIAL on the founder's word.
Found on the way, not changed: the canned `refusal_service_unavailable` («Манай салон одоогоор
хумсны үйлчилгээ үзүүлэхгүй байна.») and the topic `nail_services` still answer nail questions
by saying the salon does not offer them; whether that line stays is the founder's call.

## History

Applied data changes are in `scripts/provision/` (files named `tara-*` and `matrix-*`).
