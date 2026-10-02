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

- [ ] P1 verify tests (voice, needs-person, ceiling, emoji)
- [ ] P1 proposal `docs/proposals/tara-staff-handoff.md`
- [ ] P2 mail.ts to Ора layout; wordmark PNG in `public/brand/`; new lines as drafts
      (`prompt/drafts/billing/`), rendered only in draft mode until signed
- [ ] P2 preview artifact + test sends to bilguunbilly0214+billingtest@gmail.com (fake data)
- [ ] Review (reviewer agent), CI, draft PR, morning report
