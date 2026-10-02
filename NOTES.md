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
- [ ] Opus reviewer on the billing change (running) -> fix findings
- [ ] Test sends (fake data) via Gmail MCP to bilguunbilly0214+billingtest@gmail.com, after review
      fixes; logo from raw.githubusercontent.com on this branch (public repo)
- [ ] Preview artifact page with screenshots; CI green; morning report (<10 lines)

Open for the founder: no client "pause" e-mail exists (pause is a founder Telegram ask only);
pick an option in the hand-off proposal; sign the three drafts.
