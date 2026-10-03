# Booking and paying the deposit inside Messenger (Tara) — design

Status: **built, switched off for every tenant** (branch `claude/happy-pasteur-4gp7gd`; the
two-branch round of 2026-10-03 is stacked on it as `claude/tara-inchat-booking-two-branch`).
Written 2026-10-02 before the code, then kept in step with it. Nothing here is live, and no
customer reads a word of it until the founder signs the drafts and switches it on.

## Why

Today a Tara customer who asks for a time gets the deposit rows and the website link
(«Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж…»). Measured on
Яармаг's live messages, 2026-09-03 to 2026-10-02 (read-only):

- 558 customer messages in 212 conversations; **29 messages in 26 conversations ask for a
  time**. One more message in the same window is a vendor pitch («"sul tsag baina uu" gesen
  chatnuudad garaar xariulax…»), so it is not counted.
- **About half ask whether a time is free today or tomorrow**: «Onoodriin tsag bgaa yu»,
  «Hi unuudur tsag bnu», «Маргаашын цаг бнауу», «Margaash tsag bna uu», «10 сарын 3 нд цаг
  байна уу». Others name a stylist or a level: «Oyunaa masteraar unuudur buduulah tsag bnuu»,
  «Энэ хүн 1-р зэрэг, мастер аль нь юм бол энэ хүн дээр цаг авах гээд». A few name a time:
  «ogloo 9.30 goylin zasalt deer zahiral der n tsag bnu». **13 of the 29 are in Latin script.**
- What they got: 10 of 26 got the website link as Дали's first answer; 11 got no bot answer at
  all (a person held the chat, or the channel was not delivering then); the others got the
  hours, a «би мэдэхгүй» line with the phone numbers, or a clarifying question. **Nothing could
  answer "is there a free time"**, because Дали cannot see the calendar (dali.md E2).
- Only 11 of the 26 conversations have another customer message after the booking ask.
- The entry stems proposed for Tara (`config/booking/tara-salon.json`, «цаг … ав/зах/бай/бн» and
  the Latin «tsag … av/zah/bai/bn/bg») match all 29, plus **four more real asks** the count above
  missed («4deh udur hamgiin ert tsag hed deer bna oyuka deer», «өнөөдрийн цаг байнуу», «10-1ний
  цаг бн гэж бх уу», «…master stilist drn tsag baiga bolov uu»): **33 booking asks in 30 days**.
  One false hit: the vendor pitch. (SQL approximation of the matcher over the same 558 messages.)

The people who ask are asking exactly the question a calendar answers.

## What the customer experiences

1. The customer writes something that asks for a time («Цаг авъя», «margaash tsag bnu»). Дали
   answers with buttons (Messenger quick replies), never with a link to leave.
2. **Who it is for**, first: «Эмэгтэй / Эрэгтэй / Хүүхэд» (Tara's rule: a woman books a woman
   stylist, a man the branch's man; «Хүүхэд» goes straight to the children's services, a girl's
   served by a woman, a boy's by the branch's man).
3. **Service**: the price list's own sections for that customer (a woman: «Эмэгтэй засалт»,
   «Үйлчилгээ», «Эмэгтэй хими», «Эмэгтэй будаг»; a man: «Эрэгтэй засалт», «Үйлчилгээ»), then the
   service. This is the **current price list of 2026-10-01** (the same one Дали quotes, the same in
   both branches), with the **62 confirmed minutes** (founder, 2026-10-03). A line sold by hair
   length or by level is one button and then a second question («Tara perm» → «Богино / Дунд /
   Урт»; «Тайралт том хүн» → «SPECIAL / МАСТЕР / 1-р зэрэг»), so a long list fits Messenger's 13
   buttons. A line nobody at that branch may serve is not shown (no man is SPECIAL, so the men's
   SPECIAL haircut is never offered; Парк Од has no 1-р зэрэг, so its 1-р зэрэг haircut is not).
