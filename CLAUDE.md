# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Dala AI** — Dalatech's multi-tenant AI staff platform for Mongolian SMBs. Businesses
hire AI staff by the role, per month. One codebase, one deployment, one Meta app, one
Supabase project, and a **configuration per tenant**.

Separate business from Core Language (`dalatech-english`) — shared lessons only, **zero
shared code, customers, or databases**. Never import from that repo.

Tenant #1 Matrix Eco Salon (hair/beauty). Tenant #2 GS Auto Center. Customer-facing text
is Mongolian Cyrillic. Keep it that way.

**Status: V1 BUILD AUTHORIZED 2026-09-01 by the founder. Product code is allowed.**
The earlier "no product code" rule is lifted and must not be reinstated by inference.
Build V1 Track 1 onward per [`docs/V1.md`](docs/V1.md).

**The Meta app EXISTS, and every earlier statement in this repo that it does not was
wrong** (corrected 2026-09-04 by the founder). The app is **`dalatech`**, it holds
**`pages_messaging` and `public_profile` at Advanced Access**, and the founder has
generated a working Page access token for Matrix and read the inbox with it.
**There are TWO Meta apps** (console, 2026-09-06): `dalatech` (`1380702870025418`) holds
Matrix's Page `1520409424715591` and the ancestor's callback; `DALA_AI`
(`1562862634970492`) holds tenant #0's Page `863503883522801` and this platform's. So
D-023's open question resolves to **a second subscription is available**.

**And on 2026-09-07 the founder measured what that produces** (D-043). Tenant #0's Page was
subscribed to **both** apps at once and one real message arrived at `DALA_AI` in
**`entry.messaging`**, not `entry.standby` — `has_messaging: true`, `has_standby: false`,
no Handover demotion, answered end to end as `webhook_events` id 8. So the "Meta delivers
to every subscribed app" fan-out is **true**; what was wrong was only its citation to
§3.10.5, a section about rate-limit backoff. **The mirror is a second subscription, not a
forwarding hop.** It does *not* follow that standby is dead: the test was on tenant #0's
Page, and a Page whose primary receiver is the Page Inbox app is a different mechanism that
still yields standby. `channel/delivery.ts` carries both halves.

**A session got this wrong on 2026-09-06 and wrote "one app" here**, having read STATUS.md's
mirror paragraph without reading its own "the second app changed the answers here" section
sixty lines above. What made it plausible was D-041: `tenant_channels.app_slug` for tenant
#0 says `dalatech` and names the wrong Meta app, so the database agreed with the mistake.
**A slug is this platform's name for a callback path, not Meta's name for an app** — read
D-041 before touching `META_APP_SECRETS`, `app_slug`, or §3.3's cross-check, which cannot
currently fail.

That correction has teeth, so read how the error happened before trusting anything similar
here. `developers.facebook.com` is blocked by this environment's egress proxy, so no
session can check the App Dashboard. Earlier sessions read "no Meta app exists" in these
docs, could not falsify it, and repeated it as established fact — until it was load-bearing
in a schedule. **An unfalsifiable claim in this repository is a claim to re-ask the founder
about, not a fact to inherit.** It is the same failure D-020 names: a source answering
plausibly instead of admitting it cannot see.

The consequence is large: **Reception's DM path needs no App Review.** It makes exactly one
Graph call, `POST /{page-id}/messages`, under a permission the app already holds at
Advanced Access. App Review is now a *comments-only* concern (D-023), and it no longer sits
on the critical path to a first real message.

**The Supabase project EXISTS as of 2026-09-05** — ref `tlggenaatnopnxzbkbuf`, PostgreSQL
17.6, ap-southeast-1. Migrations `0001`–`0015` are applied through the CLI with a real
**fifteen**-row ledger (D-012, read back 2026-09-06), and `catalog.sql` returned 25/25
against it when the file carried twenty-five checks. It carries **thirty-five** now (V0–V34):
V26 and V27 pass there since `0014` and `0015` landed, and **V25 still fails and is meant
to** (see the second bullet below). **The ledger reads twenty-three rows, `0001`–`0023`,
read back 2026-09-07 18:0x UTC** — `0023_channel_expects_traffic` was pushed by the founder
that evening, and `tenant_channels.expects_traffic_since` is present with the backfill
applied: tenant #0 carries its `went_live_at`, Matrix (which has none) carries the push
instant. The eighteen-row reading below is superseded and kept only for its lesson. That was
every migration in the repo when it was read. **`0019_staff_short_name` was pushed the same
evening and the ledger reads nineteen** — verified by the founder against the ledger, with
`staff_members.short_name` present (D-038). A session asserted "the project is one behind"
after that push; it was reading its own memory of the state rather than the ledger, which
is the mistake the paragraph below exists to forbid. Note the timing, because it matters for reading anything
above: at ~19:00 the same ledger read **fifteen**, newest `0015`, and the first successful
send at 19:12 required `reserve_spend_all`, which is `0016`. So `0016` and `0017` landed
between those two reads, on the 6th. Read the count off
`supabase_migrations.schema_migrations`, never off `ls supabase/migrations/`, and never off
a memory of when something was pushed.

**Running it there immediately found three things CI structurally could not**, which is the
argument for having bought it, and the reason to distrust "verified in CI" as a synonym for
verified:

- **0001's `alter default privileges … revoke all` is a no-op in CI and the entire defence
  in production.** A vanilla cluster has no default ACLs, so tables come out ungranted
  whether that line is right, wrong or absent. Supabase seeds defaults granting `anon` and
  `authenticated` all **eight** PG17 privileges on every future table in `public`. The line
  bites — proven by creating a table and reading its ACL — but nothing had ever tested it.
- **There are two grantors and 0001 reached only one.** `supabase_admin` owns a second
  default-ACL entry that `postgres` cannot revoke. `0013` attempts it and warns; V25
  asserts the end state so the residual is visible rather than silent. **Re-measured
  2026-09-06, after `0013` was pushed: still there** — `supabase_admin` grants `anon` and
  `authenticated` all eight privileges on every future table in `public`. It is latent, not
  live: it only matters for objects created in `public` **by** `supabase_admin`.
- **The collation differs and it is not cosmetic.** CI is `C.UTF-8`, the project is
  `en_US.UTF-8`, and the same Mongolian strings sort differently under each — which fed
  the compiled prefix and therefore the prompt-cache key. Ordering now happens in
  JavaScript by code point (D-026).

**Still not proven, and do not write as if it were:**

- **`isolation.sql` and `rls.sql` against the project.** They seed test tenants and depend
  on `begin … rollback`; the MCP transport commits, and `config_audit` is append-only so a
  seeded `tenants` row cannot be deleted. They must be run over psql. The critical claims
  were confirmed by direct probe — `anon` refused everywhere, cross-tenant isolation holds,
  TRUNCATE and INSERT refused — but the suites themselves have not been run there.
- **Behaviour downstream of the queue.** The config compile, the outbound claim and the
  spend ledger are still exercised against a stub. What is no longer unproven is
  **reachability**: CI runs a real PostgREST beside the database on `db-schemas=public`,
  and `scripts/verify/postgrest.ts` asserts every `.rpc()` and `.from()` name in `src/` is
  exposed on that profile, with one live round trip through the real client (D-037). It now
  also parses every `.select()` in `src/` and asserts each column exists there, embedded
  resources included (D-038) — so a select naming a column the database does not have fails
  CI instead of failing one tenant's publish. That closes the class D-029's third bug
  belonged to. Read D-037 and D-038 before trusting it further than that: it proves names
  and columns resolve, not that the code behind them is right.

**The send WORKS. It ran end to end on 2026-09-06 at 19:12:45 UTC** — draft → claim →
decrypt → `POST /{page-id}/messages` → mark, with a real `provider_message_id`. Every
earlier statement here that it had never sent anything is superseded. Tenant #0 is
provisioned: nine founder-approved `canned_responses`, and **republished at seq 2 on
2026-09-07 for D-058** — `content_hash f207a19c…`, 10,337 chars, `allowed_numbers []`, the
canned section now in the cached prefix rather than the volatile tail. Its prefix carries
exactly two headings, the gate preamble and «БЭЛЭН ХАРИУЛТ», and **no data marker**: canned
lines are boilerplate, not a knowledge base, so `hasTenantData` is still false and the
handoff line still comes before the provider call. Seq 1 (`8b35d072…`, 9,265 chars) is
superseded and is the prefix D-033 was measured on. The channel is
`active / live / active` with a sealed `page_token`. `tenants.status` stays `provisioning`
because `active_requires_probe_run` wants a `probe_passed_at` that only a probe run sets,
and the probe route is not built — **nothing on the reply path reads `tenants.status`**, so
it does not gate a reply.

