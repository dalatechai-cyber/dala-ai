# Tara in-chat booking: the brief

_The short version of the first report and the follow-ups (2026-10-03). The full design is `tara-inchat-booking.md`; what customers read is `tara-inchat-booking-transcript.md`._

## Round 2026-10-04: your answers

- **Your approvals** (2026-10-04, as written): `booking_ask_agreement`, `booking_ask_variant` and every button label (group, family, short service and children's). Nothing in the booking waits for approval. **Signed** at your request on 2026-10-04: set `c787decc1f0a`, by Bilguun, all 42 lines; seed `0084_prompt_blocks_seed` (layer null, never in a tenant's prompt), **not applied**.
- **Otgonjargal is bookable again**: Яармаг, 1-р зэрэг, female, 10,000₮, on the same Google Calendar the website uses for her. Her button is «Otgonjargal» alone (with «· 1-р зэрэг» it is over Messenger's 20 characters); the summary still says «Otgonjargal (1-р зэрэг)». She gets the 1-р зэрэг haircut and every unlevelled service a woman books; never the SPECIAL or МАСТЕР haircut.
- **Typed names**: at the stylist question a customer may type the Latin name alone («Uyanga») or a Cyrillic spelling from the approved «Үсчдийн нэр» list («Отгонжаргал», «Бадмаа», «Чимгээ» …) or a former name the website still accepts («Batzaya»); it picks that stylist, only if she may serve that service. Cyrillic is never shown. «Отгоо» and Парк Од's Cyrillic spellings (Болороо, Болор, Сараа, Томоо, Төмөө, Булгаа, Энхүүш, Чимэгээ, Тучку, Түчкү) are recognised since you approved them (2026-10-04), each only in its own branch.
- **Deposit deducted** (your answer): the summary before «Зөвшөөрч, захиалах» now adds your approved sentence «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.» (the block approved as written, 2026-10-04; never «non-refundable»).
- **Levels** written out are «1-р зэргийн үсчин», never «1-р зэрэг үсчин» (the booking writes none today; a test keeps it so). Level-named haircuts go only to that level; «Аль ч {level}» is still never a recommendation.
- **Парк Од's QPay** (your correction): she uses YOUR existing QPay merchant and login, exactly as Яармаг and Core Language do; nothing is registered and nothing is asked of Boloroo. The only difference is the bank account her deposits are paid into (her Khan Bank account, the website's `PARKOD_QPAY_BANK_CODE` / `_ACCOUNT_NUMBER` / `_ACCOUNT_NAME`); her invoice is Яармаг's exactly but for `bank_accounts` (a test compares them). Proof is a real 100₮ test landing in HER account.
- **«Гоёлын засалт /эрэгтэй/»** (your decision): offered to men, in «Эрэгтэй засалт» (Anand at Яармаг, Tuchku at Парк Од). Approved; it was already built so.
- **Alerts**: for now every booking alert reaches only you; Boloroo checks Парк Од's Messenger herself. Nothing is built for owner alerts.
- **Парк Од switch-on**: Her booking account tarasalon.parkod@gmail.com exists. The website's domain will be tarasalon.org (links stay on matrixecosalon.org until the switch).

## Round 2026-10-03: two branches

- **Services**: the current price list of 2026-10-01 (62 services, the same in both branches; Дали's own price rows and the website's `data/services.json` carry the same prices), with the 62 confirmed minutes. The website's old menu (Оффис колор, Омбре, CMC…) is gone from the booking. A line sold by length or level is one button, then «Богино / Дунд / Урт» or «SPECIAL / МАСТЕР / 1-р зэрэг».
- **Stylists** by their short Latin names. Яармаг: Oyunaa (SPECIAL), Badamaa (Мастер), Uyanga, Zaya, Chimgee (1-р зэрэг), Anand (Мастер, the only man). Парк Од: Boloroo (SPECIAL), Saraa, Tomoo, Bulgaa, Enhuush, Chimegee, Tuchku (Мастер; Tuchku the only man). (Отгонжаргал was left out in this round; she is back since 2026-10-04, above.)
- **Deposits**: SPECIAL 20,000₮, Мастер 20,000₮, 1-р зэрэг 10,000₮ (Яармаг only; every Парк Од deposit is 20,000₮). Children: girls with a woman, boys with the branch's man, the stylist's level's deposit. «Аль ч {level}» never recommends a level and is never «Аль ч 1-р зэрэг» at Парк Од.
- **No deposit terms in chat**: the summary no longer quotes the website's non-refundable sentence (your rule). The hold records the summary the customer accepted.
- **Each branch is paid into its own bank account** (one QPay merchant and login for both, since 2026-10-04), no fallback between them; Парк Од stays off («not connected») until her calendars and her account are given.
- **Website holds** (`sh…`) and chat holds (`dh…`) share one rule: an expired website hold is free; of two holds the earlier-placed wins.

