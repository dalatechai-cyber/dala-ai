# CLAUDE.md

Working rules for Claude Code in this repository. The dated incident stories,
measurements and long explanations behind these rules are in
[`docs/history.md`](docs/history.md) (the full pre-slim file, verbatim). Search it for the
D-number or date when a rule's reason matters. [`docs/DECISIONS.md`](docs/DECISIONS.md)
holds each D-xxx in full.

## What this is

**Dala AI**: Dalatech's multi-tenant AI staff platform for Mongolian SMBs, sold by role
per month. One codebase, one deployment, one Supabase project, a **configuration per
tenant**. Tenant #0 is Dalatech itself, #1 «Tara Salon — Яармаг» (slug `matrix-eco-salon`, formerly
Matrix Eco Salon), #2 GS Auto Center. «Tara Salon — Парк Од» is the next, a separate business.
Customer-facing text is Mongolian Cyrillic.

Separate business from Core Language (`dalatech-english`): **zero shared code, customers
or databases. Never import from that repo.**

**V1 build is authorized (2026-09-01).** Product code is allowed; do not reinstate the old
"no product code" rule. Build per [`docs/V1.md`](docs/V1.md).

## Facts a session gets wrong

- **Meta: two apps exist** (founder, 2026-09-06). `dalatech` (`1380702870025418`) holds
  Matrix's Page `1520409424715591`. `DALA_AI` (`1562862634970492`) holds tenant #0's Page
  `863503883522801`. Both hold `pages_messaging` at Advanced Access, so **the DM path needs
  no App Review**. Comments need none either: `pages_read_user_content`,
  `pages_manage_metadata` and `pages_manage_engagement` are granted on `DALA_AI`, and
  comments work end to end in shadow (D-106).
- **A Page subscribed to both apps gets `entry.messaging` at both** (D-043). The mirror is
  a second subscription, not a forwarding hop. Standby still exists where the primary
  receiver is the Page Inbox app. `channel/delivery.ts` handles both.
- **An `app_slug` is this platform's callback-path name, not Meta's app name** (D-041).
  Tenant #0's `app_slug` says `dalatech` and names the wrong app. Read D-041 before
  touching `META_APP_SECRETS`, `app_slug` or §3.3's cross-check.
- **`developers.facebook.com` is blocked by this environment's proxy.** No session can
  check the App Dashboard. **A claim this repo cannot check is a question for the founder,
  not a fact to inherit.** Write such lines naming the founder as the only source.
- **Supabase project `tlggenaatnopnxzbkbuf`**, PostgreSQL 17.6, ap-southeast-1. Read the
  applied migrations off `supabase_migrations.schema_migrations`, never off
  `ls supabase/migrations/` and never off memory.
- **CI proves the repo, not the project.** CI applies every migration before running, so a
  column from an unpushed migration is green in CI and a 400 in production (every reply
  503s). **Before merging code that reads or writes a column a pending migration adds,
  read the ledger and merge only after the push** (D-058).
- `catalog.sql` **V25 fails on the project and is meant to**: `supabase_admin`'s default
  ACL grants `anon`/`authenticated` all eight privileges on future `public` tables. It is
  latent (only objects created by `supabase_admin`). Only that role can clear it.
- **Not proven on the project:** `isolation.sql` and `rls.sql` (the MCP transport commits;
  run them over psql). Downstream of the queue, only reachability is proven
  (`scripts/verify/postgrest.ts`, D-037/D-038), not correctness.
- **The send works** (first real send 2026-09-06). Tenant #0 channel is
  `active / live / active`. `tenants.status` stays `provisioning`, and **nothing on the
  reply path reads `tenants.status`**.
- **KEK:** `TENANT_KEK_ACTIVE_VERSION` is read at seal time only; reads select the key by
  `row.kek_version`, no fallback. **Never remove `TENANT_KEK_V1`** from the environment or
  comment it out in `.env.example` (preflight requires both names from there). Vercel
  cannot give the value back (D-107). Tenant #0's `page_token` has been opened over real
  PostgREST (`last_ok_at` 2026-09-19).