**And the first reply it ever sent invented the business** (D-033). The customer wrote
`hi bro`; tenant #0, whose `vertical` is `software`, answered on behalf of a beauty salon
and offered price information. Nothing was wrong with the send, the guard or the ledger:
the compiled prefix is the twelve platform gate blocks and **nothing else** — 9,243 chars
of blocks plus eleven separators is 9,265 to the character — and five of those blocks are
written in salon language, while `vertical` and `display_name` are read by no code in
`src/lib/prompt/` or `src/lib/reception/`. «салон» was the only business-type noun in the
model's context. **A tenant with no rendered sections now takes the handoff line before the
provider call**; read D-033 before touching `handleReception`'s ordering or
`hasTenantData`. The gate blocks are still salon-flavoured. The mechanism to fix that is built
and deliberately inert (D-035): `0018`, the loader's most-specific-wins selection, V29, and
four unsigned drafts in `prompt/drafts/`. **Nothing is signed and nothing is published** —
the founder holds the reading evening, and `check-mn-review.mjs` is what stops anyone
skipping it.

`0015` is pushed and verified against the project: both wrappers exist in `public`,
`reserve_spend` returns boolean, `settle_spend` returns void, and the ACLs are `postgres`
and `service_role` only.

**The first real webhook arrived on 2026-09-06 and was lost, with every status code
behaving as written** — QStash refused the colon-joined `deduplicationId`, the route 500'd,
and Meta's two retries were skipped as duplicates and answered 200, which ends redelivery.
Read D-028 before touching `webhook/events.ts`, `queue/qstash.ts` or `health/stranded.ts`:
the id is hashed, a duplicate that never reached the queue is re-enqueued, and the sweeper
§3.6.3 specified is finally built.

**Then the second message found two more of the same shape** (D-029), and this is the
sentence to carry forward: **three lost messages in one night, all three from reading "a
row exists" as "the work was done."** The queue layer (a `webhook_events` row ⇒ enqueued),
the reply layer (a `messages` row ⇒ answered), and underneath both, a spend RPC that could
never have worked:

- **`db.rpc('reserve_spend')` asked PostgREST for `public.reserve_spend`; the function
  lives in `app`.** Every client in `supabase/clients.ts` is built with no `db: { schema }`
  option, so the default profile is `public`. Every reply, for every tenant, refused with
  `guard_unavailable`. `0015` adds the wrappers. **The unit tests stub `db.rpc` and answer
  `true`** — so a passing suite said nothing at all about this, and could not have.
- **A row proves itself and nothing else.** `outbound/claim.ts` now answers "has this
  customer message been answered?" with `findReplyFor`, keyed on the reply's own dedup key,
  because the evidence that a reply happened is a reply.

**And the same table's dedup key could not tell two customers apart** (D-039, found
2026-09-06 by reading the live project while designing Matrix's cutover). It was
`{page}:{index}:{body bytes}:{app}`, and the envelope is a constant — measured across every
real delivery on record, `body_bytes = 307 + utf8_length(customer text)`. So two messages of
equal byte length were one event: the second got `already_queued`, a `console.info` and a
200, and `unique (provider, dedup_key)` is global with no time component. «Сайн байна уу» is
24 bytes and so is «Хэдэн цагт вэ». At Matrix's ~60 messages/day the common lengths burn out
within hours. **This was not a mirror risk; it was why nothing could go live.** The key is
now built from Meta's own ids (`message.mid`, `value.comment_id`) in
`src/lib/webhook/identity.ts`, and `webhook_events.source` is finally written so a forwarded
delivery is distinguishable from a direct one. Read D-039 before touching either.

**`src/lib/replay.test.ts` is where that property now lives** (D-030): both entry points
run twice with the same delivery, asserting one event, one message, one reply, one send —
and since D-039 also the inverse, that two different messages are answered twice.
Its fake reads its unique constraints out of `0001` rather than carrying transcribed ones.
It is not PostgREST and cannot catch a name resolved against the wrong schema — the third
bug of that night — so do not read a green harness as covering the transport.

