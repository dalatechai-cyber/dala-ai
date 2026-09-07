# STATUS — what is built, what is stubbed, what has never been proven

**2026-09-04, last revised 2026-09-06.** Written to answer one question honestly:
*how far is this from a real customer message, and what has to come from you?*

The short version has changed, and the change is the first real webhook. **On 2026-09-06 at
01:17:25 UTC Meta delivered a message to this system, the signature verified, and the
tenant resolved from `channel_identity`.** All nineteen required variables are set and
well-formed — the production build's own preflight says so — and the deployment is live on
`api.dalatech.online`. That is presence, not proof each credential answers: two now have
proof (Meta signed a real delivery we verified; QStash answered our publish, with a
rejection), and Anthropic and the Supabase transport still have none. So the question is
no longer "what has to be bought": it is what tenant #0 still has no rows for.

**The message was not answered, and reading why is worth more than the summary.** The
enqueue was refused (QStash rejects `:` in a deduplication id, and every part of ours was
colon-joined), the route 500'd, and both of Meta's retries were skipped as duplicates and
answered **200** — which told Meta the message was delivered. Meta stopped. The event sat
in `failed` with nothing that would ever pick it up. Both halves are fixed (PR #43) and
the sweep that would have rescued it is built (§1, D-028), but the shape of the failure is
the thing to remember: **every status code was the one the code intended, and the message
was still lost.**

---

## 1. What is built

748 tests, 9 guards, 14 migrations, 64 modules. Every module below is merged on `main`
with CI green. **The project's ledger now reads fourteen too** — `0013` and `0014` were
pushed 2026-09-06, read back off `supabase_migrations.schema_migrations` rather than off
`ls`. `catalog.sql` V26 passes there as a result; **V25 still fails**, and it is meant to
(§2).

| | Module | State |
|---|---|---|
| **Inbound** | `meta/rawBody`, `meta/signature`, `webhooks/meta/[app]` | Raw **bytes**, 1 MB cap, a SET of app secrets, fast 200 |
| | `tenant/resolve` | Per-entry, from `channel_identity`. No `?? DEFAULT_TENANT` anywhere |
| | `webhook/events` | Claim-before-work; `unique (provider, dedup_key)`, global |
| | `queue/qstash` | Enqueue with `deduplicationId`; worker verifies BOTH signing keys |
| | `meta/extract` | Skips echoes, receipts, text-less attachments, postbacks — every skip reported. **`entry.standby` is counted, not dropped** (§3.7) |
| | `inbound/persist` | contact → person → conversation → message, and the history read |
| **Money** | `guard/withTenantRole` | identity → entitlement → consent → budget, each failing closed |
| | `spend/reserve`, `spend/settle` | Reserve **before** the call, settle after, CAS on the counter |
| | `config/platform` | Ceilings compiled in code; `tenant_budgets` can only ever LOWER them |
| | `alerts/alert` | Telegram, deduplicated in **Postgres**; the period is in the key |
| **The reply** | `mn/text`, `mn/match`, `mn/extract` | The Mongolian engine: stem prefixes, script share, code-point lengths, numerals, links |
| | `prompt/render`, `prompt/publish`, `prompt/kbSafety` | Compiler, publish, rollback as one pointer move |
| | `model/reception` | Sonnet 5, thinking pinned off, zero tools, `stop_reason` read before `content` |
| | `gate/match`, `gate/deterministic` | Ш-gate matching; the pre-model shortcut layer |
| | `guard/outbound` | Seven checks, first refusal wins; numerals, links, percentages, script |
| | `reception/handle`, `load`, `volatile`, `deps` | The flow, its loader, L4, and the effect bindings |
| | `model/health` | Cache-cold alarm, served-model check, retired-model page |
| **The send** | `crypto/envelope`, `crypto/kek` | AES-256-GCM envelope encryption; the AAD binds a row to its identity |
| | `secrets/tenantSecret` | The per-request decrypt. Six codes, exactly one retryable, nothing cached |
| | `meta/send` | `POST /{page-id}/messages`. `me` refused. Three outcomes, not two |
| | `outbound/claim`, `deliver`, `deliverDeps` | Draft, lease, deliver, and what each outcome costs |
| | `channel/delivery`, `channel/halt` | Only `live` delivers, and only `live` and `shadow` **generate** — a halted channel is `off`, so after a `190` it stops paying for replies it cannot send (D-034). A `190` halts the channel and the token together |
| | `channel/breaker` | The credential circuit breaker (D-036): three consecutive channel-local failures stop a channel drafting, at most one halt an hour platform-wide, and the **suppressed** halt is a critical alert carrying how many channels are failing — because a mass revocation and a config slip look identical from here, and only one of them should be absorbed quietly |
| **The worker** | `worker/reception`, `worker/freshness` | Every branch of the job, as a value-returning function the route merely binds |
| | `reception/handle` | The reply flow. Four refusals cost nothing and come before the call: a stale event, an unparseable matcher, an unreviewed canned line, and **a tenant whose compiled prefix carries none of its own data** — that one takes the handoff line, because the gate blocks describe a business with a knowledge base and the model would have only their salon examples to go on (D-033) |
| **Health** | `health/silence`, `health/channel`, `health/watch`, `worker/health` | The silence watchdog: silence measured in OPEN minutes, two clocks so the standby trap cannot read as green (D-025). A tenant whose hours are not entered yet is `not_provisioned` — recorded, never alerted (D-032) |
| | `health/stranded` | §3.6.3's sweeper, built 2026-09-06 after the first real webhook was lost between the claim and the queue. Re-publishes an unqueued event while a reply is still wanted; past the tenant's own reply-age limit marks it `expired_unqueued` and tells the founder. Alerts on anything it finds, because finding a row means the primary floor failed (D-028) |
| **Comments** | `meta/comments`, `comments/eligibility`, `comments/send`, `worker/comments` | The `feed` firehose, the decision that never sees the comment's text, and the public reply |
| **Privacy** | `meta/signedRequest`, `privacy/erasure`, `privacy/statusPage` | Meta's data-deletion callback: verify, record, and the status page it hands people |
| **The prompt** | `prompt/render`, `prompt/publish`, `prompt/sections`, `prompt/tenant` | The compiler, the immutable snapshot + pointer, the loader that joins them, and the tenant's rows rendered into L2/L3 |
| **Operator** | `scripts/kek/generate.ts` | One 32-byte key to stdout. Writes nothing |
| | `scripts/kek/seal.ts` | A token on **stdin** → the SQL for one `tenant_secrets` row, self-verified |
| | `scripts/preflight.ts` | Every required variable, ok / BAD / MISSING, with the remedy and no values |

---

## 2. What has been proven, and how

Three different kinds of evidence, worth keeping apart because they support different
claims.

**Against the real Supabase project (PostgreSQL 17.6, 2026-09-05).** **Fifteen** migrations,
`0001`–`0015`, applied through the CLI with a **fifteen**-row ledger (read back
2026-09-06: 15 rows, newest `0015`). That count is the project's own ledger, not the
repository's file count, and the two differ by two: `0016` and `0017` are written and not
yet pushed. `catalog.sql` was **25/25** there — all twenty-five checks the file carried
when it ran (V0–V24). It carries **twenty-nine** now, and three of the four written since
have been settled against the project: **V26 passes** since `0014` landed, **V27 passes**
since `0015` (both wrappers in `public`, ACLs `postgres` and `service_role` only), **V25
still fails** by design until `supabase_admin`'s default ACL is revoked by a role that can
(re-measured 2026-09-06, still present), and **V28 fails until `0017` is pushed** — it is
the check that asserts `channel_health` can tell a provisioning gap from an outage.

Seven direct behavioural probes pass there: `anon` refused on `services` and `tenants`,
`authenticated` refused TRUNCATE, INSERT, `tenant_secrets` and `spend_ledger`, and
no MAINTAIN leak. Cross-tenant isolation confirmed by seeding two tenants inside a
transaction and returning the results through a deliberate exception so it rolled back:
a member of A sees 1 of 2 services and 0 of tenant B's rows; a non-member sees 0.

**`anon` holds zero privileges on zero tables; `authenticated` holds SELECT and nothing
else, on exactly 31 — matching this document's own count of client-readable tables.**

**Against a real PostgREST (in CI, every run).** A `postgrest/postgrest:v12.2.3` service
container runs beside the database on `db-schemas=public` — the profile the runtime asks
for — and `scripts/verify/postgrest.ts` asserts every `.rpc()` and `.from()` name extracted
from `src/` is exposed there, then makes one live round trip through the real
`@supabase/supabase-js` client. This is the layer that had never been tested and that
D-029's third bug lived in. Made to go red both ways: dropping `public.reserve_spend_all`
reproduces that bug exactly, and revoking a table from `service_role` fails it from the
other side (D-037).

**Against the source, checked against a real schema (in CI, every run).**
`query-columns.ts` extracts every literal `.select()` list and every literal
`.insert()`/`.update()`/`.upsert()` key set from `src/` and asserts each column exists on
the table being queried: **277 references across 100 query sites**, with the 6 it cannot
resolve statically listed by file and line rather than skipped. Proven by mutation — a
misspelled select column, a table that does not exist, and a bad insert key are each
caught. This is the check that would have found a `.select('naem')` before PostgREST did.

**The documents, checked against their sources (2026-09-05).** Every countable claim in
this file, `CLAUDE.md`, `schema.md`, `V1.md`, `ARCHITECTURE.md`, `README.md`, `ROADMAP.md`,
`prompt/README.md` and `.claude/agents/reviewer.md` was re-derived from the thing it
describes rather than from another document. **Five had drifted**, all in one direction —
true when written, overtaken by the build:

- the live project's migration count: thirteen → **twelve**, read off its own ledger
- the `app`/`ops` function count: 11 → **13**, since `0012` added two
- `.claude/agents/reviewer.md` still said Postgres grants **seven** privileges. An agent
  told seven will enumerate seven and report a clean ACL
- **`IDENTITY_PEPPER` was missing** from `09-reconciliation.md`'s canonical env list, which
  is the list CLAUDE.md sends you to
- **seven files** still asserted "no Supabase project exists", including a V1 row calling
  `isolation.sql` T8/T9 against it *impossible*

Correct, and re-measured rather than assumed: 714 tests, 9 guards, 14 migrations, 63
modules, 79 tables, 31 client-readable tables, 21 signed blocks, a 9,265-character gate
prefix, 27 catalog checks, every relative Markdown link, and every `D-nnn` reference.

**The method is the finding.** A claim checked against another document is not checked —
`schema.md` had the migration count right and two other files had it wrong, and reading any
one of the three would have felt like verification.

**Supabase's own database linter, run against the project 2026-09-05.** Six security
warnings, of which four are fixed and two are deliberately left:

- **Fixed (`0014`, `catalog.sql` V26):** four `ops.*` trigger functions carried a mutable
  `search_path`. V11 asks that question only of SECURITY DEFINER functions and all four are
  INVOKER, so it passed 25/25 while they sat unpinned. The exploit is thin — none of them
  resolves an unqualified table — but every `app.*` function already pinned, and four
  permanent WARNs train the eye to skip the section by the time a fifth one means something.
- **Left alone, deliberately:** `pg_trgm` and `vector` are installed in `public` rather than
  Supabase's `extensions` schema, because `create extension` without a SCHEMA clause lands
  in the first entry of `search_path`. This is **not** a CI-vs-real difference — a vanilla
  cluster does the same — it is a Supabase convention the migrations do not follow.
  `pg_trgm` would move cheaply; **`vector` would not**, because `knowledge_chunks.embedding`
  is of that type and moving the extension moves the type out from under the column. `0002`
  is explicitly "applied when retrieval is switched on, not at launch", so the right moment
  to decide is then, in a migration that rebuilds the column rather than one that hopes.
  What it costs meanwhile: `anon` and `authenticated` hold USAGE on `public` and can
  therefore call trgm and vector functions. They hold no table privilege of any kind, so no
  data is reachable — this is schema hygiene, not a leak.

The performance linter returns ~40 INFO items, all unindexed foreign keys and unused
indexes **on a database with zero rows in every table**. Acting on them now would be
optimising a query plan nobody has run. Revisit after the 14-day mirror gives real volume
and real `pg_stat` counters — several of the flagged composite FKs already have their
leading column covered by a unique constraint, which the linter does not account for.

**Against a real PostgreSQL 16 (in CI, every run).** `catalog.sql` **29/29**,
`isolation.sql` **14/14**, `rls.sql` 8/8, plus `secret-roundtrip.ts`: a token sealed by the
operator's own command, stored in `bytea`, read back in the hex form PostgREST serialises,
and decrypted through the runtime loader — including the cross-tenant copy attack performed
in SQL, which fails.

Each of the newer catalog checks was also run against a database the migration it tests had
**not** reached, and made to FAIL cleanly rather than error. That distinction is not
pedantry: V22's first version referenced `prompt_blocks.layer` directly, which does not
*parse* when the column is absent, so the check errored out instead of reporting the very
absence it existed to detect — a check that cannot fail cleanly is the same defect as a
guard that under-reads its own source. Found by running it.

**Against a real HTTP server (in CI, every run).** `boot-smoke.sh` starts the built
Next.js app and speaks HTTP to it: the verify handshake returns the challenge verbatim, a
wrong token and an unknown app slug are 403, an HMAC over the raw bytes of a **Mongolian
Cyrillic** body verifies, one changed character in a still-valid body is 401, and a
verified POST against an unreachable registry is **500** — the transient half of the
200/500 asymmetry, at the layer where it actually matters. It now also drives the
data-deletion callback: an unsigned request and a forged one are both 400, a **genuinely
signed** `signed_request` gets past verification and 500s on the unreachable database, and
the status page returns 503 rather than rendering unsigned Mongolian. Mutating the
signature comparison to always-accept flips the forged case from 400 to 500, so the check
is not vacuous. Eleven checks in all: the last is the scheduled health worker refusing an
unsigned call, which is the branch that must never be open — anything able to trigger a run
is able to trigger the alerts it raises.

**Against stubs (everything else).** 714 unit tests, of which 713 pass in CI. The one
that does not — the ancestor-dependent bake-off fixture check — reports itself SKIPPED,
because `Matrix-Chatbot` is private and CI cannot clone it, so CI's pass count is one lower
than the local 714. That skip is deliberate and says so in its own reason string; it is
named here so a count that does not match is investigated rather than shrugged at.

Load-bearing properties were checked **by mutation** — the code was deliberately broken and
the tests were watched to fail — for the AAD binding, KEK version selection, the `me`
refusal, the failed/indeterminate split, the signature comparison, the comment dedup key
(thread, not comment), the `algorithm` field being checked rather than dispatched on, and
the status page's all-or-nothing block gate. Since then, twenty-five more across four
changes: D-020's provenance (six, including an absent column reading as confirmed and the
loader dropping the field from its `select`), the silence watchdog (nine, including
wall-clock instead of open minutes and the second stream dropped, which is the mutation
that makes the standby trap green), Ш1's Mongolian list (five), and the standby path
(five).

