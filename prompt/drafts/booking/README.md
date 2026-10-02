# In-chat booking wording — DRAFTS, unsigned

What a customer reads while booking and paying the deposit inside Messenger
(`docs/proposals/tara-inchat-booking.md`). **Nothing loads these files in a deployment.** The
booking flow refuses to start for any tenant until every block below is signed:

    node scripts/prompt/sign-drafts.ts --dir prompt/drafts/booking              # read, get the set id
    node scripts/prompt/sign-drafts.ts --dir prompt/drafts/booking --set <id> --by Bilguun

Signing moves them into `prompt/platform/`, records their hashes and writes the seed migration
(layer null: never part of a tenant's prompt).

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
| `booking_ask_day` | `{service}` | «Будаг» |
| `booking_date` | `{month}` `{day}` `{weekday}` | «10», «5», «Бямба» (the hours section's weekday) |
| `booking_ask_time` | `{date}` | «Маргааш» or «10 сарын 5, Бямба» |
| `booking_ask_agreement` | `{agreement}` | the tenant's own sentence, verbatim |
| `booking_pay` | `{service}` `{stylist}` `{date}` `{time}` `{amount}` `{minutes}` `{pay_link}` | «Оюунаа (Мастер)», «14:00», «20,000₮», «10», the pay page address (sent as the «Төлбөр төлөх» button) |
| `booking_confirmed` | `{service}` `{stylist}` `{date}` `{time}` `{branch}` `{address}` | «Яармаг» (from the tenant's display name), the tenant's address row |
| `booking_expired` | `{date}` `{time}` | |
| `booking_unavailable` | `{booking_url}` | the tenant's booking link |

Buttons (Meta allows 20 characters): `booking_gender_female`, `booking_gender_male`,
`booking_any_of_level`, `booking_day_today`, `booking_day_tomorrow`, `booking_agree`,
`booking_cancel`. `booking_test_prefix` starts every message of a test booking («ТЕСТ — …»).