## How Tara's customers ask to book today

Яармаг's live Messenger, 2026-09-03 to 2026-10-02 (read-only): 558 customer messages in 212 conversations.

- **33 booking asks** (29 found by a keyword count, 4 more by the proposed entry phrases); 1 false hit (a vendor pitch).
- **About half ask whether a time is free today or tomorrow**: «Onoodriin tsag bgaa yu», «Маргаашын цаг бнауу», «10 сарын 3 нд цаг байна уу». Others name a stylist or level («Oyunaa masteraar unuudur buduulah tsag bnuu») or a time («ogloo 9.30 … tsag bnu»).
- **13 of 29 are in Latin script.**
- What they got: 10 of 26 conversations got the website link first, 11 got no bot answer (8 before Tara's channel went live on 21 Sep, Дали's reply kept as a draft; 2 in the 21–24 Sep outage, since fixed; 1 a staff member had taken the chat), the rest hours or phone numbers. Nothing could say whether a time is free.

## The design

A deterministic flow (no model, every line a signed block): who it is for, service, stylist or level, then Дали asks *when*, reads the real calendars and holds, and offers the asked time or the nearest free ones. Name and phone, a summary (no deposit terms), «Зөвшөөрч, захиалах». That tap makes the QPay QR and holds the time for exactly 5 minutes, taken everywhere (database lock and a busy calendar event the website sees). Paid: booked and confirmed. Unpaid: released on time, told with «Цаг сонгох». Late and free: booked. Late and taken: the nearest free times on the same deposit, 30 minutes, and the founder paged. One hold per customer. Deposits are Tara's per level (SPECIAL and Мастер 20,000₮, 1-р зэрэг 10,000₮), both branches on your one QPay merchant, each paid into its own bank account.

## Built and proven

Draft PR https://github.com/dalatechai-cyber/dala-ai/pull/280, off for every tenant; the two-branch round is a draft PR stacked on it. End-to-end 262 checks (2026-10-04) over real PostgreSQL and PostgREST with faithful QPay and Google fakes, 21 of them running or reading Tara's own website code (including its own hold and `from-website.ts` on her checkout) against the same calendar, 241 in CI, which has no website checkout. Seven independent review rounds, every finding fixed. Migration `0082_booking` is **not applied** (checked on the project 2026-10-03: latest is `0081_ora_billing`, no booking tables or functions; main has no other 0082).

## Still missing

- Several services in one booking; moving or cancelling a booking in chat; Instagram and the website chat.
- Парк Од: her tenant (another round), her calendars, her bank account (not given yet), then her row and a 100₮ test landing in HER account.
- Applying `0082`, #283's `0083`, then `0084` (the signed wording); your 100₮ test (steps in the design doc).

## Every draft line