**Meta token decryption is no longer parked** (2026-09-04, on the founder's call: *"waiting
until a Meta app exists means writing crypto at the worst moment — when I'm trying to go
live"*). The call was righter than the reasoning given for it: the app existed already, so
the crypto was never being built early at all.

`src/lib/crypto/` and `src/lib/secrets/` are built, and `scripts/verify/secret-roundtrip.ts`
runs the whole path against a real PostgreSQL in CI: seal, store in `bytea`, read back in
PostgREST's hex form, decrypt through the runtime loader. What that does **not** prove, and
must never be written as if it did: the hop is a local socket, not PostgREST, so the
transport the runtime will actually use is still unexercised, and the KEK in CI is generated
per run and thrown away. **Half of that changed on 2026-09-06:** a real Page token has now
been sealed by `scripts/kek/seal.ts` into `tenant_secrets` for tenant #0, under KEK `v1`
from the platform environment. It has never been *opened* — `last_ok_at` is null — because
nothing has reached the send, so the read half of the round trip is still proven only over
CI's test material.

## The test every decision is measured against

> **Onboarding client #3 must be filling in a config, not writing code.**

Everything that distinguishes one customer from another is a row. If you find yourself
writing a per-tenant `if`, a per-tenant prompt string, or a per-tenant env var, the design
is wrong — make it data.

## The rules that override convenience

1. **Tenant is derived server-side**, per webhook entry, from a registry with a unique
   key. Never from a request body, a header, or an env var. **There is no
   `?? DEFAULT_TENANT`** — not even for local testing.
2. **Fail closed on money.** Identity → entitlement → budget, in order, each refusing on
   error. Helpers return **503 on any error**. Never
   `try { check() } catch { continue }` — that exact pattern was the HIGH finding next
   door. A 503 costs a retry; failing open costs money, and here it is *another tenant's*
   money.
3. **Reserve spend before the call, settle after.** A ceiling checked after the call is
   not a ceiling.
4. **RLS per tenant, verified against the catalog** — `pg_policies`,
   `pg_class.relrowsecurity`, `aclexplode(pg_class.relacl)`. Never
   `information_schema.role_table_grants` (permission-filtered, silently empty) and never
   `supabase_migrations.schema_migrations`. **A migration file in the repo is not a
   migration applied to the database.** Check each table independently — the last failure
   next door was partial, one of four. A policy on a table with RLS **off** is created,
   looks perfect, and is never evaluated.
5. **`revoke insert, update, delete` is not "cannot write."** Postgres grants **eight**
   privileges on PG17 — the eighth is `MAINTAIN`, and Supabase's bootstrap grants it to
   `anon` — and TRUNCATE bypasses RLS entirely. Enumerate the ACL; never count on a
   remembered list, which is how this said "seven" until the real project was read.
   Ownership RLS checks *who a row belongs to, never what it says*.
6. **Mongolian Cyrillic, not ASCII.** NFC-normalise at every input boundary. No `\b`, no
   `\w`, no `[a-z]`, no unanchored substring matchers over user text, no byte-length as
   character-length. `unaccent` must **not** be installed (it maps `Ё→Е` while leaving
   `Ө`, `Ү` alone — partially destructive, so it passes nine tests in ten).
7. **Secrets from the environment only.** Per-tenant Meta tokens are *data*: envelope
   encryption, KEK in the platform env, decrypt per request. **Never a module-scope
   credential cache** — warm lambdas are reused across tenants.
8. **Next.js caching trap.** A route exporting only `GET` caches every Supabase read for a
   **year**, and `export const dynamic = 'force-dynamic'` does *not* stop it. Only
   `cache: 'no-store'` does. Use the shared clients; never construct a bare one.
9. **Never mark work done without running it.** Say what you verified, what you did not,
   and why.

## Merge authority

**Open a PR for everything; merge your own once CI is fully green AND the job logs have
been read step-by-step rather than the tick trusted.** Authorised 2026-09-04 by the
founder. Reading the logs is the load-bearing half: a green tick has already hidden a
skipped test here, and a step that prints nothing on success looks identical to one that
did nothing.

**Four things still wait for the founder**, and each is a category rather than a file:

| Waits | Means |
|---|---|
| **Money movement** | Payments, billing, ceilings — anything that changes *what can be spent*. **Not** a code path that will eventually call a model under an existing ceiling. Settled 2026-09-04 after PR #9 tested the boundary |
| **Credentials** | Provisioning, rotating or handling real secret material |
| **Destructive migrations** | Anything that drops, rewrites or narrows existing data |
| **Any customer-visible Mongolian string** | The words a customer reads. Matcher stems and test fixtures are not this; a sentence the bot sends is |

The last one has a mechanism rather than a convention: platform Mongolian lives in
`prompt/platform/*.mn.txt`, signed by **file hash** in `prompt/platform-mn-review.json`,
and `scripts/guards/check-mn-review.mjs` fails the build when a block is unsigned or has
changed since sign-off. Unsigned drafts live in `prompt/drafts/` and are loaded by
nothing.

`docs/schema.md` has one too. `scripts/guards/check-schema-doc.mjs` fails the build when a
migration exists that the document does not name — it was five behind when the guard was
written, including `0011`, which adds a NOT NULL column with no default to five tables, so
following the document produced INSERTs the database refuses.

**The Vercel production build runs `scripts/preflight.ts` before `next build`**
(`vercel.json`). A missing or malformed variable fails the deploy instead of shipping a
deployment that 500s at the first customer message, and preflight never prints a value, so
the build log stays safe to paste. It is gated on `VERCEL_ENV = production`: preview
deployments are protected and serve nobody, and failing every PR build on Preview-scoped
variables that were never set would train the eye to ignore a red build. CI is untouched —
the workflow calls `npx next build` directly rather than through the package script.

**A check that gates has to be right, and this one was not.** When it was wired into the
build it still demanded that `WORKER_PUBLIC_URL` *contain* `/api/workers/reception`, while
`queue/qstash.ts` appends that path itself. So the correct value — an origin — was reported
BAD, and any value that satisfied the rule made QStash post to
`…/api/workers/reception/api/workers/reception`: a 404 on every job, with the enqueue
returning success and nothing to see. `preflight.test.ts` asserted the same wrong contract,
so the suite was green on both halves. Both are fixed. The lesson is the one this repository
keeps relearning: a rule and the code it describes have to be read *together*, because each
one alone reads as correct.

**A parser that returns what it found rather than refusing is the same failure one layer
in** (2026-09-07, D-057). `query-columns.ts` bounded a call chain at the first `;` — and a
semicolon inside a *comment* (`"…bill to themselves; quality is…"`) cut the window through
the middle of `spend_ledger`'s insert. `parseObjectKeys` then returned the two keys it had
found instead of `null`, so the site reported as **checked** with thirteen of its fifteen
columns never examined, and a mutation renaming `cost_nanousd` passed both column checks.
Nothing was red; the number in the summary line went *up*.

That is the shape of an assertion that cannot fail, arriving from inside the tool that was
supposed to catch them: **when a parser cannot complete, it must say so, not answer with the
part it managed.** Undetermined is a result. The same read also swallowed keys after any
`//` inside a string — `'https://graph.facebook.com'` — for the same reason. Both checks now
share one walker (`scripts/verify/querysites.ts`); if you touch it, keep the rule that a
truncated object returns `null`.

**A guard whose trigger is "this collection is empty" dies the day anything unconditionally
adds to that collection** (2026-09-07, founder, after D-058's addendum). `hasTenantData` was
true exactly when `renderTenantSections` returned `[]`; moving the canned lines into the
prefix gave every tenant a section, and the guard against a bot inventing a business type
became unreachable — for every tenant, not just the one being changed. Nothing failed. The
guard still ran, still looked right, and could no longer fire.

Note the shape, because it is what makes it invisible: **the fix and the failure are in
unrelated subjects.** The change was about prompt caching. The thing it broke was the
mitigation for the worst thing this platform has done. No test connected them, because no
test described a tenant with canned lines and nothing else — which is every tenant on day
one. `src/lib/prompt/tenantKb.fixtures.ts` names that state now (`DAY_ONE_KB`); assert
against it rather than against a bare KB, which is a state no tenant that can reply is in.

The audit that followed found **one other live instance and one already lived through**.
Live: `reception/load.ts` refuses a tenant with no `canned_responses` rows as
`not_provisioned` — a platform-default canned set, exactly the sort of thing "client #3 fills
in a config" invites, would silently retire it. That guard and `hasTenantData` now key on the
same table in opposite directions (no rows means not ready; rows alone do not mean ready), so
do not "harmonise" them. Already lived through: `allowed_numbers` was `[]` for every tenant,
and "a bot with no approved prices cannot emit a price" was true only because it could emit
no numeral at all — Stage 4's knowledge base ended that, and the guarantee had to be re-founded
on the digits-only reduction. **The guard did not break; the reason it was true did, and
nothing pointed at the reason.** Everything else keyed on emptiness in `src/` is either input
validation or fails closed.

**Anything run by hand needs `npm install` first, and a missing package fails before
anything real does** (2026-09-07, founder). `scripts/publish/tenant.ts` died on a
module-not-found before it reached a single line of its own logic, which reads as "the
command is broken" rather than "the tree has no dependencies". Every script here imports from
`src/`, so `node scripts/…` on a fresh checkout fails the same way regardless of what the
script does. Install first; the failure you then see is the real one.

**A hash agreement that depends on two languages' whitespace definitions matching is a coin
flip nobody documented** (2026-09-07). The D-058 republish rebuilt the canned section in SQL
with `btrim()`, which strips only U+0020; `cannedSectionBody` trims with JavaScript's
`.trim()`, which strips every Unicode whitespace character. A canned body with a trailing tab
would have hashed one way at publish and the other at request, and **every reply would have
503'd with `canned_stale`** — a total outage produced by a guard working exactly as designed,
on a difference nobody would go looking for. Measured clean for the current rows, so it was
luck rather than construction. The general answer is `scripts/publish/tenant.ts`: publish
through the same code the request path reads, so there is no second trim to agree with.

**That route is now the only one**, and the SQL one is retired. The founder ran the command's
dry run against Matrix on 2026-09-07 and it reported the compiled prefix byte-identical to the
live snapshot — `content_hash 52426e45…`, `canned_hash eb27de84…`, 19 sections, 13,745 chars,
`allowed_numbers` unchanged — so the real compiler and the hand-written republish agree
exactly. Note when that agreement was established: **after the fact, not at the time.** The
SQL publish went out on internal checks alone and was confirmed only when a compiler run
became possible. It happened to be right. **A publish that does not go through
`compileAndPublish` is not trusted until something independent reproduces its `content_hash`,
and that check belongs before the write, not after it.**

**A column added in an unpushed migration is red in production and green in CI, every
time** (2026-09-07, D-058). The reply path gained `.select('… canned_hash')`; the migration
adding that column had not been pushed. CI applies every migration in `supabase/migrations/`
before it runs, so the column is always present there — the whole suite, the transport check
included, was structurally incapable of seeing it. Against the project PostgREST answers the
select with a 400 and `loadLiveSnapshot` refuses, so **every reply for every tenant would
have 503'd** from the deploy until the push.

This is not D-029's third bug (a name resolved against the wrong schema, which CI can and
now does catch). It is the asymmetry underneath rule 4 stated forwards: a migration file in
the repo is not a migration applied to the database, and CI is built out of the repo. So
**before merging anything that reads or writes a column a pending migration adds, read the
ledger** — `supabase_migrations.schema_migrations` — and merge only after the push. Green
CI is evidence about the repo, not about the project.

**A row in an append-only table, read as a live signal, never ages out** (2026-09-14,
D-062). D-061 taught the watchdog to read an `unrouted` delivery naming a Page as proof Meta
is delivering. It did not ask *when*. Matrix's two unattributed deliveries are stamped 01:12
UTC on 2026-09-07 and its `expects_traffic_since` is 18:02 the same day, so for eleven days
the alert read a row from **before the window opened** as present-tense evidence and sent the
reader to the wrong screen — and, because `webhook_events` is append-only, it would have read
the same on day fifty. Evidence about a window has to fall inside that window; the bound is
now the verdict's own `since` rather than a lookback constant of its own. Note that this is
the third turn of one screw: D-060 split a verdict covering two states, D-061 made a
disproving row visible, and each fix left a new pair collapsed one branch over. When you
split a verdict, ask what the new branch is now collapsing.

**Both channels went silent in the same hour, which is one cause and not two** (2026-09-14,
D-062). Every delivery this platform has ever received — seven rows — verified against the
same entry in `META_APP_SECRETS`, so both Pages were arriving through one Meta app; they
stopped forty-one minutes apart and nothing has arrived since. One app, two Pages, one
instant. Read `matchedAppSlug` as what it is: the slug whose **secret verified the HMAC**,
not the slug in the URL. It is the only field in the table that says which Meta app a
delivery came from, and it is what turns "two dead channels" into one question.

**Nothing in this platform reads the far side of a Meta subscription, and an absence has no
log line anywhere** (2026-09-14, D-062). §3.10.5 step 2 —
`GET /{app-id}/subscriptions` — was designed against exactly this failure and never built,
so for eleven days no instrument could say whether the app-level subscription still existed.
`POST /{page-id}/subscribed_apps` returns `{"success": true}` when the app has never enabled
the field on the object, and the page-level read then agrees with the tenant config and
reports healthy. `scripts/diagnose/meta-subscription.ts` is the read; it is GET-only,
deliberately, because the two Graph writes nearby are both **replacements presented as
additions** (D-043) and either one produces this outage. Run it before concluding anything
about a silent channel, and read its closing paragraph: it covers the app-level half only,
and a Page grant revoked behind a healthy app-level field looks identical from here.

**A period in a dedup key is right for a ceiling and wrong for a condition** (2026-09-14,
D-063). `channel_silence:{channel}:{state}:{localDate}` was copied from `spendDedupKey`,
where a period genuinely belongs — a ceiling reached again tomorrow is a new ceiling. A dead
channel is not a new dead channel every morning. Measured: eleven rows in `alerts`, ten of
them one condition, critical, once a day for six days. The date had even been *corrected*
once, from UTC to the tenant's clock, which was right about the boundary and wrong about
there being a boundary — the key was tuned twice without anybody asking which kind of fact it
described. **Ask whether the thing recurs or persists before you put a period in a key.**

`route` and `repeat_policy` are the split now (`0025`). The distinction that makes the rest
work: an `on_change` row is an **episode** (it opens, holds, resolves — `resolved_at` is what
"open" means); a `once` or `daily` row is an **event** that happened and is over, whose
`resolved_at` stays null for ever. The digest and the three-day escalation both filter on
`repeat_policy`, not merely on `resolved_at is null` — without that, "open" means every alert
ever raised and the digest grows without bound, which is the daily repeat wearing the fix's
clothes.

**A quiet alarm and a dead alarm must not look the same, including the one you just built to
be quiet** (2026-09-14, D-063). The digest sends on a clean day too, and its clean line
carries when the silence watchdog last ran — read from `channel_health.observed_at`, which is
upserted on every run including healthy ones precisely so its absence is a statement. Silence
meaning both "nothing is wrong" and "the job stopped" is D-060 and D-062 rebuilt one layer up,
inside the safety net. One line a day is not what trained anybody to ignore Telegram; six
criticals about one unchanged condition were.

**Telegram is shared with the customers.** `dalatech-online`'s `api/demo-request.js` posts
demo requests into the same chat — outside this repository, nothing here routes it. So a
noisy health alarm is not merely ignorable, it is burying the only messages with a person on
the other end. Weigh a new `route: 'now'` alert against that.

**A backfill default decides which rows the new rule can ever reach** (2026-09-14, D-063
addendum). Matrix's channel recovered at 06:00:04 UTC on the 14th — `channel_health` reads
`healthy` after eleven days dead — and Telegram said nothing, because the ten rows recording
that outage predate `0025` and its default stamped them `repeat_policy = 'daily'`. Under the
split that makes them events, `resolveOpenAlerts` only closes `on_change` episodes, so there
was no episode to close for the one condition the split was built around. Going forward the
mechanism works; the gap is historical. **A migration adding a discriminator column with a
default is retroactively deciding the semantics of every row already there — and those rows
are exactly the ones that motivated the change.** The rows were NOT retyped to manufacture
the missing notice: that is a write to `alerts`, and retyping all ten would have sent ten
recovery messages. It was reported by hand instead.

**And the first digest could not fire**: the route reached `main` at 06:18 UTC and the QStash
schedule is 01:00 UTC, so at its first appointment it did not exist. It is deployed now (an
unsigned GET returns 405 with `x-matched-path: /api/workers/digest`); the first firing that
can work is 2026-09-15 01:00 UTC. The QStash console is not readable from here, so if 09:00
Ulaanbaatar passes with no digest, check the schedule rather than the code.

**The first `on_change` episode fired at 08:00:08 UTC on 2026-09-14 and was exactly right in
mechanism and wrong in inference** (D-063 addendum). The row carries `repeat_policy
= 'on_change'`, `resolved_at` null, a dedup key with NO date, and `notified_at` — the whole
chain. But the condition was an ordinary quiet afternoon. **The ancestor is a control this
platform did not have to build**: it serves the same Page through a different Meta app, and
its Vercel logs show our traffic tracking it in BOTH directions — we received in the window it
received in, and neither of us since. So Matrix's live customers are not unanswered by its
production bot; it is getting what we are, which is nothing.

What that falsifies is the threshold's own justification.
`DEFAULT_THRESHOLD_OPEN_MINUTES = 180` argues from D-016's 60.5 replies/day that three open
hours should carry ~18 replies. Measured from the ancestor's worker invocations — one per
message — the last three rolling days are **37, 30, 9**. At 0.9–3.7/hour a three-hour run of
zero is an ordinary gap, so the daily noise D-063 removed from the KEY can walk back in
through the THRESHOLD. Not changed: it is the sensitivity of the instrument that caught an
eleven-day outage, and loosening it lengthens time-to-detect on the next one. **Re-derive
D-016's 60.5 before anybody picks a new number** — it is the premise every version of this
alert rests on, and the Page is not delivering at that rate.

**A column that is read and never written is worse than one that is absent** (2026-09-14,
D-064). `sweepStrandedEvents` filters `.is('replied_at', null)` and nothing had ever written
`replied_at`, so the filter could not exclude a single row — it was harmless purely because
the `state` filter beside it carried the whole load, and it would have become load-bearing
the moment somebody widened that list trusting it. An absent column fails loudly at the
first read; a dead one reads as a safety check for as long as nobody tests it. Three more
were in the same state: `messages.answered_by`, `revision_id` and `prompt_hash`, with a
literal `void answeredBy;` in `reception/deps.ts` discarding the value one line after it
crossed the seam. **When you find a column, ask who writes it before you trust what it
means.**

The cost was not theoretical: Matrix's mirror had started drafting against real customers
days before a republish, and without `revision_id` two drafts either side of a config change
are indistinguishable — so the fourteen days could not have answered *did that edit help*,
which is the whole point of running them. A trace column is worth nothing the day it is
added and everything the day the config moves.

`answered_by` now carries **three** values and not two. `0001`'s CHECK has allowed
`model | deterministic | canned | human` all along, and a `deterministic_replies` hit was
being recorded as `canned`. Different tables, different review gates, and the deterministic
path spends nothing at all — so a single value for both cannot answer the first question
anybody asks of the corpus.

**An instruction to the model is a request until something checks it** (2026-09-14, D-065).
Four gate blocks say «нэг ч үсэг өөрчлөхгүйгээр» — copy this line without changing a single
letter — and nothing had ever asked whether the model did. Matrix's third mirror draft
dropped «би» from the handoff line. The draft nine minutes earlier is byte-exact and is NOT
a counter-example: its `quality_flags` row shows the outbound guard refused the model's text
and `handoff()` served the row, so the platform typed that one. **On the only occasion the
model typed a pinned line itself, it got it wrong** — and note how that correction arrived,
from a flag nobody had read yet rather than from the reasoning. **A near-copy is an
unreviewed sentence carrying an approved one's meaning**, and `reviewed_at` cannot see it,
because the gate is on the row and not on what comes back.

`src/lib/gate/pinned.ts` closes it, and the way it closes it is the part to keep: it does not
EDIT the reply — that is still forbidden — it discards the model's text whole and serves the
row's own bytes, exactly as the two short-circuits already do. The model keeps the job it is
good at, choosing which line applies, and loses the one it was measurably unreliable at.
A paraphrase is counted as well as corrected (`quality_flags` code `canned_paraphrased`),
because a drift quietly fixed is a drift nobody knows is happening. **Only reviewed rows are
pinned lines** — measuring against an unreviewed row and then serving it would defeat the
review gate with the mechanism built to enforce it. And the safety lives in the LENGTH GUARD,
not the similarity threshold: replacing a real answer with a refusal is worse than the drift.

**`quality_flags` says what the model wrote; the draft says what the platform served**
(2026-09-14, corrected twice in one day). Both corrections were the same mistake: reading the
served draft as evidence about the model. The price question that got the generic handoff was
attributed to Ш2/Ш8 being unordered — but its `quality_flags` row shows the model never
reached for a price line at all. It wrote D-066's gate-label leak ending in
`refusal_public_channel`, the guard refused it, and `handle.ts:436` serves `handoff()`
**regardless of what the customer asked**. Ш2/Ш8 explains the NEXT turn, not that one. Two
turns, two causes, one conversation. Read the flag before explaining the draft.

That unconditional fallback is itself an open question for the founder rather than a defect
with an obvious repair: a price question refused by the guard could fall back to
`refusal_price_unlisted` using the gate layer's own classification, but picking a specific
refusal for a question that was not about price is worse than the generic one.

**Ш2 and Ш8 both cover "a price I do not have", and nothing orders them** (2026-09-14,
D-065). Ш1 says in as many words that it dominates Ш2; no block says Ш2 dominates Ш8, so the
model picks — and on Matrix it picks wrong reliably rather than occasionally, because
`services` has **no price column at all** and no «ҮНИЙН ЖАГСААЛТ» section is rendered. Ш2's
branches read as conditions on a list that is not there; Ш8 visibly applies. The customer
loses the more useful sentence. The fix is a signed gate block and belongs to the reading
evening: `prompt/drafts/sh2_price_precedence.mn.txt` is the unsigned revision.

**The model narrated its own gate to a customer, and the check that caught it was luck**
(2026-09-14, D-066). Matrix's second mirror turn opened with «Ш0 (сувагтай холбоотой
шалгалт): …» — this platform's label for a block of its own system prompt, addressed to a
salon customer, followed by the internal identifier `facebook_page` and a refusal meant for
public comment threads applied to a DM.

