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

