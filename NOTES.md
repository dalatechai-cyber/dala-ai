# Round 2026-10-04 (b): the founder's approvals of items 4–7; the reel line wired

Same branch and PR #283. Founder, 2026-10-04: every item of
`prompt/drafts/tara_quality_2026-10-03.mn.txt` approved as written. Nothing applied, published or merged.

- **Item 4** (the `image_received` line as the one question after a photo): approved; draft headers updated.
- **Items 5, 6** (price-page sentence, «Үнийн хуудас»): DROPPED 2026-10-04 (D-177): the two prices are
  not services Tara offers. Rows, contact, `price_page` kind and provision files removed; `0083` renamed
  `0083_photo_reel_question.sql`. New items 8 (`treatment_perm_women`) and 9 (`colour_lift`) await
  approval, rows disabled (`tara-yarmag-colour-and-treatment-perm-2026-10-04.sql`).
- **Item 7** (the reel line): approved and WIRED like the photo line (D-176 addendum). Its own row
  `reel_price_question` (kind added to the unapplied 0083, `MODEL_INVISIBLE_KINDS`, the guard, the D-163
  trigger list); `handover/media.ts` `unseenMediaOf` decides photo / video / mixed (`video`, `reel`,
  `ig_reel` and always-video link paths; `share`, posts, photo links, stories, pins and photo+video are
  mixed ⇒ D-152); `photoPriceStep` and `photoAloneStep` take both rows (the two questions are one
  question); the worker reads both rows for a text-less photo or reel; the reply path reads the words
  with links masked (fixed replies, price ask, service). Provisioning's video-link probe expects the reel
  question for a tenant with the row. Draft `scripts/provision/tara-yarmag-reel-question-2026-10-04.sql`
  (+ revert): the approved bytes, 5 reply cases, refuses while a reply case sends a video link and
  expects the notice.
- **Review** (code-review skill, high): 9 findings; fixed: a TikTok photo post read as a video; the
  reel question could fire on the website (now never with `noInbox`); a second reel LINK minutes after
  the question was handed off while a second attachment was held (new state `burst`, < 10 min: a
  second picture gets nothing more, no «typing…»); the two row reads now parallel; masking only for a
  tenant with a row; reel-specific flag codes; the SQL clash pattern now follows VIDEO_PATHS (and
  `must_include`, Page cases only); 0083's header. Left: one row-resolver shared by the three readers
  (a refactor, not a bug).
- **Checked:** `npm run check`; scratch PG16 (all migrations incl. amended 0083, every verify suite):
  reel file alone and after the photo file, second apply refused, the clash guard, reverts
  byte-identical (md5).
- **Go-live order** (adds to the list below): `tara-yarmag-reel-question-2026-10-04.sql` after 0083,
  any time, independent of the photo file (no republish).

# Round 2026-10-04: Tara Яармаг Дали quality, round 2 (founder's answers)

Same branch and PR #283. Binding: the founder's answers and approvals of 2026-10-04. Nothing applied,
published or merged; no model spend; production read with SELECT only (Tara's canned lines, fixed
replies, FAQs, contacts, services, gate topics; a few anonymous phrasings to test matchers).

## Decisions (and why)

1. **Photo + price = D-176**, photos only, switched on by a ROW (`photo_price_question`, model-
   invisible, migration 0083), so a tenant without it keeps D-152 and no code path names Tara.
   Why photos only: the founder's decision names photos and the question line says «зураг»; reels
   stay with staff (an optional reel line is drafted, not wired). Superseded by round (b) above: the
   reel line was approved and wired.
2. **The question is Tara's approved `image_received` bytes**, not new wording: it already asks
   «Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл…». New use flagged for the founder's OK (approved 2026-10-04).
3. **"After one question"**: hand-off when the customer's answer names nothing the rows know (no
   service, no fixed reply, no gate topic), or when a second photo comes after the 10-minute burst.
