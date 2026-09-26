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

**The invocation above is superseded and kept as the record of what was decided.** On
2026-09-20 `--field` became REQUIRED with no default: the command checked a transcribed
`REQUIRED_FIELD = 'messages'` under a docstring calling it "the field every
`tenant_channels` row on this platform subscribes to today", and that stopped being true
the moment Matrix's comment surface needed `feed`. It would have printed
`page/messages is subscribed and active` and exited 0 with `feed` switched off and every
comment silently undelivered — the drift the command exists to catch, inside the command.
Add `--field messages --field feed` for a channel answering comments.

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

### D-063 addendum, 2026-09-21 — the 180-minute threshold is MEASURED and stays

D-063's addendum left one thing open in bold: *"Re-derive D-016's 60.5 before anybody picks
a new number."* Here is the derivation, from `webhook_events` over the seven complete days
2026-09-14 to 2026-09-20.

**Volume.** Text DMs per day: 11, 20, 11, 16, 59, 37, 10 — **mean 23.4/day**. That is far
under D-016's 60.5, and the two are NOT the same quantity: D-016 counted the ancestor's
REPLIES from its own logs, this counts inbound text messages Dala received. They are not
reconcilable without knowing the ancestor's replies-per-message, so neither refutes the
other. What matters for a silence threshold is the gap distribution, not the daily total.

**Gaps, open hours only** (Mon–Sat 10:00–20:00, Sun 11:00–19:00, Asia/Ulaanbaatar), 76 gaps:

| p50 | p90 | p95 | max | > 180 min | > 240 min |
|---|---|---|---|---|---|
| 1.1 min | 114 min | **186 min** | 369 min | **4 in 7 days** | 3 |

**So `DEFAULT_THRESHOLD_OPEN_MINUTES = 180` sits essentially at p95 of ordinary open-hour
silence, and fires about 0.6 times a day.** It is well calibrated and **is not changed.**
Loosening it to 240 removes one firing in seven days and costs an hour of time-to-detect on
the next real outage; the eleven-day outage of D-062 is what that hour is measured against.

**Why this is not the daily noise D-063 removed**, which was the live worry: the routing
changed at the same time. This alert is `route: 'digest'` and `repeat_policy: 'on_change'`,
so an ordinary quiet afternoon is one line in a once-a-day digest and an episode that
resolves itself — not a Telegram critical, and not a new alert every morning. The measured
instance at 07:00:06 on 2026-09-21 carries exactly that: `delivered: false`, `route: digest`,
`resolved_at` null. **The threshold could only walk the noise back in if the route were
still `now`, and it is not.**

**A method note that nearly inverted the conclusion.** The first pass computed gaps over ALL
hours and reported **17** firings in seven days, which reads as a badly miscalibrated alarm
and argues for loosening it. That number counted overnight gaps — which the watchdog already
excludes, as its own alert body says («…of open time with nothing»). Restricted to open
hours the count is 4. **The wrong figure and the right one point in opposite directions**,
and the only thing that caught it was reading the alert's own wording before trusting the
query. Measure the thing the instrument measures, not the thing that is easy to select.


### D-062 follow-up, 2026-09-21 — the ancestor is the control, and it settles a silence in one query

An 8.5-hour gap with no text DM (03:56 → 12:27 UTC, mostly open hours) **exceeded the
maximum ordinary open-hour gap measured over seven days, which is 6.1 hours.** Reactions
kept arriving throughout, which proves the `feed` subscription works — and proves nothing
about `messages`, because they are different subscription fields. That ambiguity is exactly
D-062: eleven days of a dead channel that no instrument could distinguish from a quiet one.

`scripts/diagnose/meta-subscription.ts` is the designed read and needs a Meta token this
environment does not have. **The ancestor answers it instead, and for free.** `Matrix-Chatbot`
serves the SAME Page through a DIFFERENT Meta app, and its Vercel project is readable here
(`prj_CT13Uw8eCeKeW7hKOCYCqwdO6vei`). Since 04:00 UTC it received exactly **one** request:

| | |
|---|---|
| ancestor `/api/messenger` | **09:18:25** |
| our `webhook_events` id 313 | **09:18:26.739** |

The same thumbs-up, 1.2 seconds apart. **Both apps received the only DM that arrived, so our
`messages` subscription is healthy and the silence is real customer quiet.** We also received
the reactions the ancestor did not, so we are getting strictly more than it, not less.

**The method is the point.** A silence on a Page this platform mirrors is answerable without
any Meta credential: count the ancestor's invocations over the same window and compare
timestamps. Agreement in BOTH directions — it received what we received, and neither received
anything else — is what separates "nobody wrote" from "our subscription died". One direction
alone is not enough: had the ancestor logged a delivery at, say, 10:30 that we have no event
for, that single row would have been proof of a broken subscription.

Note what this does NOT license. It is only available while Matrix runs both systems; after
the cutover the ancestor stops being a control, and §3.10.5 step 2 becomes the only read.
`scripts/diagnose/meta-subscription.ts` is still the thing to build against, not a spare.

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

---

## D-078 — is the engine an engine? Audited, and the answer is split

**2026-09-16, on the founder's ask.** The architecture is meant to be one multi-tenant
codebase where a client is rows: one security fix protects everyone, one guard improvement
reaches every tenant, nothing bespoke per customer. Measured rather than assumed.

### `src/` is sound

- **No tenant identifier anywhere.** `8f2826f5-…` appears in no file under `src/`,
  `scripts/` or `supabase/`. The only hardcoded UUID in `src/` is `NIL_UUID`, the sentinel
  in `job_runs`' partial unique index.
- **No per-tenant branch.** The only `=== '…'` comparisons on tenant fields are
  empty-string guards in `worker/reception.ts` and `crypto/envelope.ts`.
- **No tenant vocabulary in code.** Every «салон»/«үс»/«хими» hit in `src/` is inside a
  comment. That is the right place for them: a docstring citing `Matrix's measured ~60
  messages/day` is the evidence for a constant, not a coupling to a customer.
- **No migration writes tenant business data.** `0019` mentions Matrix only to explain why
  `staff_members.short_name` exists, and says in as many words that no INSERT was written.
- **Scripts take arguments.** `publish/tenant.ts` reads `--slug`; `diagnose/mirror-corpus.sql`
  is parameterised on `:'tenant'` and `:'hours'`.
- **Compiled constants are deliberate and reversible.** `RECEPTION_UPSTREAM_TIMEOUT_MS` and
  `ALWAYS_ON_GATES` are platform-wide, each with a docstring saying why and — the part that
  matters — **the read site already takes the value as a parameter**, so the day a tenant
  needs its own it becomes a column rather than a refactor. `PLATFORM_TIMEZONE` is used only
  for platform-scoped counters; tenant-scoped ones follow the tenant's clock (`periods.ts`).

### Two things are not

**1. `scripts/provision/` is Matrix, not a template.** Nine hand-written SQL files —
`matrix-stage1`, `-stage3-canned`, `-stage3b-children`, `-stage4-kb`, `-stage4b-booking`,
`-stage4c-promo-date`, `-stage5-role`, `-budget`, `-cache-1h` — every one hardcoding
`'matrix-eco-salon'`, none parameterised. **There is no generic provisioning path at all.**
Client #3 does not fill in a config today; somebody writes nine more SQL files. This is the
single largest gap between the stated architecture and the built one, and it is the reason
Matrix took days.

Minor, same family: `verify/compile-tenant.ts` defaults to `matrix-eco-salon` when given no
argument, and `seed/matrix-service-aliases.sql` is tenant-specific (held, unapplied).

**2. Four platform gate blocks are written in salon language** — `sh3_booking`,
`sh5_health`, `sh6_concessions`, `sh8_not_in_kb`. This is D-033's finding, still live: the
first reply this platform ever sent invented a beauty salon for a software tenant because
«салон» was the only business-type noun in its context.

**The mechanism to fix it is built and inert**, which is the important half. `0018` plus
`prompt/sections.ts`' most-specific-wins selection means a platform block may be written per
vertical, and `prompt/drafts/` already holds `.salon.` and `.software.` variants of the two
worst blocks. Nothing is signed, so nothing is published. **So this is a CONTENT debt, not a
code debt, and it is per-VERTICAL rather than per-CLIENT**: client #4 in a vertical already
written for is pure rows; a new vertical costs one reading evening, once, for everyone in it.

### The verdict, plainly

**The engine is real where it is hardest to fake — the reply path, the guards, the schema.**
A security fix there does protect every client. What does not yet exist is the *on-ramp*: the
path from a signed customer to a provisioned tenant is nine bespoke SQL files and a founder's
evening. The architecture is sound and the tooling around it is not finished, and those are
different problems with different fixes.

---

## D-079 — The provisioning pipeline, and three things building it found

**2026-09-16. Founder: "Build the pipeline as designed. Two gates, `subsetCollisions`
before a customer hits «Сор», incompleteness as a recorded state with a readiness line in
the digest."** Built to `docs/provisioning.md`, which now describes what exists.

A filled questionnaire becomes an intake document, the document is read (refusing rather
than guessing), validated against the checks that already existed, written as rows by an
idempotent dry-run-by-default script, and where it stands is recorded. Two signatures are
required and neither can be forged from inside the pipeline: the **client's**, on the facts
(`confirmedBy`, landing on `service_variants.confirmed_at`), and the **founder's**, on the
words (`canned_responses.reviewed_at`, which nothing here writes).

### Incompleteness needed no new table, and that is the interesting part

The design assumed one. `alerts` has carried the right model since `0025`: `route: 'digest'`
puts a row in front of a human at 09:00 without a Telegram — which matters, because Telegram
is shared with Core Language's customers — and `repeat_policy: 'on_change'` is an **episode**
that opens, holds and resolves.

D-063's question is "does this condition recur, or does it persist?" A tenant waiting on its
price list does not become newly incomplete every morning; it is the same fact, continuing.
So the key carries no date, the digest lists it because it is an open episode, and
`digest.ts` was not touched at all. **The mechanism built for a dead channel fits an
unfinished tenant exactly**, and noticing that was worth more than the table would have
been: no migration, so nothing waits on a push, and D-058's asymmetry never arises.

One ordering rule inside it is load-bearing and is not obvious. `alerts_dedup_hourly` is
unique on `(kind, dedup_key, hour)`, so a tenant returning to a state it held earlier the
same hour gets 23505 and `suppressed_duplicate`. Resolving the other episodes on that
outcome would leave the tenant with **no open episode at all** — and an absent readiness
line reads exactly like a ready tenant. So: raise first, and resolve the others only if the
raise actually left an episode open. **Stale by up to an hour beats invisible**, because
invisible is indistinguishable from finished.

### An `ask_client` finding had to be able to hold `ready`

As designed, only blockers held provisioning. So a document with an unresolved «Сор»
collision reached `ready` — the exact failure the check exists to prevent, one layer up,
and it would have passed its own test suite. The founder's instruction was specific:
*before* a customer hits it.

`Finding.holdsReady` is the fix, and the criterion is **consequence, not severity**: set it
when a wrong answer could reach a customer while the question is open. A service-name
collision qualifies — the matcher returns `ambiguous`, and D-075's whole point is that a
real price against the wrong service is more plausible, and therefore worse, than an
invented one. A missing Latin stem does not: a rule that fails to fire leaves the model
answering unrefused, which the outbound guard still bounds. Writing the rule into the type
rather than into a list of codes is deliberate — the next check gets asked the question.

### The reader was accepting unknown keys, and casting rather than building

Found by writing the worked example, which is the argument for shipping one. Two defects,
one line apart:

`return { ok: true, doc: raw as unknown as IntakeDocument }` handed the writer whatever else
was in the file, unexamined, under a name asserting it had been checked. That is **D-057
wearing a type annotation** — a validator answering with the part it managed — and TypeScript
cannot see it, because the cast is the programmer promising it is true.

And an unrecognised key was silently ignored. A client questionnaire exported with
`never_say` instead of `neverSay` parses perfectly, yields an **empty rule list**, and the
bot then discusses the one topic the business said it must never discuss. Nothing is red;
the document reports as valid. It is `hasTenantData`'s shape (a guard that cannot fire) and
`replied_at`'s (a field nobody writes), arriving at the front door instead.

The document is now built field by field from what was validated, so what the writer sees is
exactly what was checked. Unknown keys are reported and name the fields that were probably
meant; `_`-prefixed keys are deliberate annotations and are dropped.

### What it does not do, and must not learn to

It does not approve Mongolian, publish, infer a missing fact, or resolve an ambiguity. The
sheet it prints has no database handle by construction — it takes a document and returns
text — so there is no version of it that could set `reviewed_at`. A sentence edited later is
written back **unreviewed** and the tenant stops replying until it is signed again: an
edited sentence is an unreviewed sentence, which is D-065 stated for the writer.

Unchanged bodies are left completely alone. Writing one back would clear a signature for no
reason — the same defect pointing the other way.

### The example is an auto-service tenant on purpose

`intake/example-auto.json` is in a vertical this platform has never served, and a test
asserts no salon vocabulary appears anywhere in it. That is the cheapest ongoing proof of
the standing rule D-078 recorded: **a client is rows, never a repo, never a branch, never a
code path.** It also ships deliberately incomplete — a name collision and a rule pointing at
an absent sentence — so a reader sees the validator speak rather than reading a claim about
what it would say, with a test pinning both faults so the example's own comment cannot
become a lie.

---

## D-080 — Thread control: the inbound half, and the trap that would have silenced the mirror

**2026-09-17. Founder: "Build the inbound half — `thread_control`, the
`messaging_handovers` handler, the echo subscription, H11 check 4. Nothing outbound,
nothing touching the live Page."** Built to §3.7, which had reserved exactly this seam.

`conversations.state` has allowed `awaiting_human` and `human_handled` since `0001` and
**nothing writes either** — they appear in one place, `persist.ts`'s `OPEN_STATES`, where
they read as "still open". D-064's shape again: a value that reads as a safety signal for
as long as nobody tests it. So the product bug underneath was live and uninstrumented — a
receptionist answering from Business Suite while the bot answers the same customer in
parallel, and nothing anywhere recording that it happened.

### The trap: echo detection would have destroyed the fourteen days

This is the finding worth carrying, because it is invisible from the feature's own
description and obvious once stated.

An echo is "an outbound message on this thread whose `mid` is not one of ours", and the
inference is "therefore a person typed it". On Matrix's Page that inference is **false in
the ordinary case**: the ancestor is live there answering customers all day, while Dala AI
is in `shadow` and has never sent anything, so `provider_message_id` is null on every draft
this platform has ever written. **Every ancestor reply is an echo that is not ours.**

Wired the obvious way, day one marks every active conversation `human`, H11 check 4
silences the mirror on precisely the conversations worth measuring, and the fourteen days
produce nothing — while the symptom is indistinguishable from a quiet afternoon, which is
the failure class D-070 and D-060 are both about.

So an echo moves control **only where `delivery_mode = 'live'`** — where our sends are the
sends, and "not ours" therefore means "not the bot". Elsewhere it is counted and nothing
moves. Note the general shape: **a detector built on "not ours" is only sound where we are
the only one of us**, and during a mirror phase we are not.

### `unknown` as the default and the narrow gate are ONE design

`bot` would have been the convenient default and is a claim this platform cannot support:
nobody has read the far side of a Meta thread, and D-062 is eleven days of that mistake.
D-063's addendum is the rule — a migration adding a discriminator with a default is
retroactively deciding the semantics of every row already there, and those rows are the
ones that motivated the change.

So the default is `unknown`, and **H11 check 4 refuses on a positively-established `human`
and nothing else.** Neither half is safe alone: the honest default only works because the
gate is that narrow, and widening the gate to refuse on `unknown` mutes every tenant at
once. `control.test.ts` pins both halves against each other for that reason.

An unreadable lookup concludes nothing, anywhere. `controlFromEcho` is a tristate:
concluding `human` from an unreadable table would silence a tenant on a database blip, and
concluding `bot` would let it talk over a receptionist. Undetermined is a result (D-057).

### `app_slug` is not an app id, and nothing stored the real one

A handover event names apps by Meta's numeric id. Nothing in the schema had one —
`app_slug` names a **callback path on this platform**, not an app at Meta, which is D-041
stated forwards, and tenant #0's slug says `dalatech` while its Page lives in `DALA_AI`.
`tenant_channels.meta_app_id` is new, nullable, and only the console can fill it. NULL
makes every handover verdict `unknown`, which changes no state — correct, and visibly
incomplete rather than quietly wrong.

### What is NOT built, and the shape nobody could verify

No Graph call. `pass_thread_control` and `take_thread_control` are absent: passing control
is a live mutation of a real salon's thread ownership, it cannot be rehearsed during a
shadow mirror, and the receiver configuration on Matrix's Page is unknown — the founder is
establishing it before anything is written.

**`developers.facebook.com` is 403 through this environment's egress proxy (measured
2026-09-17, `curl` via the CONNECT tunnel).** So the delivery shape of a handover event is
unverified here. `parseHandoverEvents` searches both plausible containers and, crucially,
**counts what it could not classify**; the worker logs `handover_unrecognised`. That
counter is the instrument — the first real handover event is what settles the shape, and an
entry carrying a handover key we could not read is the most informative thing this path can
emit. An unverified claim is not a fact to inherit (CLAUDE.md), so none of it is written as
one: `docs/handover.md` carries a table of what is unverified and why.

`prompt/drafts/handover_and_reclaim.mn.txt` holds the two customer-visible sentences — the
handover notice and the reclaim — with two options each and four questions. The
`canned_response_kinds` rows land WITH the outbound half rather than now: a kind nobody
serves is D-064's dead column in another table.

**The reclaim is not an enhancement to add later.** The founder's motive is a phone that
went unanswered for two days; a handover into an inbox nobody reads is the same failure
with better plumbing, and worse, because the customer gets silence from a bot that has
deliberately stopped talking. It ships with the pass or the pass does not ship.

---

## D-081 — Brevity as a platform rule, and the seeding trap publishing it exposed

**2026-09-17. Founder: "Option B. Every tenant, new file, as you've reasoned it."** After
measuring that replies were too long, that the cause was not verbosity, and that the
ancestor already had the rule.

### The rule, and why the tail rather than the mean

54 model drafts: **median 138 chars, p90 364, max 768**, 39% over 200, 44% carrying line
breaks. The median is fine. A rule aimed at the average would make good short answers curt
and fix nothing. Reading the four longest drafts, the behaviour is **catalogue-answering**:
asked about greasy hair, the model explains CICA, then the course schedule, then
эмчилгээний хими, then advises a specialist, then gives the phone — 768 characters
answering a question nobody asked. So the rule leads with *answer only what was asked* and
*ask one question instead of listing options*, not with "be brief".

The same reading found the model emitting markdown — «**CICA эмчилгээ**» — which Messenger
does not render, so the customer sees the asterisks. A visible defect nobody had looked for.

`prompt/platform/02_style.mn.txt`, 431 chars, ordinal 2 (after the preamble and the data
marker, before the Ш gates). `vertical` NULL: brevity is a fact about how a person reads a
chat message, not about hairdressing. **`RECEPTION_MAX_TOKENS` is not the lever** — hitting
it is terminal in `model/reception.ts` and the partial text is discarded, so lowering it
converts long answers into refusals.

**The carve-out is load-bearing.** The block opens by exempting «БЭЛЭН ХАРИУЛТ». Without it
"be brief" reads as licence to trim an approved sentence — precisely the drift D-065
measured (the model dropping «би») and D-077 measured (adapting `refusal_price_unlisted`).

### Third regression against the ancestor in a week

`Matrix-Chatbot`'s `lib/salonBrain.js:91` has carried «Хариултаа товч, ойлгомжтой,
Messenger-т тохирсон байдлаар бич» for weeks. Recorded in CLAUDE.md as a standing rule:
**when the incumbent has a rule we do not, that is a measured loss, not a theoretical gap** —
with the cheap reading that would have caught all three (D-067 Latin, D-076 photographs,
this): read the ancestor for the RULE, not only for the architecture. Its defect list has
been read carefully; its *prompt* had not been.

### What publishing it exposed, which is the larger half

`generate-seed.ts` wrote into `0010_prompt_blocks_seed.sql` — **applied to the project**.
Running it rewrote an applied migration; `db push` never re-runs one, so the row would have
reached no database while the repo disagreed with what ran. And it was worse than stale:
**`0010`'s `on conflict (block_key)` cannot be applied at all since `0018`** replaced that
index with one over `(block_key, coalesce(vertical, ''))` — measured, PG 16.13, «there is
no unique or exclusion constraint matching the ON CONFLICT specification». The regenerate
path produced SQL that fails.

