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
