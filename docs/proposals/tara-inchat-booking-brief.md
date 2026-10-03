# Tara in-chat booking: the brief

_The short version of the first report and the follow-ups (2026-10-03). The full design is `tara-inchat-booking.md`; what customers read is `tara-inchat-booking-transcript.md`._

## How Tara's customers ask to book today

Яармаг's live Messenger, 2026-09-03 to 2026-10-02 (read-only): 558 customer messages in 212 conversations.

- **33 booking asks** (29 found by a keyword count, 4 more by the proposed entry phrases); 1 false hit (a vendor pitch).
- **About half ask whether a time is free today or tomorrow**: «Onoodriin tsag bgaa yu», «Маргаашын цаг бнауу», «10 сарын 3 нд цаг байна уу». Others name a stylist or level («Oyunaa masteraar unuudur buduulah tsag bnuu») or a time («ogloo 9.30 … tsag bnu»).
- **13 of 29 are in Latin script.**
- What they got: 10 of 26 conversations got the website link first, 11 got no bot answer (8 before Tara's channel went live on 21 Sep, Дали's reply kept as a draft; 2 in the 21–24 Sep outage, since fixed; 1 a staff member had taken the chat), the rest hours or phone numbers. Nothing could say whether a time is free.

## The design

A deterministic flow (no model, every line a signed block): service, who it is for, stylist or level, then Дали asks *when*, reads the real calendars and holds, and offers the asked time or the nearest free ones. Name and phone, a summary with Tara's deposit terms, «Зөвшөөрч, захиалах». That tap makes the QPay QR and holds the time for exactly 5 minutes, taken everywhere (database lock and a busy calendar event the website sees). Paid: booked and confirmed. Unpaid: released on time, told with «Цаг сонгох». Late and free: booked. Late and taken: the nearest free times on the same deposit, 30 minutes, and the founder paged. One hold per customer. Deposits are Tara's per level (Мастер 20,000₮, 1-р зэрэг 10,000₮), on Tara's own QPay merchant.

## Built and proven

Draft PR https://github.com/dalatechai-cyber/dala-ai/pull/280, off for every tenant. End-to-end 194 checks over real PostgreSQL and PostgREST with faithful QPay and Google fakes, 8 of them running Tara's own website code against the same calendar. Seven independent review rounds, every finding fixed. Migration `0082_booking` is **not applied** (checked on the project 2026-10-03: latest is `0081_ora_billing`, no booking tables or functions; main has no other 0082).

## Still missing

- Several services in one booking; moving or cancelling a booking in chat; Instagram and the website chat.
- The website's own hold while its QR is open (`matrix-website-booking-holds.md`, in the Tara website round before switch-on).
- Signing the drafts below; your 100₮ test (steps in the design doc).
- Ананд (the only man; men book only with him) and Уранчимэг are in the Yaarmag stylist list (founder, 2026-10-03). Still missing for the Tara round: children's durations, SPECIAL stylists (none named), and the service list (it is still the website's old one: Оффис колор, Омбре, CMC are no longer offered, D-168).

## Every draft line

