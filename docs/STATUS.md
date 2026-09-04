# STATUS — what is built, what is stubbed, what has never been proven

**2026-09-04.** Written to answer one question honestly: *how far is this from a real
customer message, and what has to come from you?*

The short version. **Every line of V1's code path exists and is tested.** None of it has
ever touched Meta, a Supabase project, Anthropic, or QStash — because none of those four
exists yet. The gap is not engineering. It is four accounts and one twenty-day wait.

---

## 1. What is built

706 tests, 7 guards, 12 migrations, 63 modules. Every module below is merged on `main`
with CI green.

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
| | `channel/delivery`, `channel/halt` | Only `live` delivers; a `190` halts the channel and the token together |
| **The worker** | `worker/reception`, `worker/freshness` | Every branch of the job, as a value-returning function the route merely binds |
| **Health** | `health/silence`, `health/channel`, `health/watch`, `worker/health` | The silence watchdog: silence measured in OPEN minutes, two clocks so the standby trap cannot read as green (D-025) |
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

**Against a real PostgreSQL 16 (in CI, every run).** `catalog.sql` 18/18,
`isolation.sql` 10/10, `rls.sql` 8/8, plus `secret-roundtrip.ts`: a token sealed by the
operator's own command, stored in `bytea`, read back in the hex form PostgREST serialises,
and decrypted through the runtime loader — including the cross-tenant copy attack performed
in SQL, which fails.

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
is not vacuous.

**Against stubs (everything else).** 636 unit tests — 635 in CI, where the one
ancestor-dependent bake-off fixture check reports itself SKIPPED because `Matrix-Chatbot`
is private and CI cannot clone it. That skip is deliberate and says so in its own reason
string; it is named here so a count that does not match is investigated rather than
shrugged at. Load-bearing properties were checked
by mutation — the code was deliberately broken and the tests were watched to fail — for
the AAD binding, KEK version selection, the `me` refusal, the failed/indeterminate split,
and the signature comparison. Three more since: the comment dedup key (thread, not
comment), the `algorithm` field being checked rather than dispatched on, and the
status page's all-or-nothing block gate.

---

## 3. What has NEVER been proven

Read this section as the risk register. Nothing here is a known bug; it is a list of
claims nobody has earned yet.

| Never proven | Why | What would prove it |
|---|---|---|
| **Any PostgREST query** | No Supabase project exists. Every query in `src/` is exercised against a stub, never sent over the wire | A project, `0001`–`0005` applied, one real read |
| **`isolation.sql` T8/T9 against a real project** | Same. They pass against scratch Postgres, which is a different claim | Same |
| **Any Meta call, inbound or outbound** | The app, the Page and a working token all exist (D-023) — what is missing is a Supabase project holding the `tenant_channels` row and the sealed secret to read them from. The signature verifier has never seen a real Meta payload; the send has never reached Graph | The Supabase project, one channel row, one sealed token, one message |
| **The comment reply EDGE** | `POST /{comment-id}/comments` is SEARCH-CORROBORATED with an explicit "re-verify"; one source claims `POST /{comment-id}`. `developers.facebook.com` is blocked from this environment | Ten minutes on Meta's own docs, or the first real attempt. It is one constant, `REPLY_EDGE` |
| **`pages_read_user_content`** | Required to read customers' comments; was named nowhere in `docs/` until 2026-09-04. Search-corroborated, including that `pages_manage_engagement` *depends* on it — not confirmed against Meta's own permission reference | One look at the App Dashboard's Permissions and Features table, which states each permission's live access level |
| **The Graph error taxonomy** | Every code in it is from documentation and Chatwoot's handler. Not one has been observed | Production. Record the real codes as they appear |
| **Any Anthropic call from this repo** | `ANTHROPIC_API_KEY` is unset. The bake-off made real calls, but through a separate harness | One key, one call |
| **QStash redelivery and the crash property** | Unit-tested only. V1.md 1.5 has said so since it was written | A QStash account and a deliberately killed worker |
| **That the compiled prompt is a GOOD prompt** | The gate and the tenant's L2/L3 both compile now, `allowed_numbers` carries the tenant's real prices, and the marker has content behind it. What no test can tell you is whether the resulting prompt produces good Mongolian replies — that is §6.9's bake-off, and it needs a model key and real traffic | The bake-off, then the 14-day mirror |
| ~~**The refusal-topic list the MODEL reads**~~ | **Fixed 2026-09-04, and it needed no new column.** «ХОРИОТОЙ СЭДВҮҮД» listed `children_services`, so Ш1's model-side check compared Mongolian customer text against an English identifier — defence in depth doing less than it looked, since the authoritative detection is `gate/match.ts` on `matcher` stems before the model. The fix was to read `decision_question`, which is **NOT NULL on both refusal tables**, is the Mongolian first-line gate §8 designed it to be, and was simply never selected. Rendered as `key: question`, the shape `clarify_axes` already used — the key stays because it is what an operator greps and what the price list names when it withholds a price | Done. What is still unproven is whether it helps, which is the bake-off |
| **The prompt compiler against a real database** | **The chain is closed**: `prompt/sections.ts` loads blocks → `renderStablePrefix` → `publishRevision`. The twelve signed gate blocks compile into a 9,265-character prefix with a deterministic hash, proven in tests over the real signed bytes. What has never happened is the same compile **through PostgREST against a Supabase project**, and no tenant L2/L3 rows exist to compile alongside it | The project, and a tenant's config rows |
| **Prompt caching, and therefore the cost model** | D-016's margin rests on measured *ancestor* traffic, not on this system's bill | A month of real invoices |
| **Meta's data-deletion callback** | The `signed_request` format is SEARCH-CORROBORATED, never seen from Meta. No app exists, so nothing has ever posted to it. The response shape (`{url, confirmation_code}`) is standard JSON — several widely-copied implementations emit a JavaScript object literal instead, and one asserts JSON "fails" | The first real callback, or ten minutes on Meta's own docs |
| **That an erasure request can be FULFILLED** | Meta sends an app-scoped id; every id we hold is page-scoped. Nothing bridges them. A request is recorded, not executed — see §5 | A Business Manager containing the app and the Pages, then the ID Matching API |
| **That any of it works together** | The furthest anything has run is: a signed webhook POST reaching tenant resolution and 500ing on an unreachable registry | The list in §5 |

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