| Block | Draft | Status |
|---|---|---|
| `booking_agree` | Зөвшөөрч, захиалах | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_any_of_level` | Аль ч {level} | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_agreement` | {service}, {stylist} / {date}, {time} / Урьдчилгаа төлбөр: {amount} / Зөвшөөрч байвал доорх товчийг дарна уу. | **CHANGED 2026-10-03 and 2026-10-04, approved by the founder 2026-10-04 (signed 2026-10-04)**: the «Нөхцөл: «{agreement}»» line is removed (Дали never states the deposit terms); «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.» added after the amount |
| `booking_ask_gender` | Хэнд зориулж цаг авах вэ? | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_name` | Таны нэрийг бичнэ үү. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_phone` | Холбогдох утасны дугаараа бичнэ үү. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_service` | Аль үйлчилгээг сонгох вэ? | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_service_group` | Ямар үйлчилгээнд цаг авах вэ? Доороос сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_stylist` | Аль үсчинд цаг авах вэ? | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_time` | {date} — сул цагаас сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_ask_variant` | {service} — аль нь вэ? | **NEW 2026-10-03, approved by the founder 2026-10-04 (signed 2026-10-04)**: the second question for a price-list line sold by length or level |
| `booking_ask_when` | {service} — хэзээ, хэдэн цагт ирэх вэ? Жишээ нь: маргааш 14:00 | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_cancel` | Цуцлах | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_cancelled` | Цаг захиалгыг цуцаллаа. Өөр асуух зүйл байвал бичнэ үү. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_choose_again` | Цаг сонгох | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_confirmed` | Төлбөр амжилттай орлоо. Таны цаг захиалга баталгаажлаа. / {service}, {stylist} / {date}, {time} / {branch} салбар: {address} | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_date` | {month} сарын {day}, {weekday} | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_day_closed` | Уучлаарай, {date} цаг захиалах боломжгүй байна. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_day_full` | Уучлаарай, {date} сул цаг алга. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_day_today` | Өнөөдөр | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_day_tomorrow` | Маргааш | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_excess` | Таны цаг захиалга нэг удаа бүртгэгдсэн. Давхар орсон төлбөрийн талаар бид тантай холбогдоно. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_expired` | Уучлаарай, {minutes} минутын дотор төлбөр ороогүй тул {date}, {time} цагийг чөлөөллөө. Дахин цаг сонгох бол доорх товчийг дарна уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_follow_up` | Цаг захиалах уу? | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_gender_child` | Хүүхэд | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_gender_female` | Эмэгтэй | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_gender_male` | Эрэгтэй | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_no_times` | Уучлаарай, ойрын өдрүүдэд энэ үсчинд сул цаг алга. Өөр үсчин сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_page_ended` | Төлбөр төлөх хугацаа дууссан. Messenger-ээр дахин цаг сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_page_paid` | Төлбөр орлоо. Баталгаажуулалтыг Messenger-ээс харна уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_page_title` | Урьдчилгаа төлбөр | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_paid_unbooked` | Төлбөр тань амжилттай орсон. Харамсалтай нь сонгосон цаг тань энэ хооронд өөр хүнд захиалагдсан байна. Бид тантай удахгүй холбогдож өөр цаг тохирно. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_paid_unbooked_offer` | Таны төлбөр орсон боловч {date}, {time} цаг энэ хооронд өөр хүнд захиалагдсан байна. Доорх ойрын сул цагаас сонговол таны төлсөн урьдчилгаагаар шууд захиална. Сонгохгүй бол бид тантай холбогдож төлбөрийг буцаана. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_pay` | {service}, {stylist} / {date}, {time} / Урьдчилгаа төлбөр: {amount} /  / Энэ QR {minutes} минутын турш хүчинтэй. Энэ хугацаанд таны сонгосон цаг хадгалагдана. Доорх товчоор QPay-ээр төлнө үү. {pay_link} | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_phone_invalid` | Утасны дугаар 8 оронтой байх ёстой. Дахин бичнэ үү. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_pick_from_list` | Доорх сонголтоос сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_slot_taken` | Уучлаарай, энэ цаг өөр хүнд захиалагдсан байна. Өөр цаг сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_test_prefix` | ТЕСТ | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_time_free` | {date}, {time} сул байна. Энэ цагийг сонгох бол доорх товчийг дарна уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_time_not_free` | Уучлаарай, {date}, {time} цаг захиалгатай байна. Ойрын сул цагаас сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_unavailable` | Уучлаарай, яг одоо цагийн хуваарийг шалгаж чадсангүй. Та {booking_url} хаягаар цагаа захиална уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |
| `booking_when_again` | Өдөр, цагаа бичнэ үү. Жишээ нь: маргааш 14:00. Эсвэл доороос өдрөө сонгоно уу. | approved by the founder 2026-10-03 (signed 2026-10-04) |

