# MUST FIX BY 2026-10-13: billing e2e goes red again on 2026-10-14 (02:00 UTC)

`scripts/verify/billing-e2e.ts`, step «a wrong amount: mismatch» («300,000₮ against 360,000₮ is a
mismatch»), has the shape that turned `main` red on 2026-10-04 (fixed in #288): it opens the live
invoice's pay page on the WALL clock, then runs QPay's callback at the FIXED 2026-10-14 10:00
(Ulaanbaatar). Opening the page stamps the code's `checked_at` with the real time; once the real
time passes the callback's fixed time, the callback reads that code as checked «after now», skips
it (`CALLBACK_MIN_INTERVAL_S`), records no payment, and `verify` fails on every run after.

Why the obvious fix does not work: the page cannot be opened on the test's clock. A code is made
only with an `expires_at` within ten minutes of the DATABASE's real `now()` («a QPay code lives
minutes»), so a page opened at a fixed test time returns `unavailable`.

The fix needed: the callback must not see a check stamp later than its own clock. Proven locally
(2026-10-04): right after `await openPage(liveId);` add this line, with a comment saying why:

```ts
psql(`update billing_qpay_codes set checked_at = null where invoice_id = '${liveId}'`);
```
 Simulated with the payment and callback at 2026-10-04 03:00 (already
past the wall clock, as 2026-10-14 will be): all 118 checks pass. The longer-term fix is one clock
for the whole e2e (pass `now` into the code-making function instead of SQL `now()`), so no step
mixes the wall clock with fixed dates.

# NOTES — Round 5 (2026-10-04): the booking wording signed

# Round 2026-10-04 (b): the founder's approvals of items 4–7; the reel line wired

Same branch and PR #283. Founder, 2026-10-04: every item of
`prompt/drafts/tara_quality_2026-10-03.mn.txt` approved as written. Nothing applied, published or merged.

- **Item 4** (the `image_received` line as the one question after a photo): approved; draft headers updated.
- **Items 5, 6** (price-page sentence, «Үнийн хуудас»): DROPPED 2026-10-04 (D-177): the two prices are
  not services Tara offers. Rows, contact, `price_page` kind and provision files removed; `0083` renamed
  `0083_photo_reel_question.sql`. Item 8 (`treatment_perm_women`) APPROVED (row on); item 9 split by gender
  (`colour_lift` women's rows, `colour_lift_men` men's rows; «Бүтэн цайруулалт» to men only) APPROVED with a
  header line and 91005498 (the draft had the pre-D-167 80905498), rows on (`tara-yarmag-colour-and-treatment-perm-2026-10-04.sql`).
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

# Round 2026-10-04 (approvals): every file in docs/approvals/tara-2026-10-04/ approved

