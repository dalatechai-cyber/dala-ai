# In-chat booking wording — DRAFTS, unsigned

What a customer reads while booking and paying the deposit inside Messenger
(`docs/proposals/tara-inchat-booking.md`). **Nothing loads these files in a deployment.** The
booking flow refuses to start for any tenant until every block below is signed:

    node scripts/prompt/sign-drafts.ts --dir prompt/drafts/booking              # read, get the set id
    node scripts/prompt/sign-drafts.ts --dir prompt/drafts/booking --set <id> --by Bilguun

Signing moves them into `prompt/platform/`, records their hashes and writes the seed migration
(layer null: never part of a tenant's prompt).

**Every line here is approved by the founder (2026-10-03), still to be signed with the script
above.** `booking_pay`, `booking_expired`, `booking_paid_unbooked_offer` (with «бид тантай
холбогдож») first; then all the others, as drafted, except seven the founder rewrote, which now
read as approved: `booking_excess` («…Давхар орсон төлбөрийн талаар бид тантай холбогдоно.»),
`booking_paid_unbooked` («…Бид тантай удахгүй холбогдож өөр цаг тохирно.»), `booking_ask_gender`
(«Хэнд зориулж цаг авах вэ?», now asked first, with the buttons Эмэгтэй / Эрэгтэй / Хүүхэд; the
new `booking_gender_child` «Хүүхэд» is part of that approval), `booking_cancelled` («…Өөр асуух
зүйл байвал бичнэ үү.»), `booking_page_ended` («Төлбөр төлөх хугацаа дууссан. Messenger-ээр дахин
цаг сонгоно уу.»), and `booking_time_free`
(«{date}, {time} сул байна. Энэ цагийг сонгох бол доорх товчийг дарна уу.»).

**Round 2026-10-03 (two branches), awaiting approval:** `booking_ask_agreement` CHANGED: its
«Нөхцөл: «{agreement}»» line is removed, because Дали must never say in chat that the deposit is
non-refundable (the founder's rule; that sentence was the website's non-refundable tick-box text).
It now reads «{service}, {stylist} / {date}, {time} / Урьдчилгаа төлбөр: {amount} / Зөвшөөрч байвал
доорх товчийг дарна уу.». `booking_ask_variant` NEW: «{service} — аль нь вэ?», the second question
for a price-list line sold by hair length or by level («Tara perm» → Богино / Дунд / Урт; «Тайралт
том хүн» → SPECIAL / МАСТЕР / 1-р зэрэг). The service group, family and short button labels in
`config/booking/tara-salon.json` (the price list's own words where they fit 20 characters) are
drafts too. No other line changed; none says the deposit is non-refundable.

**Round 2026-10-04, awaiting approval:** `booking_ask_agreement` CHANGED again: after
«Урьдчилгаа төлбөр: {amount}» it adds the founder's approved sentence «Урьдчилгаа төлбөр
үйлчилгээний үнээс хасагдаж тооцогдоно.» (tara_quality item 1, Option A), because the deposit IS
deducted from the service price and this summary is where the customer agrees to pay it. The
sentence is approved; the block as a whole is still a draft. Nothing says the deposit is
non-refundable. Stylist `aliases` in `config/booking/tara-salon.json` are typed-only (never
shown): «Отгонжаргал» and the approved Яармаг «Үсчдийн нэр» spellings.

**Service placement (founder, 2026-10-04): APPROVED, not a pending decision.** «Гоёлын засалт
/эрэгтэй/» is printed in the price list's women's section but is a men's styling, so the booking
offers it to men, in «Эрэгтэй засалт» (Anand at Яармаг, Tuchku at Парк Од). This is how
`config/booking/tara-salon.json` already works; no wording changed for it.

**Button (founder, 2026-10-03):** `booking_any_of_level` is «Аль ч {level}» («Аль ч Мастер», «Аль ч
1-р зэрэг»), which fits Messenger's 20 characters; it replaces «{level} — аль ч үсчин». Should a
level label ever make it too long, only that «any» button is left out, never cut. Tara's
children's-service button labels in `config/booking/tara-salon.json` («Охин», «Эрэгтэй 0–13 нас»,
«Эрэгтэй 14–18 нас») are drafts too.

Style: «та», short, no markdown, no emoji. Where Tara's website already says the same thing, its
words are kept: «Уучлаарай, энэ цаг өөр хүнд захиалагдсан байна. Өөр цаг сонгоно уу.»
(`booking_slot_taken`), «Төлбөр тань амжилттай орсон. Харамсалтай нь…» (`booking_paid_unbooked`),
«…цаг захиалга баталгаажлаа» (`booking_confirmed`). Eight lines on the pay page are ALREADY signed
and reused as they are: `billing_page_qr_valid` («QR код {time} хүчинтэй»),
`billing_page_qr_expired`, `billing_page_qr_renew`, `billing_page_qr_wait`, `billing_page_scan`,
`billing_page_banks`, `billing_page_amount`, `billing_pay_button` («Төлбөр төлөх», also the pay
button's title in Messenger).

## Placeholders (filled by the platform from rows and the calendar)

| Block | Must contain | Values look like |
|---|---|---|
| `booking_ask_service` | | |
| `booking_any_of_level` | `{level}` | «Мастер» (the tenant's level label) |
| `booking_ask_when` | `{service}` | «Будаг» (the customer answers in words: «маргааш 2 цагт») |
| `booking_date` | `{month}` `{day}` `{weekday}` | «10», «5», «Бямба» (the hours section's weekday) |
| `booking_ask_time` | `{date}` | «Маргааш» or «10 сарын 5, Бямба» |
| `booking_time_free`, `booking_time_not_free` | `{date}` `{time}` | the day and the time the customer asked for, «14:00» |
| `booking_day_full`, `booking_day_closed` | `{date}` | the day the customer asked for: open with every time taken (full), or not bookable at all (closed, a closure, past, or beyond the days the tenant books ahead) |
| `booking_ask_agreement` | `{service}` `{stylist}` `{date}` `{time}` `{amount}` | the summary before the hold (no deposit terms); «Аль ч Мастер» when any stylist of the level; the hold records it as accepted |
| `booking_ask_variant` | `{service}` | the family's button, «Tara perm», «Тайралт том хүн» |
| `booking_pay` | `{service}` `{stylist}` `{date}` `{time}` `{amount}` `{minutes}` `{pay_link}` | «Oyunaa (SPECIAL)», «14:00», «20,000₮», «10», the pay page address (sent as the «Төлбөр төлөх» button) |
| `booking_confirmed` | `{service}` `{stylist}` `{date}` `{time}` `{branch}` `{address}` | «Яармаг» (from the tenant's display name), the tenant's address row |
| `booking_expired` | `{date}` `{time}` | |
| `booking_unavailable` | `{booking_url}` | the tenant's booking link |

Buttons (Meta allows 20 characters): `booking_gender_female`, `booking_gender_male`,
`booking_any_of_level`, `booking_day_today`, `booking_day_tomorrow`, `booking_agree` («Зөвшөөрч, захиалах», 18),
`booking_cancel`, `booking_choose_again` («Цаг сонгох», under the «time released» line).
`booking_pay` carries the founder's own line «Энэ QR {minutes} минутын турш хүчинтэй. Энэ хугацаанд
таны сонгосон цаг хадгалагдана.» (`{minutes}` is the hold, 5). `booking_paid_unbooked_offer` (`{date}`
`{time}`) is said when a late payment's time was taken, above the nearest free times; a tapped time is
booked on that deposit. `booking_follow_up` («Цаг захиалах уу?») goes out once, ten minutes after a customer
went quiet on the offered times, above the times read fresh. `booking_test_prefix` starts every message of a test booking («ТЕСТ — …»).
