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

> **₮80,000 IS NOT A PRICE, and a session misread it as one on 2026-09-15.** Reception's
> list price is ₮250,000/month, right there in the table above. ₮80,000 ≈ $22.86 is the
> allowable model SPEND derived from the discounted floor. The two numbers are different
> quantities and do not contradict each other. The live question is which base a ceiling is
> sized from: Matrix's was set to **$28.57** on 2026-09-15, which is 60% of LIST, where the
> rule in this decision gives $22.86 from the floor. See the D-072 addendum.

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

## D-009 — Reception runs Sonnet 5. No Haiku for customer-facing Mongolian prose.

**Settled 2026-08-31, by measurement and native-speaker review.**

`claude-sonnet-5`, `prompt_cache_mode = '1h'`, thinking pinned off, `max_tokens: 700`,
non-streaming, zero tools.

**The rule, stated so it generalises past this one choice:**

> **No Haiku for customer-facing Mongolian prose.** Haiku 4.5 remains eligible for
> internal and structured work — batch triage, classification, extraction, anything whose
> output is a row rather than a sentence a customer reads.

**Why.** Two bake-off rounds on the real prefix and the six seeded probes.

*Round 1, unhardened.* Native-speaker verdict: Haiku's Mongolian broken, Sonnet clean.
Errors included «баригдлаа», «үнэ цэнэтэй үнэлэмж», «яснаа», «манайн» for «манай», and on
the abuse probe a cheerful «Сайн байна уу! 😊» self-introduction instead of an
acknowledgement.

*Round 2, hardened* — the M0 precedent applied in full: rules written in Mongolian naming
each observed wrong form with a worked wrong-example. **Haiku was still broken.** New
nonwords appeared (сөнөө, жирэмсэнцүүд, САЙХНААР сувьд) and «манайн» **recurred despite
being named in the block with a corrected example**.

That last detail is the finding. The M0 technique works — it is what fixed Core English —
and it did not work here, so the constraint is not the prompt. **It is a fluency ceiling.**
A rule cannot teach a model a language it does not have; naming a wrong form only helps a
model that can produce the right one. Hardening buys behaviour, not competence.

