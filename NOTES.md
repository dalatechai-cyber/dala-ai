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
    2026-10-04 by D-177's `treatment_perm_women` and `colour_lift`, disabled, with five inactive
    cases; no `price_page` contact.) No migration in #284.
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