- **Ulaanbaatar time for anything a person reads or a day keys on** (D-151): `time/clock.ts`
  (`tenantClock`, `localDayStart`) or `time/ub.ts`. Never `toISOString().slice(...)` for a
  day, and never a raw ISO time in an alert. `time/tz.test.ts` runs under four machine
  zones.
- **The purge cadence is hourly and lives in the QStash console**, not in this repo. Ask;
  do not infer. The digest runs on QStash `5 16 * * *` UTC (00:05 Ulaanbaatar) and reports
  the Ulaanbaatar day that just ended. `DAILY_REPORT_V2=true` (with `DAILY_REPORT_SECRET`)
  merges it into one report.
- **Telegram is shared with customers:** `dalatech-online` posts demo requests into the
  same chat. Weigh any new `route: 'now'` alert against that.
- **Client billing is built and not live** (D-156, `docs/billing.md`): QPay on Core Language's
  merchant, `BILLING_MODE` off until the founder switches it. Until then the platform can spend
  and cannot collect.
- **Single-owner risk is ACCEPTED** (D-017). Do not raise it unless a D-017 trigger fires.

## The test every decision is measured against

> **Onboarding client #3 must be filling in a config, not writing code.**

**A client is rows. Never a repo, a branch or a code path** (founder, 2026-09-16). None of
these may exist in `src/`: a tenant id or slug in a literal, a branch on
`slug`/`display_name`/`vertical`, a tenant's own sentence, or a constant only one tenant's
numbers fit. A script that names a tenant takes it as an ARGUMENT.

Not violations, and not to be "fixed": a **docstring citing a tenant as evidence**, and a
**per-vertical** prompt block (`0018`'s most-specific-wins selection). `src/` was audited
clean (D-078). A new client is onboarded from their filled questionnaire with one command,
`scripts/onboard/tenant.ts` (D-155); `scripts/provision/*.sql` are the live tenants' history.
Eight platform gate blocks carry salon examples; neutral drafts that leave both live tenants
byte-identical wait for the founder in `prompt/drafts/vertical-neutral/`.

## The rules that override convenience

Code comments cite these by number. Keep the numbering.

1. **Tenant is derived server-side**, per webhook entry, from a registry with a unique
   key. Never from a request body, a header or an env var. **No `?? DEFAULT_TENANT`**, not
   even for local testing.
2. **Fail closed on money.** Identity, then entitlement, then budget, each refusing on
   error. Helpers return **503 on any error**. Never `try { check() } catch { continue }`.
   Failing open costs another tenant's money.
3. **Reserve spend before the call, settle after.**
4. **RLS per tenant, verified against the catalog:** `pg_policies`,
   `pg_class.relrowsecurity`, `aclexplode(pg_class.relacl)`. Never
   `information_schema.role_table_grants` (silently empty). **A migration file in the repo
   is not a migration applied.** Check each table independently. A policy on a table with
   RLS off is never evaluated.
5. **`revoke insert, update, delete` is not "cannot write."** PG17 has **eight**
   privileges (the eighth is `MAINTAIN`); TRUNCATE bypasses RLS. Enumerate the ACL.
   Ownership RLS checks who a row belongs to, never what it says.
6. **Mongolian Cyrillic, not ASCII.** NFC-normalise at every input boundary. No `\b`, no
   `\w`, no `[a-z]`, no unanchored substring matchers over user text, no byte length as
   character length. **Do not install `unaccent`.** This binds diagnostics too: a
   case-sensitive Cyrillic `includes()` once nearly reported a wrong result.
7. **Secrets from the environment only.** Per-tenant Meta tokens are data: envelope
   encryption, KEK in the platform env, decrypt per request. **Never a module-scope
   credential cache.**
8. **Next.js caching trap.** A route exporting only `GET` caches Supabase reads for a year;
   `force-dynamic` does not stop it, only `cache: 'no-store'` does. Use the shared clients
   in `supabase/clients.ts`; never construct a bare one.
9. **Never mark work done without running it.** Say what you verified, what you did not,
   and why.

## Engineering rules learned the hard way

Each line has its story in `docs/history.md`.

- **A row proves itself and nothing else** (D-028/D-029). "A row exists" is not "the work
  was done". The evidence that a reply happened is a reply (`findReplyFor` in
  `outbound/claim.ts`).
