# Decisions

Settled calls, with the reasoning that produced them. A decision here is closed — reopen it
by adding a superseding entry, never by editing one in place.

Anything genuinely undecided is recorded as **OPEN** and says what would settle it.

---

## D-001 — Dala AI is a separate business from Core Language

**Settled.** Shared *lessons* only: zero shared code, customers, or databases. New Supabase
project, new Meta app, new repository.

**Why.** Core Language sells to students; Dala AI sells to businesses. A shared database
means one product's incident is both products' incident, and a shared codebase means one
product's release cadence governs both. The lessons are worth everything and cost nothing
to carry; the coupling is worth nothing and costs a great deal.

---

## D-002 — Multi-tenant from line one, config per tenant

**Settled.** One codebase, one deployment. Everything that distinguishes one customer from
another is a row. The falsifiable test: **onboarding client #3 is filling in a config, not
writing code.**

**Why.** The ancestor is the counter-example and it is one tenant old. Its own onboarding
guide instructs the operator to edit a JS file and redeploy — and that guide is already out
of sync with the file it points at. A config format that drifts at one tenant does not
survive three.

---

## D-003 — Sold as AI staff, priced per agent

**Settled.** Businesses hire roles, not seats or messages. Four roles: Reception, Customer
Care, Analytics, Voice. Entitlement is therefore per capability (`tenant_roles`), not one
plan tier, and each role carries its own price, its own margin floor, and its own budget
slice.

**Why.** It matches how an SMB owner already thinks about hiring, it makes the upsell path
obvious, and it means a tenant who buys only Reception cannot be charged for — or spend
against — anything else.

---

## D-004 — Prices (decided by the founder, 2026-08-31)

| Role | Setup | Monthly | Notes |
|---|---:|---:|---|
| **Reception AI** | ₮150,000 | ₮250,000 | |
| **Customer Care AI** | ₮150,000 | ₮250,000 | Blocked on a Mongolian SIP trunk |
| **Voice AI** | ₮200,000 | ₮250,000 base **+ per-minute** | Per-minute rate pending a Chimege quote |
| **Analytics AI** | ₮150,000 | ₮150,000 | **Add-on only — never sold standalone** |

**Bundles**

| Bundle | Setup | Monthly |
|---|---:|---:|
| Any 2 roles | ₮250,000 | −10% |
| Any 3 roles | ₮350,000 | −15% |
| Full team (4) | ₮400,000 | −20% |

**The bundle discounts are HARD FLOORS.** No deal goes below them. Not for a first
customer, not for a referral, not for a logo. A floor that bends once is not a floor, and
every subsequent negotiation starts beneath it.

**Target margin: 60%+ per tenant on the text agents.**

**The consequence that binds engineering.** Because the discounts are floors, every ceiling
must be computed from the **discounted** price, not the list price. Reception inside a
full-team bundle is ₮200,000/month, so at a 60% margin the allowable monthly model spend is
**₮80,000 ≈ $22.86** — and that, not ₮250,000, is the number the spend ceiling derives
from.

```
monthly_ceiling_usd = (floor_price_mnt × (1 − target_margin)) / fx_mnt_per_usd
```

Analytics being add-on-only is a pricing decision with a product consequence: the
attribution work in §7.3 never has to stand on its own commercially, so it may be honest
about what it cannot measure without losing a sale.

---

## D-005 — Reception hands over a booking link; it never books

**Settled.** Booking happens on the tenant's own site or phone. Reception sends the link
(or, where there is no site, the phone number, or a structured hand-off).

**Why.** Booking means integrating with whatever each tenant runs, which is a code change
per tenant — a direct violation of D-002. It also makes Dala AI liable for a double-booked
chair. `booking_mode ∈ ('link','phone','structured_handoff')` covers all three tenants we
know about without a branch.

---

## D-006 — The Quality layer is internal and can never auto-apply

**Settled.** It reviews conversations, flags unanswered questions, and writes
`kb_change_proposals` rows carrying the evidence. Approval writes a **draft**; publishing
stays a separate deliberate act. It is admin-only and never client-facing. Tenants opt in
at `off | metadata | full`.

**Why.** A system that edits its own knowledge base from conversations it also generated
has no independent check, and the failure is silent — a wrong price propagates and looks
like a normal update. Keeping it internal is also commercial: it is Dalatech's quality
process, not a feature a competitor can copy from a screenshot. The three-way opt-in exists
because a clinic will not sign a contract letting the platform read every DM, but the
tenant most likely to need a KB fix must not be the one whose KB never improves.