4. **Crossing**: a photo and «хэд вэ?» arrive as two messages, the photo answered first. A text
   whose Meta time is before the question's row + 30 s is read as the caption; a crossed price ask
   gets nothing more (outcome `dropped`, flag `photo_question_pending`, no «typing…» bubble) — otherwise the hand-off
   would fire on the very message that asked the price and the 30-minute hold would swallow the
   customer's real answer (the failure D-176 fixes). Cost: a customer who replies «хэд вэ?» to the
   question inside 30 s gets no reply to that one message.
5. **«Anything Дали doesn't know» = the `handoff` row.** It is the line served whenever the answer
   is not in the data (A8/F3), so one row covers every case; it is model-visible, so the file is a
   D-163 edit (`set local dala.canned_edit = 'republish'`, signed in the same statement, publish at
   once). It drops 91005498 (the founder's sentence names only 76001888) and the apology. The
   other refusal rows (unlisted price, schedule, promotions, suitability) keep their own words.
6. **Approved facts as fixed replies + FAQs** (D-174: word-for-word facts in fixed replies), matchers
   tested against this week's phrasings and the live rows (deposit AMOUNT, «хуваарь» excluded).
7. **(Superseded 2026-10-04 by D-177: no price page.) Price page mirrors Парк Од byte for byte** (#284's uncommitted `tara-park-od-after-onboarding.sql`:
   two appended, DISABLED rows with the matrixecosalon.org/services.html link). Added: the link is
   DECLARED as a new `price_page` contact kind (0083), inserted with the go-live switch, because the
   model is shown an appended line and a reply repeating an undeclared link is refused (B1). For
   #284 to align: add the same contact row to Парк Од's go-live step. The page lacks both prices
   (data/services.json): asked of the founder, not hidden.
8. **Migration number 0083**: 0082 is taken by the booking branch (#285). Renumber whichever merges
   second. D-176 likewise may collide with a sibling's next D-number.
9. **Names**: nothing in this round's rows or cases names a stylist; the round-1 report and notes
   now use Latin names (Otgonjargal stays bookable, answer 5).

## Status

- [x] Code: `reception/photoPrice.ts` (pure step), `inbound/photoQuestion.ts` (crossing read),
      `handle.ts` (step before the media block; ASKS_PRICE moved), `worker/reception.ts` (photo-alone
      question, crossing, resumed notice by bytes), `handover/media.ts` (`photoOnly`, `pq:` key),
      `gate/match.ts` + guard + `load.ts` + `prompt/tenant.ts` (kinds), migration 0083 + schema.md.
- [x] Tests: `npm run check` green, 2,683 tests (2,682 pass, 1 pre-existing skip; 41 new), guards 10/10,
      typecheck clean. Mutation-checked: the words-only shortcut and the photo-alone block.
- [x] SQL: `tara-yarmag-answers-2026-10-04.sql`, `tara-yarmag-price-page-2026-10-04.sql`,
      `tara-yarmag-photo-question-2026-10-04.sql` (+ reverts); round-1 cases also refuse the new
      hand-off bytes. Scratch PG16 (all migrations + every verify suite PASSED): each file applies,
      refuses a second apply, the go-live step works, reverts restore byte-identical content (md5).
- [x] Drafts `prompt/drafts/tara_quality_2026-10-03.mn.txt` (approved vs awaiting), report, dali.md v1.6, D-176.
- [x] Independent review (code-review skill acting as `.claude/agents/reviewer.md`; no subagent
      tool in this session): 10 findings, all fixed — a fixed reply with an answer is served on a
      photo/crossed caption (only whole-message rows count as small talk); no «typing…» bubble for a
      crossed message; a redelivery finds its own question by dedup key; the question counts for an
      hour only (old image-line bytes no longer hand off a new photo); a price-less caption naming a
      service goes to staff; dye_brand with the hand-off bytes now tells a person (handedOff on the
      bytes, any path); the question is drafted as exact bytes; append rows re-matched with the
      same words-only options; one `sendLineAlone` helper for the photo question and the notice;
      the notice read once per job on resumes. Mutation-checked the redelivery fix.
- [x] Commit; push; PR body. CI: see the PR.

## Go-live order (founder)

1. Merge #283 after its deploy; apply 0083 (after the deploy, never before).
2. `tara-yarmag-answers-2026-10-04.sql`, publish at once (dry run, then --publish); one --with-model run.
3. `tara-yarmag-photo-question-2026-10-04.sql` and/or `tara-yarmag-reel-question-2026-10-04.sql` (no republish needed).
4. `tara-yarmag-price-page-2026-10-04.sql` any time (rows land disabled); its step 2 only when the
   new site is live at matrixecosalon.org AND shows both prices (founder, 2026-10-04; both branches
   the same day, publish both); the domain
   move changes the link to https://tarasalon.org/services.html in both tenants' rows.

# Round 2026-10-03: Tara Яармаг Дали quality

Branch `claude/tara-dali-quality-oct3` (worktree `/home/user/dala-wt/quality`). Brief: read Tara
Яармаг's last 7 days of DMs read-only, list every weak reply with its cause, fix as drafts.
Full list: `docs/reports/2026-10-03-tara-dali-quality.md`. Nothing applied, published or merged;
no model spend.

## Decisions (and why)

- **Biggest finding is not fixed in code: photo/reel + «how much?» → hand-off line → silence.**
  34 chats, 50 unanswered texts, 26 chats never answered by staff. It is the founder's own rule
  (D-151/D-152, question left to staff; D-153, Tara's media alert off), so changing it is his
  call. Options written for him (see open items).
- **Code fix 1 (`handle.ts` pinned step):** an approved line adapted inside a longer reply at
  ≥ 0.9 of the row as one unbroken run (new `EMBEDDED_CERTAIN_SHARE` in `gate/pinned.ts`) now
  gets its row, not the hand-off line. Why: 4 live replies (booking line 0.992 / 0.984, no-nails line 0.982 ×2)
  were served «I cannot answer»; the D-126 case (0.754) is still the hand-off line.
- **Code fix 2 (`handle.ts` presentation step, flag `set_question_unpriced`):** a reply that asks
  a set row's question and quotes no price is served as the set row (rows, then question). Why:
  12 dye-price questions got the question alone. Only when the customer's words ask a price
  (`ASKS_PRICE`, whole words), not on a suitability turn, not when every row is already in the
  chat, never when a refusal rule blocks prices (all four from the review).
- **Data draft:** `scripts/provision/tara-dali-quality-2026-10-03.sql` (+ revert): 5 reply cases,
  all needing the model. Validated apply → refuse-second-apply → revert → re-apply on a scratch
  PostgreSQL 16 with stub tables. Booking stems «авч/awch/avch» were drafted and DROPPED after the
  review: they also cover «bring» («avchirch») and «buy» («онлайн авч»); code fix 1 covers the
  live case.
- **No new customer sentence is live-bound.** The only Mongolian written is
  `prompt/drafts/tara_quality_2026-10-03.mn.txt` (FAQ options for three data gaps); facts unknown,
  so each has options for the founder to pick.
- **Staff names, levels, manicurist, Otgonjargal:** not touched; the rename worker's
  `tara-yarmag-stylist-names-2026-10-03.sql` (branch `claude/tara-park-od-tenant`) covers all four.
- Pending provision files read live: price list, branches, branch count, stylist levels are all
  applied; the November move is not (by design).

## Status

- [x] Read 315 DMs, flags, staff echoes; report written
- [x] Two code fixes + 8 unit tests in `compose.test.ts` (each mutation-checked: fails without its condition)
- [x] Provision draft + revert, drafts file, dali.md v1.5 (A4, D12)
- [x] Draft PR #283; independent review (Opus reviewer session): 2 medium + 2 low findings, all fixed
- [x] `npm run check` after the review fixes: guards 10/10, typecheck clean, 2642 tests (2641 pass, 1 pre-existing skip: ancestor repo not checked out); re-review lows fixed (more Latin price spellings, «хэд» about a time or days excluded, dedup limit noted)
- [x] CI `verify` green on every head (e8f04c1, 29bc4d5, 33f0d45), all 16 steps success; re-review by the same reviewer session: earlier findings fixed, its low items fixed in 33f0d45. Not merged.

## Open items for the founder

1. Media silence: (a) turn Tara's media alert on (`tenants.media_handoff_alert`, D-153) so a
   person is told at once; (b) let the hourly reclaim (F4) also come back to a bot media hand-off
   nobody answered in 2 open hours (code, not built); or (c) answer the price part of a photo
   question from data (reverses D-152). Recommendation: (a) now, (b) next.
2. Merge #283 (after its deploy), apply `tara-dali-quality-2026-10-03.sql`, then one
   `--with-model` dry run for Tara (the 5 model cases prove the two code fixes on the real model).
3. Facts: deposit off the price?, loan/instalment apps?, dye brand?, Эмчилгээний хими for women?,
   which service is «өнгө гаргалт»?
4. Not fixed (prompt-only rules): multi-part answers (E10), one «<br>» (D4), a complaint misread.

# NOTES — overnight session 2026-10-02 (resume point after a context reset)

Branch: `claude/serene-johnson-gla2u7`. Brief: Part 1 Дали live-customer gaps (roadmap 6b),
Part 2 billing e-mail redesign to Ора's design. Nothing goes live; Mongolian = drafts only.

## Findings (investigation, read-only)

- **Part 1 a–d are already built and live** (D-158, D-159, D-160, merged before this session):
  - Live DB 2026-10-02: both tenants have a reviewed `voice_received` row, a reviewed `handoff`
    row, 9 DM-only needs-person `comment_rules`. Tara `reply_style = {"max_emoji":1}`.
  - `alerts`: 8 `conversation.needs_person` for Tara in 7 days, all `delivered = true`
    (7 handoff, 1 voice). No cap page yet (no cap has tripped).
  - `docs/STATUS.md` already says $2.00 / $1.90 (corrected 2026-09-30, line ~406).
  - The brief contradicts the repo on a–d. Reported, not rebuilt.
- **Real open gaps:** nothing passes a chat to a person (F4; D-162/D-164 founder calls);
  Tara's staff are told only by the founder relaying (D-158 2nd addendum: "owner reads her
  messages herself"). A request for a person no DM row covers is missed. K4 DM booking request
  not alerted.
- **Billing mail** (`src/lib/billing/mail.ts`) already has a branded HTML (0070): navy band,
  36px mark, pay button + shown address, bank block, footer with founder name/phone/bank.
  Ора's approved design: `/home/user/ora` branch `claude/wonderful-fermat-7qytcl`,
  `src/lib/server/mail-templates.ts` (logo chip + name above a white card, navy heading and
  button, small fallback link, rule, footer why/who/site/contact, dark mode CSS, preheader
  filler, plain-text twin). Brand SVGs: `/home/user/dalatechai-cyber/dalatech-online/brand/`.

## Plan / status

- [x] P1 verify: 314 tests pass (voice, needs-person, cap refusal line + page, emoji)
- [x] P1 proposal `docs/proposals/tara-staff-handoff.md` (evidence: 0/8 paged chats got a staff
      reply in 24 h; Tara staff replied 22 times in 14 days otherwise)
- [x] P2 mail.ts in Ора layout; `public/brand/dalatech-wordmark.png`; three drafts in
      `prompt/drafts/billing/` (left out while unsigned); `scripts/billing/preview.ts`
- [x] Commit + push; draft PR https://github.com/dalatechai-cyber/dala-ai/pull/274 (subscribed)
- [x] Opus review: safe; fixed receipt account/holder, Outlook width, one sender constant (b86a026)
- [x] Test sends via Gmail MCP (invoice + receipt, fake data, no PDF) to
      bilguunbilly0214+billingtest@gmail.com; logo from raw.githubusercontent.com on this branch
- [x] Preview page: https://claude.ai/artifact/9XFM1M5RC43mnsjGxp8NYo (before/after, 4 e-mails, phone dark)
- [ ] CI green on b86a026 -> morning report (<10 lines). Do NOT merge: founder approves first.

Open for the founder: no client "pause" e-mail exists (pause is a founder Telegram ask only);
pick an option in the hand-off proposal; sign the three drafts; confirm hello@dalatech.online
forwards (send.ts says it has no inbox) or the footer should show BILLING_FOUNDER_EMAIL.

## Round 2 (founder reply, 2026-10-02 evening)

- [x] Three lines signed (seed 0077), send.ts note fixed, #274 merged (ff9976f), 0077 applied and
      read back sha256-identical. billing-e2e real-date bug found (red on main too) and fixed.
- [x] Pause notice: kind `pause` (0078), four DRAFT lines. Resume is NOT automatic (founder presses
      Resume; contract: 1 working day) so the wording says that. Option: build auto-resume.
- [x] Tara label + daily count built, OFF (0079 column NULL). Not applied, not merged: founder go.
- [ ] Review (Opus), CI, draft PR, report <6 lines. Ask founder: go to test a label on DalaTech's Page.
- [x] Founder (2026-10-02): resume automatic on full payment of the paused invoice + Telegram
      «resumed after payment»; founder's sentence used. Proven in billing-e2e (102 checks).
- [x] Review findings fixed: pause alarm key, label via after(), provider allowlist
      `facebook_page`, report live-only "by report time", lazy graph version, withdraw unsent
      pause notice after a manual resume.

## Round 3 (2026-10-02 night): label stopped, pass-to-inbox proposed

- Label test 19:35 UTC (voice message): Graph refused at `find`, code 2 / subcode 2018344
  «Privacy ToS not accepted», trace A0K3GdmK-j1yb_g7imf8NCX. Meta's acceptance link is broken
  (founder: blank inbox, «Cannot convert page_contact_tos to a BigInt»).
- Founder: stop the label. DalaTech's `needs_person_page_label` set back to NULL and read back;
  NULL on every tenant.
- Proposal `docs/proposals/tara-pass-to-inbox.md` (nothing built). Bug report draft for Meta
  `docs/proposals/meta-support-page-contact-tos.md` (founder sends; one URL placeholder).
- Tara Page facts: 1,893 deliveries since 2026-09-14, 0 standby, 0 handover events; echo app ids
  seen 263902037430900 (inbox), 1380702870025418, 1562862634970492. Routing config unknown:
  founder to read it in Page settings.
- Model reply confirmed after the Anthropic top-up (19:32 UTC, Sonnet 5, ~$0.035).
- Founder decision: pass-to-inbox NOT built (silences Дали, does not point staff to the chat).
  Founder talks to the Tara owner (staff routine; manager gets the hand-off alert by Telegram,
  later SMS via Нова?). Nothing built until the founder says. Meta bug report ready to send.

## Ора packs — 2026-10-02 (PR #278, merged)

- dala-ai's half of Ора's payments is live in TEST only: `POST /api/ora/pack-invoice` (100₮ test
  pack, test accounts marked `ora_account`), one signed `pack.paid` event per paid pack. 0081
  applied. The founder's one real 100₮ test passed: one event, sent once, Ора `credited`.
- Clean-up done: `ORA_WEBHOOK_URL` = `https://ora.dalatech.online/api/billing/webhook`, bypass
  secret deleted; the redeploy's preflight shows `ok` for `ORA_PLATFORM_SECRET`,
  `ORA_WEBHOOK_URL` and `ORA_BILLING_WEBHOOK_SECRET_TEST`.
- **Decision (founder): Ора launches with packs OFF** («contact DalaTech» in the app).
  `BILLING_MODE=live` is not tied to Ора's launch: Tara's go-live waits on her signed contract.
  Live 49,000₮ packs come later with client billing go-live (`docs/billing.md`, Ора section).
- Not built: `account.paused`/`account.resumed`/`plan.paid` events and `/api/ora/account-deleted`.