- **Dedup keys come from Meta's own ids** (`message.mid`, `value.comment_id`) in
  `webhook/identity.ts` (D-039). Read D-028 before touching `webhook/events.ts`,
  `queue/qstash.ts` or `health/stranded.ts`.
- **`src/lib/replay.test.ts`** asserts one event, message, reply and send per delivery, and
  two answers for two messages (D-030). It cannot catch wrong-schema name resolution.
- **Unit tests stub `db.rpc`**, so a green suite says nothing about PostgREST. RPCs
  called from the client must exist in `public` (D-029).
- **A parser that cannot finish returns `null`**, never the part it found
  (`scripts/verify/querysites.ts`, D-057). Undetermined is a result.
- **A guard triggered by "this collection is empty" dies when anything fills it.**
  `hasTenantData` and `reception/load.ts`'s `not_provisioned` key on `canned_responses` in
  opposite directions on purpose; do not harmonise them. Test against `DAY_ONE_KB` in
  `src/lib/prompt/tenantKb.fixtures.ts`, not a bare KB (D-058).
- **Guards keep a reason, not only a behaviour.** Before changing a guard, ask what makes
  it true today (e.g. the price guarantee rests on the digits-only reduction in
  `extractNumerals` / `allowedNumbersFrom`; it is not a substring test).
- **Ask who WRITES a column and who READS it** before trusting it (D-064, D-072).
  `monthly_ceiling_nanousd` and `on_exhausted` have no reader. Ask the same of computed
  values (D-083).
- **Evidence about a window must fall inside that window** (D-062). Append-only rows never
  age out.
- **`matchedAppSlug` is the slug whose secret verified the HMAC**, the only field saying
  which Meta app a delivery came from. For a silent channel, run
  `scripts/diagnose/meta-subscription.ts` first (GET-only). The two nearby Graph writes are
  **replacements presented as additions** (D-043).
- **Ask whether a condition recurs or persists before putting a period in a dedup key**
  (D-063). `on_change` rows are episodes (`resolved_at` means closed). `once`/`daily` rows
  are events. The digest and escalation filter on `repeat_policy`. Since D-128 every
  critical is an `on_change` episode; before choosing a policy, ask what closes the alert.
- **A backfill default decides the semantics of every existing row** (D-063 addendum).
- **A quiet alarm and a dead alarm must not look the same.** The digest sends on clean
  days too. An unreadable count prints UNREADABLE, never zero.
- **Channel-silence threshold is 180 min.** Re-derive D-016's 60.5 replies/day before
  anyone changes it.
- **Ordering that can reach the compiled prompt is by code point in JavaScript** (D-026).
  `check-deterministic-order.mjs` fails the build on `.localeCompare(`; exempt with a
  `guard-ok:locale` comment that says why.
- **When an exact-match check keeps being evaded, match the shape** (D-066). The
  gate-label guard (item 0) uses `(?<![\p{L}\p{N}])Ш\d{1,2}(?![\p{L}\p{N}])` and runs first.
- **`outboundGuard` is called only from `reception/handle.ts`.** That is correct while
  `worker/comments.ts` only posts reviewed `canned_responses` bytes. It becomes a hole the
  day anything generates a comment reply.
- **Pinned lines** (`gate/pinned.ts`, D-065/D-077): never edit a model reply. Discard it
  and serve the reviewed row's own bytes. Only reviewed rows are pinned. Safety lives in
  the length guard (`MIN_LENGTH_RATIO = 0.8`). An approved line adapted inside a longer
  reply is drift: `embeddedAdaptation` asks exact questions, never a fuzzy score (contains
  the row whole: exact quote; shares ≥60% and ≥40 chars: `canned_paraphrased`, serve the
  row).
- **Disclosure guard** (`disclosesPrompt`, D-068/D-077): the reply is cut at canned
  occurrences and each segment shingled on its own, never joined. Indexing is by code
  point. The exemption is padded one space each side. Never join canned bodies to test
  against, even in a diagnostic.