---

## D-007 — Customer Care ships as a seam with no transport

**Settled.** A provider-agnostic `outbound_messages` table, a `MessageTransport` interface,
and `NullTransport` as the **only** implementation. Consent and opt-out are modelled across
**all** roles, not just the one that sends.

**Why.** The enforcement must be structural, not a boolean someone can flip. There is no
code path from "the model produced text" to "a customer's phone rang", and that is a
property of the code rather than of anyone's discipline. Meta's outbound tags
(`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE`) were retired
2026-04-27 and now return error `100`, so this genuinely is SMS-or-nothing.

---

## D-008 — Analytics separates fact from estimate, and never lets the model compute

**Settled.** Three tiers in the Mongolian report — **Баримт** (fact), **Баталгаажсан**
(confirmed), **Тооцоолол** (estimate). An estimate never appears without its inputs printed
beside it. Every figure comes from SQL; the model only narrates. A post-check requires every
digit in the output to appear in the fact sheet, and a failure falls back to a fully
templated report **plus an alert**.

**Why.** The founder shows this to a paying customer. A month of plain templated Mongolian
is a fine month; a month with a hallucinated revenue figure is the end of the business. The
report's «Бидний харж чадахгүй зүйл» section is not a disclaimer to bury — it is the reason
a tenant believes the rest of it.

---

## D-009 — Reception's model is OPEN, pending measurement

**Not settled, deliberately.** Do not pin a model, and do not set a spend ceiling that
assumes one.