| Block | Draft | Status |
|---|---|---|
| `booking_agree` | Зөвшөөрч, захиалах | awaiting approval |
| `booking_any_of_level` | {level} (аль нь ч) | awaiting approval |
| `booking_ask_agreement` | {service}, {stylist} / {date}, {time} / Урьдчилгаа төлбөр: {amount} / Нөхцөл: «{agreement}» / Зөвшөөрч байвал доорх товчийг дарна уу. | awaiting approval |
| `booking_ask_gender` | Үйлчлүүлэгч эмэгтэй юү, эрэгтэй юү? | awaiting approval |
| `booking_ask_name` | Таны нэрийг бичнэ үү. | awaiting approval |
| `booking_ask_phone` | Холбогдох утасны дугаараа бичнэ үү. | awaiting approval |
| `booking_ask_service` | Аль үйлчилгээг сонгох вэ? | awaiting approval |
| `booking_ask_service_group` | Ямар үйлчилгээнд цаг авах вэ? Доороос сонгоно уу. | awaiting approval |
| `booking_ask_stylist` | Аль үсчинд цаг авах вэ? | awaiting approval |
| `booking_ask_time` | {date} — сул цагаас сонгоно уу. | awaiting approval |
| `booking_ask_when` | {service} — хэзээ, хэдэн цагт ирэх вэ? Жишээ нь: маргааш 14:00 | awaiting approval |
| `booking_cancel` | Цуцлах | awaiting approval |
| `booking_cancelled` | Цаг захиалгыг цуцаллаа. Өөр асуух зүйл байвал бичээрэй. | awaiting approval |
| `booking_choose_again` | Цаг сонгох | awaiting approval |
| `booking_confirmed` | Төлбөр амжилттай орлоо. Таны цаг захиалга баталгаажлаа. / {service}, {stylist} / {date}, {time} / {branch} салбар: {address} | awaiting approval |
| `booking_date` | {month} сарын {day}, {weekday} | awaiting approval |
| `booking_day_closed` | Уучлаарай, {date} цаг захиалах боломжгүй байна. | awaiting approval |
| `booking_day_full` | Уучлаарай, {date} сул цаг алга. | awaiting approval |
| `booking_day_today` | Өнөөдөр | awaiting approval |
| `booking_day_tomorrow` | Маргааш | awaiting approval |
| `booking_excess` | Таны цаг захиалга нэг удаа бүртгэгдсэн. Давхар орсон төлбөрийн талаар салоны ажилтан тантай холбогдоно. | awaiting approval |
| `booking_expired` | Уучлаарай, {minutes} минутын дотор төлбөр ороогүй тул {date}, {time} цагийг чөлөөллөө. Дахин цаг сонгох бол доорх товчийг дарна уу. | approved |
| `booking_follow_up` | Цаг захиалах уу? | awaiting approval |
| `booking_gender_female` | Эмэгтэй | awaiting approval |
| `booking_gender_male` | Эрэгтэй | awaiting approval |
| `booking_no_times` | Уучлаарай, ойрын өдрүүдэд энэ үсчинд сул цаг алга. Өөр үсчин сонгоно уу. | awaiting approval |
| `booking_page_ended` | Энэ цагийн хугацаа дууссан. Messenger-ээр дахин цаг авна уу. | awaiting approval |
| `booking_page_paid` | Төлбөр орлоо. Баталгаажуулалтыг Messenger-ээс харна уу. | awaiting approval |
| `booking_page_title` | Урьдчилгаа төлбөр | awaiting approval |
| `booking_paid_unbooked` | Төлбөр тань амжилттай орсон. Харамсалтай нь сонгосон цаг тань энэ хооронд өөр хүнд захиалагдсан байна. Салоны ажилтан тантай удахгүй холбогдож өөр цаг тохирно. | awaiting approval |
| `booking_paid_unbooked_offer` | Таны төлбөр орсон боловч {date}, {time} цаг энэ хооронд өөр хүнд захиалагдсан байна. Доорх ойрын сул цагаас сонговол таны төлсөн урьдчилгаагаар шууд захиална. Сонгохгүй бол бид тантай холбогдож төлбөрийг буцаана. | approved with the founder's change («бид») |
| `booking_pay` | {service}, {stylist} / {date}, {time} / Урьдчилгаа төлбөр: {amount} /  / Энэ QR {minutes} минутын турш хүчинтэй. Энэ хугацаанд таны сонгосон цаг хадгалагдана. Доорх товчоор QPay-ээр төлнө үү. {pay_link} | approved |
| `booking_phone_invalid` | Утасны дугаар 8 оронтой байх ёстой. Дахин бичнэ үү. | awaiting approval |
| `booking_pick_from_list` | Доорх сонголтоос сонгоно уу. | awaiting approval |
| `booking_slot_taken` | Уучлаарай, энэ цаг өөр хүнд захиалагдсан байна. Өөр цаг сонгоно уу. | awaiting approval |
| `booking_test_prefix` | ТЕСТ | awaiting approval |
| `booking_time_free` | {date}, {time} сул байна. Доороос цагаа сонгоно уу. | awaiting approval |
| `booking_time_not_free` | Уучлаарай, {date}, {time} цаг захиалгатай байна. Ойрын сул цагаас сонгоно уу. | awaiting approval |
| `booking_unavailable` | Уучлаарай, яг одоо цагийн хуваарийг шалгаж чадсангүй. Та {booking_url} хаягаар цагаа захиална уу. | awaiting approval |
| `booking_when_again` | Өдөр, цагаа бичнэ үү. Жишээ нь: маргааш 14:00. Эсвэл доороос өдрөө сонгоно уу. | awaiting approval |

Also drafts: the service group labels in `config/booking/tara-salon.json` (Засалт, Будаг, Хими, Арчилгаа, «CICA эмчилгээ»). Eight lines on the pay page are your already-signed billing lines.