- **When one guard rejects approved data, look for the others** (D-071, D-074).
  `allowedUrls` includes `contact_points`. `CONTACT_KIND_LABELS` binds each Mongolian
  contact heading to one kind, so a tenant with no `address` row cannot render «Хаяг». `maskUrls` masks URLs to a SPACE (never to
  nothing) in `allowedNumbersFrom`, the reply check and the customer-echo set.
- **Prices never enter `allowed_numbers` or the prefix** (D-075). The platform serves the
  price from the row. `services/match.ts`: every token must occur, most specific wins,
  ambiguity is a verdict. A one-token match on a short stem is not evidence («сорри»
  reaches «Сор»); a specificity floor belongs above the matcher. Some collisions («Сор»)
  need a rename by the salon, not a row. The alias seed is held until names are settled.
- **`quality_flags` says what the model wrote; the draft says what the platform served.**
  Read the flag before explaining the draft.
- **Latin-script Mongolian is fixed with ROWS** (Latin stems beside Cyrillic ones), not a
  transliterator (D-067). Greetings abbreviations («Sn bnu») need a different matcher.
- **Inbound attachments:** skipped messages are written by `inbound/dropped.ts`. Stickers
  are keyed on `payload.sticker_id`, never on `type` (D-070). Photos get the reviewed
  `image_received` row via `inbound/imageReply.ts` (D-076). `customerAttachments` is
  required, never defaulted; `has_attachment` matches Meta's payload kinds exactly and is
  deliberately exempt from `MIN_STEM_CHARS` (D-083).
- **Handover** (D-080): echoes move `thread_control` only where `delivery_mode = 'live'`.
  Default is `unknown`; check 4 refuses only on `human`. Do not widen it. Read
  `docs/handover.md` before writing `pass_thread_control`; reclaim ships with pass.
- **A provider is not a surface** (D-082): `VolatileInput.surface` is
  `'direct_message' | 'public_comment'`. Filter canned rows only inside
  `cannedSectionBody`, the one renderer both publish and request paths share.
- **Read the ancestor for its rules, not only its architecture.** Before building any
  customer-facing behaviour, diff our rules against `Matrix-Chatbot`'s `lib/salonBrain.js`
  and `MESSENGER_ADDENDUM`. A rule it has and we lack is a measured loss.
- **Booking:** `metrics/turnsToIntent.ts` measures replies before the booking link;
  `not_delivered` is not a low score, so never average it in (D-042).
- **`answered_by`** is `model`, `deterministic`, `canned` or `human`. Never record a
  deterministic hit as `canned`; they have different review gates and spend (D-064).

## Publishing tenant config

- **Only `scripts/publish/tenant.ts` (`compileAndPublish`)** publishes. The SQL route is
  retired. A publish that bypasses it is untrusted until something independent reproduces
  its `content_hash`, **before** the write.
- It renders with the operator's checkout: **deploy, `git pull`, then publish.**
- It runs the reply cases against the new prefix; a failing or unverifiable case stops it.
- `SUPABASE_SECRET_PUBLISH` is not set in cloud sessions, so no session can publish by
  accident. Its absence is a safety, not an oversight; do not ask for it to be added.
- Run `npm install` before any `node scripts/...`; every script imports from `src/`.
- A control that reproduces the known live value must come before trusting a new one.
- **Every copy of a fact must agree** (D-151). `scripts/facts/gate.ts` compares the price
  rows with the FAQ, fixed replies, canned lines, KB, approved lines and
  `config/external-fact-copies.json`. It needs no model and flags a label with other
  capitals, or a ₮ amount a named service does not carry. Publish refuses on a
  disagreement or an unreadable sibling copy, so check out `../dalatech-chatbot` first.
  A new place that repeats a tenant's facts is added to that config.
- **A brand's branches are separate tenants** (D-157, final; D-125 stays dormant), listed in
  `config/branch-groups.json`. The branch gate (`scripts/facts/branchGate.ts`) refuses
  onboarding and publish when a tenant's rows carry another branch's phone, map link,
  address, staff or branch name, and publish when prices or the booking link differ. Onboard
  a branch from its own form, never by copying a sibling's rows. After a price change,
  update every branch's rows, then publish every branch.

## Money and model use

- **Reception runs Sonnet 5** (D-009). **No Haiku for customer-facing Mongolian prose.**
  Haiku is fine for internal or structured work.