**Two of those mutations survived on the first attempt, and both were tests that asserted
too little.** The section-label check read only quoted and marker forms, so renaming a
label the gate referenced as bare inflected text passed; and the standby test asserted that
`webhook_events` was written without asserting *which state*, so marking the row
`processed` — precisely the value that hides the fault — passed. A mutation that survives is
the only reliable way to find a test shaped like a check.

---

## 3. What has NEVER been proven

Read this section as the risk register. Nothing here is a known bug; it is a list of
claims nobody has earned yet.

| Never proven | Why | What would prove it |
|---|---|---|
| ~~**Any PostgREST query**~~ | **Proven 2026-09-06, and by the incident rather than by a test.** The webhook read `channel_identity` and inserted into `webhook_events` over the `@supabase/supabase-js` transport with the service key, against the real project: row `id 1` exists, `routing='routed'`, tenant and channel bound. That closes the transport question this file had carried since the project was bought. It says nothing about the queries no path has reached yet — the config compile, the outbound claim, the spend ledger — which are still stub-only, and `query-columns.ts` (277 references across 100 sites) is what stands under those until they run | Done for the inbound path; open for every other query |
| ~~**`isolation.sql` and `rls.sql` against the real project**~~ | **Run there 2026-09-05, both green: isolation 14/14, rls 8/8 + R0.** Not by `psql -f` — Postgres is unreachable from this environment (5432 and 6543 refused on the session pooler and on the direct host; HTTPS to the project host is 403'd by the egress policy), so every assertion was sent as one `execute_sql` call that seeds, checks, and then `raise exception`s with the results aggregated, forcing the rollback the transport will not do for you. Verified zero residue afterwards: `tenants`, `services`, `tenant_channels`, `channel_identity`, `spend_ledger`, `spend_counters`, `config_revisions` and `config_audit` all back to 0 rows. **What is still owed is the file itself run by psql**, which is a different claim: same SQL, different transport, and no aggregation step to get wrong | `psql -f` from a machine that can reach the pooler |
| ~~**Any Meta call INBOUND**~~ | **Proven 2026-09-06.** A real Meta delivery reached `/api/webhooks/meta/dalatech`: raw-body signature verified, entry routed to tenant #0 through `channel_identity`, `webhook_events` row claimed. (Fourteen deliveries between 01:13:27 and 01:16:37 were refused `sig_invalid` with `matched_app_slug: none` — the second Meta app signing against the first one's secret — and the delivery after the 01:16:42 redeploy verified.) The verify handshake (`GET`, `hub.challenge`) had returned 200 minutes earlier. What that does **not** prove is anything past the claim | Done. The rest is below |
| **Any Meta call OUTBOUND** | `POST /{page-id}/messages` has still never run. The token is sealed in `tenant_secrets` and has never been opened by the runtime, so the whole envelope-decrypt path is still proven only over CI's test material | One reply actually sent |
| **That a job survives the queue** | QStash has answered — with a rejection, which is how the colon bug was found — but no job has ever been published, delivered, or verified at `/api/workers/reception`. Every signature check on that route is still stub-tested | One enqueued job that arrives |
| **The comment reply EDGE** | `POST /{comment-id}/comments` is SEARCH-CORROBORATED with an explicit "re-verify"; one source claims `POST /{comment-id}`. `developers.facebook.com` is blocked from this environment | Ten minutes on Meta's own docs, or the first real attempt. It is one constant, `REPLY_EDGE` |
| **`pages_read_user_content`** | Required to read customers' comments; was named nowhere in `docs/` until 2026-09-04. Search-corroborated, including that `pages_manage_engagement` *depends* on it — not confirmed against Meta's own permission reference | One look at the App Dashboard's Permissions and Features table, which states each permission's live access level |
| **The Graph error taxonomy** | Every code in it is from documentation and Chatwoot's handler. Not one has been observed | Production. Record the real codes as they appear |
| **Any Anthropic call from this repo** | `ANTHROPIC_API_KEY` is unset. The bake-off made real calls, but through a separate harness | One key, one call |
| **QStash redelivery and the crash property** | Unit-tested only. V1.md 1.5 has said so since it was written | A QStash account and a deliberately killed worker |
| **That the compiled prompt is a GOOD prompt** | The gate and the tenant's L2/L3 both compile now, `allowed_numbers` carries the tenant's real prices, and the marker has content behind it. What no test can tell you is whether the resulting prompt produces good Mongolian replies — that is §6.9's bake-off, and it needs a model key and real traffic | The bake-off, then the 14-day mirror |
| ~~**The refusal-topic list the MODEL reads**~~ | **Fixed 2026-09-04, and it needed no new column.** «ХОРИОТОЙ СЭДВҮҮД» listed `children_services`, so Ш1's model-side check compared Mongolian customer text against an English identifier — defence in depth doing less than it looked, since the authoritative detection is `gate/match.ts` on `matcher` stems before the model. The fix was to read `decision_question`, which is **NOT NULL on both refusal tables**, is the Mongolian first-line gate §8 designed it to be, and was simply never selected. Rendered as `key: question`, the shape `clarify_axes` already used — the key stays because it is what an operator greps and what the price list names when it withholds a price | Done. What is still unproven is whether it helps, which is the bake-off |
| **The prompt compiler against a real database** | **The chain is closed** and the blocks are now seeded in the real project by `0010`. What has never happened is the same compile **through PostgREST**, and no tenant L2/L3 rows exist to compile alongside them. Ordering no longer depends on the server's collation (D-026), so a compile there and a compile in CI would at least agree | A tenant's config rows, and the app pointed at the project |
| **Prompt caching, and therefore the cost model** | D-016's margin rests on measured *ancestor* traffic, not on this system's bill | A month of real invoices |
| **Meta's data-deletion callback** | The `signed_request` format is SEARCH-CORROBORATED, never seen from Meta. The app exists (D-023) but the callback URL has never been configured in it, so nothing has ever posted here. The response shape (`{url, confirmation_code}`) is standard JSON — several widely-copied implementations emit a JavaScript object literal instead, and one asserts JSON "fails" | The first real callback, or ten minutes on Meta's own docs |
| **That an erasure request can be FULFILLED** | Meta sends an app-scoped id; every id we hold is page-scoped. Nothing bridges them. A request is recorded, not executed — see §5 | A Business Manager containing the app and the Pages, then the ID Matching API |
| **That any of it works together** | The furthest anything has run is now real rather than synthetic: Meta → signature → tenant resolution → claim → **the enqueue, refused**. Nothing downstream of the queue has ever executed against a live dependency | The list in §5 |

### One thing worth saying plainly

**A single failure could still make the whole thing silent**, and the design says which:
a dead token produces no error, because no request arrives to fail.

**The absence watchdog is now built** (D-025, migration `0012`, `catalog.sql` V24). It
measures silence in **open minutes** rather than wall-clock — a salon shut overnight is
silent for fourteen hours and perfectly healthy, and an alarm that fires every morning is
muted within a week — and it watches **two** clocks rather than the one §3.10.5 specifies,
because a Page with our app as *secondary receiver* delivers into `entry[].standby`, which
we drop with a 200 while `last_webhook_at` stays fresh and every other signal reads green.
Webhooks arriving with no messages persisted is the standby fault; neither arriving is the
token; neither ever arriving is a field subscription that never worked.

**And the standby case is now caught at the instant it happens**, not three open hours later: `meta/extract` counts `entry.standby`, and the worker marks the event `standby_not_primary` — a state `0001` anticipated — refuses with a 200, and alerts. Before this, an entry delivered to us as a secondary receiver produced an extraction byte-identical to "no customer wrote in".

**And there was a second silence the watchdog could not see, which is now closed too.**
A webhook that ARRIVES and is never answered leaves every silence signal green:
`last_webhook_at` is fresh, the channel reads healthy, and a customer is waiting. That is
precisely what happened on the first real message. `health/stranded.ts` asks the other
question — is anything claimed and never queued? — and it is §3.6.3's sweeper, which the
design specified and nothing had built. Inside the tenant's reply-age limit it re-publishes
the job; past it, it marks the row `expired_unqueued` (the state `0001` named and nothing
had ever written) and says so. It alerts on **anything** it finds, because finding a row
means the route's own publish failed (D-028).

**Still not built: the 6-hourly token probe and the subscription reconciler.** Both need a
Meta call, and they catch a different fault — a token that has expired but has not yet been
used, which produces no absence to notice until a customer writes in. Until those exist,
that particular failure is still something you find out from a customer.

**It has now run, and the first thing it did was find a false alarm in itself.** The
hourly QStash schedule's first alerting run was **03:00:07 UTC on 2026-09-06**, and both
alerts are stamped there and `delivered = true`. The sweep retired event `id 1` as
`expired_unqueued` — 102 minutes old, past the tenant's 30-minute reply limit. The second
alert was `channel.unknown`: *"no usable business_hours row"*, on a tenant that has never
needed hours.

**That it re-fires is now measured rather than predicted.** `channel_health` is upserted
every run, and at 17:00:00 UTC it read *"no usable business_hours row for 2026-09-07"* —
the tenant's clock (UTC+8) had rolled over while the dedup key, which is keyed on the UTC
day, had not. The alert was suppressed as a same-day duplicate and would have been raised
again at 00:00 UTC, and every day after that.

**Fixed as a class, not as a row** (D-032). Seeding tenant #0's hours would have silenced
this channel and left every future tenant in the same window — Matrix included, on day one,
with a real customer's Page. A provisioning gap is now its own verdict: `not_provisioned` is
written to `channel_health`, counted in the health worker's response, and **never alerted**.
A schedule that exists and says *closed* is a different thing and still alerts.

**Still exercised only against stubs and a scratch PostgreSQL below that**: the watchdog and
the sweep have now read real rows once, on one channel, with one live tenant.

---

## 4. Decisions waiting for you

**None.** All twenty-one Mongolian blocks were signed on 2026-09-04 and are seeded by
`0010`; `prompt/drafts/` is empty of blocks and is now the design record.

### Settled 2026-09-04, and already built

- **`max_reply_age_minutes` = 30**, per tenant — *"a bot answering an hour-old Messenger
  message reads as broken, not helpful."* Migration `0006`, checked by `catalog.sql` V18
  (proven to fail against a database the migration has not reached). The check runs after
  the message is persisted and before the reservation, so a stale message costs three rows
  and no spend, and lands in `quality_flags` as `reply_too_late`.
- **The `contacts.last_inbound_at` / `window_expires_at` columns are not being built.**
  Not ahead of the §3.4.5 restoration replay that would be their only consumer.
- **The worker route has tests**, because it stopped being the route: the branching lives
  in `lib/worker/reception.ts` and the route is a binding that may not branch. Five
  mutations were each caught by exactly the test that should catch them.
- **The tenant's rows render into L2/L3** (`prompt/tenant.ts`). `01_data_marker`'s marker
  now has content behind it, and `allowed_numbers` carries the tenant's prices instead of
  being empty. The section labels the gate addresses by name — «ХОРИОТОЙ СЭДВҮҮД»,
  «ҮНИЙН ЖАГСААЛТ», «БАГИЙН ЖАГСААЛТ», the data marker — are asserted against the signed
  blocks in both directions, so renaming one fails the build rather than orphaning a check.
- **The compiler chain is closed** (`prompt/sections.ts`): signed blocks → `prompt_blocks`
  → `PromptSection[]` → `renderStablePrefix` → `config_snapshots`. `renderStablePrefix`
  had been built, tested and **unreachable** since Track 1 — a pure function nothing called.
  It now compiles the twelve gate blocks into a real 9,265-character prefix.
- **`allowed_numbers` now comes from tenant sections only** (D-024), corrected while
  building that loader. Deriving it from the whole prefix allow-listed «20,000» and
  «33,000» — the fabricated prices Ш1 and Ш2 exist to forbid — handing the outbound guard
  the exact output the gate is written to prevent.
- **The Mongolian is signed, promoted and seeded** — twenty-one blocks in
  `prompt/platform/`, hashed in `prompt/platform-mn-review.json` (`reviewed_by: Bilguun`),
  and carried into `prompt_blocks` by `0010`, which is **generated** from the signed files
  so the database can never hold text that differs from what was read. `catalog.sql` V22
  asserts it. Reference-by-key was kept over inlining, on the founder's call: the
  platform-wide cache entry is worth more later than the clarity gain now.
- **The Meta app EXISTS and DM Reception needs no App Review** (D-023, superseding D-022).
  `dalatech` holds `pages_messaging` and `public_profile` at Advanced Access. Every earlier
  statement in this repo that no Meta app existed was an unfalsifiable claim inherited and
  repeated — see CLAUDE.md's opening. **App Review is now a comments-only track**:
  `pages_read_user_content` + `pages_manage_engagement`, and nothing else.
- **The Data Deletion Request callback is built** (`0008`, `catalog.sql` V20), because a
  submission bounced for it costs a full cycle whatever else is in it. It records; it does
  not yet delete. §5 item 17 is why.
- **One public comment reply per POST per rolling 24 hours**, default 1, with the
  per-thread rule kept as the inner guard (D-021). Migration `0009`, `catalog.sql` V21,
  both proven to fail against a database the migration has not reached.
- **Two lessons from the Matrix analysis are now decisions**: D-019 (the platform persists
  transcripts itself, from day one — D-016's conversation count is weak precisely because
  nothing did) and D-020 (a seeded or guessed row carries its provenance into every reader,
  or is not written at all).
- **D-020 is built**: migration `0011`, `catalog.sql` V23, and readers that act on the
  column rather than merely storing it. `provenance` has **no default**, so an unlabelled
  INSERT is refused by the database and an unlabelled `GateRule` fails to compile. An
  unconfirmed FAQ is excluded from the prompt — which also keeps a guessed price out of
  `allowed_numbers`, where it would otherwise allow-list itself past the outbound guard —
  an unconfirmed deterministic reply is withheld and the model answers instead, and an
  unconfirmed refusal still fires and is counted into `quality_flags`.

---

## 5. The ordered list — what you supply to get one real message

**Revised 2026-09-06, after the first real webhook.** Most of this section used to be
accounts and variables; nearly all of that is now done, and what is left is rows and one
schedule. The order is still not arbitrary: several steps are enforced by CHECK
constraints, so getting them out of order produces a database error rather than a broken
deployment — `active_requires_published_config`, `active_requires_probe_run`,
`live_requires_name_confirmation`, `live_requires_active_token`.

> **Check your work with one command:** `node scripts/preflight.ts`. It reports every
> required variable as ok / BAD / MISSING with the reason and the remedy, and it **never
> prints a value** — so the output is safe to paste anywhere. It also runs inside the
> Vercel production build (`vercel.json`), so a bad value fails the deploy instead of
> shipping a deployment that 500s at the first customer message. A pass means the
> configuration is right and nothing more: it proves nothing about Meta, Supabase,
> Anthropic or QStash actually answering.

### Done — the whole environment, and it is not worth re-litigating

All **nineteen** required variables pass preflight inside the production build (2026-09-06).
Three had been wrong and are fixed: `TENANT_KEK_ACTIVE_VERSION` was empty, and both Meta
variables were missing the JSON map wrapper. That covers what used to be items 1, 2, 3, 4c,
4d, 6, 7 and 8 — Telegram, `IDENTITY_PEPPER`, the KEK, the two public URLs, Anthropic,
QStash and the deployment.

Two of those credentials now have live proof rather than a format check: **Meta** signed a
delivery this system verified, and **QStash** answered a publish (by refusing it — which is
how the colon bug was found). **Anthropic and the Supabase service keys have never been
exercised by a real request** beyond the webhook's own two queries.

The deployment is live on **`api.dalatech.online`**, which is also what solved the
Vercel-Authentication trap: the project protected `all_except_custom_domains` with no
custom domain, so every URL it had answered `302 → vercel.com/sso-api` — Meta's verify
handshake, QStash's call to the worker, and the public data-deletion status page would all
have hit a login wall.

### The one step that is still just a step

| # | Supply | Without it |
|---|---|---|
| ~~5d~~ | ~~`supabase db push` for `0015`~~ | **Pushed and verified 2026-09-06.** Both wrappers exist in `public`, `reserve_spend` returns boolean, `settle_spend` returns void, ACLs are `postgres` and `service_role` only |
| ~~5e~~ | ~~`supabase db push` for `0016`–`0018`~~ | **All applied.** The ledger reads eighteen rows, `0001`–`0018` (read back 2026-09-06). Nothing in `supabase/migrations/` is now unpushed |
| 8c | **One QStash schedule → `/api/workers/purge`**, nightly | The retention job (D-045). Needs `0020` pushed first. Same signing keys as 8b, so no new credential: a QStash schedule POSTing to `{WORKER_PUBLIC_URL}/api/workers/purge`. It reaches no provider and spends nothing, so `NOTHING SPENDS ON A SCHEDULE` is not engaged. Until it exists, `raw_payload` holds Matrix's customers' verbatim messages indefinitely |
| ~~8b~~ | ~~One QStash schedule → `/api/workers/health`~~ | **Created and FIRING 2026-09-06, hourly.** Both alerts stamped 03:00:07/03:00:12 UTC and delivered; event `id 1` retired as `expired_unqueued`; `channel_health` upserted every run since (17:00:00 UTC at last read). One alert real, one a false alarm now fixed as a class (D-032) |

### Then tenant #0's rows — this is the whole remaining path to a reply

Tenant `dalatech` (`919e21d4-224d-44b3-bb62-273caa6237ce`) exists, and so do its channel
(`cc5e2748-1bd9-4a36-9a31-4910acfafe2f`, Page `863503883522801`), its `channel_identity`
row — which is what routed the real delivery — its `tenant_roles` row (`reception`,
`active`), and its sealed `page_token`. What it has **no rows for at all** is the config,
and that is now the only thing between a message arriving and a message being answered.

| # | Supply | State |
|---|---|---|
| 11 | `tenants`, `tenant_channels`, `channel_identity`, `tenant_roles` | **Done.** `tenants.status` is `provisioning`, which is correct: `active_requires_published_config` refuses `active` until item 13 |
| 14 | Seal the Page token | **Done.** One `tenant_secrets` row, `page_token`, `status=active`, KEK v1. `last_ok_at` is null — it has never been opened by the runtime |
| 12 | **The tenant's config rows** | **Done for the nine that gate a reply.** `canned_responses` carries all nine kinds the compiled prompt names — founder-approved wording, `reviewed_at` set, `locale mn-MN`. Everything else (`services`, `faqs`, `business_hours`, `contact_points`, `deterministic_replies`) is still empty, which is a *product* limit rather than a blocker: with no facts, `allowed_numbers` is empty and every numeric answer is refused into the handoff line, by design |
| 13 | Publish a config revision → `tenants.live_revision_id` | **Done.** Revision `26814470-50c6-4cb9-b613-826bf536480b`, seq 1, published; snapshot `facebook_page`, 9,265 chars, `content_hash 8b35d072…`, `allowed_numbers []`. Compiled two ways that had to agree — the repo's `renderStablePrefix` over the signed files, and `string_agg(normalize(body, NFC), …)` over `prompt_blocks` — because `compileAndPublish` needs a service key this environment does not have |
| 15 | Subscribe the app to the Page, and **verify the app-level subscription too** | A page-level subscribe returns `{"success": true}` even when the app has never enabled that field, and no events are ever delivered. The 2026-09-06 delivery proves the subscription works for `messages` on this Page |
| 16 | Subscribe `DALA_AI` to **Matrix's** Page alongside `dalatech`, then `delivery_mode` | **The mirror is a second subscription — measured (D-043), no forwarding hop.** §3.13.1 is the exact call and the four-read pre-flight; the abort check is `debug_token`'s `app_id`, because `subscribed_apps` takes no app parameter and a `dalatech`-issued token would rewrite the incumbent's field list on a live Page. Never through the console's Add Page picker: it writes the complete Page set and took Matrix offline for ten minutes on 2026-09-06. **Tenant #0 is `live`** (`status active / delivery_mode live / token_status active`, `name_confirmed_at` set). Setting `token_status = 'active'` is an ASSERTION: the sealed token has never been opened, `last_ok_at` is null. **Matrix is different** — its 14-day mirror runs on `shadow`, which drafts and does not send. **Not `live`** |
| 17 | After Matrix's mirror: unsubscribe the ancestor app first, confirm from each app's own token, then `delivery_mode = 'live'` and `token_status = 'active'` | `live_requires_active_token` refuses the two halves separately, so the flip is one statement setting both |

### From the Meta app — the second app changed the answers here

**9c is answered.** The app called `dalatech` is the **ancestor's**, still serving Matrix's
customer DMs, which is why its callback could not be repointed. The app signing this
system's webhooks is the new one, **DALA_AI** (`1562862634970492`), configured under the
same slug `dalatech` in `META_APP_SECRETS` / `META_VERIFY_TOKENS`. The slug is our name for
a callback path, not Meta's name for an app — worth knowing before reading either variable.

| # | Supply | Note |
|---|---|---|
| 9 | `META_APP_ID`, `META_APP_SECRETS`, `META_VERIFY_TOKENS` | **Done, for DALA_AI.** Both maps accept `value | value[]`, which is the designed cutover mechanism: during the mirror, the ancestor's secret can be valid at the same time as this one's |
| 9b | **Confirm `pages_manage_metadata`'s access level** in the App Dashboard | Unchanged. It gates `POST /{page-id}/subscribed_apps`. At Standard Access it covers only Pages your own users have a role on — Matrix yes, GS Auto Center no — and it fails by subscribing nothing rather than by erroring |

### The comments track — parallel, and nothing else waits on it

| # | Supply | Note |
|---|---|---|
| 10 | **App Review for `pages_read_user_content` + `pages_manage_engagement`** | Those two only. Meta makes the second *depend* on the first, so a submission naming only `pages_manage_engagement` is incomplete. Business Verification is implied done — Advanced Access cannot exist without it — which is the multi-week half already behind you |
| 10b | **The rest of App Review's non-permission deliverables**: privacy policy URL, terms URL, app icon, public app name, use-case description | Each bounces a submission on its own. The Data Deletion Request callback — the one nothing had designed — is built; the other five are not code and nobody but you can supply them |
| 10c | **A test Page and a test user with a real Page admin role** for the screencast | A personal profile or a Business Manager preview is a named rejection cause: Meta cannot verify the permission grant flow from one |

### Still owed against the database

| # | Supply | Note |
|---|---|---|
| 5b | **`psql -f` for `isolation.sql` and `rls.sql`** against the project | `0013` and `0014` are pushed — the ledger reads fourteen — and `catalog.sql` V26 passes there as a result. The two behavioural suites have been run through `execute_sql` with an aggregated rollback, but never as the files themselves, which is a different claim: same SQL, different transport, no aggregation step to get wrong |
| 5c | **The `supabase_admin` default ACL** | Measured again 2026-09-06 and **still live**: `supabase_admin` grants `anon` and `authenticated` all eight privileges on every future table in `public`, and `postgres` cannot revoke it — which is why `0013` warns instead of failing and V25 stays red. It is latent, not exploitable: it only bites for a table created in `public` **by** `supabase_admin`. Clearing it needs a role neither this session nor the CLI has |

| 18 | **Confirm the Business Portfolio holds the app AND every tenant Page**, then say so — that is what makes the ID Matching API answerable, and it is the missing half of the erasure path. A portfolio very likely exists already (Advanced Access implies Business Verification); what is unconfirmed is whether the Pages are in it |
| 19 | **Label every row you seed** (D-020). `provenance` now exists on those four tables plus `disclosure_rules`, with **no default**, so an INSERT that does not say where the row came from is refused by the database. Seeding is therefore safe again — a `seeded` FAQ stays out of the compiled prompt, a `seeded` deterministic reply is withheld and the model answers, and a `seeded` refusal still fires and is counted. What is **not** built is a resolver for the `service_aliases` reader, because nothing reads that table yet |

Step 18 is not optional and it is not urgent yet. Today a data deletion request is
**recorded and alerted, not fulfilled**: Meta's callback carries an app-scoped id and every
id we hold is page-scoped, so there is nothing to join. With the app and the Pages in one
Business Portfolio, `GET /{asid}/ids_for_pages` bridges them and the resolver becomes an
afternoon's work. Before there is a single real customer message there is also nothing to
erase, which is why this sits after go-live rather than before it — but it must not still
be sitting here when there is.

Step 16 is the one worth not rushing. During the mirror both this system and
`Matrix-Chatbot` are answering the same Page, and `shadow` is what stops the salon's
customers getting two replies — the code enforces it, but only if the row says `shadow`.

By what route both systems see the traffic **is now measured** (D-043, 2026-09-07). Getting
there took two wrong answers, both worth keeping. This document said "§3.10.5 establishes
that Meta delivers the identical event to *every* subscribed app". §3.10.5 is *Back off the
tenant, not the worker* and is about rate-limit backoff. The correction then said there was
only one Meta app, so no second subscriber was possible — also wrong, and instructively so:
`tenant_channels.app_slug` for tenant #0 reads `dalatech` while that Page actually lives on
a second app (D-041), so the database said one app and the console said two.

The facts, read from the App Dashboard on 2026-09-06:

| app | App ID | holds |
|---|---|---|
| `dalatech` | 1380702870025418 | Matrix's Page 1520409424715591; the ancestor's callback at `matrix-chatbot-seven.vercel.app/api/messenger` |
| `DALA_AI` | 1562862634970492 | tenant #0's Page 863503883522801; this platform's callback |

**The measurement.** The founder subscribed tenant #0's Page `863503883522801` to **both**
apps simultaneously and sent one real message. It arrived at `DALA_AI` in
**`entry.messaging`** — `has_messaging: true`, `has_standby: false` — and was answered end
to end: `webhook_events` id 8, `dedup_key` `863503883522801:0:mfc9ea15…:dalatech`, reply
`state='sent'` with a real `provider_message_id`. **Meta delivered the real event to both
apps and demoted neither.**

So the original claim was right and only its citation was wrong, and **the mirror is a
second subscription rather than a forwarding hop**: subscribe `DALA_AI` to Matrix's Page
alongside `dalatech` and both systems receive the identical event. Nothing needs to relay.
`webhook_events.source` (D-039) stays for the day forwarding is wanted anyway.

**Two things the measurement does not settle.** It was taken on tenant #0's Page, so it
proves that being a second subscribed app is not itself a Handover demotion — not that
Matrix's Page lacks a configured primary receiver. If theirs has one, `DALA_AI` lands in
`standby` there and the mirror generates nothing and alerts daily; that is discoverable
with one message and is not an outage. And §3.7's standby branch stays exactly as it is:
the Page Inbox case is a different mechanism and was not tested by this.


---

## 6. What is deliberately not being built

Not forgotten — deferred with a reason, so "we should also…" has something to argue
against.

- **Billing overage.** Undesigned, and staying that way while there is no revenue path.
  Overage is §5.7's degradation ladder, never an invoice.
- **KEK rotation machinery.** The read path already selects by `kek_version`, so rotation
  is a job nobody needs yet. Escrow is not the same thing and is not deferred.
- **Instagram, comment replies, the Quality layer, analytics automation, the probe-token
  onboarding flow.** All in `V1.md`, each with its own return condition.
- **KEK escrow and second admins.** Accepted risk, not an open question (D-017). Do not
  raise it again unless one of D-017's named triggers fires.
