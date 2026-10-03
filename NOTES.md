# NOTES — Round 2026-10-03: two-branch in-chat booking

Branch `claude/tara-inchat-booking-two-branch` (worktree `/home/user/dala-wt/booking`), stacked on
draft PR #280 (`claude/happy-pasteur-4gp7gd`, 87a8875). Booking stays OFF for every tenant. Migration
0082 NOT applied; edited only by one comment (agreement_text now records the accepted summary).

## Status
- [x] Service list: current 2026-10-01 price list (62 services, website keys) with the 62 confirmed
      minutes, in `config/booking/tara-salon.json`; old menu gone. Prices: Дали's SQL and the website's
      `data/services.json` agree on every price; NAME differences reported, not picked (see Findings).
- [x] Stylists by Latin names, per branch; Отгонжаргал removed (flagged). Парк Од block with
      `not-connected` calendars and QPay. Levels/deposits SPECIAL/Мастер 20,000, 1-р зэрэг 10,000.
- [x] No deposit terms in chat: `booking_ask_agreement` lost «Нөхцөл: «{agreement}»»; `agreement_text`
      refused in config; the hold records the summary accepted.
- [x] Per-branch QPay: merchant + payout account are rows per tenant; optional own login
      `BOOKING_QPAY_<login>_*`; no fallback; invoice refused if not connected, login incomplete, merchant
      or account in another tenant's row, or QPay refuses it.
