# Completeness review — what no section addressed

Coverage of the founder's eight explicit asks is complete. This file is only what is
**absent**, ranked by whether it blocks work. It ends with a lesson-by-lesson audit of
`dalatech-english/CLAUDE.md` marking each lesson carried, partially dropped, or dropped.

---

Eight sections, all eight of the founder's explicit asks answered, and the depth is real. What follows is only what is **absent** — things no section addresses, or addresses only by naming it as an open question and moving on. Ranked by whether it blocks work, then by severity.

---

# TIER A — blocks starting or blocks launch

## 1. There is no canonical schema. Migration `0001` cannot be written from these eight sections.

**Missing.** The sections independently invented incompatible versions of the same tables. The tenant routing registry is `channel_bindings` (§1.2), `channel_identity` (§3.2.1) *and* `tenant_channels` (§2.4A, §3.2.1) — three names, three column sets, two different uniqueness strategies (plain PK vs partial unique + GIST exclusion). The spend ledger exists three times: `spend_ledger` with `bigint identity` and `cost_usd numeric` (§2.4E), `app.spend_ledger` in **nano-USD `bigint`** with a separate `spend_reservations` table (§5.2), and `spend_ledger` with a `kind ∈ (reservation, actual, refund)` enum and no reservations table (§7.6.2). The deliberate-omission concept is `disclosure_rules` + `out_of_scope_topics` (§1.3.4), `refusal_rules` (§2.4B), `kb_refusal_topic` (§4.6.2) and `refusal_topics` (§6.5, §7.1.7) — four schemas for one feature. The chokepoint is `withTenant` (§2, §3), `withTenantSpend` (§5) and `withTenantRole` (§7), with three different signatures; §7's is the only one that takes `initiated`/`personId`, which §7 correctly proves is required.

**Why it matters.** This is the exact "one gate, no local re-implementations" lesson from `guardAiRoute()`, violated *inside the design document itself*. Whoever writes the first migration will make ~30 arbitration decisions alone, at speed, and the losing variants will survive in the sections nobody re-reads. §5's reservation model and §7's `kind='reservation'` model are not stylistic variants — they produce different concurrency guarantees, and §5.5 proves §7's shape races.

**Sketch.** One day of work before any code: produce a single `schema.md` + `supabase/migrations/0001_*.sql` that is the only schema artifact, with a one-line arbitration note per conflict. My recommendations where the sections disagree: **`tenant_channels`** as the routing table name with §3's `active` partial-unique + `channel_transfers` history (§2's plain PK cannot express a transfer without a hand-edit); **§5's nano-USD ledger with a separate `spend_reservations` table** (it is the only one whose ceiling holds under concurrency, and §5.5 shows the arithmetic); **`refusal_topics`** with §1's `price_kind`/`out_of_scope` split folded in as columns, not tables; **`withTenant(ctx, fn)` with §7's signature** including `initiated` and `personId`, because §7's comment-private-reply case proves the others cannot express consent. Then delete the DDL from the eight sections and replace it with pointers, so there is exactly one place to be wrong.

---

## 2. There is no build plan. Nothing says what to build first or what the minimum shippable slice is.

**Missing.** §8 is an *onboarding* checklist — it assumes the platform exists. Nothing in eight sections orders the engineering work, states dependencies, estimates effort, or defines the smallest thing that could carry Matrix's Messenger traffic. The sections collectively describe several months of work: probe tokens, `bindings_version` cache invalidation, envelope encryption + KEK rotation, reserve/settle ledger with `reserve_usage`, mirror deployment in the incumbent, prompt compiler with volatility split, output guards, Quality layer, Analytics with tiered attribution, twelve CI checks, the V0–V16 verification pack, a bake-off with nine arms.

**Why it matters.** Everything here is justified, so nothing is obviously cuttable, so the realistic failure mode is four months of building before one customer message flows — during which Matrix runs on the ancestor and the founder earns nothing. The §8 checklist's Phase A step 7 ("run the entire rest of this checklist against staging") silently contains most of the product.

