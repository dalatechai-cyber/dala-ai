# Roadmap

Phases 3–5. Phase numbering continues Dalatech's own: Phase 1 and 2 were the single-tenant
website and Messenger bots that `Matrix-Chatbot` still runs.

Each phase states what "done" means as something you could **fail**, not as a feeling.

---

## Phase 3 — The platform, Reception AI, and Analytics AI

**Goal: two paying tenants served by one deployment, and the third onboarded without a
developer.**

This is the phase that decides whether Dala AI is a product or a consultancy. Everything in
it is in service of one falsifiable claim: onboarding client #3 is filling in a config.

### 3.0 Before any product code

| | Why it is first |
|---|---|
| ~~Merge `09-reconciliation.md` into one `schema.md` + `0001_*.sql`~~ **DONE 2026-08-31** — 79 tables, verified by execution (catalog 18/18, isolation 10/10, rls 8/8, the figures of the day — the pack is 27/27 now). Not applied to a real project **then**; `0001`–`0012` were applied to `tlggenaatnopnxzbkbuf` on 2026-09-05. | Until it existed there was no schema, only eight incompatible proposals (D-013) |
| ~~`count_tokens` + the bake-off~~ **DONE 2026-08-31** — two rounds, native-speaker reviewed. Sonnet 5 ships; no Haiku for customer-facing Mongolian prose (D-009). ~~Margin 29% vs 60% target~~ — **measured 71% at real traffic (D-016)**, clearing the target; `docs/prefix-trim.md` is reprioritised from margin rescue to multi-tenant scaling. | Settles D-009, which every ceiling depends on |
| KEK escrow; a second admin on Meta, Supabase, GitHub, the registrar | Losing either is unrecoverable, and it is 30 minutes |
| ~~Write the V1 cut line~~ **DONE 2026-08-31**, [`docs/V1.md`](V1.md) — revised 2026-09-01 once D-009 closed | Everything in the design is justified, so nothing is obviously cuttable — which is how four months pass with no customer message flowing |
| ~~Decide the Reception spend ceiling~~ **DONE 2026-09-01 (D-015)** — sold against a **400 conversation/month band**; the ceiling itself is unchanged | D-004's rule affords ~423 conversations at D-009's measured cost, and Reception was being sold with no stated limit against it. The band removes the mismatch without touching the hard floor. **The 400 rests on a volume guess the design contradicts itself on (750 vs 300–600) — re-derive it from the mirror phase** |

### 3.1 V1 — the smallest thing that can carry Matrix's Messenger traffic

Target ≈ 4–6 weeks.

Webhook → signature verification → **per-entry** tenant resolution → durable queue → worker
→ knowledge base → model → send to `/{page-id}/messages` with the tenant's own token.
Around it: the reserve/settle spend ledger with a hard ceiling, Telegram alerts, the config
tables and the prompt compiler, the boundary gate, the output guard, the RLS verification
pack, and the CI checks.

**Deliberately not in V1** — each deferred with a reason, not forgotten:

| Deferred | Why it can wait |
|---|---|
| Instagram | Add once Messenger has been live two weeks. Same seam, more Meta surface |
| Comment replies | Expands App Review scope and adds rate-budget pressure |
| The Quality layer | At two tenants, the founder reading conversations *is* the Quality layer |
| Analytics automation | Hand-write the first report. It will teach you what the automated one should say |
| Probe-token onboarding flow | Bind tenants #1 and #2 by hand; automate for #3 |
| KEK **rotation** machinery | Rotation is not needed in month one. **Escrow is** — that is in 3.0 |
| The web widget | Undesigned, and it is the one surface where the tenant-identity rule has no answer. Retire it or design it properly; do not leave it running |

### 3.2 Matrix Eco Salon — tenant #1

Ten phases, ending in a sequenced cutover from the existing bot in which the salon never
has two bots replying or zero bots replying, with a rollback measured in minutes. The
acceptance tests are pass/fail and include the children's-haircut question, which **must
refuse to quote**.

### 3.3 GS Auto Center — tenant #2

The vertical proof. A different service taxonomy, prices that depend on the vehicle,
quotes-after-inspection, turnaround in days, and possibly no booking site. **If onboarding
GS Auto requires a code change, Phase 3 has failed its own test** — and the change is the
backlog, not a footnote.

### 3.4 Analytics AI

