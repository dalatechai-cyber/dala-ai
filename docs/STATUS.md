# STATUS — what is built, what is stubbed, what has never been proven

**2026-09-04.** Written to answer one question honestly: *how far is this from a real
customer message, and what has to come from you?*

The short version. **Every line of V1's code path exists and is tested.** None of it has
ever touched Meta, a Supabase project, Anthropic, or QStash — because none of those four
exists yet. The gap is not engineering. It is four accounts and one twenty-day wait.

---

## 1. What is built

603 tests, 7 guards, 9 migrations, 55 modules. Every module below is merged on `main`
with CI green.

| | Module | State |
|---|---|---|
| **Inbound** | `meta/rawBody`, `meta/signature`, `webhooks/meta/[app]` | Raw **bytes**, 1 MB cap, a SET of app secrets, fast 200 |
| | `tenant/resolve` | Per-entry, from `channel_identity`. No `?? DEFAULT_TENANT` anywhere |
| | `webhook/events` | Claim-before-work; `unique (provider, dedup_key)`, global |
| | `queue/qstash` | Enqueue with `deduplicationId`; worker verifies BOTH signing keys |
| | `meta/extract` | Skips echoes, receipts, text-less attachments, postbacks — every skip reported |
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
| **Comments** | `meta/comments`, `comments/eligibility`, `comments/send`, `worker/comments` | The `feed` firehose, the decision that never sees the comment's text, and the public reply |
| **Privacy** | `meta/signedRequest`, `privacy/erasure`, `privacy/statusPage` | Meta's data-deletion callback: verify, record, and the status page it hands people |
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

**Against stubs (everything else).** 603 unit tests — 602 in CI, where the one
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
| **Any Meta call, inbound or outbound** | No app, no Page, no token. The signature verifier has never seen a real Meta payload; the send has never reached Graph | The Meta app, and one message |
| **The comment reply EDGE** | `POST /{comment-id}/comments` is SEARCH-CORROBORATED with an explicit "re-verify"; one source claims `POST /{comment-id}`. `developers.facebook.com` is blocked from this environment | Ten minutes on Meta's own docs, or the first real attempt. It is one constant, `REPLY_EDGE` |
| **`pages_read_user_content`** | Required to read customers' comments and named nowhere in `docs/`. Community-corroborated, not confirmed against Meta's permission reference | The same ten minutes — before App Review is submitted, not after |
| **The Graph error taxonomy** | Every code in it is from documentation and Chatwoot's handler. Not one has been observed | Production. Record the real codes as they appear |
| **Any Anthropic call from this repo** | `ANTHROPIC_API_KEY` is unset. The bake-off made real calls, but through a separate harness | One key, one call |
| **QStash redelivery and the crash property** | Unit-tested only. V1.md 1.5 has said so since it was written | A QStash account and a deliberately killed worker |
| **The prompt compiler on real input** | `prompt/platform/` is empty, so no snapshot has ever been compiled | The signed Ш0–Ш9 blocks |
| **Prompt caching, and therefore the cost model** | D-016's margin rests on measured *ancestor* traffic, not on this system's bill | A month of real invoices |
| **Meta's data-deletion callback** | The `signed_request` format is SEARCH-CORROBORATED, never seen from Meta. No app exists, so nothing has ever posted to it. The response shape (`{url, confirmation_code}`) is standard JSON — several widely-copied implementations emit a JavaScript object literal instead, and one asserts JSON "fails" | The first real callback, or ten minutes on Meta's own docs |
| **That an erasure request can be FULFILLED** | Meta sends an app-scoped id; every id we hold is page-scoped. Nothing bridges them. A request is recorded, not executed — see §5 | A Business Manager containing the app and the Pages, then the ID Matching API |
| **That any of it works together** | The furthest anything has run is: a signed webhook POST reaching tenant resolution and 500ing on an unreachable registry | The list in §5 |

### One thing worth saying plainly

**A single failure could still make the whole thing silent**, and the design says which:
a dead token produces no error, because no request arrives to fail. `channel_health`,
the absence watchdog and the 6-hourly probe are all designed and **none of them is
built** — they are Track 4. Until then, "Reception has stopped answering" is something
you find out from a customer.

---

## 4. Decisions waiting for you

**None that block code. Three pieces of Mongolian, all yours, all in `prompt/drafts/`:**

1. **Ш0–Ш9 wording.** Drafted with a red-pen table in its README. Until these are signed
   into `prompt/platform/` the compiler has nothing to compile, so this blocks the first
   reply rather than merely improving it.
2. **The public comment line** (`comment_public_reply.mn.txt`). Its production home is a
   per-tenant `canned_responses` row gated by `reviewed_at`, so sign-off is per tenant.