`disclosesPrompt` could not see it: it matches a contiguous 60-character run of the prompt,
and this is a paraphrase. **That is D-065's shape one file over, twice in one day** — an
exact-match check defeated by a near-copy. What refused the reply was the NUMERAL guard
objecting to the `0` in «Ш0», and read back from the live snapshot that luck is thin:
Matrix's allow-list is twelve tokens and `1` and `3` are two of them, so «Ш1 …» (forbidden
topics) and «Ш3 …» (booking) carry digits the guard is required to permit and would have
reached a customer.

Guard item **0** now matches the SHAPE rather than the content, because the content is
paraphrasable and the label is not. It runs before every other check, which re-attributes
exactly the case that was filed wrong — the real instance is recorded as `outbound_price`,
sending a reader to the allow-list for a leak that has nothing to do with numerals. **When
an exact-match check keeps being evaded, stop widening the corpus and find the shape.**

Its first form required the label's punctuation, which the real leak happened to have, and
missed the same disclosure written as prose («Ш1 дүрмээр…»). `\b` is the reflex repair and
rule 6 forbids it — it is defined against ASCII `\w`, so it reports a boundary between `1`
and Cyrillic `д`, and the matcher would behave differently in Mongolian than in English on
the one platform where everything is Mongolian. The bound is explicit instead:
`(?<![\p{L}\p{N}])Ш\d{1,2}(?![\p{L}\p{N}])`.

