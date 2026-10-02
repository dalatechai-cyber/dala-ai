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
5. **Day**: the next open days that have at least one free start for that service (closed
   days and closures skipped).
6. **Time**: the free starts that day, read from the stylists' real Google Calendars, a start
   only if the whole service fits before closing (the website's rule).
7. **Name and phone** (typed; the phone must be 8 digits), then **the deposit agreement**,
   Tara's own sentence from the website, with «Зөвшөөрч байна».
8. Дали holds the time and sends **one message with a «Төлбөр төлөх» button**: the summary and
   the deposit (Мастер 20,000₮, 1-р зэрэг 10,000₮: Tara's rule, see "Rules reused"). The
   button opens a page with the QPay QR and one button per bank app; on a phone one tap opens
   the bank app with the payment filled in. The QR is valid five minutes with a countdown and
   «new QR» while the hold lasts (10 minutes).
9. **The moment QPay confirms the payment**, the booking is written into the stylist's
   calendar and Дали sends the confirmation: service, stylist, date, time, the branch and its
   address.
10. Not paid in time: the hold is released, the QPay invoice cancelled, and Дали says so once,
    politely, offering to start again.

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
  Free: booked and confirmed. Taken: `paid_unbooked`, an immediate alert («paid, no time:
  refund or rebook») with the customer's phone, and one line to the customer that a person will
  call. Never silent.
- **Every trigger is the same function**: QPay's callback, the pay page's poll, the customer
  writing again, and the sweep (`/api/workers/booking`, every minute) all call `settleHold`,
  which is idempotent.

## Website vs chat (what the website does not do)

The website keeps no hold while its customer looks at the QR, and its create-payment does not
re-check the time. So a website customer can pay for a time a chat customer is holding; the
website then re-checks at write time, sees the chat's busy event, writes its own "paid, slot
taken" note and alerts on Telegram (its existing PR #77 behaviour). **No double booking either
way**; the loser is a refund. The change request that would make the website hold too is
`docs/proposals/matrix-website-booking-holds.md` (not done here: that repo is read-only for
this work).

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
   empty body. It releases unpaid holds and books late payments. With `BOOKING_MODE` unset it
   answers "disabled".
5. **The row.** Run `node scripts/booking/from-website.ts --website <matrix_website checkout>
   --rules config/booking/tara-salon.json --slug matrix-eco-salon --stylists "Оюунсүрэн=Оюунаа,Бадамцэцэг=Бадмаа,Батзаяа,Уянга,Отгонжаргал"
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
   - Also try «Цуцлах» once, and once let 10 minutes pass: the time must come free again.
7. **Live.** Set `update booking_config set mode = 'live' …` for the tenant, and `BOOKING_MODE=live`
   in Vercel, then redeploy. Every customer on Tara Яармаг's live Page can then book in chat;
   every other tenant stays off (no row). To stop: set the row's `mode = 'off'`. That takes effect
   on the next message, with no deploy. Holds already open are still settled or released.

**Парк Од:** once she is onboarded (her own tenant and Page) and her stylists' calendars are shared
with the same service account, run the same `from-website.ts` with her own `--slug` and
`--stylists`. Then run `node scripts/booking/check.ts --group tara-salon`. It refuses when the two
branches' services, minutes, deposits, agreement or merchant differ, or when a calendar is in both.