**What it costs — superseded by [D-016](#d-016--matrixs-real-traffic-is-41-of-the-assumed-volume-and-reception-clears-60-at-it).**
The paragraph below is left as written, per this file's convention. Its arithmetic was
correct; its *volume input* was not. At Matrix's measured traffic the margin is **71%**,
not 29%, and Reception clears the 60% target.

**What it costs.** Sonnet is roughly 2× Haiku per reply: **29% gross margin against a 60%
target** at the volume a successful salon produces. That number is recorded honestly rather
than smoothed. The recovery path is [`prefix-trim.md`](prefix-trim.md), which is worth
doing and — stated plainly there — **does not reach 60% on its own**. The remaining levers
are commercial: price, target margin, or the volume band a ₮250,000 plan is sold against.

**What shipped from the hardening.** Only the relevance rule («цагийн хуваарь ≠ цаг
захиалга») and the abuse response, in `prompts/platform/reception-mn.txt`. The
Mongolian-fluency rules did **not** ship: they were written to correct Haiku, Sonnet was
clean without them, and carrying rules for a model you do not run costs tokens on every
message and buys nothing. They stay as evidence in `scripts/bakeoff/hardening-mn.txt`.

The forbidden phrasings Haiku produced are deliberately **not** seeded into
`forbidden_phrasings` as runtime guards. They are evidence for this decision, not observed
failures of the model that ships — seeding them would be guarding against a model that is
not running.

**One measurement that survives.** The numeral gate had a false positive: the allowed set
was built from unstripped text, where «+976 7741 7777» collapses into a single 11-digit
run, while replies were checked stripped — leaving a bare `976` that was not in the set, so
any reply quoting the international number was flagged as inventing a figure. Fixed on both
sides, with 976 exempt universally rather than because one tenant's contact block happens
to contain it. Pinned by `scripts/bakeoff/test/gate.test.mjs`, which also pins the gate's
**known limit**: it asks whether a number appears in the prefix, not whether it is the right
number for the question — a children's haircut quoted at 30,000₮ passes, because 30,000₮ is
a real price for a hand spa. The `price_unlisted` probe's stricter no-number-at-all rule is
what covers that, and that is why it exists.

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

---

## D-015 — Reception is sold against a conversation band, not unmetered

**Settled 2026-09-01 by the founder**, resolving the collision between D-004's ceiling
rule and D-009's model choice.

**The band: 400 conversations/month included** in Reception's price. Beyond it, the
existing degradation ladder applies — no new mechanism.

**Why a band rather than a new ceiling.** The ceiling is unchanged and D-004's formula is
untouched: ₮80,000 ≈ **$22.86/month**. What changes is *what is promised against it*. At
the measured Sonnet 5 cost of ~$0.0090/reply and the design's own A7 = 6 messages per
conversation, $22.86 buys **2,540 replies ≈ 423 conversations**. Selling "unlimited" against
a ceiling that affords 423 was the contradiction; selling 400 removes it. The hard floor
stays hard, and the ceiling stops being a promise the platform cannot keep.

400 rather than 423 is deliberate headroom: a tenant at exactly the band should not be
skating its own ceiling.

**Overage is the degradation ladder, not an invoice.** At the band the tenant enters
state 2 (§5.7): deterministic shortcuts still answer location, hours and greetings, canned
refusals still answer, and anything needing the model gets the Mongolian handoff line once
per conversation. **Billing overage is not designed and must not be**, because no revenue
path exists yet — the platform can spend and cannot collect (see the open item in
`CLAUDE.md`). A band that degrades costs nothing to enforce; a band that bills requires
machinery we do not have.

**The band makes state 1 an upsell trigger.** The 80% soft warn already tells the founder
and not the customer. With a band, that alert is the signal to sell a bigger plan *before*
the salon notices anything — which is the direction a limit should point. The price of the
next band up is not set here.

**What this rests on, and it is the weakest part.** The overshoot that forced this decision
assumed **750 conversations/month** (`06-model-prompts.md` A8). That figure is a guess, and
the design does not agree with itself about it — `05-spend-ledger.md` assumes **300–600
conversations/month at ~5 replies each**. The spread matters enormously:

| Real volume | Monthly spend | vs the $22.86 ceiling |
|---:|---:|---|
| 300 conv | $16.20 | 0.71× — comfortably under |
| 420 conv | $22.68 | 0.99× — exactly at |
| 600 conv | $32.40 | 1.42× — over |
| 750 conv | $40.50 | 1.77× — over |

**So Matrix may already be inside the band, and nobody has looked.** The number is
countable today: `messengerProcess.js:117` in the ancestor logs one line per reply, and
those logs are in Vercel. The mirror phase (V1 Track 4) measures it properly over 14 days
before cutover, and it is the same measurement that sets `prompt_cache_mode`.

**This closes an open question five sections asked independently.** `01-tenant-model.md`,
`02-schema-rls.md`, `03-meta-routing.md`, `06-model-prompts.md` and `08-onboarding.md` each
end with a variant of *"what is the monthly ceiling, and what happens when it is hit — hard
stop, canned reply, or overage bill?"*, each noting their own gate cannot be finished
without it. The answer is: **the number is the band, and the behaviour is `canned`** — state
2 of the §5.7 ladder, which is what `07-roles-seams.md` already specified (*"Never silence"*)
and what three of the five recommended. `hard_stop` and `overage_bill` are both rejected:
the first is a broken product, the second needs a billing relationship that does not exist.

**Therefore 400 is a starting value, not a finding.** It is set now so Track 2.2 has a
constant to compile, and it is re-derived from real traffic before tenant #1 goes live. If
the mirror says Matrix runs at 300, the band was never the binding constraint and can be
raised on evidence.

---

## D-016 — Matrix's real traffic is 41% of the assumed volume, and Reception clears 60% at it

**Measured 2026-09-01** from the ancestor's production Vercel logs, which is what
[D-015](#d-015--reception-is-sold-against-a-conversation-band-not-unmetered) said to do
rather than defend 400 from a guess.

### Method, and what it can and cannot support

Counted `/api/messenger-worker` invocations per 24h across **six consecutive days**, all
on one production deployment (`dpl_2tEqj6Po…`, live since 2026-08-24), grouped
server-side by request path. The worker is invoked once per queued message, so an
invocation is one reply attempt.

| | |
|---|---|
| Wed 26 Aug | 76 |
| Thu 27 Aug | 28 |
| Fri 28 Aug | 81 |
| Sat 29 Aug | 94 |
| Sun 30 Aug | 52 |
| Mon 31 Aug | 32 |

**Mean 60.5/day, range 28–94 — a 3.4× spread.** A single day would have been badly
misleading: the first day sampled was 32, which extrapolates to less than half the
six-day mean.

**Invocations are an upper bound on model calls.** QStash retries and the `mid` dedupe
both re-invoke the worker without reaching the model, so true spend is at or below every
figure here. The bound errs in the safe direction.

### The result

| | Assumed (A8) | **Measured** |
|---|---:|---:|
| replies/month | 4,500 | **~1,842 (41%)** |
| model spend/month | $40.50 | **$16.57** |
| vs the $22.86 ceiling | 1.77× — over | **0.73× — under** |
| gross margin at the ₮200,000 floor | 29% | **71%** |

**Reception on Sonnet 5 clears the 60% target at Matrix's actual traffic**, with room.
The 29% figure in D-009 was never wrong arithmetic — it was correct arithmetic on a
volume assumption 2.4× reality.

### What this does and does not settle

**The margin figure is solid.** Spend depends only on the reply count, which is what was
measured. 71% does not rest on any unmeasured quantity.

**The conversation figure is not.** 1,842 replies ÷ **A7 = 6 messages per conversation**
gives ~307 conversations/month — but A7 is still an unmeasured assumption, and at
05-spend-ledger's ~5 it is ~368 instead. The log line carries the PSID, so distinct
customers *are* countable, but the full-text query timed out where the aggregate did not.
**So the band's adequacy is less certain than the margin's**, and anyone re-deriving the
band should count distinct PSIDs rather than divide by A7.

**A8 = 750 conversations/month is refuted.** `05-spend-ledger.md`'s 300–600 range is
corroborated, at its lower end. Where the design contradicted itself, the ledger section
was closer.

### The PSID route was tried and is not viable through the log API

Distinct PSIDs would measure conversations directly and retire A7. Tried 2026-09-01 in
2-hour windows scoped to the production deployment, with and without the text filter:
**every window carrying traffic timed out**, and only empty night windows returned. The
line-level query cannot reach busy periods; only the path-grouped aggregate can. So A7
stays unmeasured here, deliberately rather than by oversight, and the conversation figure
above keeps its caveat. It becomes trivial the moment the platform exists — `messages`
carries the PSID per row — and the mirror phase counts it over 14 real days.

### One thing the single retrieved line did settle: the prefix is 7,955 tokens

The one log line that came back carried `prompt cache: read=0 write=7955 uncached=15`.
In the ancestor the cached block is exactly the system prompt (`salonBrain.js`, PR #25),
so that is a **production-observed token count for the 11,321-character prefix** — the
`count_tokens` figure `ARCHITECTURE.md` had marked as "an estimate; has not run". The
estimate was ~6,300; the prefix runs at **~1.42 chars/token, not ~1.8**, so it was 26%
low. Checked: the ancestor checkout differs from production only by the CORS commit,
which touches no prompt file, and no code-shipped closure was active that day. An
env-configured closure cannot be ruled out from here and would only make 7,955 an upper
bound on the base prefix. **No cost figure moves** — the bake-off priced replies from real
`usage` blocks, which already carried the true count — but every *token estimate* derived
from chars ÷ 1.8 is low by about a quarter, and `prefix-trim.md` now says so.

Credit where it was earned: `06-model-prompts.md` §6.5 refused the draft's 2.0 chars/token
as the one density that happened to confirm its conclusion, and predicted **1.2–1.8** for
this corpus from its `ө ү Ё` share. Measured 1.42 sits inside that range. The section's
scepticism was right, and it is recorded here so the next density argument starts from a
measurement rather than a preference.

### The band stays at 400, and here is the case against raising it

Typical traffic sits near 307. But **the busiest single day measured (94), sustained for
a month, is ~477 conversations — outside the band.** A salon has seasons, and one good
month can look like the best week. 400 is therefore neither obviously tight nor obviously
generous, and it is *not* re-derived upward on six days of data.

**Six days is not a month.** It carries weekly shape and no monthly or seasonal shape at
all, and it is the whole life of the current production deployment, so it cannot be
extended backwards. The mirror phase's 14 days before cutover remains the measurement
that sets the band and `prompt_cache_mode`.

### The consequence for prefix-trim.md

[`prefix-trim.md`](prefix-trim.md) was written as *the margin-recovery path* for a
29%-to-60% gap. **At Matrix's real volume that gap does not exist.** The trim is now
worth doing for the reason L3 always was — it scales with tenant count — and not to
rescue this tenant's margin. Reprioritise it accordingly: it is no longer urgent.

---

## D-017 — Single-owner risk is accepted; KEK escrow and second admins are deferred

**Decided by the founder 2026-09-01.** This is an **accepted risk, not an open blocker.**
It was previously carried in `CLAUDE.md` as blocking; it no longer is, and Phase 3.0 is
complete.

**What is accepted.** One person holds sole administrative control of Meta, Supabase,
GitHub, the registrar, and (once generated) the KEK. There is no second admin and no
key escrow.

**The mitigation is provider recovery, not a second human.** Recovery email addresses and
recovery/backup codes on each provider are what stands between the business and loss of
access. That makes them load-bearing: they are the whole control, so they must actually
exist, be current, and be stored somewhere that survives losing the primary device.

**Why this is a reasonable call now.** Escrow and a second admin cost real setup and
create their own risk surface — a second admin is a second account to compromise, and a
copied KEK is a copied KEK. At one founder and zero paying tenants the loss scenario is a
rebuild of things that are all still reproducible: the schema is in the repository, the
Meta app is not yet created, and no customer data exists. The calculus changes the moment
that stops being true.

**Do not re-raise this.** Not in a status summary, not as a "remaining item", not as a
recommendation. It is decided.

**Re-raise only if one of these changes** — each is a fact a session can check, not a
judgement call:

| Trigger | Why it changes the calculus |
|---|---|
| A tenant is **live and paying** | Loss now costs someone else's business, not only ours |
| **Customer conversation data** exists in Supabase | It is no longer reproducible from the repository |
| The **KEK is generated** and encrypts real tenant tokens | Losing it orphans every tenant's Meta credentials irrecoverably |
| A **second person** joins Dalatech | The main cost of a second admin disappears |

When one fires, state that it fired and what changed — do not re-argue the original
decision.

---

## D-018 — The platform builds on Next.js 16, not the documented 14.2

**Decided 2026-09-01 during V1 Track 1 scaffolding, on evidence, not preference.**

`ARCHITECTURE.md` states the topology as "Next.js 14.2 App Router on Vercel" — inherited
from Core Language, where 14.2 is what runs. **Building V1 on 14.2 would ship a webhook
that spends money on a framework with unpatched high-severity advisories.**

`npm audit` at the newest 14.2 release (14.2.35):

| Version | Result |
|---|---|
| `next@14.2.15` (first pick) | 1 critical, 1 high |
| `next@14.2.35` (newest 14.2) | **2 high — and no 14.2.x fixes them** |
| `next@15.5.25` | 1 moderate, 1 high |
| **`next@16.3.4`** | **0 vulnerabilities** |

The decisive fact is not the count but the **fixed-in ranges**: every advisory resolves at
`<15.5.x` or `<15.5.21`. **The 14.2 line is not patched for any of them and will not be.**
Staying on 14.2 is not "pinning a known-good version", it is pinning an unmaintained one.

**One advisory is directly on V1's path.** *"Cache confusion of response bodies for
requests with bodies"* (GHSA-68g3-v927-f742, and the invalid-UTF-8 variant
GHSA-4633-3j49-mh5q) — a Meta webhook is precisely a request with a body, and the bodies
here are **Mongolian Cyrillic**, which is exactly where an invalid-byte-sequence cache bug
would bite. That is the same family as the caching trap in `CLAUDE.md` rule 8, which this
project already knows costs money in production.

**React is unaffected.** Next 16 accepts `react@^18.2.0`, so React stays at 18.3.1 and
there is no React 19 migration in this change.

**What this costs.** Divergence from Core Language's version, so a lesson learned there may
not transfer verbatim. That is a smaller cost than a known-vulnerable framework, and the
two products already share zero code by D-001. **Rule 8's caching trap must be re-verified
against Next 16's behaviour rather than assumed** — the mechanism described in `CLAUDE.md`
was read out of Next 14.2's source, and the guard script is what makes it enforceable
regardless of version.

Every dependency is pinned exactly, with no caret ranges: a platform that bills per tenant
should not float its framework.

---

## D-019 — Customer transcripts are persisted from day one, by us

**Decided 2026-09-04, from the Matrix production analysis.**

D-016's volume and margin numbers exist because **Meta keeps the inbox.** Matrix's own
service stored nothing: no message bodies, no conversation rows, no per-PSID history. Six
days of production reasoning came out of Facebook's Page inbox and the ancestor's log
lines, and every number in D-016 that rests on the log — replies per day, spend, margin —
is solid, while every number that needed a *conversation* had to divide by an assumed
messages-per-conversation constant (A7 = 6) that nothing measured. **That gap is not an
analysis mistake. It is the direct consequence of not having stored the conversations.**

So the rule, and it applies before there is a reason to want the data: **the platform
persists the transcript itself, at ingest, as its own record.** `messages` and
`conversations` are written by `inbound/persist.ts` before anything is generated, which is
already how V1 works — this decision is what stops that being traded away later for a
retention win or a schema simplification, because the value only becomes visible months
after the moment you could have started.

Three things follow, and each is a thing somebody would otherwise do:

- **Storage is not the constraint, and arguing about it is a category error.** A year of
  Matrix's measured traffic is on the order of 20,000 messages. The Quality corpus, the
  conversation-count measurement that A7 is standing in for, the Ш-block bake-offs, and
  any future analytics all read this table. §6.9.1 already calls it the most valuable data
  the business will ever have.
- **A retention policy shortens the window; it must never remove the row.** `messages` has
  `body_redacted_at` and a `redacted_or_present` CHECK precisely so that expiry nulls the
  body and keeps the fact that a message existed, at a time, in a conversation. Counting
  conversations does not need anybody's words.
- **Relying on the provider's copy is relying on somebody else's product decision.** The
  inbox is not an export, it has no API we are entitled to, and it disappears with the
  Page. It was enough to answer one question once; it is not a data store.

**What it does not license.** This is not a reason to store more per message than the
platform needs, and it does not touch the erasure path: a contact who asks to be forgotten
is deleted, cascading `conversations` → `messages` (§2.4F). Persisting by default and
deleting on request are the same policy, not opposing ones.

---

## D-020 — Seeded or guessed tenant config carries its provenance into whatever reads it

**Decided 2026-09-04, from the Matrix production analysis. This one cost real work.**

Placeholder `service_aliases` were generated to give the matcher something to chew on —
plausible Mongolian phrasings for services, invented rather than observed. The analysis
that was supposed to **validate** those aliases then read them as if they were tenant
data, and its output was corrupted by its own fixtures. The failure is not that a guess
was made; making one was reasonable. **It is that the guess became indistinguishable from
a fact the moment it was written to a row.**

This is the same shape as three failures this codebase already knows:
`supabase_migrations.schema_migrations` looking identical whether a migration ran or not;
`information_schema.role_table_grants` returning empty rather than refusing;
`unaccent` mapping `Ё→Е` and passing nine tests in ten. In every case a source answered
plausibly instead of admitting it could not.

**The rule: a seeded, guessed or placeholder row must be marked unverified in a way that
survives into every consumer, and a consumer that cannot tell must refuse rather than
assume.** Not a comment in the seed script, not a naming convention, not a note in a doc —
a column, and readers that honour it.

The mechanism already exists for the two places it was applied to: `canned_responses` and
`prompt_blocks` carry `reviewed_at`, the renderer refuses a null one, and
`check-mn-review.mjs` signs platform Mongolian by file hash. What is missing is that the
*matching* config has no equivalent. **`service_aliases`, `deterministic_replies`,
`out_of_scope_topics` and `faqs` have no provenance column**, so a placeholder alias and a
tenant-confirmed one are the same row.

**Built 2026-09-04** — migration `0011_provenance.sql`, `src/lib/provenance.ts`, and the
readers below. `provenance` (`tenant_confirmed` | `seeded` | `inferred`) is on all four
tables plus `disclosure_rules`, which is the same row in every respect that matters.

**There is no DEFAULT, and that is the load-bearing half.** A default is the whole bug in
miniature: `default 'tenant_confirmed'` blesses every placeholder somebody forgets to
label, and `default 'seeded'` mislabels real tenant data and trains people to ignore the
column. No default means the database refuses an INSERT that does not say where the row
came from — the only version of this rule that survives somebody in a hurry. The
TypeScript types mirror it: `provenance` is a required field, so a construction site that
omits it fails to compile rather than being credited with a confirmation nobody gave.

**What a reader does with an unconfirmed row depends on what the row *does*, never on
which table it sits in.** The asymmetry is the design:

| Row | Is | Unconfirmed → |
|---|---|---|
| `faqs` | a fact stated to a customer | **excluded** from the compiled prompt |
| `deterministic_replies` | a sentence sent verbatim, with no model in the loop and **no `reviewed_at` column on this table** | **withheld**; the model answers instead, at the cost of one call |
| `disclosure_rules`, `out_of_scope_topics` | an instruction *not* to answer | **kept, and counted** |

Excluding a refusal would disarm the check the tenant asked for — the failure
`matchRules` refuses to commit when a matcher will not parse. Including a guessed FAQ is
worse than it first looks: `allowed_numbers` is derived from the tenant sections (D-024),
so **a guessed price in a FAQ allow-lists itself past the outbound guard** — the one
control that exists to catch an invented number would be holding it in its own allow-list.

Counting is not logging: a fired-but-unconfirmed refusal writes `gate_rule_unconfirmed`
and a withheld reply writes `deterministic_reply_unconfirmed` to `quality_flags`, naming
the rows. `compileAndPublish` returns the excluded FAQs on the **success** path, because a
publish that quietly dropped four answers is a successful publish of a different
configuration.

**`null` is an answer, not a gap.** `readProvenance` returns null for anything it does not
recognise — an absent column, a database predating 0011, a value from a later migration —
and every consumer treats that exactly as `seeded`. There is deliberately no `isSeeded()`:
the only question a caller may ask is whether a row is confirmed, and every other state
answers no. The opposite reading, *"nothing said it was seeded, so it is probably fine"*,
is `role_table_grants` returning empty rather than refusing.

`service_aliases` carries the column and has no reader yet; the first one inherits the
rule rather than rediscovering it. Verified by execution: `catalog.sql` V23 against
PostgreSQL, an unlabelled insert refused with a NOT NULL violation, `provenance =
'probably_fine'` refused by the CHECK, and six mutations each caught by a test.

### The sibling failure: a column that looks like evidence, answering a different question

**Added 2026-09-06, by the founder, after it happened twice in one day.** D-020 is about a
row that cannot say where it came from. This is the case one step over: the row is
perfectly honest, it is *read* as the answer to a question it was never asked, and nothing
about the value says so.

| Read as | Actually answers | Cost |
|---|---|---|
| `webhook_events.state = 'processed'` — this message was answered | *the loop finished* — including the retry that skipped its own half-written row | A customer message silently lost (D-029) |
| `channel_health.observed_at` — when this fault was found | *when the watchdog last ran* — the row is upserted every hour, so the timestamp moves while the finding does not | A wrong time in a written report; caught before it was acted on |

Neither column is wrong. Both are aggregates of a *process*, read as facts about an
*event*, and the tell is the same in both: **the value changes for a reason unrelated to
the thing being asked about.** A `processed` row becomes processed because a worker
returned, not because a customer was answered. `observed_at` moves because an hour passed.

The rule that follows is narrow enough to apply: **before citing a column as evidence,
name the write that sets it.** If that write can happen when the claim is false — a retry
that returns, a scheduler that ticks — the column is not the evidence, and the evidence is
whatever the claim is actually about: a reply row for "was this answered", the alert's own
`at` for "when was this found". `findReplyFor` is that rule made structural for the first
case; the second was caught by reading the writer, which is the only tool that generalises
until a case is worth building for.

---

## D-021 — One public comment reply per post per day; the per-thread rule stays inside it

**Decided 2026-09-04 by the founder.** *"Five identical Dalatech-shaped replies under one
salon post reads as spam, and the reply's whole job is 'come to DM' — saying it once is
enough for everyone reading. Keep the per-thread rule as the inner guard."*

**This supersedes §3.8.2 rule 4's drafted `comment_replies_per_post_per_hour` (default
10).** Ten an hour is a rate limit, and rate was never the problem: the public reply is
one fixed sentence, identical every time, so the second one under a post adds nothing at
any speed. A cap counted per post per day is the shape that matches what is actually
objectionable.

The per-thread rule (one reply per thread, ever) is unchanged and is checked **first**, so
a second comment in an answered thread is still attributed to `thread_already_answered`;
`post_cap_reached` is reserved for what the thread rule cannot catch, which is the case
this cap exists for — separate people, separate threads, one post.

**"Per day" is a rolling 24 hours.** A calendar day needs a per-tenant timezone lookup and
has a hole at midnight: 23:59 and 00:01 are two days and would both be answered, two
minutes apart, under the same post.

Built in `0009`: `tenant_channels.comment_replies_per_post_per_day` (default 1, bounded
1–50) and `outbound_messages.comment_post_id`, so the count comes from the reply rows
that already exist rather than from a second table that would drift from them — the same
argument `0007` used for not creating one.

---

## D-022 — App Review is one submission, with comments bundled in — **SUPERSEDED BY D-023**

**Taken 2026-09-04 and reversed the same day, on a false premise.** It is kept rather than
deleted because the premise is the lesson. Read D-023 for the decision in force.

**Decided 2026-09-04 by the founder.** *"One ~20-day cycle, not two, and the comment path
now exists so it's demonstrable."*

The permission set is therefore `pages_messaging` + `pages_manage_engagement` +
`pages_read_user_content` in a single request, rather than DM-only now and comments in a
second cycle after Messenger is live.

**The risk taken knowingly:** reviewers trigger real webhook events, and a permission they
cannot verify sinks the whole submission rather than one feature of it. Bundling therefore
puts the DM path's approval behind the comment path's demonstrability. It is worth it
because the comment path is built end to end and demonstrable today, and because two
twenty-day cycles is most of a quarter.

**`pages_read_user_content` is the one to watch.** It is required to read customers'
comments and it appears nowhere in `docs/` — `03-meta-routing.md`'s canonical scope list
omits it. That finding is search-corroborated, not confirmed against Meta's own permission
reference, because `developers.facebook.com` is blocked from this environment. Confirm it
before submitting: a missing permission discovered mid-review is the cycle this decision
was taken to avoid.

---

## D-023 — Submit for comments only. DM Reception ships without App Review.

**Decided 2026-09-04 by the founder, reversing D-022 within hours, because D-022 rested on
a claim this repository asserted and could not check.**

> *"The Meta app exists — 'dalatech', I've used it. It already has `pages_messaging` and
> `public_profile` at Advanced Access — I generated a working Page token for Matrix and
> read the inbox with it. So Reception's DM path needs no App Review at all."*

**The premise of D-022 was false.** Every document here said no Meta app existed. No session
could falsify it — `developers.facebook.com` is blocked by this environment's egress proxy
— so it was inherited, repeated, and eventually used to sequence a quarter of work. See
CLAUDE.md's opening for the general rule this produced.

### What actually changes

**Reception's DM path is not gated on App Review.** The whole codebase makes exactly two
Graph calls: `POST /{page-id}/messages` (`src/lib/meta/send.ts`) and
`POST /{comment-id}/comments` (`src/lib/comments/send.ts`). The first runs under
`pages_messaging`, already Advanced. Nothing reads `GET /{page-id}/conversations` or any
other Graph edge — conversation history comes from our own `messages` table, which is
D-019's whole point and now pays for itself twice: it also keeps `pages_read_engagement`
off V1's critical path.

**So the submission is the comment delta and nothing else:**

| Permission | Why | Already held? |
|---|---|---|
| `pages_read_user_content` | Read customers' comments; gates the `feed` webhook field | **Submit** |
| `pages_manage_engagement` | Post the public reply. Meta makes it *depend on* `pages_read_user_content`, so the two go together or neither | **Submit** |
| `pages_messaging` | The DM send | Advanced already |
| `public_profile` | — | Advanced already |

**Business Verification is implied complete.** Advanced Access cannot be granted without
it, and two permissions are already Advanced. That is the multi-week half of App Review and
it is behind us — which is most of why bundling was ever attractive.

### The cost of the reversal, stated plainly

Bundling was the right call *given* the stated premise, and wrong given the truth. Two
cycles is no longer the comparison: DM ships now and comments arrive when they arrive, so
splitting costs nothing and buys weeks. The real cost was in the other direction and was
nearly paid — bundling would have held a shippable DM product behind a review it does not
need.

### What is still unverified, and is one glance in the App Dashboard

Nobody in this repository can read the App Dashboard. These are the founder's to check, and
each is fast:

- **`pages_read_engagement`** — its access level. V1 does not need it: no code reads
  Page-owned content or conversation history from Graph. Take Advanced Access if the
  dashboard offers it without a submission, since it is free and `subscribed_apps` is
  reported to want it.
- **`pages_manage_metadata`** — its access level. **This is the quiet one.** It gates
  `POST /{page-id}/subscribed_apps`, which is how a tenant's Page gets subscribed to
  `messages` and `feed` at all. At Standard Access it works only for Pages the app's own
  users have a role on — enough for Matrix, not for GS Auto Center. A multi-tenant platform
  that cannot subscribe tenant #2's Page has no inbound path for tenant #2, and it fails by
  subscribing nothing rather than by erroring.
- **Which app holds Matrix's current webhook subscription** — this one or the ancestor's.
  §3.3's app-vs-identity cross-check exists for exactly the cutover case, and the answer
  decides whether the mirror phase is a subscription change or a second subscription.

---

## D-024 — `allowed_numbers` comes from TENANT sections only, never from the gate

**Corrected 2026-09-04, while building the `prompt_blocks` loader. Found by compiling the
real signed blocks and reading the output.**

`renderStablePrefix` derived `config_snapshots.allowed_numbers` from the whole compiled
prefix. That was harmless for as long as L0 was a test fixture, and became a live defect
the moment the twelve signed gate blocks were compiled into the prefix for the first time.

**The gate's numerals are its counter-examples.** Ш1 contains «Чёлк тайралт 33,000₮» as
the *wrong* answer to a children's price question. Ш2 contains «ойролцоогоор 20,000₮
орчим байх аа» as the invented price it exists to forbid. Ш3 contains «маргааш 15:00
цагт болно» as the booking it must never confirm.

The outbound guard refuses any numeral in a reply that is not in `allowed_numbers`
(`guard/outbound.ts:185`). So compiling the gate handed the guard the exact fabrications
the gate is written to prevent: Ш2 would forbid the model from saying «20,000₮ орчим»,
and if it said it anyway the guard — the backstop — would wave it through.

That is §6's own worst case reproduced by the compiler: **two supposedly independent
layers, perfectly correlated, both saying yes.** It is the same shape as the Ш1 failure
that made `refusal_topics` its own check — the price tripwire passed a forbidden quote
*because 33,000 genuinely was a known price*.

**The rule: the gate is instructions; only tenant rows are facts, and only a fact may be
quoted.** `allowed_numbers` is derived from `origin = 'tenant'` sections alone.

**A tenant with no L2/L3 sections therefore gets an empty allow-list and the guard refuses
every numeral.** That is the correct direction and is not a bug to fix later: a bot with no
approved prices must not be able to emit a price.

The schema's own comment — *"every numeral the model may emit"* — was always right. The
implementation had simply stopped matching it once the prefix contained rules as well as
facts.


---

## D-025 — The silence watchdog watches TWO clocks, because the obvious one is green during the worst failure

**Decided 2026-09-04, while building the thing `STATUS.md` §3 says plainly:**

> **A single failure could still make the whole thing silent.** A dead token produces no
> error, because no request arrives to fail.

Every other failure here announces itself: a refused reply writes a `quality_flags` row, a
spent budget trips an alert, a Graph `190` halts the channel. A revoked token, an app Meta
silently unsubscribed, a webhook field switched off — none of those produce anything at
all. The only observable is an **absence**, and an absence has to be looked for.

**`03-meta-routing.md` §3.10.5 designs that watchdog as `tenant_channels.last_webhook_at`,
and this decision supersedes it**, because §3.7 of the same document describes a failure
that column is green through:

> When a Page has the **Page Inbox app as the primary receiver** — the default for many
> Pages, and the state a Page enters the moment anyone touches "Automated responses" — our
> app is a *secondary* receiver. Meta then delivers messages in `entry[].standby`, not
> `entry[].messaging`. The webhook receives a well-formed, correctly-signed,
> correctly-routed event for the right tenant, drops it, and returns 200. **Reception AI
> answers nobody, and every health signal is green.**

So the watchdog reads two clocks — webhook receipt, and inbound messages actually
persisted — and the pair distinguishes three faults that share one symptom:

| Webhooks | Messages kept | Diagnosis | Where the operator goes |
|---|---|---|---|
| arriving | arriving | healthy | — |
| arriving | **stopped** | secondary-receiver (standby) Page, or the persist path | the Page's primary-receiver setting |
| **stopped** | stopped | the token died, or Meta unsubscribed the app | re-auth, re-subscribe |
| **never any** | never any | the subscription never worked | the app-level field subscription |

The last row is §5 item 15's warning made detectable: a page-level subscribe returns
`{"success": true}` even when the app has never enabled that field, and no events are ever
delivered. Nothing else in the system would ever notice, because "no events" is exactly
what a quiet Tuesday looks like.

## Silence is measured in OPEN minutes, and that is the whole design

The obvious threshold — "alert if nothing has arrived for six hours" — **fires every
morning.** A salon closed 20:00–10:00 is silent for fourteen hours by the clock and
perfectly healthy. An alarm that cries wolf nightly is muted within a week, and a muted
alarm is worse than none: it is the failure `alerts/alert.ts` exists to prevent, arriving
from the other direction.

So the elapsed measure is the minutes during which the tenant was **open for business**,
integrated between the last event and now, with closures subtracted and the tenant's own
clock deciding. One threshold — three open hours — then means the same thing for a salon,
a garage, a night-shift business and a tenant in another timezone, with no per-tenant knob.
It is deliberately a platform constant: a per-tenant threshold invites tuning a real alert
into silence one channel at a time.

**When it cannot measure, it says so.** A tenant with no usable `business_hours` rows
produces `unknown`, not a verdict. Counting unknown hours as open alerts every
unprovisioned tenant nightly; counting them as closed disables the watchdog silently —
the watchdog acquiring the exact defect it exists to detect. `isOpenAt` already refuses to
collapse "we do not know" into "closed", and this is that refusal one layer up. The same
rule governs a failed read: the channel is reported `unknown`, never skipped.

Built: `health/silence.ts`, `health/channel.ts`, `health/watch.ts`, `worker/health.ts`,
migration `0012` (`went_live_at`, stamped by trigger so an operator cannot forget it),
`catalog.sql` V24. **Not built: the 6-hourly token probe and the subscription reconciler**,
which need a Meta app call each; they catch a *different* fault (a token that has expired
but has not yet been used) and they are the remaining half of `STATUS.md` §3's paragraph.

---

## D-026 — Ordering for the compiled prefix is done in JavaScript, by code point, never by the database

**Decided 2026-09-05, from the first run of the schema against a real Supabase project.**

`loadTenantKb` ordered every collection in SQL. That was deliberate and the reasoning was
sound as far as it went — an unordered PostgREST read makes the prefix, and therefore
`content_hash`, and therefore the prompt-cache key, differ between two compiles of
identical rows. What it missed is that **`order by` sorts under the server's collation, and
the two environments do not agree.**

Measured on the same six Mongolian strings:

| | order |
|---|---|
| CI, `C.UTF-8` | `Челк \| Чёлк \| ҮС ЗАСАЛТ \| Үс засалт \| Үс-засалт \| үс будалт` |
| Supabase, `en_US.UTF-8` | `үс будалт \| Үс засалт \| ҮС ЗАСАЛТ \| Үс-засалт \| Челк \| Чёлк` |

Completely different, and both databases are behaving correctly. `C.UTF-8` is code-point
order; `en_US.UTF-8` applies linguistic weighting, so case folds together and punctuation
is weighted differently.

**Two consequences, and the second is the one that decided this.** The prefix CI compiles
from a set of rows is not the prefix production compiles from the same rows — so a test
asserting compiled output describes CI, not production. And glibc collation is *versioned*
(the project reports `153.121`): an OS-level bump underneath the database would silently
re-order every tenant section, change every `content_hash`, and cold-miss every warm cache
entry, with no error anywhere. That is precisely the silent cache-invalidation
`renderStablePrefix` was shaped to prevent, arriving underneath it through the database.

**So ordering is a property of the rows, not of the machine they were read from.**
`ordered()` in `prompt/sections.ts` sorts after loading using `byCodePoint`, and every call
passes enough keys that no tie is left to input order. `localeCompare` is banned for the
same reason SQL ordering is: locale-sensitive by definition. The `.order()` calls stay in
the queries as documentation of intent and for deterministic pagination if a LIMIT is ever
added, but **nothing relies on them**.

Where a row carries an explicit `ordinal` — FAQs, price axes, deposit rules — the ordinal
sorts first, because it is the tenant's own priority and not a tiebreak. The first version
of the test for this used a fixture where ordinal order and alphabetical order happened to
agree; a mutation that dropped the ordinal entirely walked straight through it. The fixture
now makes them disagree.

**Not covered:** ordering performed by PostgREST for anything that does not reach the
prefix. This decision is about the compiled prompt and its cache key. A list rendered to an
operator can sort however the database likes.

---

## D-027 — `isolation.sql` runs as `service_role`, and that role MUST bypass RLS

**Settled 2026-09-05, by measurement, after the opposite was proposed.**

The proposal was reasonable and the reasoning behind it was right about a fact: the suite
connected as `postgres`, and `postgres` on this project holds `rolbypassrls = true`
(measured — `rolsuper` is false, `rolbypassrls` is true; `service_role` is the same). The
conclusion drawn from it was that the suite's tenant-separation checks therefore could not
fail. **They could, and did.** BYPASSRLS disables row-level security and nothing else: not
foreign keys, not unique indexes, not CHECK constraints, not triggers. Every one of T1–T9
rests on one of those.

**Running these assertions under a role where RLS is live would have broken them.**
Measured on PostgreSQL 16.13, with a role holding identical table grants and no BYPASSRLS,
T1's cross-tenant insert is refused with `42501 new row violates row-level security policy
for table "service_variants"` — the policy refuses first and the composite foreign key is
never reached. T1 would have printed PASS while the spine went completely untested. That is
the "green for the wrong reason" failure this repository keeps finding, and it would have
been introduced by a change intended to prevent exactly that.

So the suite asserts the opposite of the instinct. `T0` fails the run unless `service_role`
bypasses RLS **and** RLS is enabled and forced on the five tables involved — because both
halves have to hold for a refusal below to be the constraint under test rather than a
policy.

**What was genuinely wrong, and is now fixed.** The suite ran as whoever connected —
`postgres`, and in CI a superuser. The writer in production is `service_role`. T1's own
comment claimed the control "still works when the writer is service_role", and nothing
tested that. Every assertion now runs under `set local role service_role` and re-checks
`current_user` immediately before the statement it is about, so deleting a role switch
fails the test instead of silently reverting to the connecting superuser.

**Two new checks, from asking what "the mechanism is live" would have to mean.**
`session_replication_role = 'replica'` suppresses ORIGIN-enabled triggers, and is the one
documented way a writer holding INSERT/UPDATE could dodge an append-only guard. T10 asserts
`service_role` may not set it (`42501` on both PG16.13 and the live PG17.6). T11 asserts
that a role which *can* set it still cannot rewrite the ledger, because the triggers are
`ENABLE ALWAYS` rather than plain `ENABLE` — turning `catalog.sql` V9's static flag into
behaviour. On the live project `postgres` can set the parameter, so T11 ran there rather
than skipping, and the guard held.

**Mutation found two tests that asserted too little**, both by accepting any
`check_violation`:

- **T4 named the wrong constraint.** It printed "activation refused without a published
  config" while the refusal actually came from `active_requires_probe_run` — the test row
  violated both, and Postgres reports whichever it evaluates first. Dropping
  `active_requires_published_config` outright left the suite green. It is now T4a and T4b,
  each setting up the other's precondition so exactly one constraint can fire, and each
  asserting that constraint by name.
- **T5 was covered by its neighbour.** `unpriced_variant_names_its_refusal` fires on the
  same row, so dropping `unpriced_carries_no_number` left it green.

Every refusal now reads `CONSTRAINT_NAME` out of `GET STACKED DIAGNOSTICS` and asserts it.
Thirteen mutations, thirteen caught.

**`rls.sql` is unchanged and stays the other half.** It runs as `anon` and `authenticated`
and proves the policies bite; `isolation.sql` proves the constraints bite for the role that
bypasses those policies. Neither is a substitute for the other, and the reason the split
exists is written at the top of both files so the next reader does not have to rediscover
it.

---

## D-028 — an event claimed and never queued is re-published, and only expires once no reply would be sent anyway

**Settled 2026-09-06, by an incident on the first real webhook.**

Meta delivered, the signature verified, the tenant resolved, `webhook_events` row `id 1`
was claimed — and the enqueue was refused, because QStash rejects `:` in a
`deduplicationId` and every part of ours was colon-joined. The route returned 500, Meta
retried twice, both retries hit `if (claim.outcome === 'duplicate') continue;` **before**
the enqueue and answered **200**. Meta stopped. The event sat in `failed`, `attempts 0`,
`replied_at null`, and nothing in the system would ever pick it up.

Three things were wrong, and only the first is the one that looks like the bug.

**1. The id.** Fixed by hashing rather than by swapping the separator. The parts are joined
without escaping, so any separator that can also occur inside a part makes two different
events capable of producing one id — `('facebook_page','a-b')` and `('facebook_page-a','b')`
both spell `facebook_page-a-b`. A rejected request is visible; a collision silently drops
somebody's message. `sha256` over the exact string the code already built keeps the
identity and changes only its spelling.

**2. The skip.** A unique violation says a row exists. It says nothing about whether that
row ever reached the queue, and the two facts had been treated as one. `claimWebhookEvent`
now returns the existing row's `state`, and the route re-enqueues when that state is
`received` or `failed` — the only two written before the queue is involved. Fix 1 is what
makes fix 2 safe: a racing double-enqueue collapses to one job precisely because the
deduplication id is now valid.

**3. Nothing swept.** Both fixes above still depend on Meta trying again, and Meta had
already been told to stop. §3.6.3 had specified the sweeper for this — *"re-publishing with
the same `deduplicationId` … older rows → `state='expired_unqueued'`"* — and it was the one
piece of H7's second floor nobody had built. `0001` even carried the state name, and no
code wrote it.

**The threshold is the tenant's own `max_reply_age_minutes`, and that choice is the
decision.** Two obvious alternatives are worse:

- *A fixed platform grace* would expire an event for a tenant that answers up to two hours
  while a reply was still wanted, and hold one for thirty minutes for a tenant that wants
  five.
- *Re-publishing regardless of age* would spend a model call to produce a `reply_too_late`
  refusal, which `worker/freshness.ts` would then apply anyway.

Splitting at the tenant's own limit makes the two arms exhaustive and non-overlapping: on
one side a reply is still wanted, so the job is re-published; on the other no reply would
be sent, so the row is marked `expired_unqueued` and the founder is told a customer went
unanswered. It also composes with the redelivery fix — `expired_unqueued` is deliberately
*not* in `neverReachedQueue`, so a redelivery arriving after the limit is skipped rather
than re-driven, which is correct only because by then it could not be answered. The
customer's text is not lost either way: `raw_payload` still holds the delivery.

**It alerts whenever it finds anything at all**, including a successful rescue. §3.6.3 gives
the reason and it is the important one: this sweep is the *second* floor, so a row here
means the first one failed. A rescue that healed silently would hide a recurring fault
behind a system that looked like it was working — which is, exactly, what the 200s did.

**Two smaller calls inside it, both erring toward visibility.** An event is expired only
after the alert is *recorded* (`alerts` is insert-first, so "recorded" survives Telegram
being down); if even the row cannot be written, the event is left alone to be swept again,
because a state change nobody was told about is worse than a repeat. And **unrouted events
are excluded** — they are claimed for diagnosis and deliberately never queued, so without
that filter every one of them would look stranded forever and the alert that mattered would
arrive inside that stream.

**What this does not do.** Nothing here helps event `id 1` itself: the sweep runs from
`/api/workers/health`, and no QStash schedule points at it yet (§5 item 8b). The sweep has
also never read a real `webhook_events` row — it is proven against stubs and eight
mutations, not against the project.

---

## D-029 — the runtime's RPCs live where PostgREST can see them, and "answered" is proven by a reply

**Settled 2026-09-06, by two failures on the same message.**

The second real message reached the worker — QStash's first delivery of a signed job, the
hop that had never run — and refused with `guard_unavailable`. Then its retry marked the
event `processed` without answering it. Two bugs, and the second is the one that made the
loss permanent.

### 1. The spend RPC could never have worked

`app.reserve_spend` and `app.settle_spend` live in schema `app`. Every client in
`supabase/clients.ts` is constructed with no `db: { schema }` option, so supabase-js sends
PostgREST the default profile — `public` — and `db.rpc('reserve_spend')` asks for
`public.reserve_spend`, which does not exist. Not a race, not a permission: a name in the
wrong schema, failing identically for every tenant on every message since the code was
written.

**Nothing in the suite could have caught it.** The worker's test stub is
`{ from, rpc: async () => ({ data: true, error: null }) }` — it answers what it is told,
so 748 passing tests said exactly nothing about whether the function exists. That is the
general shape of the risk CLAUDE.md already names: *a schema applied to a project is not
an application talking to it.*

`0015` adds two thin `SECURITY INVOKER` wrappers in `public` rather than exposing the
`app` schema to the Data API, because exposing a schema makes everything in it
REST-reachable and `app` holds the spend primitives. The grants are the security boundary:
PostgreSQL grants EXECUTE to PUBLIC on every new function, and a `public` function is
REST-reachable, so an unrevoked wrapper would let `anon` POST to
`/rest/v1/rpc/reserve_spend` and drive any tenant's daily counter to its ceiling —
silencing that tenant until midnight, unauthenticated. The same revoke is applied to the
`app.*` originals, which have carried PUBLIC EXECUTE since `0001` and are safe today only
because the schema is not exposed.

### 2. A row exists ≠ the work was done, for the third time in one night

```ts
// "already stored, so it has already been answered or is being answered"
if (stored.value.duplicate) continue;
```

Attempt one persisted the customer's message and then died at the spend guard. QStash
retried. The retry found the inbound row *it had just written*, skipped, fell out of the
loop and marked the event `processed` — a state `neverReachedQueue` deliberately excludes,
so no redelivery will ever re-drive it. Every status code was the intended one and the
message is unanswerable.

This is D-028's mistake one layer down, and the third instance in a night: a
`webhook_events` row read as "enqueued", a `messages` row read as "answered", and a
reservation row that existed because the RPC had failed *after* inserting it.

**The fix is to ask for the artefact the work produces.** `findReplyFor` looks up the
reply by its own dedup key — `in:<inbound message id>`, exported from `outbound/claim.ts`
as `replyDedupKey` so the writer and the reader cannot drift — and returns `answered`,
`absent` or `unavailable`. Proceeding on `absent` cannot double-answer, because
`outbound_messages` is unique on `(tenant_id, kind, dedup_key)`: two workers racing the
same redelivery both attempt the insert and the loser reads the winner's row. The index
closes the window, not the read.

`unavailable` is a 503 rather than either answer, because both wrong answers cost
something real: `absent` double-replies to a customer, `answered` drops them.

### 3. The refusal log now carries the detail

`guard_unavailable` names a category. The log emitted `{ code, tenantId, eventId }` and
dropped `detail`, so a one-line schema mismatch and a database outage produced byte-
identical evidence — and the difference took an evening of inference over the ledger to
recover. The detail is logged on the 503 branch, where it exists.

---

## D-030 — the exactly-once property is tested at the entry points, not at the sites that broke

**Settled 2026-09-06, after three lost messages in one night.**

Each of the three was found in production, one at a time, after it had already cost a
message; each was fixed with a test that could only ever have caught the bug it was written
for. `src/lib/replay.test.ts` asserts the property all three violated:

> Replay any entry point with the same delivery, and the customer is answered exactly once
> — never twice, and never zero times.

Both entry points are driven directly: `handleMetaEntry` (extracted from the webhook route
for exactly this reason — *a branch in a route is a branch no test can reach*, and the
branch that lost the first message lived there) and `runReceptionJob`. Each is run twice
with the same delivery, and the harness asserts one `webhook_events` row, one `messages`
row, one `outbound_messages` row and one send. Two failure shapes get their own case: an
enqueue that failed must be re-driven rather than skipped (D-028), and a worker that died
after persisting must answer on the retry (D-029).

**The fake's constraints are read off `0001`, not transcribed.** The first draft of the
harness keyed `messages` on two columns when the real index is
`(tenant_id, conversation_id, external_id) where external_id is not null`, and it went
green on a duplicate the database would have refused. A fake carrying remembered
constraints is worse than no fake: it passes while asserting the wrong thing. So
`uniquesFromSchema()` parses the migration, partial indexes included.

**What it does not cover, and must not be read as covering.** The store is in-process. It
is not PostgREST, so it cannot catch a function name resolved against the wrong schema —
which is what D-029's third bug was, and which shipped under a suite that stubbed
`db.rpc` to return `true`. Closing that class needs PostgREST as a CI service container
with `db-schemas=public`, so that a `.rpc()` the runtime cannot reach fails in CI the same
way it failed in production. That is proposed, not built.

**A mutation the harness did not catch, and what was added.** Reverting `draftOnce` to
treat the unique violation as an error instead of reading the winner **survived** every
sequential replay, because `findReplyFor` closes the window before the index is ever
reached. The window it cannot close is two workers reading `absent` at the same instant,
where `outbound_messages_dedup` is the only floor left. That is now its own case. The
lesson generalises: a harness that only replays sequentially tests the read, never the
index underneath it.

---

## D-031 — the spend ledger moves every counter or none, and a release is a refund

**Settled 2026-09-06, before it cost anything.** `reserved_nanousd` is still `0` on both
counters: this is the rare one built ahead of the incident rather than after it.

`reserve()` walked the counters one at a time — tenant, then platform — and two leaks fell
out of that shape:

1. **A partial reservation.** The tenant counter is incremented, the platform counter
   refuses, and the tenant's day is charged for a reply that never happened. Nothing gives
   it back; the ceiling is simply lower until midnight.
2. **`release()` was a label, not a refund.** It set `spend_reservations.state` and touched
   no counter, so every 503 after a successful reserve consumed the estimate permanently —
   **once per QStash retry.** Three attempts at $0.012 is $0.036 of tenant #0's $0.475 day,
   for one message nobody answered.

**One statement per operation, not a loop that undoes itself.** A compensating undo has to
run to be correct, and the case it exists for is precisely the case where something has
just failed. `app.reserve_spend_all` updates every target in one `update … from want`,
keeping the per-row `reserved + settled + amount <= ceiling` guard that made the single-row
version safe under concurrency, and **raises if fewer rows moved than were asked for** —
so PostgreSQL rolls back the partial write and there is no state to compensate for.

**The two error codes are load-bearing.** `23514` means a ceiling refused and the caller
degrades (429). Anything else means we could not determine, and the caller refuses (503).
A negative amount therefore raises `22023`, not `23514`: it is a programming error, and
dressing it as a ceiling would quietly turn a bug into a degradation.

`app.release_spend` CASes the reservation `held → released` and refunds **only if that
matched** — so a reservation already `called`, where the provider may have been reached and
the money with it, is never refunded by a late release. `settle_spend_all` gets the same
all-or-nothing treatment for the same reason: a settlement that moved the tenant row and
not the platform row leaves the platform's day short by one estimate, permanently.

**`dayTargets()` is one definition.** Reserve, release and settle must address the same set
of counters or the ledger drifts, and two lists spelled separately is exactly how a refund
comes to miss a counter the reservation charged. Adding the monthly ceiling is a change
there and nowhere else — the all-or-nothing property is per call, not per period.

**No month is wired.** The platform's monthly cap and what a tenant sees at a month ceiling
are the founder's numbers, and `monthly_ceiling_nanousd` remains documentation until they
are picked.

**Proven at both levels, and made to go red first.** `scripts/verify/spend.sql` (10 checks,
now in `run-all.sh`) exercises the functions against a real PostgreSQL: restoring the leak
fails S2, and removing the release CAS fails S6 and S7. Four TypeScript mutations are
caught by `spend/reserve.test.ts`, which did not exist before — `reserve.ts` and
`settle.ts` had no test file at all, and were covered only incidentally through the guard.

**Still open: nothing sweeps an expired reservation.** `expires_at` is written and read by
nothing, and the `'expired'` state has no writer, so a reservation whose process died is
neither settled nor released and its budget stays consumed until the day rolls over. The
shape is a query in the health worker beside the stranded sweep — proposed, not built.

---

## D-032 — a provisioning gap is not an outage

**Settled 2026-09-06, from the first alert the platform ever raised about itself.**

The hourly health schedule's first alerting run is stamped 03:00:07 UTC, and the silence
watchdog delivered two alerts. One was real (event `id 1`, 102 minutes old, past the
tenant's 30-minute reply limit). The other said:

> Page 863503883522801: no usable business_hours row for 2026-09-06

Tenant #0 has no `business_hours` rows, because nothing has needed them yet. Silence is
measured in **open minutes** (D-025), so with no schedule there is nothing to measure and
`assessSilence` correctly refused to guess. The defect was one layer up: that refusal came
back as `unknown`, `unknown` alerts, and the dedup key carries the date — so the same
sentence would arrive once a day, for ever, on the first and only channel the platform was
watching. **Measured, not predicted:** `channel_health` is upserted every run, and by
17:00:00 UTC its reason read *"no usable business_hours row for 2026-09-07"* — the tenant's
clock had rolled over, the UTC-keyed dedup had not, and the next raise was waiting at
midnight UTC.

**The instance was one INSERT away and the instance was not the problem.** Every tenant
sits between having a channel row and having its hours entered, and Matrix will be in that
window on day one, with a real customer's Page raising a daily alert while the founder is
still deciding whether the alerting can be trusted. An alarm that cries wolf nightly is
muted within a week — which is the argument `silence.ts` opens with, arriving from a
direction its author did not look in.

**So `not_configured` / `not_provisioned` is its own verdict, recorded and never alerted.**
`silence.ts` returns `not_configured` (what is missing there is a schedule); `channel.ts`
maps it to `not_provisioned` (there the subject is the channel). It is written to
`channel_health` with the reason intact and it appears in the health worker's state counts,
so the gap is visible to anyone who looks — it simply does not page. Two conditions produce
it, and they are the same fact wearing different missing fields:

| Condition | Why it is a gap and not a fault |
|---|---|
| No usable `business_hours` row for a day the walk touched | The schedule was never entered. The remedy is a form, not an incident |
| No last inbound event **and** no `went_live_at` | There is no clock to measure from. A channel never stamped live and never used did not stop working; it was never finished |

**The boundary is deliberate, and it is where the value of the distinction lives.**
Everything else stays `unknown` and keeps alerting: a failed read, an absent tenant, and —
the one worth naming — a schedule that exists and says **closed** for the whole fourteen-day
lookback. Hours entered and marked closed are an *answer*. A live channel whose schedule
holds no trading time in a fortnight is a fact somebody should see, and unlike a form nobody
has filled in, it does not resolve itself by being ignored. Widening `not_configured` to
cover it is the mutation that makes this decision worthless, so it is a test.

**`channel_health.healthy` stays `false` here, and `0017` puts the verdict beside it.** A
provisioning gap is not a channel proven to be working, so the boolean is honest — but it
is one bit of a five-state answer, and the first dashboard question ("how many channels are
unhealthy?") would have counted an unfinished form as an outage. That is this same
conflation, waiting one layer down for a reader. **The founder called it and asked for the
migration in the same push as `0016`:** *"the first dashboard that reads a boolean will
re-make the conflation you just spent a PR removing, and an additive migration now is
cheaper than finding it later in a customer-facing view."*

`0017` adds `channel_health.state` (nullable text, no default, no backfill — a row written
before the column has no state, and inventing one is D-020 in miniature) plus one CHECK:

    healthy = (state = 'healthy')

**The CHECK names no state**, so it holds for every verdict that will ever be added while
making the drift between the two spellings unrepresentable. Deliberately absent is the
obvious `check (state in (...))`: the vocabulary is a TypeScript union that has already
grown once, `record()` only logs a failed write, and a constraint migrated out of lockstep
would silently stop health being recorded on exactly the release that added a state.
`catalog.sql` V28 asserts the column *and* the constraint — dropping either fails it, and
an inconsistent pair is refused by PostgreSQL on insert.

**Made to go red three ways**: restoring the alert gate to `if (healthy) return` fails the
watch test; collapsing `not_configured` back into `unknown` fails three; widening it to the
closed fortnight fails three.

---

## D-033 — a tenant with no facts is never asked to produce any

**Settled 2026-09-06, from the first real reply this platform ever sent.** The customer
wrote `hi bro`. Tenant #0 answered:

> Сайн байна уу? 😊 Манай **гоо сайхны салонтой** холбоотой асуулт байвал асуугаарай —
> **үнийн мэдээлэл**, үйлчилгээний талаар туслахад бэлэн байна.

*"If you have questions about our beauty salon, ask — I'm ready to help with price
information and services."* Tenant #0's `vertical` is `software`, its knowledge base is
empty, and nobody supplied either fact.

### Where it came from, measured against the published snapshot

`config_snapshots`, hash `8b35d072`, the bytes that were actually sent:

| | |
|---|---|
| `length(prompt_stable)` | **9,265** |
| Occurrences of «салон» | **4** |
| Occurrences of «үсч» / «үс буд» | **2** |
| Contains "Dalatech" or "software" | **false** |
| Heading lines (`=== … ===`) in the whole prompt | **1** |

The prefix is the twelve platform L0 blocks and nothing else — the stored block lengths
sum to 9,243, joined by eleven `\n\n` separators, which is `prompt_chars` to the character.
`renderTenantSections` returns `[]` for a tenant with no rows, deliberately.

**Five of those twelve blocks are written in salon language**, Ш8's forbidden-phrase list
(«ийм салонуудад») among them. `vertical` and `display_name` are read by no code under
`src/lib/prompt/` or `src/lib/reception/`, so the prompt tells the model in detail how a
salon should behave and never tells it who it is working for. «салон» was the only
business-type noun in its context.

Two instructions then pointed at nothing. `01_data_marker` says everything below the
«=== ТУХАЙН БАЙГУУЛЛАГЫН МЭДЭЭЛЭЛ ===» marker is reference data — the marker appears once,
inside that sentence, and **zero times as its own line**. `00_gate_preamble` rule (4) says
that when no check requires a canned answer, answer normally **from the knowledge base
below**; there was none, and no rule covers that. A greeting matches none of Ш0–Ш9, so
rule (4) fired with no else-branch.

**The outbound guard could not have caught it, and did not fail.** Its allow-list is over
NUMERALS, and it worked: `allowed_numbers` was empty, which is exactly why the reply
offered price *information* rather than a price. There is no allow-list of permissible
claims about what a business IS, and in Mongolian a deny-list of them would be the
input-filter fallacy the guard's own header rejects.

### The fix is upstream of the model, not downstream of it

`handleReception` gains a fourth free refusal: **no tenant data, no model call.** The
tenant's `handoff` line is sent instead, the hold is released, and `quality_flags` records
`no_tenant_data`. It runs after both short-circuits on purpose — a deterministic reply and
a gate short-circuit each send a sentence the tenant wrote, with no model in the loop, so
there is nothing to withhold.

It saves $0.0159 a message at the measured rate, and that is the second reason. A refusal
that spent the money and then declined to send the text would be equally correct about what
the customer sees; the safe order happens to be the cheap one.

**`hasTenantData` derives the answer from the prefix rather than reading a stored flag**,
and that was the design decision worth the most thought. A boolean on `config_snapshots`
written at compile time reads better and answers worse: every snapshot compiled before the
column existed carries `null` — including the live one with the defect — and neither
reading of `null` is acceptable. Fail closed and every provisioned tenant goes silent; fail
open and the bug stays exactly where it is. Deriving it answers correctly for every
snapshot ever compiled, with no republish and no migration.

**The test is the marker as a LINE OF ITS OWN**, because `01_data_marker` names it
mid-sentence and a substring test would therefore answer `true` for every tenant on the
platform. That coupling is guarded rather than hoped for: a test asserts no signed platform
block contains the marker on a line by itself, so a future edit fails the build instead of
silently re-enabling the model for tenants with nothing to say.

**Known and accepted:** business hours live in the volatile tail, not the stable prefix, so
a tenant with hours entered and nothing else is refused here despite having one fact.
Conservative in the safe direction, and it describes a tenant minutes into provisioning
rather than one in service.

**Made to go red three ways.** Removing the check fails three tests; making `hasTenantData`
a substring test fails the gate-only case; moving the check ahead of the short-circuits
fails the row-backed-answers case. Eighteen existing tests in `handle.test.ts` failed when
the check was added, because `promptStable: 'STABLE'` had stood for "a compiled prompt"
throughout — the fixture was the production configuration that produced the salon reply.

**Not done, and separate:** the gate blocks are still salon-flavoured, which is Matrix's
shape written into shared prose. That is a platform decision rather than a fix, and
`tenants.vertical` existing and being read by nothing is the tell. Refusing to publish a
gate-only revision was considered and rejected by the founder: it would have made tenant #0
unpublishable rather than answerable.

---

## D-034 — only the mirror generates without delivering

**Settled 2026-09-06, from a question about a different bug.** The founder asked what
reordering the credential check would break, after an undecryptable token cost $0.0161 for
a message nobody received. The answer was that reordering the decrypt breaks the mirror
phase and still cannot catch revocation — but the investigation found something cheaper and
larger sitting next to it.

**`canDeliver` was consulted AFTER the reply had been generated.** Every non-live mode
therefore paid a model call for text it then discarded. Two of them are supposed to be
free:

- **`shadow_routing`'s own description is «routing is being rehearsed; nothing is generated
  or sent»** — the string is in `delivery.ts`, two lines from the code that generated
  anyway. The code and its documentation had disagreed since the mode existed and nothing
  could notice, because the only symptom is a bill.
- **A halted channel is `off`.** `haltChannelOutbound` sets `delivery_mode = 'off'` on a
  Graph `190`, so after a token died every further message drafted a reply that could not
  be sent, at $0.0159 each, until somebody re-authorised the Page.

**The verdict is now three-way, not two.** `live` generates and delivers; `shadow`
generates and withholds; everything else does neither. `shadow` is the whole reason this is
a third state rather than a second boolean on the same axis — Track 4 runs Matrix for
fourteen days generating replies nobody sends, and that phase is how the final conversation
band gets measured. A blanket "do not generate when you cannot deliver" would delete it.

**The check runs after the message is stored**, which is §3.4.5's "persist everything,
generate nothing" taken literally for the first time. Losing the customer's question would
be far worse than paying for an answer, and a routing rehearsal that dropped inbound
messages would be rehearsing the wrong thing.

`not_generating` is logged per message and `notGenerated` is counted in the worker's
response, so QStash's delivery log distinguishes a channel that answered nothing from a
channel nobody wrote to.

**Made to go red both ways**: making the mirror stop generating fails three tests; making
the worker ignore `generate: false` fails two.

**What this does NOT close.** The FIRST message after a credential breaks still costs one
model call, because nothing marks the channel until a send fails. Halting on an
undecryptable secret was proposed and refused by the founder, for a reason worth keeping:
*"a KEK deployment slip halting every channel at once is a self-inflicted outage from a
config mistake."* The bounded version — alert immediately, stop drafting for one channel
after N consecutive credential failures, and never halt more than one channel per interval
— is specified and not built.

---

## D-035 — the gate's worked examples become per-vertical; its rationales become neutral

**Shape approved 2026-09-06; the reading evening is deliberately not scheduled.**

Five of the twelve platform gate blocks are written in salon language, and every tenant
gets all twelve. That is Matrix's shape written into shared prose, and `tenants.vertical`
existing since `0001` while being read by nothing was the tell (D-033).

**The contamination is two kinds and they take different fixes:**

| Block | Line | Kind | Fix |
|---|---|---|---|
| Ш3 | «захиалга байхгүй байх нь **салонд** шууд хохирол учруулна» | rationale | neutral wording |
| Ш6 | «амлах нь **салоны** мөнгө» | rationale | neutral wording |
| Ш1 | «**үсчний** зэрэглэл» | inline illustration | neutral wording |
| Ш5 | «Жирэмсэн үедээ **үс будуулж** болох уу?» | worked example | per-vertical |
| Ш8 | ХОРИОТОЙ … «ийм **салонуудад**» | forbidden phrase | neutral wording |
| Ш8 | БУРУУ ЖИШЭЭ: «ийм **салонууд** ихэвчлэн бэлгийн карт зардаг…» | worked example | per-vertical |

**The rationales lose nothing by being neutral** — «байгууллагын мөнгө» carries the same
force. **The worked examples would lose the thing that makes them work.** D-011's finding
is that hardening succeeds by naming the forbidden wrong answer, and Ш8's gift-card
sentence is the most load-bearing line in its block precisely because it is concrete. So
the examples stay concrete and stop being shared.

**Substituting `display_name` into L0 was considered and rejected.** It would make every
tenant's L0 bytes different, foreclosing the one cached platform prefix that
`docs/prefix-trim.md` says matters for scaling across tenants.

**Built now** (`0018`, and it changes no compiled prompt because no row carries a vertical):
the column, the loader's most-specific-wins selection, `catalog.sql` V29, and a generator
that emits per-vertical rows into their own migration. **Not built, on the founder's
instruction:** nothing is signed and nothing is published. The four example blocks sit
unsigned in `prompt/drafts/`, which is what that directory is for.

**Most specific wins, per block key.** A key may have a generic row and per-vertical rows;
taking both would put two sections in one layer/origin/ordinal slot and
`renderStablePrefix` would refuse the whole compile as `ambiguous_order`. Preferring the
vertical makes that unrepresentable, and a vertical nobody has written examples for keeps
the generic block rather than losing the gate — a quieter gap, which is why V29 asks
separately whether every vertical is covered.

**Two things the SQL run found that inspection had not:**

1. **`prompt_blocks_platform_key` was unique on `(block_key)` alone**, so two variants of
   one key could not coexist. `0018` relaxes it to `(block_key, coalesce(vertical, ''))` —
   the one non-additive line in the migration, and a relaxation, so it cannot fail on
   existing data. The original reason survives: at most one row per key can reach the
   renderer.
2. **`catalog.sql` V22 asserted exactly twelve L0 platform rows**, which would have gone
   red the day the examples landed. It now counts only rows with no vertical, so the
   twelve-block gate stays exact while per-vertical variants do not disturb it.

**The cost of the reading evening, measured rather than estimated:** five blocks edited and
four new files, so **nine signatures**. The signature is a process gate, not a
cryptographic one — `check-mn-review.mjs`'s own header records three errors already found
in the draft platform text by an adversarial read, the worst of them a duplicated verb in
the sentence whose job is to stop prompt injection. Then a migration, and a recompile and
republish per tenant because `content_hash` changes.

**One gap this exposed and did not fix.** `generate-seed.ts` writes `0010`, which is
already applied to the project. Editing the text of a block that is already in `0010` needs
a NEW migration; regenerating would produce a file that no longer describes what ran. The
generator now says so in a comment and writes per-vertical rows to their own file, but it
cannot express the edit case — so Ш1/Ш3/Ш6's neutral wording will need a hand-written
migration on the evening, not a regeneration.

---

## D-036 — three strikes, one halt an hour, and the suppression is the alarm

**Settled 2026-09-06.** A channel whose stored credential will not open fails every send,
and until D-034 it failed them expensively: the reply is drafted before the token is read.
Measured, not hypothetical — a `secret_undecryptable` cost $0.0161 for a message nobody
received. D-034 made the *second* such message free by moving the delivery gate ahead of
the model call. This closes the other half: what puts a channel out of `live` when nothing
is talking to Meta at all.

### N = 3, and the reason is not flakiness

Every code this counts is terminal by construction — the same bytes under the same KEK fail
identically next time — so **one** failure already proves the channel is broken. Halting on
one was refused, in the founder's words: *"a KEK deployment slip halting every channel at
once is a self-inflicted outage from a config mistake,"* from somebody who had made two KEK
mistakes that day. So N buys evidence that the cause is **this channel** and not **the
platform**:

| N | What it cannot distinguish |
|---|---|
| 1 | a bad row from an env var briefly wrong on one warm lambda |
| 2 | one bad deploy, observed twice inside its own rollout |
| **3 consecutive** | — three separate messages, each failing on this channel's own row |

At Matrix's measured 60.5 replies/day that is roughly an hour of traffic: long enough to
span a rollback, and it bounds the cost at 3 × $0.0159 ≈ **$0.05 per broken channel once**,
rather than per message for ever.

**A streak, not a rate.** A rate over a window is a number somebody has to tune and re-tune;
consecutive-with-reset-on-success is a property of the sequence, and the reset is the
strongest evidence available that the credential works — the provider accepted it.

### The cap, and the hole the founder found in it

One halt per hour, platform-wide, so a global cause cannot cascade: if the KEK is wrong,
every channel trips its third strike within minutes and only the first halts.

**But a global EXTERNAL event looks identical from here** — Meta revoking tokens across many
Pages — and there the cap is exactly wrong. The founder's objection, which changed the
design: it *"would leave forty-nine channels paying full model cost for two days while one
halts per hour."* Nothing would say so, because **each individual suppression is a correct
decision.**

**So the suppression is the signal.** The first time the cap holds a halt back,
`channel.credential_halt_suppressed` fires — critical, hourly, carrying the number of
distinct channels currently failing credentials. Two channels failing to open a credential
in the same hour is already anomalous; fifty is the incident, and it reaches a person in the
first hour rather than the fiftieth.

### Two exclusions, and they are the load-bearing part

`kek_unavailable` **never counts**. Its own definition says it is not one tenant: *"the
platform cannot decrypt ANYTHING sealed under that version."* Counting it counts the global
cause as local, and the cap would then be rescuing the breaker from a state it should never
have entered — better not to enter it. `secret_unreadable` is excluded for the opposite
reason: it is the one retryable code, a failed *read* rather than a failed credential.

**Neither one BREAKS a streak either.** A KEK blip between two undecryptable failures does
not make the channel healthy, and reading it as a reset would invent a fact from an absence.

### `token_status = 'error'`, never `'revoked'`

`haltChannelOutbound` answers a Graph `190`: Meta said the token is invalid, so `revoked` is
a fact reported by the authority on the matter. The breaker is answering something weaker —
a row that will not decrypt. The token may be perfectly valid at Meta; we cannot get to it.
Writing `revoked` would send an operator to re-authorise a Page whose authorisation was
never the problem, and would put something Meta never said into the platform's record of
Meta's opinion. `'error'` has been in `0001`'s CHECK since the beginning and nothing had
ever written it.

**`delivery_mode = 'off'` is not optional**, and it is the half that saves the money:
`canDeliver` (D-034) refuses to generate for a channel that is neither live nor mirroring.
Proven against the real constraints rather than by reading them — `token_status = 'error'`
alone on a live channel is refused by `live_requires_active_token`, and the three-column
write is accepted.

### The clock is the alert row

There is no `halted_at` on `tenant_channels`, and adding one would be a second place for the
same fact to drift from. `haltsInInterval` counts `channel.credential_halt` alert rows,
which are written by the halt and by nothing else — the D-020 addendum's rule applied
forwards for once, rather than after a wrong reading.

### An unreadable breaker never halts

Every read failure produces `unreadable`, not a guess. Not halting costs a bounded number of
model calls; halting a working channel on evidence nobody could read is an outage caused by
the thing that exists to prevent one.

**Made to go red six ways**: N = 1; a global code allowed to halt; an excluded code breaking
the streak instead of being skipped; the cap removed; `revoked` instead of `error`; and the
breaker never being told. Each fails one or two tests and no others.

### Still not closed

The **first** message after a credential breaks still costs one model call, because the
streak needs an attempt to count. That is the design, not an oversight: the alternative is
halting on evidence that cannot distinguish a channel from a deploy.

---

## D-037 — CI speaks PostgREST now, and the first version of the check was green while broken

**Settled 2026-09-06.** The third bug of the lost-message night was a name resolved against
the wrong schema: `db.rpc('reserve_spend')` asked PostgREST for `public.reserve_spend` while
the function lived in `app`, so **every reply for every tenant refused from the first
message that ever reached the worker.** Nothing could have caught it:

| Check | Why it was blind |
|---|---|
| the unit suite | stubs `db.rpc` and answers `true` |
| `catalog.sql` | reads the catalog directly; never asks what a REST profile exposes |
| `query-columns.ts` | checks columns against the applied schema, not against the thing that serves them |
| `replay.test.ts` | an in-process store, not PostgREST — D-030 says so itself |

**The missing layer was always the same one: nothing in CI had ever spoken PostgREST.** Now
a `postgrest/postgrest:v12.2.3` service container runs beside the database, on
`db-schemas=public` — the profile the runtime asks for, because `clients.ts` passes no
`db: { schema }`, and that omission *is* the bug.

`scripts/verify/postgrest.ts` extracts every `.rpc('…')` and `.from('…')` literal from
`src/` (the way `query-columns.ts` extracts columns — a transcribed list would pass while
the code called something else) and asserts each is exposed. Then it makes one live round
trip through the real `@supabase/supabase-js` client, so the check cannot pass on a document
alone.

### The first version was green while broken, and that is the part worth keeping

It called each RPC with `{}` and treated `PGRST202` as "not found". **It reported everything
healthy including a function I had just dropped.** Two faults, and the second is the one
that matters:

1. `PGRST202` does not mean "no such function". PostgREST resolves overloads by argument
   *names*, so `release_spend` — which exists — returns `PGRST202` when called with none.
   The signal did not mean what the check assumed.
2. **It passed anyway.** A check whose pass condition is "no specific error came back" is
   green when it is broken. That is the same defect as a stub answering `true`, which is
   the thing this file was written to catch.

It was found by dropping a function and watching the check not care — which is the only
reason it is not in the repository now, wearing a green tick.

**So the check enumerates rather than infers.** `GET /` returns PostgREST's OpenAPI
description, filtered by `follow-privileges` to what the presented role may actually reach.
A name is in that document or it is not. There is no error code to misread.

**Made to go red two ways, from both directions**: dropping `public.reserve_spend_all` —
D-029 reproduced exactly — fails it with both the enumeration and the live client probe;
`revoke all on tenant_channels from service_role` fails it on the table side. Green again
after each restore.

### Three smaller things this needed, each of them a real decision

**`authenticator` is not a migration.** Supabase provides it; `0001` deliberately does not.
A migration that invented a login role would be creating a credential, so it lives in
`scripts/verify/postgrest-roles.sql`, applied only by this check, after the migrations that
create the three roles it must be able to become.

**PostgREST is started by the step, not as a service container — and the first attempt is
why.** As a service it booted before `dala_ci` existed and before `authenticator` did, had
nothing to connect to, and stopped trying. Starting it after the migrations removes the
ordering question entirely rather than depending on how long somebody else's image retries,
which is behaviour and not a contract. The step still polls, and on a timeout prints
`docker logs` — so a transport failure explains itself instead of being reported as a schema
failure.

**And the CI run found an auth gap that local testing structurally could not.** The role was
created with `login` and no password. That works over a unix socket under `trust`, which is
how the local scratch cluster is reached, and fails over TCP under `scram-sha-256`, which is
how the CI container is reached: `fe_sendauth: no password supplied`. The auth method was
never part of what local testing exercised, so "it works locally" was true and worthless —
the same shape as `0001`'s default-privileges line being a no-op in CI and the entire
defence in production. Reproduced by switching the local `pg_hba.conf` line for 127.0.0.1 to
`scram-sha-256` and watching the identical message appear, then fixed and re-run green over
that path.

**Sixteen lines of proxy, because the client is part of what is verified.**
`@supabase/supabase-js` addresses `${url}/rest/v1/…`, which in production is Supabase's
gateway in front of PostgREST; a bare PostgREST serves at `/`. The alternative to bridging
that was to stop using the client the runtime actually uses, which is most of the value.

**And one bug caught in this diff before it shipped**, which is the lesson this repository
keeps relearning: the poll first read
`[ "$code" = "000" ] && { echo …; exit 1; }`. Steps run under `bash -e`, where a trailing
`&&` whose left side is false makes the step exit non-zero — so the terse form fails the
build **precisely when PostgREST came up correctly**. Proven by running both shapes rather
than by reading them.

### What it still does not prove

The transport, not the behaviour: `spend.sql` and the unit tests own that. And it is
PostgREST 12.2.3 against PostgreSQL 16, not Supabase's build against 17.6 — the schema is
the same, the gateway and the version are not.

## D-038 — a half-remembered name is answered by the roster, not by a lookup table

**2026-09-06.** Matrix Eco Salon answered the onboarding questions. Of the seven stylist
nicknames the knowledge-base form asked for, **there is one**: «Оюунаа». The other eight
staff have none. The founder's instruction was to *design the behaviour rather than treat
it as a lookup table — the useful case is a customer who half-remembers a name.*

> **SUPERSEDED 2026-09-07 on the facts, VINDICATED on the design (D-047).** That roster was
> stale. Five of Matrix's six active stylists have a short name — Zaya, Otgoo, Muugii,
> Оюунаа, Бадмаа — and three of the nine have left or stopped working. The count was wrong
> by five; the conclusion below was not. An alias table sized to one nickname would have
> been rebuilt for five, and the case it still could not hold — a customer who
> half-remembers a name — is now five times more likely to arrive.

### The build that was refused

`staff_aliases (tenant_id, alias, staff_id)`, mirroring `service_aliases`. It is the
obvious shape and it is the wrong one here. An alias table answers exactly the strings
somebody thought to type into it, and with one real row it would look like a mechanism
while behaving like a constant. Every name it does not hold — a misspelling, a half-heard
syllable, the wrong stylist entirely — falls through to whatever the model does with an
unmatched name, which is the case that actually happens and the case nobody designed.

### What was built instead, split by what kind of thing it is

**A fact about a person → data.** `staff_members.short_name` (`0019`): nullable, one column
on the person, rendered inline as `Оюунсүрэн (Оюунаа)` so both spellings sit in the roster
Ш4 already reads. Deliberately **not unique** — two people may share a short form, and a
unique constraint would have the schema assert they cannot while defending nothing: under
Ш10 a duplicate resolves the same way an unknown name does, by asking.

**What to do when nothing matches → the gate.** Ш10, drafted in `prompt/drafts/` and
unsigned. It fills a hole that was invisible until it was named: Ш4's non-application
clause says a named stylist's *price* falls through to Ш2, «багийн жагсаалтаас зэрэглэлийг
олж» — find the tier in the roster — and that instruction assumes the name is in the roster.
Without Ш10 the two available answers are both failures: pick the nearest-sounding name
(invent a person) or fall through to Ш8 and refuse (end a booking over a spelling). Ш10's
correct action is to ask for the full name **and show the roster**, because the roster is
the answer to "I can't remember what she's called".

### The part that is a real gap, written down rather than implied

Ш10 is the first check whose reply is **composed rather than copied** — every other block
ends by naming a `canned_responses` row, and no platform sentence can carry a per-tenant
roster. The block forbids emitting a name that is not in БАГИЙН ЖАГСААЛТ and **nothing
mechanical enforces that**: the outbound guard's allow-list is over numerals, so an invented
stylist name passes it exactly as «салон» passed everything in D-033. A name allow-list is
not obviously buildable — Mongolian names are not distinguishable from other nouns by
shape, and a deny-list over user text is the input-filter fallacy the guard's own header
rejects. The bound is prompt-level only. That is stated in `prompt/drafts/README.md` so the
reading evening judges it with the text in front of it.

### And the column found a gap in D-037

`loadTenantKb` selects `short_name`. A select naming a column that does not exist fails the
**whole** publish for that tenant — thirteen reads, one error, `staff_members unreadable`,
no new revision — and TypeScript cannot see it, because a PostgREST select list is a string.
D-037's check proved every `.rpc()` and `.from()` NAME resolves and said so explicitly about
its own limits. It now also parses every `.select()` in `src/` and asserts each column
exists on the profile, embedded resources included, resolved against the embedded table.

**Proven by mutation against a real PostgREST, three ways**: dropping `short_name`,
mistyping a plain column, mistyping a column inside `tenant_channels!inner(…)`. The first
run of the first mutation reported OK — **and that was a stale schema cache** in a PostgREST
left running from a previous attempt, not a passing check. Worth recording twice over: it is
the same shape as D-037's original defect, it was caught only by noticing that the process
that should have restarted had exited with the port already bound, and the workflow is
correct for the same reason CI is not exposed to it — PostgREST is started after the
migrations, once.

## D-039 — the event key is Meta's ids, not the length of the envelope they arrived in

**2026-09-06.** Found while designing Matrix's cutover, by reading the live project rather
than the code.

### The measurement

`webhook_events.dedup_key` was `` `${externalId}:${index}:${bodyBytes}:${matchedAppSlug}` ``
and `unique (provider, dedup_key)` is global with no time component; `purge_after` is a
column nothing writes. Every real Meta delivery this platform has received, read back from
the project:

| body bytes | text |
|---:|---|
| 310 | `yoo` |
| 313 | `hi bro` |

`310 − 3 = 307`. `313 − 6 = 307`. Both `mid` values are exactly 88 characters; the page id,
the PSID and both timestamps are fixed width. So

```
body_bytes = 307 + utf8_length(customer text)
```

and the key was, in effect, **`{page}:0:{307 + text_bytes}:{app}`**. The only thing that
distinguished two events was how many bytes the customer typed. «Сайн байна уу» is 24
bytes; so is «Хэдэн цагт вэ». The second one to arrive gets `already_queued`, a
`console.info`, and HTTP 200 — no reply, no alert, and the key is spent for ever.

At Matrix's measured ~60 messages/day the common greeting lengths are consumed within
hours. This was not a mirror-phase risk; it was why Dala AI could not go live for anyone.
Four events exist on record and all four happened to differ in length, which is the only
reason nothing had noticed.

### Why it read as fine

`ClaimInput.dedupKey` has been documented as *"Globally unique per event. Meta's message id
where present"* since it was written. The sentence was aspirational and nothing compared it
to the code. `events.ts` reasons carefully about the key's **scope** — global, not
per-tenant, so one event cannot process twice under two tenants — and never about its
**entropy**. Both halves of a correct key, and only one of them was ever examined.

### What it keys on now

`src/lib/webhook/identity.ts` collects Meta's own identifiers for what the entry carries —
`message.mid` from `messaging` and from `standby`, `value.comment_id` from `changes` —
sorts them by code point, joins on U+0000 and hashes. The key is
`{page}:{index}:m{128-bit digest}:{app}`.

They cannot collide because a mid is Meta's identity for that message: a redelivery carries
the same one, and two distinct messages never share one. The hash is for length, not
secrecy — a btree unique index has a row limit and 88-character mids add up.

An entry carrying nothing identifiable (delivery and read receipts) falls back to a digest
of the entry's own JSON, tagged `d`. That is weaker — it depends on Meta resending
identical bytes — and is deliberately confined to events that cannot produce a reply:
`meta/extract.ts` skips receipts and postbacks, so the worst case is a receipt claimed
twice and doing nothing twice. Everything that can be answered has an id.

### This is not the exactly-once guarantee

`outbound_messages_dedup` on `(tenant_id, kind, dedup_key)` is, and the reply's key comes
from the customer message's mid (D-029, D-030). An event claimed twice still cannot produce
two replies. What the event key buys is the other direction — a new message is never
mistaken for a redelivery — and no downstream key can recover from that one, because the
message never reaches them.

### Proven by mutation, in both directions

`replay.test.ts` gains the inverse of the property it was built for: two customers writing
the same words are two events, two messages, two replies, two sends. Reverting the key to
a length-derived one fails seven tests across both layers; making every key unique fails
eight, including the original replay property. Both were run.

**The harness had the same bug in miniature.** Its `generateReply` stub drafted with
`replyDedupKey(MID)` — a constant — where `reception/deps.ts` derives it from the message
being answered. Every draft in the file collided on one key, silently capping the store at
one reply. Nothing noticed while every test replayed a single message; the first test to
send two different ones found it immediately.

### `webhook_events.source` is written now

The column has carried `check (source in ('meta','mirror'))` since `0001` and every row
said `meta` because nothing ever passed anything else — the same shape as `expires_at` and
`services.duration_minutes`. A mirror has the incumbent forward each delivery, and without
this there is no way to tell a forwarded event from a direct one afterwards, which is the
question a mirror exists to answer. It is set from an `x-dala-webhook-source: mirror`
request header, strict allow-list, defaulting to `meta`.

It is **not** in the dedup key, deliberately: a mirrored copy of an event Meta also
delivered directly is the same event and must dedup against it. And it is not a trust
boundary — the request has already passed the HMAC, and nothing branches on it.

### One consequence of deploying this

The key format changes, so an event already in the table keeps its old key. If Meta
redelivered a pre-deploy event afterwards it would be claimed as new and answered again.
The four rows on record are days old and terminal, and Meta's retry window is minutes to
hours, so the exposure is nil in practice — but it is real, and the safe moment to ship it
is one with no in-flight redeliveries.

## D-040 — a row the queue accepted and never delivered is swept too

**2026-09-06.** Found while answering what a `messaging_postbacks` event does; the answer
was "nothing bad", and the trace found this next door.

`UNQUEUED_STATES` is `['received', 'failed']` and the stranded sweep read its candidate
list from it. `pending_enqueue` is written **after** a successful publish, so it is
correctly absent from `neverReachedQueue` — a Meta redelivery arriving while a QStash job
is in flight must not re-publish it. The sweep inherited that list and therefore inherited
the exclusion, and a row QStash accepted and never delivered was swept by nothing and
alerted by nothing, for ever.

§3.6.3's original text *did* name `pending_enqueue`. The state's meaning moved during
implementation, the sweep followed it, and the gap is what was left behind. `stranded.ts`
even says so in its own header — "the state names moved as the schema was built" — one
paragraph above the query that then excluded it.

### Two classes, two graces

**Claimed and never published** (`received`, `failed`): nobody else was ever going to act,
so five minutes is enough — past Meta's own retries and the route's 60-second lease.

**Published and never delivered** (`pending_enqueue`): QStash owns it until QStash gives
up. `queue/qstash.ts` publishes with `retries: 3` and Upstash backs off exponentially;
`QUEUED_GRACE_MINUTES = 45` is past that horizon with margin. **The exact schedule is
[UNVERIFIED]** — Upstash's docs are unreachable from this environment — so the number is
sized from the documented shape, and the errors are asymmetric: too long costs alert
latency on a message already too old to answer, too short means re-publishing on top of a
retry still to come, on every transient delay.

The list is a **separate constant**, `QUEUED_STATES`, not an addition to `UNQUEUED_STATES`.
That is the whole safety argument, and it is the tempting wrong fix: putting
`pending_enqueue` into `neverReachedQueue` would make every Meta retry of a perfectly
healthy in-flight event publish the job a second time.

### What it actually does, stated rather than implied

With the default `max_reply_age_minutes` of 30, a row old enough to sweep at 45 minutes is
**already past the limit**, so it takes the expiry arm and the rescue arm is unreachable
for a default tenant. That is correct rather than unfortunate: past the limit
`worker/freshness.ts` refuses anyway, so a re-publish buys a model call that produces
`reply_too_late`. **The alert is the product.** "QStash took this and never delivered it"
is a fault worth knowing about whether or not the customer can still be answered — and the
alert now names that fault instead of saying "claimed and never queued", which would send
the reader to the wrong system.

### Proven by mutation, four ways

Dropping `QUEUED_STATES` from the query, sweeping the published class at the short grace,
excluding unreadable timestamps from the longer-grace filter, and the tempting wrong fix of
adding `pending_enqueue` to `UNQUEUED_STATES` — each fails a different test.

The unreadable-timestamp case is the subtle one: the longer grace is applied in JavaScript
and a NaN comparison is false, so the naive filter EXCLUDES exactly the rows whose age
cannot be read — restoring the silence this sweep exists to break, one row at a time.

### Two more columns nothing writes

`webhook_events.attempts` and `max_attempts` are never written by any code; every
`attempts` reference in `src/` is on `outbound_messages`. They are not wired here because
age already answers the question — every completed worker run leaves a terminal state, so
a row still reading `pending_enqueue` past the horizon was never processed. Recorded so the
inventory is honest, next to `source` (D-039), which had the same shape until it was wired.

---

## D-041 — a slug is a callback path, and `app_slug` is not a Meta app

**2026-09-06, from the founder reading the App Dashboard.** There are two Meta apps:

| app | App ID | holds |
|---|---|---|
| `dalatech` | 1380702870025418 | Matrix's Page `1520409424715591`; the ancestor's callback |
| `DALA_AI` | 1562862634970492 | tenant #0's Page `863503883522801`; this platform's callback |

`DALA_AI` was created because `dalatech` was already serving Matrix's live customers and
its callback could not be repointed. Both apps' secrets live under the **one** slug
`dalatech` in `META_APP_SECRETS`, which is the `value | value[]` shape STATUS.md calls "the
designed cutover mechanism", and `tenant_channels.app_slug` for tenant #0 says `dalatech`
— naming the app that does not hold that Page.

### The contradiction, which is the actual defect

Two documents state incompatible meanings for one identifier, and both are load-bearing.

- **STATUS.md:** *"The slug is our name for a callback path, not Meta's name for an app."*
  Under that reading one slug legitimately fronts several apps, and the array is right.
- **`webhook/entry.ts`, implementing §3.3:** *"During cutover a Page is legitimately
  subscribed to two apps; without this, a leaked second app secret authenticates events for
  a Page we believe is elsewhere and nothing notices."* Under that reading a slug **is** an
  app, or the check means nothing.

Measured against the code, the second reading loses. `verifyMetaSignature` tries every
secret under every key and reports **the map key that matched, not the secret**. With both
apps under one key, `matchedAppSlug` is `dalatech` whichever app signed — so
`tenant.appSlug !== input.matchedAppSlug` **cannot fail**, and the cross-check reads as
defence in depth in every review while being a no-op. The 19:12 delivery is the proof: it
was signed by `DALA_AI` and passed a check whose stated purpose is to catch exactly that.

This is also why a session on 2026-09-06 read the database, saw one app slug, and wrote
"there is only one Meta app" into `CLAUDE.md` and three other files.

### What the slug should mean, and the cost of changing it

**One slug, one Meta app, one callback path, one secret.** Keep `value[]` for what it was
designed for — rotating *one* app's secret — and never for two apps. Then `app_slug`
identifies an app, the cross-check can fail, and the route path names the app whose
handshake token and secret it will use.

The alternative — keep slug = path, and re-derive the cross-check from *which secret
matched* — needs `META_APP_SECRETS` reshaped to `{slug: {app: secret}}` so a matched secret
has a name. It is more machinery for the same guarantee, and it leaves `app_slug` as a
column whose name means the opposite of its contents.

**Cost of moving tenant #0 to a `dala_ai` slug**, in the order it must happen, because
three of the four steps take the channel dark if done alone:

1. **Env first**: add `dala_ai` to `META_APP_SECRETS` and `META_VERIFY_TOKENS` alongside
   the existing entry, so both slugs are valid at once. Credentials — founder-only, and no
   session may ask for the values.
2. **Meta console**: repoint `DALA_AI`'s callback to `/api/webhooks/meta/dala_ai` and
   re-verify. The handshake reads `META_VERIFY_TOKENS[slug]`, so step 1 must already be
   deployed or the verification 403s.
3. **Database**: `update tenant_channels set app_slug = 'dala_ai'`. Doing this first
   refuses every delivery with `app_mismatch` — tenant #0 dark, silently, until the
   console catches up.
4. **Env last**: drop the second secret from the `dalatech` array, which is what actually
   restores the cross-check.

Two smaller consequences. The slug is in `webhook_events.dedup_key`, so keys change from
that point — same class as D-039's note, and nil in practice. And `dalatech` remains the
correct slug for **Matrix**, whose Page really is on the app of that name, so the naming
comes out truthful at the end rather than merely different.

Not built. Steps 1 and 4 are credentials and step 2 is a live Meta config change on an app
serving a real customer's Page.

## D-042 — turns to intent, and the booking link that was hostage to a price

**2026-09-07.** The founder ran a booking conversation through Matrix's restored live bot.
A customer who writes «цаг авмаар байна» is asked their gender, then the stylist tier, then
given a price, and only then the booking link. **Four replies to deliver one link**, on a
Page where 721 people had already gone unanswered.

### It is not a model failure, it is two rules composing

Each rule is defensible alone. `systemPromptBuilder.js` rule 3: a **price** question needs
the tier or gender clarified, because the price genuinely differs. The booking rule: state
the **relevant** deposit, then the booking line. "Relevant" is computable only once the tier
is known — so the instruction to include a deposit is what forces the interrogation, and the
link waits behind a number the customer never asked for.

The salon's own example dialogue teaches the same shape: price, then deposit, then the
booking CTA, after a stylist has been named.

### We inherited it before going live

The signed Ш3's correct action is «(1) шаардлагатай бол урьдчилгаа төлбөрийн дүнг мэдлэгийн
сангаас хэл; (2) …"booking_line"…» — deposit first, *if necessary*, and a model settles
whether it is necessary by asking. Same construction, same outcome, on a channel that has
not answered a customer yet. Found by reading our own block against the ancestor's rather
than by running it, which is the cheaper of the two ways.

`prompt/drafts/sh3_booking.mn.txt` is the revision: the booking line goes in the FIRST
reply, clarifying questions before it become a forbidden action rather than an optional
step, and the deposit is answered normally when the customer asks (Ш2). Unsigned — it is
customer-visible Mongolian and it replaces a signed block.

### The deposit question, and what is actually known

The deposit differs by tier (20,000₮ Мастер / 10,000₮ 1-р зэрэг), so "does the site handle
it?" is the right question to ask before deciding the bot need not.

**The salon's own FAQ answers it:** «Манай вэбсайтаар онлайнаар цаг захиалах боломжтой. Цаг
захиалахдаа QPay-ээр урьдчилгаа төлбөрөө төлнө.» The site takes the deposit at booking
time; to charge the right one it must know the tier; so it already collects the choice the
bot spends three replies establishing.

**That is an inference from their copy, not a read of their site.** `matrixecosalon.org` is
blocked by this environment's egress proxy (`CONNECT tunnel failed, 403`, re-confirmed
2026-09-07). One look at the booking flow settles it, and **no claim about what the site
does may reach customer-facing text before that** — which is why the draft asserts only
that the deposit is not needed *in order to send the link*, a statement true whatever the
site turns out to do.

### The metric

`src/lib/metrics/turnsToIntent.ts`. From the first inbound message expressing the intent,
the number of replies up to and including the one carrying the booking URL. The ancestor's
transcript is a fixture and scores **4**; a reply that leads with the link scores **1**.

Coverage cannot see this: both conversations were answered. What separates them is the
customer's patience, and the count is the measurable part of it.

**Three outcomes, kept apart on purpose.** `delivered` carries a count. `not_delivered` —
the customer asked and never got the link — carries `null`, so the worst possible behaviour
cannot be averaged into a good headline; `summarise` reports it beside the median and never
inside it. `no_intent` leaves the conversation out of the denominator entirely, because
counting it would turn the metric into a measure of how many customers happen to want a
booking. The `not_delivered` property is a DONE-TEST because it is the way this file would
lie.

**It decides nothing.** `gate/match.ts` carries the arbitration's rule that matchers run
inbound only to select rendered gate text, never as an unanchored pattern that suppresses a
reply. This reads stored messages after the fact; a wrong match costs an inaccurate number
in a report, never a refused customer. Intent matching goes through `mn/match.ts`'s folded,
segmented stems; the URL check is a substring over **our own** outbound text, which is the
one place the repository already permits one.

**The stems are a parameter, not a constant.** What counts as "asking to book" is Mongolian
that changes the number, so hard-coding a list would put per-tenant language in code and
customer-adjacent Mongolian outside the review mechanism. `MIN_STEM_CHARS` is enforced
rather than assumed: «цаг» is three characters and fires on «цагийн хуваарь», the
opening-hours question Ш3's own closing line warns is not a booking request.

### Measuring the incumbent needs the corpus problem solved first

Turns-to-intent is computable for Dala AI's drafts from the first day of the mirror. For
the ancestor it needs either `message_echoes` (D-039's note on the corpus) or hand-run
conversations like the one that produced the 4. Until then the baseline is a single
measured transcript, and should be quoted as that.


---

## D-043 — both subscribed apps get the real event, measured; the mirror is a subscription

**2026-09-07. Measured by the founder on tenant #0's live Page. Supersedes the
[UNVERIFIED] note in five places and half-answers §3.15 item 1.**

Tenant #0's Page `863503883522801` was subscribed to **both** Meta apps at once —
`dalatech` (1380702870025418) and `DALA_AI` (1562862634970492) — and one real message was
sent to it. It arrived at `DALA_AI` in **`entry.messaging`**: `has_messaging: true`,
`has_standby: false`. The platform answered it end to end.

The row, read back from the project:

```
webhook_events id 8 | source meta | routing routed | state processed
  dedup_key  863503883522801:0:mfc9ea15ae6cb46235d0cddc65528fefa:dalatech
  received_at 2026-09-07 00:31:58.579+00
outbound_messages a3bb2139 | kind reply | state sent | attempts 0
  dedup_key  in:m_LRylh-6w7AtAym1kBpobATwKi4kY2s8bDtgXmv_Ix8uFeMYqjJEcT4BOOGUw7F4Ql
  provider_message_id m_1Qjn6HEwJIy_… | drafted 00:32:10.974+00
```

**Meta delivered the real event to both apps and demoted neither.**

### What it settles

- The "Meta delivers the identical event to every subscribed app" claim in §3.13 is
  **true**. Only its citation was wrong — it was attributed to §3.10.5, which is *Back off
  the tenant, not the worker* and is about rate-limit backoff. Three sessions repeated the
  citation; nobody opened the section. The fix was to measure it, not to hunt for a better
  section number.
- **The mirror is a second subscription, not a forwarding hop.** Track 4 needs no relay
  from the ancestor to this platform: subscribe `DALA_AI` to Matrix's Page alongside
  `dalatech`, and both systems receive the identical event. §3.13.1 is the call.
- `webhook_events.source` (D-039) stays. It cost one column, it distinguishes `meta` from
  `mirror` for free, and the day forwarding is wanted is not a day to be adding a column.

### What it does NOT settle, and reading it as settled would restore a silent failure

The measurement was taken on **tenant #0's Page**, and it proves one thing: *being a second
subscribed app is not itself a Handover demotion*. It says nothing about a Page whose
**primary receiver is the Page Inbox app**, which is a different setting and the case §3.7
actually describes. `worker/reception.ts`'s terminal refusal of `entry.standby` and its
once-per-channel-per-day alert stay exactly as they are, and `reception.test.ts` carries
that sentence beside the test so the next reader does not delete the branch on the strength
of this row.

If Matrix's own Page turns out to have a primary receiver, `DALA_AI` lands in `standby`
there, the mirror generates nothing and alerts daily. That is discoverable with one message
and is not an outage.

### The console's *Add Page* picker is a replacement, and it took Matrix offline

Getting this measurement cost ten minutes of Matrix's live bot on 2026-09-06. The App
Dashboard's Add Page flow writes the **complete set** of Pages granted to an app, so a Page
not re-selected is revoked and its subscription dies silently. It is the same shape as
`subscribed_fields` — a replacement presented as an addition — and those two are the only
writes in §3 that behave that way. Hence §3.13.1: do the subscription by API with a token
whose issuing app has been verified through `debug_token`, never through the picker.

The asymmetry that makes the API route safe is that **`POST /{page-id}/subscribed_apps`
takes no app parameter**. The app is implied by the token, so a `DALA_AI`-issued token
cannot reach `dalatech`'s subscription — and, in the other direction, a `dalatech`-issued
one silently rewrites the incumbent's field list on a live Page. That is why the token's
`app_id` is the abort check and not a formality.

---

## D-044 — `purge_after` is inert, and half its design never shipped

**2026-09-07, found while provisioning Matrix's Stage 1. Not a decision yet — a measured
gap and the constraint that bounds it. The retention number itself is the founder's, because
it is a promise to a third party's customers rather than a technical parameter.**

### The design already exists

`02-schema-rls.md` § Retention decided this long before Matrix:

| Data | Default | Configurable | Mechanism |
|---|---|---|---|
| `webhook_events.raw_payload` | **7 days** | `retention_days_raw_events`, 1–30 | NULL it, set `raw_purged_at`. **Row survives for idempotency.** |
| `webhook_events` row | 30 days | no | Delete |
| `messages.body` | 90 days | `retention_days_messages`, 30–730 | NULL it, set `body_redacted_at` |

### What actually shipped, measured against the project

- **`tenants.retention_days_raw_events` does not exist.** What shipped is
  `tenants.message_retention_days` (default 90, check 7–730) — the *messages* knob under a
  different name from §2's. The raw-events knob has no column at all.
- **`webhook_events.raw_purged_at` does not exist.** So a nulled payload would be
  indistinguishable from an event that never carried one.
- **`messages.body_redacted_at` does exist.** The messages half of §2 shipped; the
  `webhook_events` half did not.

So `purge_after` is one timestamp carrying the only meaning still expressible — *delete this
row after this* — and the 7-day payload-nulling has nowhere to record itself.

### Nothing enforces any of it

§2 specifies one nightly job, `ops.purge_expired(p_max_rows int default 50000)`. Read off
`pg_proc` on the live project, `ops` contains exactly `deny_mutation`, `deny_truncate`,
`stamp_went_live`, `stamp_went_live_on_insert`. **There is no purge function and no
schedule**, and `purge_after` is written by no code path. The column is inert in both
directions: nothing sets it, and nothing would act on it if it were set.

### The constraint is two-sided, and the lower bound is the interesting one

**Below**, idempotency binds it. `unique (provider, dedup_key)` is the only thing stopping a
Meta redelivery being answered twice, and that guarantee lives **in the row**. Delete the row
and the key goes with it, so a redelivery afterwards is a new event and a second reply to a
customer. `purge_after` must therefore outlive Meta's redelivery window — which is
[UNVERIFIED] (§3.15 item 4; `developers.facebook.com` is blocked) but observed in hours, and
§3.1's two-floor design exists so nothing depends on pinning it. **This is exactly why §2
nulls the payload at 7 days instead of deleting the row at 7 days: the PII goes and the
idempotency stays.** It is the argument against the obvious shortcut.

**Above**, the privacy promise binds it, and that is a commitment rather than a measurement.

### Do NOT start writing `purge_after` before something deletes on it

The column exists, so it could be filled at claim time tonight with no migration. That would
be the wrong move: a populated `purge_after` that nothing acts on is a column that *looks*
enforced, which is this repository's most-repeated failure — a row existing read as the work
having been done (D-028, D-029). Write it in the same change that deletes on it, never before.

### What closing it costs

One migration (`raw_purged_at`, and either a `retention_days_raw_events` knob or the decision
to hard-code 7), plus `ops.purge_expired` and a schedule. The job is safe to schedule by the
health worker's argument: it reaches no provider and spends nothing, so `NOTHING SPENDS ON A
SCHEDULE` is not engaged. It must be bounded per run and alert on hitting its ceiling, because
a purge silently falling behind is how a retention promise becomes false.

**This became urgent on 2026-09-07**, not because the design changed but because the data did:
Matrix's Page is subscribed, so `raw_payload` now holds a third party's customers' verbatim
messages, and the data-deletion callback still cannot join an app-scoped id to a page-scoped
one (Step 18).

---

## D-045 — retention is enforced by a job, and the floor on it is idempotency

**2026-09-07, on the founder's instruction to close D-044. `0020` + `worker/purge.ts` +
`scripts/verify/retention.sql`. Written and validated; NOT applied — the founder pushes it.**

D-044 found the gap; this closes it. `webhook_events.raw_purged_at` and
`tenants.retention_days_raw_events` exist, `ops.purge_expired` exists with a `public`
wrapper, and `/api/workers/purge` runs it on a QStash schedule.

### Three things worth carrying forward

**`purge_after` is still written by nothing, and that is now a decision rather than an
omission.** Stamping `received_at + interval` at claim time freezes the policy in force on
the day the row arrived: lowering a tenant's retention would not shorten the life of a
single row already stored. Retention is computed from `received_at` at purge time instead,
and the column is reserved as a per-row override — a legal hold, not the mechanism. The
migration says so in a `comment on column`, so the next reader finds the reason where the
question occurs to them.

**The floor on how long a row lives is idempotency, not privacy.** `unique (provider,
dedup_key)` is the only thing stopping a Meta redelivery being answered twice, and it lives
IN THE ROW. Delete the row and a redelivery is a new event and a second reply to a real
customer. That is the whole reason §2 nulls the payload at 7 days rather than deleting at 7
days: the PII goes, the key stays. The 30-day row delete clears Meta's redelivery window
(hours, §3.15 item 4) by orders of magnitude, and is deliberately not configurable.

**An unrouted event gets the 1-day floor, not the 7-day default.** It belongs to no tenant,
so no tenant's policy can justify keeping it — and it is the row most likely to hold a third
party's PII we were never entitled to store. Matrix's Page produced two of them before Stage 1.

### The order of the two operations is load-bearing, and a test found it

The first version nulled payloads and then deleted rows. A 40-day-old row was therefore
counted in `payloads_purged` AND in `rows_deleted` — one row, two numbers, an audit trail
that overstates what a run did. P5 in `retention.sql` failed on the count, not on the rows,
which is exactly why that check asserts on the numbers. Deleting first makes the counts
disjoint; and if the delete hits its ceiling, the rows it did not reach still get their
payload nulled, so a bounded job falls behind in the safe direction.

### A purge that could not run must never look like a purge of nothing

`worker/purge.ts` returns 503 on an RPC error **and on a null answer**. `{purged: 0}` with a
200 is byte-identical to a database with nothing due, and that ambiguity is how a broken
purge stays green for months — the D-044 failure repeating one layer up. Hitting the
per-run ceiling is a `warn` alert keyed by day, not a failure: the run succeeded, and
retrying immediately would do another 50,000 and alert again.

The wrapper in `public` is not ceremony. Every client in `supabase/clients.ts` is built with
no `db: { schema }`, so a function reachable only in `ops` is unreachable from the runtime —
D-029's third bug, which refused every reply for every tenant for a day.

### Addendum, 2026-09-07: the suite proved the logic, not the caller

The founder asked whether a purge returning 200 with zeros was working or lying. It was
working — nothing was old enough, and `audit_log` proved the run happened — but the question
exposed a real gap and the twelve checks would not have closed it.

`retention.sql` called `ops.purge_expired` **as the migration owner**. Its own header said so:
*"Runs as the migration owner. `rls.sql` covers who may call it; this covers what it does."*
That scoping is the hole. Production calls `public.purge_expired` as `service_role`, and
`webhook_events` carries `relforcerowsecurity` — which strips the table owner of its usual RLS
exemption. The function survives that only because it is SECURITY DEFINER owned by a role
holding BYPASSRLS. Three properties, each changeable in a migration, none asserted.

**P13** now calls through `public.purge_expired` as `service_role` with a due row and asserts
the row actually changed. **P14** pins the three premises from the catalog. Mutation-tested
four ways: revoking the caller's EXECUTE and dropping the `public` wrapper both abort the
suite; dropping SECURITY DEFINER fails P14; and the full silent-no-op — SECURITY INVOKER plus
a caller that cannot see past FORCE RLS, with `audit_log` deliberately made writable so the
run still looks healthy — fails **P13**, which is precisely the class it exists to catch.

**A property worth knowing, found by that last mutation.** When the caller is blocked from
`webhook_events` it is normally blocked from `audit_log` too, and the function's own audit
insert then raises rather than returning zeros. The audit row is a canary: a
privilege-blocked purge fails loudly instead of reporting an empty queue. That was not
designed — it falls out of writing the audit row inside the same function — but it is worth
keeping, and it is why the M4 mutation had to grant `audit_log` writability to reproduce the
silent case at all.

**A testing-hygiene note.** `alter role service_role nobypassrls` is CLUSTER-level, and `0001`
creates roles `if not exists` without resetting attributes — so a mutation on one scratch
database leaked into every other one. `isolation.sql`'s T0 caught it immediately, which is
what T0 is for. Restore cluster-level role attributes explicitly; recreating the database does
not.

---

## D-046 — the clarifying-question signal, and a fragment rule that refuses

**2026-09-07. `metrics/clarify.ts`, `redact/fragment.ts`. Built ahead of the rest of the gap
report, which waits for Stage 5.**

The fortnightly gap report clusters conversations where we refused, sent the handoff line, or
asked a clarifying question. The first two are recorded — `quality_flags` carries a coded row,
a handoff also shows as `messages.answered_by = 'canned'`. **The third was invisible**:
`disambiguation_pairs` is read only by `prompt/sections.ts`, which renders it into the prompt
as text. No matcher, no gate, no flag. The model decides to clarify and the reply is
`answered_by = 'model'`, byte-identical to a real answer.

Three sources, precedence in this order, with `via` recording which decided: `configured`
(the reply matches one of the tenant's own clarify questions — certain, free, and circular,
since it can only find what is already configured), `classifier` (injected, so this module
never calls a provider and cannot spend), `structural` (inference from `turnsToIntent`).

**Option (c) was refused by the founder and the reason is worth keeping:** nothing changes
customer-visible behaviour to improve a report. No marker the model emits, no clarify gate.

### I was wrong about the structural rule, and the test said so

The design note claimed `turnsToIntent` catches the «цаг» case exactly. It does not.
«цаг» matches no booking stem — it is three characters and ambiguous, which is the whole
point of it — so the intent lands on the customer's SECOND message and the conversation
scores `turns: 1`. Correct by the metric's own definition, and blind to the clarification,
which happened *before* the intent existed. Counting "replies after the intent" found nothing
in the founder's own example.

The rule is therefore **before the link, not after the intent**: every reply preceding the
one that delivered the link. A link the bot volunteered unprompted is excluded by its
CONTENT rather than its position — it carries the URL, so it answered. `carriesBookingUrl`
is exported from `turnsToIntent.ts` and imported here rather than re-implemented, so the
metric and the report cannot drift apart about the same reply. A second test then caught
that `delivering` must be the first link-carrying reply AFTER the intent, or a bot that
greets with the link collapses the window to nothing.

### `unknown` is not a clarification

A classifier that cannot tell must not inflate the count, or the report measures the
classifier's confidence rather than what customers hit — and improves as the classifier gets
*less* certain. `unknown` falls through to the structural evidence rather than discarding it;
`answering` overrides structural, because a model that has read the text knows more than an
inference from position.

### The fragment rule is structural, not a filter

The founder's instruction: shortest distinguishing fragment, never a whole conversation,
never a PSID, never a phone number or a name a customer typed; and if a cluster cannot be
understood from a fragment, say so and point at `kb_change_proposals`.

Detecting names in Mongolian is the input-filter fallacy `guard/outbound.ts` already rejects.
So the fragment is never taken from one customer's message — it is the shortest term shared
by at least two **distinct customers**. A term two different people typed is structurally not
either person's name or number; the privacy property falls out of the definition. Two
backstops on top: any run of 4+ digits disqualifies a term (a PSID is ~16, a Mongolian mobile
is 8), and a 40-code-point cap, because a longer "fragment" is a sentence somebody typed.

`safeFragment` returns a refusal as a first-class result. A redactor that always produces
something will, on the day it cannot find a safe fragment, produce an unsafe one.

**Mutation testing found the hole that mattered.** Replacing the per-term customer SET with
an occurrence count passed all fifteen tests: the "one customer repeating a word" case is
caught by an earlier whole-cluster guard, so nothing exercised the per-term counting — which
IS the privacy property. The added test uses two separate messages from one customer, since
within-message repetition is already collapsed. The first attempt at that test mutated the
wrong thing and passed; the second caught it.

---

## D-047 — Matrix's Stage 4 knowledge base, and four things it corrects

**2026-09-07. Facts from Matrix, relayed by the founder and marked tenant-confirmed.
`scripts/provision/matrix-stage4-kb.sql`, applied to the project.**

Nine `staff_members`, eight `services`, seven `knowledge_documents`, one `contact_points`,
one `out_of_scope_topics`.

**Precisely what that does and does not mean.** Rendering these exact rows through
`renderTenantSections` produces five sections and `hasTenantData` returns **true** — so the
D-033 guard that takes the handoff line before the provider call will not fire for Matrix
once their config is compiled. It has **not** been compiled: `config_revisions` for this
tenant is zero rows and `live_revision_id` is null, so at runtime nothing reads any of this
yet. Rows existing is not the work being done — the distinction this repository has now paid
for three times (D-028, D-029, D-044) — and the compile is a later step, after Stage 3.

### Four corrections, each overturning something this repository had written down

**1. The roster was stale, and the count was wrong by five.** D-038 recorded «of the seven
nicknames asked for, there is one: Оюунаа; the other eight have none». In fact five of the
six active stylists have a short name — Батзаяа/Zaya, Отгонжаргал/Otgoo, Г. Мөнхзаяа/Muugii,
Оюунсүрэн/Оюунаа, Бадамцэцэг/Бадмаа — and Уянга goes by her own name. Corrected in D-038,
`docs/schema.md`, `prompt/drafts/README.md` and `tenant.test.ts`.

D-038's *design* survives the correction and is strengthened by it: an alias table sized to
one nickname would have been rebuilt for five, and the case it could never hold — a customer
who half-remembers a name — is now five times likelier. `0019`'s note on why `short_name` is
deliberately not unique reads better at five than it did at one.

**2. Three of the nine no longer work there, and they are all three of the male stylists.**
Тэргэл is not working; Ананд and Мухлай have left. They are kept as `active=false` rather
than deleted, because a customer asking for Ананд by name is asking about a real person who
has left, and a deleted row cannot be told from a name nobody there has ever had. The
renderer selects `active=true`, so only the six appear in the roster.

**3. The durations answer was wrong.** The earlier «only office colour and perm run over an
hour, so `duration_minutes` stays null on the rest» is superseded: эмчилгээний хими is 1h30
and афро хими is 4–5 hours. A single number goes in `duration_minutes`, a range in
`turnaround_text`, which is what that column exists for.

**4. «CICA эмчилгээний хими» does not exist**, and it was a misreading of their price list.
There is эмчилгээний хими (plant-based, mild) and there is CICA (a separate restorative
treatment, three sessions per course, 3–5 days apart). Had the price list been transcribed
as read, the platform would have offered a service the salon does not sell — the D-020
failure with a different costume, caught by asking rather than by any check in this codebase.

### What was deliberately NOT written, and why each is a blank rather than an omission

- **Prices.** None were given. `allowed_numbers` is built from `service_variants`, and the
  outbound guard refuses any numeral not in it, so an inferred price is the one thing here
  that cannot be quietly wrong. Eight services exist with no variants; the price-list section
  renders empty.
- **`faqs`.** They gave facts, not question/answer pairs. Composing the pairs would put my
  phrasing behind their provenance. The same facts are in `knowledge_documents`, which the
  model reads as context rather than reproduces as a line.
- **`disambiguation_pairs`.** «цаг» belongs here — it is the founder's own example and the
  reason `metrics/clarify.ts` exists — but the QUESTION is customer-visible Mongolian and
  therefore the business's to write (D-046). The row waits for their sentence.
- **`deposit_rules`, `price_axes`, `tenant_booking`.** The 20,000₮/10,000₮ tier deposits and
  the booking URL are evidenced from the ANCESTOR'S production behaviour, not from an answer
  Matrix gave. Evidence from a live bot is not the business confirming a fact, and
  `tenant_booking` has no provenance column in which to record the difference.
- **`staff_members.tier`.** The ancestor prices by Мастер / 1-р зэрэг, but which of the six
  is which was not given.
- **`service_aliases`.** Inventing these is the original D-020 sin. Not repeated.

### The Mongolian in the documents is mine, and that is stated rather than buried

The facts are Matrix's; the sentences around them are my composition. `knowledge_documents`
is prompt context (L3), not a line sent to a customer, so it is outside the review gate that
covers `prompt/platform/*.mn.txt` — which is precisely why it is worth saying out loud that
a native-speaker read belongs before Stage 5 rather than after it.

### One trap the file had to avoid

`kindsReferencedBy` scans the whole compiled prefix for `"lower_snake"` tokens in straight
double quotes and treats each as a canned kind the tenant must have provisioned; a kind with
no row makes `renderCannedSection` refuse and every reply 503. Tenant text therefore uses
«…» throughout. Verified by rendering the real rows and asserting the tenant sections demand
**no** canned kinds.

**Generation still cannot start.** Matrix has zero `canned_responses`, and the platform gate
blocks name kinds the tenant must provision — including `handoff`, without which any refusal
retries for ever. That is Stage 3, it is customer-visible Mongolian, and it is the founder's.

---

## D-048 — the messages half of retention, and why its row survives for a different reason

**2026-09-07. `0021`, extending `ops.purge_expired`. Written and validated; NOT applied —
the founder pushes it.**

`0020` closed `webhook_events` and left `messages.body`, because the instruction named the
`webhook_events` rows specifically. That was reported as a follow-up rather than quietly
widened; this is the follow-up. It matters now because the data changed, not the design:
Matrix's Page is provisioned and routing, so their customers' text lands in `messages` too.

**Everything it needed already existed, and was designed for.** `messages.body_redacted_at`
shipped in `0001`; `redacted_or_present` — `CHECK (body IS NOT NULL OR body_redacted_at IS
NOT NULL)` — refuses a nulled body that does not say it was redacted; and `readHistory`
already skips a redacted row, its own comment reading *"a retention purge must not put a
blank turn in front of the model"*. Only the purge was missing.

### The row survives, but not for `webhook_events`' reason

D-045's floor is **idempotency**: a `webhook_events` row carries the dedup key that stops a
Meta redelivery being answered twice, so deleting it re-opens double-answering a customer.
A `messages` row carries no such guarantee. It survives because `revision_id`, `prompt_hash`
and `answered_by` are how a reply is traced back to the config that produced it, and
deleting would silently change historical counts — the "plausible answer" failure in a
different costume. Same mechanism, two different arguments, and conflating them would make
the next person think the 30-day figure and the 90-day figure are the same kind of number.

### Three counts, kept disjoint

`0021` preserves `0020`'s statement order (delete, then null payloads, then redact bodies)
and adds `bodies_redacted` beside the other two rather than summing. A single total would
hide which of the three stopped working — and D-045 already paid for the lesson that
overlapping counts overstate a run.

### Mutation-tested two ways, and one was caught by the database

A redaction that clears `body` without setting `body_redacted_at` **cannot commit** —
`redacted_or_present` refuses it. The pairing is structurally enforced rather than
remembered by the function, which is why P17 asserts the constraint still exists rather
than only asserting the behaviour: the behaviour is downstream of the constraint.

A redaction that ignores `tenants.message_retention_days` and uses a fixed floor fails
**P16**, which holds a 10-day-old message against a 90-day retention.

---

## D-049 — `sent_at` is an instant, and it was recording an attempt

**2026-09-07, found by reading the live project while answering a different question.**

`buildDeliverDeps` takes one `now: Date`, captured when the QStash job starts, and
`markSent` wrote it as `outbound_messages.sent_at`. Between that instant and the actual
Graph call sit the history read, the model call, the outbound guard and the claim — so
`sent_at` named a moment before the reply text existed.

**Measured on both real sends this platform has made**, against the draft row's own
`created_at`:

| send | `sent_at` | `created_at` (draft inserted) | skew |
|---|---|---|---|
| event 8 | 00:31:59.812 | 00:32:10.974 | **11.2s early** |
| the 19:12 send | 19:12:45.674 | 19:13:01.686 | **16.0s early** |

`created_at` is the draft insert, which happens only once the model has produced the body.
A `sent_at` earlier than that is not approximately right; it is describing a different
event.

### The fix, and why it is a parameter rather than an inline `new Date()`

`clock?: () => Date`, defaulting to the real clock, read **at the moment of use**. Inline
`new Date()` inside `markSent` would be equally correct and untestable, and this repository
injects clocks everywhere for that reason. `now` stays for the things that genuinely
describe the attempt rather than an instant inside it — `recordSecretOk`'s `last_ok_at` is
about this delivery attempt, and moving it would be the same mistake in reverse.

### Why fix it when nothing reads it

Nothing does, today, which is the argument for fixing it now rather than the argument
against. The mirror phase wants reply latency, and every such number would have been 11–16
seconds short with nothing in the data to reveal it — a column that is wrong in a
consistent direction is worse than one that is obviously broken. It is the same shape as
D-044's `purge_after`: a field that looks authoritative and is not.

Mutation-tested both ways: reverting to `now` fails all three checks, and capturing the
clock once at build time — indistinguishable from the bug in any test that sends only once
— fails the second.

## D-050 — a tenant's own rules name canned kinds, and nothing required them

**2026-09-07.** Found by reading the live project while drafting Matrix's children's-services
rule, which is the third time in this repository that reading the database has found
something no test could.

### The hole

`renderCannedSection` refuses when a required kind has no row, and the required list comes
from `kindsReferencedBy(promptStable)` — a scan of the compiled prefix for `"lower_snake"`
in straight double quotes. That finds the nine kinds the signed platform blocks name, and it
is the right mechanism for them: a block added to L0 starts refusing for unprovisioned
tenants without anyone updating a constant.

It cannot find the kinds a **tenant's own rows** name, and both refusal tables carry one:

```
disclosure_rules.response_kind   -> canned_response_kinds(kind)
out_of_scope_topics.response_kind -> canned_response_kinds(kind)
```

A rule's `topic_key` renders into Ш1's list as `- children_services: …`, plain text with no
straight quotes, so the scan never sees it. `response_kind` is not rendered at all. So a
tenant could carry a rule whose sentence did not exist, and the failure was silent in the
worst available way: the gate fires, the gate text tells the model to reproduce the matching
line «нэг ч үсэг өөрчлөхгүйгээр», the line is absent from its context, and the model
improvises — on precisely the topic the business asked never to be discussed. No 503, no
flag, nothing red.

### It was not hypothetical

`scripts/provision/matrix-stage4-kb.sql` — written the previous night, by me — inserted an
`out_of_scope_topics` row for `photo_consultation` pointing at `refusal_out_of_scope`, and
Matrix has no `refusal_out_of_scope` row. It was live in the project for a day. It has not
misled a customer only because Matrix is `shadow_routing` and generates nothing.

That is the same failure shape as D-029's third bug: a reference that resolves in the schema
(the foreign key to `canned_response_kinds` is satisfied — the KIND exists) while the thing
the reference is *for* (a row for THIS tenant) does not. A satisfied constraint is not a
provisioned tenant.

### The fix

`kindsRequiredByRules(rules)` returns the response kinds a tenant's rules point at, and
`handleReception` unions it into the required set. A missing line now refuses with the
existing `canned_response_missing`, before the model is called, costing nothing.

Three choices inside it, each deliberate:

- **Unconfirmed rules count.** D-020's flag records that a rule fired without confirmation;
  it does not stop it firing. A rule that fires needs a sentence to fire into, so excluding
  unconfirmed rows would leave the improvisation case open for exactly the rows nobody has
  checked.
- **A row with an empty `response_kind` requires nothing.** Adding `''` to the required set
  would refuse every reply while naming no kind — a refusal an operator cannot act on.
- **The requirement is structural, not conditional on the matcher firing.** Checked once per
  request against the tenant's whole rule set, like the platform kinds, because "this
  message happened not to trip it" is not a reason to ship a tenant with a hole in it.

### What it costs, and who pays it now

Matrix cannot publish until `refusal_out_of_scope` exists — which is the point. Tenant #0 is
unaffected: it has zero rules, measured, so its required set is unchanged.

Mutation-tested three ways: removing the union, gutting the function, and restricting it to
`tenant_confirmed` rows each fail a test that named the property. A fourth check earned its
keep by NOT being coverage — the "unreviewed line" test passes with the union removed,
because `renderCannedSection`'s unreviewed check runs over every row it is handed rather
than only the required ones. Its comment now says so, because a test that looks like
coverage and is not is how the `WORKER_PUBLIC_URL` contract stayed wrong on both halves.

### The table that rule belongs in

Related, and settled here so the next one is not guessed at. Children's services is
`disclosure_rules` — "we know and will not say" — not `out_of_scope_topics`, which 0001
reserves for "we cannot know". Matrix cuts children's hair and «Чёлк тайралт» is a line in
their price list; they have decided the bot does not quote it. Three things follow:
`quote_price` exists only on `disclosure_rules` and false there means no numeral at all;
`approved_by` records who chose to withhold, and only that table has it; and
`canned_response_kinds.refusal_topic` is described in the database as "bound to a
disclosure_rule". `GATE_BY_RESPONSE_KIND` maps `refusal_topic` to Ш1 — an invented kind
would have fallen through to `DEFAULT_GATE` = Ш8 and answered the handoff line instead.

### And Ш1 was already the children's rule

Worth recording because it changed the size of the job from "write a gate" to "write a row".
`prompt/platform/sh1_refusal_topics.mn.txt` is signed, native-speaker reviewed, and carries
the ancestor's own wrong-example verbatim — «Хүүхдийн чёлк тайралт хэд вэ?» answered «Чёлк
тайралт 33,000₮» — plus the half of the ancestor's rule I had reported as missing: «Том хүн
үү, хүүхэд үү» гэж БҮҮ асуу. `handle.test.ts`'s fixture has carried the matching rule, with
the stems `хүүхэд` and `хүүхд`, since the file was written. The port needed the tenant row
and nothing else.

### The sweep D-050 asked for, and what it did NOT find

The founder's follow-up was the right question: "worth checking whether anything else names
a kind or a target that nothing requires." Swept 2026-09-07, over every column the loader
reads and every identifier `renderTenantSections` prints into the model's context, because
the risk surface is exactly the names the gate tells the model to look up.

**The two `response_kind` columns were the only instances of D-050's shape.** Everything
else that names a cross-row target is either a definition site (a `topic_key`, a
`trigger_term`, an `axis` — nothing to resolve) or is enforced by the database.

The near-miss is worth recording because it nearly became a false finding.
`service_variants.refusal_topic` reads, in the CREATE TABLE, as

```sql
  refusal_topic text,                          -- FK added in §8; required when price_kind='none'
```

— a comment describing two constraints that are not on that line. Both are real and both
are 850 lines further down: a composite FK to `disclosure_rules (tenant_id, topic_key)` and
`check (price_kind <> 'none' or refusal_topic is not null)`. Reading the table definition
alone produces the confident wrong answer, which is the same reading failure the
`WORKER_PUBLIC_URL` note already names — a rule and the code it describes have to be read
together, and here they were 850 lines apart.

**Two softer instances, both with a backstop, neither fixed:**

- `staff_members.tier` → `service_variants.variant_key`. Ш4's «АНХААР» clause sends the
  model from a named stylist to their tier to that tier's price, and nothing requires a
  tier to correspond to any variant. Unlike D-050 this degrades safely: Ш2's rule 2б
  refuses a name that is not in the price list, so the outcome is
  `refusal_price_unlisted`, not an invention. Latent either way — no tenant has a variant.
- `deposit_rules.applies_to` is free text and can name a service the price list does not
  carry. Same backstop, same latency.

**And two columns that are read by nothing at all**, which is the `purge_after` shape
(D-044) rather than this one: `staff_members.affects_price` and
`staff_members.customer_selectable`. The second is worse than merely unread, because
`matrix-stage4-kb.sql` — mine — *writes* it, from `active`, which makes it look like a
provisioning decision somebody made. It is inert. Either give them a reader or say so in a
`comment on column`; do not leave a written column that decides nothing.

The one known-unenforced name is unchanged and already documented: `tenant_channels.app_slug`
against `META_APP_SECRETS`, where §3.3's cross-check cannot currently fail (D-041).

## D-051 — Matrix's configuration is published, and publishing found two bugs

**2026-09-07.** Stage 5. The compile is `content_hash 4d0b4243…`, 12,313 characters, 18
sections, `allowed_numbers` fourteen tokens. It is live on the project: revision seq 1,
`published`, `tenants.live_revision_id` pointing at it, and the stored prefix re-hashes to
the compiled hash.

### Getting there needed a compiler with no caller

`compileStablePrefix` had no production caller — only tests. So "does this tenant's
configuration compile, and what comes out?" could only be answered by publishing, which is
the wrong moment to ask and needs a credential this environment does not have.
`scripts/verify/compile-tenant.ts` answers it offline: a narrow psql-backed adapter for the
handful of client calls the compile makes, then the REAL `loadPromptSections`,
`loadTenantKb`, `renderTenantSections` and `renderStablePrefix` over real rows.

Every shape the adapter does not understand THROWS. An adapter that returned `[]` for a
query it could not translate would look like a tenant with no rows — a state the compiler
is built to tolerate — so the run would pass while testing nothing. That is D-020's failure
with a different subject.

It reaches the database over psql, not PostgREST, because this environment has neither a
PostgREST binary (the release is not reachable through the egress proxy) nor a container
runtime. **That gap is real and it is exactly what `scripts/verify/postgrest.ts` covers.**
Read a pass here as "the compiler works over these rows", never as "the transport works".

### Bug one: every tenant's SECOND publish failed, halfway

`publishRevision` step 3 supersedes the outgoing revision with a bare
`set status = 'superseded'`, leaving `published_at` set, and `published_has_a_time`
demanded `(status = 'published') = (published_at is not null)`. So the UPDATE was refused
for any revision that had ever been live — after steps 1 and 2 had already committed. Two
rows claiming `published`, the pointer on the old one, and `publish.ts`'s own comment
calling that "a state nothing else in the schema can disambiguate".

`0022` widens the CHECK to `(status = 'draft') = (published_at is null)`, which still
refuses a published row with no time and additionally refuses a draft that claims one.
Nulling `published_at` instead would satisfy the old rule and destroy the only record of
when a configuration was live — `rollbackTo` moves the pointer without re-publishing, so
nothing would write it back. `isolation.sql` T12 runs the whole second-publish sequence and
T13 pins the half of the old rule that was right; T12 fails against the pre-`0022`
constraint, measured both ways.

`publish.test.ts` stubs the client and accepts any update, and no tenant had published
twice, so a green suite and a healthy production agreed with each other and with nothing.

### Bug two: I published onto a channel no code asks for

The generated publish wrote `channel = 'messenger'`. `worker/reception.ts` asks
`loadLiveSnapshot` for `'facebook_page'`. The snapshot existed, the revision was published,
the pointer was correct, every hash matched — and every reply would have returned
`no_snapshot`.

It is D-050's shape again, one table further along, and I walked into it while writing the
fix for D-050. The lesson that generalises: **a literal that names a target belongs to the
row that defines the target.** The channel now comes from `tenant_channels.provider`, so
the publish cannot name a channel the tenant does not have.

`config_snapshots` is append-only by TRIGGER — `DELETE`, `UPDATE` and `TRUNCATE` all
denied, which is stronger than the code comment ("no update path") suggests. So the bad row
could not be corrected, only out-appended: the live revision now carries a second snapshot
on `facebook_page`, which is a legal state because snapshots are per-channel and plural by
design. **The `messenger` row is permanent.** It is an orphan nobody reads, and it stays in
the project as a record that this happened.

### What publishing did NOT change

Matrix is `delivery_mode = 'shadow_routing'`, which is `{deliver: false, generate: false}`.
A published configuration generates nothing and sends nothing. The revision is the thing
that would be used the moment the founder flips the mode, and until then it is inert.

## D-052 — the watchdog watched the wrong set, and a timezone audit that found a real one

**2026-09-07.** Matrix ran in `shadow` against a third party's real customer traffic with
nothing watching whether that traffic was still arriving. The founder's question was the
right one: the `not_provisioned` verdict is correct for a channel being set up and wrong for
one that has been deliberately pointed at live traffic, and the difference between those two
states was not recorded anywhere.

### Two independent things hid it, and either alone was enough

`watch.ts` selected `delivery_mode = 'live'`, so a shadow channel was never examined. And
had it been, `assessSilence` computes `since = lastInboundAt ?? liveSince`; a shadow channel
has no `went_live_at` by definition, so `since` was null and the verdict was
`not_configured` → `not_provisioned`, which is recorded and deliberately never paged.

Note what that verdict is NOT about: Matrix's `business_hours` are complete. The failure was
a missing **clock to measure from**, not a missing schedule.

### The distinguishing fact was already named, in a comment

`0012` opens with "when did this channel start expecting traffic?" and then stamps only the
transition into `live`. The comment describes the concept; the trigger implements one case.
That is the third instance of this shape in a week — `WORKER_PUBLIC_URL`'s check, `deps.ts`'s
hardcoded `cacheTtl`, and now this — and the common thread is that each reads as correct
alone. Only the pair reads as wrong.

`0023` adds `expects_traffic_since`, stamped on the first transition into any mode that
expects webhooks. A second column rather than a widened `went_live_at`, by `0012`'s own
argument for not reusing `created_at` or `name_confirmed_at`.

**`shadow_routing` is in the set, on the founder's call, and their reason is better than the
one I gave for leaving it out.** I argued from how the modes had been used — parked versus
deliberate — which is an argument about habit. Theirs is about purpose: proving that routing
works is the entire point of `shadow_routing`, so silence is precisely the fault it exists to
surface. The objection I had (a tenant parked there before its Page is subscribed) was
already answered by machinery that existed: `not_provisioned` is recorded and does not page.

The backfill is `coalesce(went_live_at, now())`. `created_at` was the honest-looking choice
and would have paged on the watchdog's first run, because for Matrix it precedes ~600 open
minutes of parked, unprovisioned time. An alarm that fires the moment it is installed is the
failure this module was written to avoid.

### The audit: two day-key conventions, eight hours apart

The founder asked where else local-time arithmetic is done, after I twice produced a wrong
statement about Ulaanbaatar's clock. Both errors were mine and neither was in the code, but
the question was worth asking and it found something.

**`spend/periods.ts` keys the day on Ulaanbaatar** — deliberately, with a paragraph
explaining that a ceiling rolling over at 08:00 local blends two days' spend. **Four other
sites key it on UTC**, inline, as `now.toISOString().slice(0, 10)`:

| site | boundary |
|---|---|
| `spend/reserve.ts` — the daily ceiling | Ulaanbaatar |
| `health/watch.ts` — silence alert dedup | UTC → **fixed here** |
| `worker/purge.ts` — purge-backlog alert dedup | UTC |
| `worker/reception.ts` — standby alert dedup | UTC |

For the watchdog this had teeth: the UTC day rolls at 08:00 in Ulaanbaatar, an hour before a
salon opens, so a channel silent across a morning raised **two alerts for one trading day**.
That is the "trains the operator to skim past the key" failure the module's own header warns
about, arriving from a third direction. Fixed by threading the tenant's timezone into
`record()` and keying on `tenantClock(now, timezone).date`.

The other two are left, reported rather than changed: they are alert dedup keys in files this
change does not touch, and the same fix applies to both. **Both closed by D-053** the same
evening, along with the per-tenant boundary below.

**And the purge FLOORS are not affected at all**, which is worth stating because it was named
as a suspect. `ops.purge_expired` computes `now() - make_interval(days => …)` — an absolute
duration, no calendar and no local midnight. Only its alert dedup key carries a UTC day.

### The deeper one, reported and not built

`dayKey()` hardcodes `UB_OFFSET_MINUTES = 8 * 60` while `tenants.timezone` is a per-tenant
column. Every tenant's spend ceiling therefore rolls over on Ulaanbaatar's calendar, whatever
their own. Latent today — both tenants are `Asia/Ulaanbaatar` — and it is the platform's
founding test failing in miniature: something that distinguishes one customer from another
is a constant rather than a row. Fixing it moves a boundary the spend ledger is keyed on, so
it is money and it is the founder's. **Approved and built the same evening — D-053.**

---

## D-053 — every tenant's day is their own, and the platform's is not any tenant's

**2026-09-07, approved by the founder** ("It's money, and I'm approving it. Every tenant's
ceiling should roll on their own calendar"), closing D-052's "reported and not built".

`dayKey()` added a hardcoded `8 * 60` minutes while `tenants.timezone` has been a per-tenant
column since `0001`. It now takes a zone, and so does `monthKey`. Both go through
`tenantClock`, which moves to `src/lib/time/clock.ts` — the one place local time is
computed, because a second implementation of "what day is it there" is exactly how two
conventions eight hours apart appeared in the first place.

### What it changes for the two tenants today: nothing, and that is measured

Both `tenants.timezone` values read `Asia/Ulaanbaatar` (the column is NOT NULL). Every
`spend_counters` row on the project — four, `2026-09-06` and `2026-09-07`, two tenant-scoped
and two platform — keeps the key it has. `periods.test.ts` asserts the equivalence rather
than assuming it: the new rule and the old fixed offset agree for **every hour across 400
days** for `Asia/Ulaanbaatar`, because Mongolia has had no daylight saving since 2017. No
counter moves, no row is orphaned, no ceiling resets.

### `Intl`, not an offset

The old arithmetic is right for Mongolia and silently an hour out for half the year in any
zone that shifts — including Mongolia's own 2015–2016 experiment. An hour is the entire
distance between one day's ceiling and the next at midnight. The IANA zone knows; a constant
cannot. An unrecognised zone **throws**, and nothing catches it: on the money path
`withTenantRole` turns that into a 503, and a redelivery costs nothing. A fallback to UTC
would put a tenant's ceiling on the wrong calendar and say so nowhere.

### The trap this had to avoid, and it fails OPEN

`dayTargets` addresses two counters per reservation: the tenant's and the platform's.
Threading the tenant's zone into **both** is the obvious change and it is wrong. Two tenants
in different zones would then open two platform rows for one platform day, and
`PLATFORM_HARD_CAP_USD_PER_DAY` — the single number between a platform-wide bug and the
Anthropic invoice — silently becomes one cap per zone. Nothing reports a number that looks
wrong; the ledger balances; the caps just stop being one cap.

So the platform keys on `PLATFORM_TIMEZONE`, a compiled constant in `config/platform.ts`
alongside the caps themselves, for the reason the caps live there: a day boundary that can
move in a dashboard is a ceiling that can be spent twice. Only tenant-scoped counters follow
the tenant.

### The zone rides on the reservation

`Reservation` carries `timezone`. `reserve`, `release` and `settle` must address the same
counters or the ledger drifts, and a counter's identity **includes its period key** — so the
calendar is part of the address, not a detail of the caller. A `release` that recomputed the
day would credit one row and leave another permanently short, invisible until a ceiling
refused a reply nobody had spent.

### The two remaining UTC keys, now closed

`worker/purge.ts` and `worker/reception.ts` both keyed an alert on `toISOString().slice(0, 10)`.
The purge sweeps every tenant's rows in one run, so its "once a day" is one **platform** day;
the standby alert is about one tenant's channel, so it is the **tenant's**. That put the
tenant read above the standby branch in the worker — an unreadable `tenants` row is now a 503
for a standby entry too, which is the right way round: every other refusal there treats a read
it cannot complete as undetermined.

Both of those tests could not have failed before. Each pinned an instant whose UTC date and
Ulaanbaatar date happen to agree (12:00Z and 03:00Z), so they asserted the convention they
were written under and would have passed under either. Both now use an instant in the
eight-hour window where the two diverge.

### Also read `String(t['timezone'] ?? 'Asia/Ulaanbaatar')` and removed it

Unreachable — the column is NOT NULL — in exactly the way a default is unreachable right up
until a `select` changes. It now refuses with `tenant_timezone_missing`.

---

## D-054 — the FX rate is a Mongolian day, so it is looked up on one

**2026-09-07, approved by the founder** ("fix it with PLATFORM_TIMEZONE as its own change"),
kept separate from D-053 because it moves what a settle **records**.

`settle.ts`'s `currentFx` asked for the newest rate with
`effective_from <= now.toISOString().slice(0, 10)`. `fx_rates.effective_from` is a bare
`date` with no zone and the rate it carries is ₮ per $ — a Mongolian fact about a Mongolian
day. Asked for by the UTC date, a rate published for a given date was **eight hours late**:
from 00:00 to 08:00 in Ulaanbaatar the UTC date is still yesterday, so the previous rate was
snapshotted onto every ledger row written in that window.

The **platform's** calendar, not the tenant's, unlike the counters D-053 moved. A USD→MNT
rate is one fact about one currency pair on one day; a tenant does not have a version of it,
and two tenants settling in the same second must snapshot the same number.

### What it changes for existing rows: nothing, twice over

Measured on the project before applying:

- **`fx_rates` holds exactly one row** — `USD, effective_from 2026-01-01, 3500.0000,
  source planning_assumption`. Every date in 2026 selects it, so both conventions return
  3500 and always have.
- **Both `spend_ledger` rows are inside the divergence window**, which is the part worth
  saying plainly rather than glossing: ids 4 and 5 were settled at `18:57:16Z` and
  `19:13:00Z` on 2026-09-06 — 02:57 and 03:13 on the **7th** in Ulaanbaatar. The old rule
  asked for `2026-09-06` and the new one asks for `2026-09-07`. They are unaffected because
  the rate table has one row from January, **not** because the two dates agree. `cost_mnt`
  stays ₮56.34 and ₮55.50, `fx_mnt_per_usd` stays 3500.
- **And they could not have changed anyway.** `spend_ledger` is append-only by statement
  triggers created `ENABLE ALWAYS`, so they bind `service_role` too. Nothing here restates
  history; this only changes what a future settle writes.

The exposure begins the moment a **second** `fx_rates` row exists. Until then the fix is
free, which is the argument for doing it now rather than the day the first real rate lands.

### Not a ceiling

Every ceiling is in nanoUSD and never reads this figure. `fx_mnt_per_usd` and `cost_mnt` are
the columns D-004's margin is checked against after the fact — which is exactly why being
eight hours stale mattered: a wrong ₮ figure is invisible in operation and only shows up as
a margin that will not reconcile.

### `settle.ts` had no test file until now

It computes what the ledger records and nothing tested it directly. `settle.test.ts` records
the query FILTERS rather than only the rows returned, because the thing under test is a query
parameter — a stub that only answers rows passes under either convention. Four tests: the FX
date, the ₮ snapshot, the refusal when no rate exists, and that the settle addresses the same
counters the reservation charged.

---

## D-055 — a tenant fact with a date in it goes stale silently, and nothing here can notice

**2026-09-07, founder, on reading Matrix's seven knowledge documents.** One sentence was
removed and the prefix republished; the class it belongs to is **reported and deliberately
not built**.

### What was removed

Document 5, «Урамшуулал ба баримт», said:

> Одоогоор эмчилгээний химийн урамшуулал 9 сарын 20 хүртэл үргэлжилж байна.

True until 20 September, false on the 21st, and nothing in this system can tell the
difference. Removed rather than rewritten: «Урамшууллыг зараар зарлана» already covers
promotions and is true indefinitely. Trimming only the digits would leave «Одоогоор …
үргэлжилж байна», which has the same defect one word further in — `одоогоор` is a claim
about *now*, made by a prefix compiled weeks ago.

`scripts/provision/matrix-stage4c-promo-date.sql` applies it, asserting the resulting body
by md5 against the reviewed text. Republished as revision seq 2: **12,239 chars,
`content_hash f68b8f53…`**, and `allowed_numbers` drops from fourteen tokens to twelve —
`9` and `20` appeared nowhere else. `20:00` survives; it is the closing time from
`business_hours`, and the comparison is the digits-only reduction (`20` against `2000`),
deliberately not a substring test.

The publish derived the new prefix **on the project**, by `replace()` over the outgoing
snapshot, rather than sending 12,239 characters of Mongolian through a tool call. That is
safe for one reason and it is worth naming: the real compiler was run locally over the
edited rows and produced `f68b8f53…` independently, and the transaction asserts
`sha256(prompt_stable) = content_hash`. Two derivations agreeing byte for byte is what
makes the shortcut a shortcut rather than a hand-edited artefact.

### The class

**Any tenant fact carrying a date goes stale with no signal.** Not only
`knowledge_documents`: `faqs.answer`, `canned_responses.body`, `deposit_rules.rule_text`
and a service name can all say «9 сарын 20» or «энэ сар». There is no expiry column, no
review date, no trigger, and — the part that matters — **the prefix is frozen at publish
time by design**, because `content_hash` is the prompt-cache key. A fact that expires does
not expire in the prompt; it is still there, word for word, until somebody republishes.

### What making a knowledge document expire would actually take

Five pieces, and the obvious one is the least important:

1. **`valid_until date null` on `knowledge_documents`.** Null means no expiry, which is the
   normal case. The compile drops a document whose `valid_until` is past — evaluated on
   `tenantClock(now, tenants.timezone)` (D-053), never `current_date`, which is the
   server's day.
2. **Dropping it silently is the same failure one layer along.** A document that vanishes
   from the prompt with nothing said about it is exactly what D-020's `unconfirmedNames`
   reporting exists to prevent. An expired document has to be named in the compile's
   report, next to the unconfirmed FAQs.
3. **A compile-time filter alone expires nothing.** The snapshot published on the 1st still
   carries the sentence on the 21st. So expiry needs a **scheduled recompile** — a job that
   recompiles each tenant and republishes only when `content_hash` changes, costing one
   cache write per actual change and nothing otherwise. Evaluating it in the volatile tail
   instead would move the documents out of the cached prefix, which trades ~$5/month per
   tenant for a date; the wrong side of the trade.
4. **A warning before the cliff, not at it.** `valid_until` within N days should raise an
   `alerts` row — dedup keyed per tenant per document per tenant-calendar day — so the
   founder can ask the salon for the new date instead of discovering the fact disappeared.
5. **The half that would actually have caught this row: a detector, not a field.** Nobody
   would have filled in `valid_until` for document 5 — the expiry was in the prose. What
   catches it is a guard, in the shape of `check-mn-review.mjs`: refuse to publish a tenant
   text matching a date pattern (`\d+ сарын \d+`, ISO dates, «хүртэл», «одоогоор», «энэ
   сар») unless `valid_until` is set. It must match date *shapes*, not digits, or it fires
   on «3-5 хоногийн зайтай» and «7741-7777» and gets switched off within a week. And it
   belongs on every tenant-text table at once, or it is D-050's shape again: a rule that
   covers one table while the same defect lives in the next one.

### Parked, on a named trigger

**Not built, and parked by the founder the same evening: revisited when there is a third
tenant.** The immediate risk is gone — the sentence is out of the prompt — and at two
tenants, both hand-provisioned by one person who reads every document, the cost of the
machinery exceeds what it buys.

Two things to carry to whoever picks it up, so the parked design is not rebuilt from the
wrong end:

- **Piece 5 is the valuable half**, and it is the founder's judgement as much as mine. A
  detector on date *shapes* is what would have caught this row; `valid_until` is the piece
  that reads like the answer and is worth least, because the failure was never a column
  left empty — it was a fact nobody knew had an expiry.
- **A third tenant is the trigger for a reason.** At three, documents stop being provisioned
  by the person who read them, and «энэ сар» starts arriving in a batch from somebody who
  will not be the one to notice it aged.

---

## D-056 — the ledger prices a cache write at the tenant's rate, not at a literal

**2026-09-07, founder-requested.** `deps.ts` passed `cacheTtl: '1h'` to `settle` for every
tenant. It happened to be right for Matrix and wrong for anyone on `5m`, whose writes were
billed at **1.6× their rate** — 4000 nanoUSD/token instead of 2500 — in `cost_nanousd`, the
column D-004's margin is checked against. Nothing else in the system would have disagreed.

`buildDeps` already receives `cacheMode`; it now passes it. The value was two lines away
from the literal that replaced it.

### `off` is a third mode, and it is not a rate

`priceCall` took `'5m' | '1h'`, so `off` had no representation and the caller had to invent
one. It now takes `CacheMode` and refuses when a tenant with caching off comes back with
cache-write tokens: no `cache_control` was sent, so a write means the provider and our
configuration disagree about the request that was made, and no rate honestly describes it.
That is `priceCall`'s posture everywhere else — "a spend we cannot price is a spend we
cannot cap".

### `deps.ts` had no test file

The hardcode lived between two well-tested modules and was invisible to both: `settle` has
tests, `reception` has tests, and the join had none. `deps.test.ts` asserts the mode reaches
`cost_nanousd` — 10,000 write tokens land at 29,000,000 nanoUSD on `5m` and 44,000,000 on
`1h`, so the literal cannot come back unnoticed.

---

## D-057 — the transport check could not see writes, and both column checks were under-reading

**2026-09-07, founder-requested**: extend the PostgREST check to `.insert()` and `.update()`
column lists. Doing it found two silent under-reads that had nothing to do with writes.

### The gap as stated

`postgrest.ts` — the only check that speaks the real transport, the layer D-029's third bug
lived in — matched `/\.from\('t'\)\s*\.select\(/`: select lists only, and only when the
select was *adjacent* to the `from`. `query-columns.ts` walked a bounded chain window and
read writes too. Two parsers, two answers, and the transport saw **no writes at all** —
while `worker/reception.ts` carries a hand-written test pinning one insert's `tenant_id`
with the note that omitting it "is a write that every stub accepts and PostgREST rejects".
One site, checked by hand, out of dozens.

They now share one walker (`querysites.ts`). Two implementations of the same reading drifting
apart is this repository's recurring shape — D-026's two orderings, D-053's two calendars.

### Three things the extension exposed, each a check that looked healthier than it was

1. **A shorthand property poisoned a whole payload.** `parseObjectKeys` required `key:`, so
   the bare `surface,` in `spend_ledger`'s insert made all fifteen of its keys unresolvable.
   It sat in the "not statically resolvable" list looking like an honest limitation.
2. **A semicolon inside a comment cut the chain window.** The window was `indexOf(';')`, and
   that same insert carries "…bill to themselves; quality is Dalatech's own process…". The
   window ended after two keys — and `parseObjectKeys` returned those two rather than
   refusing, so the site reported as **checked**. A mutation renaming `cost_nanousd` to
   `cost_nanusd` passed both files. That is the failure mode both were written to remove,
   reintroduced inside the parser.
3. **Comment stripping was not string-aware.** `replace(/\/\/.*$/, '')` reads the `//` in
   `'https://graph.facebook.com'` as a comment and drops every key after it on that line.

Fixed: shorthand keys are keys; the window skips comments and string literals and stops at a
real statement end; an object whose brace never closes returns `null` rather than a partial
list. **Undetermined is a result. A partial answer dressed as a whole one is not.**

### What it now covers

| | before | after |
|---|---|---|
| column references checked against the applied schema | 303 | **337** |
| not statically resolvable | 6 | **1** (one genuine spread) |
| select lists seen by the transport check | 65 | **76** |
| write payloads seen by the transport check | 0 | **36**, 145 columns |

## D-058 — the canned lines move into the cached prefix, and the snapshot says which ones

**2026-09-07, founder-approved and explicitly scoped**: *"build it, with `canned_hash` in the
same PR. The mitigation shipping alongside rather than after is the whole point — two sources
of one fact is the shape we've now been bitten by three times, and a 503 with `canned_stale`
is the right failure."*

### What moved

A tenant's `canned_responses` — Matrix's are ten reviewed Mongolian sentences — were appended
to `promptVolatile` on every request, *after* the cache boundary. That is roughly a thousand
tokens billed at full input rate on every single reply, for text that changes only when an
operator edits a row. They are now rendered into the compiled prefix as an L2 section at
ordinal 4, so they are paid for once per publish and read from cache thereafter.

The prices are in `model_prices`: Sonnet 5 input is 2,000 nanoUSD/token and a cache read is
200 — a tenth. The saving is not the headline number, though. It is that the canned lines are
the *last* per-request text of any size; what remains in the volatile tail is the customer's
message and the conversation, which is what a volatile tail is supposed to be.

### What it costs, and why the mitigation is in the same commit

Once the sentence is in the published prefix it has **two sources**: the snapshot, which is
what the model reads, and the `canned_responses` rows, which is what the deterministic
short-circuit answers from. Edit a row without republishing and one customer is answered from
the new text by the gate while the next is answered from the old text by the model — with
nothing in the data saying which happened to whom.

That is the third time this exact shape has cost something here. D-029: a `messages` row read
as "answered". D-039: a dedup key that could not tell two customers apart. D-053: two day-key
conventions, one platform cap. Every one of them was a second copy of a fact that nobody had
written down as a second copy.

So `config_snapshots.canned_hash` records the identity of the rows the prefix was compiled
from (`0024`), and `handleReception` recomputes it from the live rows on every request. A
mismatch returns **503 `canned_stale`**, which releases the spend hold and leaves the
customer's message in QStash; an operator republishes and the retry answers it. That is
strictly better than either alternative: answering from the rows tells the model to reproduce
a sentence its prefix does not contain, and answering from the prefix silently ignores an
edit the operator has already made.

**At request time, not at publish time**, on the founder's call: nulling `reviewed_at` has to
stop the sentence *now*, not at the next publish. The existing `renderCannedSection`
missing/unreviewed guard stays exactly where it is and runs *first*, so an unreviewed row
still reports as `canned_response_unreviewed` rather than as staleness — the operator's fix
for those two is different, and the log has to say which one it is.

### NULL is a format marker, not a skipped check

A snapshot published before `0024` has a prefix that does not contain the section. Null
therefore means "this prefix predates D-058", and the reply path answers it by appending the
section to the volatile tail exactly as it always did. There is no state in which the check is
skipped, which matters: a skip nobody can see is the failure this repository keeps finding,
and it would have been the easy reading of a nullable column.

That is what makes the rollout safe with no coordination. Deploy and every existing snapshot
keeps working unchanged; republish a tenant and that tenant moves to the cached form and gains
the guard. No backfill, no window, no flag day. A backfill is also *impossible* and should
stay so — `config_snapshots` is append-only by an `ENABLE ALWAYS` trigger that binds
`service_role` too, so a hash could only be written onto an old row by claiming its prefix
contains text that it does not. `catalog.sql` V33 asserts the column exists, that it is
nullable, and that the table is still append-only, so those two facts cannot drift apart.

### The two renderers are one function

`cannedSectionBody` is called by both the publish path and the request path. Two renderers
would drift — and here a drift of one trailing space would 503 every reply on every
republished tenant, with the symptom pointing at the guard rather than at the renderers. Same
argument as D-057's one walker and D-026's one ordering.

The hash is taken over the **rows as rendered**, not over the section as it landed in the
prefix. A tenant with no canned rows produces no section at all (`section()` drops an empty
one), so hashing the landed section would give `''` at publish and a real digest at request,
and every reply would report as stale for ever. Hashing the same function's output on both
sides makes the empty case agree with itself.

The two sides must also *select* the same rows. `sections.ts` reads every locale and filters
in JavaScript against `tenants.default_locale`; `reception/load.ts` filters in SQL with
`.eq('locale', …)` against the same setting. Different mechanisms, same set — asserted by a
test that puts an English row beside the Mongolian ones and checks it reaches neither the
prefix nor the hash. If those two ever diverge the guard fires permanently and correctly, and
says so.

### What the founder has to do

`0024` needs pushing through the CLI (D-012), and **both tenants need recompiling and
republishing afterwards** — the prefix gains a section, so `content_hash` changes for both.
Until that republish they stay on the null-hash path, which is the pre-D-058 behaviour and
costs exactly what it costs today.

### D-058 addendum — the canned lines nearly disarmed D-033

Found on 2026-09-07 while preparing the republish, before either tenant was republished.

`renderTenantSections` returns `[]` for a tenant with no rows, which is what makes
`hasTenantData` false and what makes `handleReception` take the handoff line before the
provider call (D-033). Moving the canned lines into the prefix gave every tenant a rendered
section, so `sections.length === 0` stopped being reachable: the data marker became
unconditional and the guard became dead code.

**Canned responses are refusal boilerplate, not a knowledge base.** Every one of Ш0 to Ш9
ends "write the such-and-such line from «БЭЛЭН ХАРИУЛТ»", so a tenant has them from the day
it is provisioned — which is precisely the state D-033's guard exists for. Counting them as
data would have disarmed it for client #3 on day one, not just for tenant #0.

Measured rather than reasoned: tenant #0 today is nine canned rows and nothing else, and its
live prefix is the twelve gate blocks with no marker. Its next publish would have emitted the
marker, flipped `hasTenantData` to true, and put it back to answering a customer as a beauty
salon — D-033 restored by a change about prompt caching, and visible only on republish.

The fix is one filter: the marker is decided on the non-canned sections. The canned section
still renders, because it is machinery the gate points at by name and a tenant that ever does
reach the model should have the sentences it is told to reproduce.

Two things are worth carrying forward from how this was found. It was not found by a test —
it was found by reading tenant #0's live prefix and noticing it had exactly one section
header. And the guard it broke was the mitigation for the worst thing this platform has
done, weakened by a change whose subject was cost.

### D-058 — the republish, as performed

Both tenants were republished on 2026-09-07, after `0024` was pushed and after the addendum
above was fixed.

| | tenant #0 `dalatech` | Matrix `matrix-eco-salon` |
|---|---|---|
| revision | seq 1 → **seq 2** | seq 2 → **seq 3** |
| `prompt_chars` | 9,265 → **10,337** | 12,239 → **13,745** |
| `content_hash` | `8b35d072…` → **`f207a19c…`** | `f68b8f53…` → **`52426e45…`** |
| `canned_hash` | null → **`682604d3…`** | null → **`eb27de84…`** |
| canned rows | 9, 1,070 chars | 11, 1,504 chars |
| `allowed_numbers` | `[]`, unchanged | twelve tokens, unchanged |
| data marker | absent, and must stay absent | present, and must stay present |

Both character counts are the old prefix plus a blank-line separator plus the canned block,
to the character. `allowed_numbers` is unchanged for both because tenant #0's canned lines
carry no numeral at all and Matrix's carry only `7741-7777`, which the founder had already
approved — checked with the real `extractNumerals`, not by eye.

**How it was done, and why not with the compiler.** `compileAndPublish` needs a service-role
key this environment does not have and must never ask for. The alternative used before (D-051)
is to derive the new prefix ON the project from the stored one, so the 12,239 Mongolian
characters that are not changing are never retyped. The canned block was rebuilt in SQL from
`canned_responses` — `string_agg(… order by kind collate "C")`, C so the sort is by code point
and agrees with JavaScript (D-026) — and spliced in at one place.

Four things made that safe, and they are the reusable part:

1. **The block's bytes were checked against the compiler.** The SQL-built section and
   `cannedSectionBody` in TypeScript produce the same sha256 — two implementations, same
   bytes. The transcription used to check this was wrong on the first attempt (one dropped
   space, 1,503 chars against 1,504) and the hash caught it immediately.
2. **The splice was checked by its exact inverse.** `replace(new, block, '') = old` fails if
   anything else moved.
3. **The position is a property of the compiler, not of one tenant.** The canned section is
   L2/4, so it sorts after every other L2 and before every L3; `tenant.test.ts` pins that,
   because a spliced prefix and a recompiled one must agree byte for byte.
4. **The invariants were asserted after the write, inside the same transaction.** Stored
   prefix re-hashes to `content_hash`; the canned section is in the prefix and named by
   `canned_hash`, or in neither; the live revision has a snapshot on the tenant's own
   channel; and the data marker is absent for tenant #0 and present for Matrix.

Afterwards: one published revision per tenant, both live, no leftover drafts, every older
revision superseded with its `published_at` intact.

**One trap in this route, checked and recorded rather than left latent.** `cannedSectionBody`
trims each row with JavaScript's `String.prototype.trim()`, which strips every Unicode
whitespace character; the SQL used `btrim()`, which strips only U+0020. A canned body with a
trailing tab or newline would therefore hash one way at publish and the other way at request,
and **every reply would 503 with `canned_stale`** — a total outage produced by a guard working
exactly as designed, on a difference nobody would look for.

Measured before relying on it: no canned row on either tenant carries leading or trailing
whitespace of any kind, so the two trims cannot disagree today. The next hand-written publish
must either re-check that, or trim with `regexp_replace(body, '^\s+|\s+$', '', 'g')` rather
than `btrim`. The real answer is that a publish should go through `compileAndPublish`, which
uses the same `.trim()` as the request path; this route exists only because that needs a
service-role key this environment does not have.


## D-059 — publishing goes through the code the reply path reads

**2026-09-07, founder-requested**, after the D-058 republish exposed how much of a publish
was a second implementation: *"I'd rather publish through the code path the request path uses
than maintain a second implementation in SQL."*

### What was wrong with the old route

`compileAndPublish` needs a service-role key, and no environment that had one could run it —
so every publish since D-051 was hand-written SQL that rebuilt the compiler's output in
another language. Each one was checked hard: hashes compared against the TypeScript renderer,
splices verified by their exact inverse, invariants re-asserted inside the transaction. And it
still carried a live trap. `btrim()` strips only U+0020; `String.prototype.trim()` strips every
Unicode whitespace character. A canned body with a trailing tab would have hashed one way at
publish and the other at request, and every reply would have 503'd with `canned_stale`. It was
clean by luck, not by construction.

That is this repository's whole catalogue in one line: two orderings (D-026), two calendars
(D-053), two parsers (D-057), two sources of one canned line (D-058). A second implementation
of a thing the request path reads is the failure mode, not the mitigation.

### The command

`scripts/publish/tenant.ts`, the same shape as `scripts/kek/seal.ts` — an owner runs it from
their own shell with the key in the environment.

    NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_PUBLISH=… \
      node scripts/publish/tenant.ts --slug matrix-eco-salon            # dry run
    … node scripts/publish/tenant.ts --slug matrix-eco-salon --publish  # apply

Four properties it has on purpose:

1. **Dry run by default.** The compiled prefix is the prompt-cache key and the text a customer
   is answered from, so what would change has to be readable before anything moves. `--publish`
   is the only way to write.
2. **`allowed_numbers` is printed as a DIFF, not a list.** A number appearing there is a number
   the bot may from now on say out loud, and a list of twelve tokens does not make that visible.
3. **D-033 is stated, not left to be noticed.** The output says when the data marker is absent
   (this tenant takes the handoff line and never reaches the model) and, louder, when it appears
   for the first time (this tenant stops taking it). That transition is a change of product and
   should never be something a reader has to infer from a hash.
4. **It reads back through `loadLiveSnapshot`.** The evidence that a publish happened is the
   reply path being able to see it — not an insert returning without error. D-029's lesson,
   applied to publishing.

The draft revision is created inside the run, after every read, so a compile that refuses
cannot leave one behind.

### The key is its own name

`SUPABASE_SECRET_PUBLISH`, not a reuse of the worker's, for the reason at the top of
`supabase/clients.ts`: these keys carry BYPASSRLS, so a leak is every tenant's data at once,
and the only thing bounding the blast radius is revoking exactly the surface that leaked. "The
laptop I ran a publish from" is a different surface from "the queue worker". It is documented
in `.env.example` and deliberately absent from `preflight.ts`'s required set — no deployed code
path reads it, and a deploy must not fail for the want of a key nothing serving a request needs.

### And its queries are checked

`scripts/publish/` joins `src/` in `CHECKED_ROOTS`, so `query-columns.ts` and `postgrest.ts`
walk it too: 354 column references across 120 sites now, up from 343 across 115. It is the only
thing outside `src/` that speaks PostgREST to the real project, and a select naming a column the
database does not have would otherwise fail at an operator's shell in the middle of a publish.
The set stays narrow — `scripts/verify/` talks to a scratch cluster over psql and is not
PostgREST at all — and a test pins both halves.

### Confirmed against the project, and when

The founder ran the dry run against Matrix on 2026-09-07. It reported the compiled prefix
**byte-identical to the live snapshot** — `content_hash 52426e45…`, `canned_hash eb27de84…`,
19 sections, 13,745 chars, `allowed_numbers` unchanged — and exited without writing. So the
real compiler and the hand-written SQL republish of the same evening agree exactly, and the
command works end to end.

**The timing is the lesson, not the agreement.** That cross-check was possible only after the
command existed; the SQL publish went out on its own internal checks — hashes compared against
the TypeScript renderer, splices inverted, invariants re-asserted in the transaction — and was
confirmed hours later by a compiler run that could as easily have disagreed. It happened to be
right. **A publish that does not go through `compileAndPublish` is not trusted until something
independent reproduces its `content_hash`, and that reproduction belongs before the write.**
With this command there is nothing left to reproduce, which is the point.

One practical note from that first run: it failed on a missing package before reaching any of
its own logic, because the tree had no `node_modules`. Every script here imports from `src/`,
so `npm install` comes first or the failure you read is not the failure you have.

### What this does not do

It does not remove the founder from the loop, and is not meant to. Publishing stays an owner
action taken deliberately with a key that lives in one person's shell. What changes is that the
action now runs the same renderer, the same ordering, the same trim and the same hash as the
code that answers a customer.

## D-060 — the watchdog's healthy verdict claimed receipts it had never had

**2026-09-08, found by the 03:00 UTC Matrix check-in** — the routine the founder scheduled
to read the first routed event. There was no first routed event to read; this is what the
check-in found instead.

### What it said, and what was true

At 03:00:02 UTC, 1.0h into Matrix's first watched trading day, `channel_health` recorded:

    matrix-eco-salon   healthy   "webhooks and messages both within 3.0h of open time"

Matrix's `last_webhook_at` is **null**. It has zero `webhook_events`, zero `messages`, zero
conversations. It has never received a webhook in its life, and the row said both streams
were inside the window.

**The decision was right and the sentence was false.** `assessSilence` measures open minutes
since `lastInboundAt ?? liveSince`; with both webhook clocks empty it measured from
`expects_traffic_since` and found 1.0h of open time, under the 180-minute threshold. Not
alerting after one hour is correct — alerting would be noise on every channel's first
morning. The `ok` verdict then reached a `reason` string that describes the *other* case.

### Why that specific lie is expensive

`SilenceVerdict`'s own comment names both states in one line — *"Traffic is arriving, or the
business simply has not been open long enough to tell"* — and then the type carried no way to
tell them apart, because `everReceived` was on `silent` and not on `ok`.

The second state is the **pre-failure state of the bug this whole module exists for**. The
`silent` branch has exactly the right words for it — *"this channel has NEVER received a
webhook … the app-level field subscription probably never worked"* — and that branch is
unreachable until the threshold is crossed. For the first three open hours, the window in
which an operator is actually watching a cutover, the watchdog says the subscription is fine.

That is the D-020 shape once more: a source answering plausibly instead of admitting it
cannot see. And it is the emptiness-guard shape from D-058's addendum inverted — there a
guard could not fire; here it fires correctly and reports the wrong reason.

### The fix

`everReceived` is carried on `ok` too, and `diagnoseChannel` splits the healthy branch:

* both streams really seen inside the threshold → `webhooks and messages both within 3.0h of
  open time`, unchanged.
* nothing ever received → `state: 'healthy'`, **`everReceived: false`**, and
  `nothing received yet, and only 1.0h of open time so far — under the 3.0h threshold, so
  too early to tell`.

Still `healthy`, so still no alert: the change is to what a reader is told, not to when the
watchdog pages. Three tests pin it, including the half-received case (webhooks seen, no
message ever), which is where the standby trap begins and which is below the threshold for
its first three open hours.

### What the same check-in established about the subscription

Two real deliveries from Matrix's Page (`entry_id 1520409424715591`) reached our callback at
01:12 UTC on 2026-09-07, recorded `routing: unrouted` — correctly, because the Matrix
`tenant_channels` row was not created until 01:23:40, eleven minutes later. **So Meta does
deliver Matrix's Page traffic to this platform.** The subscription works; those two were
early, not misrouted. Their raw payloads have since been purged under the 1-day floor for
unrouted events, which is the retention policy behaving as designed.

## D-061 — the watchdog could not see the deliveries that disproved its own diagnosis

**2026-09-12.** Matrix has been alerting `channel.no_webhooks` at critical severity once a
day since 2026-09-08 06:00 UTC — five consecutive days, all delivered — with this body:

    Page 1520409424715591: this channel has NEVER received a webhook (at least 3.1h of
    open time with nothing, since 2026-09-07T18:02:54.404Z) — the app-level field
    subscription probably never worked

The alert firing at all is D-060's branch working exactly as designed: five trading days of
open time with nothing, from a channel pointed at live traffic. That part is right, and the
silence is real.

**The remedy it names is wrong, and the evidence against it was in the same table.**
`webhook_events` holds two rows with `entry_id 1520409424715591` — Matrix's own Page — from
01:12 UTC on 2026-09-07, `routing: 'unrouted'`. They were unrouted correctly: the Matrix
`tenant_channels` row was not created until 01:23:40, eleven minutes later. Meta was
delivering for that Page. The field subscription worked.

### Why it could not see them

`watch.ts` reads the channel's webhook history as

    .eq('tenant_id', tenantId).eq('channel_id', channelId)

and an unrouted row carries **both of those as null**. So the query cannot return an
unrouted event — by construction, not by oversight. `last_webhook_at` is derived from the
same read, so it stays null too, and `everReceived` is false all the way down to a sentence
about a subscription that is fine.

An operator following that sentence goes to the App Dashboard and re-subscribes a Page that
is already subscribed. The real fault — deliveries arriving for this Page that nothing
attributes to this channel — is never named, and it is the one that has a fix.

This is the repository's recurring shape at its sharpest: not a check that fails to fire,
but one that fires correctly and points at the wrong screen. D-029's third bug was a name
resolved against the wrong schema; D-057's parser answered with the part it managed; this
one answers confidently from a query that is structurally blind to the disproving case.

### The fix

The watch asks a second question — newest `webhook_events` row with `entry_id` = this
channel's `external_id` and `tenant_id is null` — and passes it to `diagnoseChannel` as
`unattributedWebhookAt`. When it is non-null the never-received branch says instead:

    no webhook has ever been attributed to this channel, but a delivery naming Page
    1520409424715591 arrived at 2026-09-07T01:12:34.724Z and could not be routed —
    Meta IS delivering, so this is channel identity, not the subscription

Still `no_webhooks`, still critical, still alerting: the silence is real either way. What
changes is the screen the operator opens.

Both halves are tested, including that a channel with no such delivery keeps the original
sentence, because the subscription genuinely is the first thing to check then. The query
shape is pinned on its FILTERS rather than on a verdict — one that forgot
`.is('tenant_id', null)` would match routed rows and report every channel as delivering.

### A second-order note worth keeping

Adding the read made `webhook_events` the third query of a run that a test stub answered
positionally, so the stranded sweep silently received the row meant for the watch and
reported nothing. The test caught it on a count. The stub's own docstring said "read twice
in one run" and was two minutes out of date — the same comment-and-code drift this
repository keeps finding, this time in the test harness.

---

## D-062 — both channels stopped in the same hour, and the one screen that would have said why had never been read

**2026-09-14, after the founder acted on eleven days of the silence watchdog.** Diagnosis
only; the remedy is a Graph read the founder must run, and it is at the bottom.

### What stopped, and when

Every delivery this platform has ever received is in one table, and it is seven rows:

| id | received_at (UTC) | Page | routing | HMAC matched |
|---|---|---|---|---|
| 1 | 2026-09-06 01:17:28 | 863503883522801 (tenant #0) | routed | `dalatech` |
| 4 | 2026-09-06 02:29:06 | 863503883522801 | routed | `dalatech` |
| 6 | 2026-09-06 18:56:59 | 863503883522801 | routed | `dalatech` |
| 7 | 2026-09-06 19:12:44 | 863503883522801 | routed | `dalatech` |
| 8 | 2026-09-07 00:31:58 | 863503883522801 | routed | `dalatech` |
| 9 | 2026-09-07 01:12:10 | 1520409424715591 (Matrix) | unrouted | `dalatech` |
| 10 | 2026-09-07 01:12:34 | 1520409424715591 | unrouted | `dalatech` |

Nothing since. Not one row, not one request, for either Page.

**The last column is the finding.** `matchedAppSlug` is the slug whose *secret verified the
HMAC*, not the slug in the URL — `verifyMetaSignature` tries every configured secret and
reports which one matched. All seven matched the same one. Both Pages were delivering
through a **single** Meta app, and both stopped within forty-one minutes of each other.
One app, two Pages, one instant. That is one cause at the app level, not two coincidences.

### What it is not

Three things were suspected and each is now ruled out by measurement rather than by
argument.

**Not the endpoint.** `GET https://api.dalatech.online/api/webhooks/meta/dalatech` answered
`403 {"error":"webhook.verify_failed"}` on 2026-09-14 at 02:18 UTC, with
`x-matched-path: /api/webhooks/meta/[app]`. That is our own route refusing a probe with no
verify token — the endpoint is up, public, and correct.

**Not Vercel Authentication.** The project protects `all_except_custom_domains`, which made
this the leading hypothesis: every `*.vercel.app` host is behind a login wall and a
redirect to `vercel.com/sso-api` would produce exactly what we see — no invocation, no
error, no log line. The probe above falsifies it for the host that matters. STATUS.md §
"Done — the whole environment" already recorded that `api.dalatech.online` was added on
2026-09-05 *because* of that trap, and deliveries then ran for two more days. The
protection is real; it is not in front of this URL.

**Not Meta, and not Matrix's Page.** The ancestor's Vercel project logged **seven**
`/api/messenger` hits in the 24 hours to 2026-09-14 02:00 UTC. Matrix's Page is receiving
webhooks right now, on the app whose callback is the ancestor. Meta is delivering; it is
not delivering *here*.

**And the absence is real, not an artefact of where we looked.** The 02:18 probe appeared in
Vercel's runtime logs 40 seconds later, as `GET /api/webhooks/meta/dalatech 403`. So that
path does produce log lines, including for requests the route itself rejects — and the
grouped 24-hour counts (`/api/workers/purge` 24, `/api/workers/health` 24, the webhook path
0) mean zero requests arrived, not zero requests were recorded. QStash reaches this
deployment hourly on the same host. Meta reaches it never.

### What is left, and why it cannot be settled from here

The fault is on that Meta app: either its **app-level webhook subscription** (the callback
URL, or the `messages` field on the `page` object) or its **Page grants**. Both produce
precisely this signature — every Page at once, no error anywhere, no request.

`developers.facebook.com` is blocked by this environment's egress proxy, so no session can
open the App Dashboard. **Everything past this point is inference and is labelled as such.**

The most probable single cause, and the repository already names the mechanism: **a
replacement presented as an addition.** D-043 records the App Dashboard's *Add Page* picker
writing the **complete set** of Pages granted to an app, so a Page not re-selected is
revoked and its subscription dies silently — it cost Matrix's live bot ten minutes on
2026-09-06. §3.13.1 records the same shape for the webhook field list. Those two are the
only writes in §3 that behave that way, and *both* of them fail exactly like this. The last
delivery is stamped minutes after Matrix's Page was granted to the app, which is itself a
picker write against that app's Page set.

That is a hypothesis with a motive and a timestamp, not a conclusion. It is not the only
one: the callback URL could have been edited, or Meta could have disabled the subscription
after the 500s of 2026-09-06 (D-028). All three are read by the same call.

### Why eleven days

Two blind spots, both ours.

**Nothing has ever read the app-level subscription.** §3.10.5 step 2 —
`GET /{app-id}/subscriptions` with an app access token — was designed, argued for at length
against exactly this failure, and never built. It is the only check that can see it:
`POST /{page-id}/subscribed_apps` returns `{"success": true}` when the app has never
enabled the field on the object, and the page-level read then agrees with the tenant config
and reports healthy. The one instrument that could have answered this in September was a
paragraph in a design document.

**And the watchdog, which did notice, pointed away from it.** D-061 taught the
never-received branch to read an `unrouted` delivery naming this Page as proof Meta is
delivering. It did not ask *when*. Matrix's two unattributed deliveries are stamped 01:12 on
2026-09-07; the channel's `expects_traffic_since` is 18:02 the same day. So for eleven days
the alert read a row from **before the window opened** as present-tense evidence and said:

    Meta IS delivering, so this is channel identity, not the subscription

— while the truth was that the app had stopped delivering anything at all. `webhook_events`
is append-only, so that row is permanent: the sentence would have read the same on day
fifty. D-061 fixed a verdict that could not see a disproving row by making it visible; it
then trusted the row without bounding it. **The bound is now the verdict's own window** — a
delivery is evidence about this silence when it falls inside the silence, and history
otherwise. History is still printed, because a Page Meta demonstrably knew about once is a
different starting point from one that has never appeared; it just no longer chooses the
remedy.

This is D-060's shape a third time. Each fix split one sentence that was covering two
states, and each time the split left a *new* pair collapsed one branch over.

### A third thing, which is data rather than code

**Tenant #0 is not being watched at all.** Its verdict every run is `not_provisioned` — "no
usable business_hours row for 2026-09-14" — so `diagnoseChannel` returns before it can
measure anything. That is the deliberate design (a provisioning gap is not an outage) doing
exactly what it was built to do, and the consequence is that the only `live` channel on the
platform went silent for eleven days and the watchdog never said a word about it. Matrix's
silence is what the founder saw; tenant #0's was invisible. **Entering tenant #0's
`business_hours` rows turns the watchdog on for it**, and that is a form to fill in, not a
code change.

### The fix that shipped

`scripts/diagnose/meta-subscription.ts`, read-only, same shape as the seal and publish
commands — the secret comes from `META_APP_SECRETS` in the environment and never from an
argument, and the app **id** is a flag because it is public:

```
META_APP_SECRETS='{"dalatech":"…"}' \
  node scripts/diagnose/meta-subscription.ts \
    --app-id 1562862634970492 --app-id 1380702870025418
```

It prints, per app: the callback URL Meta currently holds, `active`, and the field list —
so a revoked field, an edited callback and a disabled subscription are all visible in one
read. It issues GETs and nothing else; neither of the two dangerous writes is reachable
from it.

**It settles D-041 as a by-product.** An app access token is literally
`{app-id}|{app-secret}`, so a secret authenticates only against the app it belongs to.
Running our one slug against both candidate ids is Meta answering which real app
`META_APP_SECRETS["dalatech"]` names — from Meta, rather than from a document that has been
wrong about this before.

It does **not** read the page-level half, which needs a Page token, and it says so in its
own output rather than leaving a green run to be misread. A Page can be granted to an app
and still deliver nothing if the app-level field is off; an app-level field can be on and
deliver nothing if the Page grant was revoked. Both halves, every time.

### What was deliberately not touched

The alert. The founder's instruction was explicit — *it was the only thing that noticed* —
and nothing here changes when it fires, what it dedups on, or its threshold. What changed
is one sentence it prints, from a claim that was false to one that is true.

---

## D-063 — an alert says where it goes and whether it may speak again

**2026-09-14, on the founder's instruction after the eleven days of D-062.** The words that
set the requirement: *I'm getting the same health alert every day and it's training me to
ignore Telegram.*

### The measurement

`alerts` held eleven rows. Ten of them were one condition.

| kind | severity | fired | span | delivered |
|---|---|---|---|---|
| `channel.no_webhooks` | critical | 7 | 2026-09-08 → 2026-09-13 | 6 |
| `channel.unknown` | warn | 1 | 2026-09-06 | 1 |
| `secret.undecryptable` | critical | 1 | 2026-09-06 | 1 |
| `webhook.stranded_event` | critical | 1 | 2026-09-06 | 1 |

So this was never "alerting is chatty". It was **one dedup-key shape**:
`channel_silence:{channel}:{state}:{localDate}`, where the date made tomorrow a new alert
about yesterday's unchanged fact. Everything else in the table had fired once and stopped.

The cost is not just annoyance, and the founder named that too: the same Telegram chat
carries `dalatech-online`'s demo-request notifications — `api/demo-request.js`, outside this
repository, nothing here to build. A health alarm nobody reads is burying the only messages
with a customer on the other end.

### The shape of the mistake, because it is one this repo has made before in both directions

The dated key was itself a fix. `spend/periods.ts` had argued that a period belongs in a
dedup key, so a ceiling reached again tomorrow is a new ceiling rather than suppressed for
ever — which is right, for a ceiling. The watchdog copied it. Then the day was moved from
UTC to the tenant's clock, because a channel silent across a Ulaanbaatar morning raised two
alerts for one trading day (the UTC day rolls at 08:00 local, an hour before a salon opens).

**That correction was right about the boundary and wrong about there being a boundary.** A
ceiling and a dead channel are different kinds of fact: one recurs, the other persists. The
key had been tuned twice without anybody asking which kind it was describing.

### Two axes, because they were one

`route` — how the FIRST notification is delivered. `now` sends Telegram immediately, which
is what every alert does today; `digest` records the row and says nothing until 09:00.

`repeat_policy` — whether the condition may raise another row at all.

- `once` — one alert ever for this key.
- `on_change` — one alert per **unresolved episode**. A condition that holds is silent; one
  that clears and returns speaks again, because the first episode is resolved.
- `daily` — today's behaviour, kept for the cases where each day genuinely is a new fact.
  The caller puts the period in the key, as `spendDedupKey` does.

Both default to today's values (`now`, `daily`), so a call site nobody has touched is
unchanged. The watchdog is the only caller that moves, to `now` + `on_change`.

### The distinction that makes the rest coherent: episodes and events

`on_change` rows are **episodes** — they open, hold, and resolve, and `resolved_at` is what
"open" means. `once` and `daily` rows are **events**: a stranded message, a recovery, an
erasure request. It happened, it was sent, it is over, and nothing will ever resolve it.

That is why both the digest and the re-escalation sweep filter on `repeat_policy` and not
merely on `resolved_at is null`. Without it, "open" would mean "every alert ever raised" and
the digest would grow without bound — **the daily repeat again, wearing the fix's clothes.**

### The digest, and why it sends on a clean day

One message a day at 09:00 Ulaanbaatar, before the salon opens, listing what is currently
open and how long it has been. It is a summary, never an alarm, and it always arrives at the
same moment, so it cannot be mistaken for a new event.

**It sends even when nothing is open**, and that is deliberate. A digest that stays silent on
a clean day makes silence mean two things — "nothing is wrong" and "the digest stopped
running" — which is exactly the conflation D-060 and D-062 were about, rebuilt one layer up
inside the mechanism meant to be the safety net. So the clean line carries proof of life:
when the silence watchdog last actually ran, read from `channel_health.observed_at`, which is
upserted on every run including healthy ones precisely so its absence is a statement. If the
watchdog has stopped, the clean digest is what says so.

One line a day is not what trained anybody to ignore Telegram. Six criticals about one
unchanged condition were.

### Re-escalation, three days, on the founder's call

`on_change` creates the opposite failure of the daily repeat: a condition alerts once, goes
quiet, and three weeks later nobody can tell it from one that never happened. An open
`critical` nobody has been paged about for three days therefore gets its **own** `now`
message, outside the digest — buried in a summary it would read as more of the same.

`notified_at` is what makes that an UPDATE rather than a second row with a dated key, which
would undo the whole change. `coalesce(notified_at, at)` is "when was a human last told",
null-safe for a digest-routed row nobody has been paged about — reading null as "recently
told" would mean a digest-routed critical never escalates at all. It is deliberately NOT
`delivered`, which answers whether one Telegram call succeeded; conflating "accepted for
delivery" with "delivered" is a scar from next door.

Warns never escalate. A standing warn belongs in the digest and nowhere else, or the
escalation becomes the new daily repeat.

### Recovery is said out loud

Closing an episode silently would mean an operator paged about a dead channel is never told
it came back — and cannot tell that from an alarm that quietly stopped working, which is
D-062's whole subject arriving inside the fix for it. So the watchdog raises
`channel.recovered` (`info`, `once`, keyed on the episode id it closes, so it is
unrepeatable by construction rather than by a period).

Two cases that look like recovery and are not:

- **A provisioning gap does not resolve an episode.** Losing the ability to measure a
  channel is no evidence the channel is well. If `not_provisioned` resolved, deleting a
  `business_hours` row would silence a real outage — the watchdog acquiring the defect it
  exists to detect, by way of a data-entry mistake.
- **A degrade supersedes rather than accumulates.** The state is in the key, so a channel
  moving `no_messages` → `no_webhooks` opens a second episode; the first is closed by prefix
  so the digest cannot list one channel twice with one entry naming a fault it no longer has.

### Deploy order, and it is the D-058 trap exactly

`raiseAlert` writes `route` and `repeat_policy` on **every** insert. Against a project
without `0025`, PostgREST answers that insert with a 400 and **every alert in the platform is
lost, silently** — the alerting path has no caller that checks its return. CI applies every
migration in the repo before running, so the whole suite is structurally incapable of seeing
it. **Merge only after the founder has pushed `0025` and the ledger has been read.**

### What this does not touch

The demo-request path, which is `dalatech-online`'s and reaches Telegram directly. Nothing
in this repository produces or routes it; the only thing that changes for it is that it
stops competing with six criticals a week.

---


### Addendum, measured the same day: a backfill default decides which rows the new rule can ever reach

Matrix's channel recovered at **06:00:04 UTC on 2026-09-14** — `channel_health` reads
`healthy`, "webhooks and messages both within 3.0h of open time", after eleven days dead.
Telegram said nothing, and could not have.

The ten `channel.no_webhooks` rows recording that outage predate `0025`, so the migration's
`repeat_policy` default stamped them **`daily`**. Under the split this file just introduced
that makes them *events*, and `resolveOpenAlerts` filters on `repeat_policy = 'on_change'`.
There is no open episode to close, so no `channel.recovered` was raised — for the one
condition the whole split was built around.

Nothing here is broken. Going forward `watch.ts` writes `on_change` and the recovery notice
works; the digest and the escalation correctly ignore the ten rows rather than re-escalating
eleven days of noise, which is the outcome we wanted. The gap is one-time and historical.

The lesson is not one-time. **A migration that adds a discriminator column with a default is
deciding, retroactively, which semantics apply to every row already in the table — and the
rows already in the table are exactly the ones that motivated the change.** `'daily'` was the
conservative default, correct in general because you cannot know what an arbitrary old row
meant. Nobody asked what the *live* ones meant, and there were only eleven rows to look at.

What was NOT done, deliberately: the rows were not retyped to `on_change` to manufacture the
missing notice. That is a write to `alerts` — adjacent to the one instrument the founder said
not to touch — and retyping all ten would send ten recovery messages, which is the daily
repeat wearing the fix's clothes one more time. The recovery is reported by hand instead,
once, which is what a person would have done anyway.

Related, and the same shape at the outermost layer: **the first digest could not fire.**
The route reached `main` at 06:18 UTC on 2026-09-14 and the QStash schedule is 01:00 UTC, so
at its first appointment `/api/workers/digest` did not exist. Vercel's runtime logs carry no
request to that path in the twelve hours around it. The route is deployed and reachable now
(an unsigned GET returns 405 with `x-matched-path: /api/workers/digest`, i.e. POST-only as
built), so the first firing that can work is 2026-09-15 01:00 UTC. If 09:00 Ulaanbaatar comes
and no digest arrives, the schedule is what to check — not the code — and that console is not
readable from here.

## D-064 — three columns the schema carried since `0001`, written by nothing

**2026-09-14, found by reading Matrix's first real mirror drafts.** No migration: every
column here has existed since the initial schema. What was missing was a writer.

### What was not being recorded

| Column | Read by | Written by |
|---|---|---|
| `messages.answered_by` | `metrics/clarify.ts`, in its own docstring | nothing |
| `messages.revision_id` | nothing yet; it is the trace | nothing |
| `messages.prompt_hash` | nothing yet; it is the trace | nothing |
| `webhook_events.replied_at` | `sweepStrandedEvents`, as a filter | nothing |

`reception/deps.ts` carried a literal **`void answeredBy;`** — the value was computed by
`handleReception`, passed across the seam, and discarded one line later. `revisionId` and
`contentHash` never left `loadLiveSnapshot` at all: the context had `revisionId` and the
snapshot's `contentHash` was dropped on the floor.

### Why it mattered on the day it was found, rather than eventually

Matrix's mirror had just started drafting against real customers, and a republish was days
away — the retail-products rule the founder was confirming with the salon. **Two drafts
either side of a config change would have been indistinguishable in the table**, so the
fourteen days could not have answered *did that edit help*, which is the entire question
the mirror exists to answer. A trace column is worth nothing the day it is added and
everything the day the config moves.

### `replied_at` was worse than absent: it was an assertion that could not fail

`sweepStrandedEvents` filters `.is('replied_at', null)`. With nothing writing the column,
every row in the table satisfied that predicate, so the filter excluded nothing. It was
harmless **only** because the `state` filter beside it (`received`, `failed`,
`pending_enqueue` — never `processed`) carried the whole load. It would have become
load-bearing the instant somebody widened that state list while trusting the line below it.

That is D-057's shape exactly — an assertion that cannot fail, arriving from inside the
mechanism built to catch exactly this class — and it was sitting in the sweep whose entire
purpose is to break a silence. `markEventState` takes an optional `repliedAt` now, and the
worker passes `now` only when the entry actually produced a draft.

**A DRAFT counts, and that is deliberate.** In `shadow` the reply is generated and
withheld, and the question this column answers is "did this delivery produce an answer",
not "did Meta accept it". The second question is `outbound_messages.sent_at` and already
has a column.

### The third provenance

`0001`'s CHECK has allowed `model | deterministic | canned | human` since the schema was
written, and `handleReception` collapsed the first three into two: a `deterministic_replies`
hit was recorded as `canned`. They are different tables, reviewed differently, and cost
different amounts — the deterministic path spends **nothing**, and §6.3.8 prices what it
absorbs at ₮26,300 per tenant-month. The first question anybody asks of the mirror's corpus
is how often a row answered without the model, and one value for both cannot answer it. So
the deterministic short-circuit is `deterministic`; a gate short-circuit and the handoff
stay `canned`, because those genuinely are `canned_responses` rows.

### Best-effort, and it must stay that way

`traceAnswer` runs after the reply exists. A trace that cannot be written is evidence lost,
which is bad; refusing the customer's answer over it would be worse, and a 503 would retry
an event whose reply is already drafted. So it returns its failure, the worker logs
`trace_failed`, and the reply stands — the same posture `flagQuality` takes, for the same
reason. The test for that failure path is where this PR earned the positional-stub trap
again: `messages` is touched three times in one run (insert, history read, trace update),
and a two-entry queue made the *history* read fail so the job 503'd before reaching the
trace at all. The file's own docstring warns about exactly that.

---

## D-065 — the gate asked the model to copy a line and nothing ever checked that it had

**2026-09-14, measured on the third draft Matrix's mirror ever produced.** Founder's
framing: *make it enforceable rather than requested — every customer-visible string rests
on this.*

### The measurement

Four gate blocks end with the same instruction — «БЭЛЭН ХАРИУЛТ» хэсгээс … **нэг ч үсэг
өөрчлөхгүйгээр яг хэвээр нь бич**, reproduce it without changing a single letter. Within
nine minutes of webhooks coming back:

```
canned `handoff`   Уучлаарай, би энэ асуултад хариулж чадахгүй байна. …    129 chars
draft, 03:58:01    Уучлаарай, би энэ асуултад хариулж чадахгүй байна. …    byte-exact
draft, 04:05:30    Уучлаарай, ___ энэ асуултад хариулж чадахгүй байна. …   128 chars
```

One word, «би», gone.

### A correction to this entry's own first reading, and where it came from

The first version of this said: same row, same instruction, two consecutive calls, one
obeyed and one did not. **That was wrong**, and the thing that says so is a `quality_flags`
row nobody had read yet.

Draft 03:58:01 was never the model obeying. Its turn carries an `outbound_price` flag — the
guard refused the model's text and `handoff()` then served the row. It is byte-exact because
**the platform typed it**, not the model.

So the record is worse than the first account, not better: **on the only occasion the model
typed a pinned line itself, it got it wrong.** One sample is one sample, and the case for
enforcing this never rested on a rate — an unenforced instruction looks the same at any
rate: mostly fine, exceptions invisible.

Worth keeping the shape of the mistake too. The first reading inferred *the model typed it*
from *a `spend_ledger` row lands a second before the draft*, which is true and does not
imply it: a model call happens on that turn either way, and what the guard did with the
answer is recorded somewhere else entirely. Two tables, one question, and only one of them
was consulted. The damage in this instance is small — the line is a refusal either
way. The mechanism it defeats is not. Every customer-visible sentence here rests on one
arrangement: a founder approves wording, `reviewed_at` records it, the prefix carries it,
the model is asked to copy it. A near-copy is **an unreviewed sentence with an approved
one's meaning**, and the review gate cannot see it, because the gate is on the row and not
on what comes back.

### The fix serves the row, and does not edit the reply

`src/lib/gate/pinned.ts` compares the model's text against the tenant's **reviewed** canned
rows. On a match — exact or near — `handleReception` discards the model's text whole and
drafts the row's own bytes, `answeredBy: 'canned'`.

It is not editing. `handleReception` already holds that line — *an edited reply is an
unreviewed reply* — and patching a paraphrase back toward the original would be exactly
that, plus a second implementation of a sentence that already exists in a row. Throwing the
text away and answering from the row is what both short-circuits above it already do. **The
model keeps the job it is good at — deciding which line applies — and loses the one it was
measurably unreliable at, which is typing it out again.**

An exact copy is substituted too, and that is not a no-op: it normalises whitespace back to
the row's bytes, and it corrects the provenance. A reply that IS the handoff line was
answered by a canned line whoever assembled the characters, and calling it `model` would
misstate the corpus the mirror exists to produce.

A paraphrase is **counted as well as corrected** — `quality_flags` code `canned_paraphrased`,
carrying the similarity, the kind, and the attempted text. A drift quietly fixed is a drift
nobody knows is happening, and the rate is the only evidence about whether the gate wording
works at all.

### Where the safety actually comes from

Not the threshold. `NEAR_COPY_MIN_SIMILARITY` is 0.90 of the longer string in code points,
and the measured case sits at 0.992 — an enormous margin, on purpose. The dangerous
direction is the other one: replacing a genuine answer with a refusal is worse than the
drift being caught. So a **length guard** carries most of it — a reply less than 0.8 the
length of a line is never read as a copy of it, whatever the ratio says — and every one of
Matrix's refusals ends with the same phone-number sentence, so substring overlap alone would
have condemned any reply that closed politely.

Three details that are rule 6 and not taste: NFC before comparing (decomposed «Ё» is not
composed «Ё», and skipping it reports a perfect copy as a paraphrase); Levenshtein over
**code points**, because `.length` counts UTF-16 units and one emoji would silently shift
every ratio in the file; and no case folding, because a shouted variant is not the approved
sentence.

**Only reviewed rows are pinned lines.** Measuring against an unreviewed row and then
serving it would ship Mongolian nobody signed off on, on the strength of the model having
roughly typed it — the review gate defeated by the mechanism built to enforce it.

### The second half of the same class, which is a prompt change and therefore parked

The founder also asked why a price question got `handoff` rather than
`refusal_price_unlisted`. The answer is the same shape one level up: **Ш2 and Ш8 both cover
"a price I do not have", and nothing orders them.** Ш1 states in as many words that it
dominates Ш2; no block says Ш2 dominates Ш8. So the model picks, and on Matrix it picks
wrong reliably rather than occasionally, because **`services` has no price column at all** —
the table is `name, category, unit, duration_minutes, turnaround_text, active`, no
«ҮНИЙН ЖАГСААЛТ» section is rendered, and Ш2's branches both read as conditions on a list
that is not there while Ш8 visibly applies.

The customer loses the more useful sentence: `handoff` says *I cannot answer this*;
`refusal_price_unlisted` says *this is about price and I do not have it*.

That fix is a gate block, which is signed platform Mongolian and belongs to the reading
evening. `prompt/drafts/sh2_price_precedence.mn.txt` is the unsigned revision — a precedence
line, 2б widened to name the absent-section case, and a wrong-example built from the real
draft. Loaded by nothing; `check-mn-review.mjs` keeps it that way.

**Note what the two halves have in common.** Both are instructions the model is asked to
follow with nothing checking that it did. One of them could be closed in code and was; the
other can only be closed by better wording, which is why the wording has to be good.

#### Corrected 2026-09-14, reading the turns separately: Ш2/Ш8 is not why THAT one got the handoff

The paragraphs above answer the founder's question with one mechanism. Read turn by turn,
the two turns of that conversation failed for two different reasons, and the price question
— the turn the founder was actually looking at — is the one Ш2/Ш8 does **not** explain.

**Turn 2, 03:57:43, «будаг хэдээр хийх вэ»** — the price question. The model did not reach
for Ш2, Ш8, or any price line. Its `quality_flags` row preserves what it actually wrote: the
«Ш0 (сувагтай холбоотой шалгалт)…» leak of D-066, ending in `refusal_public_channel` — it
decided a Messenger DM was a public channel. The outbound guard refused that on the `0`, and
the refusal path at `handle.ts:436` calls `handoff()`. **So the customer got the generic
handoff because the guard's fallback is unconditional**, not because two gates were
unordered. `refusal_price_unlisted` was never in play.

**Turn 3, 04:05:15, «buten»** — the follow-up, still inside the price conversation. Here the
model chose `handoff` itself, unrefused (no flag on that turn), and dropped «би» doing it.
That one is Ш2/Ш8 exactly as described above.

The distinction matters because the two have different fixes and only one of them is parked.
The gate wording is a reading-evening question. The fallback is code, and it names a real
design question: **when the outbound guard refuses, the platform serves `handoff` regardless
of what the customer asked**, discarding everything the gate layer already worked out. A
price question refused by the guard could fall back to `refusal_price_unlisted` — the line is
reviewed, it exists, and the classification would come from the gate match rather than from a
fresh guess at the moment the model's output has just been judged untrustworthy.

**Not built.** It changes which approved sentence a customer sees, on the surface that faces
Matrix's live customers, and it is a policy decision rather than a defect with an obvious
repair — picking a specific refusal for a question that was not about price is worse than the
generic one. Raised here for the founder.

And note the shape of the correction itself, because it is last night's twice over: the first
account read "the customer got handoff" plus "Ш2 and Ш8 are unordered" as cause and effect,
when the evidence for what the model actually typed was sitting in a different table. The
rule that keeps earning its place — **`quality_flags` says what the model wrote; the draft
says what the platform served; they are not the same row and not the same question.**

---

## D-066 — the model narrated its own gate to a customer, and the check that caught it was luck

**2026-09-14, found in the mirror's second turn while reading the corpus for D-065.**

### What it wrote

The customer asked «будаг хэдээр хийх вэ» — how much to dye. The model's reply began:

```
Ш0 (сувагтай холбоотой шалгалт): Энэ бол facebook_page буюу нийтэд харагдах сувагтай
тул үнийн мэдээллийг нийтэд бичих боломжгүй.

Уучлаарай, энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй. Хувийн мессеж бичвэл хариулна.
```

Three things at once, and each is worth naming separately:

1. **It narrated the gate structure** — «Ш0 (channel-related check)» is this platform's own
   label for a block of its system prompt, addressed to a salon customer.
2. **It named an internal identifier**, `facebook_page`, which is a value in
   `tenant_channels.provider` and means nothing to anybody outside this repository.
3. **It called a Messenger DM a public channel** and reached for `refusal_public_channel`,
   which exists for comment threads. A direct message is the private surface.

### Neither existing check could see it, and the one that fired did so by accident

`disclosesPrompt` — guard item 4 — looks for a contiguous **60-character run** of the prompt
in the reply. This is a *paraphrase* of Ш0's substance in the model's own words, so the run
detector cannot match it. Not an oversight: it is D-065's shape one file over, an exact-match
check defeated by a near-copy, and it is the second time in one day that the same weakness
has produced a finding.

What actually refused the reply was the **numeral** guard, objecting to the `0` in «Ш0»
because zero is not in Matrix's `allowed_numbers`.

**That is luck, and it is measurably thin.** Read back from the live snapshot the same day,
Matrix's allow-list is twelve tokens — `1, 10:00, 11:00, 19:00, 20:00, 3, 3-5, 30, 4-5, 50,
70, 7741-7777` — and **`1` and `3` are two of them**. So «Ш1 …» and «Ш3 …» carry digits the
guard is *required* to permit. Ш1 is the forbidden-topics block and Ш3 is booking: the two
whose disclosure matters most would have passed every check in `guard/outbound.ts` and been
drafted for a customer.

### The fix matches the SHAPE, because the content is paraphrasable and the label is not

Guard item **0**: a reply containing `Ш` immediately followed by one or two digits and a
label's punctuation is refused as `outbound_gate_label`. A gate label is a closed set of
tokens that exist only inside this platform's prompt, and no Mongolian sentence a salon
would send contains that shape — «Шампунь» is an ordinary word in a salon and is untouched,
because the match requires a digit immediately after the letter.

It is deliberately **not** folded or whitespace-collapsed the way `shingles` is. Evasion is
not the threat: the model is not hiding a label, it is narrating its instructions because it
believes that is helpful, so the literal form is the form that appears.

### It runs FIRST, and that is a change to an order this file pins on purpose

`outboundGuard`'s docstring fixes the check order because the per-gate refusal counters are
a production metric and a reply tripping two checks must always be attributed to the same
one. This adds a check *before* item 1 and therefore re-attributes something.

What it re-attributes is exactly the case that was wrong. The one real instance is recorded
as `outbound_price`, which sends a reader to the allow-list looking for a numeral problem in
a reply whose actual defect is that it disclosed the platform's structure. Only replies
containing a gate label change code, and for those the old one was misleading.

### What is NOT fixed here

The second and third problems in that reply are prompt-level, not code-level. Nothing stops
the model from writing `facebook_page` to a customer, and nothing tells it that a DM is not a
public channel — Ш0's own text is what would have to say so, and Ш0 is signed platform
Mongolian belonging to the reading evening. Both are recorded here so the evening has them.

The guard now refuses the whole reply, so neither reaches a customer while the wording is
unresolved. That is the right posture and it is not a fix: a refusal is a customer who did
not get an answer.

### The bound is a token, and `\b` is the wrong way to say so

The first version of the matcher was `Ш\d{1,2}\s*[.:)(]` — it required the label's
punctuation, which the one real leak («Ш0 (…») happened to have. Re-read adversarially
before the PR merged, it misses «Ш1 дүрмээр…»: the same disclosure written as prose rather
than as a heading, which is at least as likely a way for a model to narrate its own rules.

`\b` is the reflex repair and rule 6 forbids it, for a reason this case shows rather than
asserts: `\b` is defined against ASCII `\w`, so between `1` and the Cyrillic `д` it reports a
word boundary. The matcher would behave differently in Mongolian than in English on the one
platform where every customer-visible string is Mongolian. The bound is therefore explicit
and Unicode-aware — `(?<![\p{L}\p{N}])Ш\d{1,2}(?![\p{L}\p{N}])` — which leaves «Шампунь»
(no digit), «Ш2маск» (a letter after the digit, a plausible tenant product name) and «АШ1»
(a letter before) alone.

Its negative tests assert on `namesAGate` directly rather than on `outboundGuard` returning
ok, because two of those three carry a digit Matrix has not approved and the numeral guard
refuses them for a different and correct reason. Asserted end to end, they would have stayed
green on the day this check broke.

### The comment path has no model in it, so it cannot leak a label

`outboundGuard` is called from `reception/handle.ts` and nowhere else, which reads at first
like a hole: a gate label leaking into a **public** reply under the salon's own wall is
strictly worse than into a DM. It is not one. `worker/comments.ts` never generates text —
`decideCommentReply` returns the bytes of a single `canned_responses` row and refuses
outright when that row is absent, empty or unreviewed (`eligibility.ts:169`). There is no
model output on that surface to guard.

Recorded because the absence is load-bearing rather than accidental: **the day anything
generates a comment reply, that surface needs item 0 and everything under it.** The reason
the guard is not there is the reason there is nothing to guard.

---

## D-067 — a customer writing Mongolian in Latin letters fires no gate at all

**2026-09-14, from the mirror's first three real messages.**

Two of the three were Latin script. One was `hello`. The other was **`buten`**, sent
immediately after «будаг хэдээр хийх вэ» — almost certainly «бүтэн», *full* (as against a
partial colour), answering the implicit question about which dye service. That reading is an
inference about a customer's intent and is written here as one; what follows does not depend
on it, only on the message being Latin.

### Proven by execution, not by reading

`fold()` is `nfc(s).toLocaleLowerCase('mn-MN')` and nothing anywhere transliterates. Stems are
stored as Cyrillic, so against Latin text `containsStem` cannot match:

```
true   Cyrillic message, Cyrillic stem      "бүтэн будалт хийлгэнэ"  ~ бүтэн
false  SAME words in Latin, same stem       "buten budalt hiilgene"  ~ бүтэн
true   children's rule, Cyrillic            "хүүхдийн үс засуулна"   ~ хүүхд
false  children's rule, Latin               "huuhdiin us zasuulna"   ~ хүүхд
true   case folding still works             "Хүүхдийн"               ~ хүүхд
```

`wholeMessageMatches` behaves the same way: «сайн байна уу» matches, `sain baina uu` does not.

### Why this is a safety finding and not a matching nicety

`matchRules` and `matchDeterministic` both go through these two functions. So for a
Latin-script message **no disclosure rule and no out-of-scope topic fires**, `firedGates` is
empty, `refusedTopicBlocksPrice` is false, and the model answers with no refusal in play.

The concrete case is the one the founder approved by hand: Matrix does not do children's
hair, the `out_of_scope_topics` row exists for it, and it **does not fire for «huuhdiin»**.
A gate that silently does not fire is worse than one that is missing, which is the same
sentence D-064 uses about a column that is read and never written.

What is unaffected: the outbound guard's numeral, URL, forbidden-phrasing, script-share and
gate-label checks are properties of the REPLY, so they hold whatever script the customer
wrote in. A price still cannot be invented. What is lost is the topic layer above them.

### Corrected within the hour: this needs ROWS, not code

The first version of this decision said a transliteration layer was required, that Mongolian
romanisation is ambiguous — «ү» is u, ue or v; «ө» o or oe; «х» h or kh — and that the
founder therefore had a design question to settle before any code. The ambiguity is real. The
conclusion was wrong, and the thing that corrected it was the ancestor.

`Matrix-Chatbot` has exactly one place that matches customer text, and it reads
`/^(сайн|байна|уу|hi|hello|hey)/i` — it **lists the Latin forms** beside the Cyrillic rather
than transliterating. Testing that idea against our own matcher:

```
true   Latin stem vs Latin text        "huuhdiin us zasuulna"  ~ huuhd
true   Latin, mixed case               "Huuhdiin Us Zasuulna"  ~ huuhd
true   Latin stem, inflected tail      "manai huuhduud"        ~ huuhd
true   the real message from the mirror "buten budalt hiilgene" ~ buten
false  mixed script                    "hүүхдийн"              ~ huuhd
false  the token-prefix rule holds     "minii huuhed"          ~ huuhd
```

**`containsStem` is already script-agnostic.** It is a Unicode token-prefix match and does not
care which script the stem is in; `fold()`'s `toLocaleLowerCase('mn-MN')` handles ASCII case
correctly. A tenant that stores `huuhd` alongside `хүүхд` is covered **today, with no code
change at all** — and it degrades the way the Cyrillic stems already do, matching inflections
by prefix and declining to match across scripts.

So there is no transliteration engine to design and no romanisation standard to adopt. This is
the platform's own test applying exactly as intended: *onboarding client #3 must be filling in
a config, not writing code.* A Latin spelling is another element of `stems`.

What remains for the founder is a **data** question, not a design one: which Latin spellings do
Matrix's customers actually use? That is answerable from the corpus rather than from a
standard — and it is precisely the thing fourteen days of real messages produce. The rows are
tenant configuration and the stems are not customer-visible strings, so they are not gated on
the reading evening; they are gated on knowing the answer.

Note the shape of the error, because it is the day's third of one family: **a claim about what
a fix would require, made without checking whether the existing mechanism already did it.**
Reading `fold()` proved Latin text matches no Cyrillic stem — true — and I carried that
straight to "therefore transliteration", never asking the adjacent question of whether a Latin
STEM works. It takes one line to test and I tested it only after the ancestor suggested it.

**Read the original finding as evidence about the mirror, which is what the mirror is for.**
Two of the first three real messages were in a script every one of this tenant's stems is
blind to, and nothing in fourteen days of tests would have said so.

### Addendum, 2026-09-14 08:00 UTC: the mechanism worked, and the threshold's premise did not

The first `on_change` episode fired at **08:00:08.989 UTC** and is exactly the row D-063
specifies: `repeat_policy = 'on_change'`, `resolved_at` null, `dedup_key`
`channel_silence:1fb6d543…:no_webhooks` — **no date** — and `notified_at` 08:00:09.636, so
raise → Telegram → `markNotified` all fired. Every older row has `notified_at` null and a
dated key (`…:no_webhooks:2026-09-14`). The split is live and behaves as designed.

The condition it reported is where it gets interesting. Matrix's last webhook was 04:06:10;
at 08:00 that was 3.1h of open time with nothing.

**It is not a delivery fault, and the ancestor is what proves it.** `Matrix-Chatbot` serves the
same Page through a different Meta app, so it is a control this platform did not have to
build. Measured from its Vercel runtime logs:

| window (UTC) | `/api/messenger` | `/api/messenger-worker` |
|---|---|---|
| 72h → 48h ago | 39 | 37 |
| 48h → 24h ago | 30 | 30 |
| 24h → 8h ago | 6 | 5 |
| 8h → 4h ago | 5 | (our 4 arrived here) |
| 4h ago → now | **0** | **0** |

Our traffic tracks the ancestor's **in both directions**: we received in the window it
received in, and neither of us has received since. There is no evidence of a problem with our
subscription, and Matrix's live customers are not sitting unanswered by its production bot —
it is getting exactly what we are, which is nothing.

**What the numbers do falsify is the threshold's own justification.**
`DEFAULT_THRESHOLD_OPEN_MINUTES = 180` carries this reasoning in its docstring:

> For Matrix, whose measured traffic is 60.5 replies/day across a ten-hour day (D-016), three
> open hours would normally carry around eighteen replies — so zero is a strong signal rather
> than a slow afternoon.

Take the worker invocations as the unit — one per message to process — and the last three
rolling days are **37, 30, 9**, not ~60. Over a ten-hour day that is 0.9–3.7 messages an hour,
so three open hours carry roughly three to eleven messages, and a run of zero is an ordinary
gap rather than a strong signal. Today's critical is therefore a **true reading of "nothing
arrived" and a false inference that something is wrong** — and at that arrival rate it has a
real chance of recurring on any quiet afternoon.

Note what that does to D-063's own purpose: the daily repeat was retired from the KEY, and the
same noise can walk back in through the THRESHOLD. One `on_change` episode per genuine quiet
spell is far better than six criticals about one dead channel, so this is not urgent — but a
critical the reader learns to dismiss is the thing being defended against, whichever mechanism
produces it.

**Deliberately not changed.** The constant is the sensitivity of the one instrument that
caught an eleven-day outage, and its docstring already argues — correctly — that a per-tenant
knob "invites tuning a real alert into silence one channel at a time". Loosening it lengthens
the time-to-detect on the next real outage. That trade is the founder's, and it now has a
measurement under it rather than an assumption: **D-016's 60.5 replies/day is the number to
re-derive before anybody picks a new threshold**, because it is the premise every version of
this alert has rested on and the Page is not delivering at that rate today.

---

## D-066 addendum — the widened matcher caught a real leak five hours after it merged

**2026-09-14 08:50:20 UTC.** `outbound_gate_label` fired in production, on a live customer
turn, against this attempted reply:

> «Ш0-г шалгахад энэ нь нийтэд харагдах сувагт (facebook_page) бичсэн мессеж тул үнэ,
> захиалга, ажилтны талаар нийтэд дэлгэрэнгүй хариулах боломжгүй.»

The guard refused it and the customer got the reviewed handoff line instead. Three of the
same defects as the 03:57 instance: the gate label narrated to a customer, the internal
identifier `facebook_page`, and `refusal_public_channel` reached for on a Messenger DM.

**The part worth keeping is which version of the matcher caught it.** #85 shipped in two
commits: the first anchored on the label's punctuation, `Ш\d{1,2}\s*[.:)(]`; the second,
after an adversarial re-read before merge, widened the bound to a Unicode standalone token,
`(?<![\p{L}\p{N}])Ш\d{1,2}(?![\p{L}\p{N}])`. Run both against the real text:

```
shipped matcher  : "Ш0"
first version    : null
```

and against the 03:57 leak, which motivated the check in the first place:

```
shipped matcher  : "Ш0"
first version    : "Ш0 ("
```

**The first version would have missed this one.** What defeats it is «Ш0-г» — the label
carrying the Mongolian accusative suffix, so what follows the digit is a hyphen rather than
one of `.:)(`. That is the same language feature that makes `\b` wrong here: Mongolian
agglutinates onto the token, and a matcher written around English punctuation habits does not
see it. The widening was reasoned from the language, five hours before the language produced
the case.

Two things follow. **An adversarial re-read of your own check before merging is not
ceremony** — it bought a real interception here, on a customer-visible reply, the same day.
And the leak has now happened **twice in the corpus's first thirteen turns**, which makes it a
rate rather than an anecdote: Ш0's wording is the fix, and it belongs to the reading evening.

### Still unfixed, and now measured: `refusal_public_channel` on a DM

Three of the ten drafts reached for the public-channel refusal on a Messenger **direct
message** — at 03:57, 08:48 and 08:50. The 08:48 one was served to the customer, who had
written «Эмэгтэй сортой будаг хийлгэх гэсийн» (*I'd like to get women's colour done*) in a
private DM and was told «Хувийн мессеж бичвэл хариулна» — *write a private message and I will
answer*. They were writing one.

That is not a guard problem; the guard cannot tell which canned line is appropriate. It is
Ш0's text, which describes the channel check in terms that let the model conclude a DM is
public. It is signed platform Mongolian and belongs to the reading evening, and it now has
three instances and a customer-visible consequence attached to it.

---

## D-067 addendum — «Sn bnu?» is an abbreviation, not a romanisation, and the row space is wider than claimed

**2026-09-14 09:28:58 UTC.** A customer opened with **«Sn bnu?»** — «Сайн байна уу?»
compressed to initials and a clipped verb, SMS-style.

This qualifies what D-067 says. For **content stems** the row answer holds exactly as written:
«huuhd» beside «хүүхд» catches `huuhdiin`, `huuhduud` and the rest by token prefix, because
the customer is typing the word out. The children's-services safety case — the one that
matters — is covered by rows.

For **greetings it is weaker, and «Sn bnu?» is the proof**: listing `sain baina uu` does not
catch `sn bnu`, and the abbreviation space is not enumerable the way a word's romanisations
are (`sn bnu`, `snbnu`, `sain uu`, `sn bn uu`, …). So "the fix is rows, not code" is right
about the topic layer and optimistic about the greeting layer.

That is not an argument for a transliteration engine — transliteration would not catch
`sn bnu` either, since there are no vowels to transliterate. It is an argument that a
deterministic greeting rule, if one is ever written, needs a different kind of matcher from a
topic stem, and that the corpus is the only place to learn which abbreviations actually occur.
Recorded so the next reader does not inherit the more confident sentence without this one.

### And the corpus's first product defect: one sentence, split, answered twice

Two of the first ten turns arrived as same-conversation bursts — «Хаяг» then «Цаг авах»
eleven seconds later, and «Холбогдох утас бна» then «Уу» **two** seconds later.

The second pair is one sentence. «Холбогдох утас бна» + «уу» is «Холбогдох утас байна уу?» —
*is there a contact number?* — typed in two goes, the way people text. The platform treated
each fragment as a complete question, spent a full model call on each, and produced two
replies of about four hundred characters that say nearly the same thing. In the mirror that
is two `draft` rows. Live it is two long messages landing on one customer two seconds apart,
the second answering half a sentence.

It is worth being precise about what is and is not established. That the fragments compose
into one question is a reading of Mongolian, not a measurement. What IS measured: two turns
under fifteen seconds apart in the same conversation, two separate model calls, two near
duplicate long replies. And the earlier pair shows the related cost — the reply to «Цаг авах»
(*book an appointment*) opens by declining to give a location, which was the PREVIOUS
message's subject.

No fix is proposed here, and deliberately. Debouncing a conversation changes when a customer
is answered on the surface that faces Matrix's live customers, and the sensible window is a
product judgement — long enough to catch a split sentence, short enough that a person waiting
does not think the bot is dead. That is the founder's call.

**And the hint that the ancestor might already collapse them is dead — checked, not left
hanging.** It took eleven deliveries to nine worker invocations the same day, which looked
like collapsing. It is not: `Matrix-Chatbot` has no debounce anywhere — no timer, no buffer,
no batching — and what produces the gap is a FILTER, `api/messenger.js` skipping `is_echo`,
`ev.delivery`, `ev.read` and non-text events before it processes `entry.messaging` one event
at a time.

That inverts what the finding means for urgency. The ancestor answers each text event
separately too, so **the double reply is the status quo for Matrix's real customers today**,
not a regression this platform would introduce. It is an opportunity to be better than the
system being replaced rather than a defect blocking the cutover — which is a different
conversation, and a less urgent one.

This is the mirror doing its job. No test would have produced it, because no test types half a
sentence and then the rest.

---

## D-068 — the disclosure guard refuses a reply for quoting an approved line

**2026-09-14 14:23:43 UTC, live turn, found by reading the corpus.** A customer opened a
new conversation with **«tsag avii»** — «цаг авъя», *let me book an appointment*, the single
most commercially valuable thing anyone types at a salon. The model answered:

> «Уучлаарай, би цаг захиалж өгөх боломжгүй байна — захиалгын системд хандах эрх надад алга.
> Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа
> төлбөрөө QPay-ээр төлөх боломжтой.»

That is a good reply. It declines what it cannot do, says why, and hands over the booking
URL — and its second sentence is the reviewed `booking_line` row, reproduced correctly.

`outbound_disclosure` refused it, and the customer got the generic handoff instead.

### The exact run, and why the exemption missed it

Reconstructed against the live snapshot and the eleven canned rows, exactly one run of the
reply is in the prefix and not in the exemption set:

```
" та манай вэбсайтаар (https://www.matrixecosalon.org/) онлай"
```

**The leading space is the whole bug.** `shingles()` ends with `.trim()`, so shingling a
canned body in isolation produces runs beginning at its first character and never one
character earlier. The compiled prefix contains that same line **in context**, preceded by
whatever renders before it — which folds to a space. So a window straddling the line's
opening boundary exists in the corpus and is absent from the exemption.

The consequence is general, not particular to this reply: **quoting an approved line as part
of a longer sentence trips the guard.** Only a reply that is *exactly* a canned line, alone,
is reliably safe — and composing around the line is precisely what a helpful answer does.

### It is the docstring's own principle, applied to one side only

`disclosesPrompt`'s comment already states the right rule, and states it well:

> …the exemption is computed by shingling the canned responses too, rather than by deleting
> them from the corpus, because deleting them would splice unrelated text together and
> manufacture runs that were never in the prompt at all.

That reasoning is correct and it was applied to the CORPUS. The same boundary problem exists
on the REPLY side and was not: a run of the reply that begins just before a canned line is
neither "inside the canned line" nor "the model disclosing the prompt". It is an artefact of
where the window happens to fall.

### The proposed fix, not built

Mask the canned-line occurrences **in the folded reply**, cut the reply into the segments
between them, and shingle each segment independently — never splicing the segments together,
for exactly the reason the docstring gives. A run can then no longer straddle a boundary,
because the boundary is where a segment ends.

**Deliberately not built.** This LOOSENS a disclosure guard on the surface that faces
Matrix's live customers, and the founder's standing rule keeps that class of change with
them. Nothing here is urgent — the platform is in shadow and every affected reply became a
`draft`, so no customer has seen either the good reply or the refusal.

But note what it costs while it stands: the guard is currently biased **against the replies
that use the approved lines properly**, which is the opposite of what it is for. And it
lands hardest on booking, which D-042 already shows is the intent this platform is worst at
delivering.

### On reading the flag rather than the draft

This turn's draft is the handoff line and `answered_by` is `canned`. Read from the draft
alone it looks like D-067 — a Latin-script message firing no gate, so the model fell back.
`quality_flags` says otherwise: the model answered well and the GUARD refused it. Same
lesson as the price question, third time in two days. **Read the flag before explaining the
draft.**

---

## D-069 — what the first real corpus says about the Mongolian, and the one fact underneath it

**2026-09-14, eleven customer turns and eleven drafts across five conversations, the
salon's full trading day.** This is item 5 of the overnight brief: read every draft and say
what reads wrong.

> **Counts corrected 2026-09-15.** This section first read "eleven customer turns and ten
> drafts", and the session's close-out said four conversations. Both were wrong. An exact
> join on `dedup_key = 'in:' || external_id` gives **eleven drafts, 1:1 with the turns, in
> five conversations**, with no nulls on either side; provenance is `model` 5, `canned` 3
> and three pre-D-064 nulls, not `canned` 2. The eleventh draft is the «tsag avii» turn
> D-068 is about — counted as a turn and missed as a draft. Nothing downstream rested on
> either number, which is exactly why neither was checked. The judgements
below are mine and the founder is the native speaker, so they are ranked by how confident
this reading is and marked as questions where they are questions. **The measurements are
not judgements and are stated separately.**

### Measured, not judged

**Matrix has no address.** `contact_points` holds exactly one row — `phone`, `7741-7777`,
`is_escalation` true. The published prefix contains «Яармаг» (a branch name) and **no street,
no district word, no unit number**. So there is no postal address anywhere in this tenant's
configuration.

That matters because **«Хаяг» — *address* — was the first word a real customer typed today**,
at 08:44:41, before anything else. The model behaved correctly: it pointed at the phone and
the website rather than inventing a street. But it then *labelled* what it gave:

- 12:28 — «Хаяг, холбоо барих:» followed by a phone and a URL, and no address.
- 12:28 — «📍 Байршил, холбогдох утас: 7741-7777» — a pin glyph and the word *location*
  against a telephone number.

**A label that promises an address and delivers a phone number is worse than declining.** The
fix is a row, and the value is the founder's to supply: an address `contact_point` alongside
the phone. It is tenant data of the same kind as the booking URL, not platform Mongolian.

**The model also wrote the same greeting two ways.** At 03:57 «Матрикс эко **салонд** тавтай
морил» and at 09:29 «Матрикс эко салон (Яармаг салбар) **руу** тавтай морил». Same intent,
same day, two different cases on the same noun. That is measured; whether one is wrong is the
next section.

### Judged, ranked by confidence, and put to the founder rather than asserted

1. **«салон руу тавтай морил» (09:29) reads wrong.** *Welcome to X* takes the dative
   («салонд»), and «руу» is directional — *towards* the salon. The 03:57 draft used the
   dative correctly. Highest confidence of anything here, and note that the evidence is
   internal: the model contradicted itself, so at most one of the two can be right.
2. **«тавтай морил» is the familiar imperative, in both greetings.** «тавтай морилно уу» is
   the polite form, and both drafts pair the familiar imperative with the honorific «Танд» in
   the next sentence. On signage «Тавтай морил!» is ordinary; in a message addressed to one
   customer it reads casual. Medium confidence — this is exactly the call a native speaker
   should make.
3. **«манай яг байршил» (08:45) is clipped.** The genitive is doing work it has not been
   given — «манай салонгийн яг байршил» or «яг байршлаа» would be the ordinary forms. Medium
   confidence. The same sentence's «би энэ хэлбэрээр өгч чадахгүй» (*I cannot give it in this
   form*) is vague about which form is meant.
4. **Emoji appear in five drafts and in no approved line** — 📞 🌐 📍 🔗 😊. Not a language
   error; a brand decision that has been made by default rather than by anyone.

### The one a customer would actually notice

At **08:45:02** the bot told a customer where to find the salon's details. At **08:45:14**,
twelve seconds later in the same conversation, it opened with «Уучлаарай, манай яг байршил
зэрэг дэлгэрэнгүй мэдээллийг би энэ хэлбэрээр өгч чадахгүй байна» — *sorry, I cannot give
detailed information such as our exact location*.

Two consecutive turns, one helping and one refusing, about the same subject. Neither is
ungrammatical. Together they read as a bot that does not know its own mind, and that is a
worse impression than either sentence alone makes.

Both were `answered_by = 'model'` against the same revision and the same `prompt_hash`, so
this is not a config change between turns — it is the model's own variance on adjacent
questions, which is the argument for pinning the answers that recur.

---

## D-068 addendum — closed, and what the fix gives away

**2026-09-15.** Built, on the founder's instruction: *"Every booking reply that quotes the
approved URL is being thrown away."*

`segmentsAroundCanned` cuts the folded reply at every occurrence of a folded canned line
and shingles each remaining piece **on its own, never joined** — for exactly the reason the
corpus side has always shingled the canned lines rather than deleting them. A run can no
longer straddle a line's opening boundary, because the boundary is where a segment ends.

The shingle exemption is KEPT alongside it. They cover different things: the segments catch
an exact quotation in context, and the exemption still catches the near-copy a cut cannot
find — D-065's paraphrase, which `gate/pinned.ts` corrects but which reaches this function
first. Removing either would give something back.

Indexing is by **code point**, not UTF-16. `String.indexOf` counts UTF-16 units and
`shingles` counts code points; they agree exactly until an emoji appears, and emoji appeared
in five of the mirror's first ten drafts. A UTF-16 offset would cut the segment out of
position and silently change what the guard examines — a bug that would be invisible except
on the replies that carry emoji, which is to say the friendly ones.

**What it gives away, stated rather than buried.** A disclosure must now be 60 characters
within ONE segment. A reply that interleaved a full canned line between every fifty-nine
characters of prompt would evade the run detector. That is a real hole and a narrow one: the
model is not an adversary here — it is being helpful — and the measured alternative is
discarding correct answers to the most commercially valuable question a salon receives.
Items 0, 1, 2 and 7 are untouched and still run before and after it.

The D-068 GAP test said, in its own first line, to delete it when it failed. It failed. It
is replaced by the guarantee plus three properties that must survive the loosening: a real
disclosure beside an approved line is still refused, the cut does not splice, and an emoji
cannot shift it.

---

## D-070 — the corpus was 79% of the traffic, and the missing fifth were thumbs-ups

**2026-09-15, reading the mirror's first full trading day.** Matrix received **fourteen**
deliveries on 2026-09-14 and the corpus holds **eleven**. The other three were attachments
with no text. `meta/extract.ts` skipped them, and its docstring said everything skipped was
"*reported*, not silently dropped". The report was one `console.info` in the reception
worker. No `quality_flags` row, no `messages` row, nothing in the digest.

So 21% of what real customers sent was invisible to the fourteen-day mirror whose entire
purpose is to measure what real customers send. The only way to learn what those three had
been was to read `webhook_events.raw_payload` by hand in SQL.

### They were thumbs-ups, and that is the argument, not the refutation

All three carried `sticker_id` **369239263222822** — the same Facebook thumbs-up. Dropping
them is right. A photograph of the colour a customer wants would have been dropped
identically, and that is the single most valuable message a salon can receive.

**A mechanism whose correct behaviour and its worst behaviour are indistinguishable from
the outside is not yet a mechanism.** Nothing in the corpus, the digest or the logs
separated three thumbs-ups from three photographs; the distinction existed only inside a
jsonb blob nobody was reading.

### And the trap inside the payload

Meta sends one sticker as **two** attachments carrying the same `sticker_id`, the first
declared `type: "image"`:

```
[{type: image,   payload: {url, sticker_id: 369239263222822}},
 {type: sticker, payload: {url, sticker_id: 369239263222822}}]
```

Counting the array says the customer sent two things. Reading only `type` says one of them
was a photograph. **Both are wrong, and the second is the one that costs** — it is the
reading that turns a thumbs-up into a lost sales enquiry in a morning report, which is
exactly what happened before the payload was read. `attachmentKinds` keys on the
`sticker_id` in the PAYLOAD, which is the only field that tells them apart, and the
duplicate collapses.

### What is recorded

`inbound/dropped.ts` writes one `quality_flags` row per unanswered inbound event, with the
reason, the kinds, the sticker ids and the event's position — tied to its conversation where
one exists, found **read-only**, because a sticker must not open a `conversations` row that
the sold band and D-016's volume model both count.

Only skips where a CUSTOMER acted: `no_text`, `postback`, `malformed`. An echo is our own
message coming back and a receipt is Meta's bookkeeping; recording those would bury the ones
that matter. `postback` and `malformed` are in rather than out because leaving them would
rebuild this same blind spot one branch over — D-062's "when you split a verdict, ask what
the new branch is now collapsing".

**Idempotent on `(event_id, idx)`** and not on a unique constraint, because that is a
migration and the founder pushes migrations. A QStash retry re-parses the same payload, so
without it the digest count — the number a person actually reads — would drift upward on its
own. When the dedupe read itself fails the row is written anyway and says
`dedupe: "unverified"`: dropping it rebuilds the bug, writing it silently lets a duplicate
pass as a distinct loss, and undetermined belongs in the row rather than in a log nobody
greps.

The digest carries one clause every day, **zero included**, for the same reason its
heartbeat does. An unreadable count prints `UNREADABLE`, never zero — reporting zero when
the read failed is the exact defect being removed, rebuilt inside the repair. It does not
503 the digest the way an unreadable `alerts` does: the alerts read is the digest's subject,
this is a fact carried alongside, and failing the job would trade a missing clause for a
missing digest including the open criticals it was about to list.

The PSID reaches neither a log line nor the jsonb detail. `conversation_id` is the link, and
it is what the data-deletion callback can find.

### The correction this decision exists to make structural

The first reading of these three events — written into a morning report before the payload
was read — called them photographs and built a customer narrative on it: *sent a photo, got
nothing, gave up, asked for a phone number instead*. Measured: a thumbs-up, forty seconds,
then a question. **The type field was read and the payload was not**, which is `read the
flag before explaining the draft` in a third table. The instrumentation is the answer
precisely because the next reader should not have to be careful.

---

## D-071 — a tenant's own link, refused by its own guard

**2026-09-15, founder:** *"Matrix's location is a Google Maps link, not an address."*

`contact_points.kind` has permitted `maps_url` since `0001` and `prompt/sections.ts`
compiles contact points into the prefix — but `allowedUrls` was built from
`tenant_booking.booking_url` **alone**. So the location could be handed to the model,
quoted back correctly, and then thrown away by `urlsNotAllowed`.

That is D-068's shape in a different check, found the same morning: **a reply punished for
using the tenant's own approved data.** Two guards, two tables, one failure mode — which is
the argument for looking at the others rather than for fixing this one.

All four URL-shaped kinds are included (`maps_url`, `website`, `facebook`, `instagram`), not
only the one needed today: restricting it to `maps_url` would rebuild the same gap for
`website` the first time anybody adds one. An unreadable `contact_points` refuses the whole
load rather than narrowing the allow-list — a guard that tightens itself because a query
blipped would refuse every reply quoting a tenant link, with nothing to show why. The values
join `scriptShareExclusions` as allowed URLs already did, so Latin characters in an approved
link do not count against the Cyrillic share and trip `outbound_language` instead.

The allow-list is exact, not host-wide: **that** Maps link is permitted and any other
`maps.app.goo.gl` link is refused. Verified by execution.

### The labels were English keys, which is why the model invented «Хаяг»

D-069 recorded the symptom — «Хаяг, холбоо барих:» and «📍 Байршил, холбогдох утас:
7741-7777», a label promising an address over a telephone number — and called the fix a row.
The row is half of it. The other half is that the section rendered `- phone: 7741-7777`:
the heading was Mongolian and every line beneath it was an English identifier, so **the one
thing the model could not do was reuse the platform's own word for the thing.** It had to
pick one, and it picked the customer's.

`CONTACT_KIND_LABELS` gives each kind a Mongolian label, and **«Хаяг» is bound to the
`address` kind and to nothing else** — so a tenant with no address row cannot have the word
in its prefix at all. That is a structural answer rather than an instruction the model may
or may not follow, which is D-065's lesson one layer up. An unknown kind falls back to the
key rather than being dropped: a contact point the tenant entered must not vanish from the
prompt because nobody added a translation.

**The wording waits for the founder** and the mechanism makes waiting free: nothing reaches
a customer until a republish through `scripts/publish/tenant.ts`, which needs
`SUPABASE_SECRET_PUBLISH` — absent from this environment, so no session here can publish it
by accident.

**Order matters on the way out.** The code must deploy before the republish. Deploy first
and the maps link is merely allowed and not yet quotable; republish first and the model is
handed a URL the live guard still refuses, which is D-058's asymmetry pointed the other way.

---

## D-072 — the unit of cost is the conversation, not the reply

**2026-09-15, founder:** *"If ₮250,000/month doesn't cover 400 conversations, I need to know
before I sell another one."*

**It covers it. The ceiling does not.**

### Measured, from `spend_ledger` and `model_prices`, not modelled

Matrix, 2026-09-14, eleven Sonnet 5 calls, **$0.186995**. The per-call rows split in two:

| | calls | total | each |
|---|---|---|---|
| cache **miss** — paid to write the prefix | 4 | $0.1622 | **$0.040554** |
| cache **hit** | 7 | $0.0248 | **$0.003540** |

A cold reply costs **11.5×** a warm one, and cold starts are **86.7%** of the day's money.
The prefix is 9,738 tokens and Matrix runs `prompt_cache_mode = '1h'`, so a cold start pays
9,738 × $4.00/MTok = **$0.038952 — 96% of a cold reply — before a single word is generated.**

**Cold starts track CONVERSATIONS, not replies.** Five conversations yesterday produced four
cold starts: conversations arrive hours apart and a conversation's own turns arrive seconds
apart, so the cache is gone by the next customer and warm for the rest of this one. The one
conversation that did not pay was «Sn bnu?» at 09:29, which warmed off a call 38 minutes
earlier.

### The answer

₮250,000 ÷ 3,500 MNT/USD (`spend_ledger.fx_mnt_per_usd`) = **$71.43/month**. At D-015's
400-conversation band, with `cost = C × cold + C × (T−1) × warm`:

| turns/conversation | cost/month | margin | against the $20 ceiling |
|---|---|---|---|
| 2.2 — measured yesterday | $17.92 | **74.9%** | 90% |
| 4.6 — D-016's 1,842 replies ÷ 400 | $21.32 | **70.2%** | **107% — BREACHED** |
| 6.0 — D-016's unmeasured A7 | $23.30 | **67.4%** | **117% — BREACHED** |

Every plausible shape clears the 60% target. **₮250,000 is safe to sell against 400
conversations.**

### What is not safe is the ceiling, and it is the founder's

`tenant_budgets.monthly_ceiling_nanousd` for Matrix is **$20.00**, set when the price was
₮80,000 ≈ $22.86. At two of the three volumes above the tenant exhausts it and degrades to
`on_exhausted = 'canned_reply'` — the bot stops using the model part-way through the month,
which the customer experiences as the product breaking, not as a budget working. At $71.43
revenue a 60% margin supports a ceiling of **$28.57**.

Not changed here. Ceilings are money movement.

**And the reservation is 3.4× light.** `RECEPTION_REPLY_ESTIMATE` is $0.012, from D-016's
measured $0.0090/reply; a cold reply is $0.0406. Its own docstring says an under-estimate
"lets a burst slip past the ceiling between reserve and settle", and that is now measured
rather than hypothetical. Settle corrects the ledger afterwards, so the accounting is right;
what is wrong is how far a burst can run before the ceiling bites. Also money, also the
founder's.

### Two levers, one of them re-opened

**`docs/prefix-trim.md` is a margin lever again.** CLAUDE.md retired it — "no longer a
margin rescue; it matters for scaling across tenants" — on D-016's blended per-reply
arithmetic, which has no cold-start term. On this arithmetic the prefix IS the bill: a 30%
trim saves ~27% of it.

Note why the prefix is so expensive here and not elsewhere: 13,745 characters compile to
9,738 tokens, **1.41 characters per token**, against roughly 4 for English. Mongolian
Cyrillic costs about 2.8× more per character to cache, so prefix discipline matters more on
this platform than the general advice would suggest.

**`1h` versus `5m` is a wash and should not be touched on one day of data.** Replaying
yesterday's actual arrival times under a 5-minute TTL gives 6 cold starts instead of 4, but
at $2.50/MTok instead of $4.00: **$0.173 against the actual $0.187**, 7.3% cheaper. That
advantage is a property of one day's gap distribution and reverses as volume rises. Left
alone.

### What this does not establish

The 400-conversation band itself is D-015's and rests on D-016's six days; CLAUDE.md already
flags that **D-016's 60.5 replies/day must be re-derived** before anybody leans on it. This
decision changes the COST model, not the volume model. `T`, turns per conversation, is a
one-day measurement of 2.2 from five conversations — the two higher rows are there because a
single day cannot settle it, and the conclusion holds across all three.

---

## D-072 addendum — two things D-072 got wrong, found while carrying out its own recommendations

**2026-09-15.** The founder authorised both changes D-072 asked for. Executing them turned
up two errors in the decision itself. Both are recorded here rather than edited away,
because both are the same class of mistake the repository keeps cataloguing.

### 1. NOTHING ENFORCES THE MONTHLY CEILING, so nothing could have degraded

D-072 said two of three volumes "breach it into `on_exhausted = 'canned_reply'`". That
cannot happen, and the repository already said so:

- **`monthly_ceiling_nanousd` is read by no code anywhere.** It appears in `0001`'s DDL, in
  its CHECK constraint, in `scripts/provision/matrix-budget.sql`'s assertion, and in prose.
  There is no reader in `src/`, no reader in any migration, and D-051's own text says it
  plainly: *"No month is wired… `monthly_ceiling_nanousd` remains documentation until they
  are picked."*
- **`on_exhausted` is read by no code either.** The degradation ladder it names is designed
  and not built, so `canned_reply` is a string in a column, not a behaviour.
- **What actually binds is the DAILY cap, and it is compiled, not configured.**
  `effectiveDailyCeiling` takes the LOWER of `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY`
  (**$1.50**, `src/config/platform.ts`) and the tenant row's daily × `surface_fractions`
  (**$2.00 × 0.95 = $1.90** for Matrix). So Matrix's live reception ceiling is **$1.50/day
  from a constant in the repository**, and its `tenant_budgets` row does not currently
  change it in either direction.

**This is D-064 read from the other end.** That decision's rule was "when you find a
column, ask who writes it before you trust what it means." D-072 checked who WRITES
`monthly_ceiling_nanousd` — the provisioning script — and never asked who reads it, then
built a customer-visible consequence on the answer it did not look up. **Ask both, every
time.** A column with a writer and no reader is as inert as one with a reader and no
writer; it is merely inert in the direction that makes a report sound more urgent.

And note where the wrong claim came from: `src/config/platform.ts:33` says *"The MONTHLY
ceiling is the real control; this daily one exists to stop a single runaway day."* That
comment describes a design, and the design was never finished, so the daily cap has been
carrying the entire load alone since `0001`. **A comment asserting a control that does not
exist** — the same shape as `meta/extract.ts`'s "everything skipped is reported" in D-070,
found the same day, in a file about money rather than a file about stickers.

The ceiling row was still raised to **$28.57** as instructed (`tenant_budgets` id 3,
2026-09-15, append-only so id 2 stands as the record of what was in force before). It
changes no behaviour today and is correct for the day a month is wired.

**The real exposure is a burst day, and it is not what D-072 described.** At $0.040554 per
cold conversation, $1.50/day affords roughly **37 conversations in a day** before reception
is refused. D-016 measured a spread of 28–94 replies per day in one week, so a busy day can
reach that cap — and the failure mode is not graceful degradation, because the ladder is not
built. Whether $1.50 is the right compiled number is a money decision and is the founder's;
it is flagged here rather than changed.

### 2. ₮80,000 IS NOT A PRICE, and D-004 does not disagree with ₮250,000

D-072 and the report that preceded it said D-004 and D-015 "still derive ₮80,000" as though
that contradicted the founder selling at ₮250,000. **It does not, and the error was a
misreading.** Reception's list price in D-004 *is* ₮250,000/month. ₮80,000 is a different
quantity entirely: the allowable model SPEND at a 60% margin, computed from the **discounted
bundle floor**, and D-004 states the rule in bold —

> every ceiling must be computed from the **discounted** price, not the list price.
> Reception inside a full-team bundle is ₮200,000/month, so at a 60% margin the allowable
> monthly model spend is **₮80,000 ≈ $22.86** — and that, not ₮250,000, is the number the
> spend ceiling derives from.

So the two documents were consistent all along and needed no reconciliation. What needs
deciding is something else, and it is live:

**$28.57 applies the 60% formula to the LIST price. D-004 requires the FLOOR price.**

| base | revenue | 60% margin allows |
|---|---:|---:|
| list, standalone (₮250,000) | $71.43 | **$28.57** |
| full-team bundle floor (₮200,000) | $57.14 | **$22.86** |

At a $28.57 ceiling, a Reception sold inside a full-team bundle runs at **50%** margin, not
60%. D-004's floor rule exists precisely so a ceiling is not sized against a price some
customers will not pay. Restating D-072's cost table against both bases:

| turns/conversation | cost/month | margin on list | margin on the bundle floor |
|---|---:|---:|---:|
| 2.2 — measured | $17.92 | 74.9% | 68.6% |
| 4.6 — D-016 ÷ 400 | $21.32 | 70.2% | 62.7% |
| 6.0 — D-016's A7 | $23.30 | 67.4% | **59.2%** |

**The price is sound on either base** — only the highest turns-per-conversation inside a
full bundle misses 60%, and by 0.8 points. What is unresolved is the ceiling: $28.57 is
correct for a standalone sale and 25% above what D-004's floor rule permits. That is a
pricing call, not an engineering one, and it is the founder's. The row stands at $28.57
because he set it; this is the note saying which rule it departs from.

---

## D-073 — the public surface could not be rehearsed, and the corpus it will produce is half a corpus

**2026-09-15, founder:** *"I'm not going live on a public surface without the corpus that
caught D-066 and D-068 on the private one."*

### What was wrong

`canDeliver` has answered two questions since it was written — `shadow` is
`{ generate: true, deliver: false }`, meaning *decide the reply, write it down, withhold
it*, and `off` is false for both. `worker/reception.ts` reads both halves and that is
exactly what produced Matrix's fourteen mirror days.

`runCommentJob` read only `deliver`, and returned **before** `draftOnce`. So a mirroring
channel produced refusal counters and no rows at all.

Note which surface that left unrehearsed. The DM mirror found D-066's gate-label leak,
D-068's thrown-away booking reply and D-069's label promising an address over a telephone
number — **three defects no test produced**, on the surface where a mistake is private,
one customer sees it, and it can be followed up. The comment surface, where a mistake is
public, permanent, screenshot-able and under the tenant's own post, had no rehearsal mode
whatsoever. The capability existed one function call away and was being thrown out by a
boolean.

### The fix, and where the withhold sits

`!generate` refuses early as before. `!deliver` now sits **after** `draftOnce` and after the
two in-entry counters that carry the thread rule and the per-post cap, so a shadow run
exercises those rules rather than stubbing them: what the corpus shows is what going live
would actually have done, which is the only version worth reading. The row stays `draft` and
therefore claimable, exactly as a withheld DM does.

### And the part that is NOT solved by this change

**The comment's own text is never persisted anywhere.** `extractComments` returns it,
`decideCommentReply` deliberately never receives it — that is the feature's whole safety
argument — and no layer in between writes it down. There is no `messages` row for a comment
and no equivalent table.

So the only place a customer's comment exists in words is `webhook_events.raw_payload`, and
`ops.purge_expired` nulls that past the tenant's `retention_days_raw_events`, which is **7**
for both tenants, deleting the row entirely at 30 days. The purge runs hourly.

**A fourteen-day comment mirror therefore records what we would have SAID for ever, and what
they SAID for seven days.** The draft rows carry the reply body, the post id and the thread
id permanently; the questions that produced them age out halfway through the window.

That asymmetry is fine for validating the machinery — the thread rule, the per-post cap, the
loop filters, the volume of the `feed` firehose are all visible in rows and counters. It is
not fine for the decision the mirror is being run to inform. **Option B — gate on intent,
reply with the fixed line — is a judgement about which comments deserve an answer, and that
judgement can only be made against the comments themselves.**

Three ways out, none taken here:

1. **Raise `retention_days_raw_events`.** One row, immediate, and it caps at 30 by its own
   constraint — so even the maximum only just covers a fourteen-day window plus reading time.
   It is a retention decision about a third party's customers' content and it is the
   founder's.
2. **Persist the comment text beside the decision.** The honest fix and a schema change,
   which means a migration, which the founder pushes. It also means deciding what a comment
   is in this data model, which is a real design question and not a column.
3. **Accept seven days as the sample.** Plausible: comment volume is entirely unmeasured —
   zero `feed` entries have ever reached this platform — so seven days may be more than
   enough, and may equally be nothing at all. That is not knowable in advance, which is an
   argument for (1) as cheap insurance rather than for (3) as a plan.

### What still gates the mirror starting

The split makes shadow possible; it does not make it happen. In order: App Review for
`pages_read_user_content` + `pages_manage_engagement`, the Page subscribed to `feed`,
`comment_policy` set to `public_only`, and **a reviewed `comment_public_reply` row** — Matrix
has eleven canned kinds and that is not one of them, so until the founder writes it every
comment refuses `no_reviewed_line` and the mirror drafts nothing. `delivery_mode` stays
`shadow` throughout, which is now a meaningful state on this path rather than an alias for
off.

---

## D-074 — a URL slug became an approved price, and two bugs hid each other

**2026-09-15, found on a routine check-in after the founder republished Matrix.**

Revision seq 4 went live at 19:46 UTC carrying the Maps link. `allowed_numbers` grew from
**twelve tokens to thirteen**, and the thirteenth is **`9`**.

It came from the slug of `https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9`. `allowedNumbersFrom`
extracted numerals from the whole rendered section text, links included, so a URL widened
the list of numbers the model is permitted to say. Nobody approved a `9`.

### The half that makes it interesting

A reply QUOTING that link carries the same `9`. So check 2 of the outbound guard saw a
numeral in the reply — and passed it, **because the allow-list had been widened by the very
same slug**. Two defects, exactly cancelling.

That is worth stating as a rule, because it is how both would have survived a review: **a
bug that only manifests when its twin is fixed is invisible to any test of either.** Remove
the allow-list leak alone and every reply quoting the salon's own location starts being
refused as an invented price — which is D-068's shape a third time, and D-071's second:
a reply punished for using the tenant's own approved data. I would have caused it.

### And one half was already broken, with nothing to cancel it

Check **2b** is handed an EMPTY allow-list on a refused topic, deliberately — on a topic Ш1
forbids quoting a price for, no provenance rescues a numeral. So no accidental widening
could ever have helped it: quoting the location in a reply about children's services was
refused as `outbound_refused_topic_price`. A map link read as a price. That one was live
from the moment the link entered the prefix, and `quality_flags` would have filed it under
price, sending a reader to the allow-list for a defect that has nothing to do with numerals
— exactly the misattribution D-066 is named for.

### The rule, stated once and applied to every side

**A URL is validated as a URL, and its characters are never content.** `urlsNotAllowed`
permits the tenant's declared links and refuses all others, whole; nothing downstream reads
their digits. `maskUrls` implements it and is applied in three places — the compiler's
`allowedNumbersFrom`, the guard's reply check (covering both 2 and 2b), and the customer-echo
set, because a customer who pastes a link has not approved the digits in its slug either.

Masking to a SPACE rather than to the empty string: splicing the text either side of a link
together would manufacture a numeral that was never written, which is the mistake
`disclosesPrompt` documents about its own corpus. Same trap, third file.

### What this does not change

The price guarantee's footing is untouched. It still rests on `extractNumerals`' digits-only
reduction and on the comparison being an exact match rather than a substring test — `20` does
not license `20,000`, `7741-7777` does not license a bare `7741`. This removes a numeral that
was never a tenant fact; it loosens nothing. The one behaviour it restores is a reply's right
to quote a link the tenant declared.

### It is not live until the next publish

`allowed_numbers` is compiled, so seq 4 still carries the `9` and will until Matrix is
republished. That republish is also owed for a separate reason — see below — so one run
clears both.

### The republish that produced this also missed the labels, and the instruction was wrong

Seq 4 carries the Maps link and **not** the Mongolian contact labels: the prefix still reads
`- phone: 7741-7777`, and `- Утас:` and `- Байршлын холбоос:` are absent. +54 characters is
exactly a `- maps_url: <url>` line with the English key.

The cause is that `scripts/publish/tenant.ts` **runs on the founder's own machine and imports
from his checkout**. The instruction given was "deploy the code, then republish", which is
right about the runtime guard — `urlsNotAllowed` must be serving the widened allow-list
before the prefix can carry a link it would refuse — and silently wrong about the compiler,
which is local. A publish renders with whatever `src/` the operator has, not with what
Vercel is serving.

**So the correct order has three steps, not two: deploy, `git pull`, publish.** Recorded
here because the two-step version reads as complete and is the kind of instruction that gets
followed exactly.

---

## D-075 — prices leave the model's reach, and the matcher measures what that costs

**2026-09-15, founder's call after D-074's service-binding gap.**

D-074 left a question rather than a fix: `allowed_numbers` is a SET, so the guard checks
that a numeral is on the tenant's list and never that it belongs to the service under
discussion. «Омбре 33,000₮» — a 500,000–640,000 service at a haircut's price — passes every
check. A real price against the wrong service is more plausible to a customer than an
invented one, and therefore worse.

**Decided: prices never enter `allowed_numbers`, and never enter the prefix.** The model
keeps the job it is good at — recognising which service a customer is asking about — and the
platform serves the price line from the row, exactly as `gate/pinned.ts` discards the
model's text and serves a reviewed row's own bytes (D-065). The guard is unchanged and
still refuses every price numeral, so the two stop competing: a wrong price becomes
inexpressible rather than checked.

This is not an invention. `0001` says it above `service_variants`, and has since the schema
was written: *`none` means there is no price and the compiler emits the service name plus a
bound refusal and NO NUMBER ANYWHERE — a price that is not in the prompt cannot be quoted,
which is stronger than any rule forbidding it.* The mechanism was designed, written down,
and never built.

Rejected: teaching the guard the pairing. It needs a migration (`allowed_numbers` is
`text[]`), a matcher that does not exist, and it **fails hardest where the list collides** —
for «Сор» the relational check degrades to the union of both services' tokens, which is the
flat allow-list again. Paying for structure and getting no protection on the two cases that
motivated it.

### Step 1, built: the matcher

`src/lib/services/match.ts`, plus `scripts/seed/matrix-service-aliases.sql`. No prices, no
Mongolian, no rendering — it returns a service id and a verdict.

The rule is **every token must occur, most specific wins**. Matching on ANY token makes
«Сор» and «Оффис колор /Сор/» permanently indistinguishable, because the first name's only
token is a subset of the second's. Requiring all tokens separates them, and
most-specific-wins is `0018`'s selection applied to names instead of prompt blocks.
Ambiguity is a VERDICT, never a tie broken silently: a confident wrong service is the exact
failure the mechanism exists to prevent.

### What it measured

**«Сор» cannot be separated in the direction that matters, and no row repairs it.**
Mechanically the rule works — «сортой будаг» reaches only «Сор», «оффис колор сор» reaches
«Оффис колор /Сор/». But the separation only ever fires on the word «оффис», which is the
case that was never ambiguous. A customer naming only «сор» is unresolvable, and that is
the **one instance in the corpus**: «Эмэгтэй сортой будаг хийлгэх гэсийн», 2026-09-14
08:48:29. Right answer 120,000–190,000 or 380,000–460,000, 3.2× apart, and nothing in the
message decides it. **The repair is a rename, upstream, by the salon.**

**The three CICA names DO separate, at two tokens or more.** «cica эмчилгээ» → «CICA
эмчилгээ»; «CICA нөхөн сэргээх эмчилгээ» → itself; «хими эмэгтэй cica» → «Хими эмэгтэй /
CICA». Bare «cica» reaches none of the three, which is the safe answer. The caveat is not
the matcher's: one of the three is the row the salon may say does not exist, and the
matcher will route to it confidently.

**A one-token match on a short stem is not evidence.** `mn/match.ts` accepts over-matching
by design, and «Сор» is a three-character one-token name. Measured: «сорри» — a customer
apologising — reaches the service, as do «соронз», «сорил» and «сорох». So the caller needs
a specificity floor; at two tokens the corpus's one Сор instance correctly becomes *ask*
rather than a 3.2× underquote. That floor belongs above the matcher, which reports the
token count for exactly this reason.

**A collision nobody had asked about.** `subsetCollisions` found a third:
«Тэжээл» (44,000–88,000) is a subset of «CMC тэжээл» (132,000). Same shape as «Сор», same
lack of repair, and it was not in the two the founder flagged — which is the argument for
the check existing rather than the pair being handled by hand.

**And a canonical name whose qualifier customers do not say.** «Оффис колор /Сор/» requires
«сор» as a token, so the natural «оффис колор» reaches NOTHING until an alias says so. That
is what alias rows are for, and it is the strongest argument in the file for having them.

### Why the seed is not applied

The `services` table's eight rows and the confirmed price list **disagree about the names**,
and an alias points at a `service_id`. Four match exactly (Афро хими, Омбре, Сор, Шулуун
хими); «Office өнгө» is «Оффис колор /Сор/» on the list; «CMC тос» is «CMC тэжээл»; «CICA
эмчилгээ» is neither CICA entry; and «Эмчилгээний хими» is on the list nowhere and is
nearest to the name the salon said does not exist. A rename or a delete moves the id the
alias would point at, so section 2 of the seed is held — for that reason, and not because
the spellings are in doubt.

---

## D-076 — a photograph got silence, and the bot we replace answers it

**2026-09-16.** D-070 built the instrument and argued the case in the abstract. Between
2026-09-15 11:59 and 2026-09-16 00:17 it caught the case four times: `inbound_dropped` rows
carrying `attachments: ["image"]` and **no `sticker_ids`**. Four real customers sent a
photograph to a hair salon and got nothing. A fifth drop, 2026-09-15 11:37, was sticker
`369239263222822` — the thumbs-up — and dropping that one is right, which is the whole
reason the discriminator had to be the payload's `sticker_id` rather than `type`.

**The ancestor answers these and has for weeks** (`Matrix-Chatbot` PR #27: one fixed line
saying it cannot see pictures, asking for the request in words). So this was not a gap in a
new product; it was a **measured regression against the bot this platform replaces**, on the
surface that matters most at a salon.

`inbound/imageReply.ts` ends it. The reply is one reviewed `canned_responses` row served
whole — the model is never consulted, so nothing can be inferred from a picture it cannot
see, which is the ancestor's reasoning and D-065's. `0026` adds the `image_received` kind;
the sentence itself is founder-gated Mongolian and the path **refuses to serve an unreviewed
row**, so the code is inert until the reading evening.

Three rules, each load-bearing and each tested: a skip with ANY `stickerIds` is never
answered whatever its `type` claimed; at most one reply per sender per entry, and a
ten-minute look-back for a burst spread across separate events (two of the four real drops
were 82 seconds apart); and the look-back **fails open**, because repeating ourselves is
much better than returning to the silence this file exists to end.

**Not covered, deliberately: a photograph WITH a caption.** It carries text, so `extract`
does not skip it and the model answers the words alone. The ancestor treats a captioned
photo as a photo — *"the caption is almost always about the picture, and answering the words
alone is exactly how an unseen image gets quoted."* Ours does not. That is a live divergence
and it needs the founder, because closing it means routing text-bearing messages away from
the model.

**Note before adding a row: `refusal_out_of_scope` is already reviewed and already about
pictures** — «Зураг харж зөвлөгөө өгөх боломжгүй…». It could be wired today. What it does
not do is invite a description, and it routes to a phone a customer told us went unanswered
for two days. Both are reasons for a second line, not reasons the first is wrong.

---

## D-077 — one space at the end of an approved sentence refused a better answer

**2026-09-16 11:26:29.** The model wrote «Шулуун химийн үнийн мэдээлэл надад байхгүй байна.
Та 7741-7777 дугаараар холбогдож лавлана уу.» plus the location. The approved row says
«Уучлаарай, **энэ үйлчилгээний** үнийн мэдээлэл…». Naming the service the customer actually
asked about is **better than the row**, and `outbound_disclosure` threw the whole reply away.

Measured per approved line: of the reply's 104 windows, 23 were in the corpus and 22 sat
inside `refusal_price_unlisted`. **The single offender was the approved sentence to its last
full stop plus ONE SPACE** — `"…байхгүй байна. та 7741-7777 дугаараар холбогдож лавлана уу. "`.

This is D-068's boundary at the other end. The exemption is built per line, so it can never
contain a window reaching past that line's last character; the corpus holds the line in
context and does. `segmentsAroundCanned` was the patch for exactly this, and it could not
fire, because it cuts at EXACT occurrences and the model had adapted the opening. So the
two mechanisms have a gap between them that only an adapted-and-continued line falls into —
which is to say, the most natural helpful reply there is.

**The fix is one space at each end of the exemption**, padded with the separator `foldFlat`
itself would have produced. The give, stated plainly: a disclosure must now consist of sixty
characters that are not an approved line bordered by whitespace. Both real incidents are
pinned as tests — the leading space from 2026-09-14 and the trailing one from 2026-09-16.

**Two things worth carrying beyond the fix.**

First, the diagnostic that missed it. The initial check joined the canned bodies into one
string and matched against that, which manufactured a window spanning two unrelated lines
and reported **zero offenders** — the exact splice `disclosesPrompt` refuses to perform on
the corpus, and its docstring explains why, committed inside the tool used to investigate
it. The conclusion drawn from it was reported to the founder before it was checked per-row,
and it was wrong.

Second, and still open: **the adaptation was counted nowhere.** `checkPinnedLines` rejected
the reply on `MIN_LENGTH_RATIO = 0.8` before computing similarity, because the reply is
longer than the row — which is that constant working as designed, to stop a long correct
answer being replaced by a refusal. So no `canned_paraphrased` flag was written and the
drift is invisible. D-065's rule is that a near-copy is an unreviewed sentence carrying an
approved one's meaning; here the near-copy was an IMPROVEMENT. Whether an embedded
adaptation should be corrected, counted, or allowed is the founder's call, and it wants the
native speaker rather than a threshold.

### D-077 addendum — an adapted line is drift, and the founder chose exactness

**2026-09-16, founder's call.** *"A near-copy of an approved sentence isn't the approved
sentence — the mechanism only means anything if it's exact, and «би» dropping today is a
rewrite tomorrow. If the row's wording is worse than what the model produces, fix the row."*

So the gap D-077 found is closed rather than left open. `embeddedAdaptation` asks two
**exact** questions of each reviewed row, deliberately avoiding a similarity score inside
the mechanism that decides whether an approved sentence was altered:

  1. does the reply contain the row WHOLE? → an exact quotation, left alone;
  2. otherwise, does it share ≥ `EMBEDDED_MIN_SHARE` (0.6) of the row and at least
     `EMBEDDED_MIN_RUN` (40) characters? → drift: counted as `canned_paraphrased`, and the
     row is served in its place.

Proportional because the rows differ in length, with a floor because Matrix's rows share a
36-character closing sentence — «Та 7741-7777 дугаараар холбогдоно уу.» — that a reply may
legitimately end with without having reproduced any row.

Both real incidents pin it: 2026-09-14's «tsag avii» reply quoted `booking_line` exactly
inside a longer sentence and is left alone; 2026-09-16's adapted `refusal_price_unlisted` is
corrected.

**The cost, stated rather than discovered later.** Serving the row discards the rest of the
reply — `handleReception` never edits a reply and this keeps that line. In the 11:26 case
the customer loses the location link that followed the adapted sentence. That is the price
of exactness, and it was chosen knowingly.

**What it does not solve, and the founder named it:** `refusal_price_unlisted` says «энэ
үйлчилгээний» where the model wrote «Шулуун химийн». The model's version was better because
it named the service the customer asked about, and **a static row cannot do that.** "Fix the
row" therefore has a floor: the row can be reworded, but naming the service needs a template
with a slot, which is machinery this platform does not have. Recorded as the open question
rather than quietly not done.

### D-076 addendum — the approved image line, and the first refusal that does not end at the phone

**2026-09-16, founder's approval:**

> Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.

«бичвэл» over «бичиж өгвөл» (every reply has to be brief); all three prompts kept (a
customer who does not know what to write needs the examples); «харах боломжгүй» because it
is about the assistant and it is true.

**And no phone.** This is the first refusal row that does not end at 7741-7777, and the
reason is the corpus: on 2026-09-15 a customer wrote «Утсаа авахгүй байна» and then «2 өдөр
залгаж байна», and on 2026-09-16 another asked for a human rather than an AI. *"The point is
keeping them in the conversation, not sending them to a number nobody answered for two
days."* Every other refusal row still ends there, so that remains the platform's escape
hatch — this one deliberately does not use it.

Wiring the already-reviewed `refusal_out_of_scope` was rejected for the same reason: it
would have shipped without a reading evening, and it both fails to invite a description and
ends at the phone.