- **The unit of cost is the conversation** (D-072). A cold reply is ~$0.0406, a warm one
  ~$0.0035. `RECEPTION_REPLY_ESTIMATE` is $0.041 (founder, 2026-09-15). Prefix trimming
  (`docs/prefix-trim.md`) is a margin lever.
- **The binding cap is daily:** the lower of the compiled
  `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY` ($2.00, the founder's call of 2026-09-21, D-106;
  it was $1.50 before) and the tenant's `tenant_budgets` daily × surface fraction, with
  `PLATFORM_HARD_CAP_USD_PER_DAY` ($10.00) across all tenants (`src/config/platform.ts`).
  Read 2026-09-30: Tara Яармаг's Reception cap is **$1.90** (her row, $2.00 × 0.95), DalaTech's
  $2.00 (the constant). Ceilings are never environment variables (`check-no-ceiling-env.mjs`).
- **The monthly figure is an alert, never a stop** (rulebook §3.1, D-159):
  `CLIENT_MONTHLY_NORMAL_LIMIT_MNT` (₮20,000) is read only by the daily report, which shows
  each client's month from `spend_ledger.cost_mnt` and marks 70%. A cap refusal pages at once
  (`spend/ceilingAlert.ts`, one `on_change` episode per tenant and surface, closed by the
  hourly health run after midnight). After a refusal the customer gets the tenant's own reviewed
  `handoff` row where one exists, on a live channel, once per conversation a day (Messenger
  since D-160, website since D-139), no model and no spend, and a person is told; with no reviewed row nothing is sent and the page is the signal.
- **₮250,000 is Reception's list price; ₮80,000 ≈ $22.86 is the allowable model spend**
  (D-004: ceilings derive from the discounted floor). Matrix's ceiling is $28.57 (60% of
  list), set by the founder; the departure is flagged, not resolved.
- Sold against a 400-conversation/month band (D-015). **Overage is the §5.7 degradation
  ladder, never an invoice**, and the ladder is designed but not built.
- **Live customers are the only thing allowed to spend** (D-137). No paid model runs in
  tests, gates or diagnostics unless the founder asks. **One exception** (D-151): before a
  publish that changes what a tenant's bot says, run that tenant's model cases once
  (`scripts/publish/tenant.ts --slug <slug> --with-model`, dry run). Report the result and
  what the run cost. Spend is allowed for this purpose only, one run per change.

## Merge authority and what waits for the founder

**Open a PR for everything. Merge your own once CI is fully green AND you have read the
job logs step by step** (founder, 2026-09-04). A green tick has hidden a skipped test here.

Four categories wait for the founder:

| Waits | Means |
|---|---|
| **Money movement** | Payments, billing, ceilings: anything that changes what can be spent. Not a code path that calls a model under an existing ceiling |
| **Credentials** | Provisioning, rotating or handling real secret material |
| **Destructive migrations** | Anything that drops, rewrites or narrows existing data |
| **Customer-visible Mongolian** | Any sentence the bot sends. Matcher stems and test fixtures are not this |

**Approved wording mechanism.** Platform Mongolian lives in `prompt/platform/*.mn.txt`,
signed by file hash in `prompt/platform-mn-review.json`. `scripts/guards/check-mn-review.mjs`
fails the build on an unsigned or changed block. Unsigned drafts live in `prompt/drafts/`
and nothing loads them. Tenant wording is `canned_responses` rows; an unreviewed row
refuses. **The founder is the native speaker; language observations are put to the founder,
not asserted.** Pending drafts: `sh2_price_precedence`, `sh3_booking`,
`matrix_out_of_scope_rewording`, Ш0 wording.

**Build gates.**
- `scripts/guards/check-schema-doc.mjs` fails when a migration is missing from
  `docs/schema.md`.
- The Vercel production build runs `scripts/preflight.ts` before `next build` (only when
  `VERCEL_ENV=production`). It never prints values. A gate must match the code it checks
  (`WORKER_PUBLIC_URL` is an origin; `queue/qstash.ts` appends the path).