4. **Stylist**: each stylist who may serve it, by the short Latin name the salon chose
   («Oyunaa · SPECIAL», «Badamaa · Мастер», «Uyanga · 1-р зэрэг»), level by level in a fixed
   order, plus «Аль ч {level}» where two or more of a level may serve. No level is ever
   recommended. A name whose button would pass Messenger's 20 characters with its level is
   shown alone («Otgonjargal»). Typed instead of tapped, the Latin name alone («Uyanga») or a
   Cyrillic spelling the rules list for her (`aliases`: «Отгонжаргал», «Отгоо», «Бадмаа»,
   «Төмөө» …, from each branch's approved «Үсчдийн нэр» list, 2026-10-04) picks the same stylist,
   within her own branch only; Cyrillic is never shown. The level sets the deposit: SPECIAL 20,000₮, Мастер 20,000₮, 1-р зэрэг 10,000₮
   (only Яармаг has 1-р зэрэг, so every Парк Од deposit is 20,000₮).
5. **When**: Дали asks «{service} — хэзээ, хэдэн цагт ирэх вэ?», with the days that still have
   a free start as buttons. The customer can tap a day or type it in words: «маргааш 2 цагт»,
   «10 сарын 15-нд 14:00», «баасан гарагт оройн 6», Latin «margaash 14 tsagt»
   (`src/lib/booking/when.ts`; «2» means 14:00 only when the salon is shut at 2 and open at 14).
   A day and time already in the first message («маргааш 14 цагт цаг авъя») is used without
   asking again.
6. **Дали checks and offers**: the stylists' real Google Calendars and every hold are read at
   that moment. The asked time is free: «…, 14:00 сул байна» with the six times around it. It is
   taken: «Уучлаарай, …, 14:00 цаг захиалгатай байна» with the six nearest free times. The day
   has nothing: «… сул цаг алга» and the next day that has time; a day the salon is closed or
   that is beyond how far ahead it books: «… цаг захиалах боломжгүй байна» instead. A start is offered only if the
   whole service fits before closing (the website's rule). Typing another hour or day at this
   point checks again.
7. **Name and phone** (typed; the phone must be 8 digits), then **the summary**: service,
   stylist, day, time and the deposit, with one button, «Зөвшөөрч, захиалах». **No deposit
   terms**: the founder's rule is that Дали never says in chat that the deposit is non-refundable
   (the website's own tick box carries that). It says only the founder's approved line that the
   deposit is deducted from the service price («Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж
   тооцогдоно.», 2026-10-04; the block itself approved as written and signed on 2026-10-04). The hold records the summary the customer accepted,
   word for word, with the time, and writes it on the calendar event («Summary accepted: «…»»).
   Nothing is held and no QR exists before this tap.
8. Дали holds the time and sends **one message with a «Төлбөр төлөх» button**: the summary and
   the deposit (SPECIAL and Мастер 20,000₮, 1-р зэрэг 10,000₮: Tara's rule, see "Rules reused"). The
   button opens a page with the QPay QR and one button per bank app; on a phone one tap opens
   the bank app with the payment filled in. **The QR and the held time last exactly five
   minutes, together** (the website's own QR countdown), and the message says so: «Энэ QR 5
   минутын турш хүчинтэй. Энэ хугацаанд таны сонгосон цаг хадгалагдана.» During those five
   minutes the time is taken everywhere: in the database (no other chat can hold it) and as a busy
   event in the stylist's calendar (the website stops offering it). There is no «new QR» that
   would stretch the five minutes; a sweep is scheduled for the exact moment they end (QStash
   `notBefore`), so the time comes free on time, not at the next minute.
9. **The moment QPay confirms the payment**, the booking is written into the stylist's
   calendar and Дали sends the confirmation: service, stylist, date, time, the branch and its
   address.
10. Not paid in five minutes: the time is released, the QPay invoice cancelled, the calendar event
    removed, and Дали says so once, politely, with a «Цаг сонгох» button that starts a new booking.
    **One hold per customer:** a customer who starts a new booking while a QR is out keeps the
    old time only until the new QR is made; the new QR replaces the old hold (QPay asked first).
11. **Quiet on the offered times**: ten minutes after the times were offered with no answer,
    Дали asks once «Цаг захиалах уу?» with the times read fresh from the calendar (a time the
    website took meanwhile is gone). Never twice, and never once the chat has idled out (30
    minutes), never while a person holds the thread (staff answered in the Page Inbox), and
    never once the customer has sent anything the flow did not take. An old button still means
    the day and time it showed: buttons carry the time itself, never their position or label.

Any typed message that is not an answer to the current question leaves the flow before the
hold (the normal Дали answers it); after the hold the payment still completes on its own.

## Rules reused, not invented (source: `matrix_website`, read 2026-10-02)

| Rule | Website source | Here |
|---|---|---|
| Deposit = stylist level: SPECIAL 20,000₮, Мастер 20,000₮, 1-р зэрэг 10,000₮ (Яармаг only), every booking, children too | `config/stylists.js` `LEVELS`, `config/siteMode.js` `depositFor` | `booking_config.config.levels[].deposit_mnt` (the same three levels in both branches' rows). `from-website.ts` refuses if the website's deposit for a level differs |
| Gender rule (woman→woman stylist, man→the branch's man; girl→woman, boy→the man) | `services/bookingRules.js` | asked first; groups, services and stylists are filtered by it |
| Non-refundable tick box | `bookingRules.js` `DEPOSIT_TERMS_TEXT` | **not said in chat** (founder, 2026-10-03). The chat records the summary accepted instead |
| Hours: Яармаг and Парк Од Mon–Sat 10–20, Sun 11–19; starts every 60 min; last start = close − length; nothing in the past | `data/branches.json`, `routes/calendar.js` | each branch tenant's `business_hours` rows and `tenant_closures`; `config.slot_step_minutes`; same arithmetic |
| Services and lengths: the 2026-10-01 price list, 62 confirmed minutes | `data/services.json`, `data/serviceDurations.json` (non-retired) | `config/booking/tara-salon.json` holds them (CI tests the real list); `from-website.ts` refuses unless they equal the website's exactly |
| Stylists by short Latin names, level, gender, calendar | `config/stylists.js` (Latin keys; Парк Од calendars from `PARKOD_CALENDAR_<NAME>`) | `tara-salon.json` per branch; calendar ids read from the website at run time; none yet: `not-connected` |
| QPay Quick QR v2, terminal `DALATECH_AI`, mcc 7230, description «Name - Phone»; **one merchant and login for both branches, each branch its own payout account** | `api/qpay/create-payment.js` (`YAARMAG_MERCHANT_ID`, both branches), `config/branches.js` `qpayAccountFor` | `config.qpay` per branch row (the merchant id, mcc, the branch's one bank account); no fallback between branches' accounts (see "Per-branch QPay") |
| Calendar event: summary «phone - services», the description lines, «ТЕСТ – » for tests | `services/bookingWriter.js` | the same lines, plus «Source: Messenger (Дали)» and «Branch: …» |
| Test: 100₮ and «ТЕСТ» only for the tester | `config/siteMode.js` | `mode = 'test'`: only the channel's listed testers enter; 100₮; «ТЕСТ» |

## How "never confirmed before paid, never double-booked" is kept

- **No model in the flow.** Every message is a signed platform line with slots filled from rows
  or from the calendar. dali.md C1 («Дали never books») stays true of the model: the only
  sentence that says "booked" is sent by the platform after QPay's own check said paid and the
  calendar write succeeded.
- **A slot is held in two places before any invoice exists.** (1) `booking_holds`, through
  `booking_acquire_hold`: a per-calendar advisory lock, then "no active hold overlaps", then
  insert; a unique index on (calendar, start) for active holds is the second wall. Two chats
  racing: one row. (2) A busy "hold" event in the stylist's Google Calendar with an id derived
  from the hold, so **the website's free/busy no longer offers that time**. After inserting it,
  the calendar is read again: if any other busy event now overlaps (the website wrote first),
  the chat yields, deletes its event and offers other times. No invoice is made for a slot the
  chat does not hold.
- **Paid means QPay said paid.** The callback's body is never read; a signed token names the
  hold and the platform asks QPay `/payment/check`. Payments are recorded once per QPay payment
  id (`booking_payments`, unique, append-only).
- **One booking per hold.** `booking_settle` moves held→paid→booked under a row lock; a second
  payment (two QRs both paid, or paid twice) is recorded as `excess` and **paged at once** for a
  refund; it never makes a second event.
- **Late payment.** After a release the slot is tried again (same lock, same calendar check).
  Free: booked, confirmed, and you are told. Taken: `paid_unbooked`, and at once (a) Дали tells
  the customer the time was taken and offers the nearest free times (the same stylist first, else
  any of the same level, so the same deposit); a time they tap is booked on the money already
  paid (`booking_rebook_hold`: one payment, no new QR) and confirmed; and (b) you are paged on
  Telegram with name, phone and amount, to refund or rebook, and paged again if they rebooked
  themselves. With nothing free to offer, the line says a person will call. Never silent.
- **Every trigger is the same function**: QPay's callback, the pay page's poll, the customer
  writing again, the sweep scheduled for each hold's end, and the minute sweep (the fallback) all
  call `settleHold`, which is idempotent.

## Website and chat holds (one calendar, one rule)

Both sides now hold a time while their customer looks at the QR (website round of 2026-10-03,
matrix_website `services/bookingHold.js`; the chat's hold is described above). The contract:

| | Website hold | Chat hold |
|---|---|---|
| Event id | `sh` + sha256(calendarId\|startISO\|phoneDigits), first 40 hex (base32hex; `w` is not allowed) | `dh` + the hold's uuid hex (32), base32hex |
| Marks | private `taraHold: '1'`, `holdExpiresAt`, `holdPlacedAt` (rewritten on every insert or renewal), `holdPhone` | private `dalaBookingHold: <hold id>`, `dalaBookingState: 'hold'` (then `'booking'` once paid; a paid `dh` event is a booking, not a hold) |
| «Placed» | `holdPlacedAt` (else `created`) | the event's own `created` (no separate property) |
| Expired | `holdExpiresAt` passed: free to both sides, deleted lazily by the website | removed by the chat's sweep at the hold's end (QStash) or within a minute |

- **Free time.** The chat reads Google's free/busy and, for the same window, the events: an
  `sh` hold whose `holdExpiresAt` has passed is taken out of the busy time
  (`calendar.ts` `withoutExpiredHolds`), and any booking that overlapped it stays busy.
- **Two holds on one time: the earlier-placed wins, on both sides.** After writing its hold, each
  side reads the window again and gives its hold back for every other blocking event (a booking
  always wins), except an expired website hold and a hold placed strictly after its own (that one
  yields). A tie: both yield (never two winners). The chat's half is `otherBlocking`; **yes, the
  chat's `dh` re-check yields to an earlier-placed `sh`** (and to an earlier-created `dh`).
- **Never a double booking** either way; at worst a customer is told the time was just taken.

**Proven against the website's own code** (`scripts/verify/booking-e2e.ts` section 16, run with
`MATRIX_WEBSITE=<checkout>`; CI has no checkout and prints SKIPPED). The website's real
`/available-slots`, its paid-booking writer and its own `placeHold`, pointed at the same calendar
the chat uses: a chat hold at 12:00 removes 12:00 from the website; a website customer who pays
for that 12:00 anyway is refused (no second booking) and alerted; a time the website books is
never offered in the chat; for a whole day both offer exactly the same times; the website's live
hold at 16:00 makes the chat say «taken»; its expired hold at 17:00 is offered by the chat; and a
chat hold at 18:00 makes the website's own hold for 18:00 refuse. Section 21 proves the chat's side
of the contract in CI with the fake (live, expired, earlier-placed and later-placed `sh` holds;
every `dh` id base32hex). Run 2026-10-03 against matrix_website `claude/cool-albattani-9om8zg`
(`070bdb8` plus the lead's uncommitted hold work): all pass.

## Switches (all off)

- `BOOKING_MODE` (environment): unset = nothing runs, for every tenant. `test` or `live`.
- `booking_config` row per tenant: `mode` `off` | `test` | `live`, default `off`. No row = off.
  `test`: only the channel's testers, 100₮, «ТЕСТ». `live`: every customer on a live channel.
- Every customer line must be signed (prompt blocks `booking_*`); an unsigned line keeps the
  flow off for that tenant (it answers as today).

## Branches (Яармаг, Парк Од)

Each branch is its own tenant (D-157) with its own `booking_config` row, built from ONE rules file,
`config/booking/tara-salon.json`: the same services, minutes, levels, deposits, entry words and
children's rule; each branch's own stylists (Яармаг: Oyunaa SPECIAL, Badamaa Мастер, Uyanga /
Zaya / Chimgee / Otgonjargal 1-р зэрэг, Anand Мастер, the only man; Парк Од: Boloroo SPECIAL, Saraa, Tomoo,
Bulgaa, Enhuush, Chimegee, Tuchku, all Мастер, Tuchku the only man), its own calendars, its own
address and hours (its rows), and **its own payout account** (the bank account its deposits are paid
into; both branches invoice under the same QPay merchant and login).

`scripts/booking/check.ts --group tara-salon` refuses when the branches' services, minutes,
service buttons, levels, deposits, entry words or children's rule differ, and when a calendar or
a payout account appears in two branches (the same merchant id in both is expected).

**Not connected yet.** Парк Од's calendar ids and her bank account are not given yet. Her row says so
with the literal `not-connected` (each stylist's `calendar_id`, and `qpay`). Such a row parses
(its shape is checked) but books nobody, testers included (`reason: not_connected`); the ordinary
Дали answers. One placeholder left is enough to keep the branch off. Nothing is ever borrowed
from Яармаг.

## Per-branch QPay

Founder, 2026-10-04: Парк Од does **not** get a QPay merchant or login of her own. Both branches
invoice under the founder's existing merchant on the platform's Quick QR partner login, exactly as
Яармаг and Core Language do: `QPAY_USERNAME` / `QPAY_PASSWORD` / `QPAY_TERMINAL_ID` (terminal
`DALATECH_AI`, the website's login too), a secret from the environment only (rule 7), the same for
every tenant. The ONLY difference is the **payout account**, the bank account the invoice names in
`bank_accounts` (Парк Од: her Khan Bank account). The row (`booking_config.qpay`, not secret) holds
`merchant_id`, `mcc_code` and `bank_accounts: [{ bank_code, account_number, account_name }]`; for
Tara both rows carry the same merchant id and mcc, and so the same invoice but for `bank_accounts`
(a unit test and the e2e compare the two invoice bodies field by field). There is no per-tenant
login (`qpay.login` is refused).

An invoice is refused, and no QR exists, when: the row's `qpay` is `not-connected`; the platform's
login is missing; another tenant's `booking_config` names the same payout account (checked in the
database before every invoice; you are paged once, `booking.account_shared`); or QPay itself
refuses. Each invoice row records the merchant and payout account it was made with
(`booking_invoices`, 0082), so changing a branch's row while a QR is out never strands a paid
deposit. If the login is missing from the environment while QR codes are out, nothing is read: you
get one alert per tenant (`booking.qpay_login_missing`, an episode that closes once it reads
again). A tenant whose `booking_config` becomes unusable still has its payments read and recorded;
only the booking waits until the row is fixed. The website does the same for Парк Од from
`PARKOD_QPAY_BANK_CODE`, `PARKOD_QPAY_ACCOUNT_NUMBER`, `PARKOD_QPAY_ACCOUNT_NAME` (its
`qpayAccountFor('parkod')`: Яармаг's login and merchant, her account; complete only when all three
exist and the account is not Яармаг's); `from-website.ts` reads her values under those same names
from the operator's shell, so both sides carry the same values. QPay's own documentation could not
be reached from this environment: that a payment settles to the invoice's `bank_accounts` is
inferred from the SDKs, so **the proof is a real 100₮ test landing in HER account** before her
row goes beyond `off`.

## Setting it up for a branch

`node scripts/booking/from-website.ts --website ../matrix_website --rules config/booking/tara-salon.json
--slug <branch> [--tester <PSID>] --out <file.sql>` builds the branch's row:
the rules file's services, minutes and stylists, checked against the website (every service and
minute equal to its current list; every stylist at that branch with the same level, gender and
deposit; a disagreement stops it, never picked), the calendar ids from the website's
`config/stylists.js` (`not-connected` where it has none), and the QPay: the website
create-payment handler's one merchant id and mcc for every branch, and the branch's own payout
account: Яармаг's from the website's `config/branches.js`; Парк Од's from
`PARKOD_QPAY_BANK_CODE` / `_ACCOUNT_NUMBER` / `_ACCOUNT_NAME` in the operator's shell, else
`not-connected`. It refuses an account equal to another branch's. The merchant, account and
calendar ids are never copied into this repository. The row is written with mode `off`.

## What is not built

- More than one service per booking (the website lets several be ticked and sums them).
- Moving or cancelling a booking in chat; refunds (always by a person).
- Instagram and the website chat (Messenger only).
- Asking whether the booking is for the customer or someone else of the other gender (the
  «who for» answer decides the stylists; a woman booking for her husband taps «Эрэгтэй»).
- Alerts to a branch owner (founder, 2026-10-04): for now every booking alert reaches only the
  founder; Boloroo checks Парк Од's Messenger herself. Nothing is built for owner alerts.

## Switching it on for Tara Яармаг (the founder's steps, in order)

Nothing below has been done but step 1. Each other step is yours: credentials, migrations, a live switch.

1. **Sign the wording.** DONE 2026-10-04: set `c787decc1f0a`, signed by Bilguun (all 42
   `booking_*` blocks, at the founder's request), seeded by `0084_prompt_blocks_seed` at layer
   null. Until `0084` is applied, the flow refuses to start (it reads the signed rows).
2. **Apply `0082_booking`, then `0083_photo_question_price_page` (PR #283), then
   `0084_prompt_blocks_seed`**, in that order (`0084` is numbered past #283's `0083` so the two
   cannot collide; merge #283 first, or `supabase db push` refuses the out-of-order `0083`). Then
   merge the PR (D-058: code that reads a table only after the push).
3. **Vercel → dala-ai → Environment Variables (Production).**
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`: copy them from the matrix_website
     Vercel project, same names. This is the service account the stylists' calendars are shared
     with.
   - `BOOKING_LINK_SECRET`: `openssl rand -base64 36`.
   - `SUPABASE_SECRET_BOOKING`: a new secret key (Supabase → Settings → API keys).
   - **Confirm** that the platform's `QPAY_USERNAME` / `QPAY_PASSWORD` / `QPAY_TERMINAL_ID` are the
     same Quick QR partner login the website uses (terminal `DALATECH_AI`), the one the merchant
     both branches invoice under is registered under. If not, copy the website's values under
     those names.
   - `BOOKING_MODE=test`. Preflight refuses the deploy if anything above is missing.
4. **QStash.** Add one schedule: every minute, POST `https://api.dalatech.online/api/workers/booking`,
   empty body. It is the fallback (each hold's end is also scheduled by itself, through the same
   `QSTASH_TOKEN`); it releases unpaid holds and books late payments. With `BOOKING_MODE` unset it
   answers "disabled".
5. **The row.** Run `node scripts/booking/from-website.ts --website <matrix_website checkout>
   --rules config/booking/tara-salon.json --slug matrix-eco-salon
   --tester <your PSID on Tara's Page> --out booking.sql`. Read the summary and run `booking.sql`
   in the Supabase SQL editor. It writes mode `off`. Then run:
   `update booking_config set mode = 'test' where tenant_id = (select id from tenants where slug = 'matrix-eco-salon');`
6. **One real 100₮ test.**
   - From your own Messenger, write «Цаг авъя» to Tara's Page.
   - Book a time at least a day ahead and pay **100₮** from your bank app.
   - Check four things: the confirmation in Messenger (marked ТЕСТ); one «ТЕСТ – <phone> - <service>»
     event in that stylist's Google Calendar; one row in `booking_payments`; the 100₮ in Tara's
     QPay merchant app.
   - Then delete the calendar event, and refund the 100₮ if you want it back.
   - Also try «Цуцлах» once, and once let the 5 minutes pass: the time must come free again, the
     website must offer it again, and Дали must say so with «Цаг сонгох».
7. **Live.** Set `update booking_config set mode = 'live' …` for the tenant, and `BOOKING_MODE=live`
   in Vercel, then redeploy. Every customer on Tara Яармаг's live Page can then book in chat;
   every other tenant stays off (no row). To stop: set the row's `mode = 'off'`. That takes effect
   on the next message, with no deploy. Holds already open are still settled or released.

**Парк Од** (after Яармаг works), in order:
1. Her tenant `tara-park-od` onboarded (another round), with her hours (Mon–Sat 10–20, Sun 11–19),
   address and Page.
2. Her booking account and stylists' calendars: the booking account tarasalon.parkod@gmail.com
   exists (2026-10-04). Each stylist shares her calendar with it and with the website's service
   account («make changes to events»); the calendar ids go into the website's
   `PARKOD_CALENDAR_<NAME>` variables.
3. Her QPay: nothing to register. She uses your existing merchant and login, exactly as Яармаг
   does; only her bank account is hers. Put her Khan Bank account into the website's
   `PARKOD_QPAY_BANK_CODE` (Khan Bank: 040000), `PARKOD_QPAY_ACCOUNT_NUMBER` and
   `PARKOD_QPAY_ACCOUNT_NAME` (the holder's name as the bank has it). **The proof is step 5**: a
   real 100₮ landing in HER account.
4. `PARKOD_QPAY_BANK_CODE=… PARKOD_QPAY_ACCOUNT_NUMBER=… PARKOD_QPAY_ACCOUNT_NAME=…
   PARKOD_CALENDAR_…=… node scripts/booking/from-website.ts --website <checkout> --rules
   config/booking/tara-salon.json --slug tara-park-od --tester <PSID> --out park.sql`;
   the summary must say «connected». Run it, then `node scripts/booking/check.ts --group tara-salon`
   (it must print «the branches book alike»).
5. One 100₮ test on her Page, as step 6 above, and check the 100₮ arrived in HER bank account
   (not Яармаг's). Until that 100₮ is seen there, her row stays `off`: this is the only proof that
   her deposits reach her account.

**Domain.** Tara's website moves to **tarasalon.org** (bought at Namecheap; the website's
`docs/DOMAIN_MOVE.md`), not tarasalon.mn. Nothing in the in-chat booking names the website's
domain: the pay page is dala-ai's own link, and `from-website.ts` reads a checkout, not a URL.
Until the switch, live links stay on matrixecosalon.org; DNS is not touched here.