**`outboundGuard` is called from `reception/handle.ts` and nowhere else, and on the comment
surface that is correct rather than a hole** — `worker/comments.ts` never generates text, it
posts the bytes of one reviewed `canned_responses` row and refuses when there is none, so
there is no model output there to guard. It stops being correct the day anything generates a
comment reply, where a leak would land on the salon's public wall.

**A customer writing Mongolian in LATIN letters fires no gate at all** (2026-09-14, D-067).
Two of the mirror's first three real messages were Latin script. `fold()` is
`nfc(s).toLocaleLowerCase('mn-MN')` and nothing transliterates, so a Cyrillic stem cannot
match Latin text — proven by execution: `containsStem('huuhdiin us zasuulna', 'хүүхд')` is
**false** while the Cyrillic form is true. Both `matchRules` and `matchDeterministic` go
through it, so for such a message no disclosure rule and no out-of-scope topic fires,
`refusedTopicBlocksPrice` is false, and the model answers unrefused. **The children's-services
rule the founder approved by hand does not fire for «huuhdiin».** The outbound guard is
unaffected — its numeral, URL, phrasing, script-share and gate-label checks are properties of
the reply — so a price still cannot be invented; what is lost is the topic layer above them.

**The fix is ROWS, not code**, and the ancestor is what showed it: `Matrix-Chatbot`'s one
customer-text matcher reads `/^(сайн|байна|уу|hi|hello|hey)/i` — it LISTS the Latin forms
rather than transliterating. `containsStem` is already script-agnostic (a Unicode token-prefix
match), so a tenant storing `huuhd` beside `хүүхд` is covered today with no code change:
`containsStem('huuhdiin us zasuulna','huuhd')` is true, `'manai huuhduud'` matches by prefix,
mixed script does not, and the token rule still holds. No transliteration engine to design, no
romanisation standard to adopt — "client #3 fills in a config, not writes code" applying as
intended. What is left for the founder is a DATA question: which Latin spellings Matrix's
customers actually use, answerable from the corpus. Stems are not customer-visible strings, so
they are not gated on the reading evening.

**And note the error that first framing was**: a claim about what a fix would require, made
without checking whether the existing mechanism already did it. Reading `fold()` proved Latin
text matches no CYRILLIC stem — true — and that went straight to "therefore transliteration",
never asking whether a LATIN stem works. One line to test, tested only after the ancestor
suggested it.

**Then the corpus qualified it the same day**: a customer opened with **«Sn bnu?»** —
«Сайн байна уу?» compressed to initials. For CONTENT stems the row answer holds (`huuhd`
catches `huuhdiin`, `huuhduud`, by token prefix, because the word is typed out) and that is
the children's-rule safety case. For GREETINGS it is weaker: listing `sain baina uu` does not
catch `sn bnu`, and the abbreviation space is not enumerable. Transliteration would not catch
it either — there are no vowels to transliterate. It means a deterministic greeting rule needs
a different matcher from a topic stem, and only the corpus says which abbreviations occur.

**The widened gate-label matcher caught a real leak five hours after it merged** (2026-09-14
08:50:20, D-066 addendum). Production, live customer turn, attempted reply
«Ш0-г шалгахад энэ нь нийтэд харагдах сувагт (facebook_page) бичсэн мессеж тул…». #85 shipped
in two commits: the first anchored on the label's punctuation, the second widened the bound to
a Unicode token after an adversarial re-read. Against the real text the shipped matcher
returns `"Ш0"` and **the first version returns `null`** — «Ш0-г» carries the Mongolian
accusative suffix, so what follows the digit is a hyphen, not `.:)(`. The same agglutination
that makes `\b` wrong here is what defeated the narrow form. **An adversarial re-read of your
own check before merging is not ceremony.** And the leak is now twice in the corpus's first
thirteen turns — a rate, not an anecdote.

**`refusal_public_channel` on a DM is measured too**: three of ten drafts, and one was served
to a customer who had written «Эмэгтэй сортой будаг хийлгэх гэсийн» in a private DM and was
told to write a private message. The guard cannot fix that — it cannot know which canned line
fits. Ш0's wording can, and it is signed platform Mongolian for the reading evening.