Sold add-on-only (D-004), which is what lets it be honest about what it cannot measure. The
first month is hand-written; automation follows once the shape is known.

### Phase 3 is done when

- Two tenants are live on one deployment with no per-tenant code.
- A third could be onboarded by filling in a config — **demonstrated**, on a real or dummy
  tenant, in a morning.
- The RLS/grant catalog pack is green, per table, run against production and pasted.
- No tenant can spend past its ceiling, proved by tripping one deliberately.
- A Telegram alert has fired in anger at least once and was actionable.
- Revenue is actually collected from both tenants.

---

## Phase 4 — Voice AI and Customer Care

**Goal: the two roles that are sold but currently cannot be delivered.**

Both are blocked on **external** dependencies, which is why they are one phase and not two:
the work is mostly waiting, and the engineering only starts when a vendor answers.

### 4.1 Voice AI

Blocked on a **Chimege** quote for per-minute Mongolian speech. Pricing is already set as
₮200,000 setup + ₮250,000 base + a per-minute rate (D-004), and the per-minute rate is the
open term. Until it exists, Voice is a row in the `roles` table with `enabled = false` and
nothing behind it.

The seam: a voice channel attaches to `tenant_channels` like any other, and a call becomes a
`conversation` with turns. Nothing else is designed on purpose — a speculative voice design
written before the vendor is known is a design that gets thrown away.

### 4.2 Customer Care AI

Blocked on a **Mongolian SIP trunk**. Meta's outbound tags died 2026-04-27, so there is no
Messenger fallback: it is SMS or nothing.

The seam already exists (D-007) — `outbound_messages`, a `MessageTransport` interface, and
`NullTransport` as the only implementation. Filling it should be a config plus an adapter,
and **if it turns out to be a redesign, the seam was wrong** and that is worth knowing.

Consent and opt-out are already enforced across all roles, so the day a transport exists,
the compliance model is not new work.

### Phase 4 is done when

- A real customer receives a real SMS reminder they consented to, and can stop it.
- A real caller reaches Voice AI and is handed off correctly when it cannot help.
- Both have per-tenant ceilings, and Customer Care's per-message price is known rather than
  `NULL` — because an unknown price refuses.

---

## Phase 5 — Scale

**Goal: growth stops requiring the founder's attention per tenant.**

Phase 3 proves one person can onboard a tenant in a morning. Phase 5 asks whether that
morning can be removed, and whether ten tenants cost ten times the attention.

- **Self-serve onboarding.** The Business-Manager token dance is a runbook, not a form.
  Facebook Login for Business turns it into two clicks — at the cost of a credential
  coupled to one person's password. That trade is the phase's first real decision.
- **The Quality layer, automated.** Viable only once there is a conversation corpus worth
  reviewing. At two tenants it is a person; at twenty it cannot be.
- **Retrieval over the knowledge base**, when a tenant's compiled prompt crosses the named
  size trigger. GS Auto's parts-and-labour catalogue is expected to cross it first.
- **Platform-shared prompt caching.** Measured 2026-09-01 by `scripts/bakeoff/compose.mjs`:
  **61.7% of the prefix is platform instruction, identical across tenants; 30.5% is tenant
  knowledge.** Ordering the platform block first, with its own cache breakpoint, makes it
  one cache entry for the whole platform instead of one per tenant. Worth little at two
  tenants and a great deal at twenty — which is exactly why it belongs here and not in
  Phase 3. (This line previously read 64%/24%, which was wrong on both sides and
  disagreed with `docs/prefix-trim.md`; that file records what the error was. Re-run the
  script rather than editing either number by hand.)
- **Second-operator readiness.** Everything the break-glass note in Phase 3.0 says a
  delegate cannot do, they should by now be able to do.

### Phase 5 is done when

- A tenant can be onboarded without the founder touching a Business Manager.
- Per-tenant marginal cost and per-tenant marginal *attention* both fall as tenants are
  added.
- The founder can be unreachable for two weeks without the platform degrading.

---

## What is deliberately not on this roadmap

- **Non-Mongolian tenants.** The Cyrillic suite, the folding table and the pinned-line
  review are Mongolian-specific. Do not pre-build it; record the gap and price it when a
  real customer asks.
- **A booking engine.** D-005. Booking stays on the tenant's own system.
- **Anything that makes a tenant's config a code path.** D-002.