Also customer-visible, in `config/booking/tara-salon.json`, and approved by the founder as written (2026-10-04; config, not prompt blocks, so the signing covers none of them and this approval is their record): the group labels (the price list's own section names: «Эмэгтэй засалт», «Эрэгтэй засалт», «Үйлчилгээ», «Эмэгтэй хими», «Эмэгтэй будаг»); the family buttons («Afro хими», «Hippie & Jerry curl», «TARA BLEND», «TARA LUMI», «Tara perm», «Гоёлын засалт», «Сэттинг хими», «Тайралт том хүн», «Усан хими», «Хэлбэржүүлэлт», «Шулуун хими», «Энгийн будаг», «Өнгөлөгч будаг»); the short button labels that differ from the price list's words: «SPECIAL» (Эмэгтэй засалт — Тайралт том хүн /SPECIAL/); «МАСТЕР» (Эмэгтэй засалт — Тайралт том хүн /МАСТЕР/); «1-р зэрэг» (Эмэгтэй засалт — Тайралт том хүн /1-р зэрэг/); «өдөр тутмын» (Эмэгтэй засалт — Хэлбэржүүлэлт /өдөр тутмын/); «гоёлын» (Эмэгтэй засалт — Хэлбэржүүлэлт /гоёлын/); «бүтэн» (Эмэгтэй засалт — Гоёлын засалт /бүтэн/); «хагас» (Эмэгтэй засалт — Гоёлын засалт /хагас/); «Тайралт /SPECIAL/» (Эрэгтэй засалт — Тайралт том хүн /SPECIAL/); «Гоёлын засалт» (Эмэгтэй засалт — Гоёлын засалт /эрэгтэй/); «Нөхөн сэргээх» (Эрэгтэй засалт — Нөхөн сэргээх эмчилгээ); «Үс оношлогоо» (Үйлчилгээ — Үс оношлогоо зөвлөгөө); «Нөхөн сэргээх» (Үйлчилгээ — Нөхөн сэргээх эмчилгээ); «CICA эмчилгээ» (Үйлчилгээ — CICA үсний гүний эмчилгээ); «Богино» (Эмэгтэй хими — Tara perm (Богино)); «Дунд» (Эмэгтэй хими — Tara perm (Дунд)); «Урт» (Эмэгтэй хими — Tara perm (Урт)); «Богино» (Эмэгтэй хими — Усан хими (Богино)); «Дунд» (Эмэгтэй хими — Усан хими (Дунд)); «Урт» (Эмэгтэй хими — Усан хими (Урт)); «Богино» (Эмэгтэй хими — Afro хими (Богино)); «Дунд» (Эмэгтэй хими — Afro хими (Дунд)); «Урт» (Эмэгтэй хими — Afro хими (Урт)); «Богино» (Эмэгтэй хими — Hippie & Jerry curl (Богино)); «Дунд» (Эмэгтэй хими — Hippie & Jerry curl (Дунд)); «Урт» (Эмэгтэй хими — Hippie & Jerry curl (Урт)); «Богино» (Эмэгтэй хими — Сэттинг хими (Богино)); «Дунд» (Эмэгтэй хими — Сэттинг хими (Дунд)); «Урт» (Эмэгтэй хими — Сэттинг хими (Урт)); «Богино» (Эмэгтэй хими — Шулуун хими (Богино)); «Дунд» (Эмэгтэй хими — Шулуун хими (Дунд)); «Урт» (Эмэгтэй хими — Шулуун хими (Урт)); «Богино» (Эмэгтэй будаг — Энгийн будаг (Богино)); «Дунд» (Эмэгтэй будаг — Энгийн будаг (Дунд)); «Урт» (Эмэгтэй будаг — Энгийн будаг (Урт)); «Богино» (Эмэгтэй будаг — Өнгөлөгч будаг (Богино)); «Дунд» (Эмэгтэй будаг — Өнгөлөгч будаг (Дунд)); «Урт» (Эмэгтэй будаг — Өнгөлөгч будаг (Урт)); «Богино» (Эмэгтэй будаг — TARA LUMI (Богино)); «Дунд» (Эмэгтэй будаг — TARA LUMI (Дунд)); «Урт» (Эмэгтэй будаг — TARA LUMI (Урт)); «Богино» (Эмэгтэй будаг — TARA BLEND (Богино)); «Дунд» (Эмэгтэй будаг — TARA BLEND (Дунд)); «Урт» (Эмэгтэй будаг — TARA BLEND (Урт)); and the children's buttons «Охин», «Эрэгтэй 0–13 нас», «Эрэгтэй 14–18 нас». Eight lines on the pay page are your already-signed billing lines.