**What is known.** Sonnet 5 is both newer and cheaper than the Sonnet 4.6 the Core Language
bake-off chose, so that verdict is superseded, not inherited. The incumbent Messenger bot
runs Sonnet 5 for a production-observed reason (`salonBrain.js:16-18`: *"haiku occasionally
slips on free-form Mongolian… language quality is customer-facing"*) — real evidence, but
it predates the boundary-gate technique, and the sibling's own measurement suggests prompt
shape may have been the real variable.

**Measured 2026-08-31:** the live Messenger prefix is **11,321 characters / 19,070 bytes /
66% Cyrillic** (base 7,824 + Messenger addendum 3,497).

### Round 1 — run by the founder, unhardened. Still OPEN.

**Native-speaker verdict: Haiku's Mongolian is broken; Sonnet is clean throughout.**
Confirmed errors: «баригдлаа» (booking_confirm r2), «үнэ цэнэтэй үнэлэмж» and «яснаа»
(health_question r2), «манайн» for «манай» (staff_availability r2) — and on the abuse
probe Haiku opened with a cheerful «Сайн байна уу! 😊» self-introduction instead of
acknowledging the customer.

**One reported price was checked and is exonerated.** Haiku quoted a 20,000₮
master-stylist deposit on `staff_availability` r3. That number is **real and grounded**:
`systemPromptBuilder.js:148` sets «Мастер үсчин: 20,000₮ урьдчилгаа», and
`currentClient.js:18` lists Оюунсүрэн as a «Мастер үсчин». It is not a hallucination.

It is, however, a **relevance** failure, and a known one: the ancestor's own rule
(`salonBrain.js:94`) fires deposit information only on *expressed booking intent*, and
commit `df72418` exists specifically to stop a schedule question producing an
Оюунсүрэн-deposit reply. Haiku reproduced a bug the ancestor already fixed. The hardening
block therefore carries an explicit «цагийн хуваарь ≠ цаг захиалга» rule.

**A gate of mine was too narrow, which is why this needed a human to catch.** The numeral
check watched only the children's-haircut probe. It now runs on **every** probe: any
number in a reply that does not appear in the prefix is flagged as ungrounded. Verified it
does not flag the real 20,000₮ deposit.

### Round 2 — hardened, not yet run

Per the M0 precedent, [`hardening-mn.txt`](../scripts/bakeoff/hardening-mn.txt) adds
Mongolian-quality and misbehaviour rules **written in Mongolian**, naming each observed
wrong form above with a worked wrong-example. Run with `--harden`.

**The decision rule, fixed before the run so the result cannot be rationalised:**
- Hardened Haiku's Mongolian reads clean to the founder → **Haiku wins on economics**
  (64% margin vs 29%).
- Still broken → **Sonnet is Reception's model**, the 29% margin is recorded honestly, and
  the prefix-trim work becomes the margin-recovery path.

**What settles it:** `count_tokens` on that exact prefix, and the bake-off
(arm D vs arm E). **Both are written and ready to run** —
[`scripts/bakeoff/README.md`](../scripts/bakeoff/README.md). Neither has been run: no
`ANTHROPIC_API_KEY` in the environment that produced them.

Projected cost is **≈$0.07**, not the ~$0.45 originally budgeted — caching makes the
repeats nearly free after the first call in each arm. The run refuses before the first
call if the projection exceeds `--max-usd` (default $0.50) and stops mid-run rather than
overshooting.

**Why it matters commercially.** At the D-004 floor price the allowable spend is ₮80,000
≈ $22.86/month. On estimated numbers a busy salon (~750 conversations, ~4,500 replies)
costs roughly ₮142,000 on Sonnet 5 and ₮71,000 on Haiku 4.5 — **29% margin against 64%.**
Sonnet clears the 60% target only up to roughly 420 conversations a month; Haiku clears it
to roughly 840. So the model choice decides whether a *successful* tenant is profitable.
That is a pricing decision wearing an engineering hat, and it gets measured rather than
argued.

---

## D-010 — Model ids are platform constants, never tenant config

**Settled.** The tenant carries a `model_tier`; one registry maps tier → id, in exactly one
place. A CHECK constraint rejects date-suffixed ids.

**Why.** A per-tenant model id would let a tenant's configuration change what *we* pay per
message. Spend is ours, so the lever must be ours. The date-suffix rule exists because the
ancestor already pins `claude-haiku-4-5-20251001` in one channel and `claude-sonnet-5` in
another — two channels, two models, one of them stale.

---

## D-011 — Prompt hardening names the forbidden wrong answer

**Settled.** Six checks run first, in Mongolian, each naming the **forbidden openings**
explicitly, giving a worked wrong example with its reason, and pinning the exact correct
sentence to be copied verbatim.

**Why.** The Core Language bake-off measured this: a rule that only describes the right
answer loses to the model's disposition (1/7), and a rule that forbids the specific wrong
answer holds (3/3). The stronger form is structural — **a price that is not in the prompt
cannot be quoted** — so deliberate omissions are modelled as data that keeps the number out
of the context window entirely.

Four of the six failure modes are **hypothesised**, not measured. Shipping the text is
correct; presenting it as validated is not. Every Mongolian string requires native-speaker
review before it ships, and the schema enforces that: the renderer refuses to build a
prompt containing a line with a null `reviewed_at`.

---

## D-012 — Migrations go through the Supabase CLI with a real ledger

**Settled.** Not the dashboard SQL editor.

**Why.** Next door, dashboard-applied SQL left `supabase_migrations.schema_migrations`
frozen at a single April row, so the table looked identical whether a migration had been
applied or never applied — and that gap hid an unapplied HIGH fix in production for weeks.
Repeating it here would be inexcusable, because we already know.

---

## D-013 — The reconciliation outranks the design sections

**Settled.** `docs/architecture/09-reconciliation.md` takes precedence over every section
file, and merging it into one `schema.md` + `0001_*.sql` is the first engineering task.

**Why.** The eight sections were designed independently and invented incompatible versions
of the same tables — three spend ledgers with *different concurrency guarantees* among
them. That is the one-gate-no-local-re-implementations lesson violated inside the design
document itself. Whoever writes the first migration would otherwise make ~30 arbitration
calls alone, at speed, and the losing variants would survive in the sections nobody
re-reads.

---

## D-014 — The ancestor's `MAX_TOKENS` truncation is fixed in the port, not patched upstream

**Settled.** `salonBrain.js` sends no `thinking` parameter, so Sonnet 5 runs adaptive, and
`MAX_TOKENS = 1024` is a *shared* ceiling — thinking tokens eat the reply budget and a
customer can receive half a sentence, with nothing detecting the truncation. Reception AI
pins `thinking: {type:'disabled'}` and sizes `max_tokens` for the reply alone.

**Why not patch the old repo.** It is being replaced, the fix is a behaviour change worth
measuring rather than shipping blind, and every hour spent on the ancestor is an hour not
spent on the thing that replaces it. The exception was the origin-policy hole, which was
live unmetered spend and could not wait.
