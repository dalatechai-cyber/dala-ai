# Booking and paying the deposit inside Messenger (Tara) — design

Status: **built, switched off for every tenant** (branch `claude/happy-pasteur-4gp7gd`). Written
2026-10-02 before the code, then kept in step with it. Nothing here is live, and no customer
reads a word of it until the founder signs the drafts and switches it on.

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
2. **Service**: a group, then the service (Tara's bookable list and its minutes, from the
   website's `data/serviceDurations.json`).
3. **Who it is for**: «Эмэгтэй / Эрэгтэй» (the website's gender rule: a woman books a woman
   stylist, a man a man).
4. **Stylist**: each stylist of that gender with their level («Оюунаа · Мастер»), plus «any
   Мастер» and «any 1-р зэрэг». The level sets the deposit.
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
   stylist, day, time, the deposit, and Tara's own deposit sentence from the website, with one
   button, «Зөвшөөрч, захиалах». Nothing is held and no QR exists before this tap.
8. Дали holds the time and sends **one message with a «Төлбөр төлөх» button**: the summary and
   the deposit (Мастер 20,000₮, 1-р зэрэг 10,000₮: Tara's rule, see "Rules reused"). The
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
| Deposit = stylist level: Мастер 20,000₮, 1-р зэрэг 10,000₮, every booking | `config/stylists.js`, `config/siteMode.js` `depositFor` | `booking_config.config.levels[].deposit_mnt`. Agrees with Яармаг's live `deposit_rules` rows (Мастер 20,000₮, 1-р зэрэг 10,000₮, SPECIAL 20,000₮). The brief said 20,000₮; Tara's rule is per level, so 1-р зэрэг is 10,000₮ |
| Gender rule (woman→woman stylist, man→man) | `services/bookingRules.js` `checkGenderMatch` | the stylist step only offers that gender |
| Non-refundable agreement, verbatim | `bookingRules.js:22` | `config.agreement_text`, recorded with the time it was accepted |
| Hours Mon–Sat 10–20, Sun 11–19; starts every 60 min; last start = close − length; nothing in the past | `routes/calendar.js` | the tenant's `business_hours` rows (identical today) and `tenant_closures`; `config.slot_step_minutes`; same arithmetic |
| Service lengths, unknown → 60 | `data/serviceDurations.json` | `config.services[].minutes` (copied) |
| QPay Quick QR v2, terminal `DALATECH_AI`, mcc 7230, one merchant and bank account, description «Name - Phone» | `api/qpay/create-payment.js` | `config.qpay` (merchant id, mcc, bank account) + the platform's `QPAY_*` credentials |
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

## Website vs chat (what the website does not do)

The website keeps no hold while its customer looks at the QR, and its create-payment does not
re-check the time. So a website customer can pay for a time a chat customer is holding; the
website then re-checks at write time, sees the chat's busy event, writes its own "paid, slot
taken" note and alerts on Telegram (its existing PR #77 behaviour). **No double booking either
way**; the loser is a refund. The change request that would make the website hold too is
`docs/proposals/matrix-website-booking-holds.md` (not done here: that repo is read-only for
this work).

**Proven against the website's own code** (`scripts/verify/booking-e2e.ts` section 16, run with
`MATRIX_WEBSITE=<checkout>`; CI has no checkout and prints SKIPPED). The website's real
`/available-slots` route and its real paid-booking writer, pointed at the same calendar the chat
uses: a chat hold at 12:00 removes 12:00 from the website at once; a website customer who pays
for that 12:00 anyway is refused by the website (no second booking) and the salon is alerted
with their phone; a time the website books is never offered in the chat; and for a whole day
the chat and the website offer exactly the same times. Run 2026-10-02 against matrix_website
`e1f1f4e`: all pass.

## Switches (all off)

- `BOOKING_MODE` (environment): unset = nothing runs, for every tenant. `test` or `live`.
- `booking_config` row per tenant: `mode` `off` | `test` | `live`, default `off`. No row = off.
  `test`: only the channel's testers, 100₮, «ТЕСТ». `live`: every customer on a live channel.
- Every customer line must be signed (prompt blocks `booking_*`); an unsigned line keeps the
  flow off for that tenant (it answers as today).

## Branches (Яармаг, Парк Од)

One `booking_config` row per branch tenant: its own stylists and calendars, its own address
(from its `contact_points`), the same services, minutes, deposits and QPay merchant.
`scripts/booking/check.ts --group tara-salon` refuses when the branches' services, minutes,
deposits, agreement or merchant differ, or when a calendar id appears in two branches.

## Setting it up for a branch

`node scripts/booking/from-website.ts --website ../matrix_website --rules config/booking/tara-salon.json
--slug <branch> --stylists "Оюунсүрэн=Оюунаа,…" --out <file.sql>` builds the `booking_config` row
from the website's own `config/stylists.js` (calendars, levels, deposits, genders),
`data/serviceDurations.json`, `services/bookingRules.js` (the agreement) and
`api/qpay/create-payment.js` (merchant, mcc, bank account). The merchant, account and calendar ids
are never copied into this repository. The row is written with mode `off`. It refuses a stylist the
website does not know, a website service missing from the groups, or anything the platform's parser
would refuse.

## What is not built

- More than one service per booking (the website lets several be ticked and sums them).
- Moving or cancelling a booking in chat; refunds (always by a person).
- Instagram and the website chat (Messenger only).
- The website's own hold (change request).

## Switching it on for Tara Яармаг (the founder's steps, in order)

Nothing below has been done. Each step is yours: wording, credentials, a migration, a live switch.

1. **Sign the wording.** Read `docs/proposals/tara-inchat-booking-transcript.md` (every draft in
   context), then `node scripts/prompt/sign-drafts.ts --dir prompt/drafts/booking`, then sign with
   `--set <id> --by Bilguun`, and push. Until it is signed, the flow refuses to start.
2. **Apply `0082_booking`.** Then merge the PR (D-058: code that reads a table only after the push).
3. **Vercel → dala-ai → Environment Variables (Production).**
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`: copy them from the matrix_website
     Vercel project, same names. This is the service account the stylists' calendars are shared
     with.
   - `BOOKING_LINK_SECRET`: `openssl rand -base64 36`.
   - `SUPABASE_SECRET_BOOKING`: a new secret key (Supabase → Settings → API keys).
   - **Confirm** that the platform's `QPAY_USERNAME` / `QPAY_PASSWORD` / `QPAY_TERMINAL_ID` are the
     same Quick QR login the website uses. The website sends terminal `DALATECH_AI` with its own
     `QPAY_USERNAME`/`QPAY_PASSWORD`. If they are different logins, copy the website's values and
     tell Claude: the code then needs a per-tenant QPay login, which is not built.
   - `BOOKING_MODE=test`. Preflight refuses the deploy if anything above is missing.
4. **QStash.** Add one schedule: every minute, POST `https://api.dalatech.online/api/workers/booking`,
   empty body. It is the fallback (each hold's end is also scheduled by itself, through the same
   `QSTASH_TOKEN`); it releases unpaid holds and books late payments. With `BOOKING_MODE` unset it
   answers "disabled".
5. **The row.** Run `node scripts/booking/from-website.ts --website <matrix_website checkout>
   --rules config/booking/tara-salon.json --slug matrix-eco-salon --stylists "Оюунсүрэн=Оюунаа,Бадамцэцэг=Бадмаа,Ананд,Уранчимэг,Батзаяа,Уянга,Отгонжаргал"
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

**Парк Од:** once she is onboarded (her own tenant and Page) and her stylists' calendars are shared
with the same service account, run the same `from-website.ts` with her own `--slug` and
`--stylists`. Then run `node scripts/booking/check.ts --group tara-salon`. It refuses when the two
branches' services, minutes, deposits, agreement or merchant differ, or when a calendar is in both.
