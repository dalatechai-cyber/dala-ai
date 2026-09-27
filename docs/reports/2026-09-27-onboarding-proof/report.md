# Onboarding report — Цэцэглэг Салон (`tsetsegleg-demo`)

Run 2026-09-28 07:51 UB time (Ulaanbaatar) from `scripts/onboard/fixtures/sample-salon-branch.docx`, filled by Болор, Эзэмшигч (2026-09-27).

## Where it stands

- Readiness: **knowledge** — in the daily report until ready
- Gate 1, founder signs the wording: **open** — 13 lines, sheet `f2cbd3fb37bd` (wording-sheet.md)
- Gate 2, client confirms the facts: **open** — 12 rows, summary `ac0a43719567` (client-summary.md)
- Channels: facebook_page 990000000000001, instagram (not created: no id) — **shadow**, no token. Nothing is sent to a customer.
- Reply cases: 17, off until both gates pass.

## Written

- created tenant tsetsegleg-demo (0afe8906-79ac-4c60-a537-ffc778825aae)
- 7 business_hours
- 3 contact_points
- tenant_booking mode=link
- 13 canned_responses written UNREVIEWED (0 unchanged, signatures untouched)
- 5 out_of_scope_topics (0 kept their provenance)
- 40 comment_rules (0 left enabled, the rest disabled)
- 7 services, 9 variants, 0 aliases
- reply_style {"max_emoji":0}
- 4 staff_members (4 added, 0 reconciled)
- 3 faqs (3 added, 0 changed and unconfirmed again)
- 1 deposit_rules (1 added)
- 6 knowledge_documents (6 written)
- facebook_page 990000000000001: created, delivery_mode=shadow, no token
- instagram «@tsetsegleg.demo»: NOT created — no id (see missing)
- 17 reply_cases, inactive (17 added, 0 changed, 0 retired)

## Missing — recorded, never guessed

For the client (also listed at the end of their summary):

- form 4: «Үс будалт»: duration «2-3 цаг» does not read as minutes or hours
- form 4: a price for «Сормуус суулгалт» — **holds readiness**
- form 4: Latin spellings customers type for the services (e.g. «budalt», «hums») — not derivable (D-067)

For the operator:

- form 2.1: the Instagram account id for «@tsetsegleg.demo» — Meta routes by id, not by handle; re-run with --instagram-id

## Service names a customer could confuse

- «Хумс будалт» collides with «Гель хумс будалт» — a customer typing only the shared words is answered with BOTH, each under its own category heading (D-102). Confirm that is the reply you want; renaming one is the alternative, and no longer the only repair.

## Other findings

- [ask_client] `comment_rule_no_latin`: comment rule «complaint_again_mn» has only Cyrillic stems. 52% of the measured corpus carries no Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. Ask which spellings their customers use.
- [ask_client] `comment_rule_no_latin`: comment rule «complaint_call_mn» has only Cyrillic stems. 52% of the measured corpus carries no Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. Ask which spellings their customers use.
- [ask_client] `comment_rule_no_latin`: comment rule «complaint_days_mn» has only Cyrillic stems. 52% of the measured corpus carries no Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. Ask which spellings their customers use.
- [ask_client] `comment_rule_no_latin`: comment rule «complaint_human_mn» has only Cyrillic stems. 52% of the measured corpus carries no Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. Ask which spellings their customers use.
- [ask_client] `comment_rule_no_latin`: comment rule «complaint_money_mn» has only Cyrillic stems. 52% of the measured corpus carries no Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. Ask which spellings their customers use.
- [ask_client] `comment_rule_no_latin`: comment rule «complaint_phrases» has only Cyrillic stems. 52% of the measured corpus carries no Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. Ask which spellings their customers use.
- [ask_client] `no_latin_stems`: rule «handoff_1» has only Cyrillic stems. A customer typing the same words in another script fires no gate at all (D-067) — four of the mirror corpus’s first eleven turns were Latin. Ask which spellings their customers use, and store the shortest distinctive stem.
- [ask_client] `no_latin_stems`: rule «handoff_2» has only Cyrillic stems. A customer typing the same words in another script fires no gate at all (D-067) — four of the mirror corpus’s first eleven turns were Latin. Ask which spellings their customers use, and store the shortest distinctive stem.
- [ask_client] `no_latin_stems`: rule «never_1» has only Cyrillic stems. A customer typing the same words in another script fires no gate at all (D-067) — four of the mirror corpus’s first eleven turns were Latin. Ask which spellings their customers use, and store the shortest distinctive stem.
- [ask_client] `no_latin_stems`: rule «never_2» has only Cyrillic stems. A customer typing the same words in another script fires no gate at all (D-067) — four of the mirror corpus’s first eleven turns were Latin. Ask which spellings their customers use, and store the shortest distinctive stem.
- [ask_client] `no_latin_stems`: rule «withhold_1» has only Cyrillic stems. A customer typing the same words in another script fires no gate at all (D-067) — four of the mirror corpus’s first eleven turns were Latin. Ask which spellings their customers use, and store the shortest distinctive stem.
- [advisory] `allowed_numbers`: 17 numerals from THIS DOCUMENT would be permitted: 1, 10:00, 120,000, 15,000, 180,000, 18:00, 2, 20:00, 25,000, 3, 30,000, 40,000, 45,000, 5, 60,000, 7711-2233, 9911-4455 — a tenant that already holds knowledge-base, clarify or deposit rows licenses more than this, and they are invisible here (see `toTenantKb`)
- [advisory] `price_ranges`: 1 of 9 priced entries are ranges — each one answers a price question with «between X and Y», then a clarifying question, then the link (D-042)