**Still not built: the 6-hourly token probe and the subscription reconciler.** Both need a
Meta call, and they catch a different fault — a token that has expired but has not yet been
used, which produces no absence to notice until a customer writes in. Until those exist,
that particular failure is still something you find out from a customer.

**And none of it has run.** The watchdog is exercised against stubs and a scratch
PostgreSQL; it has never read a real `webhook_events` row, and nothing schedules it yet —
that is one QStash schedule pointing at `/api/workers/health`, and QStash has no account.

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

The order is not arbitrary. Several steps are enforced by CHECK constraints, so getting
them out of order produces a database error rather than a broken deployment:
`active_requires_published_config`, `active_requires_probe_run`,
`live_requires_name_confirmation`, `live_requires_active_token`.

> **Check your work with one command:** `node scripts/preflight.ts`. It reports every
> required variable as ok / BAD / MISSING with the reason and the remedy, and it **never
> prints a value** — so the output is safe to paste anywhere. A pass means the
> configuration is right and nothing more: it proves nothing about Meta, Supabase,
> Anthropic or QStash actually answering.

### Free, and you can do all of it in an hour

| # | Supply | Without it |
|---|---|---|
| 1 | **Telegram bot token + alert chat id** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`) | Every alert is recorded in `alerts` and delivered nowhere. The condition is detected; nobody is told |
| 2 | **`IDENTITY_PEPPER`** — any 32 random bytes | `person_identities.value_hash` cannot be computed; inbound persistence refuses |
| 3 | **`TENANT_KEK_V1` + `TENANT_KEK_ACTIVE_VERSION=v1`** — `node scripts/kek/generate.ts` | No credential can be sealed or opened. Put the key in a password manager the moment it seals a real token: it has no issuer and no recovery path |
| ~~4~~ | ~~Sign Ш0–Ш9~~ · ~~sign the data-deletion status blocks~~ | **Done 2026-09-04.** All twenty-one blocks signed, promoted to `prompt/platform/`, and seeded by `0010` |
| 4c | **`DALA_PUBLIC_URL`** — the deployment's own origin, e.g. `https://dala.mn` | The deletion callback cannot build the status URL Meta requires. Never taken from the request's Host header, so it has to be configured |
| 4d | **`SUPABASE_SECRET_PRIVACY`** — one more named key, once the project exists | The deletion callback cannot record anything; every callback is a 500 and Meta retries |

### Costs money

| # | Supply | Note |
|---|---|---|
| 5 | **Supabase Pro, $25/mo** → a project → apply `0001`–`0005` via the CLI | Then run `scripts/verify/run-all.sh` **against the real project** and paste the output. A migration file in the repo is not a migration applied to a database |
| 6 | **Anthropic API key**, plus a **provider-side spend limit** | The platform's own ceiling is compiled in code; the provider limit is the backstop that does not depend on our correctness |
| 7 | **QStash**: `QSTASH_TOKEN` + both signing keys | Both, not one. Rotation is the reason there are two |
| 8 | **Vercel deployment** → `WORKER_PUBLIC_URL` | The worker needs a public URL before QStash can reach it |
| 8b | **One QStash schedule → `POST {WORKER_PUBLIC_URL}/api/workers/health`**, hourly | The silence watchdog is built and nothing calls it. It spends nothing — rows in, at most one Telegram message out — and it is the only thing that notices Reception has gone quiet (D-025). Unscheduled, that is still something you find out from a customer |