- **Reply-case gate** (D-120/D-121/D-137): `scripts/replycases/gate.ts` runs in the
  production build and in publish. It checks only cases that never reach the model, plus
  EXACT cases whose row stopped answering. Model cases run only with `REPLY_GATE_MODEL=1` /
  `--with-model`, which spends. CI cannot see this gate (no live DB), so **read the Vercel
  build log before concluding a deploy happened.** The only bypass is the founder's signed
  Ed25519 override (outages only). **Never add a key to
  `src/lib/replycases/overrideKeys.ts` that the founder did not generate and hand over.**
- Model replies pass `guard/facts.ts`: a price, deposit, hour, phone or address in the
  model's words is replaced by data rows, or by the handoff line.

## Testing

- **PostgreSQL 16 is installed** at `/usr/lib/postgresql/16/bin` (not on `PATH`). `initdb`
  a scratch cluster and run the SQL suites locally; a migration never reaches a PR without
  that.
- Before changing the schema: run `scripts/localvalidate/run.sh`, then all files in
  `scripts/verify/` (`catalog.sql`, `isolation.sql`, `rls.sql`, `spend.sql`,
  `retention.sql`). All raise on failure.
- **`rls.sql` is required after any policy or grant change.** It runs as
  `anon`/`authenticated`. `isolation.sql` runs as `service_role` on purpose (D-027); do
  not swap them.
- **Count the checks, not the PASS lines** (each suite prints one extra summary NOTICE).
- CI is `C.UTF-8`; the project is `en_US.UTF-8`. Never let collation order reach a hash.
- `scripts/verify/postgrest.ts` checks every `.rpc()`, `.from()` and `.select()` column in
  `src/` against a real PostgREST. `scripts/verify/secret-roundtrip.ts` covers crypto over
  a local socket, not PostgREST.

## Session style (token budget)

Caveman (plugin, `.claude/settings.json`) applies to status lines and tool narration only.
The **final report** to the founder is plain, readable English in full sentences, and so
are commits, PR bodies, docs and every customer-visible string. Large command output goes
through context-mode (`ctx_execute` / `ctx_batch_execute`) rather than straight into
context.

**Subagents** (`.claude/agents/`): the main session stays on Opus. Use `researcher`
(Sonnet) for read-only lookups instead of `Explore` or `general-purpose`, which inherit
Opus. Use `reviewer-routine` (Sonnet) for docs, tests, scripts and config. Use `reviewer`
(Opus) for any change to code on the live-customer path (`src/`, migrations, prompt
blocks) and `architect` (Opus) for design. `tester` runs on Sonnet.

## Where things are

| | |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **Where this actually is.** What is built, what is unproven |
| [`docs/standards/dali.md`](docs/standards/dali.md) | **Дали's reply standard**: every rule, where it is enforced, the reply and change checklists |
| [`docs/standards/rulebook.md`](docs/standards/rulebook.md) | **The shared rulebook for every DalaTech agent**, with what tooling enforces and what is only convention |
| [`docs/history.md`](docs/history.md) | Full pre-slim CLAUDE.md: every incident, measurement and addendum |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The reviewable summary; start here |
| [`docs/architecture/09-reconciliation.md`](docs/architecture/09-reconciliation.md) | **The arbitration.** Beats every section file. Canonical table and env lists |
| [`docs/architecture/10-completeness.md`](docs/architecture/10-completeness.md) | Gaps no section addressed |
| [`docs/architecture/`](docs/architecture/) | 01–08, the design by dimension. `00-research-notes.md` lists ancestor defects |
| [`docs/schema.md`](docs/schema.md) | **The schema.** Beats every section file's DDL |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Settled calls and why. Pricing lives here |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 3–5 |
| `docs/handover.md`, `docs/comments.md`, `docs/prefix-trim.md` | Handover protocol, comments, prefix cost |

## The ancestor

`Matrix-Chatbot` is the single-tenant predecessor, live for Matrix. Reuse what works:
fast-ACK plus durable QStash hand-off, raw-body signature verification, per-PSID
conversation keys, pinned Mongolian sentences. **Do not port its defects**
(`docs/architecture/00-research-notes.md`): a module-scope prompt cache, `/me/messages`
(posts as whoever owns the token), and a `|| process.env.PAGE_ACCESS_TOKEN` fallback.