**The disclosure guard refuses a reply for quoting an approved line** (2026-09-14 14:23:43,
D-068). A customer wrote «tsag avii» — *let me book* — and the model answered well: it
declined what it cannot do, said why, and handed over the booking URL, its second sentence
the reviewed `booking_line` reproduced correctly. `outbound_disclosure` refused it and the
customer got the generic handoff.

Exactly one run of that reply is in the prefix and not exempt:
`" та манай вэбсайтаар (https://www.matrixecosalon.org/) онлай"` — **and the leading space is
the whole bug.** `shingles()` trims, so shingling a canned body in isolation never produces a
run beginning one character before it; the compiled prefix holds that line IN CONTEXT, with a
preceding character that folds to a space. Any window straddling the line's opening boundary
is therefore in the corpus and absent from the exemption. Generally: **quoting an approved
line inside a longer sentence trips the guard, and only a reply that is exactly a canned line
alone is reliably safe** — which is the opposite of what the guard is for, and it lands
hardest on booking, the intent D-042 already shows this platform delivers worst.

It is `disclosesPrompt`'s own stated principle applied to one side only: it shingles the
canned lines rather than deleting them from the CORPUS, precisely because deleting splices
unrelated text and manufactures runs — and the same boundary problem on the REPLY side was
not addressed. The fix is to mask the canned occurrences in the folded reply, cut it into the
segments between them, and shingle each segment independently. **Not built: it loosens a
disclosure guard on the surface facing Matrix's live customers.**

And note how it was found. The draft is the handoff line with `answered_by = 'canned'`, which
read alone looks like D-067 — a Latin message firing no gate. `quality_flags` says the model
answered well and the guard refused it. Third time in two days: **read the flag before
explaining the draft.**

**Matrix has no address, and «Хаяг» was the first word a real customer typed** (2026-09-14,
D-069). `contact_points` holds one row — `phone 7741-7777` — and the published prefix has
«Яармаг» (a branch name) and no street, district or unit number. The model correctly declined
to invent one, then LABELLED what it gave: «Хаяг, холбоо барих:» and «📍 Байршил, холбогдох
утас: 7741-7777». **A label that promises an address and delivers a phone is worse than
declining.** The fix is a row and the value is the founder's, like the booking URL.

**The model wrote the same greeting two ways in one day** — «салон**д** тавтай морил» at
03:57 and «салон **руу** тавтай морил» at 09:29. *Welcome to X* takes the dative; «руу» is
directional. Both were `answered_by = 'model'` on the same revision and `prompt_hash`, so it
is the model's own variance, not a config change — and at most one can be right. That is the
argument for pinning answers that recur. Other language observations (the familiar imperative
«тавтай морил» beside the honorific «Танд»; «манай яг байршил»; emoji in five drafts and in no
approved line) are in D-069, ranked by confidence and put to the founder rather than asserted:
**the founder is the native speaker and these are his call.**

And the one a customer would notice: at 08:45:02 the bot pointed a customer at the salon's
details; twelve seconds later, same conversation, it opened «Уучлаарай, манай яг байршил зэрэг
дэлгэрэнгүй мэдээллийг би энэ хэлбэрээр өгч чадахгүй байна». Neither sentence is
ungrammatical; together they read as a bot that does not know its own mind.

**A mechanism whose correct behaviour and its worst behaviour look identical from outside
is not yet a mechanism** (2026-09-15, D-070). Matrix received fourteen deliveries on the
14th and the corpus held eleven. Three were attachments with no text; `meta/extract.ts`
skipped them and its own docstring said everything skipped was "*reported*". The report was
one `console.info` — no `quality_flags` row, no `messages` row, nothing in the digest. So
**21% of what real customers sent was invisible to the fourteen-day mirror whose entire
purpose is to measure what real customers send.**

All three were `sticker_id` 369239263222822, the same thumbs-up, and dropping a thumbs-up is
right. That is the argument rather than the refutation: a photograph of the colour a customer
wants — the most valuable message a salon receives — would have been dropped identically, and
nothing anywhere separated the two. `inbound/dropped.ts` writes the row now, keyed
idempotently on `(event_id, idx)` because a unique constraint is a migration, and the digest
carries one clause a day including `No inbound events dropped`. An unreadable count prints
UNREADABLE, never zero.

**And Meta sends one sticker as TWO attachments, the first declared `image`** — same
`sticker_id` in both payloads. Counting the array says two things arrived; reading `type`
says one was a photograph. Both are wrong and the second is the one that costs: it is the
reading that turned three thumbs-ups into three lost sales enquiries in a morning report
before the payload was read. **The type field was read and the payload was not** — `read the
flag before explaining the draft`, in a third table. Key on `payload.sticker_id`.

**Two guards now, both punishing a reply for using the tenant's own approved data**
(2026-09-15, D-068 addendum and D-071). `disclosesPrompt` threw away a correct booking answer
for quoting the reviewed `booking_line` inside a longer sentence — the corpus holds that line
IN CONTEXT and `shingles()` trims, so every window straddling its opening boundary was in the
corpus and absent from the exemption. The reply is cut at its canned occurrences now and each
segment shingled **on its own, never joined**, which is the rule the corpus side always had.
Indexing is by CODE POINT: `String.indexOf` and `shingles` agree until an emoji appears, and
emoji were in five of the first ten drafts. It gives away one thing, said plainly — a
disclosure must now be 60 characters within one segment.

`urlsNotAllowed` was the same failure in a different table: `allowedUrls` came from
`tenant_booking.booking_url` alone, so Matrix's location — a kind `contact_points` has
permitted since `0001` — could be compiled into the prefix, quoted correctly, and refused.
**When you find one guard rejecting approved data, look for the others before fixing that
one.**

**The prefix renders a Mongolian heading over English column keys, and the model translates
them itself** (2026-09-15, D-071). `- phone: 7741-7777` is why «Хаяг» appeared over a
telephone number: the one thing the model could not do was reuse the platform's own word for
the thing, so it picked the customer's. `CONTACT_KIND_LABELS` binds «Хаяг» to the `address`
kind and nothing else, so a tenant with no address row cannot have the word in its prefix at
all — a structure rather than an instruction, which is D-065 one layer up. The wording waits
for the founder and waiting is free: `SUPABASE_SECRET_PUBLISH` is absent here, so no session
can publish it by accident. **Deploy the code before the republish** — the other order hands
the model a URL the live guard still refuses.

**The unit of cost is the CONVERSATION, not the reply** (2026-09-15, D-072). Measured from
`spend_ledger`: a cache-miss reply is **$0.0406** and a cache-hit reply **$0.0035**, 11.5×,
and misses were **86.7%** of a day's money. The 9,738-token prefix at `1h` costs $0.038952 to
re-warm — 96% of a cold reply before a word is generated — and cold starts track conversations
because conversations arrive hours apart while a conversation's own turns arrive seconds
apart. Five conversations, four cold starts.

So ₮250,000 ≈ $71.43 covers 400 conversations at **67–75%** margin on every plausible
turns-per-conversation (**68.6–59.2%** against the full-team bundle FLOOR, which is the base
D-004 requires a ceiling to be sized from). `RECEPTION_REPLY_ESTIMATE` was $0.012 against a
$0.0406 cold reply, 3.4× light, and is **$0.041 since 2026-09-15** on the founder's
authority. Two consequences for anyone reading D-016: **its per-reply blended figure has no
cold-start term**, and `docs/prefix-trim.md` is a margin lever again rather than only a
scaling one — 13,745 characters compile to 9,738 tokens, **1.41 chars/token against ~4 for
English**, so Mongolian pays about 2.8× per character to cache.

**D-072's own two errors, both found a day later while executing it** (D-072 addendum), and
both worth carrying because neither was a slip:

**`monthly_ceiling_nanousd` is read by NOTHING**, so D-072's "two of three volumes breach it
into `on_exhausted = 'canned_reply'`" describes a mechanism that does not exist —
`on_exhausted` has no reader either, and D-051 already said *"No month is wired."* What
binds is the DAILY cap, and it is **compiled, not configured**: `effectiveDailyCeiling` takes
the lower of `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY` (**$1.50**) and the tenant row's
daily × surface fraction ($1.90 for Matrix), so a `tenant_budgets` row does not currently
move Matrix's live ceiling at all. **That is D-064 from the other end** — its rule is "ask
who WRITES a column", and this asked who writes and never who reads. Ask both. And
`config/platform.ts:33` says the monthly ceiling "is the real control", which is a comment
asserting a control that was never built, the same shape as `meta/extract.ts`'s "everything
skipped is reported" one file-tree over. The real exposure is a **burst day**: $1.50 affords
about 37 cold conversations, and D-016 measured 28–94 replies/day.

**₮80,000 is not a price and D-004 never disagreed with ₮250,000.** ₮250,000 IS Reception's
list price; ₮80,000 is the allowable model SPEND at 60% margin computed from the discounted
full-team floor (₮200,000), which D-004 requires in bold: *"every ceiling must be computed
from the discounted price, not the list price."* So there was nothing to reconcile — the
claim that there was came from misreading a spend ceiling as a price. What IS open: the
ceiling was set to **$28.57**, which is 60% of LIST, where D-004's floor rule gives $22.86.
A bundled Reception at a $28.57 ceiling runs at 50% margin. The founder set it knowing the
list figure; the departure from the floor rule is flagged, not resolved.

**A URL slug became an approved price, and its twin bug hid it** (2026-09-15, D-074).
Matrix's Maps link `…/fHaBVwc9mFZJxYAJ9` contains a `9`; `allowedNumbersFrom` read numerals
out of the whole rendered section, links included, so `allowed_numbers` went from twelve
tokens to thirteen and the model gained permission to say `9`. A reply quoting that link
carries the same `9` — and passed check 2 **only because the allow-list had been widened by
the very same slug**. Two defects exactly cancelling, which is the part to carry: **a bug
that only manifests when its twin is fixed is invisible to any test of either.** Fixing the
allow-list alone would have started refusing replies that quote the salon's own location —
D-068's shape a third time.

Check **2b** had no twin to save it: it is handed an EMPTY allow-list on a refused topic, so
quoting the location on a children's-services question was refused as
`outbound_refused_topic_price` from the moment the link entered the prefix — and filed under
price, sending a reader to the allow-list for a defect about neither.

The rule now: **a URL is validated as a URL and its characters are never content.**
`maskUrls` is applied in the compiler's `allowedNumbersFrom`, in the guard's reply check
(covering 2 and 2b) and in the customer-echo set. Masking to a SPACE, never to nothing:
splicing the sides together manufactures a numeral nobody wrote — `disclosesPrompt`'s own
lesson, third file. The digits-only reduction is untouched; this removes a numeral that was
never a tenant fact.

**`scripts/publish/tenant.ts` runs on the operator's machine and renders with THEIR
checkout.** The instruction "deploy, then republish" is right about the runtime guard and
silently wrong about the compiler: Matrix's seq 4 carries the Maps link and not the Mongolian
labels, because the publish ran against pre-merge local code. **Deploy, `git pull`, publish
— three steps.**

**Prices never enter `allowed_numbers` and never enter the prefix** (2026-09-15, D-075,
founder's call). `allowed_numbers` is a SET, so the guard checks that a numeral is on the
tenant's list and never that it belongs to the service being discussed: «Омбре 33,000₮» — a
500,000–640,000 service at a haircut's price — passes every check, and a real price against
the wrong service is more plausible than an invented one. The model recognises WHICH service;
the platform serves the price from the row, as `gate/pinned.ts` serves a reviewed row's bytes.
`0001` said this above `service_variants` all along — *a price that is not in the prompt
cannot be quoted, which is stronger than any rule forbidding it* — and it was never built.

`src/lib/services/match.ts` is step 1, and `service_aliases` finally has a reader after
existing since `0001` with zero rows. The rule is **every token must occur, most specific
wins**: matching on ANY token leaves «Сор» and «Оффис колор /Сор/» permanently
indistinguishable, since the first name's only token is a subset of the second's. Ambiguity
is a VERDICT, never a tie broken silently.

What it measured, and the answers are not symmetrical. **«Сор» cannot be separated in the
direction that matters** — the rule only ever fires on «оффис», which was never the
ambiguous case, and the corpus's one instance («Эмэгтэй сортой будаг хийлгэх гэсийн») is
unresolvable between prices 3.2× apart. **The repair is a rename by the salon, not a row.**
**The three CICA names DO separate at two tokens or more**, and bare «cica» safely reaches
none. **A one-token match on a short stem is not evidence**: «сорри» — a customer
apologising — reaches «Сор», so a specificity floor belongs above the matcher, which
reports the token count for that purpose. `subsetCollisions` then found a third pair nobody
had asked about, «Тэжээл» ⊂ «CMC тэжээл», 44,000–88,000 against 132,000.

**The `services` rows and the confirmed price list disagree about the names**, which is why
the alias seed is held rather than applied: an alias points at a `service_id`, and four of
the eight rows are renamed or absent on the list — «Эмчилгээний хими» is nearest to the name
the salon said does not exist. Settle the names before seeding rows that point at them.

**A photograph got silence while the ancestor answered it** (2026-09-16, D-076). D-070
predicted the case; between 2026-09-15 and 2026-09-16 it happened FOUR times —
`inbound_dropped` rows with `attachments: ["image"]` and no `sticker_ids`. The ancestor has
sent a fixed line for weeks, so this was a **measured regression against the bot being
replaced**, not a missing feature. `inbound/imageReply.ts` serves one reviewed
`canned_responses` row whole; the model is never consulted, so nothing can be inferred from
a picture it cannot see. A skip with ANY `stickerIds` is never answered whatever its `type`
claimed — that is what keeps a thumbs-up quiet. `0026` adds the kind; the sentence is
founder-gated and the path refuses an unreviewed row, so it is inert until the reading
evening. **A captioned photo is NOT covered** — it carries text, goes to the model, and the
ancestor deliberately treats it as a photo; closing that needs the founder.

**One space at the end of an approved sentence refused a better answer** (2026-09-16,
D-077). The model adapted `refusal_price_unlisted` to name the service the customer asked
about — better than the row — and `outbound_disclosure` discarded the reply. Measured per
line: 23 of 104 windows were in the corpus, 22 sat inside the approved line, and the single
offender was that line to its last full stop **plus one space**. The exemption is built per
line so it cannot reach past the line's end; the corpus holds the line in context and does;
`segmentsAroundCanned` was the patch and could not fire because it cuts at EXACT occurrences.
The exemption is padded one space at each end now, and the give is statable: a disclosure
must be sixty characters that are not an approved line bordered by whitespace.

Two lessons beyond the fix. **The first diagnostic joined the canned bodies into one string
and matched against that** — manufacturing a window across two unrelated lines and reporting
zero offenders, which is the very splice `disclosesPrompt` refuses to perform and explains in
its own docstring, committed inside the tool used to investigate it. That wrong conclusion
was reported before it was checked per-row. **And the adaptation is counted nowhere:**
`checkPinnedLines` rejects on `MIN_LENGTH_RATIO = 0.8` before similarity is computed, so no
`canned_paraphrased` flag is written when an approved line is adapted INSIDE a longer reply.

And `scripts/guards/check-deterministic-order.mjs` fails the build on a `.localeCompare(`
call anywhere in `src/`. Ordering that can reach the compiled prompt decides
`content_hash`, i.e. the prompt-cache key, so it must not depend on the runtime's locale
any more than on the database's collation (D-026). Exemptions are written as
`guard-ok:locale` on the line or the one above, so an exemption is always a sentence
somebody wrote rather than a filename that happened to match.

## Where things are

| | |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **Where this actually is.** What is built, what has never been proven, and the ordered list of what the founder must supply for one real message |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The reviewable summary — start here |
| [`docs/architecture/09-reconciliation.md`](docs/architecture/09-reconciliation.md) | **The arbitration. Takes precedence over every section file.** Canonical table and env lists live here |
| [`docs/architecture/10-completeness.md`](docs/architecture/10-completeness.md) | What no section addressed; the CLAUDE.md carry-forward audit |
| [`docs/architecture/`](docs/architecture/) | 01–08, the full design by dimension |
| [`docs/schema.md`](docs/schema.md) | **The schema.** Beats every section file's DDL |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Settled calls and why. Pricing lives here |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 3–5 |

## The schema

**Done.** [`docs/schema.md`](docs/schema.md) + `supabase/migrations/0001_initial_schema.sql`
are the schema; the eight section files carry a banner saying their DDL is superseded.
Applied to a scratch PostgreSQL 16.13 and verified by execution, re-counted 2026-09-07
from a run out of an empty cluster: `catalog.sql` **35/35** (V0–V34), `isolation.sql`
**16/16** (T0–T14, with T4 split into T4a/T4b, so 18 PASS lines), `rls.sql` **8/8**
(R1–R8), `spend.sql` **10/10** (S1–S10), `retention.sql` **17/17** (P1–P17). **Count the
checks, not the PASS lines** — several PRs on 2026-09-07 published rls 9, spend 11,
retention 18 and catalog 33 when the file then carried 32, each one exactly one too high
because each suite's own `SUITE PASSED` summary NOTICE was counted as a check. **Also applied to the real project** (PG17.6,
2026-09-05, via the CLI; `0013`–`0014` pushed 2026-09-06): `catalog.sql` was 25/25 there
against the twenty-five checks it then carried, and of the two written since, **V26 now
passes** and **V25 still fails** — `supabase_admin`'s default ACL, re-measured 2026-09-06,
and only a role that can act as `supabase_admin` will clear it.