### From the Meta app you already have — no review, and it is not the long pole any more

**This section used to be "the long pole" and it was wrong** (D-023). `dalatech` holds
`pages_messaging` at Advanced Access, and Reception's DM path makes exactly one Graph call
under it. Nothing about a DM waits on Meta.

| # | Supply | Note |
|---|---|---|
| 9 | **`META_APP_ID`, `META_APP_SECRETS`, `META_VERIFY_TOKENS`** from the existing app | Config, not a review. `META_APP_SECRETS` is a JSON **map** so the cutover app's secret can be valid at the same time |
| 9b | **Confirm `pages_manage_metadata`'s access level** in the App Dashboard | It gates `POST /{page-id}/subscribed_apps`. At Standard Access it covers only Pages your own users have a role on — Matrix yes, GS Auto Center no — and it fails by subscribing nothing rather than by erroring |
| 9c | **Say which app currently holds Matrix's webhook subscription** — this one, or the ancestor's | Decides whether the Track 4 mirror is a subscription change or a second subscription, and whether §3.3's app-vs-identity cross-check fires during it |

### The comments track — parallel, and nothing else waits on it

| # | Supply | Note |
|---|---|---|
| 10 | **App Review for `pages_read_user_content` + `pages_manage_engagement`** | Those two only. Meta makes the second *depend* on the first, so a submission naming only `pages_manage_engagement` is incomplete. Business Verification is implied done — Advanced Access cannot exist without it — which is the multi-week half already behind you |
| 10b | **The rest of App Review's non-permission deliverables**: privacy policy URL, terms URL, app icon, public app name, use-case description | Each bounces a submission on its own. The Data Deletion Request callback — the one nothing had designed — is built; the other five are not code and nobody but you can supply them |
| 10c | **A test Page and a test user with a real Page admin role** for the screencast | A personal profile or a Business Manager preview is a named rejection cause: Meta cannot verify the permission grant flow from one |

### Then per-tenant, and all of it is rows rather than code

| # | Supply |
|---|---|
| 11 | A `tenants` row for Matrix; a `tenant_channels` row for the Page; `tenant_roles` with reception; `tenant_budgets` |
| 12 | The tenant's config: `services`, `business_hours`, `contact_points`, `faqs`, `canned_responses` for all ten kinds the gate can answer with (`GATE_BY_RESPONSE_KIND`), `deterministic_replies`, `disclosure_rules`, `out_of_scope_topics` |
| 13 | Publish a config revision → `tenants.live_revision_id` |
| 14 | Seal the Page token: `printf %s "$TOKEN" \| node scripts/kek/seal.ts --tenant <id> --channel <id> --kind page_token`, then paste the SQL |
| 15 | Subscribe the app to the Page, and **verify the app-level subscription too** — a page-level subscribe returns `{"success": true}` even when the app has never enabled that field, and no events are ever delivered |
| 16 | `delivery_mode = 'shadow'` for the 14-day mirror. **Not `live`** |
| 17 | After the mirror: unsubscribe the ancestor app first, confirm from each app's own token, then `delivery_mode = 'live'` |

| 18 | **Confirm the Business Portfolio holds the app AND every tenant Page**, then say so — that is what makes the ID Matching API answerable, and it is the missing half of the erasure path. A portfolio very likely exists already (Advanced Access implies Business Verification); what is unconfirmed is whether the Pages are in it |
| 19 | **Label every row you seed** (D-020). `provenance` now exists on those four tables plus `disclosure_rules`, with **no default**, so an INSERT that does not say where the row came from is refused by the database. Seeding is therefore safe again — a `seeded` FAQ stays out of the compiled prompt, a `seeded` deterministic reply is withheld and the model answers, and a `seeded` refusal still fires and is counted. What is **not** built is a resolver for the `service_aliases` reader, because nothing reads that table yet |

Step 18 is not optional and it is not urgent yet. Today a data deletion request is
**recorded and alerted, not fulfilled**: Meta's callback carries an app-scoped id and every
id we hold is page-scoped, so there is nothing to join. With the app and the Pages in one
Business Portfolio, `GET /{asid}/ids_for_pages` bridges them and the resolver becomes an
afternoon's work. Before there is a single real customer message there is also nothing to
erase, which is why this sits after go-live rather than before it — but it must not still
be sitting here when there is.

Step 16 is the one worth not rushing. Meta delivers the identical event to every
subscribed app, so during the mirror both this system and `Matrix-Chatbot` see every
message. `shadow` is what stops the salon's customers getting two replies — and the code
enforces it, but only if the row says `shadow`.

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