- [x] Website hold contract (lead): `sh` prefix, holdExpiresAt/holdPlacedAt; expired `sh` free; earlier-
      placed wins; chat holds recognised by `dalaBookingState: 'hold'` only (lead's review finding).
- [x] e2e 247 local (11 run the website's own code incl. its placeHold), 236 CI-shaped; unit + check green;
      5 SQL suites + query columns, postgrest.ts, billing-e2e 118 pass locally (PG16 + PostgREST 12.2.3).
- [x] Draft PR #285 (base claude/happy-pasteur-4gp7gd). CI green on 8287e82 (booking e2e 235 in CI).
- [x] Independent review (remote reviewer session, Opus, read-only, ~$2.59 of session spend): 3 findings,
      all fixed: (1) invoices record merchant/account/login (0082 columns) and are checked/cancelled on
      that login, not the row's current one; (2) no tenant slug literals in src/ (tests name branches by
      their place in the rules file); (3) an own QPay login shared by two tenants is refused/flagged.
      The lead's finding (chat hold by dalaBookingState only) also fixed.

## Decisions (with reason)
1. Rules file holds services WITH minutes (not only the website): CI can test the real list; from-website.ts
   refuses unless they equal the website's current list exactly (one source checked, two copies).
2. Service names = the website's keys («Эмэгтэй будаг — TARA BLEND (Урт)»): the duration sheet and the
   website's calendar events use them. Button labels = the price list's words; shortened only where > 20.
3. Groups = the price list's sections with an `audience` (women's/men's sections shown only to that gender).
   «Гоёлын засалт /эрэгтэй/» (printed in the women's section) is offered to men, in «Эрэгтэй засалт»:
   it is a men's styling. Founder question.
4. `family` (one button, then lengths/levels) because «Эмэгтэй хими» has 18 lines and Messenger shows 13.
   One new draft line `booking_ask_variant` «{service} — аль нь вэ?».
5. A price line per level (`level`) is served only by that level; a line nobody may serve is hidden
   (men's SPECIAL haircut everywhere; 1-р зэрэг haircut at Парк Од). This also guarantees no 1-р зэрэг
   button at Парк Од. Levels are identical in both rows (one price list); Парк Од just has no 1-р зэрэг.
6. «Not connected» = literal `not-connected` in `calendar_id` / `qpay`: parses (shape checked, branches
   compared) but `customerMode` off and `bookingTurn` reason `not_connected`, testers included.
7. Merchant id/account are rows (not secret; the website has Яармаг's in source). Login stays env (rule 7).
   Own login named by the row (`qpay.login`), env `BOOKING_QPAY_<LOGIN>_*` so the env guard sees the prefix.
8. One merchant = one tenant, checked before every invoice by reading other tenants' booking_config
   (`merchantSharedWith`), plus `check.ts` (`shared_merchant`). Unreadable → refused.
9. Website holds: busy() = free/busy minus expired `sh` holds plus the other events (one events.list per
   calendar per read; fine at today's volume). Placed-at: website `holdPlacedAt` else `created`; ours
   `created` (no own property written). Tie → we yield.
10. Agreement: Дали never shows terms; the hold's agreement_text = the summary shown (evidence of what was
    accepted). Consequence for the founder: chat customers never agree to «non-refundable» in writing.
12. Invoices record merchant_id/payout_account/qpay_login (0082 edit, unapplied): the login an invoice was
    made on is the only one that can read or cancel it (QPay scopes invoices per login; the fake does too).
11. testConfig() is now Tara's real Яармаг config (test calendars/merchants), so unit tests and e2e prove the
    real list; section numbers: 19 updated, 20 (two branches), 21 (hold contract) new.

## Findings
- Prices agree (SQL vs website). Name differences: «Afro хими» (site) / «Афро хими» (SQL); «TARA LUMI» /
  «TARA Lumi»; «Уг будаг» / «Үсний угийн будаг»; men's «Хуйхны цэвэрлэгээ» vs «Хуйх цэвэрлэгээ», and the
  site lists the men's «Хуйхны цэвэрлэгээ» and «Нөхөн сэргээх эмчилгээ» separately while SQL merges them;
  girls' haircut «Эмэгтэй засалт — Тайралт хүүхэд» / «Хүүхдийн тайралт (охин)»; «Үс оношлогоо, зөвлөгөө»
  (site key drops the comma). Not picked.
- dala-ai's staff rows (matrix-stage4-kb.sql / intake) disagree with the founder's list: Ананд active=false
  («left»), Уранчимэг absent, Г. Мөнхзаяа active (in neither the website nor the list), Отгонжаргал active.
  dala-ai holds no stylist levels (only deposit_rules), so no level disagreement; the website matches the
  founder (Oyunaa special, Badamaa/Anand master, Uyanga/Zaya/Chimgee first).
- Website `bookingRules.js` DEPOSIT_TERMS_TEXT is the non-refundable sentence that the summary used to quote.

# NOTES — Tara in-chat QPay booking (session 2026-10-02, resume point)

Branch: `claude/happy-pasteur-4gp7gd`. Brief: in-Messenger booking + QPay deposit for Tara, built OFF
for every tenant, draft PR, merge nothing. All new Mongolian = drafts. No real QPay charges.
Previous session's notes moved to `docs/notes-2026-10-02-overnight.md`.

## Status
- [x] Investigate (website report summarised in the design doc; live asks counted)
- [x] Design `docs/proposals/tara-inchat-booking.md`
- [x] Migration `0082_booking.sql` (all 5 SQL suites pass locally; schema.md row)
- [x] Build (flag off), fake QPay, fake calendar, tests, reply cases
  - [x] src/lib/booking/{config,slots,calendar,wording,store,links,engine,turn}.ts (typecheck ok)
  - [x] send.ts quick replies + linkButtonTitle; extract.ts quickReplyPayload; billing qpay mccCode
  - [x] prompt/drafts/booking/*.mn.txt (32 drafts + README)
  - [x] pay page + /book route, /api/booking/qpay, /api/workers/booking, worker hook, clients, env, preflight
  - [x] testkit fakes, unit tests (23), worker hook tests (4), booking-e2e.ts 88 checks (+ CI step), transcript
  - [x] scripts/booking/from-website.ts (config from website checkout), scripts/booking/check.ts (branches)
  - [x] docs/proposals/matrix-website-booking-holds.md (change request)
- [x] Draft PR https://github.com/dalatechai-cyber/dala-ai/pull/280 (subscribed)
- [x] Preview artifact https://claude.ai/artifact/93ZE7ihKniDXXhm6gA4ocH (regenerate: scratchpad python from transcript + page renders); Vercel preview dala-ai-git-claude-happy-past-6bccc0-bilguuns-projects-a8563d8e.vercel.app
- [x] Opus review done (2nd run; 1st lost to container restart). Fixed 1-10: confirmation re-sent + session closed on
      already-booked; name/phone miss-once-then-let-go + typed «Цуцлах»; short payment no longer pins hold (end_hold
      refuses only applied/late_*); reused hold placed in calendar before invoice; start-in-past refused (+SQL starts_at>now);
      invoices marked paid, leftovers cancelled after booking, uncancellable QR paged + swept 24 h; expireHold never
      releases on unavailable; poll throttled 15 s/hold (last_checked_at); sweep per-hold try/catch + 80 s budget;
      branch_label config; gender null when no rule; stricter bank-link schemes. e2e now 105 checks.
      Not changed (report): #11 alerts carry name+phone to shared Telegram; #12 preflight cannot see 0082 applied.
- [x] Re-review of d7fdc32: fixed its 4 findings (paid_unbooked re-tell, notified_at + sweep of untold holds, cancel while QPay down -> Дали answers, invoice marked paid even on duplicate + never cancel a paid invoice). e2e 112.
- [x] CI green on 14ee5fe (e2e 112 in CI log). Final report delivered.
- [x] Founder follow-up (2026-10-02, later): ask WHEN in words, check, offer nearest times, «okay» -> QR,
      one follow-up if quiet, Messenger and website never cross. Built: when.ts parser, offerTimes, confirm summary,
      followUps in the minute sweep, value-carrying button payloads, followed_up_at column (0082, unapplied),
      e2e section 15 (+22) and 16 (website's OWN code, +8 when MATRIX_WEBSITE set). e2e 142 local.
- [x] Opus review of 06098f0: 8 findings, all fixed: follow-up now skips a thread a person holds (any `human`) and
      a conversation with a newer customer message, re-reads the session before sending, never sends an `exists`
      draft, refuses an undelivered follow-up so no retry sends it late, logs every failed read, has a time budget,
      marks skipped chats; an old button whose value is not on offer is never matched by its title (its own day and
      time, or «taken» + nearest); parser: «14:30-нд» minutes not a day, two days / «биш» -> ask again, «үдээс өмнө»/
      «өглөө» morning, «цагийн дараа» not a time, «хагас»/«минут», bad hour keeps the day; a question with no hour and
      the same day again count as misses; closed/beyond-window day says «боломжгүй», not «full»; off-grid hour gets
      the nearest times, not «taken». e2e 149 locally (141 in CI, 8 need MATRIX_WEBSITE).
- [x] CI green on 5f467f6 (141 in CI; 8 website-code checks SKIPPED there by design).
- [x] Re-review of 5f467f6: fixed its gaps: an hourless question at «when» is answered with times but counts as
      a miss (so the flow still lets go); the follow-up also sees replies sent since the offer (a photo's image
      line) via outbound_messages, comparing at microsecond-safe precision; failed/`exists` follow-up drafts are
      refused (never sent late, never read back as a turn); shadow keeps its draft; budget stops before a
      follow-up that could overrun; today after closing says «боломжгүй»; «цагийн үед»/«цагаар» read as a time.
      e2e 152 locally.
- [x] CI green on 405e502 (144 in CI). Third review: fixed its gaps: a sticker / file / unanswered photo
      (only the dropped-message flag) also stops the follow-up; «today» with nothing that can still start says
      «боломжгүй»; «цагийн өмнө/дотор/турш» are lengths, not times; an `exists` follow-up draft younger than
      2 min is left to the run that may be sending it (runs can overlap). e2e 153 locally.
- [x] CI green on bb52b3f (145 in CI). Final review: all 4 fixed; closed its leftovers: an unreadable draft time
      now logs as a failure (never a silent skip); bare «цаг өмнө/дотор/дараа» are lengths too; e2e now covers the
      leftover-draft path both ways and «өнөөдөр» when nothing can still start. e2e 156 locally.
      Not done (noted): quality_flags has no index for the follow-up's read (fine at today's volume).
- [x] CI green on d236bab (148 in CI). Done; PR body updated.
- [x] Founder follow-up (2026-10-03): QR = hold = exactly 5 min; scheduled sweep at the hold's end (QStash
      notBefore) + minute fallback; expiry message with «Цаг сонгох» (bk:start); late payment free -> booked,
      taken -> nearest free times (same stylist first) + rebook on the same deposit (booking_rebook_hold) + alerts;
      one held per customer (unique index + customer_has_hold -> release old, then hold new); pay page has no
      «new QR» once it runs out. e2e section 17 (+21). e2e 177 locally.
- [x] CI green on 57b2ee6. Opus review: 11 findings; fixed: a rebooked deposit that loses its time again is told
      and paged again (round in every key); duringPay no longer closes the rebook chat it just opened (close only
      at step pay); the rebook offer has a 30-min deadline in SQL, named in the page; «Цаг сонгох» in any open
      chat restarts and no button is ever a name or phone; the pay page asks QPay before «ended» and keeps
      polling a minute; offerRebook opens a chat only with an offer, closes it on failure; the page text follows
      what was delivered; expiry minutes never 0; the 5 min start when the QR exists (hold end moved to the
      QR's) and scheduling is bounded to 3 s; rebook SQL checks level and an old busy event; a 23505 on the
      per-customer index is not «taken». e2e section 18 (+11). e2e 188 locally.
- [x] Re-review of 1a4662c: fixed: an undelivered rebook offer is retried each minute only until its 30-min
      deadline, with one page per outcome (offered / not delivered yet: do not refund / none: yours); the level
      checked in SQL is the target stylist's; calendar_failed paged per round; a QR whose hold end cannot be moved
      is cancelled, never shown; the page's QPay check at expiry is throttled; a customer message that settles a
      paid-but-taken hold gets only the offer (no second Дали reply); offer and plain line have separate keys.
      e2e 191 locally.
- [x] Review of cf2dba2: fixed its 4: a told round never pages again (no «offered» after «refund it»); a channel
      that does not deliver is «none», not «wait»; an unreadable read refuses and retries (never «nothing free»),
      and a round whose plain line was drafted is never offered after; the hold's end is moved before the QR row
      opens. e2e 193 locally.
- [x] Review of 295a8e2: all 4 fixed; fixed its new one (an offer left open behind a «none» page on a
      non-delivering channel: the rebook chat is closed) and the earlier one (setHoldExpiry reported success on
      zero rows: a QR never opens for an ended hold); an unreadable record now pages «do not refund yet».
      e2e 194 locally.
- [x] Last review of 78e4335: all 3 fixed; applied its two leftovers verbatim (a failed close of the rebook chat
      returns `failed`, never «yours»; the «unreadable» page defers to any earlier page). Not re-reviewed: two-line
      changes taken as the reviewer wrote them. e2e 194 locally.
- [x] CI green on a5d49a0 (186 in CI).
- [x] Founder 2026-10-03: approved booking_pay and booking_expired as drafted; booking_paid_unbooked_offer
      with «бид тантай холбогдож» (founder handles refunds); approved decisions 27 (same stylist first),
      29 (30-min offer), 25 (no «new QR»). 0082 checked on the project: NOT applied (latest 0081_ora_billing,
      no booking tables/functions; main has no other 0082). Website hold goes in the Tara website round
      before switch-on. Brief: docs/proposals/tara-inchat-booking-brief.md.

## Decisions (with reason)
1. Deterministic flow, no model: C1/E2 stay true of the model; every line is a signed platform block.
2. Deposit per stylist level (Мастер 20,000₮, 1-р зэрэг 10,000₮) — Tara's website rule and her live
   deposit_rules; the brief's "20,000₮" is the Мастер case. Every booking needs a deposit.
3. Holds: DB (advisory lock per calendar + partial unique index; no btree_gist extension) AND a busy
   Google Calendar event, so the website's free/busy stops offering the time. Re-read after insert;
   chat yields if the website wrote first.
4. Hold 10 min (config), QR 5 min with renewal on the pay page (website's 5-min QR).
5. QPay: reuse platform `QPAY_USERNAME/PASSWORD/TERMINAL_ID` (website uses the same terminal
   `DALATECH_AI`); merchant id, mcc 7230, bank account are tenant config rows. Founder confirms.
6. Calendar: Google service account from env `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_PRIVATE_KEY`
   (same names and values as the website); calendar ids are tenant config rows.
7. New env: `BOOKING_MODE` (master switch), `BOOKING_LINK_SECRET`, `SUPABASE_SECRET_BOOKING` (own key
   for the public pay page and callback, like billing).
8. Test mode = booking_config.mode 'test' + `config.test_sender_ids` (PSIDs): 100₮, «ТЕСТ» events.
   Channel `test_sender_ids` only works in shadow, Tara's channel is live, hence its own list.
9. Booking replies are `outbound_messages kind='reply'` (answers: `reply:<mid>`; pushes:
   `booking:<hold>:<event>`), so every existing "was it answered" reader sees them. Quick replies
   only on the first send (body text stands alone on a resend). No outbound schema change.
10. One service per booking (v1). Website allows several.
11. Entry = list of gate matchers per tenant (`entry_matchers`); Tara's proposal catches 33/33 real asks, 1 FP.
12. Service buttons: optional short `label` (CICA…); stylist button drops the level when > 20 chars.
13. Local PostgREST (all versions 11.2–14.1) 400s claim()'s PATCH+or; hosted 200s (edge log). e2e gateway
    drops the lease `or` only (state CAS stays). Documented in booking-e2e.ts `claimShim`.
15. «When» is asked AFTER the stylist: the free times depend on the service length and the stylist, so the
    check can answer the moment the customer names a time. A time in the first message is kept and used then.
16. Offers around an asked time: the 6 nearest free starts, shown in time order; none asked: the first 12.
17. Name and phone stay between the time and the «okay»: the hold record and the founder's alerts need them;
    the «okay» is the summary's «Зөвшөөрч, захиалах», and the QR is made on that tap.
18. Follow-up after 10 min quiet on the offered times, once, re-reading the calendar; only on the times step
    (the founder asked about the offered times). Chat idles out at 30 min as before.
19. Button payloads carry the offer's value (`bk:time:<iso>`), not its index: the follow-up re-reads the list.
20. Weekday names are not read from the FIRST message (a name like «Баасан» is as likely); they are at the
    when/times steps. A number followed by words («маргааш 2 хүн») is not a time.
22. Follow-up never over a person: skipped on ANY `thread_control = human`, ignoring the tenant cooldown (a
    nudge is worth less than talking over a receptionist). Reception's own replies keep the cooldown rule.
23. A question with an hour in it («Маргааш 2 цагт болох уу?») IS a request for that time; without an hour it
    is a miss (so the flow still lets go on the second).
24. Calendar ids: Tara's booking_config is generated from the website's own config/stylists.js
    (scripts/booking/from-website.ts), so both sides use the same calendar per stylist by construction.
    Section 16 swaps in test ids; it cannot catch a hand-edited mismatch later. Re-run from-website.ts
    after any website stylist change.
25. Hold = QR = 5 min (founder): `hold_minutes` default 5, `qr_minutes` removed (refused if set). No
    renewal that stretches it; «new QR» shows only if QPay refused the first while the hold runs.
26. Release on time without polling: each hold schedules one sweep at its end (QStash `notBefore`); the
    minute schedule stays as the fallback (a failed publish costs at most a minute).
27. Late payment, time taken: offer the same stylist's nearest free times first (a «16:00 taken» line next
    to a «16:00» button for another stylist reads wrong), else any stylist of the same level (same
    deposit). A tap books on the paid deposit; founder paged at once and again on rebook.
28. «A new QR replaces the old hold»: starting a new booking while a QR is out closes the paying chat but
    keeps the time held until the NEW QR is made (or the 5 min end); then the old hold is released.
29. Rebook offer lasts 30 min from the moment the time was lost, enforced in SQL; the founder's page names the
    deadline, after which a refund or a hand booking is safe from a late tap.
30. Pay-page QR loss of the last seconds: the page asks QPay itself when the 5 min are up before saying ended.
21. The website side is unchanged (brief: no website edits). Its gap stays the change request: it holds
    nothing while its own QR is open, so a chat customer can take that time first; the website then refuses
    its paid booking and alerts (proven with its own code, e2e section 16). Never a double booking.
14. Yaarmag stylists proposed = dala-ai active staff (Оюунаа, Бадмаа, Батзаяа, Уянга, Отгонжаргал); website
    also has Уранчимэг + Ананд (male) -> founder question; men cannot book in chat with that list.

31. (founder, 2026-10-03) Every booking line approved, seven rewritten (README). «Хэнд зориулж цаг авах
    вэ?» is asked FIRST with Эмэгтэй / Эрэгтэй / Хүүхэд; «Хүүхэд» leads straight to the children's
    services, and each children's service says who serves it (a girl's a woman, a boy's Ананд), so the
    gender is never asked twice. Children's names are Tara's price rows; durations are missing
    (from-website.ts refuses until given). Prices are never shown in the flow (the deposit is by level).
31b. Review of 31 (2026-10-03): under the rule a stylist is never offered before «who for» is known (an old
    session at step service is asked it); the adult list never resolves a children's service; branches
    compare who serves each children's service; from-website.ts no longer counts a children's service on
    the website as ungrouped. For the founder: a child's deposit follows the stylist's level like any
    booking (Мастер 20,000₮ on a 33,000₮ haircut): confirmed by the founder (35).
32. «{level} — аль ч үсчин» did not fit a button for «1-р зэрэг» (23 > 20). Founder, 2026-10-03: the line is
    «Аль ч {level}» («Аль ч Мастер», «Аль ч 1-р зэрэг»). The guard stays: a label too long loses only
    that «any» button, never cut.
35. Founder, 2026-10-03: confirmed girls are served by women stylists, boys by Ананд; a child's deposit
    follows the stylist's level, as an adult's. Durations for every service, the SPECIAL stylists and
    the new service list come in the Tara round; booking stays off until then.
33. (founder) Yaarmag's stylist list adds Ананд (the only man; men book only with him) and Уранчимэг
    (woman, 1-р зэрэг), both from the website's own data. Booking stays off; the Tara round applies it.
34. Deposits: the website's levels (Мастер 20,000₮, 1-р зэрэг 10,000₮) match Tara's live deposit rows;
    SPECIAL 20,000₮ (D-169) is a live row, but no stylist anywhere is SPECIAL, so nothing books it; a
    SPECIAL stylist on the website stops from-website.ts (unknown level) until the level is added.

## Findings
- 2026-10-03, the «11 of 26 booking chats got no Дали answer» (live rows, read-only): 8 were before Tara's
  channel went live (2026-09-21 01:59 UTC): Дали wrote a reply, kept as a draft by design. 2 (09-22,
  09-24) were the canned_stale outage of 21–24 Sep: every reply refused, then dropped as older than 15
  min (reply_too_late); fixed by D-163 (0074/0075 applied 09-30, page + hand-off line). 1 (09-27) a staff
  member had taken the chat 2 min earlier (handover cooldown, correct). The 4 extra asks found later add
  2 more pre-live drafts and 1 more staff hold. Every booking ask since 09-24 that no person held got a
  reply within seconds. Residual gap: a reply dropped as too late for any OTHER reason still leaves the
  customer silent (only canned_stale sends the hand-off line).
- dala-ai already has a Quick QR client (`src/lib/billing/qpay.ts`) for DalaTech's own merchant
  (Core Language's). Tara's deposits must go to Tara's merchant (website's), not this one.
- dali.md C1 «Дали never books/confirms» and E2 «no availability»: hold for the MODEL. The booking
  flow must be a deterministic path that never lets model text confirm anything.

## Local environment (re-create after a container reset)
- PG16 + pgvector: `apt-get install -y postgresql-16-pgvector`; cluster as user postgres:
  `su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /tmp/pg/data -U postgres --locale=C.UTF-8 && /usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data -o '-p 5433 -k /tmp' -l /tmp/pg/log start"`
- `PGHOST=/tmp PGPORT=5433 PGUSER=postgres ./scripts/verify/run-all.sh dala_ci` (baseline green 2026-10-02)
- PostgREST 12.2.3 static binary at /tmp/postgrest (github release download works); roles:
  `psql -d dala_ci -f scripts/verify/postgrest-roles.sql`, then run with PGRST_DB_URI=postgres://authenticator:dala-ci-authenticator@localhost:5433/dala_ci,
  ANON_ROLE=anon, SCHEMAS=public, JWT_SECRET=dala-ci-postgrest-secret-at-least-32-chars, PORT=3001.
  billing-e2e passes locally (118 checks) -> model for booking-e2e.
