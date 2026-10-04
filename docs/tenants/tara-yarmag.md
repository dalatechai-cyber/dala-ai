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
| Booking domain `matrixecosalon.org` | `tenant_booking.booking_url`; `canned_responses.booking_line`; `deterministic_replies.booking` (2026-09-30); `deterministic_replies.deposit_required` and FAQ 15 «Заавал эхлээд урьдчилгаа төлөх үү?» (2026-10-04, D-179) |
| Address and map link | `contact_points` (`address`, `maps_url`); `deterministic_replies.address` (2026-09-30); `reply_cases` «Хаяг хаана вэ». Moving in November 2026: `scripts/provision/tara-yarmag-move-2026-11.sql` |
| Парк Од's address, Page and the shared line (D-170) | KB «Салбарууд»; `deterministic_replies.park_od_branch`; `config/branch-groups.json` `allow_addresses` (must equal Парк Од's address row) |
| Яармаг's own address as Парк Од gives it (symmetric, 2026-10-04) | Парк Од's KB «Салбарууд» and `deterministic_replies.yarmag_branch`; `allow_addresses` (lists the current address and the VIP Center one). The move file changes both tenants |
| Phone numbers 76001888, 91005498 (91005498 replaced 80905498 on 2026-10-01, D-167) | `contact_points` (`phone`); five `canned_responses` (`handoff`, `refusal_no_promotion`, `refusal_price_unlisted`, `refusal_staff_schedule`, `refusal_suitability`); `deterministic_replies.salon_phone` (Яармаг only); `deterministic_replies.holiday_hours_note` (76001888); `reply_cases` «Утас хэд вэ». 76001888 is the shared main line of both Tara branches (`config/branch-groups.json` `allow_phones`) |
| Hairdressers' names and levels (2026-10-03: short Latin names; 2026-10-04: Latin everywhere) | `staff_members` (`name`, `tier`, `active`; `short_name` empty, so the roster is Latin only); KB «Салбарууд» (Oyunaa) and «Үсчдийн нэр» (the Cyrillic names customers type); `deposit_rules` labels («SPECIAL үсчин», «Мастер үсчин», «1-р зэргийн үсчин») equal the tiers; the website's `config/stylists.js` (matrix_website) |
| Prices (identical in both branches, D-157) | `services` and `service_variants`; `faqs` «Үс их хуурай…» (two treatment prices); `deterministic_replies.dye_prices` and `perm_types` name services in `quote_services`, and the two «usnii himi» `reply_cases` expect perm_types' rows |

## Rebrand checklist

- [ ] **The day the new Tara domain goes live** (tarasalon.org, bought at Namecheap; founder
  2026-10-04): replace `matrixecosalon.org` in the places in the first row above, and in
  every Парк Од row that carries it (docs/tenants/tara-park-od.md «Domain»), in one SQL transaction
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
(address, 76001888, Парк Од's Facebook Page; D-178, 2026-10-04: her number is 99076874 and the
«нийтлэг утас» line becomes each branch's own numbers, `tara-yarmag-branch-phones-2026-10-04.sql`,
applied after the stylist-names file and before the publish). `tara-yarmag-move-2026-11.sql` is ready for the day
Яармаг moves to Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар (date to
come); it changes the address row and the fixed address reply and drops the map link. The
branch keeps the name «Яармаг салбар» after the move (founder, 2026-10-01).