The tool's own docstring already said an applied block "needs a new migration too — the
generator cannot express that". **Fourth instance of a comment asserting a control nobody
built** (`meta/extract.ts`, `config/platform.ts:33`, `preflight`'s `WORKER_PUBLIC_URL`). The
replacement is a structure, not a sentence: the writer allocates `max(prefix) + 1` and uses
`writeFileSync(..., { flag: 'wx' })`, an EEXIST from the operating system. There is no
`--force`.

**Convergent, never delta** — the load-bearing choice, and it came from the adversarial
pass killing the delta design. A delta computes "already seeded" from the REPO, so a missed
push is permanent AND self-concealing: the generator finds the block in the unpushed file,
excludes it from every future delta, and reports "nothing changed" for ever. A full-set
upsert self-heals; the repair is the ordinary next commit. Measured cost of convergence:
zero — `prompt_blocks` has no triggers and no `updated_at`.

**A live collision, deleted rather than patched.** `VERTICAL_SEED_PATH` pointed at a
per-vertical seed numbered **0019** while `0019_staff_short_name` is applied under that
number. The first per-vertical block ever signed would have written a second 0019 — and the
four gate blocks waiting on the reading evening are exactly that case. Generic and
per-vertical blocks are now one family in one file.

### A row in `prompt_blocks` is not a publish

The finding that changes the operator's model. `compileStablePrefix` reads `prompt_blocks`
at COMPILE time; the reply path serves frozen `config_snapshots` bytes via
`tenants.live_revision_id`. Pushing the migration only puts the text where the compiler can
see it — **the republish is what publishes it**, per tenant. If the migration is pushed and
nothing is republished, the block reaches nobody and nothing goes red.

`scripts/publish/tenant.ts` now refuses before compiling unless the LIVE platform blocks
equal the signed set. It is the only check in this repository that reads the project rather
than a database CI built out of the repo, and it is on the only path that can change what a
customer reads. It also repairs a confirmation inversion: «byte-identical to the live one.
Nothing to publish» is exactly what a silently-missing block printed, and that sentence is
only true with this check ahead of it.

**Named and NOT built:** `platform_hash` on `config_snapshots` surfaced as a D-063
`on_change` digest episode, which is what would make "pushed but never republished" go red
on its own. A second PR. Until then the staleness signal is a human running the publisher.

---

## D-082 — The surface is not the provider, and the leak was not the line we blamed

**2026-09-17.** Two defects the founder found by reading the day's corpus himself, one of
which was attributed to the wrong sentence by both of us.

### 1. «СУВАГ: facebook_page» — a provider name answering a question about visibility

Ш0 asks the model exactly one question: «Энэ хариулт НИЙТЭД ХАРАГДАХ сэтгэгдэл (comment)
мөн үү?» — *is this reply a publicly visible comment?* `worker/reception.ts:419` handed the
volatile block `channel: 'facebook_page'`, a hardcoded literal, and Facebook carries both a
public wall and a private inbox. The provider's name cannot answer the question, so the
model resolved the ambiguity itself, and it resolved it wrong.

Measured on 2026-09-17:

| | |
|---|---|
| 04:14:47 | `outbound_gate_label` — «Ш0 (сувагны шалгалт) — энэ нь **нийтэд харагдах Facebook page коммент** боловч…», written to a customer in a DM |
| four drafts | `refusal_public_channel` served on DMs: «Хувийн мессеж бичвэл хариулна» — *write me a private message* — to people who had |

Verified against the live project: **all sixty-one outbound rows this platform has ever
written are `kind = 'reply'` with a null `comment_post_id`.** No comment conversation has
ever existed, so every one of those refusals was wrong, and none of them could have been
right.

`VolatileInput.channel: string` is now `surface: 'direct_message' | 'public_comment'`, and
the labels are phrased in Ш0's own vocabulary so that what the model reads is recognisable
as an ANSWER rather than a fact it has to interpret:

```
СУВАГ: хувийн зурвас (зөвхөн энэ хэрэглэгч харна, нийтэд ХАРАГДАХГҮЙ)
СУВАГ: нийтэд харагдах сэтгэгдэл (comment) — хэн ч харж болно
```

**It is a union rather than a string, and that is the fix rather than a tidiness.** The bug
was not that somebody chose the wrong string; it was that the parameter accepted one. The
old value no longer type-checks, and the change caught every caller in the repository at
compile time — there was exactly one.

L4 is rendered per request and never cached, so **this moves no `content_hash` and needs no
republish.** The labels are prompt scaffolding the model reads and no customer sees, which
`volatile.ts` has said in its own docstring since it was written; they are code, not a
`reviewed_at` row.

### 2. The picture leak, and why `image_received` was the wrong suspect

The founder's second finding: a text-only message answered with «зурган дээр үндэслэн» —
*based on a picture*. His reading, and mine before his, was that the image line approved on
2026-09-16 had entered the cached prefix and was leaking. **That was wrong, and the way it
was wrong is the part to carry.**

The conversation, read off the live project:

| | |
|---|---|
| 02:06:57 | inbound: «Hi vsnii ongo oorchlowol zohih ongiin songoj ogohvv» — *if I change my hair colour, will you pick a suitable one for me?* Latin script, no picture word in any script |
| 02:07:23 | draft: «Уучлаарай, **зурган дээр үндэслэн** зохих өнгөний зөвлөгөө өгөх боломж надад байхгүй байна» |
| — | `quality_flags`: **zero** `inbound_dropped` rows for that conversation. No photograph, ever |

So the contamination is real. But the live prefix (seq 6) holds **two** sentences about
photographs, and only one of them is `image_received`:

| row | pointed at by | text |
|---|---|---|
| `image_received` | **nothing** | «би зураг харах боломжгүй…» |
| `refusal_out_of_scope` | `out_of_scope_topics.photo_consultation` | «**Зураг харж зөвлөгөө өгөх боломжгүй.** Манай мэргэжилтэн Танд туслах болно…» |

`refusal_out_of_scope` has been in the prefix since **seq 3 on 2026-09-07**, nine days
before the image feature existed. The draft's second sentence — «Манай мэргэжилтэн Танд
өнгө сонголт хийхэд туслах болно» — tracks that row almost word for word. It is Matrix's
only consultation-refusal, and it is phrased about photographs, so a consultation question
with no photograph in it gets the photograph wording, because that is the only way the
prompt knows how to decline a consultation.

**An edit-distance score could not settle this and was not allowed to.** Run against the
four candidate rows the whole-draft similarities were 0.21–0.35 with `handoff` scoring
highest — a row that has nothing to do with it. That is D-077's lesson holding: the
mechanism that decides whether an approved sentence was reused asks exact questions
precisely because scoring on Mongolian sentences is dominated by shared function words and
length. What settled it was reading which rule points at which row.

The fix that *is* code: `image_received` is filtered out of the compiled prefix, because
**nothing points at it.** It is served whole by `inbound/imageReply.ts` on a path that never
calls the model, no platform block names it, and no tenant rule names it. A sentence sitting
in the model's context with no instruction attached is not an instruction — it is an offer,
and the model will eventually take it. Audited across Matrix's twelve rows: it was the only
one in that state (`refusal_topic` is pointed at by the children's `disclosure_rules` row).

`MODEL_INVISIBLE_KINDS` lives inside `cannedSectionBody`, the ONE renderer both the publish
path and the request path call. Filtering at either caller instead would move `canned_hash`
on one side only and 503 every reply with `canned_stale` — the outage the shared-renderer
rule was written to prevent (D-058). It does not touch the review gate: an unreviewed
`image_received` row still refuses the whole section, because that is a question about the
row and `imageReply.ts` would serve those bytes to a customer.

`scripts/guards/check-gate-keys.mjs` gained the contradiction: a prompt block that NAMES a
filtered kind is an instruction pointing at a line the model cannot see — the gap D-058 left
with the model improvising into it. The guard holds a copy of the list and verifies it
against `match.ts`, because a copy that can go stale silently is the defect that file exists
to catch. All three branches were executed and seen to fail before merge.

**What this does not fix, stated plainly:** the 02:07 reply. That came from
`refusal_out_of_scope`, which is a customer-visible Mongolian sentence and therefore the
founder's. `prompt/drafts/matrix_out_of_scope_rewording.mn.txt` carries two options and the
open question of whether the `photo_consultation` rule should survive at all, now that a
photograph has its own handler and the rule's Cyrillic-only stems miss «zurag» anyway
(D-067).

### The hash, reproduced before the write and not after

Matrix's canned section shrinks by 119 characters. The new `canned_hash` is **`eb27de84`**,
and that number is worth reading twice: it is exactly what seq 3, 4 and 5 carried — the
value from before the image row existed. The filter returns the section to its previous
bytes, which is an independent confirmation that it removes that row and nothing else.

The method satisfies CLAUDE.md's standing rule that a publish is not trusted until something
independent reproduces its hash **before** the write: the twelve live rows were pulled as
base64 (no transcription), rendered through a faithful reimplementation of the pre-change
function, and reproduced `b1044d93` — the live seq 6 value — exactly. Only then was the new
number computed. A control that reproduces the known value is what makes the unknown one
evidence.

`allowed_numbers` is unchanged: the image line carries no numeral.

**Republish: Matrix only.** Tenant #0 has no `image_received` row, so its `canned_hash` does
not move and it needs nothing. Matrix is in `shadow`, so the window between deploy and
republish costs mirror drafts and reaches no customer.

### A near-miss inside the verification

The first check that the picture wording was gone tested `section.includes('зураг')` and
printed `false`. The remaining sentence begins «**З**ураг харж» — capital З. A
case-sensitive substring test on Cyrillic, inside the tool checking a Cyrillic fix, one
line away from reporting that the section was clean. Rule 6 is about matchers over customer
text; it applies to the diagnostics just as hard, and D-077's first diagnostic made the same
class of mistake three days ago.


### D-082 addendum — the variant, and a row the model was never shown

**2026-09-18.** The founder took the variant over plain A for `refusal_out_of_scope`:
A's first sentence with `image_received`'s approved second sentence, because *"ending at the
phone number is what I keep trying to get away from, and that version routes them back into
the conversation."* It is the second refusal row that does not end at 7741-7777, for D-076's
corpus reason.

Sharing a sentence with `image_received` put two rows in front of `checkPinnedLines`, and
the measurement is why the variant is safe rather than a hope:

| reply | canonical row |
|---|---|
| the row verbatim | `exact` → `refusal_out_of_scope` |
| the row with «би» dropped (D-065's real drift) | `paraphrase` → `refusal_out_of_scope`, 0.978 |
| sentence 1 reworded, sentence 2 kept | `paraphrase` → **`image_received`**, 0.680 |
| the shared sentence alone | `paraphrase` → **`image_received`**, 0.630 |

The third row is the defect: a model faithfully adapting the CONSULTATION refusal gets
corrected to the IMAGE line, and a customer asking which colour suits them is told the bot
cannot see pictures. **D-082's own defect, rebuilt inside the mechanism that exists to
correct drift.** `embeddedAdaptation` picks the longest common run and the shorter row wins
on run-over-length — 62/100 against 62/139.

The fix is the same principle one file over: `image_received` is filtered out of the compiled
prefix because the model is never asked to produce it, so **it must not be a row the model's
output is measured against either.** A reply resembling a sentence the model never read is a
coincidence, not an adaptation. `isPinnable` excludes `MODEL_INVISIBLE_KINDS` alongside the
unreviewed rows it already excluded, in both passes. Rows three and four then come back
`clean`; rows one and two are unchanged.

**The give, stated rather than discovered:** a partial adaptation is now `clean`, so it is
neither corrected nor counted — the shared run is a 0.45 share of the longer row, under
`EMBEDDED_MIN_SHARE`. Plain A has no such case because it shares nothing. That is D-077's
"counted nowhere" at smaller scale, and it is what routing the customer back into the
conversation costs.
## D-083 — A value computed and thrown away, and a matcher that read a proxy

**2026-09-18.** The founder, on the photo-consultation rule: *"keep it, don't tune it. The
real repair is carrying attachments through to the turn so the gate keys on whether a
picture is there, not whether the customer typed the word."*

### The discard

`meta/extract.ts` has always called `attachmentKinds()` for **every** message and bound the
result into `carried`. `carried` is used on the skip paths — malformed, and the textless
attachment D-070 taught it to record. For a message that has text the function ended:

```ts
messages.push({ senderId, externalId, text, sentAt });
```

`InboundMessage` had no attachment field, so the kinds were computed and dropped one line
before they would have been useful. **A photograph captioned «Ийм болгож болох уу?» — *can
you do it like this?* — reached the model as those five words, with nothing anywhere saying
a picture existed.** The model then answered about an image it cannot see and did not know
about.

This is D-064's shape inverted. That rule is "when you find a column, ask who writes it";
this is a value that was written and never carried. Both produce the same class of thing: a
fact the system has and does not act on, which reads from the outside exactly like a fact it
does not have.

### The proxy

Matrix's one `out_of_scope_topics` row matched the stems `зураг / зурган / фото` and pointed
at `refusal_out_of_scope`. Matching the customer's WORDS is a proxy for the thing the rule
cares about — a picture being present — and it is wrong in both directions:

| | |
|---|---|
| **Over-fires** | «зураг явуулж болох уу?» — *may I send a picture?* The honest answer is *yes, send it*, and the rule refuses |
| **Under-fires** | a caption need not contain a picture word at all, so the dangerous case fires nothing |

Since 2026-09-16 an *uncaptioned* photograph is answered by `inbound/imageReply.ts` on a path
that never reaches the model or this rule. So what the word matcher still covers is the
question about sending one — the case it answers wrongly — while the case it exists for goes
past it.

`has_attachment` is the mode: it fires on what the message CARRIES. The kinds are Meta's own
identifiers out of the payload (`image`, `video`, `audio`, `file`…), matched exactly and
case-sensitively, and deliberately **not** held to `MIN_STEM_CHARS` — that floor exists
because a short stem over-matches customer text, and these are never customer text.

**The rule stays a ROW.** Nothing in `src/` decides that a picture means a refusal; a tenant's
matcher does. Matrix's rule changes from a stem list to this mode and keeps pointing at the
same response kind, so the rule the founder approved survives with its proxy replaced by the
fact. No behaviour changes until that row is edited — this PR ships the signal, the lever and
the instrument, and no new sentence.

### `matcherFires` takes a subject, not a string

It was `matcherFires(text: string, spec)`. A mode that reads something other than the words
bolted onto that signature would have had to invent its answer from an argument it was never
given. `MatchSubject` is `{ text, attachments }`, and the change caught every call site at
compile time — one in `src/`, the rest tests. Same move as D-082's `Surface` union: the bug
class is closed by making the wrong call impossible to write, not by remembering not to
write it.

`ReceptionInput.customerAttachments` is **required, not optional with a default**. A default
of `[]` would assert "this message had no attachment" on behalf of a caller that simply
forgot — and the case it would get wrong is the captioned photograph, the one the field
exists for.

### The instrument, before the policy

`quality_flags` gains `inbound_captioned_attachment`, written before the `delivery.generate`
check so a captioned photograph arriving at a channel in `shadow` is still counted — the
mirror phase is precisely when the number is wanted. **Stickers are excluded**, which is
D-070's lesson applied on the other side: Meta sends one sticker as two attachments and
declares the first `image`, so reading `type` alone would turn every thumbs-up with a word
beside it into a photograph. Any `stickerIds` at all means filler.

The flag needs no migration — `quality_flags.flag` is `text not null` with no CHECK, verified
against `0001`. So this whole change is code-only: no migration, no `db push`, no republish,
no hash movement. It merges and deploys independently of anything else in flight.

**What is deliberately NOT decided here:** what a captioned photograph should be answered
*with*. That is a customer-visible Mongolian sentence and D-076 already put it to the founder.
The measurement comes first, and now it can exist.

### Verified by execution, both directions

The two probes matter more than the green run. Restoring the original discard
(`attachments: []` at the push) turns four tests red, including both worker-level ones;
removing the sticker exclusion turns exactly one red. A test that cannot fail is the thing
this repository keeps catching itself writing.


### D-082 addendum — the published `canned_hash` is not the one this record predicted

**2026-09-18.** D-082 records the new `canned_hash` as **`eb27de84`**, and that number was
right about the thing it measured: the `image_received` filter ALONE returns Matrix's canned
section to its pre-image-row bytes, which is what seq 3, 4 and 5 carried. It was reproduced
before the write, against a control.

The value actually published at seq 7 is **`00486066`**, with `content_hash 91349162…` and
14,279 chars. The difference is not a miss: the founder's `refusal_out_of_scope` rewording
landed in the same publish, so two changes moved one section. Both numbers are true of
different things.

It is written down because the alternative is a session reading D-082, comparing it to the
live snapshot, finding a mismatch and going looking for a bug that is not there — which is
the failure mode CLAUDE.md already names for `allowed_numbers`: **read the count off the
live snapshot, never off a sentence in this file.** The same applies to every hash recorded
here.
---

## D-085 — which public comments deserve a reply

**2026-09-18.** The founder: *"Most of a salon's comments are «гоё», tags and emoji;
answering all is noise, answering none misses «хэдэн төгрөг вэ» asked in public. Propose
the design against the real feed first."*

The design is `docs/comments.md`. This records the decisions inside it and the two things
that turned out not to be true.

### The real feed does not exist, and that was the first finding

89 `webhook_events` rows at the time of asking, every one an entry with `messaging` and
**zero with `changes`**. `subscribed_fields` is `["messages"]` on both Pages,
`comment_policy` is `none` on both, and neither tenant has a `comment_public_reply` row.
Facebook is unreachable through this environment's proxy. So it was designed against the
71-message DM corpus instead, and the substitution is stated wherever it bites — most
importantly that **nobody sends a salon a DM to say «гоё»**, so the corpus grounds what a
real customer asks and is silent on the noise rate a public feed carries. That half is the
founder's reading of his own feed and is not evidence this repository holds.

### Question-shape is the wrong signal, and wrong in both directions

Measured: 28% of the corpus is question-shaped; **52% is a bare topic noun** with no
question marker at all — «Хаяг», «Хими», «Мэдээлэл», «Salbaruud» — and those are the
customers worth answering. Meanwhile «уу» **is** the interrogative particle, so the
detector fires on «Сайн байна уу». It greets the greeters and ignores the buyers. Topic
stems reach 65% `reply` + 6% `escalate`.

### The cap makes the classifier a prioritiser, not a filter

`comment_replies_per_post_per_day` is 1 and replies are decided first-come-first-served —
verified against the control flow, where `postCounts` increments only when `draftOnce`
reports `created`. So a false positive is not one wasted comment, it is **the day's single
allowance spent**, and the question that arrives an hour later gets nothing. Precision
matters more than recall here, which is the opposite of the DM surface, and silence is a
decision to hold the allowance rather than a failure to answer.

### Three verdicts, not two, and the ordering is load-bearing

The corpus holds four complaints in 71 messages. «Утсаа авахгүй байна» answered with the
pinned line — whose whole content is *come to DM* — is a brush-off to a public complaint,
in the salon's own voice, permanently, under their own post. `escalate` posts nothing and,
because a refusal never drafts, does not spend the allowance.

Its precedence over `reply` is not tidiness: «ai bish huntei holbogdmoor bna» — *I want to
talk to a human, not an AI* — contains `holbog` and is caught by a contact topic. Under any
order where `reply` can win, a customer explicitly asking not to talk to a bot is answered
by one. D-066's ordering lesson.

A `priority` column was rejected for D-075's reason: ambiguity must be a verdict, never a
tie broken silently. With a declared total order over three verdicts there is no tie.

`ignore` and `unclassified` stay separate (D-070). Merged, the shadow phase's only
product — the list of comments the tenant has no rule for — is unreadable under «гоё»
volume.

### The verdict is an enum, and that is the safety argument

`eligibility.ts` rests on the comment's words not being a parameter. A classifier reads
them, so the reading happens in `classify.ts` and what crosses the seam is one of four
values. D-082: *the defect is a parameter that accepts a string.* TypeScript caught every
caller.

**It must not be a model, and on this surface that is a security argument**: a public
comment is attacker-controlled text from anyone with a Facebook account. With a fixed reply
and an enum verdict, the worst a crafted comment achieves is a wrong enum — it cannot
produce prose.

### Two claims in this record's own drafts that were wrong

**The first measurement said 56% and was measuring its own bug.** It reimplemented
`containsStem` by splitting the subject into tokens and testing `startsWith`, which makes
every multi-word stem silently unmatchable — so the booking intent, the clearest in the
corpus, scored zero and the conclusion drawn was that `contains_stem` could not express it.
`containsStem` is a Unicode-boundary substring match. D-077's lesson in a third file: **a
diagnostic that reimplements the thing it measures is measuring the reimplementation.**

**Both "over-matches" the probe reported were the probe's fault** — «цагаан будаг» firing
`service` via `будаг`, and «цагаан өнгө» via `өнгө`, are correct; those are service
questions about white dye and white colour. The trap strings contained genuine service
words. No true over-match was found.

### The floor costs two words, and the fix already existed

`MIN_STEM_CHARS = 4` correctly refuses **«цаг»** (*appointment*) and **«хэд»** (*how
much*) — both three characters, both prefixes of something else («цагаан» white,
«хэдийнээ»). A salon's two most valuable intents were unreachable in rows.
`matchesStemSequence` is the answer and was already built for outbound forbidden phrases;
its own docstring uses `['цаг', 'авл']` as the worked example. The exemption is **bounded,
not waived**: at least two stems, and a window no wider than 40 code points. The «хэд»
half was found by a test failing, not by reading.

### Two defects found while building it

**`post_too_old` measures the COMMENT's age, not the post's.** A brand-new spam comment on
a four-year-old post passes — the exact case §3.8.2 rule 5 exists to stop. Four things
agreed with each other and all four were wrong: the refusal's name, the config column's
name, the docstring, and a test called *"a comment on a post older than the tenant window"*
that constructed an old COMMENT. Renamed to `comment_too_old`, which is what it actually
guarantees; the post-age rule needs `GET /{post-id}?fields=created_time` and is recorded
rather than taken, with a test asserting the gap.

**`0030` is the first migration since `0001` to create a table**, and `0001` does its
security bookkeeping in bulk catalog loops that a later migration inherits none of. Six
items, and they were found in two batches by two different mechanisms:

- `catalog.sql` caught three against a real PostgreSQL — no `force row level security`, no
  `ops.tenant_scope` row, and a single `for all` restrictive policy where the convention is
  three per-command ones (a `for all` denies SELECT too, the silent fail-closed `0001`'s
  own comment warns about).
- **CI's PostgREST reachability check caught the fourth**: no `grant … to service_role`, so
  the table was absent from the schema cache entirely and every `.from('comment_rules')`
  would have 404'd at runtime.

That split is the lesson worth carrying. **`catalog.sql` proves nobody unauthorised can
read; only the transport check proves the runtime can.** V5 (`anon` holds no privilege) and
V6 (`authenticated` holds only SELECT) both pass perfectly for a table nobody can read at
all. **V35** asserts the allow side now, one layer earlier than PostgREST, and was probed in
both directions — with the grant revoked it fails and names the table.

### Status

Nothing changes for any tenant. `comment_policy` is `none` on both channels and
`classifyComment` refuses `no_rules` until somebody writes rows. Going live still waits on
the founder for three things: subscribing `feed` (a Graph write that **replaces** the field
list — sending `feed` alone drops `messages` and takes the DM mirror offline),
`comment_policy`, and the `comment_public_reply` sentence.

---

## D-086 — The website channel derives its tenant from the tenant's own server, not from the browser

**2026-09-18. Founder's call, from three named options.**

`0001` seeded the `web` provider row with `enabled = false` and this note:

> `'Undesigned in v1. The one surface where the tenant-identity rule has no answer.'`

That has been true and unaddressed for eighteen days. This settles it.

### What rule 1 is actually made of

The rule reads *"tenant is derived server-side, per webhook entry, from a registry with a
unique key. Never from a request body, a header, or an env var."* It is easy to read that
as a rule about WHERE in the request the identifier sits, and that reading is wrong — Meta's
Page id arrives in the **body**, at `entry[].id`.

What makes reading it legal is the ordering in `webhooks/meta/[app]/route.ts`: raw bytes at
step 1, `verifyMetaSignature` at step 2, `JSON.parse` only at step 3 — against a secret only
Meta holds — and `signature.ts` returning `matchedAppSlug`, *the slug whose secret actually
verified*. **The rule's operative content is: derive the tenant from an attested signal.**

A browser holds no secret by construction. A site key, the Origin header, the Host, a path
segment, a cookie — every one is chosen by the caller and attested by nothing.
`Matrix-Chatbot/lib/cors.js` says it in its own first ten lines about the control people
reach for first: *"CORS is a browser control… It is NOT an authorization gate and must never
be relied on as one."*

So the commercial-widget construction — a public site key — is **identification dressed as
derivation**. Anyone who reads the page source can mint as that tenant and spend that
tenant's budget, which is rule 2's stated harm (*another tenant's money*) arrived at through
rule 1's hole.

### The construction chosen

**The tenant's own server mints.** It signs a mint request with a per-tenant secret; the
platform derives the tenant from which secret verified, mints an opaque token, and returns
it. The browser never names a tenant, and every later message resolves the tenant by looking
that token up in `web_sessions` — a registry, server-side, with a unique key, holding a
value the platform itself issued.

Three consequences worth writing down:

- **`live_requires_active_token` is already correct for this surface.** A website channel's
  "token" is the mint secret, so the constraint that looked like an obstacle is the right
  one. Nothing is loosened.
- **No new `Surface` value is needed, on either type.** A widget is spend-surface
  `reception` and volatile-surface `direct_message`. That is the signal the seam is in the
  right place: the channel reuses Matrix's reply path, prompt, gate blocks and guards
  unchanged, which is what was asked for.
- **The cost is stated, not discovered.** A client with no server of their own — a salon on
  Wix — cannot do this. The answer for them is a Dala-hosted chat page (option B, where Dala
  is the origin and the tenant comes from a path Dala itself serves). It is a separate build
  and is deliberately not started.

### Why a caller-supplied channel id is not a violation

The mint request carries `X-Dala-Channel`, and a channel id is not secret. On its face that
is what rule 1 forbids.

It **selects a candidate**; it does not determine the answer. A caller naming another
tenant's channel gets that tenant's secret loaded and tried, the HMAC fails, and the request
is refused. That is exactly `verifyMetaSignature`'s `appSlug` parameter, which the `[app]`
URL segment supplies and which "selects which secret to try first" with a miss falling
through to a refusal. JWT's `kid` is the same construction. Trying every tenant's secret is
equally sound and O(tenants) decryptions per mint; this is O(1), and both derive the tenant
from the signature.

What it must not do is leak, so an unknown channel and a bad signature are **one refusal**
over the wire (`mint_unauthorised`) and two different diagnoses in the log. Otherwise the
endpoint enumerates which channel ids exist, unauthenticated.

### Two orderings that are findings rather than taste

**The timestamp is checked after the signature.** Checking freshness first answers *"that
timestamp is stale"* to a caller holding no secret at all — a distinction offered to somebody
entitled to none.

**Turnstile sits behind the HMAC, and gates the mint rather than every message.** Turnstile
says "a browser that passed a challenge", not "a person", and solving services exist. It is a
cost multiplier on automation; the HMAC is the authorization. There is deliberately no
`TURNSTILE_DISABLED` — a bypass flag is one dashboard edit from being live and its failure is
silent.

### What the survey that preceded this found, and how much of it is refuted

The map of Meta assumptions in the reply path was run as a four-lens workflow. **43 of its 54
agents died on a usage limit, and every one of them was a refuter** — so its findings came
back unrefuted and were checked by hand instead. Confirmed by direct reading:

- **`tenant_domains` is keyed `(tenant_id, host)`**, so `host` is not unique across tenants
  and it cannot serve as an Origin→tenant registry without violating rule 1's "unique key".
  `verified_at` is nullable and nothing sets it. It has **no reader anywhere** in `src/`,
  `scripts/` or `supabase/`.
- **`tenants.allowed_origins[]` does not exist.** `10-completeness.md:175` and
  `08-onboarding.md:153` both cite it as if it were schema. Implementing the sketch as
  written produces D-058's failure: a `.select()` naming a column the project does not have,
  a 400 from PostgREST, and CI structurally unable to see it.
- **`channel_providers.enabled` has no reader either.** Flipping it does nothing today —
  D-064's dead column in its other form, a flag nobody reads. It is not the switch for this
  surface and must not be treated as one.
- **The two fail-open CORS paths this repo's docs cite at `Matrix-Chatbot/lib/cors.js:16-17`
  were fixed on 2026-08-31.** Our citation is stale; the principle in that file's header is
  the part to carry.

### What is NOT built

The two routes. This lands the identity spine, the session registry, the rate limiter, the
Turnstile client and the migration — inert, because no `tenant_channels` row has
`provider = 'web'` and no mint secret is provisioned. Provisioning one is credentials, which
waits for the founder; the ceiling number for anonymous traffic is money, which waits too.

And `turnstile.ts` has **never been exercised against Cloudflare** — `challenges.cloudflare.com`
is unreachable from this environment, as is `api.github.com`, so the request shape is written
from the documented contract. The parsing is narrow (`success === true`, nothing else) so an
unexpected body refuses rather than passes.

### D-086 addendum — the two routes, and the three things that turned out to need no code

2026-09-19. `POST /api/web/session` and `POST /api/web/message` are built, as
`src/lib/website/mintJob.ts` and `messageJob.ts` with the routes as thin bindings — the
rule `api/workers/reception/route.ts` states, that a condition inside a route handler is a
condition no test can reach.

**Three things the survey expected to cost code and did not.** Each is the platform's own
test — client #3 fills in a config — coming out right, and each was found by reading rather
than assumed:

| | |
|---|---|
| Publishing for the web channel | `scripts/publish/tenant.ts` already reads a tenant's channels off `tenant_channels.provider` and passes the distinct set to `compileAndPublish`, and `config_snapshots` is keyed `(tenant_id, revision_id, channel)`. A `provider = 'web'` row is therefore the whole of "publish for the website" |
| A new spend or volatile `Surface` | Neither. A widget is spend-surface `reception` and volatile-surface `direct_message`, so it shares Reception's ceiling by construction rather than by a second number that could drift |
| The CORS allow-list | `tenant_domains` has existed since `0001` with no reader anywhere. This is its reader. `.env.example` already lists `ALLOWED_ORIGINS` as **banned** as an environment variable — "per-tenant DATA" — so the table was the answer the repository had already written down |

**`verified_at` means "an operator confirmed this host".** Nothing in this platform performs
an automated domain check, and a row without it is not an allow-list entry. Saying it means
anything stronger would be a comment asserting a control that was never built —
`config/platform.ts:33`'s monthly ceiling, one directory over.

**Two orderings, and they pull against each other.** The spend guard runs BEFORE the turn is
claimed, because a visitor refused for the tenant's ceiling has not had a turn and burning
one charges them for an answer they never got. The turn is claimed BEFORE the model is
called, because rule 3 — a ceiling checked after the call is not a ceiling. Both hold only
because the guard costs no model tokens, so nothing but `handleReception` sits between the
claim and the provider call. `messageJob.test.ts` asserts each as a trace ordering rather
than as a comment.

**A gate that cannot PASS is the same defect as one that cannot fail.** The first draft of
`runMintJob` passed a hardcoded `null` to `verifyTurnstile`, so every mint would have
answered `turnstile_missing` — a 403 on the happy path. The repository catalogues the other
direction at length (D-058's `hasTenantData`, `sweepStrandedEvents`' dead filter); this is
its mirror, and neither is visible without a test that drives the success case. The token
travels inside the SIGNED body, not a header, for the reason `issued_at` does: anything
outside the raw bytes is not covered by the HMAC, so a relay could strip it and the
signature would still verify.

**`x-forwarded-for` is a list whose FIRST entry is attacker-controlled.** A client may send
its own, and each proxy appends. Taking `[0]` — the reflex — hands an attacker the
rate-limit bucket key: vary it per request and every request opens a fresh window, so the
limiter counts to one for ever while looking like it works. `clientIp.ts` takes the
rightmost entry, and an unreadable address is a NAMED bucket rather than `''`, so
unattributable traffic is bounded together and is visible as itself.

**One bucket was not enough, and the arithmetic said so.** The mint allows 30 sessions a
minute from one address; a per-session message limit alone would then permit 30 × that many
turns from it. There are two buckets, and the per-address one is sized as a blast-radius cap
rather than a per-visitor limit because school, office and carrier NAT put many real people
behind one address — `dalatech-english` sizes its own per-IP backstop on the same reasoning.

**`SecretKind` did not contain `web_mint_secret`.** `0032` widened the database CHECK and the
TypeScript union was never widened to match, so the database permitted a kind the code could
not name. Found by `tsc`, not by reading. The union is now mirrored with a note saying why it
is mirrored rather than derived: the two halves have to be changed together, and a drift
should be a compile error rather than a 400 from PostgREST at the first real request.

**And a comment of mine that was false when written.** `.env.example` gained a note saying
the two new variables were "deliberately NOT in `scripts/preflight.ts`'s required set" —
except preflight DERIVES that set from the uncommented names in that very file, so writing
them there made them required and broke `preflight.test.ts`. The rule and the code it
describes have to be read together; each alone read as correct. They sit in the Optional
section now, commented out, to be uncommented in the same change that provisions the first
web channel.

**Still not exercised, and not to be written as if it were.** No tenant has a `provider =
'web'` channel, no mint secret is sealed, and `challenges.cloudflare.com` is unreachable from
this environment — so Turnstile's request shape is still written from the documented
contract and has never met Cloudflare. What IS proven: 51 unit tests over both jobs against
fakes that record ordering, and every column the new code selects verified to exist in the
live project rather than only in the repo.

### D-085 addendum — the comment rules are seeded, and one of them is not a salon's

2026-09-19. `comment_rules` is provisioned for both tenants, every row `enabled = false` and
`provenance = 'seeded'` (D-020: a provisioner did not review a matcher, so it cannot claim
`tenant_confirmed`). Matrix carries the full thirteen from `classify.test.ts`; **dalatech
carries ten.**

The three it does not carry are `service`, `booking_free_mn` and `booking_free_lat`.
`service`'s stems are «хими», «буда», «маникюр», «педикюр» — hair dye, perms and nail work.
Seeding those under a tenant whose `vertical` is `software` is D-033's shape exactly: a
tenant carrying another business's vocabulary because it was convenient to copy. The two
`booking_free_*` sequences are tuned to «цаг байна уу» as a salon's customers phrase it and
have no measured basis off that corpus; `booking_mn`/`booking_lat` («цаг авах») are ordinary
Mongolian for making an appointment and are kept.

**Validated by replaying the corpus through the rows as stored**, read back out of the
database rather than from the insert script, through the real `parseMatcher` and
`classifyComment`:

```
parseMatcher            23/23 accepted, 0 refused
matrix-eco-salon        reply 46  escalate 4  ignore 1  unclassified 20   72% actioned
dalatech                reply 23  escalate 4  ignore 1  unclassified 43   39% actioned
```

Matrix's four figures are **exactly** the ones this document's own rule-set section
records, which is the point of running it: a control that reproduces a known value is what
makes the unknown one evidence (D-082's method note). Without that agreement the dalatech
row would be a number with nothing behind it.

**And the dalatech figure is not a quality measurement, and must never be quoted as one.**
It is Matrix's DM corpus — a salon's customers asking about hair — scored against a software
company's rule set. 39% is what *should* happen when a salon corpus meets rules that
deliberately contain no salon words. There is no dalatech comment corpus, and until there is,
the only honest claim about those ten rows is that they parse and that they fire on the
generic intents.


## D-087 — tenant #0's knowledge base, ported from its own live chatbot, minus every price

**2026-09-19.** Tenant #0 published at seq 3 carrying two channels (`facebook_page`, `web`)
and **no data marker**. Its eleven knowledge tables held nothing at all: ten
`canned_responses` rows and zero everywhere else — `knowledge_documents`, `faqs`,
`contact_points`, `services`, `service_variants`, `business_hours`, `staff_members`,
`out_of_scope_topics`, `price_axes`, `deposit_rules`, `tenant_booking`.

That is `DAY_ONE_KB` exactly, and D-033's guard does what it is built to do: `hasTenantData`
is false, so `handleReception` serves the handoff line **before the provider call**. Every
message, every channel. The website channel was therefore about to replace a site chatbot
that answers about the five AI staff with one that says «Хамт олон маань хариулах болно» to
everything — a measured regression against the incumbent, which is the shape the founder
named on 2026-09-17: *when the incumbent has a rule we do not, that is a measured loss.*

The source is `dalatech-chatbot`, `api/chat.js`, `buildConversationSystemInstruction` — the
prompt the company's own site has been serving. `scripts/provision/tenant0-knowledge.sql`
ports it into rows: seven `knowledge_documents`, eight `faqs`, two `contact_points`.

### Every ₮ amount was dropped, and that is D-075 rather than an omission

D-075 is platform-wide and is the founder's call: *prices never enter `allowed_numbers`, and
never enter the prefix.* `allowed_numbers` is a SET, so the guard checks that a numeral is on
the tenant's list and **never that it belongs to the thing being discussed**.

This tenant is the worst case that rule was written for, and worse than the salon it was
written about. Matrix's collisions are between services with distinct names; here **five
products share two price points** — three staff at one monthly figure, two at another, and
two setup figures — so «Вира» carrying Dali's fee is a real, allow-listed number against the
wrong product at a 67% overquote. More plausible to a customer than an invention, and
therefore worse.

What was kept is everything that is not a price: what each member of staff does, which are
live and which take pre-registrations, the rollout time, what the monthly fee covers, the
discount tiers, the payment split, the contact route. Measured through the real
`renderTenantSections` with `DAY_ONE_KB` as the control:

| | control (canned only) | after the seed |
|---|---|---|
| sections | `canned_responses` | `tenant_data_marker, canned_responses, kb_documents, faqs, contacts` |
| data marker | **false** | **true** |
| tenant-section chars | — | 4,088 |
| `allowed_numbers` | `[]` | `10, 15, 20, 3–5, 5, 50, 7–10` |

Seven tokens: three discount percentages, the payment split, the page count and two
durations. **No price, and no phone number.**

### Three things that would have been wrong, found by checking rather than by reasoning

**An unconfirmed FAQ renders nothing.** `sections.ts` EXCLUDES a FAQ whose provenance is not
`tenant_confirmed` — deliberately, because a guessed answer is a promise the business is then
expected to honour. Seeding these as `seeded`, which is the cautious-looking choice, would
have inserted sixteen rows that compile to an empty section and a marker that still never
fires: the repository's own "a row exists ⇒ the work was done". They are
`tenant_confirmed` because every ANSWER is a sentence from the live prompt verbatim. The
question strings are composed, and that is stated here rather than implied.

**A dash is not a numeral.** The rollout answer is «3–5 хоногт» with an EN DASH and the
discounts use U+2212 MINUS. A prefix that hashes one way and a reply that hashes another is
the `btrim`/`.trim()` coin flip of 2026-09-07, one table over. Measured instead of assumed:
`extractNumerals` reduces `3–5` and `3-5` to the same `35`, and reads `−10%` as `10`
whichever minus is used, so the comparison is on digits and the dash cannot disagree.

**A URL the tenant never declared is refused even when the tenant wrote it.** D-071's shape:
`allowedUrls` is `tenant_booking.booking_url` plus the URL-bearing contact kinds, and
`urlsNotAllowed` matches on the CANONICAL form — scheme, host and path. So the `website`
contact row covers `https://dalatech.online/` and does **not** cover `app.dalatech.online`,
the demo-site tool. Rather than compile a link the guard would then discard, the demo tool is
absent from the documents; putting it back means a second row, and the primary key is
`(tenant_id, kind)`, so it needs a kind of its own or a different home.

**There is deliberately no `phone` row.** The source prompt states that the company publishes
no number and instructs the model never to produce one. Here that is structural rather than
an instruction (D-065): with no row there is no number in the prefix, and the guard refuses
every numeral outside `allowed_numbers`.

### Open, and the founder's: prices

Nothing above lets the bot quote a price, and the incumbent does. The mechanism that closes
that is already built and is D-075's own second half: a `deterministic_replies` row is
drafted **verbatim before the model call**, so its body never enters the prefix, its numerals
reach neither `allowed_numbers` nor the outbound guard, and the price is bound to the product
by the MATCH rather than by the model's judgement. One row per product, matched on the
product's name, is a price answer that cannot be attached to the wrong thing.

Those rows are customer-visible Mongolian, so they wait for the founder. The alternative —
compiling prices into the prefix — is a reversal of D-075 and is his to make, not a session's.

## D-088 — tenant #0 quotes prices from one row, and per-product is rejected

**2026-09-19, founder's call.** D-087 left prices open. The mechanism chosen is D-075's own
second half: a `deterministic_replies` row, drafted **verbatim before the model call**, so
its numerals enter neither the compiled prefix nor `allowed_numbers`, and the price is bound
to the product by the MATCH rather than by the model's judgement.

One row, `price_overview`, `match_mode = 'whole_message'`, `requires_empty_history = false`,
`provenance = 'tenant_confirmed'`, eleven stems. It is live: nothing in `src/lib/prompt/` or
`scripts/publish/` reads `deterministic_replies`, so the row took effect on insert with no
republish, no `content_hash` move and no `canned_hash` move.

### Per-product was asked for, drafted, and rejected

The request was one row per product matched on the product name. Three things measured
against the real `matchDeterministic` decided otherwise:

- **«эхо» and «ора» are THREE code points against `MIN_STEM_CHARS = 4`.** Those rules skip
  with `stem_too_short` and can never fire — two of the five staff silently unanswerable.
  `stem_sequence` clears the floor but is a `gate/match.ts` mode, and
  `deterministic_replies.match_mode` permits only `whole_message | contains_stem`.
- **`matchDeterministic` returns the FIRST matching rule and has no ambiguity verdict.**
  «Дали Вира хоёрыг авбал үнэ хэд вэ?» matches two product rules; the same rules in the
  opposite array order answer with the other price. `reception/load.ts` selects the table
  with **no `order by`**, so which price a customer is quoted is *unspecified*, not merely
  first-wins.
- **`requires_empty_history` defaults TRUE** and a price question arrives mid-conversation,
  so every price row needs it false explicitly.

The founder's words: *"Per-product is the same failure one table over, and unspecified
ordering on a path with no outbound guard is worse than the problem it solves."* Note what
that rejects — not only the rows but the matcher change that would have rescued them. An
ambiguity verdict would have fixed the ordering and left the design wrong for the second,
independent reason, which is the better argument against it.

**This path has no outbound guard at all**, and that is the whole reason the row can carry
prices: `handle.ts` drafts the short-circuit body at line 269 and returns, while
`outboundGuard` is at 447. So the numeral, URL, phrasing and gate-label checks never run on
these bytes. They are safe because they are the founder's bytes, reviewed as a sentence —
not because anything downstream checks them. Anyone adding a second row here is adding
unguarded customer-facing text.

### What it answers, measured by replaying the row AS STORED

Fires: «Үнэ хэд вэ?», «үнэ», «ҮНЭ ХЭД ВЭ?», «Үнэ.», «Үнийн мэдээлэл», «Үнэ хэдэн төгрөг вэ?»,
`Price?`, `How much?`, `une hed ve?` — first turn and mid-conversation alike, and also when
the history read FAILS, because `requiresEmptyHistory` is false so history is never consulted.

Falls through to the model as `no_match`: «Танай үнэ хэд вэ?», «Далийн үнэ хэд вэ?». Those
then meet D-075's prefix, which holds no prices, so they get `refusal_price_unlisted`. **That
is a known, accepted gap rather than a bug**: a price question with any extra word in it is
not answered with a price. It is the cost of the row being exact.

The Latin stems are D-067's lesson applied — rows listing the Latin forms, not a
transliteration engine. `whole_message` carries no length floor, which is what lets «үнэ»
(three code points) serve as a stem at all.

### The two edits

The drafted body compressed the setup fee to «Суурилуулалт 150,000₮, Эхо 200,000₮», which
made the reader do the subtraction; it is enumerated per member of staff now, in the source
prompt's own phrase «нэг удаагийн суурилуулалт». And the closing question «Аль ажилтны талаар
дэлгэрэнгүй сонирхож байна вэ?» is gone — they asked a price, so give the price.

## D-089 — `meta_app_id`, set from 197 deliveries and one thing still unverified

**2026-09-19, founder's instruction.** `tenant_channels.meta_app_id` was NULL on every
channel, and D-080's inbound handover half is inert without it: `controlAfter` returns
`unknown` when `ourAppId` is null, and `recordHandover`'s `move()` writes nothing on
`unknown` — *"no evidence; write nothing."* Every handover event was being parsed, counted
and discarded.

### Two channels, not three

The instruction said all three. Handover is Meta-only: `recordHandover` is called from
`worker/reception.ts` and nowhere else, and `src/lib/website/` contains no reference to it.
A `meta_app_id` on the `web` channel would be data describing a thing that does not exist
there, so it stays NULL. Both `facebook_page` channels are set.

### What the evidence says, and it is better evidence than D-062 had

`matchedAppSlug` is persisted as the last colon-separated field of `webhook_events.dedup_key`
(`identity.ts`), so it is readable without any log. Across **every delivery this platform has
ever received — 197 rows, not D-062's seven:**

| Page | tenant | deliveries | `matched_app_slug` |
|---|---|---|---|
| `1520409424715591` | matrix-eco-salon | 179 | `dalatech` |
| `1520409424715591` | (unrouted, 09-07) | 2 | `dalatech` |
| `863503883522801` | dalatech | 16 | `dalatech` |

**One `META_APP_SECRETS` entry verifies both Pages.** So whatever the right numeric id is, it
is the SAME for both Meta channels — that part is measured, not inferred, and it is why a
single `update … where provider = 'facebook_page'` is the correct shape.

### What is still unverified, stated plainly

The slug is a callback path, never Meta's name for an app (D-041), so the measurement does
not name the numeric id. It was set to **`1380702870025418`**, CLAUDE.md's console reading
for the app named `dalatech`, on the grounds that it is the only value consistent with every
record: that app holds Matrix's Page, and D-043 measured tenant #0's Page subscribed to both
apps at once — so both Pages arriving under one secret fits without contradiction.

**It has never appeared in any data this platform holds.** Searched: no `app_id` key occurs
in any `raw_payload` row. `developers.facebook.com` is 403 through this environment's egress
proxy, re-measured 2026-09-19. So this is a console reading carried forward, which is exactly
the class of claim CLAUDE.md says to re-ask about rather than inherit — and it is flagged
here rather than left to be discovered.

### Why setting it anyway is safe, which is the part that decided it

A wrong id is **never worse than NULL**, and that is not a guess — it is `controlAfter` read
line by line:

| event | `ourAppId` NULL | WRONG | RIGHT |
|---|---|---|---|
| pass → us | nothing | `human` — bot goes quiet needlessly | `bot` |
| pass → someone else | nothing | `human` ✓ | `human` |
| take from us | nothing | nothing | `human` |
| take from other | nothing | nothing ✓ | `unknown` |

Every cell a wrong value produces is either correct or over-cautious, and none of them lets
the bot talk over a person — the failure the feature exists to prevent. The worst case is a
needlessly quiet bot, which is the direction this platform picks everywhere else. Correcting
it later is one `update`.

## D-090 — the two outbound handover calls, written and wired to nothing

`src/lib/handover/graph.ts` adds `passThreadControl` and `takeThreadControl`. **No caller.**
`docs/handover.md` requires the reclaim to ship with the pass, and the reclaim is a policy
question with three answers still owed; this is the plumbing under it, whose shape those
answers cannot change.

Three things it refuses to assume:

**`{"success": true}` is not proof.** D-062 is this repository already paying for that on the
neighbouring endpoint: `POST /{page-id}/subscribed_apps` answers `success: true` when the app
never had the field enabled, and eleven days of a dead channel hid behind it. Same product
surface, same shape of answer. So the outcome is `accepted` — Graph took the request — and
what proves a pass is the handover webhook that follows, which `recordHandover` already
consumes.

**An indeterminate handover is read the OPPOSITE way to an indeterminate send.**
`meta/send.ts` treats it as "do not re-send", because the risk is a duplicate. Here the risk
runs the other way: a pass that may have succeeded means the Page Inbox may already own the
thread, so the caller must assume it happened and go quiet. Both calls resolve towards
silence. The type cannot say that, so the module header does.

**No Graph code is mapped for "not the primary receiver".** Only the primary receiver may
take control back, and whether this platform holds that role is on `docs/handover.md`'s
unverified list. Inventing a code would be a rule nobody has watched fire; it falls through
`classify` to a non-retryable 4xx, which is right for a call Meta will refuse identically.

`/me` is refused as in `sendMessage` — it resolves the Page from the token, so a mismatch
would move thread control on the wrong salon's Page and answer 200 — and a pass with no
`target_app_id` is refused rather than letting Graph pick who owns a customer.

The `NEVER_CONNECTED` list is duplicated from `meta/send.ts` deliberately (importing it would
export an internal), and a test parses BOTH files and fails when they drift. That test was
checked adversarially: deleting one entry from `graph.ts` turns it red.

## D-091 — the handover policy answered, and D-089's app id was wrong

**2026-09-19, founder.** All three of `docs/handover.md`'s open questions are answered, and
the `meta_app_id` set hours earlier was corrected from the App Dashboard.

### The app id was wrong, and it was wrong for the reason D-089 quoted

`meta_app_id` is **`1562862634970492`** (`DALA_AI`). D-089 set `1380702870025418`, which is
the **ancestor's** app.

The mistake is worth more than the fix. D-089 quoted D-041 — *a slug is this platform's
name for a callback path, not Meta's name for an app* — wrote that the numeric id could not
be derived from the measurement, and then derived it from the measurement anyway: 197
deliveries verified under the slug `dalatech`, and `dalatech` is also the NAME of a Meta
app, so the id of that app was taken. **The slug named `dalatech` holds DALA_AI's secret.**
That is precisely the coincidence D-041 exists to warn about, recited and then walked into
one paragraph later.

The general form: quoting a warning is not applying it. The application here would have been
to notice that the only step from evidence to value was *a name matching a name*, and stop.

**Nothing was harmed, and D-089's harm table is why** — it argued a wrong id is never worse
than the NULL it replaced, and that held: no handover event has ever arrived, so
`controlAfter` was never called with the wrong value. The table was right; the id was not.

### The three answers

**1. The reclaim window is 15 minutes.** *"Long enough for someone to notice, short enough
that «2 өдөр залгаж байна» doesn't happen again."*

**2. A staff reply resets the clock.** `applyThreadControl` now refreshes
`thread_control_at` on a human turn. The file argued the opposite, and that argument was
incomplete rather than wrong: refreshing on every human turn does extend the silence for as
long as someone keeps typing. What bounds it is the reclaim. **The refresh and the reclaim
are one design, not two decisions** — ship the refresh alone and the old comment's warning
comes true.

It is deliberately narrow: only `source = 'echo'` (a person typing), only `human`, and
`changed` stays **false** because `recordHandover` counts `changed` as takeovers and a
refresh moved nothing. A `handover` event re-asserting `human` is Meta repeating itself, and
treating it as a turn would let a redelivered webhook hold a thread open for ever. Both
narrowings are tested, and the test was checked adversarially: widening the condition turns
one red.

**3. The customer sees the pass.** Both sentences are drafted in
`prompt/drafts/handover_notice_and_reclaim.mn.txt` and are unsigned. Neither promises a
time, and the reclaim gives no reason for the wait — *our team is busy* was drafted and
rejected, because nobody was necessarily busy and the platform cannot tell the difference.

### Open: 15 minutes and 30 minutes cannot both bind

`tenants.human_takeover_cooldown_minutes` is **30** for both tenants; the reclaim window is
**15**. If the sweeper reclaims any `human` thread after its window, it always fires first
and **the cooldown becomes unreachable** — a configured control that can never be observed,
which is D-064's dead column from the other end.

`docs/handover.md` step 3 scopes the reclaim to threads **we** passed, which keeps both
numbers meaningful: our pass reclaims at 15, a person's own takeover holds for 30. That
needs something `thread_control_source` cannot give — `handover` is written both when we
pass and when a person grabs the thread through Meta's UI — so it wants either a fourth
source value or a column recording that the pass was ours.

Not decided here, because picking silently either kills a number the founder set or adds a
column he has not seen. The sweeper is not built until it is settled.

### Also: `pages_messaging` is at STANDARD access on the app that matters

The founder reports `DALA_AI` holds `pages_messaging` **Active at Standard access**, and did
not request Advanced, on the reasoning that this platform administers both Pages. CLAUDE.md
records **Advanced** — but for the app named `dalatech`, which the correction above shows is
the ancestor's, not ours. Both statements can be true of different apps, and the one that
carries our traffic is the Standard one.

Standard Access is what an app has for users who hold a role on it. Messaging the general
public is what Advanced Access is for. If that is right, the first reply to a stranger fails
at send time. It cannot be checked from here — `developers.facebook.com` is 403 — so it is
recorded as a risk with its evidence rather than asserted:

**The evidence is thin in the direction that matters.** `outbound_messages` holds four sent
messages with provider ids for tenant #0, across **two conversations**, on this platform's
own Page — both plausibly the founder. Matrix holds **163 drafts across 57 conversations**
and has sent to none of them, because it is in `shadow`. So **the cutover would be the first
time this platform sends to a stranger**, and if Standard is insufficient it will be
discovered on Matrix's real customers rather than in a test.

The cheap settlement, before cutover: have somebody with **no role on `DALA_AI`** message
tenant #0's Page, which is `live`, and see whether the reply sends. Two minutes, and it
converts the whole question into an observation. A failure would surface as Graph code 200 →
`channel_permission_error`, terminal, which halts outbound and pages rather than failing
quietly — loud, but on a live customer.

## D-092 — Matrix's names settled, and what the rename did and did not fix

**2026-09-19, founder, after the salon finally answered.** D-075 held the alias seed because
*"the `services` rows and the confirmed price list disagree about the names."* Two are now
settled and applied:

| was | is |
|---|---|
| `CICA эмчилгээ` | **«CICA нөхөн сэргээх эмчилгээ»** |
| `Office өнгө` | **«Оффис колор /Сор/»** |

«CICA хими» was never in our rows at all — there was nothing to remove. Four aliases seeded,
`tenant_confirmed`: the two old CICA names, and «Оффис колор» / «Офис колор» for the single-ф
spelling.

### Measured through `matchService`, not assumed

| text | verdict |
|---|---|
| «оффис колор сор хийлгэмээр байна» | **Оффис колор /Сор/**, 3 tokens |
| «Оффис колор хийлгэе» | **Оффис колор /Сор/**, 2 tokens (via alias) |
| «офис колор» | **Оффис колор /Сор/**, 2 tokens (spelling alias) |
| «cica эмчилгээ хийлгэх үү» | **CICA нөхөн сэргээх эмчилгээ**, 2 tokens (old-name alias) |
| bare «cica» | **none** — safe, as D-075 measured |
| «Сор хийлгэх үнэ хэд вэ» | **Сор**, 1 token |
| **«сорри буруу бичлээ»** | **Сор**, 1 token |

**The rename did not remove the collision, and could not.** `subsetCollisions` still reports
«Сор» ⊂ «Оффис колор /Сор/», because the salon's own name for the three-dye service contains
the one-dye service's name. The founder's *"they're separable"* is true in the direction that
has words to separate on — anything naming «оффис» resolves — and false for a bare «сор»,
which `match.ts`'s own docstring already said no row can repair.

**And D-075's warning fired on the first probe.** «сорри» — a customer apologising — still
reaches «Сор» at one token. So **a specificity floor above the matcher is a precondition for
letting any of this choose a price**, not a refinement of it. The matcher reports the token
count precisely so the caller can refuse a one-token hit; nothing calls it yet, and nothing
should until that floor exists.

### Prices are still out, and the reason is unchanged

The salon gave figures — a by-length dye scale, and one-session against course rates for the
CICA treatment. **None of them is in a row.** Putting them in `service_variants` renders them
into the price list and into `allowed_numbers`, which is exactly what D-075 forbids, and the
serve-from-row half that would carry them safely is still unbuilt. Per-service
`deterministic_replies` cannot rescue it either: «Сор» is three code points, under
`MIN_STEM_CHARS`, the same wall that stopped «Эхо» and «Ора» in D-088.

Two readings of the figures are also still open and were NOT guessed: whether the by-length
scale replaces the 120–190k range for «Сор» or describes a different dye service, and whether
the course rate is per session. A wrong price against a service is the failure D-075 exists to
prevent, so an ambiguity in the source is not resolved by picking.

### The knowledge rows are drafted, and one of them widens the allow-list

`prompt/drafts/matrix_cica_knowledge.mn.txt`, unsigned. The CICA row carries **97, 3, 30 and
40** — the protein/water split and the тэжээлийн тос equivalence. `3` and `30` are already on
Matrix's list; **97 and 40 would be new**. None is a price, but every numeral added is one more
the outbound guard must permit, so it is put to the founder as a choice rather than absorbed:
the row answers the question perfectly well without either statistic.

The damaged-hair answer is placed as KNOWLEDGE rather than a served canned row, and the
difference is D-065's: a served row is typed by the platform, knowledge is a request the model
may ignore. Enforcing it needs a matcher for "the customer is describing damaged hair", which
is the fuzzy judgement D-067 and D-083 both show stem lists make badly. It becomes a served
row if the corpus shows the model ignoring it.

## D-093 — which handoffs become a pass, measured instead of argued

`docs/handover.md` step 1 says *"the bot decides a person should take over"* and never says on
what. That is the last thing blocking the outbound half, and it is the kind of question this
repository has been wrong about before by reasoning from the code rather than the corpus. So it
was measured first.

`passThreadControl` and `takeThreadControl` still have **no callers** — D-090 built them and
wired them to nothing, which is still true. Nothing here changes that.

### The obvious wiring, and why the corpus refuses it

`handoff()` is the only place the reply path gives up, so hanging the pass off it is the
reading that presents itself. Matrix, six days, 09-14 → 09-19: **57 conversations, 154 inbound
messages, 151 answered** (105 model, 46 canned), mean **2.70** turns, max 10, and **21 of 57**
are a single turn.

| Candidate trigger | Conversations | % of 57 | ≈/day |
|---|---|---|---|
| any canned answer | 29 | 51% | 4.8 |
| any guard refusal (reaches `handoff()`) | 13 | 23% | 2.2 |
| 2+ canned answers in one conversation | 10 | 18% | 1.7 |
| 3+ canned answers | 4 | 7% | 0.7 |
| the customer asks for a person | **1** | **2%** | **0.2** |

The guard-refusal row is 15 `quality_flags` rows — `outbound_disclosure` 7, `outbound_gate_label`
7, `outbound_price` 1. **Most of those are this platform's own defects, not customers needing a
person**: D-068 threw away a correct booking answer for quoting the reviewed `booking_line`,
D-077 discarded a reply that named the service better than the row did, D-082 served
*write me a private message* to four people who had. Passing control on a guard refusal
therefore converts OUR bug into the salon's labour, at 2.2 conversations a day, and it does it
most often on exactly the turns where the bot was right and the guard was wrong.

That is the argument against the trigger that was easiest to build. It is not an argument
against passing at all.

### One conversation carries the whole case

2026-09-15, six turns, and it is the only place in the corpus a customer says it outright:

```
05:09:46  sn bna uu                              → model
05:10:20  emchilgeenii himu                      → model
05:10:25  himu hymdral bgaa yu                   → model
06:55:06  эмчилгээний хими сонирхож бна          → canned
06:55:37  ai bish huntei holbogdmoor bna         → canned   ("I want a human, not an AI")
06:55:51  asuult oilgoh tuvshnii bish bna        → canned   ("it can't understand questions")
```

Our draft at 06:55:23 was «Энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй. Хувийн мессеж
бичвэл хариулна.» — D-082's `refusal_public_channel`, telling someone already in a DM to send a
DM. Our drafts for the last two turns were the handoff line twice, pointing at **7741-7777** —
the number the salon disconnected four days later.

**The causal reading of that is wrong and worth stating, because it was the first one written
here.** Matrix is `shadow`: 163 outbound rows, **0 sent**, every one a draft. The customer was
reacting to the ANCESTOR's live replies, not to ours. What our rows show is not that we drove
this customer off — it is what we would have said at each turn, which is a refusal aimed at the
wrong surface followed twice by a dead phone number. Third time in this corpus that reading a
draft as an effect rather than as a proposal produced a wrong answer; *read the flag before
explaining the draft* applies to whole conversations too.

### The matcher half needs no code, and that is the point

The trigger «the customer asked for a person» looked like it needed transliteration or a new
mechanism, because «хүн» and `hun` are **3 code points** and `MIN_STEM_CHARS` is 4 — the same
wall as «Сор», «Эхо» and «Ора». It does not. `stem_sequence` is already exempt from the floor,
bounded rather than waived (≥2 stems, window ≤ `MAX_SEQUENCE_WINDOW_CP` = 40), on exactly the
argument that applies here: *ordering and the window are the specificity that the length floor
is a proxy for.* `['hun', 'holbogd']` and «хүн»+«холбогд» are both expressible as rows today,
and `ажилтан` (7) and `оператор` (8) clear the floor on their own. Client #3 fills in a config.

`холбогд` alone would NOT do, and the corpus says why rather than intuition: «Холбогдох утас
бна» is a customer asking for the phone number, which is not a request for a person.

Run against the six corpus messages rather than asserted:

```
{"mode":"stem_sequence","stems":["hun","holbogd"],"windowCp":40}
  fires=true   ai bish huntei holbogdmoor bna          <- the real request
  fires=false  Ugluni mend. Unudr tom huni tairalt ...  <- «хүний», an adult's
  fires=false  Хүннү салбар                             <- a branch name
  fires=false  Холбогдох утас бна                       <- asking for the PHONE
  fires=false  2 өдөр залгаж байна                      <- distress, not a request
```

**It takes TWO rows, one per script, and that is the finding rather than a caveat.** The Latin
pair does not fire on «хүнтэй холбогдмоор байна» and the Cyrillic pair does not fire on
«ai bish huntei holbogdmoor bna» — `fold()` does not transliterate (D-067), so each row covers
its own script and neither covers both. The probe was written expecting one row to do the job
and reported three MISSes; the misses were the expectation, not the matcher. `ажилтан` catches
neither of these two phrasings and is a third row, not a substitute for either.

The exemption is bounded, and the bounds were checked by trying to break them — all three
refused: a bare `hun` (`stems shorter than 4 characters over-match badly`), a one-stem sequence
(`one stem is contains_stem without the floor`), and `windowCp: 999` (`an unbounded window is an
unanchored matcher wearing a tightening's clothes`).

### How the stems were checked, since counting them lied

Six messages matched the probe; reading them left one. «tom **hun**i tairalt» is «хүний» — *an
adult's* haircut — and «**Хүн**нү салбар» is a branch name. **Two of six matches were false
positives on a 3-character stem**, which is `MIN_STEM_CHARS` earning its keep inside the
diagnostic that was arguing about it. A count would have reported 6 and been wrong by 6×.

### The reclaim discriminator

D-091 left the sweeper blocked on recording that a pass was ours, and the proposal is a fourth
`thread_control_source` value, **`pass`**. The column already holds our own outbound action in
one direction — `reclaim` — and was simply missing the other; this is a missing enum member, not
a new dimension.

One rule comes with it. `applyThreadControl` returns early when control has not changed, so a
pass recorded AFTER Meta's webhook has already moved the thread to `human` would leave
`source = 'handover'` and the thread unreclaimable — the exact silence the reclaim exists to
prevent. So **a `pass` writes its source even when control already matches**: the other three
sources are evidence, and re-applying evidence is not news, but a pass is our own action. When
the webhook and the pass disagree about who moved the thread, the webhook is the redundant one.

### Open — the founder's call

Which trigger. The recommendation is **the customer asking for a person, plus a consecutive-
canned floor**, not the guard refusal: together ≈0.9 conversations a day against 2.2, and they
fire on customers who are stuck rather than on replies the guard got wrong. Both reach the
conversation above by different routes. It is his because it decides how much of the salon's
day this feature spends.

## D-094 — a retired phone number in a re-runnable seed, a guard whose reason expired, and a truncated grep that hid both

Found while checking whether the retired number survived anywhere in the repository. Two
separate things did, and the way the first was nearly missed is the most useful part.

### First, the error, because it was published before it was caught

This entry originally read: *"it does, in test fixtures and docstrings only — no provisioning
file, no seed, nothing on a write path, so a re-provision cannot put the dead number back."*
**That was false, and it was committed and pushed.** The grep behind it ended in `head -30` and
returned exactly thirty lines; the real count is **117**, and the provisioning files were below
the cut. An answer assembled from a truncated read was reported as an audit — D-057's lesson
(*when a parser cannot complete, it must say so, not answer with the part it managed*) arriving
in a shell pipeline rather than in a parser, and arriving inside the check that existed to find
exactly this. The finding below is what the untruncated search returned.

### The seed files, and a claim that had to be corrected twice

The first version of this section said `matrix-stage4-kb.sql` *"would have written the dead
number back as a second escalation contact, and the next publish would have compiled it into the
prefix and into `allowed_numbers`."* **That is also false.** It was written from reading the SQL:

```sql
insert into contact_points (tenant_id, kind, value, is_escalation)
select t.id, 'phone', '7741-7777', true
  ... and not exists (select 1 from contact_points c
                      where ... and c.value = '7741-7777');
```

The guard IS keyed on the value it inserts, so after the republish removed that row it stops
preventing anything — that much was right. What was wrong was the consequence. Run against a
scratch PostgreSQL 16.13 holding the new value, the old file does not insert anything:

```
psql:/tmp/old-stage4.sql:106: ERROR:  duplicate key value violates unique constraint
                                      "contact_points_pkey"
exit: 3
```

`contact_points`'s primary key is **`(tenant_id, kind)`** — one phone row per tenant, ever — and
the file wraps lines 40–213 in a transaction, so the violation rolls the whole stage back. No
corruption, no partial state. **The safety came from a constraint the guard does not know about**,
which is worth more than the guard: a dead idempotency check sitting on top of a live primary key
looks exactly like a working idempotency check. The real defect is that stage 4 silently became
un-re-runnable. After aligning the value and the guard, a re-run is a genuine no-op — measured,
`re-run OK`, one phone row.

**The actual risk is in the canned files, which is the opposite of the ordering first written
here.** `canned_responses` guards on `(kind, locale)`, so a re-run is a no-op whatever the body
says — but a FRESH provision is not. Rows deleted and the old `matrix-stage3-canned.sql` re-run,
measured:

```
handoff                -> Та 7741-7777
refusal_no_promotion   -> Та 7741-7777
refusal_price_unlisted -> Та 7741-7777
refusal_staff_schedule -> Та 7741-7777
```

Four reviewed bodies carrying a disconnected number, stamped `reviewed_by = 'founder'` — and this
file's own header explains why that is the serious one: *a canned line is trusted on `reviewed_at`
alone*, bypasses the outbound guard entirely, and is served to a customer verbatim. The review
gate cannot help, because the rows genuinely were reviewed; what expired is the number inside
them. The same held for `refusal_topic` in `matrix-stage3b-children.sql` and for the «Салбарууд»
knowledge document.

All are now the live approved text, verified by running the whole chain against the scratch
cluster and comparing lengths to the project: `refusal_topic` 128, `refusal_no_promotion` 99,
`handoff` 143, `refusal_price_unlisted` 122, `refusal_staff_schedule` 102, `contact_points.phone`
= `76001888, 80905498`. Every one matches. The `contact_points` row takes the comma form because
it renders as data (`- Утас: …`); the canned bodies take the sentence form «76001888 эсвэл
80905498» because they are sentences.

One was deliberately **not** updated. `matrix-stage3b-children.sql`'s `refusal_out_of_scope` body
is superseded outright — D-082 found its photograph wording was answering text-only colour
questions «зурган дээр үндэслэн», and the founder reworded it to a row carrying no phone number
at all. Swapping its number would have produced a sentence current in exactly one respect and
retired in every other, which is the most misleading state for a line somebody might re-run. It
is flagged in place; replacing it is customer-visible Mongolian and the founder's.

### And second, the docstring that was not inert

`EMBEDDED_MIN_RUN = 40` is the floor below which a shared run is not counted as drift, and its
justification was the shared closing sentence: «Та 7741-7777 дугаараар холбогдоно уу.», *"36
characters"*, so *"forty keeps the phone sentence from reading as drift on its own."* Two things
are now wrong with that sentence. It was **37** code points, not 36. And its replacement is
**51** («холбогдоно») or **48** («лавлана»), both comfortably over the floor — so forty no longer
excludes the shared sentence at all.

**The guard did not break.** Every probe against Matrix's live rows came back `clean`, because
`EMBEDDED_MIN_SHARE` catches what the floor stopped catching: the shortest live row ending that
way is `refusal_no_promotion` at 99 code points, and 0.6 × 99 = 59.4 > 48, so the run now fails
the proportion instead of failing the floor. This is D-058's shape exactly — *the guard did not
break; the reason it was true did, and nothing pointed at the reason* — arriving through a row
edit in a different table from the code it invalidated.

### The test was the part that should have caught it

`'the shared phone sentence alone is not drift'` existed, said in its own comment that
`EMBEDDED_MIN_RUN` is what the property rests on, and stayed green — **because its fixture still
carried the retired number.** A test whose fixture is a copy of production data keeps asserting
the world that fixture came from, and reports it as a pass. Nothing in CI could have seen this:
the fixture is in the repo and CI is built out of the repo (D-058's asymmetry, one more time).

The fixture now carries the sentence as published at seq 8, and the property is stated on BOTH
sides of the boundary rather than on the safe side only:

- a reply merely ending that way, against a row shaped like the shortest live one → `clean`;
- the same reply against a row of **≤ 80 code points** ending the same way → `paraphrase`,
  i.e. the correct answer discarded and the row served in its place.

80 is where 48 ≥ 0.6 × L turns over. **The boundary is a property of the ROWS, not of the
constant**, and Matrix has about 19 characters of margin: one shorter refusal row ending at the
phone number would start replacing correct answers with it, which is D-068's failure by a new
route. Both assertions were checked adversarially — `EMBEDDED_MIN_RUN` at 52 and
`EMBEDDED_MIN_SHARE` at 0.45 each turn them red, and 0.45 also reddens a pre-existing test, so
the share is load-bearing in more than one place.

### What was deliberately not done

`EMBEDDED_MIN_RUN` was **not raised to 52** to restore the original reading. That loosens a guard
on the surface D-077's founder call was about — *"the mechanism only means anything if it's
exact"* — and it is a behaviour change to a guard that is currently correct. The number stays and
the justification is now accurate, which is the honest repair; whether the floor should track the
closing sentence's length is a question for the founder, not a constant to nudge.

The incident fixtures keep the OLD number on purpose. `PRICE_ROW` and the D-077 tests reproduce
production turns from 2026-09-16, when 7741-7777 was live; rewriting them to the new number would
falsify the record of what actually happened. **A fixture reproducing an incident is dated
evidence; a fixture asserting a live property must track the live value.** Conflating the two is
what produced this finding.

### The method, which is the part worth keeping

This entry was wrong twice, in the same direction, and both times the correction came from
running the thing rather than reading it. First a `head -30` truncation reported as an audit.
Then a consequence — *it would insert the dead number back* — inferred from SQL that, executed,
does something else entirely, and whose real risk turned out to be in a different file with the
severity ordering reversed. **Reading SQL tells you what it says; only running it tells you what
the schema will let it do**, and a primary key declared in `0001` is exactly the sort of thing
that is not in front of you when you are reading line 100 of a seed file.

## D-095 — the specificity floor, and the fixtures it exposed

D-092 called this a PRECONDITION rather than a refinement: «сорри» — a customer apologising —
reached «Сор» at one token, so the matcher that D-075 wants to choose a price was accepting as a
service identification exactly what `MIN_STEM_CHARS` refuses to accept as a topic stem. Built.
`matchService` still has no callers; this makes it correct before it gets one.

**The rule reuses the gate's floor rather than inventing a second number, and states the
exemption the way `stem_sequence` does: two tokens or more, or one token of at least
`MIN_STEM_CHARS`.** Several tokens that must ALL occur are their own specificity, which is what a
length floor is a proxy for in the single-token case. A service name is matched against the same
customer prose a topic stem is, so it earns the same floor.

The verdict is **`too_vague`**, not a downgrade to `none`. Both mean "do not act", but only one is
countable — «сорри» reaching «Сор» is a measurement worth having, and a silent collapse into
`none` is D-070's `console.info` in a fourth table. The match, its term and its token count are
carried through, and `specific: false` says why it was refused. The floor is applied to the
WINNERS, after most-specific-wins has run: an entry reachable both vaguely and specifically is
judged on its best reading, so a two-token alias rescues a short name.

«Сор» becomes unmatchable on its own, and that is the honest outcome rather than a regression.
D-092 established the collision cannot be repaired by any row, because the salon's name for the
three-dye service CONTAINS its name for the one-dye service; refusing to guess makes the rename
it needs visible instead of silently picking between prices 3.2× apart.

### Four tests failed, and the split between them is the point

Two were **about the behaviour that changed**, and now record the floor holding instead of the
defect. `A ONE-TOKEN MATCH ON A SHORT STEM IS NOT EVIDENCE` had said in as many words that it was
*"the argument for a specificity floor above the matcher"* — it now asserts the floor.

Two were **about other mechanisms whose fixtures happened to use a sub-floor name**:
agglutination («сортой» from «сор») and Latin aliases (`sor`). Both mechanisms are untouched —
`fold()` still does not transliterate, a token-prefix hit still finds the comitative — and both
tests would have passed with a one-character fixture swap. **That swap is exactly the failure
D-094 had just recorded**: a fixture quietly changed so a test goes green stops describing what
it claims to. So each keeps its old fixture as a second assertion — agglutination still *finds*
«сортой», and the floor is what declines to act on it — and the new fixture is explained rather
than substituted.

The fifth test was mine and wrong before the code was. `uniqueName('CICA нөхөн сэргээх')` was
asserted to reach «CICA нөхөн сэргээх эмчилгээ»; that name has **four** tokens and three were
supplied, so the all-tokens rule correctly returns `none`. The assertion now states that, which
is a better demonstration of this test's actual subject than the one intended.

Both halves checked adversarially: making the floor always-true, and applying it to every hit
rather than to the winners, each turn five tests red.

## D-096 — the comment surface's first delivery, and the three wrong diagnoses on the way to it

`webhook_events` id **203, 2026-09-20 02:17:25 UTC**: the first `changes` entry this platform
has ever received, after 202 deliveries that were all `messaging`. `docs/comments.md` opened by
recording that the real feed "does not exist, and that is the first finding"; it exists now.

### The cause was the app-level half of a two-part subscription

Webhook delivery needs **two independent subscriptions**: the app subscribed to the field on the
`page` OBJECT, and the app subscribed to the specific Page ASSET. Only the second was done.
`POST /{page-id}/subscribed_apps?subscribed_fields=feed` returns `{"success": true}` when the
first is missing, and no event is ever delivered.

`03-meta-routing.md` §3.10.5 predicted this in as many words, including that it "bites the first
time a *new* field is requested, i.e. when comments are added" — and it did, on the first
attempt, eleven days after being written down. The step that would have caught it,
`GET /{app-id}/subscriptions`, is still the unbuilt half of the reconciler.

**No write was needed to fix it.** The page-level subscription had been correct all along; the
app-level toggle was the entire cause.

### Three diagnoses, all wrong, and how each was caught

This is the part worth keeping, because the fix was one checkbox and the route to it was not.

**One — "`comment_policy = 'none'` does not protect you."** Asserted from tracing
`classifyComment`'s `no_rules` refusal and finding no caller for `handleComments`. There is no
such export: the entry point is `runCommentJob`, and `reception.ts:386` gates it on the policy
before anything else. **I grepped for a name I had assumed rather than reading the module's
exports**, concluded the path was unwired, and stated the opposite of the truth. Caught by a
docstring mentioning "the comment job" inside `reception.ts` — a file the grep had already
searched and found nothing in.

**Two — "the page-level subscription must be re-POSTed."** Reasoned from the documented
`{"success": true}` behaviour: a field registered while the app lacked it at app level is not
really registered, so fixing the app level cannot backfill it. Plausible, and false. The read
came back `["feed","messages"]` already. The founder ran the GET before the POST, as instructed,
and the write turned out to be unnecessary — **which is the entire argument for reading before
writing on a control that is a replacement presented as an addition.** Had the order been
reversed, a `subscribed_fields=feed` sent without `messages` would have dropped the DM mirror to
fix a problem that did not exist.

**Three — a test whose negative result could not mean what I said it would.** I asked for
`debug_token` scopes and pre-announced that a missing `pages_read_user_content` would prove App
Review was required. A freshly generated Explorer token's `scopes` is a statement about what was
ticked in that session, not about what the app holds. **The founder flagged the confound
himself**, in the same message that reported the result. Ticking the permission granted it
immediately, `granular_scopes` scoped to the Page, no App Review anywhere.

The shape is one this repository keeps recording and I produced three times in one night: a
source answering plausibly instead of admitting it cannot see. A grep that finds nothing because
the name is wrong. A documented API behaviour applied to a state it did not describe. A token
whose scope list answers a different question from the one asked.

**What made it tractable was a control whose timing we chose.** Every delivery on record arrived
before the salon closed, so silence was uninformative — 09:15 Ulaanbaatar looks identical whether
`feed` is broken or the city is asleep, and the ancestor's logs showed it had stopped in the same
half-hour, which is D-062's signature *and* the signature of night. A DM sent on demand arrived
in seconds and collapsed the hypothesis space in one step. **When silence is the evidence, buy a
delivery rather than reason about the absence of one.**

### The first real payload, measured against code written blind

Everything in `meta/comments.ts` was written without ever seeing a `feed` entry. Two assumptions
looked fragile and both were already right, with the reasoning recorded:

- `created_time` is UNIX **seconds** (`1789870639`), not an ISO string. `secondsToDate` handles it
  and documents both failure directions — ×1000 puts every comment in 1970 and refuses everything.
- `parent_id` **equals** `post_id` for a top-level comment. `isReply = parentId !== '' &&
  parentId !== postId` separates a reply from a root without parsing Facebook's `{owner}_{object}`
  id structure, which `eligibility.ts` then relies on.

Run against the real bytes: no skips, `threadId === commentId`, timestamp sane at two minutes,
and the self-comment guard fires when `from.id` is the Page. The comment arrived on a **reel**
(`status_type: added_video`), which nothing in the design had contemplated and which changes
nothing.

### What the rehearsal starts with, and two things to read it against

Matrix: 13/13 rules enabled, `comment_policy = 'public_only'`, `delivery_mode = 'shadow'`. First
draft at 02:32:44 — `kind = 'comment_reply'`, `state = 'draft'`, `provider_message_id` null,
`unit_cost_nanousd` null, body byte-identical to the reviewed `comment_public_reply` row. No model
call, because this surface never makes one.

**«гоё» classifies as `unclassified`, not `ignore`.** The seeded `praise` stem is `гоён`, and
`containsStem` is a token-PREFIX match, so the longer stem can never match the shorter word: «гоё»,
«гоёхон» and «Гоё!» all miss. The cause is `MIN_STEM_CHARS` — «гоё» is three code points and is
refused outright, so whoever seeded the rule reached for a four-character form and inverted its
meaning. **The floor forced a stem that misses the word it was written for**, which is the «Сор» /
«Эхо» / «хүн» wall again, this time failing open into the wrong counter rather than refusing.
Deliberately NOT fixed yet: the real praise forms are what the rehearsal is for, the outcome is
silence either way, and `whole_message` (no length floor) is the mechanism once the forms are known.

**A draft consumes the per-post cap.** `repliesPerPost` counts `draft` alongside `sent`, on purpose
— "it is what a shadow run writes" — so the cap is genuinely exercised in shadow rather than
bypassed. The consequence for reading the results: **drafts will be far fewer than comments, by
design.** One per post per rolling 24 hours, not one per comment. A day of thirty comments and four
drafts is the cap working, so `post_cap_reached` has to be read beside the draft count or the
classifier will look broken when it is not.

## D-097 — a success message narrower than its reader, and the column that believed it

`tenant_secrets` holds exactly one row: tenant #0's `page_token`, sealed 2026-09-05. On
2026-09-20 the founder ran `scripts/kek/seal.ts` twice against Matrix. Both printed
`verified`. Both exited 0. Neither wrote anything, and neither could have.

### The script has no database client

`scripts/kek/seal.ts` is a SQL **generator**. It reads the secret from stdin, seals it,
decrypts it back in memory through the runtime's own `openForRow`, prints an
`insert into tenant_secrets …` to **stdout**, and exits. There is no Supabase import in the
file and no network call. Its header said so on line 16 — *"one command and a paste into a
SQL editor"* — and nothing in its runtime output repeated it.

The trap is one line:

```
seal: verified — this row decrypts back to the input under the active KEK.
```

Every word is **true, and about the crypto only**. What made it misread is where it went:

- **stderr**, so in a terminal it interleaves *after* the SQL block. The operator sees a wall
  of SQL scroll past and then a line saying `verified` — the last thing on screen, which is
  where a person looks for the outcome of a command.
- gated on **`process.stderr.isTTY`**, which is backwards. The reassurance appeared only when
  a human was watching and was suppressed when piped to a file — the one context where a
  machine could have checked it got nothing at all.

Reproduced by execution rather than read: a run prints 17 lines of SQL, then `verified`, then
exits 0; the same run with `2>&1 >/dev/null` printed nothing.

### The column then believed the script

`tenant_channels.token_status` was set to `active` by hand on the strength of that report,
and that is the part with teeth. **`live_requires_active_token` checks the COLUMN, not the
secret** — `check (delivery_mode <> 'live' or token_status = 'active')`. So the constraint
built to stop a channel going live without a credential would have waved Matrix through into
`live` with `tenant_secrets` empty, and every reply would have failed at decrypt with the
salon silent. The constraint that would actually have blocked the flip was
`live_requires_name_confirmation` — unrelated bookkeeping. Clear that and nothing is left.

That is D-064's rule needing its third statement. Its first form was *ask who WRITES a
column*; D-072's addendum added *ask who READS it*; this adds **ask what the writer actually
checked**. `token_status` is written by a human from a script's report, read by a CHECK
constraint, and reconciled against `tenant_secrets` by nothing.

Reverted to `unprovisioned` on the founder's instruction, 2026-09-20. `delivery_mode` stays
`shadow`; the constraint now genuinely blocks.

### The fix, which is not a database client

The script still writes nothing — that is deliberate, and the header's reasoning stands: the
alternative puts a service-role credential in an operator's shell for a job done twice per
tenant. What changed is that it can no longer be read as having written:

- **The first line of stdout** is `-- NOTHING HAS BEEN WRITTEN TO THE DATABASE`, followed by
  the confirming `select`. It is inside the payload, so it survives redirection into a file
  and is the first thing seen when the SQL is pasted. The stderr notice can be thrown away;
  this cannot be separated from the statement it warns about.
- **The stderr notice is unconditional** and three lines, in order: what was checked (the
  crypto), what was not (the write), and the query that settles it.

The general rule, which is the reason this is an entry and not a commit: **a success message
must be no wider than what was verified, and where it is printed decides what it will be read
to mean.** `verified` after seventeen lines of output is read as "the command worked",
whatever its sentence says. The same failure is in this repository twice already —
`meta/extract.ts`'s "everything skipped is reported" when the report was one `console.info`,
and `config/platform.ts:33` asserting a monthly ceiling no code reads.

## D-098 — two instruments that could not see what they were built to see, and the price measurement that reframes the go-live

Three findings from one night's reading of Matrix's comment rehearsal (2026-09-20), plus
the measurement that changes what "load the price list" means. They belong together because
the first two are one shape and the third is the argument for not shipping yet.

### The rehearsal, in full, because six comments is the whole corpus

The comment surface took its first real traffic between 02:17 and 04:04 UTC:

| id | from | text | outcome |
|---|---|---|---|
| 203 | the founder | `une hed ve` | the first `changes` event this platform has ever received |
| 205 | the DalaTech.ai **Page** | `une hed ve` | **the one draft**, 02:32:44 |
| 212 | a real customer | «Яармаг хаяг хаана вэ» | nothing |
| 215, 217 | **Matrix eco salon itself** | the salon's own address replies | `comment_self` |
| 219 | a real customer | «Зэсэн улаан туяа арилдагуу» | `comment_unclassified` |

Four of the six are on one post. **Our own test comment spent that post's daily allowance,
and the only real answerable customer comment of the night was capped.** Somebody asked
where the salon is and got silence.

### A refusal that is counted is not a refusal that is recorded

`decideCommentReply` places the per-post cap AFTER the verdict deliberately, and its own
comment gives the reason in as many words: the operator's question is *is a cap of 1 costing
me customers?*, they answer it **by counting `post_cap_reached`**, and putting the verdict
downstream would bury that number under every «гоё» arriving on a capped post.

The ordering was right and the counter it describes did not exist. The refusal went into a
return value and one `console` line; only `comment_unclassified` and `comment_escalated`
ever got a `quality_flags` row. So the number the cap exists to be judged by could not be
read at all — third instance of one shape in this neighbourhood, after `meta/extract.ts`
claiming everything skipped was reported and `docs/comments.md` claiming an escalation wrote
a flag. **A comment explaining how to count something uncountable.**

`post_cap_reached` is now the only structural refusal that writes a row, and the line is
drawn where **a reply was wanted and lost**. `thread_already_answered` withholds nothing —
the thread has its reply. `comment_self`, `comment_too_old` and `comment_not_worth_reply`
were never going to be answered. `no_reviewed_line` is a per-tenant provisioning fault that
would write one identical row per comment for ever, which is volume rather than signal.

The row carries `replies_in_window` and `cap`, so it answers the question without a join,
and the digest carries the count with its DISTINCT POST COUNT beside it. That second number
is not decoration: six capped comments on one post is the cap working exactly as designed,
six across six posts is six conversations the wall never got, and only the second argues for
raising the number. A single total cannot tell them apart and is what somebody would use.

### A constant that named a fact, inside the tool built to catch drifting facts

`scripts/diagnose/meta-subscription.ts` checked `REQUIRED_FIELD = 'messages'`, under a
docstring calling it *"the field every `tenant_channels` row on this platform subscribes to
today"*. That stopped being true the moment Matrix's comment surface needed `feed`.

So the one instrument built to read the far side of a Meta subscription — the instrument
that exists because D-062 cost eleven days of a dead channel — would have printed
`page/messages is subscribed and active`, exited 0, and said nothing whatever about `feed`
being off with every comment silently undelivered.

**`tenant_channels.subscribed_fields` is read by nothing.** Written at provisioning, never
consulted since: D-064's rule is "ask who WRITES a column", D-072's addendum is "ask who
READS it", and this one fails the second. Reading it in the diagnostic would not have helped
either — Matrix's row says `{messages}` while Meta holds both — so the check would have
reproduced the same blindness from a different source. Until something reconciles that
column against Meta, the honest input is the operator's own expectation, stated per run.

`--field` is therefore required, repeatable and **has no default**, which is D-083's rule
again: a default asserts on behalf of an operator who forgot, and the case it gets wrong is
the one the flag exists for. The verdict is per field, because `messages` live while `feed`
is off is a real state and "not healthy" does not name the switch.

### The praise rule cannot fire, measured

`praise` carries the stem `гоён`, and `containsStem` is a token-PREFIX match: a four-
character stem cannot match the three-character token «гоё». Measured — `гоён` misses «гоё»
AND misses «гоёхон»; it only reaches «гоён…» forms.

It cannot be repaired by swapping in `гоё`, because `contains_stem` refuses a stem under
`MIN_STEM_CHARS` and a malformed matcher refuses the whole job. Nor by `whole_message`
alone, which is an EXACT match on the entire message — it catches «гоё» and misses «гоё юм
аа». Only `stem_sequence` is exempt from the length floor, and it needs two stems.

So the covering set is three rules, measured at 12/12 on the praise forms and 4/5 on the
negatives: `contains_stem` for the long words (`гоёх`, `сайхан`, `баярла`, Latin),
`whole_message` for the bare short forms, `stem_sequence` for «гоё» inside a longer
sentence. The one false positive — «Сайхан амраарай» — fires on a stem that is already live
and already does that, so it is not a regression, and `praise` is `ignore`, so the cost of
either error is accounting rather than a wrong reply.

### And the price list is not a data-entry job

`service_variants` is empty, the table already has the right shape, and the ancestor's list
is **43 entries** (not the 40 in circulation). The assumption was that loading it is the
easy half. It is not, and the measurement is the reason.

`sections.ts` already reads `service_variants`; `tenant.ts` already renders them as an L3
«ҮНИЙН ЖАГСААЛТ»; `allowedNumbersFrom` runs over every tenant section. Three real rows
through the real compiler:

```
- Омбре: 500,000₮ - 640,000₮
- Үндэс: 135,000₮
- Эмэгтэй тайралт (Мастер): 66,000₮ - 88,000₮

allowed_numbers → ["135,000","500,000","640,000","66,000","88,000"]
```

Loading the list as-is puts 43 prices in the model's context and ~60 price numerals in
`allowed_numbers` — and the guard checks that a numeral is ON the list, never that it
belongs to the service under discussion. **That is D-075's «Омбре 33,000₮» at full scale,
with a real price against the wrong service, which is more plausible than an invented one
and therefore worse.** Today's thirteen-token allow-list is the only reason that failure has
never been available.

So D-075's serve-from-row half is not "add a short-circuit". It requires the price section
to stop emitting figures first, and the two must land together: rows without the renderer
change is the worst state this platform could be put in.

One refinement the audit produced. `priceOf` has five kinds and only three carry a numeral.
`on_inspection` renders «(үзээд)» and `none` renders «(none: children_services)» — neither
is a price, both do real work, and `tenant.test.ts` already asserts the second. Suppressing
"the price section" wholesale would delete the mechanism by which the prompt says *this
service exists and its price is deliberately withheld, see this refusal*. Suppress the
numbers; keep the kinds.

`hasTenantData` keys on the data-marker heading and not on this section, so the change does
not reach it. `price_list` renders in exactly one place.

### The lesson, which is one lesson and not four

Each of these is a mechanism whose own prose describes a measurement it does not take: a
cap explaining how to count something uncountable, a subscription check naming the field it
does not parameterise, a stem list naming a word it cannot match, and a price list whose
docstring says prices are kept out of the prompt while the renderer puts them in.

D-097 stated it for a success message — *a report must be no wider than what was verified*.
The general form is older and worth writing down plainly: **prose in this repository is a
claim, and a claim next to the code it describes is the most credible kind of wrong.**

## D-099 — composition across two true rows, a failure mode Ш8 structurally cannot catch

**2026-09-20, the founder's call.** Recorded because the next instance will not be about
hair colour.

### What happened

A customer asked whether office colour could be done on already-dyed hair. The bot answered
with a figure — «30 хувийн цайруулалт», *a 30 percent bleach* — that appears in no row, no
knowledge document and no price list. It was not retrieved and it was not invented from
nothing. Two true, separately approved facts were bridged by a relationship nobody wrote:

- the knowledge base says office colour is **three dyes**, and
- the knowledge base says CICA compares to **30–40 тэжээлийн тос**.

The `30` was real. Its attachment to a bleaching percentage was not.

### Why the existing gates cannot see it

**Ш8 — *do not answer what is not in the knowledge base* — is structurally blind here**,
and that is the finding rather than a gap in its wording. Ш8 asks whether the PARTS are in
the base. They were. Every individual proposition the reply rests on is approved; what is
fabricated is the edge between them, and no rule that quantifies over facts can quantify
over the relations a fluent model will draw between them.

The numeral guard cannot see it either, for a reason worth stating precisely: `30` was on
`allowed_numbers` because a knowledge row legitimately contains it. **The allow-list is a
SET** — D-075's whole argument — so it licenses `30` in any sentence whatsoever, including
one about bleach concentration in a chemical process performed on a person.

`disclosesPrompt`, `checkPinnedLines` and `urlsNotAllowed` are all properties of the reply's
TEXT. None of them models the claim the text makes.

### It is the same shape as the price problem

D-075's sentence is *«Омбре 33,000₮» — a real price against the wrong service — is more
plausible than an invented one, and passes every check.* This is that, one layer up: **a
real number attached to an invented relationship.** The repair is the same in form — the
platform serves the fact from the row and the model chooses only WHICH row — and that is
why part 2's `decidePriceQuote` and item A's refusal row are the same design and not two.

### What was built, and what deliberately was not

Built: `out_of_scope_topics` rows routing a SUITABILITY question — *will this chemical
process work on my hair* — to a founder-approved refusal that hands the customer to a
person (`scripts/provision/matrix-suitability-refusal.sql`, `0034`). The matcher keys on the
QUESTION'S SHAPE rather than on chemistry vocabulary, because the shape is the invariant:
whether a process suits a particular head of hair is a judgement requiring eyes on the hair,
whatever chemistry is attached to it.

**Not built: a guard.** An input filter over chemical words is D-033's fallacy — it would
refuse «зураг явуулж болох уу?» in a new costume, firing on the vocabulary rather than on
the act. And an output check for "invented relationships" is a check that cannot be written:
there is no corpus of false relations to match against, only a corpus of true parts.

**Not closed:** the reply that prompted this was about office colour on dyed hair, and the
honest answer to it is the salon's, not ours. It goes to them with the rest.

### The general rule

**Two approved facts in one context are a third, unapproved claim waiting to be made.** A
knowledge base is not a set of independent statements to a model reading it; it is a graph
it will complete. When a row is added, ask not only *is this true* but *what will this be
bridged to* — and expect the bridge to carry the credibility of both endpoints, because a
sentence built from two approved facts reads exactly like an approved sentence.

That is also why the measurement mattered more than the reasoning here: the matcher pair
`[хими, болох]` looked obviously right and fired on three price questions out of
twenty-two, every one of them *«хэд болох вэ»* — how much will it be.

### D-099 addendum — the corpus was invented, and it scored 5/5

**2026-09-20, caught by the founder before the SQL was run.** He asked why two of the six
matcher pairs had no twin in the other script while the other two did: *measured, or a gap?*

It was a gap, and chasing it found a worse one underneath.

**The pairs had been measured against a corpus somebody typed into the test.** Five
"suitability questions" written by the same author as the matchers, and the set scored 5/5.
Re-run against the **real** corpus — all 164 inbound messages Matrix has received — the
identical six pairs scored **3 of 6**. They missed half the genuine suitability questions
real customers have actually sent, and two of the six fire on **nothing in 164 messages**.

Note precisely what the invented corpus measured: the author's idea of how customers write,
compared against matchers built from the author's idea of how customers write. Both sides of
the test came from the same place, so it could only ever agree with itself. **That is an
assertion that cannot fail, built out of two halves that each look like evidence.**

It also explains the asymmetry the founder spotted. `[будаг, хими]` and `[ungu, garal]` had
both been *tested* and both scored 0/5 — so they were dropped. But the invented corpus
contained each concept exactly once, in exactly one script, so neither pair could have scored
above zero. **Two pairs were cut for failing a test structurally incapable of passing them**,
which is the inverse of the same defect: an assertion that cannot succeed.

### What only the real corpus could say

- **Customers write «ү» as `v`** — «Tas har vsend ene ungu garalt blhu», «Hi vsnii ongo…».
  Every Latin pair keyed on `usend` alone misses them. Nothing in any romanisation standard
  predicts this; the corpus simply does it.
- **`ungu` and `ongo` BOTH occur** for «өнгө», in the same corpus. The question "which
  romanisation is correct" has no answer — both are, and a rule must carry both.
- **The Cyrillic twin of `[buda, himi]` is actively unsafe**, not merely absent: widened it
  fires on «тайралт будалт хими», a customer *listing services*. Narrowed to `[будаг, хими]`
  it fires on nothing. So that asymmetry is correct — but it was correct by luck, since the
  reasoning that produced it was about a corpus that did not exist.
- **Four real messages are suitability-shaped PRICE questions** — «Өөрт тохирох үсний өнгөө
  олж будуулах д үнэ хэд вэ», «Iim ongo gargabal une bogino usend», «будагтай үсний уг
  цайруулалт хэд вэ», «Yg iim urtta usend hed bolh be». Every one must NOT refuse. They are
  the reason recall cannot simply be bought by widening stems.

Final set: nine pairs, **7 fires across 164, 6/6 genuine caught, 0 false positives**, verified
by parsing the matchers back out of the SQL file rather than from the script that wrote them.
Each row is now marked `attested` (fires on a real message) or `twin` (the same stems in the
other script, firing on nothing yet, kept as a bet because that script is 41% of traffic).

**The rule: a matcher is measured against messages the business received, never against
messages the author can imagine it receiving.** Where no such corpus exists yet, the honest
report is a recall of *unknown* — not a number from a set you wrote. And when a candidate
scores zero, ask whether the corpus could have scored it above zero before you cut it.

### D-099 addendum 2 — the third artifact measured against something other than the real thing

**2026-09-20, the founder, having stopped before running the SQL.** He read
`matrix-suitability-refusal.sql` against the live database and found its first INSERT could
not execute: `canned_responses` has no `provenance` column, and the live shape is
`tenant_id, kind, locale, body, reviewed_by, reviewed_at`.

Checking it properly found **three** defects in that one statement, not one:

| | what | would it have failed? |
|---|---|---|
| 1 | `provenance` — the column does not exist on this table | **yes**, `42703` at parse time |
| 2 | `on conflict (tenant_id, kind)` — the PK is `(tenant_id, kind, **locale**)` | **yes**, matches no constraint |
| 3 | `locale` omitted | no — it defaults to `'mn-MN'` |

The third is the instructive one: it is *not* a bug, and it was named anyway, because the
same reading that produced 1 and 2 produced it. A file that depends on a value should show
the value.

What made `provenance` plausible is worth keeping: **`out_of_scope_topics` does have it**,
and the two INSERTs sit eight lines apart. A column that exists on the neighbouring table,
in the same file, for the same feature, reads as a column that exists.

### The pattern, which is the founder's observation and not a new finding

He named it: *"the third artifact measured against something other than the real thing."*
In one session —

1. **The matchers** were scored against a corpus the author invented (addendum 1). 5/5 on
   imagined messages; 3/6 on the 164 real ones.
2. **`allowedNumbersFrom`'s earlier estimate** was reasoned from three rows rather than run:
   "roughly sixty" against a measured 45.
3. **This INSERT** was written from `docs/schema.md` and `0001`'s DDL rather than from the
   database it runs against.

Each substitute was a *faithful description* of the real thing — a schema doc maintained by
a guard, a DDL file that is the source of the schema, a corpus drawn from the same domain.
That is what makes the substitution invisible: **nothing about a good proxy announces that
it is a proxy.** Rule 4 already says a migration in the repo is not a migration in the
database; this is the same sentence about documents, corpora and estimates.

The operational form, and the cheap part: **EXPLAIN the statement against the live database
before shipping a file that writes to it.** It plans without writing, and it catches a
missing column and a non-matching ON CONFLICT — defects 1 and 2 here — in one round trip.
Both were confirmed that way, including reproducing the original error before fixing it. It
does not catch a CHECK violation, so `body IS NORMALIZED` and the `provenance` CHECK were
verified by direct probe instead.

## D-100 — a bare «будаг» answers with every length, and two things that needed no change

**2026-09-20, the founder's call.** Three services in the intake share the token «будаг» —
«Будаг», «Будаг арилгалт», «Дип будаг» — and `validateIntake` reported the collisions. His
requirement: a bare «будаг» should not resolve to any of the three; the two-token names
should match only when named.

**Measured before answering, against the intake's real 36 services, and two-thirds of it was
already true.** Most-specific-wins requires every token, so «будаг» alone cannot reach
«Будаг арилгалт» or «Дип будаг» — they match only when named. Nothing to build.

The one open case was the first clause: a bare «будаг» resolves uniquely to «Будаг» itself,
at one token, clearing the specificity floor (five characters). Also «будалт» and
«Vniin medeelel budag», through the alias «буда».

### Option B, and why the cheap answer was the right one

- **A — a clarifying question.** Costs a new `canned_response_kinds` row and a new reviewed
  Mongolian sentence. **None of the twenty-one kinds is a question**; they are all statements
  or refusals, so there was nothing to reuse.
- **B — serve every variant.** `decidePriceQuote` already serves all of a service's prices
  or none, so «будаг» answers with all three lengths and the customer self-selects. No
  migration, no sentence, no code.

The founder took B: *"That's what a receptionist says when someone asks about colouring."*
The general shape is worth keeping — **an ambiguity can be answered with DATA instead of a
question**, and where the data is already approved that costs nothing and asks the customer
for nothing.

It is pinned as a test rather than written down here, because the behaviour it leans on —
serve-every-variant-or-none — is one `if` away from pick-the-first, and that change would
read as a tidy-up. The failure it prevents: a customer asking «будаг хэдээр хийх вэ», told
«135,000₮», arriving with shoulder-length hair.

### The label bug the answer exposed

Writing the salon's confirmation list surfaced a defect in the intake, not the code.
`decidePriceQuote` omits a variant's label only when `variantKey` is EMPTY, and the intake
had written `'Стандарт'` for every single-variant service — so the bot would have said
«Омбре (Стандарт) — 500,000₮ - 640,000₮». Twenty-eight rows retitled to `''`. The two that
keep a key do so because it carries meaning: «Хумс нөхөлт (1 хумс)» is priced per nail.

Note how it was found. The claim being checked was *"the list the salon confirms is
byte-identical to what the bot will serve"* — and it was not, for thirty of the
forty-three lines. **A list rendered by one code path and served by another is two
implementations of one sentence** (the `btrim`/`.trim()` lesson, third instance). The
generator now uses the renderer's own label rule.

## D-101 — a collision the code could describe and did not act on

**2026-09-20, the founder, on the point of applying the intake.** He asked one question:
«Дип будаг» and «Будаг арилгалт» are MANICURE services — if a customer writes «үсний будаг
арилгах», *remove my hair colour*, does that match «Будаг арилгалт» and quote 8,000₮?

**No, and what it did instead was worse.** «арилгалт» is not a prefix of «арилгах» — they
diverge after «арилга» — so the manicure name never matched. The text satisfied «Будаг»
alone, at one token, five code points, comfortably clearing `MIN_STEM_CHARS`. The verdict
was `unique`, and the three dye-APPLICATION prices (135,000 / 176,000 / 200,000₮) would
have been quoted to somebody asking about REMOVAL.

### The defect was a function that only ever printed

`subsetCollisions` has computed this relation since D-092 and was never consulted when
matching. Its own docstring says the pair is *"UNVERIFIABLE in one direction"* and that no
row repairs it — which is an argument for REFUSING, and it was used as an argument for
reporting and then answering anyway. **A collision the code can describe and does not act
on is a comment.** That is `meta/extract.ts`'s "everything skipped is reported" and
`config/platform.ts`'s monthly ceiling, a third time: prose asserting a control that was
never wired.

`shadowed` is carried beside `specific` rather than folded into it, because they are
different facts and D-074's lesson is that a defect filed under the wrong reason sends the
reader to the wrong screen. A log line saying «Будаг» was too SHORT would be false.

### The first version was too broad, and the test that caught it said so in its name

Folding both checks into one condition turned «гоёл» — which reaches «Хумсны гоёл» AND
«Гоёлын засалт» — from `ambiguous` into `too_vague`. Both refuse, so it looked harmless;
`ambiguous` names the candidates and `too_vague` does not. **A rule that makes an answer
LESS specific in the name of safety has confused the two.** Shadowing now decides exactly
one shape: a SINGLE winner that a longer name contains. Several winners stay `ambiguous`.

### What it costs, measured on real traffic rather than argued

Over all 164 inbound messages Matrix has received: 132 `none`, 22 `unique`, 9 `too_vague`,
1 `ambiguous`. **Exactly two change**, and both were right before:

| message | was | now |
|---|---|---|
| «будаг хэдээр хийх вэ» | `unique → Будаг` | refused |
| «Тайралт будаг» | `unique → Будаг` | refused |

Both are genuine hair-colour price questions that D-100's option B would have answered with
the three lengths. Against that: **«арилга» occurs 0 times in 164 and «дип» occurs 0
times.** The threat cases are hypothetical and the cost is real — two of twenty-two
будаг-family messages lose a correct answer. The founder took the trade knowing «Дип будаг»
is a manicure service; it is recorded here so it can be reversed on evidence rather than
re-argued from scratch.

**And note where the invented example came from: me.** «үсэндээ дип будаг» was my
construction in the previous measurement, and the corpus says no customer has ever written
«дип» at all. It is the same error as D-099's addendum one turn later — a case that feels
diagnostic because the author wrote it. Checking whether an example is ATTESTED costs one
grep and changes what the measurement means.

### Two holes left open, both measured

**Latin.** `budag arilgah` is still `unique → Будаг`, because «Дип будаг» and «Будаг
арилгалт» carry no Latin aliases, so `{budag}` is a subset of nothing in that script — and
58.5% of the corpus carries no Cyrillic. Measured repair: add the alias rows «dip budag»
and «budag arilgal», after which all three `budag` probes return `too_vague`. It is data,
not code, and it was NOT applied here because the founder was mid-apply of the intake.

**«Дип будаг» itself** is a subset of nothing, so no shadow rule reaches it. A rename to
«Дип хумсны будаг» fixes it and was measured — but it also makes a plain «дип будаг»
`too_vague`, because «дип» is three code points and fails the length floor. That is a real
cost to nail customers for a phrasing with zero corpus instances, so it is reported and not
taken.

## D-102 — two salons under one Page, and a refusal that was right about the danger

**2026-09-20, the founder, supplying the fact none of us had.** Matrix runs a hair salon
AND a nail salon on one Facebook Page. Тайралт ба засалт, Үс будалт and Химийн үйлчилгээ are
the hair salon; Маникюр and Педикюр are the nail salon. «Будаг» is hair colouring
(135,000–200,000₮). «Дип будаг» (65,000₮) and «Будаг арилгалт» — removing polish from nails,
8,000₮ — are manicure services. **The names are not sloppy: «будаг» genuinely means two
things, and nothing should be renamed.**

### What that does to D-101

D-101 refused a shadowed single winner. It was **right about the danger and wrong about the
remedy.** The danger is a confident single price for a word the text cannot disambiguate;
the remedy is not silence but the LIST. What the customer cannot settle from their own
message, the reply settles by showing the alternatives — which is D-100's option B one level
up: three SERVICES instead of three lengths.

`shadowed` survives unchanged; it was always the right detector. Only the verdict moves,
from `too_vague` to a new `family`. Existing callers test `=== 'unique'` and so keep
refusing — serving the set is opt-in, which is the direction a new verdict has to fail in.

**The category label is load-bearing, not decoration.** «Будаг арилгалт — 8,000₮» under two
hair prices, unlabelled, reads as a cheaper colouring option — the wrong-price failure this
mechanism exists to prevent, reached by a different road. The heading is the salon's own
`services.category` as they wrote it, so the reply gains no Mongolian the client has not
already published. A single service shows no heading, because there is nothing to tell apart.

Measured: the two real messages D-101 refused — «будаг хэдээр хийх вэ» and «Тайралт будаг» —
now serve five labelled lines in **203 characters**, against a measured p90 of 364.

### Three things the measurement settled that argument could not

**The hair/nail matcher split is not worth building.** Of 164 real inbound messages,
**exactly one** mentions any nail vocabulary — «Үс будуулна, маникюр педикюр» — and it names
BOTH salons, so no disambiguation rule could resolve it. 52 mention hair. The nail salon
receives essentially no inbound traffic on this Page, and the one case a category rule would
face is the one it cannot decide. Revisit if nail traffic appears.

**«хумсны» does no work, and the family covers for it anyway.** The founder asked for
«хумсны будаг» to serve Гелэн будалт and Дип будаг. Measured, it reaches NEITHER — «Гелэн
будалт» needs `{гелэн, будалт}` and «Дип будаг» needs `{дип}`, none of which is present. The
word matches no service name at all. What it now gets is the «будаг» family, which contains
both nail services among the five, labelled — self-selection rather than targeting.

**Removing «Тэжээл» kills the collision AND the match.** The founder dropped «Тэжээл»
(44,000–88,000₮), leaving «Тэжээлийн тос» and «CMC тэжээл», which share no token — so the
collision is gone outright. But a bare «тэжээл» now reaches **nothing**: «тэжээлийн» is not a
prefix of «тэжээл» and «CMC тэжээл» needs `cmc`. His instruction was *"a customer asking
«тэжээл» should get both, not a refusal"*, and the removal makes that impossible by this
route. Measured alternative: an alias «тэжээл» on both remaining services yields `ambiguous`,
which `decidePriceQuote` also refuses. **Serving both would need `ambiguous` to serve its set
too** — a different relation (two peers, neither containing the other) and a separate call,
so it is reported rather than taken.

### The shape worth carrying

Three verdicts in one evening for one relation: serve one (D-100), refuse (D-101), serve the
set (D-102). The DETECTION never changed. What changed each time was a fact about the
business — first that «Дип будаг» exists, then that it belongs to a different salon — and
each fact arrived after a decision had been made on the assumption it did not exist.

**A collision between names is a question about the business, not about the matcher.** The
repository read «Будаг» ⊂ «Дип будаг» as a naming defect for three revisions because nobody
had asked the salon what the two words meant. One sentence from the founder settled what no
amount of measurement could.

## D-103 — `ambiguous` serves its set too, and a collision the code answers stops holding provisioning

**2026-09-20, the founder's call**, closing the question D-102 reported rather than took.

Two things, and the second is the one worth carrying.

### 1. The word should still work

Removing the service «Тэжээл» (44,000–88,000₮) was right — it should not be offered — and
D-102 measured the side effect: a bare «тэжээл» then reached **nothing**, because «тэжээлийн»
is not a prefix of «тэжээл» and «CMC тэжээл» needs `cmc`. The founder's clarification
separates the two: *"the service should be gone. But when a customer types «тэжээл» I want
both «Тэжээлийн тос» and «CMC тэжээл» shown. The word should still work."*

So «тэжээл» and its Latin twin `tejeel` are aliases on both survivors, and `decidePriceQuote`
now serves the `ambiguous` set the same way it serves a `family` — every match, each with the
salon's own category heading, and the customer self-selects.

**This is not a tie broken.** Every line names its own service, so nothing is attached to the
wrong one, which is the single failure `src/lib/reception/price.ts` exists to prevent. The
verdict still says the text did not settle which service; what changed is the policy above it.
`too_vague` is deliberately NOT swept in: there the matched term is too short to be evidence
at all — «сорри», a customer apologising, reaching «Сор» — so there is no honest set to serve.

**Ordering matters and it is not cosmetic.** Aliasing «тэжээл» onto both makes the
«Тэжээлийн тос» term a strict subset of «CMC тэжээл»'s NAME, so that winner carries
`shadowed`. `matchService` checks `ambiguous` first, so the family branch is never reached —
and it must not be, because building a family requires naming ONE of two equal winners as
the match, which is the silent pick the whole function refuses. Measured, both readings
happen to yield the same pair here. **The order is right because of what it declines to
decide, not because of the set it produces.**

**Measured against the 164-message corpus, before and after: identical.**
`{none: 132, too_vague: 7, unique: 22, family: 2, ambiguous: 1}`. «тэжээл» occurs **zero
times** in the corpus, so this change is proven by probe and not by corpus — `тэжээл`,
`tejeel` and `тэжээл хэд вэ` all reach both services, `cmc тэжээл` and `тэжээлийн тос` each
still resolve uniquely. Said plainly because the opposite was claimed twice this month: an
invented corpus and an invented proof case, both caught by the founder.

The one real `ambiguous` in the corpus is «будагтай үсний уг цайруулалт хэд вэ» → «Будаг» |
«Цайруулалт», which it now answers with both rather than refusing. The customer mentioned
both services; answering both is what a receptionist does.

### 2. A validator blocking on a relation the code handles

**`service_name_collision` held `ready` and advised a rename for four days after D-102 had
made both wrong**, and the founder found it in a dry run — «Будаг» ⊂ «Будаг арилгалт»,
«Будаг» ⊂ «Дип будаг», both marked `← holds provisioning`, beside a review sheet still
reading *"Until one is renamed the matcher returns `ambiguous` and no price is served."*

Note the shape, because it is CLAUDE.md's own recurring one from the other side. The usual
failure is a guard that silently stops firing. This is a guard that kept firing after its
reason expired — same invisibility, opposite sign. Nothing was red. The validator was
*asking the client to fix their catalogue to suit a refusal the code had stopped making*,
and D-102's own conclusion was that **nothing should be renamed**: «будаг» genuinely means
two things because Matrix runs two salons under one Page.

The hold survives in exactly one case, and it is the one the finding was originally written
for. `matchService` applies the specificity floor to the winners BEFORE it looks at
shadowing, so a subset term below `MIN_STEM_CHARS` returns `too_vague` and nothing is served
at all. That is «Сор» — 120,000–190,000 against «Оффис колор /Сор/» 380,000–460,000, 3.2×
apart, a real customer wrote «сортой» on 2026-09-14. Three code points cannot carry a
decision, and no alias and no verdict changes that.

**And «Сор» needed its own finding, not the collision's.** Matrix split «Оффис колор /Сор/»
into its own service, which removed the collision and left «Сор» exactly as unreachable as
before — seven of the 164 corpus messages reach it and get nothing. Without
`service_name_unmatchable` the service would simply have disappeared from the sheet when its
collision partner did: *the guard did not break, the reason it was true did.* It is
`ask_client` and does **not** hold, on the same footing as `no_latin_stems` — nothing wrong
is served, the turn falls through to the model, so it is a question that cannot produce a
wrong answer. Filed under its own code because the repair is different, and D-074's rule is
that a defect under the wrong reason sends the reader to the wrong screen.

**The colliding thing is a TERM, which is the service's name only sometimes.** «Тэжээлийн
тос» is not a subword of «CMC тэжээл» — its new alias «тэжээл» is. The finding said the
former until it was read back against the real intake, which would have sent the client to
check a name that resolves perfectly well. Both the finding and the sheet name the via term
now when it differs.

### What the dry run says after this

One blocker, `facts_unconfirmed`, which is the founder's own signature and his to clear. The
three collisions are `ask_client` questions; «Сор» is named without holding; with
`confirmedBy` filled in, readiness reaches **ready**. 35 services, 42 priced entries,
allow-list 7 tokens and not one of them a price.

## D-104 — the provisioning writer had never been able to write, and nothing could have noticed

**2026-09-20.** The founder ran `--apply` against the real project and it refused:
`null value in column "provenance" of relation "out_of_scope_topics" violates not-null
constraint`. Rolled back clean, Matrix untouched.

`provenance` is NOT NULL with no default and **has been since `0001`**. So
`scripts/provision/apply.ts` has never, for any tenant, been able to write an
`out_of_scope_topics` row. The nine rows Matrix carries landed because
`matrix-suitability-refusal.sql` supplies the column by hand.

### There were TWO, and the second is the reason to state the rule

`service_aliases.provenance` is in exactly the same state. Topics are written at step 4 and
aliases at step 5, so the first refusal aborted before the second could be reached: fixing
what the log named would have produced an identical crash on the next run. Both confirmed by
executing the real payloads against a scratch PostgreSQL with all 34 migrations applied, and
both confirmed fixed the same way.

**Enumerate the whole class from the catalog; never fix the error a run happened to reach.**

### How this path was tested, which is the founder's question and the real finding

`scripts/verify/postgrest.ts` exists precisely to stop this: it reads every `.from()`,
`.select()` and write payload in the tree and checks them against a live PostgREST. Two gaps
let this through, and they are different failures:

1. **`CHECKED_ROOTS` was `['src', 'scripts/publish']`.** `scripts/provision` — the one tree
   whose entire job is writing rows the database has never seen — was not in it. A writer is
   checked wherever it lives, not where the runtime lives. It is now `['src',
   'scripts/publish', 'scripts/provision']`.

2. **The check only ever asked one of the two questions.** `writeProblems` asks whether every
   key in a payload is a real column. Nothing asked the inverse: whether every column the
   database *requires* is in the payload. Every key `apply.ts` sent was real, so even inside
   CHECKED_ROOTS it would have been green.

`missingRequiredProblems` is the second question. It applies to `insert` and `upsert` and
deliberately not to `update`: an UPDATE leaves an omitted column at its old value, so a
partial patch is legitimate, while PostgREST's upsert is `insert … on conflict do update` and
the INSERT arm's NOT NULL bites on a row that does not exist yet — a new tenant, once, and
never again. Reproduced first, then fixed: with the two `provenance` keys removed the check
names both sites; with them restored it is clean.

**Its `required` set is read from the CATALOG, not from PostgREST's Swagger document**, and
that is not a preference. PostgREST derives `required` from "not nullable and no default", and
an IDENTITY column has no `pg_attrdef` row — measured against the real schema, that reading
produces five false positives (`webhook_events.id`, `alerts.id`, `spend_ledger.id`, and both
`quality_flags.id` sites), every one a generated key that a correct payload omits. `attidentity`
and `attgenerated` settle it and exist only in the catalog. Rule 4's own instruction: ask the
thing that enforces, not a description of it.

### And the parser was answering about the wrong object

Adding `scripts/provision` surfaced a third defect. `parseObjectKeys` was handed the text from
`.upsert(` onward and scanned for the first `{` — so a call whose payload is a VARIABLE walked
past it into the OPTIONS object and reported **`onConflict` as a column being written**. One
site of fifty-five: `apply.ts`'s `tenants` upsert.

That is D-057 a third time, with an extra turn of the screw worth naming. The earlier two
returned an *incomplete* answer — some keys of the right object. This returned a *complete*
answer about a different object, so no count, no key total and no summary line could reveal it.
`firstCallArgument` bounds the payload to argument one, comments stripped before the brackets
are counted (a comma inside an explanatory comment moves the boundary, which is how the fix
briefly broke the alias site it was fixing). A payload that is not a literal is UNDETERMINED.

`tenantPatch` is inlined for the same reason: a payload behind a variable is unchecked, and
`tenants` carries four required columns. **A named const is a hiding place from a static check.**

### The shape

Three of tonight's four defects are one shape — *a check that appears to cover something and
does not.* A root list that omits the one tree that writes; a column check that asks one of two
directions; a parser that answers about whichever object it found first. None of them was ever
red. The founder's `--apply` was the first thing in this repository's history to read the real
`out_of_scope_topics` schema from the writer's side.

### D-104 addendum — the tenant-side repair could not work, and nothing said so

The founder asked to see the seven corpus messages that reach «Сор» before anyone picked an
alias for it, rather than take the recommendation `service_name_unmatchable` prints. He was
right to, and the reason is better than the one either of us had.

Every `сор`/`sor` token in all 164 messages: `sor` ×3, `sortoi` ×2, `сортой` ×2. **Bare
«сор» in Cyrillic occurs zero times** — customers type the comitative «сортой», or Latin
`sortoi`, or bare `sor`. All seven are genuinely about the service, so on this corpus the
specificity floor refuses seven true positives and prevents zero false ones; «сорри» is a
constructed probe, not an instance.

**Adding «сортой» and «sortoi» to the intake changed the verdicts by nothing.** Identical
counts, byte for byte. `bestTerm` chose the winning term by token count alone, with a strict
`>`, so the first one-token term could never be replaced — and terms are `[name, ...aliases]`,
so the three-character NAME always beat the six-character alias, and the match was then
refused as `too_vague`. The repair the validator recommends in as many words could not work.

The tie-break is fixed: on equal token count a term that clears the floor beats one that does
not. Measured — with no new rows it changes **nothing**, which is the property that makes it
safe; with both aliases, `too_vague` falls 7 → 3, `ambiguous` 1 → 4, `unique` 22 → 23 and
nothing else moves. The three survivors typed bare `sor`; three characters cannot be rescued
and no alias will.

Two things to carry. **A comment asserting a behaviour nobody tested is worth nothing**: the
docstring above the verdict already said an entry "should be judged on its best reading, and
`bestTerm` has already chosen that", and it had not — the same shape as
`config/platform.ts:33` claiming a monthly ceiling that was never built. And **a finding that
recommends a repair should be tested against the repair working**: `service_name_unmatchable`
shipped advice that was false at the moment it was written, and it took a founder asking for
the corpus to find that out. Its wording now names the length the alias must clear, and says
to read it off the corpus rather than guess.

## D-105 — a provisioner that may not make a claim may not withdraw one either

**Recorded 2026-09-21, late.** The code shipped in `1187e71` under this number and this
section was never written — so for a day the only statement of the rule was a commit
message, which is exactly what this repository keeps saying not to rely on. Written here
from the diff.

**The measured cost**, found by the founder reading seq 11's publish output: an
`UNCONFIRMED photo_consultation` line that was not there at seq 10. Read from the live
project, that row's `provenance` was `seeded` while the nine suitability rows beside it
were `tenant_confirmed`, and the only thing that wrote it between those two compiles was
`--apply`. **Re-provisioning Matrix turned a claim about what a human had read back into a
claim about what a script guessed.**

D-020's rule is that only a person who has read a rule may call it `tenant_confirmed`. The
corollary nobody had written down is the one this is named for: **a script that cannot make
that claim must not be able to withdraw it.** `apply.ts` states the principle twenty lines
up about `reviewed_by` — *"it is half of a signature"*, so it is left alone — and
`provenance` is the same kind of fact and was not given the same care. An existing row now
keeps its own provenance on `out_of_scope_topics`, `comment_rules` and `service_aliases`; a
new row is still `seeded`.

**`enabled` is the sharper half, and it had not fired only by luck.** `comment_rules` wrote
`enabled: false` unconditionally, so a second `--apply` silently switches OFF every rule an
operator has read and enabled — on the one surface where the mistake is public, permanent
and screenshot-able. Matrix has fifteen rules and exactly one enabled, so this was one
`--apply` away from happening. **A provisioner that may not enable a rule must not be able
to disable one.**

Note the shape, because it is one this repository keeps meeting: the write was not wrong in
isolation. `provenance: 'seeded'` and `enabled: false` are both correct for a NEW row, and
the writer had no idea it was ever looking at an old one. **A default is a claim about a
row's history, and a writer that cannot tell a create from an update asserts that history
on every run** — D-063's backfill lesson arriving through a script instead of a migration.

**`config_audit` is EMPTY for this tenant**, so the prior provenance could not be recovered
from the audit trail; the value was reconstructed from the founder's observation plus the
code. A table that exists to answer exactly this question and is written by nothing is
D-064's shape. Noted, not fixed.

## D-106 — App Review was never the gate, and the daily cap was enforcing a superseded number

**2026-09-21**, on the eve of Matrix going live. Two corrections and one mechanism, all
measured rather than argued.

### 1. App Review: granted, no review required

`docs/comments.md` called App Review *"the first gate"* and *"the multi-week item"*, with
every other row on the comment surface downstream of it. It was wrong. The founder opened
the Graph API Explorer on `DALA_AI` and measured:

* `pages_read_user_content`, `pages_manage_metadata`, `pages_manage_engagement` — **all
  granted, no review required**
* `debug_token` on the Page token: `pages_show_list, pages_messaging, pages_manage_metadata,
  pages_read_user_content, pages_manage_engagement`, every one `granular_scopes` →
  `1520409424715591`
* `feed` subscribed on the Page object; both Pages read `feed and messages`
* A real comment produced `webhook_events` id 203 with `has_changes: true`, and
  `outbound_messages` wrote a `comment_reply` draft at 02:32:44 carrying the reviewed line

Confirmed independently against the project before this was written: that draft exists at
`2026-09-20 02:32:44.675`, and `has_changes` deliveries are arriving `routed` and
`processed` as recently as 00:39 on the 21st. **Comments already work end to end in
shadow.** STATUS.md items 10, 10b and 10c are retired.

**How it survived is the part to keep.** `developers.facebook.com` is 403 through this
environment's egress proxy, so no session could check the App Dashboard. The claim was
written once, could not be falsified from here, was read back, and was repeated as
established fact — including on 2026-09-21, to the founder, as the reason comments could
not ship that day.

That is the *identical* failure CLAUDE.md's opening describes about the Meta app's very
existence, and the rule against it — *"an unfalsifiable claim in this repository is a claim
to re-ask the founder about, not a fact to inherit"* — was already written down, one table
away, because it had already cost something once. **The rule did not fail. Nobody applied
it to the neighbouring claim.** A line this repository cannot check must name the founder
as its only source, in the line itself, or it will be inherited.

### 2. The daily cap was enforcing a number the founder had already superseded

`SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY` was `1.5`, derived from the DISCOUNTED floor:
₮200,000 × 0.40 / 3,500 = $22.86/month ÷ 30.44 × 2 = $1.50. The founder moved the monthly
ceiling to **$28.57** on 2026-09-15 (D-072 addendum) and **the daily constant was never
re-derived**, so it went on enforcing the older figure. $28.57 ÷ 30.44 = $0.939/day, 2×
headroom is $1.88, and **2.00** is 2.13× — the founder's call, on the argument below.

Measured from Matrix's own mirror, replies and DISTINCT conversations per day, priced at
D-072's $0.0406 cold and $0.0035 warm:

| day | replies | conversations | est. |
|---|---|---|---|
| 09-18 | 65 | 26 | **$1.19** — busiest measured, 79% of the old cap |
| 09-19 | 40 | 13 | $0.62 |
| 09-17 | 18 | 6 | $0.29 |

D-016's busiest day was 94 replies. At 09-18's ratio that is ~38 cold starts and 56 warm
turns: **$1.74** — which $1.50 refuses and $2.00 clears. The founder's reasoning, verbatim:
*"A first live day that stops silently is worse than the spend."* It stops **silently**
because `on_exhausted` still has no reader (D-051, D-072 addendum), so the §5.7 ladder does
not run — the tenant simply goes quiet.

**$2.00 is not yet the effective number for Matrix.** `effectiveDailyCeiling` takes the
MINIMUM of the compiled cap and `tenant_budgets.daily_ceiling × surface_fractions[surface]`,
and Matrix's row is $2.00 with `reception: 0.95` → **$1.90**. Raising the constant makes
$1.90 bind where $1.50 did; making it literally $2.00 needs the row, which is the founder's.

### 3. Cutover: the ancestor goes off FIRST, and the reason is a mechanism

The founder's instinct was right and the reason is stronger than the one he gave. D-080:
an echo moves `thread_control` to `human` **only where `delivery_mode = 'live'`**. Flip to
live while the ancestor is still answering and every ancestor reply becomes an echo that
marks its conversation `human` — and H11 check 4 then refuses exactly those conversations.
Matrix has 63 conversations and **0** currently marked `human`; the wrong order would mark
the active ones within minutes, and nothing un-marks them but the reclaim sweeper.

So the cost of "both answer" is not only a customer getting two replies. It is a persistent
state change that silences the new bot on the busiest threads, arriving through the front
door — the same trap D-080 was written to avoid on day one.

The gap in the other order is recoverable and the drafts are inert: `claim` takes an
explicit id from the turn that created it and never scans for old rows, and
`sweepStrandedEvents` only touches `webhook_events` in non-terminal states, of which Matrix
has none. **The 173 unsent shadow drafts cannot be sent by any background process** — which
is the obvious fear when flipping a tenant live with a week of drafts behind it.

One warning that belongs with the order, not after it: `POST /{page-id}/subscribed_apps`
**replaces** the field list rather than adding to it (D-043, D-062). Removing the ancestor
must be a `DELETE` issued with the ancestor's own app token, never a re-POST from either
side.

---

## D-107 — `ACTIVE_VERSION` is read at seal time only, and a working KEK is a KEK you cannot read

**The question, 2026-09-21, from the founder:** *"Is ACTIVE_VERSION read at decrypt time or
only at seal time? If only at seal, this is safe today."*

**Seal time only. The plan is safe.** Seal Matrix under `v2`, set
`TENANT_KEK_ACTIVE_VERSION=v2` in Production; tenant #0's `v1` row keeps opening, because
each row names its own version and the read path uses the row's.

Verified three ways rather than from the docstring that says so:

| Evidence | What it shows |
|---|---|
| `src/lib/secrets/tenantSecret.ts` imports `kekForVersion` and **not** `activeKek`, reads `row['kek_version']`, and calls `kekForVersion(kekVersion)` | the read path never consults the active version |
| The only `activeKek()` caller in the repository is `scripts/kek/seal.ts:95` | the active version is reachable from exactly one place, and it is a seal |
| `crypto/kek.test.ts` — with `TENANT_KEK_ACTIVE_VERSION: 'v2'` set, `kekForVersion(1)` still returns V1's key | pinned by a test, so a future edit that adds a fallback goes red |

`kekForVersion` has **no fallback to the active version and no loop over the versions that
exist**, which is what makes this a property rather than a coincidence: a row pointing at a
key we do not hold is unreadable, and saying so is correct — trying V1 for a V2 row would
turn a tamper signal into a success and make the unauthenticated `kek_version` column a
lever.

### The risk is the opposite one, and it is not the one that was asked about

The safe direction is retiring a version as ACTIVE. The unsafe one is **removing its key**.
`kekForVersion` does `required('TENANT_KEK_V' + n)`, so `TENANT_KEK_V1` must stay in the
platform environment for as long as any row names it — which is for ever, since tenant #0's
`page_token` is sealed under it and the runtime opens it on every send. Its `last_ok_at`
reads `2026-09-19 12:16:18.117+00`.

**And the value cannot be recovered.** Vercel redacts a secret on `env pull` and the
dashboard will not reveal it. So `TENANT_KEK_V1` is now a value that is *working in
production and readable by nobody*: it can be used, and it can be destroyed, and it cannot
be copied. Deleting it is not a configuration mistake that can be undone — it is the
permanent loss of a live client's Meta credential, recoverable only by re-running the
Business-Settings token dance with that client.

Nothing in `src/` can defend against that, because by the time the loader asks for V1 the
deploy has already shipped. What stands in front of it:

- **`scripts/preflight.ts` requires both names**, and fails the production build before
  `next build` when either is absent. It derives its required set from the **uncommented**
  lines of `.env.example` — so the protection is a property of a text file, and is exactly
  what a tidy-up removes. Both names now carry a comment saying so.
- **The KEK contract is matched by PATTERN, not by name.** It was keyed to the literal
  `TENANT_KEK_V1`, which was right for as long as there was one key; `TENANT_KEK_V2` fell
  through to `no format rule to check`, so a mistyped active key would have passed the
  deploy and failed at the first send, as a row nobody could open.
- **A test pins the whole of it** (`preflight.test.ts`, `DONE-TEST: retiring the ACTIVE
  version does not retire the keys under it`): dropping *either* key fails, with the
  active version at `v2`.
- **`scripts/kek/generate.ts` no longer tells the operator to use `TENANT_KEK_V1`.** It
  did, and an operator following our own tool's printed instruction today would have
  written a new key over the one that opens tenant #0's live row — the precise loss
  described above, printed as advice. It now says to use the next unused version, never to
  overwrite an existing one, and to save the value before pasting it anywhere.

### The pipeline blocker, recorded separately as the founder asked

> *"An operator who can't retrieve the KEK can't provision any client. That's a pipeline
> blocker, not a Matrix one."*

Correct, and the mechanism is `scripts/kek/seal.ts` calling `activeKek()`, which reads the
active key from **the operator's own shell** — not from Vercel, which is write-only in
practice. Provisioning client #3 therefore requires holding the active KEK value locally.
Today that is satisfied: the founder has V2. The day a laptop is lost it is not, and the
only way forward is minting V3 — which seals new rows fine and makes the environment carry
a third value that can never be read back either. **Each rotation is a one-way ratchet**,
and the set of unrecoverable-but-load-bearing values grows by one every time.

That is not the "hit by a bus" scenario D-017 weighed. It is a working operator, with full
access to every provider account, unable to read a value his own platform is using.

### Two of D-017's triggers have fired

D-017 accepted single-owner risk and says not to re-raise it — *"unless one of these
changes — each is a fact a session can check."* Stating that they fired, as it instructs,
without re-arguing the decision:

| Trigger | Fired? |
|---|---|
| A tenant is **live and paying** | Not yet — Matrix goes live today, and is not paying |
| **Customer conversation data** exists in Supabase | **Yes.** Matrix's corpus is real customers' messages; it is not reproducible from the repository |
| The **KEK is generated** and encrypts real tenant tokens | **Yes.** V1 seals tenant #0's live Page token and the runtime opens it; V2 is active |
| A **second person** joins Dalatech | No |

What changed beyond the table's own wording: it anticipated *losing* the KEK. What actually
happened is that the KEK became **unreadable while still working**, which the mitigation
D-017 names — provider recovery emails and codes — does not address at all, because there
is no provider to recover it from. That is a fact for the founder, not a decision reopened
here.

---

## D-108 — the provisioner wrote a matcher the runtime refuses, and shadow had no traffic to catch it

**Matrix went live at 2026-09-21 01:59:46 UTC and answered nobody.** The founder sent
«sain bnuu» from his own account at 02:02; `webhook_events` 266 arrived and the worker
503'd twice:

```
[worker] reception_retry {
  detail: 'matcher unusable: rule photo_consultation (Ш8): unknown matcher mode undefined'
}
```

`out_of_scope_topics.photo_consultation` held `{"stems": ["зураг","зурган","фото"]}` — **no
`mode`**. `parseMatcher` has required an explicit mode since the gate was first drafted, the
gate fails closed on an unusable rule, and so **every direct message for the tenant 503'd**.
It never reached the secret, so the KEK was never in question. Comments were unaffected: all
fifteen `comment_rules` carry valid modes.

The repair was one row, restoring `contains_stem` — what an absent mode used to be read as.

### The writer built it, so there was nothing to validate

`scripts/provision/apply.ts` wrote `matcher: { stems: n.stems }`. Not a typo: the intake
document holds a bare `stems` array for a topic rule and the WRITER manufactures the matcher
around it. Every `out_of_scope_topics` row `--apply` has ever written is unparseable, for
every tenant — client #3 would have hit it on day one.

`comment_rules` were fine for the opposite reason: their matcher arrives in the document
whole, so the validator had a value to check and checked it. **`validate.ts` states the
principle exactly, in the block immediately below the one that was missing it:**

> Validated with `parseMatcher`, the SAME function that runs the rule at request time. A
> provisioning-only validator would be a second reader of one jsonb, free to disagree with
> the first — and the direction it would disagree in is "accepted here, refuses the whole
> job there", which is a tenant switched on and silently unable to answer.

That is this outage, described in advance, by the file that failed to prevent it. **This is
the third instance in a week of the same shape**: D-105 (the `reviewed_by` principle stated
twenty lines above `provenance`, not applied to it), D-106 (the unfalsifiable-claim rule one
table away from the claim), and now this. The rule keeps being written down correctly and
applied to the neighbour that happens to hold the value. **A validator can only check a
value that exists — so where a writer manufactures one, the manufacture must be shared, or
the check has nothing to bite on.**

`src/lib/provision/matchers.ts` is that shared manufacture: `topicMatcher()` builds the row's
matcher, `validate.ts` parses *its output* rather than the document's stems, and `apply.ts`
writes the same function's result. `apply.ts` already dies on any blocker with nothing
written, so one builder, one validator and one gate close it — a second pre-flight inside
`apply.ts` would be the second reader the file warns against.

**It closes a second live route nobody had noticed.** `MIN_STEM_CHARS` is enforced inside
`parseMatcher` and was applied in `validate.ts` to service aliases only, so a three-character
topic stem passed validation, was written, and would have 503'd at request time exactly as
the missing mode did. Validating the constructed value catches both without a rule for each.

**Nothing could have caught it downstream.** `matcher` is `jsonb`, so
`scripts/verify/postgrest.ts` — which now checks that every column exists and that every
insert carries the NOT NULL columns — sees the column and cannot see inside it. The one
field deciding whether a rule is usable is invisible to every check the repository has.

### What this says about the fourteen days of shadow (founder, 2026-09-21)

> *"The mirror had no traffic between `--apply` and the flip, so shadow couldn't catch this.
> Shadow only protects you if messages flow through it after a change — that's a real limit
> on what fourteen days of mirroring proved."*

Measured, and it is exact. A customer message at 16:47 UTC on 09-20 drafted normally, which
places `--apply` after it; the next inbound message of any kind was the founder's own test at
02:02, two minutes past the cutover. **The config change landed inside an overnight traffic
gap, so the mirror had precisely zero messages to fail on.**

So "fourteen days of shadow" is not a property of the calendar. It is a property of how many
messages crossed the current configuration, and a change made in a quiet hour resets that
count to zero without resetting the reassurance. The generalisation: **a shadow phase
validates a configuration, not a system — and every edit starts a new one.**

The instrument that did work was the founder sending one message himself immediately after
the flip. Sixty seconds, one test, the whole defect. That belongs in every cutover.

---

## D-109 — a credential can be wrong in two unrelated ways, and length sees only one

**Matrix's cutover produced both, forty minutes apart, and they look nothing alike.**

| | Sealed value | `verify.ts` | Failure at send |
|---|---|---|---|
| First | **105 characters** | never run against it | `secret_undecryptable` |
| Second | **242 characters** | `OPENED` | `graph 401 code=190 subcode=463` |

The first was a **truncated paste**. The second was **whole, opened cleanly, and expired** —
a short-lived Graph API Explorer token that answered `GET /{page-id}?fields=name` at 02:0x
and was dead by 02:24.

**During the incident this session inferred that the 105 characters meant "short-lived",
and that was wrong.** It read one symptom as evidence for the other defect, and the
founder corrected it: *"Token length tells us about truncation, not lifetime.
`expires_at: 0` is the only acceptance test."* Two independent properties, two independent
checks:

- **Whole?** The character count, compared against a token known to be complete. This is
  what `scripts/kek/verify.ts` prints and what its header means by "a token you know is
  whole". It says nothing about lifetime.
- **Long-lived?** `GET /debug_token` → **`expires_at: 0`**. Nothing else establishes it, and
  no property of the string does.

**Neither is checked by anything that runs today.** `unusableBecause` in the runtime loader
rejects an empty secret, control characters and surrounding whitespace — that is the whole
test. A truncated token passes it, seals, self-checks, decrypts, and fails at Graph; an
expired one does the same. `tenant_secrets` carries no `expires_at` at all, which `0001`
omits deliberately, so expiry is discoverable only as a 401 at send time.

**The breaker did its job and should not be softened.** Three consecutive credential
failures halted the channel — `delivery_mode = 'off'`, `token_status = 'revoked'`,
`tenant_secrets.status = 'revoked'` — which is correct behaviour for a credential that
cannot be used, and the founder's own verdict was *"the breaker was correct."* Note the
recovery asymmetry that follows: `seal.ts`'s SQL restores `tenant_secrets.status` to
`active` by itself, and the two `tenant_channels` columns do not self-repair. They must move
together in one statement, because `live_requires_active_token` evaluates the finished row.

**The follow-up is a WARNING, never a refresh** (founder, 2026-09-21). Track `expires_at`
AND `data_access_expires_at`: a token with `expires_at: 0` still loses data access about
ninety days after the last authorization, so "never expires" and "never needs the human
again" are different claims. Automatic re-authorization is out of scope — the platform
should say *this credential dies on date X* early enough to act, and nothing more.

---

## D-110 — a 503 is a request for a retry until it is the last one, and nothing knew which

**2026-09-21. Matrix's first live day, event 266.** A customer message arrived at 02:02:20,
was delivered to the worker three times inside three minutes, and was refused every time by
a matcher D-108 had already broken. The founder learned about it at **02:59**, from the
hourly stranded sweep, in an alert that said the event *"was published to the queue and
never delivered to the worker."* Production logs show three `redelivery_unanswered` lines
for that id.

Three separate defects, and they compound in one direction — later, and wronger:

### 1. The sentence was inferred from a premise that is false

`sweepStrandedEvents` derived the fault from `state` alone, on the premise that every
completed worker run leaves a terminal state. It does — and it does not follow that a row
still reading `pending_enqueue` was never processed. **A run that returns 503 leaves no
terminal state ON PURPOSE**, so QStash retries. `pending_enqueue` means *no run COMPLETED*
and never *no run happened*, and the two send a reader to different systems: QStash's
console, or our own code.

The premise was written down in `stranded.test.ts`, above the test asserting the wording,
where it read as background rather than as the claim it was. **A false premise stated in a
test comment is an assertion nothing will ever check.**

### 2. `attempts` existed, and was written by nothing and read by nothing

`webhook_events.attempts` and `max_attempts` have been in the schema since `0001`. D-064's
rule is *"when you find a column, ask who writes it"*; this is the fourth instance, and the
first with a measured cost — the sweep had to guess at delivery history because the column
that records it was dead. It is written on ARRIVAL now, before anything can refuse, because
counting failures would leave a run that dies inside its own error handling
indistinguishable from a run that never happened.

It is a read-modify-write (PostgREST cannot express `attempts = attempts + 1`), which is
sound because QStash does not start a retry until the previous delivery returns. If they
ever overlap the counter undercounts by one; it cannot double-count and cannot lose the
event.

### 3. Detection was 57 minutes behind a 3-minute retry horizon

`QUEUED_GRACE_MINUTES` was **45**, sized in a docstring from "the documented shape" of
Upstash's backoff, carrying an explicit `[UNVERIFIED]` note saying to move it if the horizon
were ever measured **and longer**. It was measured and it is far SHORTER: 02:02:24, 02:02:47,
02:05:27 — about **three minutes** end to end, under the same `retries: 3` every job uses.
The guess was wrong by 15×, and the note only anticipated being wrong in one direction.

The fix is not a smaller constant. **The worker raises the alert itself**, on the delivery
it can identify as QStash's last, because it is the only place that knows both that this
delivery failed retryably and that no retry is coming. The sweep drops to 10 minutes and
becomes the BACKSTOP for the narrower class the worker cannot speak for: events that never
reached it at all. Those are still bounded by the health worker's hourly cadence, which
lives in the QStash console and not in this repository.

Matrix's `max_reply_age_minutes` went 30 → **15** at the founder's instruction, so detection
now lands at ~3 minutes inside a 15-minute window instead of 57 minutes outside a 30.

**Tightening the grace does not risk a double answer, and that is by construction rather
than by timing.** `outbound/claim.ts` asks `findReplyFor` whether this exact inbound message
already produced a reply (D-029); the grace only avoids the wasted work of a racing
re-publish. `replay.test.ts` holds the property.

### The three things this fix got wrong on its own first pass

Each was found by re-reading the diff adversarially before committing, and each is the same
shape as the defect being fixed — an alert asserting something it had not measured.

- **The re-publish at 10 minutes is inside QStash's deduplication window for the first
  time.** A publish carrying a `deduplicationId` QStash already holds returns **200** with
  the original message's id and `deduplicated: true`; nothing new is queued and nothing new
  is delivered. Read as `ok`, the sweep would have said an event was *"re-published
  successfully"* while QStash had refused it. `EnqueueResult` carries the flag now and
  `requeue_deduplicated` is a distinct action.
- **`attempts = 0` is not "never delivered" either.** The counter is written after the
  worker reads the event row, so a delivery that dies before that — unreadable row, rejected
  signature, or the counter write itself failing — leaves 0 while QStash's log shows a
  delivery. The branch names both causes instead of asserting one. Splitting a verdict and
  leaving the new branch covering two states is D-062's third turn of the screw.
- **`limitMinutes` was pre-filled with the platform default (30).** `worker.tenant_unreadable`
  and `worker.tenant_timezone_missing` both refuse before the tenant's own limit is read, so
  an exhausted delivery on either path would have printed *"30-minute reply limit"* for a
  tenant whose limit is 15 — wrong in the generous direction, in a critical alert whose whole
  content is how long a human has. It is `number | null` now, filled at the first line where
  the row is in hand, and the alert says UNKNOWN rather than substituting.

### What is not closed

The floor on detecting an event that never reaches the worker at all is still the health
worker's schedule, which is hourly and set in the QStash console. Making it more frequent is
a console change and therefore the founder's; it is recommended, not done.

---

## D-111 — the assistant's half of the conversation never reached the model

**2026-09-21. Matrix's live test: eleven typical customer messages in one thread.** The
founder's verdict was that Dala AI was far worse than the incumbent — it re-answered every
earlier question until the replies were walls of text, re-greeted every turn, and answered
one message with another message's refusal.

All of that is **one defect**, and it is not in the prompt.

`readHistory` builds the transcript from `messages`, mapping `direction = 'outbound'` to
`role: 'assistant'`. **Nothing has ever written an outbound row.** Measured against the live
project: **194 inbound rows, zero outbound, platform-wide since `0001`.** The assistant's
replies live in `outbound_messages` and were never carried across.

So every multi-turn conversation arrived at Sonnet as **N consecutive `user` turns with no
assistant turn anywhere in it.** Given a transcript of ten unanswered questions, answering
all ten is the *correct* reading, and the model said so in as many words:
«Асуулт олон байгаа тул нэг бүрчлэн хариулъя» — *there are many questions, let me answer
each one*. It was describing the transcript it was handed.

Measured in that thread, reply length by turn: **37 → 62 → 73 → 163 → 369 → 444 → 530 →
634 → 860 → 1020 characters.** Each turn added one more unanswered question to re-answer.
The re-greeting has the same cause — the model could not see that it had greeted. So does
the "wrong message" answer: «Цаг захиалмаар байна, утас хэд вэ?» got
«Эрүүл мэндийн талаар зөвлөгөө өгөх боломжгүй» because the hair-damage question one turn
earlier sat in the same undifferentiated block of user turns.

**This is D-064 applied to a value rather than a column** — computed, stored, and never
carried to the one reader that needed it, which is D-083's lesson in a third place. And
`readHistory`'s `direction === 'outbound'` branch is the dead-code half of D-064 exactly:
a branch that exists, reads as a safety feature, and cannot fire.

### Why no test caught it

`persist.test.ts` fixtures manufactured `direction: 'outbound'` rows inside `messages` —
**a shape the database has never held.** The test asserted the fixture's world, passed, and
made the branch look exercised. That is the same failure as D-029's `db.rpc` stub answering
`true`: a green suite saying nothing at all about the thing it appeared to cover.

### The fix, and the two rules inside it

History reads BOTH tables and interleaves by timestamp. Two choices are load-bearing:

- **Only `sent` and `draft` outbound rows.** A `failed` or `refused` reply was never in
  front of the customer, and replaying it would have the model build on a turn that does
  not exist for the person it is talking to. `draft` IS included, because the mirror phase
  produces nothing else — excluding it would reproduce the all-user transcript on exactly
  the conversations being run to measure quality.
- **Trim from the END.** Merging two sorted lists and taking the first N is the reflex bug,
  and it would feed the model the start of the conversation while dropping what the
  customer just said — worse than no history, because it looks like history.

An unreadable assistant half is a **refusal, not an empty history**, for the same reason the
inbound half already was: an empty assistant side is indistinguishable from this defect, so
a transient hiccup must not be allowed to quietly restore it for one reply.

---

## D-112 — forty-two confirmed prices, and not one of them reached the model

**2026-09-21, founder's call, reversing half of D-075.** In the same live thread the bot
told a customer «сор нь мэдлэгийн санд байгаа тул хэлж чадна … надад яг тоо өгөгдөөгүй» —
*сор is in my knowledge base so I can say it, but I was not given the number.*

It was describing its own prompt accurately. `priceOf` returned `null` for `exact`, `range`
and `from` — **the three kinds that have a figure** — so the price section rendered `- Сор`
with the number withheld, while `service_variants` held `120,000–190,000`, `confirmed_at`
set. Forty-two confirmed rows for Matrix; every figure suppressed.

D-075's reasoning was sound and is not discarded: `allowed_numbers` is a SET, so the guard
checks that a numeral is on the tenant's list and never that it belongs to the service being
discussed — «Омбре 33,000₮» passes. What it traded that risk for was supposed to be
`reception/price.ts` serving the figure from the row.

**That module was built, tested, and is imported by nothing.** `decidePriceQuote` and
`priceText` have zero callers. So the figures were suppressed on the strength of a comment
promising a reader that did not exist — the same shape as `config/platform.ts:33` asserting
a monthly ceiling nothing reads, and the third *built-but-never-wired* instance found in one
night alongside `webhook_events.attempts` (D-110) and the history above.

The founder's verdict, and its provenance is checkable rather than remembered: the
overnight brief of 2026-09-21 lists «claiming not to know prices it has (dye by length,
сор, CICA, manicure)» as complaint 3, and then names the figures under *facts every reply
must get right* — 135k/176k/200k by length, сор 120–190k, CICA 198k a session and 154k on a
course. An instruction to quote those entails putting them where the model can see them. So
a bot that cannot quote the salon's own confirmed prices is worse than the wrong-service
risk, and the incumbent has quoted them in production for months under disambiguation rules
rather than silence.

**Read that as a reversal made on an explicit instruction, not as a settled preference.**
D-075's mechanism argument is untouched and is restated in `docs/reports/matrix-bakeoff.md`
for the founder to re-make in daylight: the report says what is still guaranteed (the
digits-only reduction), what is not (that a price belongs to the service asked about), and
that declining to republish leaves the whole change inert.

### Three details that decide whether this is safe

- **The currency symbol goes on BOTH ends of a range.** Measured against
  `extractNumerals`: «80,000–150,000» is ONE token, «80,000₮–150,000₮» is two. With one
  token the allow-list holds only the fused pair, so a reply quoting either endpoint alone
  — the ordinary way anybody answers «сор хэд вэ?» — reduces to digits that are not on the
  list and **the guard refuses the salon's own price.** That is D-074's shape, and it would
  have shipped invisibly.
- **A range missing an end prints no figure at all.** A row meaning 120,000–190,000 whose
  upper bound is unreadable must not print «120,000₮»: a real-looking price 70,000 under
  the true one, which passes every guard because the numeral genuinely came from the
  tenant's own row.
- **No `toLocaleString`.** It is locale-dependent exactly as `localeCompare` is, and this
  string lands in the compiled prefix — so the runtime's locale would decide
  `content_hash`, i.e. the prompt-cache key (D-026).

**The guarantee that survives, stated with its mechanism:** a numeral this tenant never
published is still refused, by the digits-only reduction — not by an empty list. `150,000`
being approved does not license `1,150,000`. Between D-075 and D-112 "a price cannot be
quietly wrong" was true for the trivial reason that no price could be quoted at all, which
is the same hollow footing `allowed_numbers = []` had before Stage 4.

**This changes `content_hash` and needs a republish** through `scripts/publish/tenant.ts`,
which only the founder can run — `SUPABASE_SECRET_PUBLISH` is deliberately absent here. The
code must be deployed and pulled first (D-074's three steps: deploy, `git pull`, publish).

## D-113 — in shadow, a customer the incumbent answered is not a customer left waiting

**2026-09-24, founder's call.** *"In shadow mode, if the ancestor has already answered the
customer, don't send a 'human can still answer' alert. It's a false alarm, and I got 44 of
them."*

### What happened, measured

Matrix sat in `canned_stale` from the data edit after seq 12 until it was republished: the
canned rows no longer matched the snapshot's `canned_hash`, so `handle.ts` returned `retry`
for every message and QStash exhausted on each one. Vercel's logs carry
`canned_stale: the canned lines have changed since this configuration was published` on
every refused delivery of 731, 733, 735 and 737. Between 2026-09-21 and 09-24 that produced
**29 `webhook.delivery_exhausted` and 8 `webhook.stranded_event` criticals** — every one
`route: 'now'`, into the Telegram chat that also carries customers' demo requests, every one
saying a human could still answer.

Replayed against `webhook_events` (read-only, message text stripped): **the ancestor had
answered all 29 exhausted events before the alert fired, in 3.5–21.0 s by Meta's clock, and
7 of the 8 stranded ones.** The eighth, event 266, predates the `message_echoes`
subscription, so there is no evidence either way — and it would still page.

### The rule

`health/answered.ts`: an unanswered-customer alert pages the founder unless BOTH hold —

1. the channel would not have sent our reply anyway (`canDeliver(mode).deliver` is false,
   i.e. `shadow`); and
2. every customer message in the event has a later echo from the Page to that customer, not
   from our own app, on **Meta's clock on both sides** (the echo's `timestamp` is carried
   through `extract.ts` for exactly this).

When both hold, the event is recorded as `mirror.draft_lost` (`warn`, `route: 'digest'`)
and the 09:00 digest carries one line — `N shadow drafts lost (24h), every customer
answered by the Page. Latest: …` — naming the refusal. **Silencing them entirely was the
wrong fix and was not taken**: `canned_stale` ran for two and a half days with those false
alarms as its only symptom, and "the mirror refuses every message" must not read like a
quiet day. `live` is untouched and never consults the echoes; an unknown mode, an unreadable
or truncated scan, or a turn with no timestamp all page exactly as before.

### Two things the fix found on the way

- **The alert said the wrong code.** It printed `last: worker.reception_retry` 29 times;
  the reason that told the founder what to do — republish — was only in the log line beside
  it. The refusal's detail now travels with the trace into the alert body.
- **"QStash has no retries left" was false.** 731/733/735/737 each got a FOURTH delivery at
  about 33 minutes (`attempts = 4`, the fourth ran `reply_too_late`). The alert still fires
  on the third — for a 15-minute limit the fourth is too late — but the body now states the
  measurement instead of the claim. Why event 266 got no fourth is not established.

### What "answered" means, and does not

The Page sent this customer something after they wrote. Not that it addressed the message:
two messages seconds apart and one reply count both. For *is somebody left waiting?* that is
the right evidence; it is not a quality judgement, and the side-by-side remains the
instrument for that.

`webhook.requeued` (the sweep re-publishing an event still inside the limit) is unchanged:
it reports the platform's own floor failing, not a customer, and it fired twice in the
period.

## D-114 — the salon renamed itself on its own Page, and both bots deny it

**2026-09-24. Recorded on the founder's instruction** — *"Customers are already writing «Tara
salon». Note that for the rebrand; the bot must recognise both names."* The facts below are
read from the project; the proposal at the end is NOT applied, for the reasons given there.

### What changed, and when, from the salon's own Page

- **The Page's name.** Every feed event the Page authored carries `from.name`. It reads
  «Matrix eco salon» through 2026-09-22 03:05:35 UTC and **«Tara salon яармаг салбар»** from
  05:39:59 UTC the same morning. Same Page id, `1520409424715591`.
- **The announcement**, posted 05:36:53 UTC that day: «…салон маань шинэ нэртэй болж байна.
  🤎 TARA SALON 🤎 … Matrix-ийн 20 жилийн түүхээс TARA-ийн шинэ эхлэл рүү…», signed «TARA
  SALON · Hairstylist Oyunaa · ☎️76001888 Яармаг салбар».
- **A service renamed too**, posted 2026-09-24 03:42:44 UTC: «✨ OFFICE COLOR → TARA LUMI ✨».
  The price list still says «Оффис колор /Сор/» and nothing maps the new name to it.
- **Customers already use it**: a DM on 2026-09-22, «Sainuu, tara saloninxoon, … urdichilgaa
  awch baigaa yu?», and a comment on 2026-09-24, «Tara salon яармаг салбар yarmagtaa bizdee
  hehe».

### What each bot says, measured against the real model

Eight probes (`scripts/bakeoff/tara-set.json`: two real, six constructed — no customer has
asked about the name yet, and the finding is what happens when one does), two runs each,
through `scripts/bakeoff/dala.ts --set … --kb …` (the production compiler, gate and guard;
only the database stubbed) and through the ancestor's own `salonBrain.js`. About $0.36 of
model spend:

| Probe | Dala AI today | Ancestor today | Dala AI + the proposed row |
|---|---|---|---|
| «энэ Тара салон мөн үү?» | «Үгүй… энэ бол Тара салон биш — Матрикс эко салон» (2/2) | «Үгүй, энэ бол Matrix Eco Salon» (2/2) | «Тийм ээ… өмнө нь Матрикс эко салон нэртэй байсан манай Яармаг салбар одоо TARA SALON нэртэй боллоо» (2/2 correct) |
| «Matrix salon neree solison uu?» | «Үгүй, нэрээ сольсонгүй» (2/2) | handoff line (2/2) | «Тийм ээ, … шинэ нэр TARA SALON … Хуучин нэр нь Matrix Eco Salon» (2/2) |
| «Та нар Матрикс салон уу, Тара салон уу?» | Matrix only (2/2) | «"Тара салон"-ы талаар мэдээлэл надад байхгүй» (1/2) | one salon, both names (2/2) |
| «Tara salon яармаг салбар yarmagtaa bizdee» | «Тийм ээ, энэ бол Матрикс эко салоны Яармаг салбар» / «Тийм ээ, манай хуудас бол Яармаг салбар» — never TARA | «таны асуултыг ойлгосонгүй» / «зөвхөн Matrix Eco Salon-ы мэдээллээр» | yes, TARA SALON is the Yarmag branch (2/2) |
| the real DM above, and «Tara salon hayag haana baidag ve?» | answers the question asked (4/4) | answers the question asked (4/4) | answers the question asked (4/4) |

So a name mentioned in passing does no harm today — the one real customer who used it got a
correct deposit answer from the ancestor. **A customer who asks about the name is told the
salon is not the salon**, by both bots, on a Page that now carries that name.

### The fix is a row, not code — and it is proposed, not applied

`knowledge_documents` is generic: any tenant can carry its own names there, so this is
"client #3 fills in a config" rather than a feature. The candidate measured above:

```sql
insert into knowledge_documents (tenant_id, title, body, source)
values ('8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06',
        'Салоны нэр',
        E'Шинэ нэр: TARA SALON (Tara salon яармаг салбар)\nХуучин нэр: Matrix Eco Salon (Матрикс эко салон)',
        'Tara salon яармаг салбар Facebook хуудас, 2026-09-22');
```

It carries no digits, so `allowed_numbers` does not move — the salon's own sentence
«Matrix-ийн 20 жилийн…» was deliberately not used, because a bare `20` on the allow-list
licenses «20%» anywhere (D-055's shape). It changes `content_hash` and not `canned_hash`.

**Not applied, for three reasons that are each the founder's:**

1. Its three labels — «Салоны нэр», «Шинэ нэр», «Хуучин нэр» — are Mongolian this session
   wrote, and the model paraphrases them to customers.
2. **It makes a second claim false.** With the row in, «Tara salon heden salbartai ve?» was
   answered «Tara Salon (Матрикс эко салон) нийт зургаан салбартай» in 2/2 runs: the model
   joins the new name to «Салбарууд»'s «Матрикс эко салон нийт зургаан салбартай». The Page
   is «Tara salon **яармаг салбар**» and the post is signed by one stylist, so whether TARA
   SALON has six branches or one is a fact nobody here can read.
3. **TARA LUMI.** Neither bot knows it is Office Color. One Dala run answered «Tara Lumi
   будалт хэд вэ?» with the full-dye rows (176,000/200,000) — the price guard serving real
   data for the wrong service, because the right service is not named in the data. The fix
   is a `service_aliases` row pointing «TARA LUMI» at the right `services` row, which needs
   the founder to say which row that is.

### Also touched by the rebrand, and not changed

- `canned_responses.assistant_identity` introduces the bot as «Матрикс эко салоны хуудсыг
  хариуцдаг хиймэл оюунтай туслах» — reviewed, customer-visible, the founder's to reword.
- `tenant_booking.booking_url` is `matrixecosalon.org`. Whether that domain survives the
  rebrand is unknown here.
- `tenants.display_name` reads "Matrix Eco Salon"; nothing in the prompt reads it (D-033).
  The slug `matrix-eco-salon` is an identifier and is deliberately left alone.
- **The ancestor denies the new name to live customers today.** Its knowledge is
  `Matrix-Chatbot/config/currentClient.js`; changing it touches Matrix's live customers, so
  it is the founder's call and was not done.

## D-115 — seq 13: the Tara line is live, prices stay in the prompt and every violation is counted

**2026-09-24, founder's calls, after republishing Matrix as seq 13 (`content_hash 62d3d914…`,
`canned_hash 21ada36b…`).**

- **Decision 3 is deferred, not dropped.** *"Keep prices in the prompt, with the guard. Count
  every violation, and I'll decide after Дали is live."* The guard only counted replies that
  reached it; a reply replaced earlier (FAQ answer, pinned line, booking answer) skipped it.
  `handle.ts` now writes `quality_flags.price_violation_seen` once per model reply whose OWN
  text breaks the price-presentation rule, whatever is then served. Count them with
  `select count(*) from quality_flags where flag = 'price_violation_seen'`.
- **The bot must never deny the name.** The founder's reviewed line — «Тийм, манай салон одоо
  Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ.» — is a `deterministic_replies`
  row (`tara_rebrand`, `tenant_confirmed`), served whole before any model call when a message
  mentions Tara or asks about the name, location or branches. Stems: `tara тара нэрээ neree
  хаяг hayag байрш bairsh байрла bairla хаана haana салбар salbar`. That table is read per
  request and is not part of the snapshot, so it needed no republish and cannot make
  `canned_hash` stale. On the 236 real inbound messages on record, 17 carry one of those
  words. Its cost is stated: a message that mixes a trigger with another question («tara
  saloninxoon … urdichilgaa awch baigaa yu?», «байршил хаана вэ … хэд вэ») gets only the
  line, and an address question no longer gets the Maps link. Prices, addresses and links
  are unchanged until the salon sends new details; TARA LUMI is left alone.
- **Tara Salon's branches are named by location.** «Tara salon яармаг салбар» is Tara Salon,
  Yarmag branch — one branch today, a second coming. D-114's six-branch question is answered;
  its proposed knowledge-base row is superseded by the line above.
- `scripts/bakeoff/dala.ts --gate` runs the tenant's real refusal rules and deterministic
  rows, shaped by `reception/load.ts`'s own `toRules`/`toDeterministic`. Without it the
  harness measured a bot with no gate.

## D-116 — a row can add to an answer, and the salon's own data decides what the model may say

**2026-09-24, the founder's eight-point list after reading the seq 13 comparison.** Every
point is a row or a check on the model's text; nothing names a tenant in `src/`.

- **B1 — the Tara line never replaces an answer.** `0041` gives `deterministic_replies` a
  `placement`. `tara_rebrand` is now `append`: the reply is produced as normal and the line
  goes at the END, on every path including the handoff, and the model is told in L4 that it
  is coming so it does not contradict it. Only a message that is ONLY about the name gets
  the line alone — the new `tara_name` row, `match_mode = 'covers_message'`, which fires
  when every word is a name stem or one of its whole `cover_words`. «Tara salon hayag haana
  baidag ve?» has «hayag», so it is an address question with the line appended.
- **B2/B3 — colour prices from data, in the founder's order, then his question.** The
  `dye_prices` row quotes `quote_services` («Үсний угийн будаг», «Дунд…», «Урт…») from the
  compiled price list — the prices live in one place — then the founder's question. It
  answers «Үс будуулахад хэд вэ?» before any model call. Where the model does answer, a
  reply quoting those services in another order, or under a leaked gate label, or as a
  presentation violation, is served as the same row. The question under a price that is
  not in the set («Сор хэд вэ?») is dropped by serving the quoted rows alone.
- **B4 — never "Мастер is better".** Tenant `forbidden_phrasings` under Ш2 (always on):
  `мастер…илүү`, `туршлага…илүү`, `мастер…туршлага`, `чанар…илүү`. None matches the salon's
  own documents, FAQs or canned lines; a neutral «аль нь илүү сайн гэж хэлэх боломжгүй»
  does not match. A refused reply that quoted prices is served those prices from data.
- **B5 — the clock is Ulaanbaatar's.** The worker renders L4 from `tenants.timezone`
  (`Asia/Ulaanbaatar` for Matrix) at the real request instant. The seq 13 run was at 01:11
  UB, so c05's "closed now" was correct. `dala.ts --now` runs the comparison at a chosen
  instant.
- **B6 — advice must be in the data.** `out_of_scope_topics.grounded_only` (`0041`), set on
  the nine suitability rules. When one fires, each sentence of the reply must be at least
  four-fifths covered by 12-character runs of the tenant's own region of the prefix;
  otherwise the rule's refusal is served, opened by the quoted price rows when the rule
  allows a price. c07 is the salon's document «Химийн хориглох заалт» nearly word for word
  (1.00, 0.89) and stands; c02 («Оффис колор нь харанхуй/хар үсэнд … тохирдог», 0.34) is
  replaced. The bar was one half until the second real-model run assembled a false claim
  out of two true rows at 0.74 («…арга бөгөөд хараар будсан үсэнд ч хийх боломжтой»); the
  cost of four-fifths is that a faithful paraphrase of the knowledge base gets the refusal.
- **B7 — «Уучлаарай» only when refusing.** A model reply that opens with the tenant's
  apology word (read from its handoff row) and carries no word ending in what all its
  refusal rows share (read from the rows: «гүй») loses that word, and it is flagged
  `apology_removed`. A reply on a turn where a refusal rule fired keeps it. «Оффис колор»:
  the salon document said «Office өнгө» and the model copied it; the document now says
  «Оффис колор» — a knowledge-base edit, so it reaches the model on the next republish.
- **B8 — photos.** `photo_consultation` gains `zurag zurgan foto` and is `tenant_confirmed`.
  The new `photo_send` row answers «зураг явуулж болох уу?» with «Тийм, зургаа явуулаарай.»
  plus the reviewed «Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.»
  `covers_message` never fires on a message that carries a picture.

Found while verifying the ancestor for the same list: `salonBrain.js` sends no `thinking`
parameter (D-014), and on 25 real-model turns one reply stopped mid-word and one came back
empty. The ancestor now disables thinking and never sends a `max_tokens` stop
(Matrix-Chatbot#37). D-014's "not patched upstream" is superseded for that one line.

## D-117 — the customer's words choose the rows, and a refused reply keeps the approved line it quoted

**2026-09-24, the founder's second eight-point list, after reading every row of the D-116
run.** As in D-116, each point is a row or a check on the model's text; nothing names a
tenant in `src/`.

- **1 — «будагтай үсний уг цайруулалт хэд вэ» said there was no price.** It happens on the
  OLD configuration too, so it is the model rather than D-116: it reads «уг цайруулалт» as a
  service the list does not carry. When the reply is `refusal_price_unlisted` and
  `matchService` finds a listed name whole in the message (`unique` or `family` only), that
  service's rows are served instead (`price_unlisted_overridden`).
- **2 — «tsag zahialah» lost the deposits.** They went missing on three different paths, so
  the fix sits where every path ends: any draft carrying the reviewed booking line without
  every deposit amount gets the compiled deposit rows just above it (`withDeposits`).
  `deposit_rules` now lists Мастер first. The same probe also found a fourth path: the model
  wrote «Ш3 хамааралтай тул booking_line…», then the booking line exactly, and the gate
  label sent the customer the handoff. A refused reply that contains a reviewed canned row
  WHOLE is now served that row (`quotedRow`: exact after folding, longest wins, never the
  image line). A reviewed row is bytes somebody approved, and the model chose it.
- **3 — Мастер questions are answered neutrally.** A `stylist_tier` row
  (`covers_message`, anchored on «мастер/master»): «Мастер болон 1-р зэргийн үсчний ялгаа нь
  зэрэглэл болон үнэд байдаг. Аль зэрэглэлийн үсчинд үйлчлүүлэхээ та өөрөө сонгоно. Ямар
  үйлчилгээ авахаа хэлбэл үнийг нь хэлье.» — the founder's wording, approved 2026-09-24. Its cover words exclude «хэд», «цаг», «хэн» and «байна», so
  «Мастер хэд вэ», «Мастерт цаг авъя» and «Мастер үсчин хэн бэ» still reach the model. The
  knowledge base gains «Мастер ба 1-р зэргийн үсчин», which says the same thing. The
  suitability stylist line was the founder's own sentence from his damaged-hair FAQ,
  «…мастер үсчин зөвлөж өгнө». It was briefly reworded here to drop the tier word, then put
  back, because an unreviewed rewording of an approved line is exactly what D-065 forbids.
  The founder then changed it himself, in both places: «Үсэнд тань аль нь тохирохыг манай
  үсчин зөвлөж өгнө.» The tier document's first line now matches the approved tier answer.
- **4 — a «can it be done» question gets prices, then «the stylist decides».** `0042` adds
  `match_mode = 'on_topic'`: the row fires when any of its `stems` is a gate topic that
  fired, so `suitability_stylist` is appended to every suitability answer. When the reply is
  refused or ungrounded (D-116's check), the answer is the price rows: first any rows the reply
  quoted, else `relevantRows` over the customer's message, then over the reply. A grounded
  reply that quotes no price keeps its words, and the rows the CUSTOMER named are composed
  after it (`suitability_prices_added`); c07, the founder's own example, is exactly this. Only
  when there are no rows to give is the refusal line served. "Refused" means ANY reviewed
  refusal row, not only the rule's own: on the full run c03 was answered with the
  photo-consultation refusal word for word, and a check that knew only `refusal_suitability`
  served it with no price. A row that another rule firing on the same message points at still
  stands, because that refusal was asked for.

  `relevantRows` finds a listed name or a `service_aliases` alias whole in the text, then adds
  every listed service of the same KIND (the same last word, head-final): «himi» → every
  «… хими», but not «Хими арчилт». Two things the first real-model probe got wrong, both
  fixed: the texts were POOLED, so the model's own advice picked rows («хэт цайруулсан» →
  «Цайруулалт» for a perm question), and the order was code-point order. The texts are now a
  priority list, and the kinds come in the order the customer mentions them, with the named
  service first («budaad … himi» → the colour rows, «Үсний угийн будаг» first, then the perm
  rows). Thirteen `inferred` aliases were written for «хими/himi», the dye verbs, and
  «өнгө/ungu/ongo/ungo». The existing «buda/budag/budal» point at the inactive «Будаг» and were
  left alone. The knowledge-base document «Үсэнд тохирох эсэх» was deleted: the model quoted it
  as grounds to refuse more often.
- **5 — a photo with any caption gets the photo line.** Keyed on the attachment:
  `customerSentPhoto` is true when the message carries an `image` and no sticker id (a sticker
  arrives as an `image` too, D-070). It is served before any model call, whatever the words.
- **6 — «Салбарууд»**: one branch today, Яармаг, and a second coming. Knowledge base, so it
  reaches the model on the next republish.
- **7 — greeting** is the `greeting` row: «Сайн байна уу! Tara Salon-д тавтай морил. Танд
  юугаар туслах вэ?», on an empty history only.
- **8 — `photo_consultation` is `tenant_confirmed`.**

**Republish once, after this merges.** It covers everything in the prefix: «Оффис колор»,
«Салбарууд», the tier document, the removed suitability document, the narrowed suitability
decision questions and the deposit order. The deterministic rows and aliases are read on
every request and are already live in shadow. No `canned_responses` row changed, so there is
no `canned_stale` window.

Both new customer-visible lines, the `stylist_tier` body and the stylist line, were approved
by the founder on 2026-09-24 in the wording above. The two `deterministic_replies` rows are
read per request and took effect when written. The FAQ answer and the tier document are in
the prefix, and they reach the model with the same republish.

## D-118 — every customer-facing wording in the comparison is approved; Matrix's cutover audit

**2026-09-24, founder:** *"I approve every customer-facing wording in the comparison."* That
covers every line a customer can receive in the round-3 comparison and the five live seq 14
turns: the `deterministic_replies` bodies (`greeting`, `dye_prices`, `photo_send`,
`stylist_tier`, `suitability_stylist`, `tara_name`, `tara_rebrand`), the reviewed
`canned_responses`, the FAQ answers, and the knowledge-base documents the model quotes
(«Салбарууд», «Мастер ба 1-р зэргийн үсчин»). The rows already say so: all seven reply rows
are `tenant_confirmed`, no canned line is unreviewed, and every FAQ is `tenant_confirmed`.
This entry is the record of who approved them and when.

### Readiness for `live`, read from production on 2026-09-24

Nothing was switched. The audit is the founder's pre-cutover list.

1. **Caching: ready.** In the last 7 days, 131 of Matrix's 152 real turns read the prefix
   from cache. A cached reply averaged $0.0041 and an uncached one $0.0443. Seq 14's prefix
   is 16,354 tokens, and its first two model turns cost $0.067 uncached and $0.0061 cached.
   The spend guard reserves `RECEPTION_REPLY_ESTIMATE` = $0.041 per reply, so an uncached
   reply now settles above its reservation. That is a money question, and it is left for
   the founder.
2. **Sending: ready in code, not proven on today's bytes.** `channel/recover.ts` moves
   `authorization_error → active` on the first send that returns a `provider_message_id`,
   and only then. Meta last accepted this credential on 2026-09-21 at 03:28:45 (17 real
   sends between 02:51 and 03:29). Nothing has used it since, and a re-seal does not reset
   `last_ok_at`. Before cutover, run `scripts/kek/verify.ts` and
   `GET /1520409424715591/subscribed_apps`.
3. **Typing bubble: ready.** It is gated on `delivery.deliver` (live only). It runs after
   every exit that ends in no reply, and it is never awaited.
4. **Our own echoes: ready, with one open item.** An echo is ours if its `mid` matches a
   recorded `provider_message_id`, and an echo carrying any app id counts as "an app, not a
   person". Neither path can mark a thread `human`. Echoes never become customer messages:
   the ten events of the seq 14 test produced five drafts. The open item: no echo of our
   own send exists in production yet (echoes were subscribed at 14:55 on 09-21, after the
   17 sends). It is also unverified whether a person typing in the Page Inbox pauses the
   bot: all 51 echoes on record carry the ancestor's app id.
5. **Alerts and breaker: ready.**
   - A rate limit or a 5xx is retried by QStash, then raises one critical
     `delivery_exhausted`. That alert is suppressed only when someone other than us
     answered the customer.
   - A revoked token halts the channel, with one critical alert that has no period.
   - A reply that may or may not have arrived is parked, with one warning. It is never
     re-sent.
   - Three consecutive credential failures halt the channel.
   - The 15-minute rule (`max_reply_age_minutes = 15`): a message older than 15 minutes by
     Meta's clock is not answered and gets a `reply_too_late` flag, not a page. A stranded
     event younger than 15 minutes is re-queued; an older one is expired and paged.
   - The silence verdicts go to the digest only. Today's `no_messages` was a quiet Page:
     the ancestor's echoes stop in the same window.
6. **Comments: not ready as configured.** Comment replies follow `delivery_mode`, and
   Matrix's `comment_policy` is `public_only`, so switching the channel live would also
   post comment replies. Set `comment_policy = 'none'` in the same statement.
7. **Token: ready.** `expires_at` is null (the token never expires).
   `data_access_expires_at` is 2026-12-20 00:00 UTC. The hourly health job puts a warning
   in the digest from 2026-11-20 (30 days) and pages from 2026-12-13 (7 days).
8. **Cutover order: correct, with two additions.** See below.

### Cutover, in order

1. Run `scripts/kek/verify.ts --tenant matrix-eco-salon --channel 1520409424715591 --kind
   page_token`.
2. Run `GET /1520409424715591/subscribed_apps` and save the `dalatech` app's
   `subscribed_fields`.
3. Unsubscribe the ancestor. Do it from the `dalatech` app (1380702870025418), with its own
   dashboard or its own token. **Never with the token sealed for Dala AI**: a DELETE removes
   the CALLING app's subscription, so it would unsubscribe `DALA_AI` (1562862634970492).
4. Repeat step 2. `DALA_AI` must still be subscribed to `messages`, `message_echoes` and
   `feed`.
5. Switch Dala AI live:

   ```sql
   update tenant_channels set delivery_mode = 'live', comment_policy = 'none'
    where id = '1fb6d543-3e14-4f42-ab9e-fd39cbc09cd5';
   ```

   The CHECKs pass (`token_status = 'active'`, `name_confirmed_at` is set).

A message that arrives between steps 3 and 5 is drafted and never sent, so keep that gap
short and read the Page inbox afterwards.

### Rollback, if a live reply is wrong

1. Stop sending. The next job reads the new mode, and drafts continue:

   ```sql
   update tenant_channels set delivery_mode = 'shadow'
    where id = '1fb6d543-3e14-4f42-ab9e-fd39cbc09cd5';
   ```

2. Re-subscribe the ancestor from the `dalatech` app with the fields saved in cutover step
   2. `POST /{page-id}/subscribed_apps` replaces that app's field list rather than adding
   to it (D-043), so send the whole list.

## D-119 — Matrix's first live hour: a reply from the Page inbox is a person

**2026-09-24, measured live on Matrix's Page after the 21:54 UTC cutover.** The founder
answered a customer by hand from the Page inbox (event 768). Meta stamped that echo
`app_id 263902037430900`, its own inbox app, and not "no app". The echo rule from the shadow
phase read any app id as "an app, not a person". It was written while the ancestor answered
the same Page through `dalatech`. So the bot answered the customer's next message on top of
the staff reply (769 → 770).

The rule now:

- An echo whose `mid` is one of our sends is the bot.
- An echo stamped with OUR app id (`tenant_channels.meta_app_id`) is also the bot. The id
  alone decides, because an echo can outrun `markSent`. Every Dala AI reply in the first live
  hour came back as `1562862634970492`.
- Every other echo is a person: the inbox app, any other app, or no app at all. The thread
  goes to `human`, and check 4 keeps the bot quiet for `human_takeover_cooldown_minutes`
  (30 for Matrix). Each further staff reply restarts that clock.
- With no `meta_app_id` recorded, an app-stamped echo is not judged, because it could be our
  own reply.

### D-119, continued: the rest of the first live hour

- **«usnii himi» is hair perm in general** (771). The model read «usnii» as «Усан» and quoted
  Усан хими. Neither the Latin `service_aliases` nor the suitability rows were involved. Both
  771 and 773 were plain model replies, and aliases are read only for suitability price
  lists. The new `perm_types` row (`covers_message` on «himi/хими») lists Усан, Эмчилгээний,
  Шулуун and Афро хими from the price list, then asks which. A name that says which perm,
  such as «usan himi» or «Эмчилгээний хими», is not covered, and the model answers it.
- **A correction is never answered with the answer it corrects** (773 → 774). `0043` adds
  `match_mode = 'on_correction'`. The row's `stems` are the tenant's correction words, and
  its body replaces any reply that repeats the previous one on a turn carrying one of those
  words. "Repeats" means the same text once folded, or exactly the same prices. A customer
  re-asking in other words still gets the same answer, because that turn has no correction
  word.
- **Who are you / who made you** (775, 777) are exact-phrase rows carrying the founder's lines.
  `covers_message` would not do, because its anchors must be at least four letters, and
  «хэн», «hen» and «cmg» are three.
- **«Матрикс»** reached a customer through the reviewed canned line `assistant_identity`,
  which the model served for «ci henbe». The two rows above now answer those questions before
  the model is called. The canned line itself needs rewording, and a canned edit makes every
  reply return 503 until the next republish, so it is left to the founder as UPDATE +
  republish.
- **The Tara lines**: `tara_name` covers «tnah … salonu». The Latin greeting row no longer
  requires an empty history, so «sain bnuu» mid-conversation gets «Tara Salon-д тавтай морил».

## D-120 — the flaw loop: yesterday's wrong replies, permanent tests, spellings, facts from data

Founder, 2026-09-24, on Matrix's first live night: *"Build the flaw loop for Matrix."* Five
parts, and each is data or a property of the text, never a per-tenant code path.

**1. The morning report** (`quality/flaws.ts`, sent by the 09:00 digest job as its own
message; no QStash change). One section per live tenant, for the tenant's yesterday. It lists
real, **sent** replies where:
- the customer's next message carried one of the tenant's correction words (its
  `on_correction` row's stems);
- the customer asked the same thing again;
- the reply held the reviewed handoff or a `refusal_*` line;
- the reply opened with the tenant's apology word and refused in its own words;
- the reply said it did not understand.

Each item shows the customer's message, the bot's reply and an 8-character ref. A clean day
still sends one line per tenant, and an unreadable tenant is printed UNREADABLE, never zero.
Previewed against the live night: 5 of 7 sent replies flagged, the same five the founder
found by hand. «ci henbe» (the old Матрикс line) is not caught, because nothing in its text
is a flaw signal.

**2. Marking a reply wrong makes it a test** (`0044`). In the SQL editor:
`select mark_reply_wrong('<ref>', '<the right reply>');`. This copies the customer's message
and the ten turns before it into `reply_cases`, so the case outlives retention. Nothing
deletes a case. `active = false` is the only way to retire one, and it is a person's decision.

**3. Nothing goes out unless every case passes.** `replycases/run.ts` answers each case
through `handleReception` over the tenant's live configuration, with the real model when a
case reaches it. Drafts are recorded, not written, and nothing is sent. It runs in two places:
- in `scripts/publish/tenant.ts`, against the prefix about to be published. A failing case
  stops the publish, including in a dry run;
- in the Vercel production build, as `scripts/replycases/gate.ts` after preflight
  (`vercel.json`). A failing case fails the build, so the live deployment is not replaced.

A case that cannot be checked is a failure. That covers a table that cannot be read, a
configuration that will not load, and a case that needs the model with no key given. CI
cannot hold this gate, because it has no live database; the production build is where
"merge" becomes "goes out". Seeded with the six live failures of 2026-09-24 (766, «usnii
himi», 774, 775, 777, «sain bnuu»). All six are answered by rows, need no model, and pass
against the live configuration. A mutation that switches off `perm_types` and puts «Матрикс»
back fails three of them.

**Consequences, stated rather than discovered:**
- A newly marked case blocks every publish and production deploy until it passes. The fix is
  usually a row, which is live without a deploy. A code fix passes the gate in its own build.
- The build now depends on the live database and, for model-reaching cases, on Anthropic.
  Either being down fails the deploy, which is the fail-closed direction.
- The build reads with `SUPABASE_SECRET_WORKER`, which production already holds. No new
  credential was provisioned.

**4. The Latin-spelling list grows by itself** (`mn/latin.ts`, `quality/spellings.ts`,
`spellings`). Every morning, each unknown Latin word from yesterday's customer messages is
compared with the words in the tenant's own text, through a deliberately lossy key. The key
treats ү/у/ө/о as one letter, ы/ий/и/ь as one, and ц/ч as one (Latin `c`).
- One word fits: `settled`.
- Several words fit, and one is the stem of the rest («хими», «химий»): `settled` to the stem.
- Several different words fit: the neighbouring word is tried. A pair the tenant's text
  contains settles the TWO-word row, and the single word goes to `ask` in the report with a
  one-line `set_spelling` for the founder.
- No word fits: nothing is written.

`settled` and `confirmed` rows are applied to matching as a SECOND text: every gate and
deterministic matcher also tries the message with those words replaced. The model never sees
the replacement, and it cannot hide what the customer wrote. On the live night «usnii» meets
only «үсний» in Matrix's text, because «усны» appears nowhere in it, so it settles rather
than asks. «huuhdiin» → «хүүхдийн» makes the children's rule fire on Latin (D-067).

**5. Prices, the address, phone numbers, hours and deposits come from the data**
(`guard/facts.ts`, checked in the draft wrapper, where every model draft passes). An amount of
a fact row outside approved text is a restatement, and the reply is replaced by the rows
themselves. Approved text is: a fact row quoted whole, a reviewed line, a FAQ answer, a
deterministic reply, today's L4 line, or a contact value on its own. Twelve characters of the
address outside a verbatim quote counts too. A range names one row. A price row must be
corroborated by its range partner or by a word of its service's name in the reply or the
question. Otherwise the handoff line is served, never a guess. Hours are served as the whole
week. Set rows are served in the tenant's order with its question. Audited on four days of
Matrix's real model replies: 7 of 41 restate a fact. Six get the right rows, including three
where the model had relabelled root dye «хүзүүний урт». One, a manicure price from a
superseded list, gets the handoff. The cost is D-077's: the rest of that reply goes.

**Also measured: the inbox handover works live.** At 22:19:51 UTC, event 779 (an echo not from
our app) set Matrix's thread to `human`. Event 780, the customer's «une hedve» two seconds
later, was not answered, and was flagged `human_has_thread; 30 minute(s) of cooldown left`.

## D-121 — two wordings approved; the founder's emergency override for the reply-case gate

**Approved by the founder, 2026-09-25.** These are the two customer-facing lines D-119
introduced as my wording:
- `perm_types` question: «Та аль химийг хийлгэх вэ?»
- `correction_clarify`: «Уучлаарай, би буруу ойлгосон байна. Та юу асууж байгаагаа арай
  дэлгэрэнгүй бичнэ үү?»

Read back from the live `deterministic_replies` rows the same day: both bodies are
byte-identical to the approved text, and both rows are `tenant_confirmed`. No row changed.

**The override** (founder: *"for when the database or Anthropic is down and I need a hotfix
deployed. Only I can use it, it's logged, and it sends me a Telegram alert every time it's
used."*). The code is `replycases/override.ts`; the founder's tool is
`scripts/replycases/override.ts`.

- **Only the founder can use it.** An override is a token signed with an Ed25519 private key.
  `override.ts keygen` creates that key on the founder's machine and writes it with mode
  0600. The build verifies the token against the public keys in `overrideKeys.ts`. That list
  is **empty**, so nobody can override until the founder runs keygen and has its public half
  committed. Without the private key no one can mint a token, this session included.
- **One commit, one window.** The token names the commit (`VERCEL_GIT_COMMIT_SHA`) and lives
  at most 24 hours (default 6). Left in the Vercel environment, it does nothing for the next
  deploy. Edited after signing, or signed by another key, it is refused, and the refusal says
  why.
- **Outages only.** It lets through cases that could not be checked: a table that cannot be
  read, a configuration that does not load, a reply path that asks for a retry (the model or
  the database unavailable), or the whole check passing 180 seconds. A case checked and
  answered **wrongly** still fails the build, override or not. `runCases` now labels each
  result `wrong` or `unchecked` so the two are never merged.
- **Every use is announced, or it does not count.** The Telegram alert (commit, reason, what
  could not be checked, key id, expiry) is sent **before** the override applies. If Telegram
  does not accept it, the override is refused.
- **Logged.** The build log carries a banner with the same lines. An `alerts` row
  (`deploy.gate_override`, critical, `once`) is written when the database answers, with a
  10-second bound. It is best effort, because the database being down is one reason the
  override exists.

How to use it:
1. `node scripts/replycases/override.ts sign --sha <commit> --reason "…"`.
2. Put the printed token in Vercel as `REPLY_GATE_OVERRIDE` (Production).
3. Redeploy that commit.
4. Remove the variable afterwards.

The publish script is not covered, because a publish needs the database anyway.

Verified: unit tests cover each branch (the founder's token passes and alerts once; a
stranger's key, another commit, an expired or edited token and no token are all refused; a
wrong answer is never overridden; no alert means no override). The real gate script was run
against an unreachable database: without a token it exits 2 and names what it could not
check. A token from an unregistered key is refused, exit 2. The success path has not run
against real Telegram, because that would post into the shared chat.

**D-121 addendum, 2026-09-25: the founder's key is registered.** The founder generated it
and handed over the public half. `overrideKeys.ts` now lists one Ed25519 key, id
`33e1d9160edf3173` (the first 16 hex of the SHA-256 of its SPKI bytes). The private half never
left the founder's machine, and nothing here can mint a token with it. A test now fails CI if
any registered entry is not an Ed25519 public key, or appears twice.
## D-122 — comments get their own switch, both lines, one reply per person per post

**Founder, 2026-09-25 (overnight brief):** comments run in shadow with their own off / shadow /
live switch, independent of DMs, which stay live. Reply only to a comment that asks something
or wants information; never to praise, emoji, stickers, tags between friends, jokes or the
Page's own comments; at most one reply per person per post. A complaint gets no reply and a
Telegram alert with the link. The reply is the public line «Сайн байна уу! Манай хуудас руу
мессеж бичвэл дэлгэрэнгүй хариулъя 😊» plus, at the same time, the private message «Сайн байна
уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.» Both wordings are the founder's
and approved. Comments do not go live until he switches them.

**The switch.** `0045` adds `tenant_channels.comment_delivery_mode` (`off` default). The
comment job runs only when it is not `off` and `comment_policy` is not `none`, and it reads
this switch, never the DM `delivery_mode` (`canDeliverComments`). `live` posts only while
`token_status = 'active'`: both halts write the token status, so a halted channel stops
posting publicly without `halt.ts` naming one more column in the statement that must never
fail.

**Both lines.** `comment_policy` `both` and `private_only` are built. The private message is
`POST /{page-id}/messages` with `recipient.comment_id` and no `messaging_type` (Meta's
private reply). The public row and the private row are both drafted before either is sent;
each has its own claim, so a refused public line never withholds the private one. "Both" with
either line unreviewed sends neither: half of "both" is a different policy. When the customer
answers the private message it arrives as an ordinary DM and is answered as one.

**One reply per person per post.** `outbound_messages.comment_from_id` records who a comment
row answers. The rule is read from it (no time window) and, for the private message, enforced
by the unique index through the key `pr:{post}:{from}`. The per-thread rule stays.

**Tags and the post's age are read from Graph**, because the webhook does not carry them —
measured: 72 real comment deliveries, none with `message_tags`; a tag arrives only as a name
in the text. `comments/lookup.ts` reads `message_tags` on the comment and `created_time` on
the post, only for a comment already decided worth answering. A tag of anyone but the Page
refuses (`comment_tags_person`); a post older than `comment_max_post_age_days` refuses
(`post_too_old`, closing §3.8.2 rule 5, which docs/comments.md called a precondition for
live); anything unreadable refuses (`comment_lookup_unknown`). This path cannot be exercised
from this environment (graph.facebook.com is unreachable here), so its first real run is in
production, in shadow.

**Complaints** keep the `comment_escalated` flag row and now also raise a `comment.complaint`
alert (`once` per comment, route `now`) with the comment's text and a link built from
`value.post.permalink_url` plus `comment_id`. Raised in shadow too: nothing is posted either
way, and a complaint is no less real because the bot is rehearsing. The link format is
Facebook's documented share form and is unverified from here.

**The classifier stays rows.** The shared matcher language gains four modes: `has_word`
(whole words, which is what makes «ib», «pm», «хэд», «вэ» safe below the stem floor; `?` and
emoji are tested as symbols), `ends_with` (a fused question particle, «арилдагуу»), `all_of`
and `not` (only inside `all_of`, nesting at most three). `scripts/provision/templates/
comment_rules.salon.json` is a vertical template of 40 rules; `scripts/provision/comment-rules.ts
<slug>` prints the SQL that installs it (upsert and enable; every other rule of the tenant
disabled, not deleted). Every reply rule excludes laughter; the generic service question also
excludes praise, which is what keeps «Ямар гоё будаг вэ» (an exclamation) silent while «Энэ
ямар будаг вэ» is answered.

**Tested, permanently** (`comments/salonRules.test.ts` over `salonCorpus.fixtures.ts`): all 42
real comments (33 with text, 9 stickers/photos; the Page's own 30 are skipped before any rule),
and at least 30 written examples each of question, praise, tag, emoji, complaint, joke and
Latin-typed — zero replies to praise or tags, asserted as a count. The first version of the
rules was then probed with 52 comments it had not been tuned on; five misses and three false
alarms were fixed and every probe was added to the corpus.

**Known and left:** a bare service noun («Үс будуулах», «Usnii emchilgee») is silent. It is
probably a request, and on the DM surface it is answered; on the wall, precision is kept over
recall until the shadow list says how often it happens. «Муу» alone escalates; «муу биш» does not.

**Addendum, 2026-09-25 (founder).** The cap of **20 public replies per post per day** is
approved as set (`tenant_channels.comment_replies_per_post_per_day = 20` on Matrix's channel).
It sits on top of one reply per person per post, which is unchanged: the cap bounds a viral
post, the person rule bounds one commenter.

**Same day, the `tara_rebrand` append lost its «Тийм,»** (founder's wording). Appended under
an address or location answer, «Тийм,» agreed with a question nobody asked. The append row now
reads «Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ.»;
`tara_name` — the `covers_message` row answering *is this Tara / Matrix?* — keeps «Тийм,»,
because there it answers the question. A `deterministic_replies` UPDATE, live on write with no
republish; read back NFC. Reply case 1 expects `tara_name` and is unaffected; the old append
text survives only inside recorded case histories, where it is what the customer saw.

**Addendum, 2026-09-25 evening (founder): a location question with a laugh, and the staff
who answer by hand.**

*Laughter.* «Tara salon яармаг салбар yarmagtaa bizdee hehe» (webhook 749) — the Page and its
branch named, then *it is at Yarmag, right?* — was silent: every reply rule excluded laughter.
The founder wants it answered and the ≥30 jokes kept silent. Rows only: `location` and
`location_branch` no longer exclude laughter (no joke in the corpus carries a location word,
and a location question with a laugh on the end is still one), and `location_branch` accepts
the confirmation particle «биз / biz / биздээ / bizdee / биздэ / bizde» as a question word.
Every other reply rule keeps the exclusion — that is where the jokes are («Халзан хүнд хэд вэ
хаха») — and `salonRules.test.ts` now asserts the two location rules are the only exceptions.
749 fires because it contains «салбар» (inside the Page's name); a bare «yarmagtaa bizdee
hehe» stays silent, since a place name is tenant data (`tenant_branches.stems` is where it
would come from). 749 and «Үнэ хаяг» (784) are in `REAL_COMMENTS` expecting a reply: 43 real
comments, 78 deliveries, 35 the Page's own. Matrix's live `location` and `location_branch`
rows were updated to the template the same evening (compare-and-set on the old matcher hash,
read back: 40 enabled rows equal the template); comments stay `shadow`. Note that 749 is a
reply inside a thread where the platform had not drafted: had the bot answered 412 in that
thread on 09-22, the one-reply-per-thread rule would silence 749. That rule is unchanged.

*Staff first.* The salon's staff answer comments from the Page, and every such comment is
already stored — the Page's own comments arrive on the `feed` subscription (35 of 78). So
before drafting, and again before any live send, the comment path now reads the Page's
comments on the post from `webhook_events` (jsonb containment on `raw_payload`, one query per
post, `comments/staff.ts`) and refuses when **(a)** a Page comment's `parent_id` is this
comment (`staff_replied`) or **(b)** a Page comment on the same post names this commenter
(`staff_tagged_commenter`); an unreadable check or a missing `from.name` refuses
(`staff_check_unknown`). Each writes `quality_flags.comment_staff_answered` with the proving
Page comment's id and `at: decision | before_send`, never the text or the name. Our own
posted replies (`provider_message_id`) are excluded. The check sits after the verdict (praise
stays `comment_not_worth_reply`, a complaint still escalates) and before the person and thread
rules, which is what stops `resumePending` from posting a draft decided before the staff
answered. Before a live send it runs after the claim and before the Graph call; answered means
the row goes to `refused`, unreadable means `failed` and a 503.

The tag is read from the NAME because the webhook has nothing else (0 of 78 deliveries carry
`message_tags`): the commenter's `from.name`, as whole words in order, anywhere in the Page
comment, on `messageWords` (NFC, `mn-MN` fold, punctuation and emoji stripped) — no `\b`. A
tag the staff shortened to one name is not recognised. "The Page is somewhere in this thread"
is deliberately NOT a refusal: 749 sits in a thread the Page answered for someone else.

*No Graph read.* It would add Page comments whose webhook never arrived (before 2026-09-20,
or dropped) and ones whose payload the purge has nulled (Matrix: 30 days). It is not made:
the decision follows the comment by seconds, a staff reply's webhook arrives within seconds
(751: created 14:10:21, received 14:10:27), and a fail-closed gate on the live send that
cannot be exercised from here is a gate nobody has seen work.

*What the re-check does not do.* The Page's 29 replies on record came **47 s to 7.5 h** after
the comment (median 28 min; 4 of 29 inside 2 min); a live send follows its decision by about a second. So the
re-check catches a draft resumed later, not a staff member typing at the same time — on
2026-09-25 the bot, live, would have answered «Үнэ хаяг» at 06:49 and the staff would have
answered it again at 14:19. Closing that needs a hold before sending (a delay, then this same
check), which is a separate decision for the founder. And (b) cannot tell a thank-you from an
answer: 751 thanked Saran Tuul for her praise, so once it exists her question (749) reads as
handled.

Tested: `staff.test.ts` (the matcher and the decision), `eligibility.test.ts` (ordering),
`worker/comments.test.ts` (shadow refusal and flag, the read's filters, our own reply excluded,
unreadable ⇒ retry, live re-check refusing both lines once, a resumed draft stopped), and
`worker/comments.realThreads.test.ts`, which replays the real threads of 2026-09-22 to 09-25
(`realThreads.fixtures.ts`) through `runCommentJob` over an in-memory store.

## D-123 — the morning report reads what a reply says: former names and internal instructions

**Founder, 2026-09-25:** the morning report missed «ci henbe», where the bot called the salon
«Матрикс». Flag any reply that calls the salon Матрикс / Matrix, and any reply that mentions
internal instructions unasked.

Every earlier signal in `quality/flaws.ts` reads the SHAPE of a conversation — a correction, a
repeat, a handoff, a refusal. None reads what the reply says, so a wrong name went through.
`quality/leaks.ts` adds two content checks, both reported in the morning report, neither
enforced at send time:

- **`old name (…)`** — the reply uses one of `tenants.former_names` (`0046`). Rows, not code:
  the next business to rebrand fills in a column. Links are masked first, because
  `matrixecosalon.org` is still the salon's real website and quoting it is not calling the
  salon Matrix. Matrix's row: `{Матрикс, Matrix}`.
- **`internal (…)`** — a gate label («Ш0»), an internal identifier (`refusal_public_channel`,
  `facebook_page`), a section heading copied in capitals («БЭЛЭН ХАРИУЛТ»), `===`, or words
  describing the bot's instructions or the data it was given («заавар»/«заавр», «дотоод»,
  «надад өгсөн», «мэдээллийн сан», «тухайн байгууллагын мэдээлэл»…). Approved text (reviewed
  lines, enabled deterministic replies) is cut out first. When the customer asked about the
  bot, its rules or its instructions, it is not flagged.

**Measured against the 201 replies on record** (10 days, drafts and sent): 23 flagged, every
one a true positive on reading — 21 greet as «Матрикс эко салон» (shadow-era drafts before the
rebrand, plus the live 03:28 reply on 09-21), one draft named `refusal_public_channel` to a
customer, one said «Тухайн байгууллагын мэдээллийн санд…». The live «ci henbe» reply of
2026-09-24 21:57 is flagged twice: «Матрикс» and «Дотоод зааврынхаа талаар…». The first form
of the check missed the second flag — «заавар» drops its vowel when inflected — and the
stem list now carries both.

## D-124 — a reply that needs no model: where the 3.5 seconds went, and the typing bubble's order

**Founder, 2026-09-25:** replies that need no model call still wait about 3.5 s. Find where
the time goes and cut it without weakening any guard; measure before and after on live
traffic. And confirm the typing bubble shows on live replies, from real logs.

**Measured before** (the seven live turns of 2026-09-24 21:54–21:58, `webhook_events` →
`outbound_messages`, plus each job's `reply_timing_ms`): Meta → our webhook 0.6–1.7 s;
webhook → worker start ~0.9 s (the webhook route and the QStash hop); the worker's reads
before the reply ~1.25 s, every one sequential — event 70, attempt count 50, tenant 65,
channel ~60, context 450, inbound persistence 205, thread state 50, history 60, guard 300;
a row-answered reply 110–170 ms; trace 50, claim 50; the Graph send ~600 ms. A no-model reply
therefore lands ≈3.8 s after the customer pressed send.

**Cut, with every refusal evaluated in the same order as before:**
- the attempt counter, the tenant row and the channel row are read together;
- the reply context (ten reads, ~450 ms) starts as soon as the tenant is known and is
  awaited just before the history read, so it overlaps the inbound persistence and thread
  check. The one ordering change: the customer's message is now stored before a context
  failure refuses the job — which is "persist everything" and is safe on the retry, since
  persistence is idempotent and `findReplyFor` still decides whether to answer;
- the answer trace is written together with the claim;
- in `spend/reserve`, the platform counter's seed (an idempotent insert of a ceiling that is
  compiled in code; no money moves) is issued with the ceiling read. The charge itself —
  the reservation row and `reserve_spend_all` — is unchanged and still last.

Expected ≈0.45 s off the worker; the after-measurement is the next live no-model turns
(`reply_timing_ms`: `context_load` should read near zero, `attempt_write` should absorb the
tenant and channel reads).

**The typing bubble had no instrument.** `showTyping` swallowed every outcome, so "it shows"
could not be read from production at all; it now logs `typing_indicator` with its outcome
and duration. And it was fired without awaiting: for a reply that needs no model, the reply
is ready ~150 ms later while the bubble's own request takes longer, so the bubble could reach
Meta AFTER the answer and hang «typing…» under it. The first fix made the send wait for the
bubble; measured live, the bubble took 1.2 s on a cold lambda, so that would have cost every
no-model reply the round trip the rest of this change saves. The shipped rule: **the reply
never waits.** If its bubble had not landed when the reply went out, `typing_off` is sent
once it lands (bounded by `TYPING_WAIT_MS`, 1.5 s, after the send). A model reply's bubble has
always landed, so nothing extra is sent. **Confirmed live** at 2026-09-25 04:55 UTC:
`typing_indicator { outcome: 'sent', ms: 1197 }`, and the context load overlapped completely
(`context_load: 0`).
## D-125 — a tenant with two branches: ask which one, never guess, and change nothing for one

**2026-09-25. Built, not applied, not published.** Matrix is becoming Tara Salon and will
send new prices, a new domain, new map links and a SECOND BRANCH. Until now a tenant was one
place: `contact_points` is keyed `(tenant_id, kind)`, so it could hold one address and one
map link. `0047` makes the data model and the reply path ready for two or more locations.
Nothing here touches Matrix's rows, and Matrix's compiled prefix and replies do not move.

### The rule

- **A question whose answer differs by branch, from a customer who has not said which
  branch: the bot asks.** A question whose answer is the same at every branch: answered.
- **A customer who names a branch — in this message, or in an earlier message of their own
  — gets that branch's facts.** A reply about the other branch, or both, is replaced by the
  named branch's own rows when the branch was named in THIS message; when it was named
  earlier, the bot asks, because «нөгөө салбарынх?» names no branch and means the other one.
- **One branch, or none, is today's tenant, byte for byte.** Nothing is split below two
  active, confirmed branches.

### How it is built, and why each piece is where it is

**Rows, not code.** `tenant_branches` (name, customer spellings, order, provenance) and three
side tables holding only what DIFFERS per branch: `branch_contact_points`, `branch_hours`,
`branch_variant_prices`. Where a branch has no row, the tenant-wide row applies to it. Side
tables rather than a `branch_id` on the old ones, because admitting a second address to
`contact_points` means replacing a live primary key, which is not additive.

**The compiler decides what is shared** (`prompt/tenant.ts`, `planBranches`). A fact whose
effective value prints identically at every branch stays in the tenant-wide section where it
always was; one that differs leaves it and appears under each branch's own heading
(`=== ХОЛБОО БАРИХ — Яармаг салбар ===` etc.), after a `=== САЛБАРУУД ===` list. Compared as
rendered lines. Hours are one fact, the week; a service is one fact, all its variants — so
the prompt never shows half a service in one place. An unconfirmed branch price shows the
service with no figure, never the tenant-wide price the row says is wrong.

**The check is a property of the reply's text, like `guard/facts.ts`** (`branches/facts.ts`,
run in the same draft wrapper every path ends in). It reads each branch's rows back out of
the compiled prefix and asks whether the reply carries one of them whole, an amount only
some branches carry, a phone in the model's own format, twelve code points of an address, or
a branch's link. Text the tenant approved (reviewed lines, FAQ answers, deterministic rows,
deposit rows, L4) is masked first, so the handoff line's phone numbers never read as the
model choosing a branch. `guard/facts.ts` reads the branch sections too, so a branch fact in
the model's own words is still replaced by its row first; the branch verdict then judges
those rows.

**Only model text is judged.** A reviewed line or a deterministic row is the tenant's own
words; a tenant that writes one branch's address into a FAQ answer has chosen to.

**The question is the tenant's reviewed `clarify_branch` line, or nothing.** Missing or
unreviewed, the handoff line is served (flag `branch_ask_unavailable`) — never the guess.
Asked on the previous turn and still unanswered: the handoff (`branch_ask_repeated`), so it
cannot loop. The kind is `MODEL_INVISIBLE_KINDS`, so inserting or editing the row moves no
`canned_hash` and needs no republish. The wording is the founder's and is NOT written:
`prompt/drafts/branch_clarify.mn.txt` carries two unsigned proposals.

**Naming a branch.** Its `stems` plus the words of its name no other branch shares, matched
at token starts over folded text. A word two branches share names neither — «салбар» is in
both names and in nearly every location question, and establishing every branch would
switch the question off exactly where it is needed. The same across scripts: a `salbar`
stem is dropped because D-120's lossy key says it is «салбар». A branch left with no usable
word would make the bot ask for ever, so the publish refuses it instead.

**L4 says which branch is open** when the branches' weeks differ; one line when they agree.

### Two properties the design rests on, both measured

1. **A one-location tenant is untouched.** `branches.test.ts` compares the compiled
   `content_hash`, `canned_hash` and ten recorded replies against values produced by the
   PRE-CHANGE code at `5edc916` — measurements of the old code, not of the new. Adding ONE
   branch row, however different, still produces the old hash. Mutating the threshold to one
   branch fails those tests; switching the branch check off fails seven others.
2. **Deploying before `0047` is pushed cannot take a live tenant down.** The reply path
   reads the branch tables only when the LIVE snapshot lists branches, and a snapshot can only
   list them after a publish that read those tables. The publish path reads them always, so a
   publish before the push refuses with `tenant_branches unreadable` and writes nothing.

### What is not built, and costs stated rather than discovered

- **The discarded answer.** When the bot asks, the model's reply is thrown away whole,
  including anything else it said (D-077's cost). A gate instruction telling the model to ask
  first would save the wasted call; it would be signed platform Mongolian and is not drafted.
- **The week is one fact**, so «10:00-20:00» on a Monday-to-Saturday question is asked about
  when only Sunday differs. Over-cautious in the safe direction.
- **Deposits, the booking link, closures, FAQs, knowledge documents and canned lines stay
  tenant-wide.** A branch that takes different deposits is not modelled.
- **A branch that does not offer a service at all** is not modelled (`none` is refused in
  `branch_variant_prices`).
- **`answered_by` on the trace** records `model` for a draft the wrapper replaced — true of
  `fact_restated` before this change too. The flag rows say what was served.
- Found while reading, not fixed: `prompt/tenant.ts` says «Only CONFIRMED rows reach here:
  `loadTenantKb` filters on `confirmed_at`» of `service_variants`, and `loadTenantKb` does not
  select or filter `confirmed_at`. A comment asserting a filter that does not exist (D-072's
  shape). Fixing it could change Matrix's prefix, so it is reported, not changed.

### Adding the second branch — the rows, in order

Tenant id from D-114. Only the SECOND branch needs contact, hours or price rows: the first
keeps every tenant-wide row. Names and values in `<…>` are the salon's.

```sql
-- 1. Both branches, confirmed. Latin spellings customers use go in `stems`.
insert into tenant_branches (tenant_id, name, stems, ordinal, provenance) values
  ('8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06', 'Яармаг салбар', '{yarmag,iarmag}', 0, 'tenant_confirmed'),
  ('8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06', '<name> салбар', '{<latin>}',      1, 'tenant_confirmed');

-- 2. What differs at the second branch: its address, map link, and phone if it has its own.
insert into branch_contact_points (tenant_id, branch_id, kind, value)
select b.tenant_id, b.id, k.kind, k.value
  from tenant_branches b,
       (values ('address', '<address>'), ('maps_url', '<https://maps.app.goo.gl/…>'), ('phone', '<phone>')) as k(kind, value)
 where b.tenant_id = '8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06' and b.name = '<name> салбар';

-- 3. Only weekdays whose hours differ (weekday 0 = Sunday).
insert into branch_hours (tenant_id, branch_id, weekday, opens, closes, closed)
select tenant_id, id, 0, '<12:00>', '<18:00>', false from tenant_branches
 where tenant_id = '8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06' and name = '<name> салбар';

-- 4. Only prices that differ, per variant. confirmed_at null = shown with no figure.
insert into branch_variant_prices (tenant_id, branch_id, variant_id, price_kind, price_min, price_max, confirmed_at)
select b.tenant_id, b.id, v.id, 'exact', <price>, null, now()
  from tenant_branches b
  join services s on s.tenant_id = b.tenant_id and s.name = '<service name>'
  join service_variants v on v.tenant_id = s.tenant_id and v.service_id = s.id and v.variant_key = '<variant key or empty>'
 where b.tenant_id = '8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06' and b.name = '<name> салбар';

-- 5. The founder's approved question. CHOSEN 2026-09-25: Proposal A of the draft, with
--    «асууж байна вэ»; the second branch's name (and «уу»/«үү» after it) comes from the founder
--    when the branch is added:
--    «Та манай аль салбарын талаар асууж байна вэ? Яармаг салбар уу, эсвэл <second branch> уу?»
--    («уу» follows the last word's vowels: after «салбар» it stays «уу»; after a name ending
--    in front vowels it becomes «үү»).
insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
values ('8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06', 'clarify_branch', 'mn-MN', '<approved sentence>', '<name>', now());
```

Then: push `0047` (read the ledger), deploy, `git pull`, dry-run `scripts/publish/tenant.ts`
— it prints `NOTE: branches appear for the FIRST time` — then publish. Before publishing,
re-read every row that states ONE location as the salon's: the «Салбарууд» knowledge
document (it says one branch), any FAQ or deterministic row carrying the address, and the
handoff line's phone numbers. Those are tenant text and are served as written. The new
domain is a tenant-wide edit (`tenant_booking.booking_url`, `contact_points.website`) and
the `booking_line` canned row carries the old URL: a canned edit makes every reply 503 with
`canned_stale` until the republish (D-058), so edit and republish together.

## D-126 — tomorrow's hours as one day, the holiday line, and a person who replies while the bot is writing

**2026-09-25, founder, from three live DM flaws.**

**1. «Hi margaash tanaih ajilahu» got the whole week.** The model had answered it right —
«Тийм ээ, маргааш манай салон 10:00–20:00 цагийн хооронд ажиллана» (`quality_flags` 153) —
and `guard/facts.ts` (D-120) refused hours in the model's own words and served the only hours
it had, all seven days. The founder's answer is one day: «Маргааш (Бямба) 10:00–20:00
ажиллана.» Two layers now give it:

- **A row, no model.** `0048` lets a `deterministic_replies` row use the gate's own matcher
  (`match_mode = 'matcher'`; `0049` lets such a row pass the "an enabled row can match" CHECK
  without stems), because this needs two words together — *tomorrow* AND
  *working / closed / holiday* — and no existing mode could say "and". The body is the
  tenant's sentence with two slots, «Маргааш ({tomorrow.day}) {tomorrow.hours} ажиллана.»,
  filled per request from `business_hours` on the tenant's clock (`reception/daySlots.ts`).
  The row is **withheld** — the model answers — when tomorrow has no hours, is closed, falls
  in a `tenant_closures` range, or the tenant lists two or more branches. It stays silent on a
  message that also asks a price, a booking or an address. The vocabulary is
  `scripts/provision/templates/day_hours.salon.json`, tested as written.
- **The guard, when the model answers anyway.** Hours restated about ONE day — «маргааш»,
  «өнөөдөр» or exactly one weekday name in the model's words — are served as that day: the
  tenant's tomorrow sentence when it has one, otherwise that day's hours row. Only when the
  amount really is that day's; «маргааш» over the wrong day's hours keeps the week.

**2. «Margaash automashingvi bvh niitiin amraltiin udur ym bn» got the PRICE refusal.** The
model wrote a sensible holiday refusal; `gate/pinned.ts` scored it 0.754 of
`refusal_price_unlisted` — same frame, different subject — and served the price row
(`quality_flags` 154). The founder's answer: that day's regular hours plus «Баярын өдрийн
цагийг 76001888 дугаараас лавлана уу.» The tomorrow row fires on holiday words too, and a
second row (`holiday_hours_note`, `append`) adds the holiday line to whatever is served, so a
holiday question without a day still gets it. «Баярлалаа» never does: the words are whole
words, not the stem «баяр».

**Open, not fixed:** the pinned-line mechanism will still serve a topic-specific refusal to a
different topic that shares its frame. D-077's rule is that an adapted approved line is drift
and the row is served; serving the WRONG row is worse than the drift. Proposal: when the
adaptation replaced the row's own subject words, serve the handoff line instead of the row.
The founder's call.

**Both are permanent cases** (`reply_cases`), judged by what must and must not appear —
the right answer names tomorrow, so it changes with the day the gate runs on. A closure day
tomorrow makes the first one fall to the model; that is the row doing its job.

**3. A person who replies while the bot is writing wins.** H11 check 4 asks before generating,
and the model takes seconds. `handover/presend.ts` asks again beside the claim, immediately
before a live send: `thread_control` set to `human` at or after the customer's message, OR an
echo to this customer stored after the customer's own event and not sent by our app — read
straight from `webhook_events`, so a staff reply counts before its own job has run (0.17 ms,
primary key and a jsonb containment filter). If so, our reply is marked `refused`
(`human_replied_before_send`, terminal, so no redelivery sends it) and flagged. An unreadable
check SENDS and logs, as check 4 does. What it cannot see is a reply Meta has not delivered
to us yet.

**The case the founder cited was not this race, and it matters for trusting the fix.** In
conversation 63a52c70 the customer wrote at 14:16:41 and our reply went at 14:16:58; the
first staff reply to that customer was «Болноо» at 14:17:27, after ours. The 14:16:57 staff
echo («Манай салбар ажилна») went to a DIFFERENT customer — conversation a70ce9fe, three hours
after the holiday question. So on 25 Sept the staff answered on top of the bot, not the bot on
top of the staff; the re-check would not have changed that turn. From the first staff echo on,
the bot stayed silent in 63a52c70, as check 4 is meant to make it.

**The digest reports the Ulaanbaatar day that just ended** (founder moving it to `5 16 * * *`
UTC, 00:05 Ulaanbaatar). The flaw report already used the calendar day (`previousDate` on the
tenant's clock). The three counters used a rolling 24 hours, which is "yesterday" only by the
accident of the run time; they now count 00:00–00:00 of that day (`reportWindow`), and the
header names it.

**Addendum, 2026-09-25 evening — two decisions (founder).**

- **When the checker is unsure, the general line.** An approved line found adapted INSIDE a
  reply (`embeddedAdaptation`) is the unsure verdict: refusal rows share their frame and phone
  sentence, so a refusal about one subject reads as an adaptation of another's. It now serves
  the tenant's `handoff` line, never that other row. A near-copy of the WHOLE reply (≥0.9,
  D-065's «би») is certain and still gets its row. FAQ drift is unchanged: its match is the
  answer's own content, not a shared frame. Counted as before (`canned_paraphrased`, whose
  detail now says which was served).
- **No hold on comment replies.** A comment is answered as soon as it is decided. The staff
  check (D-122 addendum) therefore protects the seconds before a send and every later resend,
  not the typical 28-minute staff reply; the founder accepts that. Comments went live the same
  evening.

**Addendum, 2026-09-26 — tenant #0's own Page (DalaTech) gets comment replies (founder).**

- Rules are `scripts/provision/templates/comment_rules.software.json` (29, installed with
  `comment-rules.ts dalatech --template software`; `scripts/provision/dalatech-comment-rules.sql`
  is what was applied). The salon template's complaint, price, location, booking, info, praise,
  laughter and greeting rules carry over unchanged — none names a salon service. Its service
  questions become questions about the products, plus `any_question_mark` (any «?» that is not
  praise, a laugh or a bare greeting). `ad_keyword` answers the words of the company's own ads,
  «Message» and «combo» (and «мессеж», «комбо»), whatever sits beside them: `reply` outranks
  `ignore`. Only a complaint outranks it, and a complaint is escalated, never answered.
- Channel `cc5e2748…`: `comment_policy = both`, cap 20 per post per day, and posts up to 365
  days old — ads run on posts older than Matrix's 30 days. Held in `shadow` until the private
  line is approved; `both` refuses to send either line while one is unreviewed.
- **No comment has ever reached this platform from that Page**: zero `feed` events since
  2026-09-06, against 18 DM events. The app's `feed` subscription for Page `863503883522801`
  is missing, and nothing can go live until it exists. `POST /{page-id}/subscribed_apps`
  REPLACES the field list (D-043), so it must name `messages` and `feed` together.

**Business Suite automations and the "a person replied" rule — not measurable yet, and why it
matters.** An echo not sent by Dala AI's own app counts as a person (`controlFromEcho`), and a
staff reply typed in the Page inbox arrives stamped `263902037430900`. Whether Meta's automated
messages (instant reply, comment-to-message) carry that same id could not be settled: in every
stored delivery on both Pages there is no automation echo at all, and Meta's documentation is
unreachable from here. What the code already guarantees: an automated DM to someone who has
never written to the Page attaches to no conversation (`conversationForPsid` → null) and moves
nothing, so the comment-to-message automation cannot silence Dali for a new contact. What it
cannot rule out: an automation echo into an EXISTING conversation, stamped with the inbox's id,
would read as a person — 30 minutes of silence, and the pre-send check would drop a reply in
flight. The measurement is one test comment while the automation is still on; the echo's
`app_id` answers it.

**Addendum, 2026-09-26 — automations are not people, and the bot never discusses its own
instructions unasked (founder).**

- **Measured**: a test comment «message» on DalaTech's Page produced Meta Business Suite's
  public auto-reply «chat bicnuu» (created in the same second) and an automated DM «sn bnuu»
  8.6 s later, whose echo carried app id `263902037430900` — the id a staff reply typed in the
  Page inbox carries — and no other distinguishing field. It marked the founder's own
  conversation `human` (19:19:46) and the auto-reply read as staff answering the comment.
- **The fix is rows**: `tenant_channels.automation_texts` (`0050`). An echo or a Page comment
  whose text is one of them (NFC, whitespace collapsed, case folded; exact — a looser match would
  let a person's «Болноо» pass as an automation) moves nothing and is not staff. DalaTech's
  channel lists the two measured texts. Any automation whose text changes must be updated there.
- **Never the bot's own instructions unless asked**: a model reply that talks about its
  instructions — «промпт», «дотоод заавар», «зааврынхаа», a gate label, an identifier, a section
  heading — is replaced by the handoff line and flagged `internal_instruction_blocked`. Narrower
  than the morning report's `internalMentionIn`, which also counts «тохиргоо» and «мэдээллийн
  сан», words DalaTech's answers about its product legitimately use.
- DalaTech's approved private comment message and "who are you" answer are rows
  (`comment_private_reply`, `deterministic_replies.assistant_who`); reply case pins the latter.

## D-127 — both bots become salespeople: the next step and the lead, in shadow first

**Founder, 2026-09-26:** *"Both bots become salespeople. Every chat should end with a next step,
without being pushy."* DalaTech offers the demo, or asks for a name and phone number, and the
lead goes to the founder's Telegram. Tara offers booking (link and deposit), or asks for a phone
number so the salon can call back, and suggests one related service where it fits.
*"Propose all new Mongolian wording for my approval, test on real traffic in shadow, and show
me before anything goes live."*

**What is built is the instrument, not the behaviour.** No customer-visible change.

- **The decision** is `src/lib/sales/nextStep.ts`, a pure function.
  - **When:** once per conversation. Never after a complaint (the tenant's own
    `comment_rules` escalate rows), a person in the thread, a phone number already given, a
    photo, a refusal or handoff line, a reply that asks the customer something, a greeting, or
    a stray key.
  - **Which:** a step whose intent words fire, lowest priority first. Otherwise the tenant's
    default step.
  - **Related service:** its own verdict, once, when the customer names a paired listed
    service uniquely.
- **The lead detector** is `src/lib/sales/phone.ts`. It finds 8-digit Mongolian numbers:
  joined, halved, paired, dashed, or behind `+976`. It never matches prices, times or ranges,
  and never the tenant's own published numbers. Records carry the number masked («7600****»),
  never digits.
- **The rows** are `0051`: `sales_playbooks` (mode `off`/`shadow` only, so no live mode
  exists; plus the lead route), `sales_next_steps` (bodies NULL until chosen), and
  `service_pairings` (seeded, unconfirmed). Not `canned_responses`: that would put a sales
  sentence in the cached prefix and move `canned_hash`.
- **The hook** sits in `worker/reception.ts`, after the draft, beside the claim. It is capped
  at 250 ms, cannot reject, and reads the stored reply. It writes only `quality_flags`
  (`sales_next_step_shadow` per reply, plus `sales_lead_shadow` when a phone number is
  present). It does not touch `handle.ts`, the handover code, or any alert.
- **The retrospective** is `scripts/sales/retro.ts` over seven days of real DMs
  (`docs/reports/2026-09-26-sales-shadow.md`). Tara: 17 of 37 conversations would have ended
  with a step, and 12 of the other 20 got no reply at all. No customer gave a phone number.
- **The words** are in `prompt/drafts/sales_next_step_{tara,dalatech}.mn.txt`. They are
  unsigned, with two options each.

**Open, for the founder:** the wording. Tara's lead destination: Telegram to a salon chat is
recommended, if the staff use Telegram. Whether a refusal should carry the call-back ask. And
before live: count the step as offered only after a confirmed send. Today a failed send
consumes it.

### D-127 addendum (2026-09-25, evening) — the founder's decisions on the first report

- **A percentage from the tenant's own data is quoted, not invented.** The outbound guard used
  to refuse every percentage while `kbHasPromotion` was false, which it always is. So DalaTech's
  team discount (−10/−15/−20%) and its 50/50 website payment could never reach a customer in the
  model's words: FAQ 6 and 7 went out as the handoff line. Now item 3 refuses only a percentage
  the tenant's sections do not state. `tenantPercentages` reads them off the snapshot and
  subtracts the gate's as a multiset, because the gate's percentages are counter-examples (Ш6
  quotes «10% хямдралтай» as the answer it forbids). Matrix's only 10% is that one, so Matrix
  still refuses every percentage. A customer typing a figure does not approve it. Concession
  vocabulary is unchanged, and no tenant has a Ш6 rule row today.
- **Only Дали is built.** The live data marked Вира ИДЭВХТЭЙ in two places (its knowledge
  document's title and the «not running yet» line) and the approved price_overview row. All
  three now say Вира, Эхо, Нова and Ора are coming soon with pre-registration, using the
  sentence the rows already used for the other three. Reply case 9 moved with the price row in
  one transaction. The knowledge documents reach the model at the next republish.
  - The sales shadow sends a question naming any of the four to the call-back row, which reads
    as pre-registration. It never goes to the demo, which would sell the product as available.
  - The four names are intent words on DalaTech's row, not the software template, because they
    are one tenant's products.
- **The demo page is a contact point** (`demo_url`, `0052`), so the guard allows the link
  and the prefix can label it.
- **Tara's leads go to a Page inbox label**, because the salon does not use Telegram. Only the
  shadow reads `lead_route` today; the label write is built with the live switch.
- **Automation texts:** four for DalaTech and Tara's away message, both as provided and with
  the typographic apostrophe. The match is exact, so a curly quote would otherwise count as a
  person. All of it is in `scripts/provision/decisions-2026-09-25-evening.sql`.

### D-127 addendum (2026-09-26) — wording approved; the test-set read fixed at the root

- **Sales wording approved, still shadow.**
  - **DalaTech:** demo A, callback A and lead_thanks A.
  - **Tara:** booking B, which is «Цаг захиалах бол: » followed by the approved booking_line, read from its row. Callback A and lead_thanks A are approved but disabled until the salon is confirmed to call back from the inbox label, so Tara's next step is booking only.
  - Tara's related-service step and all eleven pairings are gone, because Tara does not recommend services.
  - The record is `scripts/provision/sales-wording-approved-2026-09-26.sql`.
- **The founder's read of the test set was reproduced in CI**, because the report was not on a reachable branch.
  - `scripts/bakeoff/dalatech-live.json` holds the live gate half and tenant half. The prompt was rebuilt from the repository's gate, and it hashes to the live `content_hash`.
  - `.github/workflows/testset-dalatech.yml` answers the set with the real model, and runs only on purpose.
  - The baseline scored 45/53, and every lost answer had a named cause:
    - k03: refused as not Mongolian, because of the tenant's own Latin e-mail.
    - x03: a correct total refused as an unapproved numeral.
    - c02 and t02: «24/7» and «4».
    - v03: an adapted approved line, then «unsure», then the handoff line.
    - q04: a gate label.
    - n02: an English answer.
    - p03: a clarifying question in place of the list.
- **What changed, and why each is the root rather than a patch:**
  - **The generic fallback is the tenant's reviewed callback line when it has one** (`fallbackLine`). Founder: a customer who wants to buy must never be told we have no information. A specific reviewed refusal still wins. The line is read best-effort, and Tara's is disabled.
  - **Contact values are excluded from the script share.**
  - **`shownTotals`:** a total passes only with its work shown. The addends must be approved prices written in the reply; a discount must be an approved percentage written in the reply. A bare figure that happens to be a sum stays refused.
  - **Aliases corroborate a price row** in the facts guard. A three-letter name such as «Эхо» could not otherwise be tied to «Эхогийн».
  - **Three reminders are read last in L4:** reply in Mongolian, never write the gate's labels, answer first. They are code-owned scaffolding like `LABELS`, and never approved text.
  - **An apologetic opening question** that the reply answers itself goes with the apology.
  - **`covers_message` matches a stem under the floor as a WHOLE word**, where it used to skip the row. Measured: DalaTech's price row went silent for minutes when data ran ahead of this code, and was reverted. Any row using a short stem must follow the deploy.
  - **Data rows, all reusing approved sentences:** a general price question gets price_overview (a `covers_message` row, pending the deploy); robot-or-human questions get assistant_who; naming any of the four coming-soon staff appends «…хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно»; a general discount question gets FAQ 6. The record is `scripts/provision/dalatech-testset-fixes-2026-09-26.sql`.
  - **Test set:** the forbidden list holds positive forms only (a substring test cannot see negation, so v01's correct answer failed). l03 now fails on any wording that puts Вира beside Дали as running.

### D-127 addendum (2026-09-26, later) — the open items decided

- **A price row is owned by what the MODEL named, not by an approved line it quoted.** The coming-soon line names all four coming-soon staff, so a reply carrying it corroborated every one: «Эхо минутаар хэдээр…» was served Ора's 250,000₮, and «Дали, Вира хоёр…» nine rows. Name words are read with quoted approved lines blanked. Rows of one service tied on an amount are told apart by the variant written in that amount's own clause.
- **A joke gets the off-topic line** (t02). This is a DalaTech `out_of_scope_topics` row answered straight from `refusal_off_topic` with no model call. It fires on a laugh (the tenant's own comment-rule laughter words) AND a question, with no business word. «хаха» alone still goes to the model.
- **The coming-soon status follows the REPLY** (s04). The new matcher mode `in_reply` reads the reply about to be sent, and only the deterministic append pass supplies one; everywhere else it never fires. An append row judged on the reply joins only if the message alone did not fire it, and not when the reply already carries its line.
- **Complaints keep «Уучлаарай».** A complaint is recognised by the tenant's own `comment_rules` escalate rows, the same rows the comment classifier and the sales shadow read. Stripping the apology had left r01 opening on «Хариу удсанд тань.», half a sentence.
- **QPay is in DalaTech's knowledge base** as a document the model words itself, not a verbatim FAQ answer. It is in the compiled prefix, so customers see it only after the founder's next publish. `compile-tenant.ts` on DalaTech's live rows reproduced the live `content_hash` 1b8bb21f (the control) before the change was compiled (ba3e4ed4).
- The record is `scripts/provision/dalatech-decisions-2026-09-26b.sql`; the `in_reply` row follows the deploy.

### D-127 addendum (2026-09-26, third set) — price sentences, callback rows, QPay wording

- **Only the price sentences become rows** (founder: *"Keep the model's sentences that contain no price, and replace only the price sentences with the data rows. Everything kept still goes through the facts guard."*). `splitFacts` checks each sentence with the rest of the reply as context. A sentence that restates a fact becomes its rows; the others stay as written. It falls back to the old whole-reply rows on one sentence, on an amount nobody owns, or when the assembled reply does not itself pass `checkFacts`. «Дали юу хийдэг вэ?» now keeps its description.
- **The cost, stated:** a kept sentence can still be wrong in ways the facts guard cannot see. The first replay kept «Дали хараахан ажиллаж эхлээгүй» (a false claim that Дали is not running) in x03. The test set's forbidden list now carries it.
- **l04 and v05 answer from the approved callback line, with no model call.** A pre-registration request (`preregister_callback`), and paying without an advance or in instalments (`terms_callback`), are `contains_stem` rows. Their body is read from the reviewed sales callback row. The coming-soon rows still append the status line.
- **QPay in the founder's words:** «Бүх төлбөрийг, үүнд сарын төлбөр багтана, QPay-ээр төлөх боломжтой.» It reaches customers at the next publish.
- The record is `scripts/provision/dalatech-decisions-2026-09-26c.sql`.

## D-128 — Telegram cleanup: once-ever criticals become episodes, one 09:00 report

**Founder-approved from `docs/reports/2026-09-25-telegram-inventory.md`** (§4, "Fix while
there" and "Merge into one daily report").

**Once-ever criticals are episodes now.** Five keys had no period and were `daily`. So
after the first row they could never fire again:

- `model_not_found:{id}`
- `secret.kek_unavailable:{tenant}`
- `secret.undecryptable:{tenant}:{channel}`
- `outbound.{token_revoked|channel_permission_error}:{tenant}:{channel}`
- `secret_expiring:…`

All are `on_change`. Each closes when its condition clears:

- `model_not_found` closes on the next clean call on that id. `resolveEpisodes` runs one
  conditional UPDATE per reply, on the partial open-key index. There is no cache.
- The four credential keys close on the next send that goes out for that tenant and channel.
- `secret_expiring` warn and critical close when the hourly health run no longer classifies
  the credential that way. That covers a re-seal, a warn becoming critical, and a credential
  that is no longer live.

A recurrence opens a new episode and pages again. The three-day STILL OPEN re-escalation now
covers these criticals too.

`alreadyRaised` for `on_change` now reads only `on_change` rows. Without that, the old `daily`
rows under the same keys would gag the new episodes for ever. **Expect one page per condition
that is still true when this deploys**, because the old rows no longer suppress it. Nothing on
the project was read to count them.

**The 30-day credential warning is finally shown.** It was written to a digest that lists
only `on_change` rows. As an episode, it is an open condition every morning until it clears.

**`DAILY_REPORT_V2=true`** switches two things together. `alerts/alert.ts`'s
`dailyReportV2()` is the only reader.

1. **Non-actionable warnings go to the daily report** (`quietRoute()`):
   - a re-publish that worked (both REFUSED variants still page)
   - `model_swap` and `cache_cold`
   - `channel.credential_failure` below the halt
   - `outbound.reply_indeterminate`
   - `purge_backlog`
   - `channel.recovered`
   - `privacy.erasure_requested`
2. **The digest sends ONE report**, in this order:
   - A: dalatech-app's section, fetched with `DAILY_REPORT_SECRET`. On any failure it prints
     an `UNREADABLE — reason` line.
   - B: the digest, with STILL OPEN as lines. `notified_at` moves only when B's message was
     delivered.
   - C: «Yesterday», the held-back events grouped by kind.
   - D: the flaw report.

   The report is split into `(1/2)`, `(2/2)` at section boundaries above 3,900 characters.

Unset, today's behaviour and message count are unchanged, which the tests pin.

**Schedule: one QStash schedule, `0 1 * * *` UTC (09:00 Ulaanbaatar).** If a 00:05
(`5 16 * * *`) schedule exists, the founder must delete it. The QStash console is the only
place that shows it.

**Preflight** requires none of the three variables. It refuses `DAILY_REPORT_V2=true` without
`DAILY_REPORT_SECRET`, any value other than `true`/`false`, and a non-https
`DAILY_REPORT_SECTION_URL`.

**Not done:**
- Tenant names instead of raw ids in alert bodies.
- Everything in the inventory outside dala-ai.

A resolved critical is closed without a message; the resolve is logged and `resolved_at` is
the record.

### D-128 addendum (2026-09-26) — the daily report runs at 00:05 Ulaanbaatar

The founder moved the report to **00:05 Ulaanbaatar (`5 16 * * *` UTC)** so it arrives during
his US day, and approved the sample. **Keep exactly one QStash schedule for
`/api/workers/digest`: `5 16 * * *`.** Delete `0 1 * * *` if it exists.

- **This half needed no code.** `reportWindow` and the flaw report take the Ulaanbaatar
  calendar day before the one the run falls in, which at 00:05 is the day that has just
  ended. A delivery up to 23h55m late still reports that day. A delivery six minutes EARLY
  (before local midnight) would report the day before; QStash does not fire early.
- **dalatech-app's section was wrong at 00:05.** It counted «Шинэ хүсэлт (өнөөдөр)», the
  requests created in the current Ulaanbaatar day, which at 00:05 is five minutes old and
  always 0. It now counts the day that just ended, as «Шинэ хүсэлт (өчигдөр)», so it is right
  at any run time. Follow-ups are unchanged. They count whole days elapsed, so a once-a-day
  run reaches each of day 3, 7 and 14 exactly once whenever it fires. Both are tested there.
- Comments, STATUS and the sample now say 00:05. The 3-day re-escalation, the «Yesterday»
  section and the counters are unaffected: none of them depends on the hour.


## D-129 — the model account pages: credit, billing, and a rejected key (2026-09-26)

**What happened.** On 2026-09-25 the Vercel production key's Anthropic account ran out of
credit. Every model reply on the platform became the handoff line, and nothing reached
Telegram. Anthropic answered **HTTP 400 `invalid_request_error`** («Your credit balance is too
low…»), the same status and type as a malformed request, so `classifyError` filed it as
`invalid_request`, a per-reply `quality_flags` row that nobody reads at the time. The
reply-case gate is what surfaced it, a day later, by failing every production deploy.

**Decision (founder).** A model call that fails because of credit, billing, or an invalid or
revoked key pages at once. It pages once per episode, and pages again if the fault comes back.

- `TerminalReason` gains `billing`, from 402, a body typed `billing_error`, or a 400 whose
  message names the credit balance or Plans & Billing. That is the one place the classifier
  reads message text, because the status cannot tell the two cases apart. If Anthropic
  rewords it, the call falls back to `invalid_request`: quieter, never refused.
- `billing` and `auth` (401/403) raise `model_account:{fault}`: critical, `route: 'now'`,
  `on_change`, tenant null (one key serves every tenant). `quietRoute()` never demotes it.
- A clean call closes it in the SAME conditional UPDATE that closes `model_not_found`, so
  the platform still issues one statement per clean reply. When an account episode closes,
  one Telegram line says so. `resolveEpisodes` now returns the keys it closed, and the
  UPDATE hands each key to exactly one caller.
- **Residual.** The hourly unique index on `alerts` suppresses a second page within one clock
  hour of the first, so a fault that clears and recurs inside the hour pages once.
- **Tested with stubs, no spend.** The real classifier runs on the exact 400 body, through the
  real raise and resolve, with Telegram's `fetch` stubbed. Five failures produce one page,
  the recovery produces one line, and a recurrence produces a second page.

## D-130 — Tara takes no leads: booking is its only next step (2026-09-26)

The salon confirmed its staff will not call customers back. Tara's `callback` and
`lead_thanks` rows are deleted (both had been disabled since 2026-09-25), and booking —
«Цаг захиалах бол:» plus the approved booking line — is its only next step. `lead_route`
gains `none` (`0053`), because leaving `page_label` would record every volunteered number as
routed to a label nobody wants. A number a customer types anyway is still detected, masked
and recorded, and it still silences the next step for that turn. The Page inbox label was
only ever a recorded value: no code calls Graph `custom_labels`, so nothing exists on Meta's
side to remove. Nothing in Tara's compiled prompt asks for a phone number; its lines give the
salon's numbers only. DalaTech keeps its approved `callback` and `lead_thanks`. The salon
template (`sales_playbook.salon.json`) keeps a callback step, because it is per-vertical, and
another salon may call back.

## D-131 — a channel that comes back answers the customers its halt left waiting (2026-09-26)

**What happened.** At 01:09 UTC Tara's Page token was cancelled (190/460). The reply to
«Сайн уу танай хаяг хаана бэ» was marked `failed`, the channel halted, and a new token
brought it back. Nothing then answered that customer: no path ever re-drives a `failed`
reply, and a message arriving during a halt is stored and deliberately not generated. The
founder answered by hand.

**Decision (founder).** When a channel comes back after a halt, answer each message that
failed on the token error, if it is under 24 hours old and no person or later reply has
answered it since. Page the founder at halt time with the number waiting.

- **Held is recorded at the time, never inferred afterwards.** Two kinds of message count:
  - a reply `failed` with Graph `code=190`, or with the breaker's `no credential:` prefix;
  - a `held_channel_halted` quality flag, carrying `message_id`, which the worker writes when
    it stores a message it will not generate for because the channel is HALTED
    (`status = 'authorization_error'`). A channel switched off for any other reason writes
    none, so it is never caught up.
- **One reply per conversation, to its latest customer message**, generated with the whole
  conversation in view. If the customer wrote again after the channel came back, the normal
  path owns the newer message and there is nothing to catch up.
- **Skips:**
  - older than 24 hours (Meta's window);
  - a `sent` reply of ours after the message;
  - a person replied. This uses `personRepliedSince`, the same check a live send makes. It
    reads the stored echoes, so it sees a hand reply typed DURING the halt, when
    `delivery_mode = 'off'` meant no echo could move `thread_control`. Measured: the
    founder's reply this morning is `webhook_events` 833, an echo from the Page inbox app
    `263902037430900`, not DALA_AI, so it counts as a person;
  - already attempted (a `catch_up_enqueued` flag; one attempt per message, ever);
  - anything unreadable (retried next hour, never guessed).
- **How it answers.** The hourly health run enqueues the message's own stored event with
  `catchUpMid`. The worker then re-runs only that message, against a 24-hour limit instead
  of the tenant's, and may claim a reply that failed on the credential. Every gate a live
  reply passes still applies, including the person-replied re-check before the send.
- **The halt page** (Graph 190 and the breaker's halt) now says how many customers are
  waiting and that they will be answered within an hour of the channel coming back, unless
  a person replies first. An unreadable count still pages, as "an unknown number".
- **Cost, stated.** When the held message's reply had already failed, the worker still makes
  one model call before it finds the stored body and sends that. At most one call per
  halted conversation.
- **The first run, predicted against live data (2026-09-26 03:4x UTC):**
  - DalaTech's 190/467 message from 09-25: the customer wrote again and was answered →
    `newer_message`.
  - Tara's 01:09:56 message: answered by hand, echo 833 → `person_replied`.
  - Nothing is sent.

## D-132 — DalaTech's salesperson goes live; Tara stays in shadow (2026-09-26)

**Decision (founder).** *"DalaTech salesperson: go live without waiting for shadow numbers (my
Page gets little traffic). Tara stays in shadow until real-traffic numbers."* After Дали
answers a DalaTech customer's question, price or otherwise, it adds the approved follow-up,
exactly:

> Дали бол таны бизнесийн Facebook, Instagram, вэбсайтад ирсэн зурваст 24/7 хариулдаг AI ажилтан.
> Үнэгүй демо вэбсайт авахыг хүсвэл: https://app.dalatech.online — 24 цагийн дотор бэлэн болно.
> Манай бусад AI ажилтнуудтай https://dalatech.online дээр танилцаарай, эсвэл асуух зүйлээ энд бичээрэй.

The rules:
- once per conversation;
- not after a complaint, a greeting or a thanks;
- the approved demo, callback and lead_thanks lines still apply when the customer asks for a
  demo or a call, or leaves a number.

**How.**

*The decision is the shadow's own.* `sales/live.ts` runs D-127's `decide`, unchanged, on the
reply exactly as it will be sent. It is the last step of `handleReception`'s draft wrapper,
which every path passes through. It adds nothing when any of these holds:
- a complaint (the tenant's escalate rows), in this message or an earlier one;
- a refusal or the handoff line;
- a reply that asks the customer something;
- small talk: the tenant's whole-message rows, or the new `sales_playbooks.small_talk` list;
- a stray key;
- a reply that already carries a step's words or link;
- an earlier assistant turn that carried one ("once per conversation", read from the
  conversation itself).

Otherwise it adds the step whose intent words fired (`demo`, `callback`), or the default,
which is now the `follow_up` row. It uses only reviewed rows, served whole.

*A number is answered, not sold to.* A new phone number gets the reviewed `lead_thanks` line
with no model call, and the lead goes to the founder's Telegram with the digits. That is the
one place the digits go: the flag rows keep them masked. A repeat of a number already given
is neither thanked nor sent twice. A `lead_route = 'none'` tenant takes no leads.

*Rows.* `0054` adds `mode = 'live'`, `small_talk` and the `follow_up` kind. The switch is
`scripts/provision/dalatech-sales-live-2026-09-26.sql`:
- the follow-up becomes the default and demo stops being one;
- the small-talk list is added;
- the four exact price cases gain the follow-up;
- the mode is set to `live`.
Tara is untouched.

**Tested before switching.**
- `scripts/bakeoff/dalatech-sales-set.json`: fourteen realistic conversations covering a price
  question, a second question in the same chat, a greeting, a thanks, a complaint, a demo, a
  call, a number, and a greeting with a question.
- They are answered in CI over the dump carrying the live configuration, beside the 53-case
  set, whose four exact price cases now expect the follow-up.
- They then become permanent `reply_cases`.

**Replayed before the switch (CI run 36218713869, real model, the live configuration dumped).**
Results: 53/53 on the existing set and 14/14 on the sales set.

What the replies showed:
- **Price:** the price rows, then the follow-up, exactly.
- **A second question:** answered, with no second follow-up.
- **Greeting and thanks:** greeted or thanked back, with no line.
- **Complaint:** «Уучлаарай…», with no line.
- **Number:** the thank-you line, with no model call.
- **Call:** answered, then the approved callback line.

One gap, fixed before the switch. «Демо үзмээр байна» was answered by the model's own
sentence with the demo link. That counts as the step already carried in the reply, so the
approved demo line never appeared. The founder's rule is that the approved demo line applies
when the customer asks for a demo, so the switch adds `demo_request`: a `covers_message` row
whose body IS the reviewed demo row. It fires only when every word is a demo word or a filler
word, so a question ABOUT the demo still goes to the model.

Checked without the model after the change:
- `sd1` and `sd2` now expect the demo line exactly, and pass;
- `e01` and `e02` in the 53-case set still pass.

`sd3`, a question about the demo, is new. It is proven only by the production gate after the
switch.

## D-133 — DalaTech's look, its thanks and greeting replies, and why gate labels leaked (2026-09-26)

Founder, 2026-09-26: four changes for DalaTech. Tara is not affected except by the fourth,
which is platform-wide.

**1. The look, as a row (`0055`, `tenants.reply_style`).** Option A, approved: a staff
member's price reads «💬 Дали — AI хүлээн авагч» / «💰 Сарын төлбөр: 250,000₮».
`reception/style.ts` re-lays only lines that ARE price-list rows, character for character,
after the facts guard has served them. It types no number, and every digit comes from the
row. The same row carries `max_emoji: 1`. It caps emoji in the model's own words, and keeps
none on a complaint or on a reply carrying a reviewed refusal or handoff row. Approved lines
keep their own emoji. A tenant with no row gets exactly what it got. The follow-up row is
replaced by the approved text. The service is renamed «Дали — AI хүлээн авагч» to match the
approved look. That rename reaches the prefix only on a republish. Before the republish the
header reads the old name, and the permanent cases assert only «💬 Дали», so they hold both
before and after.

**2. Thanks.** «Баярлалаа» got «Тавтай морил!», which welcomes an arrival. A whole-message
`thanks` row now serves the approved «Зүгээр ээ 😊 Өөр асуух зүйл байвал бичээрэй.»

**3. The invented name.** A plain greeting was answered «Дала апп» plus the coming-soon
line. The cause is in the data, not the model: DalaTech's compiled prefix never contained
the word DalaTech. Its data marker section is empty, `display_name` is rendered nowhere
(D-033), and no document names the company. The model named the product after the demo URL.
Two changes follow:
- a whole-message `greeting` row serves the approved introduction, so a greeting gets a
  short greeting only;
- a knowledge document «Нэр» states the company and assistant names, reaching the prefix on
  the republish.

**4. Gate labels, at the source.** Every caught leak had one shape: the Ш-rule walk as the
first paragraph («Ш0 (…) болон Ш2 (…) хамаарч байна.»), a blank line, then the real answer.
The guard refused the whole reply, so case 20's discount question got the handoff line.
The instruction not to write the labels was already in L4. The reason it failed is that
the checklist block asks the model to walk the rules before answering, and thinking is off
(D-014). The walk had nowhere to go but the reply.

It has a place now. L4 tells the model to do the walk inside `<check>` and write the
customer's reply inside `<reply>`. `model/reception.ts` `replyOf` returns only the `<reply>`
body. Without tags, the `<check>` blocks are removed and the rest is the reply, exactly as
before. Every guard, the label guard included, still reads what is returned, so a label
written inside `<reply>` is refused as it always was. This applies to every tenant.

Case 20 goes back on only after `dalatech-repeat-set.json` (x02 eight times, real model)
passes eight of eight.

## D-134 — why DalaTech's publish gate flipped, and making it stable (2026-09-26)

Founder, 2026-09-26: three runs of the same configuration, `350f5f01`, minutes apart. The
dry run passed 36/36. Publish run 1 failed case 23 and publish run 2 failed case 40. *"Find
out why these replies vary between runs … make the gate reliable … Don't make cases so loose
they stop catching real problems."*

**Measured, not guessed.** `dalatech-gate-repeat-set.json` runs every active case that
reaches the model three times over the dump. It is run by a commit tagged `[gaterepeat]`,
which runs that set alone. The result was 49/51. Each flip had a cause of its own, and the
two publish failures added two more. There were four causes, none of them "the model is
random":

1. **A guard swapped the path and dropped the answer (q01, case 25).** The model wrote the
   price, then a reworded FAQ answer about what the monthly fee covers. `faq_paraphrased`
   served the stored FAQ answer ALONE, so a price question got no price one run in three.
   Fixed in code: the price rows the facts guard can show the reply stated now go in front
   of the stored FAQ answer. Rows only, never the model's words, and none that the FAQ
   answer already carries.
2. **A fact the prompt did not have (sd3, case 40).** Nothing in the prefix says how long a
   demo takes. «Демо хэдэн цагт бэлэн болох вэ?» got the link one run and the handoff line
   (no link) the next. The founder's approved follow-up already carries the answer:
   «🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online». A `demo_timing`
   covers_message row serves that line whole.
3. **Wording variance on questions that have an approved answer.**
   - «За тэгвэл Дали авъя. Яах вэ?» (v03) was answered «холбоо барих мэдээллээ … бичээрэй»
     one run. Another run said you could order Дали at the DEMO link.
   - «Надад залгаж болох уу?» (sk1) got the callback line only when the reply let the
     sales line through.
   - Both now get the approved callback line, from the `purchase_request` and
     `callback_request` covers_message rows.
   - covers_message means every word must be a buying/calling word, a product name or
     filler. Anything that asks more goes to the model.
   - A complaint about calls («залгаад авахгүй») is never covered.
4. **An ambiguity D-133 introduced (s01, case 23).** The «Нэр» document said «AI туслахын
   нэр: Дали.», which made Дали both the assistant and the product. «daly gj yuve» (what is
   Дали?) was then read as "who are you?" and answered with the assistant_identity line, with
   no word of what Дали does.
   - A first rewording ("the assistant in this chat IS Дали, the AI хүлээн авагч") made it
     worse: 3 runs in 4 on the repeat set.
   - The document now names the company only. The assistant's name lives in the approved
     greeting and assistant_who rows, which is where the «Дала апп» greeting was fixed.
5. **Two rules that contradict each other on a complaint (sc1, case 30).** L4's answer-first
   reminder says not to open with «Уучлаарай», and D-127 says complaints keep it.
   - Four runs of «…муухай үйлчилгээ» gave four different openings. One of them was
     «Уучлаарай гэж хэлэхгүйгээр —», the model reading both rules out loud.
   - When the tenant's own complaint rows match, `volatileFor` replaces the answer-first
     reminder with an apology reminder. That is code-owned scaffolding, never sent text.

**And a bug of D-133's own, found while tracing (3).** `deterministic_replies.requires_empty_history`
defaults to true, and D-133's `thanks` and `greeting` rows did not set it. «Баярлалаа» was
therefore answered from the row only as a conversation's first message, and a thank-you
follows an answer, so in practice never. The founder's own «Баярлалаа → Тавтай морил!» was
mid-conversation. Every row here sets it false.
- Permanent cases `st2` (thanks) and `sg3` (greeting) are that exact situation: a message
  arriving after an answer.
- The founder's live re-test on the 26th confirmed it: «Баярлалаа» got «Тавтай морил!…» and
  «Сайн байна уу» got «…Танд юугаар туслах вэ?», both from the model.
- **This was never waiting on a publish.** Deterministic rows are read per request. The fix
  went live the moment the rows were updated, before any deploy.

**No case was loosened.** Every assertion is as it was. The new exact answers are approved
lines. The cases that still reach the model (14) are the ones whose answer is the model's
job, and the repeat set runs every active case three times to prove they hold.

Data: `scripts/provision/dalatech-gate-stable-2026-09-26.sql`. The rows are live when
applied. The «Нэр» rewording reaches the prefix on the republish, which compiles to
`ca202860`.

## D-135 — case 42: a follow-up the model copied, refused as a price (2026-09-26)

The founder's publish run failed again on `ca202860`: case 42 (sq2, «Хэр хурдан ажиллаж
эхлэх вэ?» after a price answer and the follow-up) was answered by a canned line, with the
flag `outbound_price`. CI had passed it every time.

**Measured, not guessed.** Case 42 was run fifteen times at the real clock, the way the
publish script runs it. Two runs failed. In both, the model wrote the right answer and then
**copied the approved follow-up from the earlier turn into its own reply**:
«…1–2 долоо хоногт ажиллаж эхэлдэг. 🤖 Таны … 24/7 хариулна. 🎁 Үнэгүй демо, 24 цагт…».
- «24» and «7» are not in `allowed_numbers`, which is compiled from the prefix only, and the
  follow-up is not in the prefix.
- So the numeral guard refused a correct answer and served the fallback.
- It was not a duration read as a price: «1–2» and «7–10» are on the list and pass.

**Two fixes, each at its own root:**
1. **The guard.** A numeral in an approved line the platform ALREADY SHOWED in this
   conversation may be repeated, exactly as a numeral the customer typed may be
   (`OutboundContext.shownText`, from `shownApprovedLines`).
   - It is never introduced: 25 is still refused, and «24» licenses 24, never 24,000.
   - Only approved lines count (reviewed canned, enabled deterministic, reviewed sales),
     never a turn the model wrote.
2. **The copy itself.** The follow-up is the platform's to add, once per conversation. A
   model that retypes it would have offered it twice, even once the guard stopped refusing
   it. `withoutSalesLines` removes exact lines of the reviewed follow-up from the model's
   reply, flagged `sales_line_retyped`.
   - It covers the follow-up only: a callback or demo line the model writes is an answer
     and stays.

**Why the Mac and CI disagreed.** It was not the key or the settings. Both run the same code
(`gateTenant` → `runCases` → `handleReception`) on the same prompt hash and the same rows.
Sonnet 5 takes no sampling parameters, so every run is a fresh sample. A 2-in-15 variant can
pass three CI runs and fail the next publish. Two real differences are also removed:
- the gates now retry a transient API error once, as CI always did (`caseModelSeat`);
- the CI repeat set now runs at the real clock, not a fixed 06:00 UTC.

A failing `outbound_price` case now prints the numerals it refused, so the next one explains
itself.

## D-136 — the account's spend cap, read as a bad request (2026-09-26)

The production deploy of D-135 failed its gate on 33/38. The five cases were not answered
wrongly: every call returned 400 «You have reached your specified API usage limits. You will
regain access on 2026-10-01 at 00:00 UTC.»
- That is the Anthropic account's own spend cap. Raising or lifting it is the founder's
  (money), and until then every deploy and every publish fails its gate on the model cases.
- D-129's `isBillingError` recognised the credit-balance 400 but not this one, so it was
  filed `invalid_request`, a per-reply flag, and paged nobody.
- It is now billing: a live reply that hits it raises the account alert.
- No live customer reply had hit it when it was found. The last model failure in
  `quality_flags` was the 01:09 credit episode.

## D-137 — the gates spend nothing; paid test runs only by hand (2026-09-26)

Founder, 2026-09-26: *"No paid model runs for testing … unless I explicitly start one. …
Live customers (Tara and DalaTech) are the only thing allowed to spend."*

- **Deploy gate and publish script** now judge only the cases that never reach the model.
  A case that needs the model is reported `not_run` ("N need the model and were not run")
  and does not block. An EXACT case (one with an expected body) that reaches the model still
  fails: the row that answered it stopped answering, which needs no model to know.
- **By hand, and spending:** `REPLY_GATE_MODEL=1` on the build gate, `--with-model` on
  `scripts/publish/tenant.ts`. Both keep the old rule: a model case without a key fails.
- **`testset-dalatech.yml`** runs only on `workflow_dispatch`; the repeat set is an input,
  off by default. `bakeoff-arms.yml` already was dispatch-only. A `[testset]` commit tag
  starts nothing now.
- What that gives up, said plainly: a prefix or rule change that makes a model case answer
  wrongly is no longer caught on deploy. It is caught when the founder runs the cases by hand
  before a big change, or by a customer.

**Spend on 2026-09-26 (Ulaanbaatar day, from 16:00 UTC on the 25th), by source:**
- CI test sets: 13 paid runs, ~$17.6 (seven read from their logs: 1.59, 1.70, 1.61, 1.76,
  1.32, 0.47, 1.69; six earlier ones ~$1.25 each).
- Production-build gates: 35 builds, ~$0.6 each, ~$20. **Estimate**: builds write no ledger.
- The founder's local publish runs: ~$3, **estimate**.
- Live customers: DalaTech 15 calls, $0.46 (`spend_ledger`). Tara $0: its Page token has
  failed since 01:09 (`authorization_error`) and needs a new one from the founder.
- Demo app (`dalatech-app`): $0 today. Two test demos yesterday, ~$1.50 each.

Testing was ~98% of the day's model spend and customers ~1%.

**The demo app:** each demo is three designs (minimal, bold, elegant) on Opus 5.5, ~9k tokens
in and 20–25k out each, ~$0.45–0.54 each. `LEAD_LIMIT_PER_DAY` defaults to 10, so the worst
day is ~$15. The safest cheap lever is that env var (e.g. 3 → ≤ ~$4.50/day), which changes no
code and no output. Fewer designs per demo, or a cheaper model, cut the per-demo cost but
change what a prospect sees. Both are the founder's call, in that repository.

## D-138 — the site chatbot moves onto tenant #0's web channel, behind a switch that is off (2026-09-26)

The founder's brief: the dalatech.online chat answers exactly as DalaTech's Facebook Page
does — same data, guards, sales follow-up, leads to Telegram — with per-visitor limits and
the tenant's daily budget still binding, a polite line when Dala AI is down, and nothing live
until the founder switches it. Built to `docs/reports/2026-09-25-tenant0-data.md` §5 B/C and
`2026-09-25-site-chatbot-overnight.md` §4, with three corrections found on the way.

**Where the pieces sit.** dalatech.online embeds an IFRAME of `dalatech-chatbot.vercel.app`
(`dalatech-online/index.html`), so the chat page is that repository's `public/index.html` +
`app.js`, not `widget.js`. Its server (`api/session.js`) signs the mint with the web mint
secret; the page then talks to `/api/web/message` directly, so every per-address limit here
sees the visitor and not the relay. `CHAT_BACKEND=dala` turns it on; anything else, or `dala`
with a variable missing, serves the old bot.

**Three gaps on this side, fixed:**
1. **A lead left in the widget reached nobody.** The web path drafted the thank-you line
   (`leadThanksFor` runs inside `handleReception`) but never called the sales record, which is
   what writes `sales_lead_shadow` and sends the number to Telegram. `runMessageJob` now calls
   the same `salesShadowEffect` the Messenger worker binds, after the draft, bounded by
   `SALES_SHADOW_WAIT_MS`, and unable to cost the visitor the reply. What outlives that wait
   is handed to Next.js `after()`: here the response IS the delivery, and a function frozen on
   return would drop a lead's Telegram call with no log line. (The Messenger worker has the
   Graph send after its wait to cover the same gap; it does not use `after()` and was not
   changed tonight.)
2. **Switching the channel off stopped only new visitors.** The mint refuses a channel that is
   not `active`/`live`; `/api/web/message` never re-read it, so an open session kept answering
   and spending for up to two hours. Each turn now reads `tenant_channels` first, so
   `delivery_mode = 'off'` is an immediate, no-deploy stop. Refused as a 503 with CORS headers
   so the widget can say so politely.
3. **Turnstile was told the relay's address.** The mint is server-to-server, so `clientIp` is
   the chatbot server's — the same for every visitor. The relay now puts `visitor_ip` inside the
   SIGNED body and the mint passes it to siteverify. Scoring only: it never keys a rate bucket,
   because it is the tenant server's claim.

**Two corrections to the earlier plan.** "A switch (`CHAT_BACKEND`) lets you flip back in one
env change without a deploy" was wrong: a Vercel environment change reaches a function only on
the next deployment. The instant way back is Vercel's Instant Rollback to the previous
production deployment, or `delivery_mode = 'off'` here. And the relay does not send every
message through the chatbot server: only the mint goes that way.

**Found, not changed (customer-visible, the founder's):** tenant #0's reviewed `handoff` line
ends «Хамт олон маань хариулах болно». On the Page a person reads the inbox; on the website
nobody is told about the conversation as it happens, so the promise has nothing behind it
unless the visitor leaves a number (which now reaches Telegram).

Nothing is live: no web mint secret is sealed (`tenant_secrets` holds only the Page token),
`TURNSTILE_SECRET_KEY` is unset here, `CHAT_BACKEND` is unset there, and `web_sessions` has
never held a row.

## D-139 — DalaTech polish: one price header, the approved price layout, website hand-offs told (2026-09-26)

The founder, after the site chat went live on Dala AI (D-138): three items, for DalaTech on the
Page and the website.

1. **The first price answer named the service twice.** Measured on the website at 15:17:
   «Дали — AI хүлээн авагчийн үнэ дараах байдалтай байна:» then «💬 Дали — AI хүлээн авагч».
   The model wrote the intro and two price lines; the facts guard replaced the two lines with
   rows and KEPT the intro (`fact_restated`: *2 sentence(s) replaced by rows, 1 kept*); the look
   (D-133) then put its header under it. `stylePriceRows` now drops a lead-in directly above a
   header it adds: one clause ending in a colon, no digit in it. A sentence, a line with a
   number, or an unstyled reply keeps its line.
2. **The general price answer is the founder's layout** — four lines, verbatim, in
   `price_overview` (`scripts/provision/dalatech-price-layout-2026-09-26.sql`, applied after the
   code deploy, with the six exact reply cases that quoted the old paragraph). One code change
   came with it: the reply-matched `coming_soon_in_reply` row no longer appends to the SET ROW
   the message matched. The layout says «⏳ Удахгүй: Вира, Эхо, Нова, Ора — урьдчилан бүртгэл
   авч байна» in the tenant's own words; the old paragraph carried the status sentence verbatim,
   which is the only reason the row had not fired on it before. A model reply naming a
   coming-soon staff member still gets it, and «Вирагийн үнэ хэд вэ?» is not the overview's (it
   does not cover «вирагийн»), so it still gets Вира's price and the pre-registration line.
3. **A website hand-off asks for a number and is told to the founder.** `ReceptionInput.noInbox`
   (required; `true` only on `/api/web/message`): wherever the handoff row would be served, the
   tenant's reviewed callback line is served instead. The draft wrapper, which every draft
   passes, marks the outcome `handedOff` — the handoff row, or the callback line served as the
   general line; never a callback row the customer's words asked for (`deterministic`). The
   website then sends `🙋 Website visitor needs a person` with the visitor's question to
   Telegram (`website/handoffAlert.ts`), off the reply's path via `after()`. Only where the
   tenant's `lead_route` is `founder_telegram` — the chat is DalaTech's and shared with the demo
   form — and at most three per conversation, counted in `quality_flags` rows that carry no
   customer text. The ceiling path, which serves a line without calling `handleReception`, does
   the same.

No republish: 1 and 3 are code, and `deterministic_replies` is read per request, not compiled.

## D-140 — the website never sends a visitor to the site they are on (2026-09-26)

Founder, 2026-09-26: on dalatech.online, «Танай оффис хаана байдаг вэ?» was answered «…
Дэлгэрэнгүй мэдээллийг https://dalatech.online хуудаснаас үзэх боломжтой.», and the follow-up
ends «👉 Бусад AI ажилтнууд: https://dalatech.online». Right on the Page; wrong in a widget on
that page. *"Build it so any tenant with a website channel gets the same behaviour."*

- **The rule is code, for every tenant** (`website/ownSite.ts`). On the website channel, the
  tenant's VERIFIED `tenant_domains` hosts — the registry `/api/web/message` already reads for
  CORS — are the site the visitor is on. A sentence in the reply naming one of them is not sent,
  whoever wrote it: the model, a canned line, a row with no website version, the sales line.
  Flagged `own_site_removed`, so a row that needs a website version shows up. A reply with
  nothing left is the general line, as a hand-off. A subdomain that is not listed is another
  site: `app.dalatech.online`, the demo app, stays. A Mongolian suffix after the host
  («dalatech.online-д») is caught; `\b` is not used (rule 6).
- **Approved lines may have a website version** (`web_body`, `0056`) on `sales_next_steps` and
  `deterministic_replies` — the two tables read per request. `/api/web/message` swaps it in
  (`websiteContext`) before the reply path, the sales record and the hand-off alert see the
  row. Not on `canned_responses`: those are compiled and hashed into the prefix, so a second
  body there would be a second source of one fact; the rule covers them.
- **Reply cases per channel** (`reply_cases.channel`, `0056`). A `web` case runs exactly as the
  website answers: website versions, the site rule, no inbox. Every earlier case is the Page.
- **Data** (`scripts/provision/dalatech-website-versions-2026-09-26.sql`): the follow-up's
  website version, approved exactly; `office_location` «Бид Улаанбаатарт байрладаг,
  онлайнаар ажилладаг.» on both channels (covers the question only when every word is an
  office word or filler, so «Имэйл хаяг», «Вэбсайтын хаяг», «Демо хаана» still go to the
  model); five cases.

What it cannot see: a reference with no host in it («манай вэбсайтаас»). No republish: the
rule is code, and both new columns are read per request.