## Reply cases generated from the client's facts

Exact cases never reach the model and are checked by every publish for free. The others are checked by the one paid pre-publish run (`--with-model`, D-151).

| id | customer writes | must include | must not include | exact |
|---|---|---|---|---|
| price_1 | «Эмэгтэй үс засалт хэд вэ?» | 60,000₮, 45,000₮ | 0 value(s) |  |
| price_2 | «Эрэгтэй үс засалт хэд вэ?» | 40,000₮, 30,000₮ | 0 value(s) |  |
| price_3 | «Үс будалт хэд вэ?» | 120,000₮, 180,000₮ | 0 value(s) |  |
| price_4 | «Үс угаалт, салхилгаа хэд вэ?» | 25,000₮ | 0 value(s) |  |
| price_5 | «Хумс будалт хэд вэ?» | 25,000₮ | 0 value(s) |  |
| price_6 | «Гель хумс будалт хэд вэ?» | 45,000₮ | 0 value(s) |  |
| price_7 | «Хөмсөг засалт хэд вэ?» | 15,000₮ | 0 value(s) |  |
| hours | «Даваа гарагт хэдэн цагаас хэдэн цаг хүртэл ажилладаг вэ?» | 10:00, 20:00 | 0 value(s) |  |
| address | «Хаяг хаана байдаг вэ?» | Цэцэглэг хотхоны 5-р байрны 1 давхар | 0 value(s) |  |
| booking | «Цаг захиалмаар байна» | https://tsetsegleg-demo.mn/booking | 0 value(s) |  |
| deposit_1 | «Урьдчилгаа төлбөр хэд вэ?» | 20,000₮ | 0 value(s) |  |
| rule_never_1 | «хямдрал амлах?» |  | 10 value(s) |  |
| rule_never_2 | «эмнэлгийн зөвлөгөө?» |  | 10 value(s) |  |
| rule_withhold_1 | «хүүхдийн үнэ?» |  | 10 value(s) |  |
| rule_handoff_1 | «гомдол?» |  | 10 value(s) |  |
| rule_handoff_2 | «мөнгө буцаалт?» |  | 10 value(s) |  |
| media_link | «https://youtu.be/dQw4w9WgXcQ» |  | 0 value(s) | yes |

## Answers recorded, not applied

- 8.1 tone: Найрсаг боловч мэргэжлийн. The platform's style rules (02_style) apply to every tenant; recorded only.
- 8.3 length: Богино (1–2 өгүүлбэр). Brevity is a platform rule (D-081); recorded only.
- 10.2 products: Үнийг хэлнэ. No product prices are in the form; recorded only.

## Still done by hand, in order

1. Send client-summary.md to the client. When they reply that it is right, re-run with `--apply --client-confirmed "<name>" --confirmed-on <YYYY-MM-DD> --summary <id printed at its foot>`. If they correct something, fix the form, re-run `--apply`, and send the new summary (its id changes).
2. Read wording-sheet.md and sign: re-run with `--apply --sign-wording <sheet id> --signed-by <name>`.
3. Seal the Page token (founder, by hand): `printf %s "$TOKEN" | node scripts/kek/seal.ts --tenant <uuid> --channel <uuid> --kind page_token`, run the SQL it prints, then set the channel's `app_slug`, `token_status` and name confirmation as for the live tenants. This command never handles a token.
4. Grant the Reception entitlement (`tenant_roles`, state `trial` or `active`). A money decision, so the founder's: without it the reply path answers 403 and nothing is spent.
5. Publish, after both gates: `node scripts/publish/tenant.ts --slug tsetsegleg-demo` (dry run, runs the reply cases), then once `--with-model` (paid; report its cost, D-151), then `--publish`.
6. Go live: move the channel from shadow to live by the same procedure as the live tenants, only after the above.
7. New-request alerts go to «Менежер Сараа — Telegram @saraa_demo» (2.3). Lead routing is not configured by this command.