Still open: the matcher word
«хими»/«himi» points at Эмчилгээний хими (now the men's perm).

Read 2026-10-03 (read-only): the price list, branches and stylist-level files above are
already applied on the project (the level document is titled «SPECIAL, Мастер ба 1-р зэргийн
үсчин», the fixed reply `park_od_branch` exists).

## The hairdressers' new names (2026-10-03; round 2 2026-10-04; NOT applied)

The founder (2026-10-03): hairdressers are shown everywhere by short Latin names, exactly as
written, also inside Mongolian sentences. Approved 2026-10-04 with two changes: Latin in the
roster the model reads too (Cyrillic only in «Үсчдийн нэр»), and «1-р зэргийн үсчин», never
«1-р зэрэг үсчин». `scripts/provision/tara-yarmag-stylist-names-2026-10-03.sql` (with its
`-revert.sql`):

| Now (live rows, read 2026-10-03 and 2026-10-04) | After | Level |
|---|---|---|
| Оюунсүрэн (Оюунаа), Мастер үсчин | **Oyunaa** | SPECIAL үсчин (founder: she is SPECIAL; the owner) |
| Бадамцэцэг (Бадмаа) | **Badamaa** | Мастер үсчин, kept |
| Уянга | **Uyanga** | 1-р зэргийн үсчин (the level kept; the wording fixed) |
| Батзаяа | **Zaya** | 1-р зэргийн үсчин |
| Ананд, inactive | **Anand**, switched on, «Эрэгтэй үсчид», the only man | Мастер үсчин, kept |
| (no row) | **Chimgee** (was Уранчимэг), added | 1-р зэргийн үсчин (the website's level; dala-ai had none) |
| Отгонжаргал, active | **Otgonjargal**, stays on and bookable (founder 2026-10-04: she still works at Яармаг) | 1-р зэргийн үсчин (deposit 10,000₮) |
| Г. Мөнхзаяа, «Маникюр баг», active | switched off: manicure is off at Tara | — |

Otgonjargal in our data (read-only, 2026-10-04): «Эмэгтэй үсчид», «1-р зэрэг үсчин», active,
selectable; no manicure group. So she is a hair stylist and stays bookable with her level. The
website agrees (`config/stylists.js`: 1-р зэрэг, female, own calendar).

Every `short_name` is cleared, so the roster reads «Oyunaa · Эмэгтэй үсчид · SPECIAL үсчин». The
Cyrillic names (Оюунсүрэн, Оюунаа, Бадамцэцэг, Бадмаа, Уянга, Батзаяа, Заяа, Уранчимэг, Чимгээ,
Ананд, Отгонжаргал and «Отгоо», approved 2026-10-04) are in a new knowledge document «Үсчдийн нэр», and
«Салбарууд»'s line «Оюунаа Яармаг салбарт ажилладаг.» becomes «Oyunaa Яармаг салбарт ажилладаг.».
The branch gate keeps searching Парк Од's rows for these Cyrillic names through
`config/branch-groups.json` `staff_aliases` (the same list as «Үсчдийн нэр»: change both
together); a pasted «Оюунсүрэн, Оюунаа гэвэл Oyunaa» in her rows is a LEAK (control, 2026-10-04). No canned line, fixed reply, FAQ, reply case, comment
rule, topic or service alias names a hairdresser, so nothing else changes and the canned-edit
guard is not engaged. Apply, then publish Яармаг at once (`node scripts/publish/tenant.ts --slug
matrix-eco-salon`, dry run, then `--publish`). Proven on a local replica of her rows (2026-10-04):
it applies, refuses a second run, reverts to the bytes read, re-applies; the compiled roster is
exactly the seven Latin lines; the branch and facts gates are clean with Парк Од beside her.

Found on the way, not changed: the canned `refusal_service_unavailable` («Манай салон одоогоор
хумсны үйлчилгээ үзүүлэхгүй байна.») and the topic `nail_services` still answer nail questions
by saying the salon does not offer them; whether that line stays is the founder's call.

## Quality answers of 2026-10-04 (PR #283 for Яармаг, PR #284 for Парк Од, the same bytes)

The founder approved three answers, the hand-off sentence and a price-page pointer for both
branches. Яармаг's rows are #283's `tara-yarmag-answers-2026-10-04.sql` and
`tara-yarmag-price-page-2026-10-04.sql`; Парк Од's are the same bytes from her own files (her form's
FAQs, her `--wording` handoff, `tara-park-od-after-onboarding.sql`). The facts gate does not
compare FAQs or fixed replies across branches, so "the same bytes" is by convention:

- `handoff` «Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.»
- fixed replies + FAQs: `deposit_deducted` «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж
  тооцогдоно.», `loan_apps` «Одоогоор зээлийн аппаар төлбөр авдаггүй.», `dye_brand` (the hand-off
  sentence); FAQ questions «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу?», «Зээлийн аппаар
  төлбөр төлж болох уу?», «Ямар брэндийн будаг хэрэглэдэг вэ?»; the same seven reply cases.
- fixed replies `treatment_perm_women` (women's «Эмчилгээний хими» is not offered; approved, on),
  `colour_lift` («өнгө гаргалт»: the women's colour rows, then her phone line) and `colour_lift_men`
  (the men's rows, only with «эрэгтэй»), each under «Манай өнгөний үйлчилгээний үнэ:» and ending
  with 76001888 and 91005498; all approved 2026-10-04 and on (D-177, #283's
  `tara-yarmag-colour-and-treatment-perm-2026-10-04.sql`). The earlier price-page rows and the
  `price_page` contact are dropped: neither service is offered (founder, 2026-10-04).

## History

Applied data changes are in `scripts/provision/` (files named `tara-*` and `matrix-*`).