**The two behavioural suites test different roles on purpose, and swapping them breaks
them** (D-027). `rls.sql` runs as `anon`/`authenticated` and proves the policies bite.
`isolation.sql` runs as **`service_role`** and proves the constraints bite for the role
that bypasses those policies — the inbound writer. Its `T0` fails the run unless
`service_role` bypasses RLS: measured, a non-bypassing role has T1's cross-tenant insert
refused by the policy (`42501`) before the composite foreign key is reached, so the test
would pass while the spine went untested.

**PostgreSQL 16 is installed in this environment** — `/usr/lib/postgresql/16/bin`, not on
`PATH`, which is why sessions keep concluding it is absent and leaving the SQL suites to
CI. `initdb` a scratch cluster and they all run locally in seconds; a migration should
never reach a PR without that.

Before changing it: run `scripts/localvalidate/run.sh`, then all four files in
`scripts/verify/`. All raise on failure, so a red check fails CI rather than printing.
**`rls.sql` is not optional after a policy or grant change** — it runs as `anon` and
`authenticated`, and it is the only one that distinguishes a policy that works from a
policy that merely exists. It found three bugs the other two could not.
Re-run them after any migration touching grants, policies, triggers or seeds, and check
each table independently — the last failure of this kind next door was partial.

## Open, and blocking

- **Reception runs Sonnet 5** (D-009, settled by two bake-off rounds and native-speaker
  review). **No Haiku for customer-facing Mongolian prose** — it is a fluency ceiling, not
  a prompt gap; hardening that names the wrong forms did not fix it. Haiku stays eligible
  for internal/structured work. **The 29% margin figure is superseded** — it assumed
  4,500 replies/month; measured traffic is 41% of that, so the real margin is **71%**
  and Reception clears the 60% target (D-016). **The sentence that followed — that
  `docs/prefix-trim.md` is no longer a margin rescue — is withdrawn (D-072).** It rested on
  a blended per-reply figure with no cold-start term; measured, the prefix is 86.7% of the
  bill and trimming it is a margin lever again.
- **Reception is sold against a 400-conversation/month band** (D-015). **₮250,000 is
  Reception's LIST PRICE and ₮80,000 ≈ $22.86 is the allowable model SPEND** at 60% margin
  computed from the discounted full-team floor — two different quantities, consistent with
  each other, and a session misread them as a contradiction on 2026-09-15. D-004 requires the
  ceiling to derive from the FLOOR, not the list. The band clears 400 conversations at
  67–75% margin on list and 59–69% on the floor. **Matrix's ceiling was raised to $28.57 on
  2026-09-15 by the founder — that is 60% of LIST, where the floor rule gives $22.86** (D-072
  addendum). **Overage is the §5.7 degradation ladder, never an invoice** — billing overage is
  undesigned and must stay that way while there is no revenue path, and note that the ladder
  itself is designed and NOT BUILT: `on_exhausted` has no reader.
- **Matrix's real volume is measured (D-016):** 6 days of production logs, mean 60.5
  replies/day → ~1,842/month, **41% of the assumed 4,500**. Spend $16.57/mo against a
  $22.86 ceiling (0.73×), margin **71%**. A8 = 750 conv/mo is refuted;
  `05-spend-ledger.md`'s 300–600 was closer. **The margin figure rests only on measured
  replies and is solid. The conversation count still divides by the unmeasured A7 = 6 —
  count distinct PSIDs instead** (the log line carries them). The band stays at 400: the
  busiest measured day sustained is ~477 conversations, outside it. Six days carries no
  seasonal shape; the mirror phase's 14 days still sets the final number.
- **The booking link is hostage to a price, in the ancestor and in our own Ш3** (D-042,
  measured 2026-09-07). A customer who writes «цаг авмаар байна» is asked gender, then
  stylist tier, then given a price, and only then the link: **four replies for one link**.
  Two reasonable rules compose into it — a price question needs the tier clarified, and the
  booking rule says to state the *relevant* deposit first — so the link waits behind a
  number nobody asked for. Ш3 has the same construction and has not gone live yet.
  `prompt/drafts/sh3_booking.mn.txt` is the unsigned revision; `metrics/turnsToIntent.ts`
  is the measurement, and **`not_delivered` is not a low score** — read D-042 before
  aggregating it.
- **The price guarantee now rests on the digits-only reduction, not on an empty list**
  (2026-09-07). `allowed_numbers` was `[]` for every tenant, and "a bot with no approved
  prices cannot emit a price" was true for the trivial reason that it could emit no numeral
  at all. Matrix's Stage 4 knowledge base ended that. As published on 2026-09-07 (revision
  seq 3, `content_hash 52426e45…`, 13,745 chars — seq 2 was `f68b8f53…` at 12,239 chars
  before D-058 moved the canned lines into the prefix) it compiles to **twelve** tokens —
  `1, 10:00, 11:00, 19:00, 20:00, 3, 3-5, 30, 4-5, 50, 70, 7741-7777` — the percentages,
  session counts, opening hours and phone number. It briefly read fourteen: `9` and `20`
  came from a promotion end date that has since been removed (D-055), and the four clock
  times arrived with the `business_hours` section. **Read the count off the live snapshot,
  never off this sentence.** Prices are still refused, and the reason is now a
  specific rule rather than an empty set: **comparison is on the digits-only reduction and
  is deliberately not a substring test.** `20` does not license `20,000`, `30` does not
  license `30,000`, and `7741-7777` does not license a bare `7741` — half a phone number is
  as wrong as an invented one. Every price shape probed is refused. But the guarantee is
  one rule deep now, so **read `extractNumerals` and `allowedNumbersFrom` before touching
  either**, and do not repeat the sentence "prices cannot be quietly wrong" without saying
  which mechanism makes it true.
- **The purge cadence is HOURLY and it is not in this repository** (2026-09-07, founder).
  `vercel.json` carries no `crons` block; the schedule lives in the QStash console. A
  session reading the repo cannot learn it, and a session that assumes nightly will
  mis-state the retention floors by up to a day — one already did. Ask; do not infer. The
  1-day floor on unrouted events is therefore ~1 hour of slack rather than ~24.
- **No revenue path exists.** The platform can spend and cannot collect.
- **Single-owner risk is ACCEPTED, not open** (D-017). KEK escrow and second admins are
  deliberately deferred; provider recovery emails and codes are the mitigation. **Do not
  raise this again** unless one of D-017's named triggers fires.

## The ancestor

`Matrix-Chatbot` is the single-tenant predecessor, in production for Matrix Eco Salon.
Read it for what works — fast-ACK plus a durable QStash hand-off, raw-body signature
verification, per-PSID conversation keys, pinned Mongolian sentences — and for the list of
things multi-tenancy must undo. Its known live defects are catalogued in
`docs/architecture/00-research-notes.md`; **do not port them.** Chief among them: a
module-scope prompt cache, `/me/messages` (which posts as whoever the token belongs to),
and a `|| process.env.PAGE_ACCESS_TOKEN` credential fallback.