3. **The eight data-deletion status blocks** (`data_deletion_status.mn.txt`). App Review
   will visit that page, and until these are signed it returns **503** on purpose.

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
- **App Review is ONE submission, with comments bundled in** — *"one ~20-day cycle, not
  two, and the comment path now exists so it's demonstrable."* The permission set is
  therefore `pages_messaging` + `pages_manage_engagement` + `pages_read_user_content`.
  The last of those is the one nothing in `docs/` had named; see §3.
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
| 4 | **Sign Ш0–Ш9** into `prompt/platform/*.mn.txt` + `prompt/platform-mn-review.json` | The compiler has no platform block, the gate refuses, and no reply can be generated |
| 4b | **Sign the eight data-deletion status blocks** (`prompt/drafts/data_deletion_status.mn.txt`) | `/data-deletion/status` returns 503. App Review visits that URL, so this is a submission blocker rather than a polish item |
| 4c | **`DALA_PUBLIC_URL`** — the deployment's own origin, e.g. `https://dala.mn` | The deletion callback cannot build the status URL Meta requires. Never taken from the request's Host header, so it has to be configured |
| 4d | **`SUPABASE_SECRET_PRIVACY`** — one more named key, once the project exists | The deletion callback cannot record anything; every callback is a 500 and Meta retries |

### Costs money

| # | Supply | Note |
|---|---|---|
| 5 | **Supabase Pro, $25/mo** → a project → apply `0001`–`0005` via the CLI | Then run `scripts/verify/run-all.sh` **against the real project** and paste the output. A migration file in the repo is not a migration applied to a database |
| 6 | **Anthropic API key**, plus a **provider-side spend limit** | The platform's own ceiling is compiled in code; the provider limit is the backstop that does not depend on our correctness |
| 7 | **QStash**: `QSTASH_TOKEN` + both signing keys | Both, not one. Rotation is the reason there are two |
| 8 | **Vercel deployment** → `WORKER_PUBLIC_URL` | The worker needs a public URL before QStash can reach it |

### The long pole — start it first, it runs in parallel with everything above

| # | Supply | Note |
|---|---|---|
| 9 | **Meta app**, Business Verification, App Review for `pages_messaging` + `pages_manage_engagement` + `pages_read_user_content` | ~20 days, unverified. `META_APP_ID`, `META_APP_SECRETS`, `META_VERIFY_TOKENS`. Nothing inbound or outbound is real until this clears. Submit once, with comments bundled: the comment path exists and is demonstrable |
| 9b | **The rest of App Review's non-permission deliverables**: privacy policy URL, terms URL, app icon, public app name, use-case description | Each bounces a submission on its own. The Data Deletion Request callback — the one nothing had designed — is built; the other five are not code and nobody but you can supply them |

### Then per-tenant, and all of it is rows rather than code

| # | Supply |
|---|---|
| 10 | A `tenants` row for Matrix; a `tenant_channels` row for the Page; `tenant_roles` with reception; `tenant_budgets` |
| 11 | The tenant's config: `services`, `business_hours`, `contact_points`, `faqs`, `canned_responses` for all ten kinds the gate can answer with (`GATE_BY_RESPONSE_KIND`), `deterministic_replies`, `disclosure_rules`, `out_of_scope_topics` |
| 12 | Publish a config revision → `tenants.live_revision_id` |
| 13 | Seal the Page token: `printf %s "$TOKEN" \| node scripts/kek/seal.ts --tenant <id> --channel <id> --kind page_token`, then paste the SQL |
| 14 | Subscribe the app to the Page, and **verify the app-level subscription too** — a page-level subscribe returns `{"success": true}` even when the app has never enabled that field, and no events are ever delivered |
| 15 | `delivery_mode = 'shadow'` for the 14-day mirror. **Not `live`** |
| 16 | After the mirror: unsubscribe the ancestor app first, confirm from each app's own token, then `delivery_mode = 'live'` |

| 17 | **Once the Business Manager exists**, add the app and every Page to it, then say so — that is what makes the ID Matching API answerable, and it is the missing half of the erasure path |
| 18 | **Do not seed `service_aliases`, `deterministic_replies`, `out_of_scope_topics` or `faqs` with invented phrasings** (D-020). They have no provenance column, so a placeholder is indistinguishable from a tenant-confirmed row and the next analysis reads its own fixtures back. An empty matcher is honest; a matcher full of invented Mongolian is not. The `provenance` column is the fix and is **not built** |

Step 17 is not optional and it is not urgent yet. Today a data deletion request is
**recorded and alerted, not fulfilled**: Meta's callback carries an app-scoped id and every
id we hold is page-scoped, so there is nothing to join. With the app and the Pages in one
Business Manager, `GET /{asid}/ids_for_pages` bridges them and the resolver becomes an
afternoon's work. Before there is a single real customer message there is also nothing to
erase, which is why this sits after go-live rather than before it — but it must not still
be sitting here when there is.

Step 15 is the one worth not rushing. Meta delivers the identical event to every
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
