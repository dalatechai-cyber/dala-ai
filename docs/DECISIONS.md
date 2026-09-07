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
change does not touch, and the same fix applies to both.

**And the purge FLOORS are not affected at all**, which is worth stating because it was named
as a suspect. `ops.purge_expired` computes `now() - make_interval(days => …)` — an absolute
duration, no calendar and no local midnight. Only its alert dedup key carries a UTC day.

### The deeper one, reported and not built

`dayKey()` hardcodes `UB_OFFSET_MINUTES = 8 * 60` while `tenants.timezone` is a per-tenant
column. Every tenant's spend ceiling therefore rolls over on Ulaanbaatar's calendar, whatever
their own. Latent today — both tenants are `Asia/Ulaanbaatar` — and it is the platform's
founding test failing in miniature: something that distinguishes one customer from another
is a constant rather than a row. Fixing it moves a boundary the spend ledger is keyed on, so
it is money and it is the founder's.
