# Change request for `matrix_website` (Tara's booking site): hold the time while the customer pays

For a later session in the `dalatechai-cyber/matrix_website` repository. **Nothing here is done.**
That repository was read-only for this work (2026-10-02, at commit `e1f1f4e`, after PRs #76–#79).
Context: the in-chat booking flow in dala-ai (`docs/proposals/tara-inchat-booking.md`) books into
the same stylist calendars the website does.

## Why

The chat flow is already safe against the website. Before it shows a QR, it does three things:

1. It puts a busy HOLD event in the stylist's calendar.
2. It looks again after inserting the event.
3. It re-checks the calendar before writing the booking.

Two chats racing are serialised in dala-ai's database. The end-to-end check proves all of this
(`scripts/verify/booking-e2e.ts`, section 7).

The website keeps **no hold** while its customer looks at the QR, and the gap is on its side:

- `api/qpay/create-payment.js` makes the invoice without asking the calendar whether the time is
  still free. Only `renewQr` in `script.js` re-checks.
- So a website customer can open a QR for a time that a chat customer is already holding, or has
  just booked, and pay it.
- PR #77's write-time re-check then catches the clash. It writes a "⚠ ТӨЛСӨН, ЦАГ ДАВХЦСАН" note
  and sends a Telegram alert, so a person must refund or rebook.
- There is no double booking, but the customer is disappointed and someone has to refund.

## The changes, in order of value

1. **Check the time before making the invoice.** In `api/qpay/create-payment.js`, before
   `POST /invoice`:
   - run `calendar.freebusy.query` over `[start, start + totalDurationFor(services))` on the
     stylist's calendar;
   - if the time is busy, answer 409 with the existing slot-taken message:
     «Уучлаарай, энэ цаг өөр хүнд захиалагдсан байна. Өөр цаг сонгоно уу.»;
   - the browser already handles that path for `renewQr`.

2. **Hold the time while the QR is open.** The same way the chat does:
   - Insert an opaque event with a deterministic id before the invoice, for example
     `'wh' + sha256(calendarId|startISO|phoneDigits).slice(0,40)`. The prefix `wh` keeps it apart
     from the chat's `dh…`, so the two can never collide.
   - Look at the window again, and give the time back if anything else now overlaps.
   - On payment, rewrite the event into the booking (keep `qb…` as the booking id, or patch the
     `wh…` event).
   - When the 5-minute QR and its renewals end unpaid, delete the event. A sweep is needed because
     the site has no database: for example, a Vercel cron that deletes `wh…` events whose
     `extendedProperties.private.expiresAt` has passed.
   - Without (2), (1) still leaves a few seconds open between check and payment. With (2), a
     website customer and a chat customer can never both reach a QR for one time.

3. **Read the closure from the same place.** The website reads `SALON_CLOSURE_*` from its
   environment (`config/closures.js`). The chat reads dala-ai's `tenant_closures` rows. Until one
   reads the other, **a closure must be set in both**, or the chat will offer times on a closed
   day. One option: dala-ai reads the website's `GET /api/calendar/closures`. That would be a
   dala-ai change, and it was not built here.

4. **Move the merchant out of the code.**
   - `merchant_id`, `account_number` and `account_name` are hard-coded in
     `api/qpay/create-payment.js`.
   - `QPAY_MERCHANT_ID` is documented in `.env.example` but the live handler does not read it.
   - dala-ai's `scripts/booking/from-website.ts` reads these three values out of that file today.
     If they move to the environment, give that script the values as arguments instead.

## Facts the founder should settle (they differ between the two systems)

- **Stylists.** The website books Уранчимэг (1-р зэрэг) and Ананд (Мастер, male). In dala-ai,
  Уранчимэг has no `staff_members` row and Ананд's row is inactive. The proposed chat
  configuration for Яармаг books Оюунаа, Бадмаа, Батзаяа, Уянга and Отгонжаргал (all women).
  With that list, **a man cannot book in chat** (the gender question offers only «Эмэгтэй»).
- **Map link.** The website's footer links `maps.app.goo.gl/1X9q6weeFyHgXVpKA`. dala-ai's
  `contact_points` row for Яармаг is `maps.app.goo.gl/ckEXBLoq4FnxJHq16`. The chat's
  confirmation sends the address row only, not a map link.
- **Durations.** 21 of the website's 25 service lengths are engineering estimates
  (`"confirm": true` in `data/serviceDurations.json`). The chat uses the same numbers, so a wrong
  estimate is wrong in both places.
- **Branches.** The website has no notion of a branch. Парк Од's stylists need their own
  calendars (shared with the same service account) before Парк Од can book in chat. If the
  website is to book Парк Од too, it needs a branch choice.
