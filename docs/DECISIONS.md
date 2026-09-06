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
