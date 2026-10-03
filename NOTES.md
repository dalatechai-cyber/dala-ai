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
- **Staff names, levels, manicurist, Отгонжаргал:** not touched; the rename worker's
  `tara-yarmag-stylist-names-2026-10-03.sql` (branch `claude/tara-park-od-tenant`) covers all four.
- Pending provision files read live: price list, branches, branch count, stylist levels are all
  applied; the November move is not (by design).

## Status

- [x] Read 315 DMs, flags, staff echoes; report written
- [x] Two code fixes + 8 unit tests in `compose.test.ts` (each mutation-checked: fails without its condition)
- [x] Provision draft + revert, drafts file, dali.md v1.5 (A4, D12)
- [x] Draft PR #283; independent review (Opus reviewer session): 2 medium + 2 low findings, all fixed
- [x] `npm run check` after the review fixes: guards 10/10, typecheck clean, 2642 tests (2641 pass, 1 pre-existing skip: ancestor repo not checked out); re-review lows fixed (more Latin price spellings, «хэд» about a time or days excluded, dedup limit noted)
- [ ] CI on the PR head (see PR #283)

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