**Sketch.** Write a sequenced plan with a hard V1 line. My cut for V1 (≈4–6 weeks): webhook + signature + per-entry tenant resolve + QStash + worker + reply + send-to-`/{page-id}/messages` + per-tenant token from `tenant_secrets` + reserve/settle ledger with a hard ceiling + Telegram alerts + the config tables + a prompt compiler + the refusal gate + the output guard + the V0–V16 pack + six CI checks. **Deferred to V1.1+ without loss:** Instagram (add after Messenger is live for two weeks), comments entirely, the Quality layer (do it manually — the founder reading conversations *is* the Quality layer for two tenants), Analytics (send a hand-written first report), the probe-token onboarding flow (the founder can bind by hand for tenants 1–2), volatile/stable prompt split, `bindings_version` (one tenant, no transfers), KEK rotation machinery (rotation is not needed in month one; the *escrow* is, see #3). Say explicitly which of §8's forty-three steps V1 skips.

---

## 3. The KEK has no backup and there is no break-glass. This is an unrecoverable-loss gap and a 30-minute fix.

**Missing.** §2.4A, §3.4.1 and §1.6 all specify envelope encryption with the KEK in the Vercel environment, and all three describe *rotation*. None says where the second copy lives. Vercel environment variables are not a backup — a deleted project, a lost account, a mistaken `vercel env rm` and every tenant's page token is permanently undecryptable. Broader: nothing anywhere designates a second human or a break-glass. The Meta Business Portfolio is described throughout with the founder as the only admin, which is a well-known way to lose a portfolio permanently; the Supabase org, the domain registrar, the GitHub org and the Anthropic account are in the same position.

**Why it matters.** Losing the KEK does not lose data — it loses *every tenant's ability to send*, and recovery requires re-running the Business-Settings dance with every client. Losing sole Meta Business Portfolio admin access is not recoverable by a support ticket in any reasonable timeframe.

**Sketch.** Before the first tenant: generate the KEK, store it in a password manager with an offline printed copy in a sealed envelope, and record in `docs/ops/break-glass.md` exactly where. Add a second admin to the Meta Business Portfolio (a co-founder, a spouse, a lawyer — someone), a second Supabase org owner, a second GitHub org owner, and 2FA recovery codes for all of them, all escrowed the same way. Write a half-page "if the founder is unreachable for two weeks" note naming what a delegate can and cannot do. Add a startup assertion that `TENANT_KEK_V1` decrypts a known canary row, so a wrong KEK fails at boot rather than at the first customer message.

---

## 4. Backups, PITR, and a tested restore are absent from all eight sections.

**Missing.** The words "backup", "PITR", "restore" and "RPO" appear nowhere except §2.4A's *threat model* ("a stolen database backup"). There is no statement of Supabase's backup tier, no PITR decision, no restore rehearsal, no RTO/RPO, and no plan for the two failure classes that actually happen: a bad migration applied to production (§2.11 detects it, nothing reverts it) and accidental deletion.

**Why it matters.** The design makes the database the sole authority for spend ceilings, conversation history, the Quality corpus, tenant config, and the encrypted tokens. §2.8 promises tenants a retention policy and an export; a promise you cannot honour after an incident is worse than no promise. And §6.9.1 correctly argues the conversation corpus is the most valuable data the business will ever have — it is also the only copy.

**Sketch.** Decide and write down: Supabase Pro daily backups as the floor, PITR (7-day) as an add-on once there is revenue — price it (#9). **Rehearse one restore before go-live**: restore staging from a backup, run V0–V16 against the restored database, time it, and write the number into the ops doc as your RTO. Add a nightly `pg_dump` of the config and secrets tables to a second location (an object store outside Supabase) — small, cheap, and it is the one thing that survives losing the Supabase account. Add a down-migration or a written revert procedure for each migration that touches grants or policies, since those are the ones the pack catches after the fact.

---

## 5. Meta App Review has deliverables beyond permissions, and at least two are on the critical path.

**Missing.** §8 Phase B covers Business Verification, permission requests and the screencast. App Review also requires a **privacy policy URL**, a **terms of service URL**, a **Data Deletion Request callback** (flagged as ASSUMED in §2.14 and never designed), an app icon, a public app name, and a use-case description. Nothing designs the deletion callback endpoint, and nothing decides what the app is *called* — §8 Q2 recommends reusing Matrix's existing app, which means GS Auto Center's owner sees "Matrix Chatbot" (or whatever it is named) in an OAuth dialog.

**Why it matters.** App Review is the ~20-day critical path the whole plan is sequenced around. A submission bounced for a missing deletion callback costs a full cycle. And the app name is a "would embarrass the founder in front of a client" item that costs nothing to fix now and cannot be fixed after tenants are attached.

**Sketch.** Add to Phase B, before submission: a public `dala.mn/privacy` and `dala.mn/terms` (they must exist as pages, and §8 Q6's answer must be consistent with them); `POST /api/meta/data-deletion` implementing Meta's signed-request flow, writing a `contact_erasure_requests` row (§2.4F already has the table) and returning the confirmation URL and code Meta requires; a neutral app display name ("Dala AI") and icon decided before reuse-and-rename, with the rename's review implications checked in Business Settings first — §8 flags that as unverified and it should be resolved in week one, not week five.

**PARTLY CLOSED 2026-09-04 — the deletion callback is built.** On the founder's call:
*"build it now, since a submission bounced for that costs a full cycle whatever else is in
it."* `POST /api/meta/data-deletion` verifies Meta's `signed_request`, writes a
`contact_erasure_requests` row, and returns the `url` + `confirmation_code` Meta requires;
`GET /data-deletion/status` is the page that URL points at. Migration `0008` gives the row
the columns it needs to be acted on later, and `catalog.sql` V20 asserts them.

**What it does NOT do, and this is deliberate:** it does not delete anything. Meta's
callback carries an **app-scoped id (ASID)**; every id this database holds for a customer
is a **page-scoped id (PSID)** or an IGSID. A lookup that treats them as one namespace
finds nothing, reports success, and leaves the data in place behind a confirmation code
saying otherwise. Bridging them needs Meta's ID Matching API (`GET /{id}/ids_for_pages`),
which needs a Business Manager containing the app and every Page — neither of which
exists. So a request is **recorded**, its status says `received` rather than `completed`,
and an alert fires. `docs/STATUS.md` carries the resolver as an ordered item.

Still open in this section: the privacy policy and terms pages, the app icon, the display
name, and the use-case description. None of them is code.

**And the section's own premise was half wrong.** It assumed App Review was ahead of us in
its entirety. The `dalatech` app exists with `pages_messaging` at Advanced Access, so
Business Verification — the multi-week item — is behind us, and DM Reception needs no
review at all (D-023). What remains is a comments-only submission for
`pages_read_user_content` + `pages_manage_engagement`. The deliverables above still gate
*that* submission; they no longer gate shipping.

---

# TIER B — blocks the first paying client, or the first contract

## 6. There is no revenue path. The platform can spend money and cannot collect it.

**Missing.** §5.10's margin query joins `app.tenant_subscriptions (plan, price_mnt, active)` — a table that is defined nowhere. There is no invoicing design, no payment rail (the sibling has a full QPay integration; Dala AI has nothing), no dunning, no path into `tenants.status='suspended'` for non-payment despite `suspension_reason='nonpayment'` existing in §1.1.1, no proration, no contract term, no price-change mechanism. §5.6's central ceiling formula — `monthly_ceiling = price × (1 − margin) / fx` — takes as input a subscription price that no part of the system stores.

**Why it matters.** Every ceiling in §5 and §6 is a placeholder until this number exists, and a placeholder ceiling nobody revisits is precisely how the sibling ended up with none. More concretely: a tenant who stops paying keeps being served indefinitely, at the founder's Anthropic cost, because nothing connects payment state to `tenant_roles.state`.

**Sketch.** For tenant #1 this can be a bank transfer and a spreadsheet — say so explicitly rather than leaving it undesigned. But add now: `tenant_subscriptions (tenant_id, plan, price_mnt, billing_day, status, effective_from, effective_to)` as an append-only history like §5.2.2's budgets; a manual `paid_through` date the founder sets; a daily job that flips `tenants.status` to `suspended` with `suspension_reason='nonpayment'` at `paid_through + grace_days`, using §1.1.4's existing suspension behaviour; and one line in §5.6's formula reading the real price. QPay is the obvious rail later and the sibling's `src/lib/qpay.ts` is a working reference — including its `isUnderpaid()` open finding, which is the one thing to fix rather than copy.

## 7. The tenant contract does not exist, and the most likely commercial dispute is unaddressed.

**Missing.** §7.8 and §8.42 sketch an SLA. There is no contract, and specifically no answer to: **when the bot quotes a wrong price and a customer demands it be honoured, who pays?** That is the single most likely dispute this product generates, it will happen, and eight sections of careful price-guarding do not remove it. Also absent: controller/processor designation, data ownership on exit, termination and notice, what is *not* promised (accuracy, uptime, that the model will not change), acceptable-use for tenant-supplied content, and indemnity if a tenant's own KB text is false advertising or their refusal rule is discriminatory.

**Why it matters.** Without a written allocation, the default is that the founder eats it, once per tenant per quarter, forever. And "the tenant owns their data, Dalatech processes it" needs to be written *before* the first erasure request, not during it.

**Sketch.** A two-page Mongolian agreement, reviewed by a Mongolian lawyer alongside #8. Load-bearing clauses: the tenant supplies and warrants the accuracy of prices, staff and hours, and is responsible for honouring or declining what the bot quotes from them (with the mitigation that §4.1.5's `confirmed_at` gives you a defensible record of what they confirmed and when); Dalatech is a processor acting on the tenant's instructions; data is the tenant's and is exported on request within N days and deleted per §2.8; service is best-effort within the salon's business hours with the §8.42 targets as targets, not warranties; the SLA clock pauses for tenant-caused token revocation; either party may terminate on 30 days' notice; the model and prompt may change. Note that §7.3's honest downgrade of the analytics claim ("bookings that passed through our link", not "revenue driven") must match the sales material and this contract — a mismatch there is the second-most-likely dispute.

## 8. Mongolian personal-data compliance is named once and never designed, and Matrix's own published privacy policy becomes false on cutover day.

**Missing.** §7.2.4 item 5 names the Law of Mongolia on Personal Data Protection (in force 2022-05-01) as a pre-send checklist item for SMS and stops there. Nothing addresses it for the far larger surface that ships first: storing every customer's Messenger and Instagram conversations server-side. Absent entirely: controller/processor analysis (see #7), **cross-border transfer** (customer messages go to Anthropic in the US, Supabase in whatever region, Vercel edge — the law has expectations here), a breach-notification policy and timeline, a privacy notice the salon can show its own customers, and **whether the bot must disclose it is a bot** — §6.5 Ш9 has it identify as an "assistant" and deflect, which may or may not be sufficient. Separately: `Matrix-Chatbot/PRIVACY_POLICY.md` is published on the salon's site and describes a localStorage-only architecture. §4.10 Q7 notes it is stale. It becomes *false* the moment Dala AI writes the first `messages` row, and it is the salon's document, on the salon's domain.

**Why it matters.** This is the cluster most likely to embarrass the founder in front of a client, and the cheapest to fix in advance. It also gates #5 (App Review wants a privacy policy URL) and #7.

**Sketch.** One session with a Mongolian lawyer covering: controller/processor, cross-border transfer basis, retention, consent for SMS later, and breach notification. Produce three artifacts: a Dalatech privacy policy at a public URL (needed for App Review anyway); a one-page Mongolian notice the salon can publish, covering server-side storage, the retention window, and the AI disclosure; and a rewritten `PRIVACY_POLICY.md` for `matrixecosalon.org` that the founder hands the owner **before** cutover, not after. Decide the AI-disclosure question deliberately — a single sentence in the greeting is cheap and removes the argument.

## 9. The platform's own cost is unpriced, and §5.6's margin formula ignores it.

**Missing.** The founder asked explicitly for the cost of Vercel, Supabase, Upstash and Anthropic at 2 and 20 tenants. §5.6 and §6.3 price Anthropic per tenant well. Nothing prices the fixed floor: Vercel plan, **two Supabase projects** (§8.1.3 mandates prod + staging), PITR if you take #4's advice, Upstash requests, QStash publishes (one per inbound message plus retries), Sentry, domain. §5.6's ceiling formula computes gross margin from AI COGS alone, which overstates affordable AI spend at low tenant counts by the entire fixed floor divided by N.

**Why it matters.** At 2 tenants the fixed platform floor is plausibly *comparable to or larger than* the AI cost, which means the ₮250,000 plan price in §5.6's worked example may be wrong in a direction that matters. And one specific item is a compliance risk, not just a cost: **Vercel's Hobby plan prohibits commercial use** — a paying client on Hobby is a terms violation, and Hobby is also where the short log retention in #12 comes from. *(Verify current Vercel/Supabase pricing and terms; I could not reach them from here.)*

**Sketch.** Build a one-page cost model with the fixed line items enumerated and marked verified-or-assumed, computed at N=2, N=5 and N=20, and add fixed-cost-per-tenant into §5.6's formula: `monthly_ceiling = (price_mnt × (1 − margin) − fixed_cost_per_tenant_mnt) / fx`. Then re-derive the ₮250,000 plan price. Decide staging's tier (Supabase Free pauses on inactivity, which is survivable for a weekly-use staging DB and saves $25/mo) and Vercel's plan (Pro, for terms compliance and logs).

## 10. Anthropic's organization-level rate limits and a whole-provider outage are unhandled.

**Missing.** §3.10 handles Meta's app-level shared budget with real care — per-tenant buckets, a global bucket sized under Meta's, usage-header high-water marks. The exactly-analogous Anthropic constraint is absent from all eight sections: Anthropic enforces per-organization RPM/ITPM/OTPM limits, shared across every tenant, and at 20 tenants a coincident burst hits them and *every* tenant 429s simultaneously. There is also no design for a sustained Anthropic outage: §6.10.1 handles one call failing, §7.7 degrades one tenant, but there is no platform-wide degraded state, no way to tell twenty salons at once, and no status page.

**Why it matters.** It is the same noisy-neighbour problem the design already solved once for Meta, on the vendor that carries 100% of the product's value. And a 4-hour Anthropic outage is a single event that breaks every SLA in #7 simultaneously, with the founder discovering it from twenty Telegram alerts.

**Sketch.** Mirror §3.10 exactly: parse `anthropic-ratelimit-*` response headers on every call, store per-tenant high-water marks, add a global `gate:anthropic` bucket sized under your org tier's published limit, and shed non-urgent surfaces (Quality, Analytics, probes) before Reception. Add a `platform_flags.upstream_degraded` state that (a) short-circuits every generation to the tenant's pinned handoff line at zero cost, (b) fires one aggregated founder alert rather than N, and (c) sets a dashboard banner for every tenant. Two lines in §5's gate, and it converts a twenty-tenant incident into one.

## 11. The boundary-hardening technique is applied to Reception only. Quality and Analytics have no prompt, no forbidden-openings, and no eval — and Quality writes to the KB.

**Missing.** §6.9's bake-off has nine arms, all Reception. §6.2.3 specifies Quality's models and a triage output schema but no prompt, no gate, no `forbidden_openings`, and no evaluation set. §7.5 designs the *plumbing* of proposals beautifully (evidence rows, composite FKs, ACL-enforced no-auto-apply) and never designs what the model is asked or how you know it is right. Analytics is better covered (§7.3's digit post-check) but its two named holes — spelled-out Mongolian numerals, and comparatives assembled from allowed digits — are acknowledged and left open.

**Why it matters.** The Quality layer's output is a **proposed price change**, presented to a busy founder in a review queue. A model that confidently proposes a plausible-but-wrong price, with an evidence excerpt that reads reasonable, and a founder who approves twenty proposals in ten minutes, is a direct path to a wrong price in production — routed *around* every guard §6 built, because the founder's approval is the authorising act. The founder asked for the boundary-hardening technique per surface; it was delivered for one surface.

**Sketch.** Add two arms to §6.9's bake-off with the same discipline: a Quality arm scored on precision of proposals (what fraction of proposed price changes are correct against ground truth on a seeded corpus, where you have deliberately planted three wrong-looking-but-right and three right-looking-but-wrong cases), and an Analytics arm scored on the digit post-check plus a spelled-out-numeral probe. Give Quality its own first-line gate: `no_action` is the default; a proposal requires an exact quoted customer turn and an exact quoted current KB value, both machine-verified to exist before the row is insertable; forbidden openings include hedges that make a guess sound observed. And make the founder's approval UI show the *current* value and the *evidence excerpt* side by side with a required "I checked this against the salon's actual price" checkbox — friction is the control here.

## 12. Nobody has computed the founder's operating hours per tenant. That, not onboarding, is the scaling wall.

**Missing.** §4.5 correctly observes the config-vs-code test is passed on the provisioning axis and was being failed on the operating axis. Nobody then totalled the operating axis. The design assigns the founder, per tenant: a weekly Quality review, a monthly analytics read and send, unacknowledged-handoff escalations, all config edits (§4.5.3 makes the owner read-only in v1), all refusal-topic approvals, all Mongolian sign-offs, all alert triage, all closure announcements within 4 business hours (§8.41), and the freshness-confirmation chase (§4.1.5).

**Why it matters.** At 20 tenants, weekly Quality review alone at 30–60 minutes each is 40–80 hours a month — half to a full FTE, before any alerts, edits or sales. The business stops scaling at a number nobody has calculated, and the calculation would change several design decisions (it is the strongest argument for a tenant-owner login, which §1.15 Q1, §2.15 Q1, §4.10 Q1 and §7.8 Q8 all raise as the highest-leverage open question and none resolve).

**Sketch.** Do the arithmetic on one page: minutes per activity per tenant per month, multiplied at N=2, 5, 20. Then decide the two levers it exposes. First, Quality cadence: weekly per tenant does not survive N=20 — make it weekly for tenants in their first month and monthly thereafter, with the immediate-trigger path (§7.5.2) unchanged. Second, resolve the tenant-login question with the number in hand rather than in the abstract: if the operating total exceeds ~15 h/month at N=10, self-serve price editing (with founder-approved *pinned strings* only, per §4.5.3's class split) stops being a nice-to-have and becomes the thing that lets the business exist.

---

# TIER C — needed within the first month of live traffic

## 13. Log retention and observability substrate are undesigned, and the entire measurement plan depends on them.

**Missing.** §4.3.2, §5.15 and §6.2.1 each say the decisive measurement is "already in the Vercel logs" — token counts, cache hit rate, the accidental-adaptive-thinking question. Vercel's runtime log retention on lower plans is short *(verify: on Hobby it is roughly an hour and there are no log drains)*. There is no log-drain destination, no retention decision, no structured-logging format, and — concretely — **no request-id propagation chain** across webhook → QStash → worker → Anthropic, despite `request_id` columns appearing in §5.2.6 and elsewhere. The sibling's Brevo incident was diagnosed by correlating a `profiles` row with a missing log line; that correlation needs both halves to still exist.

**Sketch.** Decide a drain (Vercel Pro drain to Axiom/Better Stack/Sentry logs — cheap tiers exist) with 30-day retention. Mint one `trace_id` at the webhook, put it in the QStash body, stamp it on `webhook_events`, `messages`, `spend_ledger` and every log line alongside `tenant_id`. Adopt one JSON log shape `{ts, level, trace_id, tenant_id, code, ...}` and ban free-form `console.log` in `src/` with a CI grep. Keep §7.3's rule that message text never enters a log line.

## 14. Supabase connection handling under serverless burst is not designed.

**Missing.** §2.2.3 mentions PgBouncer only in passing (as a reason not to use `set local`). Nothing decides between the direct connection, the transaction-mode pooler (Supavisor) or the session pooler, and nothing states the connection ceiling. The design fans out per-entry, per-event, with QStash retries, on Vercel serverless — the textbook connection-exhaustion shape. §5.5's `reserve_spend` takes a row lock per call, which under exhaustion turns into queued connections rather than queued locks.

**Sketch.** Use the transaction-mode pooler for all serverless routes (and note that this forbids session-scoped `SET`, prepared statements and `LISTEN`, which the design does not need); use a direct connection only for migrations. Record the pool ceiling for your Supabase tier in the ops doc. Add one load test — 200 concurrent synthetic webhook entries — before go-live, and watch connection count and `reserve_spend` latency, not just success rate.

## 15. There is no incident-lookup tool, which is the founder's actual daily job.

**Missing.** A salon owner says "a customer says your bot told them 45,000 for a colour". Reconstructing that requires: find the conversation by PSID or date, see the exact reply, the `config_version` and `prompt_hash` in force, the retrieved KB rows, the ledger row, and whether an output guard fired. Every one of those facts is stored somewhere across §2/§4/§5/§6, and no section specifies the view that assembles them. §8.1.5 lists four dashboard surfaces; this is not one.

**Sketch.** One admin page: search conversations by tenant + date + last-4-of-external-id, and one conversation view showing every turn with its `revision_id`/`prompt_hash`, the reply's `answered_by`, the ledger row's cost and cache counts, any `quality_flags`, and a "what the prompt said at that version" expander rendered from the immutable snapshot. It is a day of work and it is the difference between answering a client in two minutes and in two hours.

## 16. The web widget channel is in the schema and is designed nowhere — and it is the one place the tenant-identity rule has no answer.

**Missing.** `web_widget`/`web` appears in §1.2's `channel_provider`, §4.2.1's `kb_snapshot.channel`, and §8/§6 open questions. Non-negotiable #1 says the tenant is derived server-side and never from the request body; a browser widget request contains nothing else, and `Origin` is spoofable. The ancestor's `api/chat.js` is a live unauthenticated Anthropic proxy whose only gate fails open two ways (`Matrix-Chatbot/lib/cors.js:16-17`), and the sibling's P1-1 finding is the same shape: a guest cap enforceable client-side only, on a paid model.

**Sketch.** Either retire it (my recommendation for V1 — say so, and remove `web` from the enums so it does not read as designed), or design it properly: a per-tenant public widget key that maps to a tenant server-side, `Origin` checked against `tenants.allowed_origins[]` as defence-in-depth only, an Upstash per-IP daily cap plus the per-tenant ceiling, and a Turnstile/hCaptcha token on session start. Until one of those is done, the ancestor's `/api/chat` should be taken offline at cutover rather than left running (see #21).

## 17. Two named CLAUDE.md rate-limiter traps are silently dropped.

**Missing.** `CLAUDE.md` names two specific `@upstash/ratelimit` traps: its own `timeout` option resolves `{success: true, reason: 'timeout'}` — i.e. it **fails open** — and `consume()` must detect that reason and convert it; and constructing the Redis client can throw, so it must sit *inside* the `try` or the throw escapes the policy and 500s the route. Neither appears anywhere in the eight sections, which repeatedly assert "fail closed" as a posture without carrying the two mechanisms that make it true in this specific library.

**Sketch.** Port `src/lib/rateLimit.ts` as code rather than as a principle, keeping both handled traps and the `FAIL_OPEN_KEYS` comment block, and re-derive the exception list for Dala AI (§5.8 does this well — attach the two traps to it). Add a unit test that stubs the limiter to resolve `{success:true, reason:'timeout'}` and asserts the caller refuses.

## 18. Security headers, CSP, and founder-account hardening for the admin dashboard.

**Missing.** `CLAUDE.md`'s CSP lesson ("ships report-only; promote to enforcing once the console is clean; XFO/nosniff/Referrer-Policy/Permissions-Policy already live") has no Dala AI analogue — §8.5 only says "don't promote CSP in week one", presuming a CSP nobody has written. Nothing designs `next.config.mjs` headers. Separately: no MFA requirement on the founder's Supabase/GitHub/Vercel/Meta/Anthropic accounts, no admin session length, no statement of **whether the Dala AI repo is public** (the sibling's entire threat model assumes public source and §2's Vault-vs-envelope argument leans on it), and no "a secret leaked, now what" runbook.

**Sketch.** Copy the sibling's enforcing headers on day one (XFO, nosniff, Referrer-Policy, Permissions-Policy) and add CSP report-only. State the repo's visibility in `CLAUDE.md`. Turn on MFA everywhere and escrow the recovery codes with #3. Write a ten-line leak runbook: which named `sb_secret_*` to revoke for which surface (§2.6's per-component keys make this cheap and it is their whole point), how to rotate the Meta app secret without downtime (§3.2's *set* of secrets makes this possible — say so), and how to rotate the KEK (§3.4.6 has the procedure).

## 19. Testing has no strategy, no Meta replay harness, and no load test.

**Missing.** Tests are specified in five places (§1.13, §2.11, §5.13, §6.9, §8.1.6) with no unifying statement of what is tested where. Two specific absences: there is **no recorded-fixture harness for Meta payloads** (page/instagram, messaging/standby/changes, echo, receipt, comment, album) despite `developers.facebook.com` being unreachable and half the Meta facts being marked ASSUMED — a fixture set is how those assumptions get pinned once and regression-tested forever; and there is **no load test** at all.

**Sketch.** Three layers, written down once: unit (clock injected, matcher engine, fold table, cost arithmetic, prompt render); integration against a local Supabase with the §2.11 negative suite and a stubbed `fetch` (the `check-supabase-nostore.mjs` technique); end-to-end with a `tests/fixtures/meta/*.json` set replayed through the real webhook route against a stubbed Anthropic. Capture real payloads during §8's shadow phase and freeze them as fixtures — that is free and it is the only way the ASSUMED Meta facts ever become verified.

## 20. The native Mongolian reviewer is a hard dependency with no name, no availability and no SLA.

**Missing.** §6.6 makes CI fail if a platform Mongolian block's hash has moved since sign-off; §4.5.3 blocks publish on a null `reviewed_at`; §8 gates go-live on the owner signing off every pinned sentence. Every one of those depends on a person who is identified nowhere, and §6.11 Q5 raises it as an open question rather than resolving it into a resource. There is also no glossary or style guide, so two reviewers would produce two registers.

**Sketch.** Name the person, agree a turnaround (48 hours for a platform block, same-day for a closure sentence), and agree a fallback for when they are unavailable — most likely: the founder may ship a *tenant* string with a temporary `reviewed_by='founder-provisional'` that expires in 14 days and blocks the next publish, but may never ship a *platform* block that way. Start a one-page glossary from the ancestor's existing pinned lines, which already encode a house register.

---

# TIER D — checked, genuinely deferred, listed so you know I looked

- **Voice AI** — seam only, correctly scoped, and §7.4's argument for *not* pre-committing `'voice'` to the transport enum is right.
- **Customer Care** — correctly gated twice (§7.2.0's transport *and* data-source prerequisites is the right catch).
- **Retrieval/RAG** — correctly deferred with a named trigger (§4.3.4).
- **Multi-language beyond Mongolian** — gap accepted and named (§8.4).
- **Content moderation** — the sibling has `moderateUserInput`/`isContentBlocked`; Dala AI has only §6.5 Ш7's in-prompt handling. Fine for DM-only v1; becomes real the day comments ship, because a Meta policy strike takes down every tenant at once (§3.17 Q2 names the blast radius without a control that reduces it).
- **The ancestor's three unauthenticated endpoints** — `/api/analytics` returns the last ten free-text customer feedback entries, `/api/feedback` writes to an unbounded in-memory array, `/api/health` leaks heap/RSS, and `LOG_WEBHOOK_URL` ships message previews offsite. §8.43 correctly says keep the deployment for 14 days as a rollback target; nothing says what happens on day 15. Take it offline then, and in the meantime set `LOG_WEBHOOK_URL` to empty. Small, but leaving it running indefinitely is an active liability with a client's name on it.

---

# CLAUDE.md lesson-by-lesson carry-forward audit

| Lesson | Status |
|---|---|
| Mongolian UI copy and user-facing errors | Carried |
| Next 14.2 / `@supabase/ssr` / middleware session refresh | Carried (§8.1.1) |
| Every paid AI call in a route handler | Carried |
| `guardAiRoute()`: one gate, no local re-implementations | **Partially dropped** — three names, three signatures across sections (gap #1) |
| The guest-serving route that must inline the same check, same order | **Dropped** — the analogous guest surface (web widget) is undesigned (gap #16) |
| Identity → entitlement → budget, in order, each failing closed | Carried, everywhere |
| `tier` nullable, a failed read yields `undefined` and is refused | Carried (`tenant_roles.state`, `monthly_budget_usd` default 0) |
| Don't 403 someone halfway through what they paid for | Carried in spirit (§7.7's mid-conversation degradation) |
| Quota helpers 503 on any error; never `try { check() } catch { continue }` | Carried, loudly and repeatedly |
| Two limiter layers; per-account is the real control, per-IP a NAT-sized backstop | **Partially dropped** — per-tenant/sender/conversation exist; no per-IP backstop and no statement of why not (matters only for the widget) |
| `FAIL_OPEN_KEYS` as a documented exception list; adding a key is a security decision | Carried (§5.8 re-derives it rather than copying — correct) |
| `@upstash/ratelimit`'s `timeout` resolves `{success:true}` — it fails **open** | **Dropped. Named nowhere** (gap #17) |
| Redis client construction can throw, so it sits inside the `try` | **Dropped. Named nowhere** (gap #17) |
| Missing Upstash creds in prod fail closed; dev allows through | Carried, and deliberately diverged with a stated reason (§5.8) |
| Server-owned tables: `SELECT` only, service-role writes derive server-side | Carried and improved (per-command restrictive denies) |
| Ownership RLS checks who a row belongs to, never what it says | Carried, quoted correctly |
| `anon` no privilege, `authenticated` `SELECT` only | Carried |
| Investigate → fix → verify live | Carried (§8's evidence-row discipline) |
| `supabase_migrations.schema_migrations` is not a ledger | Carried — though §2.10 (never use the dashboard editor) and §8.2 step 3 (assume the dashboard editor) contradict each other and need one answer |
| `information_schema.role_table_grants` empty ≠ no grants | Carried, with the demonstration |
| Use the catalog: `pg_policies`, `aclexplode`, `relrowsecurity` | Carried and extended (V0–V16) |
| A migration file is not a migration applied; check each table independently | Carried |
| `revoke insert,update,delete` is not "cannot write"; TRUNCATE bypasses RLS | Carried, with §2's TRUNCATE-on-the-ledger finding as a real extension |
| Secrets from the environment only; no fallback to a default credential | Carried and adapted — **but the KEK's own backup is undesigned** (gap #3) |
| Never mark work done without running it | Carried |
| #6 QPay `isUnderpaid()` fulfils on an unparsable settled amount | Generalised lesson carried (`per_message_cost_usd === null` refuses; `price_unknown`); **the domain it came from — taking money — is absent entirely** (gap #6) |
| #7 soft-404 with HTTP 200; exclude new file-like routes from the matcher | Carried (§8.1.1, §3.1 H0), with a test |
| #8 dead endpoints still reachable | **Partially dropped** — no rule that every endpoint is authenticated; the ancestor's three are described but never explicitly excluded from the port |
| #8 `sanitizeForPrompt` is not a security control | Carried, repeatedly and correctly |
| #8 usage RPCs exist in the DB but not the repo | Carried (V10 + "every function is a migration file") |
| #8 QPay logs bank details | Carried, and hardened into allow-list constraints on error-code columns |
| GET-only route caches Supabase reads for a year; only `cache:'no-store'` stops it | Carried extensively, both directions, with the guard script |
| NOTHING SPENDS ON A SCHEDULE without a ceiling and an alert path | Carried, and applied to the new scheduled spenders |
| Bank depth verified by direct SQL — a cached read is indistinguishable from truth | Carried as a general principle |
| `BANK_BUILD_BUDGET_USD = 0`; say who approved it in the commit | Carried and cited as the reasoning pattern for several defaults |
| CSP report-only; promote when clean; the safe headers already live | **Dropped** — no security-header design at all (gap #18) |
| Email senders on the authenticated domain; a 2xx means "accepted", never "delivered" | Principle carried (Telegram `message_id`, §8 step 8's negative test). **But no email path is designed**, despite §7.1.4 making email the mandatory handoff fallback and §4.5.2 making it the login recovery path — that path needs the same domain, DKIM/SPF and `messageId`-logging treatment before it is relied on |
| `README.md` is stale | Meta-lesson; `docs/onboarding` exists, no doc-freshness rule. Minor |

---

**If you fix only five things before writing code:** #1 (canonical schema), #2 (build plan with a V1 line), #3 (KEK escrow and Meta second admin), #4 (backups plus one rehearsed restore), #5 (App Review's non-permission deliverables). The first two unblock the work; the next three prevent losses you cannot undo.

**If you fix only three more before the first invoice:** #6 (revenue path), #7 (contract, and specifically the wrong-price liability clause), #8 (privacy, including rewriting Matrix's now-false published policy before cutover day).