Same branch, PR #284. The founder approved every file in `docs/approvals/tara-2026-10-04/` as
written (2026-10-04). Moved from AWAITING to APPROVED, nothing applied, signed or live:
`prompt/drafts/tara_stylist_names.mn.txt` (Otgonjargal's line with «Отгоо», «Otgonjargal» in the
first line), `prompt/drafts/tara_park_od_wording.mn.txt` (sections 4 with `yarmag_branch` and
Яармаг's Page link, 4b with every Cyrillic spelling, 6), the comments and `source` labels of the
two SQL drafts, the tenant docs, and the approvals README (copies kept as the founder read them).
Still open: the price-page rows stay DISABLED until the website shows both prices; signing the
approved drafts is the founder's own step. Not wording, still to confirm: Парк Од's Page id.

# Round 2026-10-04: Latin names everywhere, Otgonjargal, Парк Од per the approvals

Same branch and worktree, PR #284. Founder's answers and approvals of 2026-10-04 (binding);
nothing live, no production writes (SELECT-only reads), drafts only.

## Status

- [x] Names, both tenants: rosters Latin only (Яармаг's short names cleared), «1-р зэргийн үсчин»,
      Cyrillic only in «Үсчдийн нэр» (Яармаг + Otgonjargal line; Парк Од's, guesses).
- [x] Otgonjargal read-only on the project: «Эмэгтэй үсчид», «1-р зэрэг үсчин», active, selectable
      → hair stylist, kept bookable as «Otgonjargal», 1-р зэргийн үсчин (10,000₮). Manicurist off.
- [x] Парк Од: identity/booking lines = Яармаг's bytes and no refusal_topic (`--wording`), no
      1-р зэрэг price (form + `not_offered`), Boloroo on 2.3, three quality FAQs, two price-page
      fixed replies (disabled), symmetric «Салбарууд» + `yarmag_branch` + `branch_count`.
- [x] Move-day SQL updates both tenants; real revert file; `allow_addresses` lists both
      addresses and the VIP Center one.
- [x] Replica (fresh `dala_r2` from Яармаг's snapshot): onboarding dry run, apply, follow-up SQL,
      re-apply unchanged, both gates and both publish dry runs clean, controls caught, move +
      revert byte-identical. Details: docs/tenants/tara-park-od.md.
- [x] `npm run check` (2,640 tests, 2,639 pass, 1 pre-existing skip), review + re-review, commit
      a86b5da, pushed, PR #284 body updated, CI `verify` green on a86b5da (every step read). Not merged.

## Decisions (and why)

13. **Roster purely Latin = every Яармаг `short_name` cleared.** The roster prints
    «name (short_name)», so clearing it is the only data-only way. Cost: the branch gate no longer
    searches the other branch's rows for «Оюунаа»/«Бадмаа» (Latin names still searched; controls
    prove it). Recorded in the SQL header, tara-yarmag.md and dali.md §7.
14. **The tier text is changed to «1-р зэргийн үсчин»**: nothing matches on `tier` (only the roster
    prints it) and it now equals the deposit label. Price variant keys stay «1-р зэрэг»: they are
    shared price rows, and prices must not change.
15. **Парк Од's 1-р зэрэг: her form leaves the row out, the gate is told.** No row-level switch
    exists: the price serve quotes every variant of a service, `refusal_topic` only works with
    `price_kind = 'none'` (a price change → DRIFT), and an unconfirmed price is stamped at client
    confirmation. So `config/branch-groups.json` gets `not_offered` {slug: [variant]} and
    `sharedDrift` accepts that branch's missing row (still drift if she carries one, and every
    other price must still agree). Gate code only (scripts/facts + src/lib/facts), nothing on the
    reply path. The men's SPECIAL cut is the same shape and left as an open question.
16. **`--wording <file>` on the onboarding command**, not SQL: onboarding rewrites every templated
    canned line on each `--apply` (and re-creates refusal_topic), so lines set by SQL would be
    reverted, unsigned, by the very run that produces the wording sheet. The file replaces a
    template's text by kind or (null) writes no line; only template kinds; NFC; printed on every
    run; the follow-up SQL refuses to run if it was not used. Generic (any client's own approved
    line), tested.
17. **Price-page answers are appended fixed replies, landing disabled.** The URL guard allows only
    the booking link and contact links by exact match, so an FAQ quoting /services.html would be
    replaced by the hand-off line; a fixed reply is sent verbatim. `append` so a message with other
    questions is still answered. Disabled because matrixecosalon.org still serves the old Matrix
    site (old prices) until the new site merges. The #283 worker mirrors this shape for Яармаг
    (the lead tells it); the exact rows are in tara-yarmag.md «Quality answers».
18. **The three approved answers are FAQs in her form** (rowsNotInForm names any FAQ not in the
    form), with new questions (model-read, awaiting approval). «Anything Дали doesn't know» keeps
    her approved `handoff` line, which already says the staff will help and gives 76001888.
19. **Symmetric «Салбарууд»**: mirrored from Яармаг's approved text, keeping her own address line
    so the model cannot take Яармаг's address for hers. `yarmag_branch` mirrors `park_od_branch`
    (Яармаг's Page link from the website's data, to confirm). `allow_names` gains «Яармаг».
20. **Яармаг's side unchanged**: it already names Парк Од's address, 76001888 and Page
    (`park_od_branch`, «Салбарууд», read 2026-10-04); 91005498 is only in its own rows.
21. **Hand-off by Boloroo**: no row routes hand-offs to a person (the alert goes to the founder's
    Telegram), so it is recorded in form 2.3 (a manual note) and the docs; open question how she
    is told.
22. **Chimgee/Chimegee**: «Чимгээ» is only in Яармаг's document, «Чимэгээ» only in Парк Од's;
    control: «Chimgee» in her rows is a LEAK, her own «Chimegee» is not.

23. **Independent review** (code-review skill acting as `.claude/agents/reviewer.md`; no subagent
    tool in this session). Ten findings, all fixed: the follow-up SQL refuses once Яармаг's address
    has moved; `--wording` is recorded (`onboarding_steps` «own_wording») and a later run without
    it is refused, and a `null` line an earlier run wrote is deleted (a signed one refuses); the
    price-page rows wait for a page that actually lists both prices (the new site's list has
    neither); the other branch's name and address are exempt only in the rows named in
    `other_branch_in`; `not_offered` takes a service-scoped entry; Cyrillic names come back to the
    gate through `staff_aliases`; the move file expects exactly the Парк Од rows that carried the
    old address (a partly provisioned Парк Од never blocks Яармаг's move) and its revert reads back
    Парк Од's rows and Яармаг's address and map link exactly; `--wording` kinds are checked with
    `Object.hasOwn` and a kind the form does not write is refused; the sheet reads an explicit
    `own` flag. The replica caught one more on the way (a temp-table column named like a PL/pgSQL
    variable), fixed and re-run.

24. **Matched to #283 (a5bf883)** at the lead's request: her `handoff` is the founder's sentence
    (via `--wording`, so onboarding writes it); `deposit_deducted`, `loan_apps`, `dye_brand` fixed
    replies with #283's matchers; the FAQ question for the deposit is #283's wording; #283's seven
    answer cases, inactive until her publish. (The price-page rows and cases were replaced on
    2026-10-04 by D-177's `treatment_perm_women` (approved, on), `colour_lift` and `colour_lift_men`
    (approved, on), with seven cases; no `price_page` contact.) No migration in #284.
25. **Re-review** (same reviewer, on the fixes): six findings, all fixed — the recorded wording key
    is compared (`--wording-changed` for a meant change); a signed `null` line refuses before
    anything is written; a configured alias missing from its branch's rows is named (whole word,
    never refusing); the move file's comment no longer claims the gate catches the old address
    (its own check and the follow-up's precondition do); the move and revert also carry Парк Од's
    reply cases and web bodies; a misleading comment in `sharedDrift`.

## Open items (for the founder)

- Approved as written on 2026-10-04 (round above): Otgonjargal's line (with «Отгоо»); Парк Од's
  «Салбарууд», `yarmag_branch` (Яармаг's Page link 100067872726164 confirmed), «Үсчдийн нэр»
  (every spelling), three FAQ questions, price-page sentence.
- Confirm: Парк Од Page id; men's SPECIAL cut at Парк Од;
  how Boloroo hears of a hand-off; approve the D-177 wording (approvals file 08):
  women's «Эмчилгээний хими» not offered, «өнгө гаргалт» answered with the colour rows.
- Nail refusal line still mentions nails (both branches).

# Round 2026-10-03: Парк Од tenant and new names

Branch `claude/tara-park-od-tenant` (worktree `/home/user/dala-wt/parkod`). Founder away; the
round's facts and limits: nothing live, no production writes (SELECT-only reads), drafts only.

## Status

- [x] Task A — Яармаг's hairdressers' Latin names: `scripts/provision/tara-yarmag-stylist-names-2026-10-03.sql`
      + `-revert.sql`, wording `prompt/drafts/tara_stylist_names.mn.txt`. NOT applied. Replica:
      applies, refuses a re-run, reverts byte-identical, re-applies.
- [x] Task B — Парк Од dry run: `intake/tara-park-od.answers.json` → `intake/tara-park-od.docx`
      (real client form), onboarding dry run + `--apply` on a LOCAL replica only, follow-up
      `scripts/provision/tara-park-od-after-onboarding.sql` (NOT applied), wording
      `prompt/drafts/tara_park_od_wording.mn.txt`.
- [x] Task C — branch and facts gates, both tenants, on the replica: clean. Controls refused.
- [x] Docs: `docs/tenants/tara-park-od.md` (facts, go-live steps), `docs/tenants/tara-yarmag.md`.
- [x] Review (findings fixed, decision 12); `npm run check` green: 2,635 tests, 2,634 pass, 1 skipped
      (needs the Matrix-Chatbot checkout), guards and typecheck clean.
- [x] Commit 034ef3c, pushed, draft PR https://github.com/dalatechai-cyber/dala-ai/pull/284 (not merged).
- [ ] CI on the PR: read once.

## Decisions (and why)

1. **Short name = the Cyrillic form customers type** (Oyunaa → «Оюунаа», Badamaa → «Бадмаа»,
   Zaya → «Заяа», Chimgee → «Чимгээ», Anand → «Ананд», Uyanga → «Уянга»). That is 0019's design
   (one roster line, both spellings) and matches real traffic: the stored messages show «oyunaa»
   / «oyuna» 7×, «Оюунаа» 1×, «badmaa» 1×, no full old name. The full old names (Оюунсүрэн,
   Бадамцэцэг, Батзаяа, Уранчимэг) go in a KB document «Үсчдийн нэр» (rows, not a
   transliterator). Both are drafts the founder may trim.
2. **Oyunaa = SPECIAL** (founder's explicit word), everyone else keeps dala-ai's level, which
   agrees with the website's. No disagreement to hold. Chimgee had no dala-ai row: the website's
   1-р зэрэг is used (the round facts list it as our data).
3. **Switched off, not deleted:** Отгонжаргал (not in the founder's list) and the manicurist
   Г. Мөнхзаяа («Маникюр баг», still ACTIVE on the project: manicure is off at Tara). Reversible.
4. **No `set local dala.canned_edit` in Task A:** no canned row names a hairdresser, so no canned
   row changes and the guard is not engaged. Loosening a guard that is not needed is worse.
5. **Парк Од from her own form, with the real form file** (`fill.ts` into `dali-form-v2-blank.docx`).
   `fill.ts` now adds table rows when answers outnumber them (31 services, 12 rows), as a client
   does in Word.
6. **`parsePriceCell` reads one untiered line beside tiers** («69,000₮» + «SPECIAL: 89,000₮»).
   Яармаг's «Эрэгтэй тайралт» has exactly that shape; without it a branch onboarded from its own
   form could never match the shared price list and the gate would hold her forever. Test added.
7. **What the form cannot carry is a provision file of literal values**, not an INSERT…SELECT
   from Яармаг (D-157: never copy a sibling's rows). Every identical row was checked equal to
   Яармаг's live row by md5 on the replica; `address` and `salon_phone` carry her details.
   Not given to her: `branch_count`, `park_od_branch` (naming Яармаг is the founder's call;
   D-170 went one way), `tara_name`/`tara_rebrand` (she was never Matrix).
8. **Gates run against a local replica, never the project.** PostgreSQL 16 on :5437 (data in
   /tmp/parkod-pg, outside the scratchpad because the postgres user cannot enter it), PostgREST
   12.2.3 on :3007, gateway on :54327. Яармаг's gate-relevant rows loaded from read-only reads
   (KB, canned, fixed replies, FAQs, prices all md5-equal to the project).
9. **`config/branch-groups.json` unchanged:** 76001888 is already shared, 91005498 is Яармаг's by
   default (the control proved the gate refuses it in Парк Од's rows), and each branch's own
   staff need no entry (`allow_names` would let a name into BOTH branches).
10. **Page id 100067391025472 used as a placeholder** (from her profile link), marked CONFIRM.
11. **Парк Од's level lines name only SPECIAL and Мастер** (fixed reply `stylist_tier`, form 5.2
    document): she has no 1-р зэрэг hairdresser. Draft wording; the shared price list keeps its
    1-р зэрэг rows (D-157), which stays an open question.
12. **Independent review** (code-review skill acting as `.claude/agents/reviewer.md`: this
    session has no subagent tool, so the reviewer agent could not be spawned directly). Fixed:
    the untiered price line must be an EXACT price (a note «Үзлэгээр …» under a tier is refused,
    not read as a price); the names file pins every column its revert writes back (NULLs
    included) and the revert reads them back; the follow-up file refuses when its documents or
    the «Будаг» question exist; `fill.ts` drops Word's paragraph ids from added rows (0 duplicates);
    the real-tenant form test moved out of src/ to `scripts/onboard/intake.test.ts`; Парк Од's
    `stylist_tier` (decision 11); a doc said deposit labels «match» the tiers (they correspond).
    Not fixed, by rule: her hairdressers' Cyrillic spellings (never guessed; asked).

## Open items (for the founder)

- Approve `prompt/drafts/tara_stylist_names.mn.txt` and `prompt/drafts/tara_park_od_wording.mn.txt`.
- Confirm Парк Од's Page id; who gets her new requests; her hairdressers' Cyrillic spellings;
  whether her Page runs an away message; whether her Дали names Яармаг.
- The shared price list has 1-р зэрэг and SPECIAL-men prices Парк Од cannot serve.
- Nail refusal line (`refusal_service_unavailable`) still mentions nails, both branches.
- Отгонжаргал: confirm she is gone.

# NOTES — overnight session 2026-10-02 (resume point after a context reset)

Same branch/worktree/PR (#285). Signed at the founder's request (he approved every block on
2026-10-03/04 and asked us to sign). Nothing live: no merge, no `supabase db push`, no SQL on a
real database, no Vercel/Supabase change.

## Status
- [x] `sign-drafts.ts --dir prompt/drafts/booking --set c787decc1f0a --by Bilguun`: 42 blocks
      moved to `prompt/platform/`, hashes in `platform-mn-review.json` (2026-10-04), seed written.
- [x] Root cause of the 4 red tests after signing: `generate-seed.ts` `layerFor` gave every key that
      is not `data_deletion_*`, `comment_public_reply` or `billing_*` layer L0, so the 42 booking
      blocks became gate sections (ordinal 0). Through the real loader every tenant's compile then
      REFUSED (`ambiguous_order` at L0/platform/0) — every live tenant's next publish would have
      failed. Fix: `booking_*` is layer null (read by key by `booking/wording.ts`, like billing);
      DONE-TEST over `BOOKING_BLOCK_KEYS`; the family test checks the booking family by prefix.
- [x] Live tenants unchanged: the compiled gate prefix through `loadPromptSections` over every
      seeded row has the same content hash before and after (salon, software, other, none; 14
      sections). The other 107 rows of the seed are byte-identical to `0080`'s, dates included;
      no existing sign-off entry changed.
- [x] Seed renamed `0083` → `0084_prompt_blocks_seed.sql` (sibling #283 has `0083`). Order:
      `0082_booking`, #283's `0083`, `0084`. Not applied.
- [x] e2e section 0: the flow's wording is read from the database with `loadBookingWording` (the
      production read), all 50 blocks present (`missingBlocks` empty), each byte-identical to its
      signed file, every `booking_*` row layer null and signed. Was the draft files before.
- [x] check green (2669 tests); run-all SQL suites green; e2e 266 local with the website, 245
      CI-shaped.

# NOTES — Round 4 (2026-10-04): the founder's wording approvals

Same branch/worktree/PR (#285). Nothing live: no merge, no SQL on a real database, nothing signed
(signing is the founder's step, `scripts/prompt/sign-drafts.ts --dir prompt/drafts/booking`).

## Status
- [x] Approved as written (founder, 2026-10-04), marked in `prompt/drafts/booking/README.md`, the
      config's comments and the docs: `booking_ask_agreement`, `booking_ask_variant`, every button
      label (group, family, short service, children's).
- [x] Typed-only aliases now approved, added to `config/booking/tara-salon.json`: «Отгоо» for
      Otgonjargal (Яармаг); Парк Од's «Үсчдийн нэр» spellings read byte for byte from PR #284's
      `prompt/drafts/tara_park_od_wording.mn.txt` §4b (Boloroo: Болороо, Болор; Saraa: Сараа; Tomoo:
      Томоо, Төмөө; Bulgaa: Булгаа; Enhuush: Энхүүш; Chimegee: Чимэгээ; Tuchku: Тучку, Түчкү).
- [x] Duplicate check: the parser's «no alias names two stylists» runs per branch config (each
      branch is its own tenant; a typed name only picks within its branch), which is the right
      scope. A unit test pins the approved aliases and that no typed name is in both branches
      (Chimgee «Чимгээ» at Яармаг vs Chimegee «Чимэгээ» at Парк Од); the e2e checks at Парк Од
      that «Чимгээ» picks nobody and «Төмөө» picks Tomoo. R2-2 below is superseded.
- [x] check green (2668 tests); e2e 262 local with the website (21 website), 241 CI-shaped.

# NOTES — Round 3 (2026-10-04): founder's correction on Парк Од's QPay

Same branch/worktree/PR (#285). Nothing live: no SQL on a real database, no Vercel/Supabase change.
Founder: Парк Од does NOT get her own QPay merchant or login; she uses the founder's merchant and login
exactly as Яармаг (and Core Language). The ONLY difference is her bank account (Khan Bank) in the
invoice's `bank_accounts`. The website did the same (matrix_website bdbbaa1).

## Status
- [x] from-website.ts: every branch gets the website create-payment handler's ONE merchant id (exactly
      one `*_MERCHANT_ID` constant there, else refused) and its one mcc; Парк Од's account from the website's
      `qpayAccountFor('parkod')` with the operator's PARKOD_QPAY_BANK_CODE/_ACCOUNT_NUMBER/_ACCOUNT_NAME,
      `not-connected` until the website calls it complete; an account equal to another branch's refused; an
      equal merchant id no longer refused (it must be equal). `--qpay-login` refused with a reason.
- [x] Per-tenant QPay login removed: `qpayLogin.ts`, `qpay.login` (the parser refuses it), `BOOKING_QPAY_*`,
      `booking_invoices.qpay_login` (0082 not applied; column dropped from the file), `.env.example`.
- [x] Sharing check is account-only: `accountSharedWith` (before every invoice, alert
      `booking.account_shared`) and `compareBranches` `shared_account`; the same merchant is expected.
- [x] Tests: test branches share one merchant id, own accounts; unit test: Парк Од's invoice body equals
      Яармаг's except `bank_accounts` (token request too); e2e section 20: the same, field by field, on
      the fake QPay; e2e 16(h) runs from-website.ts on the website checkout for both branches.
- [x] «Гоёлын засалт /эрэгтэй/» offered to men: APPROVED (founder 2026-10-04), recorded in tara-salon.json
      and prompt/drafts/booking/README.md. Owner alerts: none built; alerts reach only the founder; Boloroo
      checks Парк Од's Messenger herself (design doc «What is not built»).
- [x] Docs: design doc «Per-branch QPay» rewritten, switch-on steps (no registration, no
      qpay-merchant.js, nothing from Boloroo), brief, schema.md, transcript heading (hand-edited: a full
      regeneration only churned the time-of-day day buttons).
- [x] check green (2668 tests); e2e 260 local with the website (21 website), 239 CI-shaped.

## Decisions (with reason)
R3-1. The merchant id comes from the website handler's single merchant constant, not from
      `qpayAccountFor` (its `merchantId` is null for both branches; the handler keeps its own). More than
      one id there means the website changed its model: stop, never pick.
R3-2. The per-tenant login mechanism is REMOVED, not kept as a general option: Парк Од was its only user,
      no other code needs it, and an unused secret path (env names, a DB column, a second alert key,
      per-login token caching) is risk without benefit. Every tenant invoices on the platform's QPAY_*
      (as billing and the website do). A row still carrying `qpay.login` is refused rather than silently
      invoiced on another login. If a tenant ever needs its own login, it comes back with its own review.
R3-3. Only the payout account is compared between tenants (DB check and check.ts). The merchant is
      deliberately shared; comparing it would block the founder's design.
R3-4. Яармаг's account typed as hers is stopped twice: the website's `qpayAccountFor` calls it incomplete
      (→ `not-connected`), and from-website.ts refuses an equal account if the website ever stops doing so.

# NOTES — Round 2 (2026-10-04): founder's answers on the in-chat booking

Same branch/worktree/PR (#285). Binding: scratchpad round-facts.md + round2-facts.md. Nothing live.

## Status
- [x] Otgonjargal back: Яармаг, 1-р зэрэг, female, 10,000₮, `website: "Otgonjargal"` (the lead's new
      website id; her old calendar). from-website.ts against the lead's 63a33c0 builds Яармаг with her.
- [x] Typed names: stylist `aliases` (rules → row → parser → offer `a`); the Latin name alone or an alias
      picks the stylist at the stylist question. Parser refuses an alias that names two stylists.
- [x] Level words: no «зэрэг үсчин» anywhere (unit test over the rules file and every booking draft).
- [x] Level-named haircuts: Otgonjargal gets the 1-р зэрэг haircut only; e2e: typed «Отгонжаргал» for the
      МАСТЕР haircut is not taken; «Аль ч» still never a recommendation (unit test unchanged, extended).
- [x] e2e: the website's own `requiredLevelFor` and the chat's `level` agree on all 62 services.
- [x] `booking_ask_agreement` + the approved «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.»
- [x] Docs: tarasalon.org, tarasalon.parkod@gmail.com exists, proof = a real 100₮ in HER account.
      Transcript regenerated. (Парк Од's QPay: see Round 3.)
- [x] check green (2666 tests, guards); e2e 263 local with the website (19 run its code or check it), 244 CI-shaped.
- [x] Independent review (code-review skill, high, acting as reviewer.md): 10 findings; fixed 9:
      (1) the alias collision check now uses the flow's own normaliser (`choiceKey`, quotes/punctuation);
      (2) from-website.ts refuses when the website books someone at the branch the rules lack (the
      Otgonjargal gap) and (6) when a website `formerly` name is missing from her aliases (Latin former
      names added: Oyunsuren, Badamtsetseg, Batzaya, Uranchimeg, Otgonzargal); (3) a single-stylist choice
      is re-checked against the booking's gender and level (no hold/QR on a mismatch, whatever the
      session saved); (4) typed names resolve against the CURRENT config, nothing copied into sessions;
      (7) one alias validation (blank refused in rules.ts too); (8) e2e reads the stylists from the rules;
      (9) unit test reads the rules via taraRules(); (10) the «typed for the wrong level» check asserts
      the exact reply and that nobody was picked.
      NOT changed (5): a typed name of a stylist who cannot serve this line gets the generic
      «pick from list» and counts as the one miss; a precise reply needs new Mongolian wording (open item).

## Decisions (with reason)
R2-1. Her button is «Otgonjargal» alone: «Otgonjargal · 1-р зэрэг» is 23 characters, Meta cuts at 20;
      the existing rule (stylistButton) shows the name alone and the summary still says «(1-р зэрэг)».
      Not renamed or abbreviated: the founder fixed her name.
R2-2. Aliases are typed-only and per stylist in the rules file. Included: «Отгонжаргал» (founder) and
      Яармаг's approved «Үсчдийн нэр» spellings (Оюунсүрэн/Оюунаа, Бадамцэцэг/Бадмаа, Уянга, Батзаяа/Заяа,
      Уранчимэг/Чимгээ, Ананд). Left out: «Отгоо» (the lead's guess) and Парк Од's Cyrillic spellings
      (guesses) — a wrong alias would book the wrong person, so only confirmed ones. (Round 4: the
      founder approved both on 2026-10-04; they are in now.)
R2-3. The Latin name alone also picks (typing «Uyanga» used to match nothing): same risk class, helps.
R2-4. The deducted sentence goes ONLY in the summary before «Зөвшөөрч, захиалах» (where the customer
      agrees to pay), not in the pay message or the confirmation (no repetition). The approved wording
      «…хасагдаж тооцогдоно.» is used byte for byte; the website uses its own shorter «…хасагдана.» —
      reported, not picked.
R2-5. Summary keeps «Name (1-р зэрэг)» (a level label, not «… үсчин»), so the «1-р зэргийн үсчин» rule
      has no line to change; a test keeps «зэрэг үсчин» out.
R2-6. Added the website/chat level agreement check to the website section of the e2e (the lead's
      requiredLevelFor), so the two level rules cannot drift.

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
- [x] Per-branch QPay: merchant + payout account are rows per tenant; no fallback; invoice refused if
      not connected, or QPay refuses it. (Round 3: one merchant and login for both branches; only the
      account is per branch and checked against other tenants' rows.)
- [x] Website hold contract (lead): `sh` prefix, holdExpiresAt/holdPlacedAt; expired `sh` free; earlier-
      placed wins; chat holds recognised by `dalaBookingState: 'hold'` only (lead's review finding).
- [x] e2e 251 local (11 run the website's own code incl. its placeHold), 240 CI-shaped; unit + check green;
      5 SQL suites + query columns, postgrest.ts, billing-e2e 118 pass locally (PG16 + PostgREST 12.2.3).
- [x] Draft PR #285 (base claude/happy-pasteur-4gp7gd). CI green on 8287e82 (booking e2e 235 in CI).
- [x] Independent review (remote reviewer session, Opus, read-only, ~$2.59 of session spend): 3 findings,
      all fixed: (1) invoices record merchant/account (0082 columns), not the row's current ones; (2) no
      tenant slug literals in src/ (tests name branches by their place in the rules file); (3) (an own
      QPay login check; the own login is gone in Round 3).
      The lead's finding (chat hold by dalaBookingState only) also fixed.
- [x] Re-review of 35129b0 (relayed by the lead): 3 more, all fixed: settleHold reads and records payments
      even when the tenant's config is unusable (only the booking waits; e2e proves it, then books after the
      fix); collectPayments' unused config parameter dropped; the QPay login missing from the environment
      while QRs are out raises ONE on_change alert per tenant (`booking.qpay_login_missing`), closed when a
      token is obtained again (e2e proves the alert, no secret in it, and the booking once it is back).

## Decisions (with reason)
1. Rules file holds services WITH minutes (not only the website): CI can test the real list; from-website.ts
   refuses unless they equal the website's current list exactly (one source checked, two copies).
2. Service names = the website's keys («Эмэгтэй будаг — TARA BLEND (Урт)»): the duration sheet and the
   website's calendar events use them. Button labels = the price list's words; shortened only where > 20.
3. Groups = the price list's sections with an `audience` (women's/men's sections shown only to that gender).
   «Гоёлын засалт /эрэгтэй/» (printed in the women's section) is offered to men, in «Эрэгтэй засалт»:
   it is a men's styling. APPROVED by the founder 2026-10-04 (Anand at Яармаг, Tuchku at Парк Од).
4. `family` (one button, then lengths/levels) because «Эмэгтэй хими» has 18 lines and Messenger shows 13.
   One new draft line `booking_ask_variant` «{service} — аль нь вэ?».
5. A price line per level (`level`) is served only by that level; a line nobody may serve is hidden
   (men's SPECIAL haircut everywhere; 1-р зэрэг haircut at Парк Од). This also guarantees no 1-р зэрэг
   button at Парк Од. Levels are identical in both rows (one price list); Парк Од just has no 1-р зэрэг.
6. «Not connected» = literal `not-connected` in `calendar_id` / `qpay`: parses (shape checked, branches
   compared) but `customerMode` off and `bookingTurn` reason `not_connected`, testers included.
7. Merchant id/account are rows (not secret; the website has Яармаг's in source). Login stays env (rule 7):
   the platform's QPAY_* for every tenant (Round 3, R3-2).
8. One payout account = one tenant, checked before every invoice by reading other tenants' booking_config
   (`accountSharedWith`), plus `check.ts` (`shared_account`). Unreadable → refused. (Round 3: the merchant
   is shared by design, so it is no longer compared.)
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
