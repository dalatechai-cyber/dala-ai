> **The DDL in this file is superseded.** It was one of eight independently written
> proposals, and [`09-reconciliation.md`](09-reconciliation.md) arbitrated the twenty-three
> places they contradicted each other. The schema is
> [`../schema.md`](../schema.md) + `supabase/migrations/0001_initial_schema.sql`, which
> is applied and verified; where this file disagrees with either, this file is stale.
> The reasoning here is still live — it is why the schema is shaped as it is.

## 3. Meta webhook routing — one app, many pages

## 3.0 How to read this section

The ancestor is a *correct single-tenant webhook*. Its transport reasoning — verify over raw bytes, ACK before doing anything slow, hand off durably, never double-reply on an ambiguous failure — is the best thing in that repository and carries over almost intact. What does not carry over is that it has **no tenant at all**: `extractActionableEvents` iterates `body.entry` and consumes only `entry.messaging`, never `entry.id` (`api/messenger.js:164-180`, verified); it sends to `/me/messages` (`lib/messengerClient.js:10`, verified); its send credential is one global env var with a silent `||` fallback (`lib/messengerClient.js:67-69`, verified).

Everything cited as `path:line` I read in the file during this session. Claims I could not verify against Meta's primary documentation — `developers.facebook.com` is blocked by this session's egress policy — are marked **[UNVERIFIED]** inline and consolidated in §3.15. Where a claim is uncertain, the design is built so the **system measures the truth rather than assuming it**: the routing probe (§3.2.5), the `facebook-api-version` response-header check (§3.10.4), and the app-usage-percentage gate (§3.10.2) all exist because a documentation answer was unavailable and a runtime measurement was.

Failure codes are lowercase snake — `tenant_unrouted`, `token_revoked`, `window_closed`. One vocabulary, appearing identically in logs, counters, `ops_alerts.code`, and the `state` column of `inbound_events`. No per-site invention.

---

## 3.1 The request path, end to end

One deployment. A small, configured number of Meta apps (normally one; see §3.13 and §3.17 Q2). One callback URL per app. `N` tenants, each with one or more channels.

```
Meta ──POST──▶ /api/meta/webhook/[app]
        H1  read raw bytes (no parser)
        H2  verify X-Hub-Signature-256 against the app's secret       ── AUTHENTICITY
        H3  parse; dispatch on body.object
        H4  FOR EACH entry: resolve tenant from (object, entry.id)    ── IDENTITY
        H5  classify events within the entry (msg / standby / comment / drop)
        H6  NFC-normalise
        H7  DURABILITY, two independent floors:
              (a) publish one envelope per event to QStash
              (b) insert inbound_events (dedupe authority)
            ACK 200 if EITHER landed; 500 only if BOTH failed
        H8  200 to Meta                                       ◀── target p99 < 800 ms

QStash ──POST──▶ /api/meta/worker
        H9   verify Upstash signature over raw bytes
        H10  load inbound_events by (provider, event_key) ── tenant re-derived from OUR row
             (envelope fallback only when the edge insert did not land)
        H11  gate: channel active → not standby → token healthy → outbound eligible
             → freshness → rate → budget
        H12  per-conversation mutex; load history + tenant knowledge (scoped client)
        H13  Anthropic call; persist reply text + settle spend ledger
        H14  claim outbound_sends row (lease); Send API to /{channel-external-id}/messages
        H15  mark sent; append turn; release mutex; 200
```

The rule that shapes everything: **H1–H8 must not depend on anything slow and must not spend a cent.** All spend happens in H11–H14, behind a gate that runs identity → entitlement → budget in that order, each refusing on error.

### H0 — Route shape and the Next.js caching trap

Route: `app/api/meta/webhook/[app]/route.ts`, exporting `GET` (handshake, §3.12) and `POST` (delivery). Because the file exports `POST`, Next 14.2's `hasNonStaticMethods` is true and the static-generation store sets `revalidate = 0`, so this file is not exposed to the GET-only caching trap. **That is an accident of this file's shape and must not be relied on anywhere else.** Every Supabase client in Dala AI is built through `src/lib/supabase/fetch.ts` with `cache: 'no-store'`, ported day one along with `scripts/check-supabase-nostore.mjs`. The hazard here is worse than next door: a cached `channel_identity` read does not return stale data, it returns **another tenant's binding**, with HTTP 200 and `error: null`. The offboarding, reconciliation and health routes are the ones most likely to be written GET-only; they are the ones to watch.

`[app]` is a slug, not a secret. It selects which app secret and verify token to expect; a wrong slug fails the HMAC at H2.

### H1 — Read the raw body

Port `lib/rawBody.js` verbatim including the 1 MB cap (`lib/rawBody.js:10`, verified). In App Router the equivalent of `bodyParser: false` (`api/messenger.js:16-20`) is `await req.text()` **before** any `JSON.parse`, and nothing in `src/middleware.ts` may consume the stream first. Exclude `/api/meta/*` from the middleware matcher explicitly — the sibling's finding #7 is precisely a matcher swallowing a route nobody thought about.

| Failure | Response |
|---|---|
| Body > 1 MB | `413`, `webhook.body_too_large` |
| Stream error / truncated | `400`, `webhook.body_read_failed` |

### H2 — Signature verification (authenticity only)

Port `verifyFacebookSignature` from `lib/messengerClient.js:25-42` unchanged: `sha256=` prefix check, length check, `crypto.timingSafeEqual`, and **`return false` when the secret is absent** (`:26`, verified). That last line is the whole posture.

One change: the secret becomes a *set*. `META_APP_SECRETS` is a JSON map `{ "<app_slug>": "<secret>" }` in the environment. The `[app]` slug selects one; on a miss, try every configured secret (there will be one or two) and record `matched_app_slug`. App secrets are **app-level, not tenant-level**, so they stay in the environment and never touch the database. This is what makes "how many Meta apps do we run" a config value — which §3.13 needs immediately.

| Failure | Response |
|---|---|
| Header missing or not `sha256=` prefixed | `401`, `webhook.sig_missing` |
| Mismatch against every configured secret | `401`, `webhook.sig_invalid`; log `matched_app_slug=none` and the body's SHA-256, never the body |
| `META_APP_SECRETS` unset or unparsable | `401` **and** page the founder (`startup.config_invalid`). Never 200, never skip. |

There is no environment in which signature verification is off. "No fallback to a default credential" extends to "no fallback to no credential".

### H3 — Dispatch on `body.object`

```ts
const OBJECT_ADAPTERS = { page: pageAdapter, instagram: instagramAdapter } as const;
```

The ancestor's `if (!body || body.object !== 'page') return res.status(200).end();` (`api/messenger.js:98-101`, verified) is the single line that would make an Instagram rollout a silent no-op: the endpoint ACKs perfectly and answers nobody. Replace with a table lookup plus `counter('webhook.unknown_object', { object })` on a miss, still 200. An unrecognised object is a Meta product we have not built yet, not an attack.

### H4 — Tenant resolution, per entry

§3.2. The invariant: **scoping is per `entry`, never per request.** One POST may carry entries for Matrix Eco Salon and GS Auto Center. Resolution failure for one entry does not affect the others.

### H5 — Classify

Per entry, iterate `entry.messaging` (write it as a loop even if Meta documents at most one element — **[UNVERIFIED]**), `entry.standby`, and `entry.changes`. Carry the ancestor's three drop guards (`api/messenger.js:169-175`, verified: `is_echo`, `delivery || read`, `psid === pageId`) and extend them:

| Condition | Action |
|---|---|
| `entry.standby[]` non-empty | **Not a drop.** `state='standby_not_primary'`, alert once per channel. §3.7. |
| `message.is_echo` | Persist as `echo`; drives human-takeover detection (§3.7.3) and the IG routing cross-check (§3.2.4). Never answered. |
| `delivery` / `read` receipt | drop, `event.receipt` |
| sender id == the channel's own external id | drop, `event.self` — belt-and-braces beyond `is_echo` |
| `messaging_handovers` events | thread-control state machine, §3.7 |
| attachments, no text | **do not drop.** `unsupported_media` → per-tenant canned reply + Quality flag (§3.5.5) |
| `changes[].field` in the tenant's subscribed comment fields | comment pipeline, §3.8 |
| anything else | drop, `event.unhandled`, field name in the counter |

Dropping an image-only message the way the ancestor does (`api/messenger.js:174-175`, text-only, verified) is wrong for a salon: "here's the colour I want" is a photograph, and silence produces no signal anywhere.

### H6 — Normalise

NFC-normalise every piece of user text at this boundary and nowhere else. The ancestor never normalises anywhere (`grep -rn "normalize("` over the repo returns nothing), and the consequence is measurable: `'Байна уу'.normalize('NFD')` fails the greeting shortcut at `lib/salonIntents.js:26` while the NFC form matches. Same message, same customer, different behaviour depending on their keyboard.

### H7 — Durability: two independent floors

**This replaces the draft's "persist, then enqueue, and 500 if Postgres is down."** The critique is right that the draft's durability argument ran in exactly one direction — it protected against QStash failing *after* Postgres succeeded, and made Postgres a single point of loss whose failure was priced against an [UNVERIFIED] belief about Meta's Messenger redelivery behaviour. The critique's own counter-claim (that Messenger redelivery is materially less generous than general Graph webhooks) is *also* unverified, so the design must not depend on resolving the question at all. Two independent floors does that.

```
for each classified event:
    envelope = { provider, entry_id, event_key, matched_app_slug,
                 received_at, raw_event }          // NO tenant_id
    (a) publish(envelope, deduplicationId = `${provider}:${event_key}`)
    (b) insert inbound_events (...) on conflict (provider, event_key) do nothing

ack 200 if (a) OR (b) succeeded
500 only if BOTH failed
```

Why the envelope carries `entry_id` and not `tenant_id`: the tenant is still never transported. The chain is Meta HMAC verified → `entry_id` extracted from a signed payload → published under our QStash signing key → worker verifies the QStash signature → **registry lookup**. The worker's normal path (H10) does not use the envelope's id at all; it loads our own `inbound_events` row and takes the tenant from there. The envelope's `entry_id` is used only on the degraded path where the edge insert did not land, and then it goes through the identical registry lookup that the edge would have done.

**Objection partly rejected:** the critique proposed moving the insert *entirely* into the worker, making QStash the sole floor. That trades one single point of loss for another and gives up the property the second critique correctly praised — the queue body carrying nothing but an id. Two floors keeps both.

| Failure | Response |
|---|---|
| Duplicate (insert conflicts, publish deduped) | not an error. `event.duplicate`, 200 |
| Publish hard-fails, insert succeeds | 200, row `state='pending_enqueue'`, sweeper re-publishes (§3.6.3) |
| Publish times out (ambiguous), insert succeeds | 200; sweeper re-publishes with the same `deduplicationId`, so a landed-but-timed-out publish is deduped at the queue and again by the `outbound_sends` claim. This preserves the ancestor's key insight at `api/messenger.js:118-133` (verified) — *an ambiguous failure is not a failure* |
| Insert fails, publish succeeds | 200, `webhook.persist_deferred`; the worker inserts |
| **Both fail** | **500**, `webhook.durability_lost`, **page immediately**. Meta retry is now a third-order hope, not the design |
| QStash entirely unconfigured | boot-time refusal in production, `startup.queue_unconfigured`. The ancestor degrades silently here (`lib/messengerQueue.js:37-43`) and `memoryEnabled()` exists to report it and is never called (`lib/conversationStore.js:130`, verified) |

Publishes are batched per entry and time-boxed with the ancestor's `withTimeout` (`api/messenger.js:29-41`) at **1200 ms**, not 4000 (`api/messenger.js:24`) — we no longer need slack for an inline fallback.

An optional Redis seen-set consulted before the publish sheds obvious redeliveries at the edge. It fails open, which is safe because layer (b) is authoritative.

### H8 — ACK

Always `200` once at least one floor holds. Hard handler deadline 2500 ms.

### H9 — Worker authenticity

Port `api/messenger-worker.js:27-59` including the deliberate non-pinning of the URL claim (`:45-52`, verified) — with one deployment and one worker URL that reasoning still holds, and pinning would 401 legitimate deliveries from Vercel's internal host. `MAX_RETRIES = 3` (`lib/messengerQueue.js:13`) and the `upstash-retried` → `finalAttempt` mapping (`api/messenger-worker.js:68-69`) carry over unchanged.

### H10 — Re-derive the tenant

```ts
let ev = await db.inboundEvents.byKey(envelope.provider, envelope.event_key);  // service-role
if (!ev) ev = await routeAndInsertFromEnvelope(envelope);   // degraded path only
if (!ev) return 200;                                        // unrouted or purged
const ctx = await withTenant(ev.tenant_id, ev.channel_id);  // the chokepoint
```

`withTenant()` is the `guardAiRoute()` of this codebase: **one gate, no local re-implementations.** §3.2.7 makes it mechanical rather than a naming convention, because RLS protects nothing here — the whole inbound path runs as `service_role` with `BYPASSRLS` and there is no user session anywhere in it.

### H11 — The gate, in order, each failing closed

| # | Check | Refusal |
|---|---|---|
| 1 | `tenants.status = 'active'` | `tenant_suspended` → terminal, 200 |
| 2 | `tenant_channels.status = 'active'` | `channel_offboarded` / `channel_suspended` → terminal |
| 3 | Event is not `standby_not_primary` | `channel_not_primary_receiver` → terminal, alert (§3.7) |
| 4 | Conversation not in human-takeover cooldown | `human_has_thread` → terminal, no spend (§3.7.3) |
| 5 | `tenant_secrets` active for this channel | `token_missing` → 503 if unread; `token_revoked` → terminal, no spend (§3.4.5) |
| 6 | **`resolveOutboundEligibility(action, ctx)`** permits this action type | `window_closed` / `private_reply_expired` / `comment_cap_reached` → terminal, no spend, Quality flag (§3.9) |
| 7 | Freshness: `now - occurred_at ≤ tenant.max_reply_age_minutes` | `reply_too_late` → terminal, no spend, Quality flag |
| 8 | Per-tenant rate + concurrency | `rate_limited_tenant` → 503, QStash retries with backoff (§3.10) |
| 9 | Budget reserve against `spend_ledger` | `budget_exhausted` → per-tenant policy (§3.17 Q4) |

Every helper returns **503 on any internal error** and is never wrapped in `try { check() } catch { continue }` — the exact pattern that was the HIGH finding in the sibling's 2026-08-13 audit. Here it is worse than next door: failing open spends *another tenant's* money, which is not the founder's to lose.

Checks 3–7 are free and precede check 9 deliberately. Refusing to generate a reply we cannot deliver is the cheapest budget control in the system.

### H12–H15 — Generate and send

Detail in §3.5 (crash window), §3.10 (concurrency), §3.4 (credential). Two rules:

- **Persist the generated reply before attempting the send.** A send retry re-sends stored text and never re-enters the model. Today the ancestor regenerates on every attempt: `processMessengerEvent` calls `generateSalonReply` at `lib/messengerProcess.js:95` and `markHandled` only runs after a successful send at `:116` (verified), so a send failure buys a second generation.
- **The Send URL is `/{external_id}/messages`, never `/me/messages`.** `lib/messengerClient.js:10` hardcodes `/me/messages`, which resolves the Page *from the token*. In a multi-tenant port that is the most dangerous line in the file: a token/tenant mismatch does not error, it **succeeds and posts as the wrong salon**. With an explicit id in the path the same mistake produces a catchable error.

---

## 3.2 Tenant resolution

### 3.2.1 The schema

```sql
create extension if not exists btree_gist;

create table tenant_channels (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id),
  provider                text not null check (provider in ('facebook_page','instagram')),
  auth_flavour            text not null check (auth_flavour in ('facebook_login','instagram_login')),
  meta_app_slug           text not null,
  send_host               text not null,           -- graph.facebook.com | graph.instagram.com
  send_external_id        text not null,           -- the id used in POST /{id}/messages
  display_name            text not null,
  status                  text not null default 'pending'
      check (status in ('pending','probing','active','suspended','offboarded')),
  graph_version_override  text,
  subscribed_fields       text[] not null default '{}',
  granted_scopes          text[] not null default '{}',
  business_id             text,
  rate_weight             int  not null default 1,   -- §3.10.2 reserved floor
  ignore_commenter_ids    text[] not null default '{}',
  last_webhook_at         timestamptz,
  last_subscription_ok_at timestamptz,
  created_at              timestamptz not null default now(),
  unique (tenant_id, id)                              -- enables composite FKs downstream
);

create table channel_identity (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('facebook_page','instagram')),
  external_id  text not null,
  tenant_id    uuid not null,
  channel_id   uuid not null,
  id_kind      text not null check (id_kind in
                 ('page_id','ig_user_id','ig_linked_page_id','observed_entry_id')),
  source       text not null check (source in ('onboarding_api','routing_probe','founder_manual')),
  active       boolean not null default true,
  verified_at  timestamptz,
  retired_at   timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, channel_id)
    references tenant_channels (tenant_id, id) on delete restrict,
  constraint one_tenant_per_active_external_id
    exclude using gist (external_id with =, tenant_id with <>) where (active)
);
create unique index channel_identity_active_key
  on channel_identity (provider, external_id) where active;
create index on channel_identity (channel_id);

create table channel_transfers (             -- the only legal way an id changes hands
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  external_id   text not null,
  from_tenant   uuid not null,
  to_tenant     uuid not null,
  from_channel  uuid not null,
  to_channel    uuid not null,
  actor         text not null,               -- founder identity, never a service account
  reason        text not null,
  at            timestamptz not null default now()
);
```

Four constraints do the security work:

- **`unique (provider, external_id) where active`** — one live identity maps to exactly one channel. No "most recent wins", no upsert, no tie-break. A second tenant claiming a bound id gets a constraint violation at onboarding, not at 2 a.m. in the routing path.
- **`exclude … where (active)`** — no two *active* rows may share an `external_id` across different tenants, even under different providers. This is what makes "store both the IG user id and the linked Page id" safe: the same tenant may hold the same numeric id under two providers; a different tenant may not hold it at all.
- **The composite FK `(tenant_id, channel_id)`** — an identity row can never point at another tenant's channel. This is the one integrity check that still fires against a bug in service-role code, because referential integrity is not subject to RLS.
- **`active` as a partial-index predicate, not a delete** — this is the fix for a genuine hole the second critique found and I could not argue with. The draft promised two mutually exclusive things for the same `external_id`: keep the row after offboarding (so an offboarded page is a *known* state rather than a permanent unknown-id alert), and insert a new binding on transfer. Under a hard primary key both cannot be true, and the real-world outcome would have been a hand-written `update … set tenant_id = …` in the Supabase SQL editor — no audit row, no cache invalidation, applied by exactly the dashboard-editor habit `CLAUDE.md` already documents as unloggable. With `active`, a transfer is `update … set active=false, retired_at=now()` + `insert` + one `channel_transfers` row, in one transaction, and the history survives.

Multiple *active* rows per channel are normal. An Instagram channel typically has three: the IG user id from onboarding, the linked Page id as a fallback, and the observed entry id from the probe. All route to the same `channel_id`. **Match either — the routing key is whatever arrived.**

### 3.2.2 The lookup, and cache versioning

```ts
const v = await redis.get('bindings:version');                 // bumped on every write
const key = `chan:v${v}:${provider}:${entryId}`;
```

The draft cached the resolved row for 60 s with no invalidation on write. Every binding change — transfer, offboard, suspend, probe activation — therefore had a 60-second window in which warm lambdas kept routing to the previous tenant, and because H7 persists before H11 gates, the new owner's customers' messages would be written into the previous owner's `inbound_events` and stay there. A monotonic `bindings_version` integer in the cache key invalidates every warm lambda's view atomically. Bump it in the same transaction as any write to `channel_identity` or `tenant_channels.status`.

Positive TTL 60 s, negative TTL 10 s. The negative cache is short because a channel bound during onboarding must start routing within seconds, and an unknown id under a comment storm must not hammer Postgres. If Redis is unavailable, fall through to Postgres — resolution is a *read*, and failing it closed drops legitimate traffic. The fail-closed posture belongs on the spend path, not here.

### 3.2.3 Making an unrouted event cheap

An unknown `entry.id` is refused, and refused means precisely:

- **HTTP 200 to Meta.** Not 404, not 400, not 500. A non-2xx repeated for ~1 hour gets the *asset* unsubscribed **[UNVERIFIED threshold]**, and an unknown id is by definition not an asset we can repair by being noisy at Meta.
- **Nothing processed.** No enqueue, no model call, no send, no spend, no tenant guessed. **There is no `?? DEFAULT_TENANT` in this codebase, in any environment, including local development.** A fallback written "just for testing" is the single most likely origin of a cross-tenant leak.
- **`counter('webhook.unrouted', { provider, app_slug })`** and a log line carrying the id. A Page/IG account id is public information; the *payload* is not logged.
- **Quarantined**, in `unrouted_events (provider, external_id, first_seen_at, last_seen_at, count, sample_text_nfc, probe_code_seen, expires_at)`, upserted by `(provider, external_id)` so a storm produces one row with a counter. Hard caps: 500 distinct ids, 7-day TTL; past the cap, count only, no sample. **This table is founder-only and is never rendered on a tenant-visible screen** — it holds message text from businesses that may not be Dala AI customers at all.
- **Alerted once** per id, deduped through `ops_alerts`. Thereafter a dashboard number.

**Never auto-create a tenant from a webhook.** Not behind a flag, not in staging.

### 3.2.4 What `entry[].id` contains — and provisional routing

| `body.object` | `entry[].id` | Confidence |
|---|---|---|
| `page` | the Facebook **Page ID** | High. Consistent across sources and with the ancestor's operation. |
| `instagram` | the **Instagram professional account ID** (`17841…` shape) | **[UNVERIFIED]** as an unambiguous statement under *both* auth flavours. Chatwoot, a production multi-tenant inbox, reads `entry.id` but resolves its channel from `messaging.sender.id` (echoes) / `messaging.recipient.id` (inbound), and keeps two channel tables with an explicit priority rule. A serious implementation does not trust the invariant blindly. |

```
for entry of body.entry:
    binding = resolve(object, entry.id)                       # PRIMARY — authorises
    if binding:
        for m of entry.messaging ?? []:                       # cross-check, cheap
            expected = m.message?.is_echo ? m.sender?.id : m.recipient?.id
            if expected && expected != entry.id:
                counter('webhook.entry_id_mismatch', {provider, channel_id})
                if resolve(object, expected) is a DIFFERENT channel:
                    REFUSE the entry; alert 'routing_ambiguous'    # never guess
    else:
        for m of entry.messaging ?? []:                        # SECONDARY — evidence only
            cand = m.message?.is_echo ? m.sender?.id : m.recipient?.id
            b2 = resolve(object, cand)
            if b2:
                persist with state='routed_provisionally', tenant = b2.tenant_id
                DO NOT ENQUEUE. alert 'routing_needs_confirmation' once per id
                break
        if nothing: REFUSE (§3.2.3)
```

**The secondary path resolves but does not authorise.** The draft let it resolve *and process* — spend money and send a reply as that tenant — while the counter meant to make it visible was read by a human hours later. The critique is right that this converts "I do not know whose this is" into a completed, billed, publicly-visible reply, and it fires precisely when routing is already confused (mid-transfer, mid-probe, an id shape Meta changed between auth flavours). Provisional rows are held; the founder confirming writes the `channel_identity` row with `id_kind='observed_entry_id'`, which promotes the held rows to `pending_enqueue` for the sweeper.

The critique conceded that its strongest scenario — a leaked app secret — gains nothing from the fallback, since an attacker could set `entry.id` directly. I am adopting the change on the "guess and commit under confusion" ground alone, which is sufficient.

This is bounded, not a per-event human step: **one confirmation per channel, ever.** Onboarding (§3.2.5 step 2) already stores both the IG user id and the linked Page id from the Graph read, so the primary lookup hits for whichever value Meta actually uses. The secondary path fires only for a genuinely third id shape — which is exactly the discovery we want, alerted rather than silently absorbed.

One dependency worth stating: **the echo branch of the cross-check only exists if `message_echoes` is subscribed**, and `MESSENGER_SETUP.md:63` (verified) explicitly instructs *not* to subscribe it. §3.7.3 argues echoes should be subscribed for a different reason; the cost is roughly a doubling of inbound webhook volume, since every outbound reply generates an inbound event. That is a per-tenant `subscribed_fields` decision, not a global constant.

### 3.2.5 The routing probe — proof of possession, not a founder's eyeball

Both critiques independently found the same hole, and they are right. The draft bound an id to a tenant by *temporal coincidence*: the founder was shown an opaque numeric id and a time window and asked "is this Matrix Eco Salon?" The founder cannot verify that answer. Two concurrent onboardings, a forgotten Page still subscribed to the app, or the tenant's staff DMing the wrong account during testing, and the founder clicks yes on the wrong id. `channel_identity`'s constraints then cheerfully accept it — they prevent an id being claimed *twice*, not being claimed *wrongly*. From that moment tenant B's customers are answered from tenant A's knowledge base, on tenant A's token, charged to tenant A's ceiling, and every downstream control faithfully propagates the wrong answer. The `channel_already_claimed` failure row does not fire, because there is no second claim.

**The fix is to bind on content, not on time.**

```sql
create table channel_probe_tokens (
  code        text primary key,          -- e.g. 'ДАЛА-7F3K'
  tenant_id   uuid not null,
  channel_id  uuid not null,
  provider    text not null,
  expires_at  timestamptz not null,      -- 15 minutes
  consumed_at timestamptz,
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id)
);
```

The onboarding flow, in order:

1. **Discovery — never `/me/accounts`.** From the Dalatech System User token: `GET /{business-id}/owned_pages` and `GET /{business-id}/client_pages`. `GET /me/accounts` is the `information_schema.role_table_grants` of the Meta API — for a Page owned by a Business Portfolio accessed through a business role it returns an **empty array with HTTP 200**, which reads as "this business has no pages". It may appear in the onboarding UI as a convenience; it is never the source of truth and empty is never "none".
2. **Page credential and ids.** `GET /{page-id}?fields=name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}` with the System User token. Store the Page ID (`id_kind='page_id'`), every Instagram id returned (`ig_user_id`), and the Page ID again under `provider='instagram', id_kind='ig_linked_page_id'`. Encrypt and store the token (§3.4).
3. **Subscribe.** `POST /{page-id}/subscribed_apps` with the tenant's field list — the ancestor's curl at `MESSENGER_SETUP.md:65-72` (verified), now parameterised. **Then verify the app-level subscription too** (§3.10.5) — a page-level subscribe returns `{"success": true}` even when the app has never enabled that field on the object, and no events are ever delivered.
4. **Probe.** Channel → `probing`. Mint a code; the operator sends **exactly that string** as a DM to the Page and, separately, to the IG account. The webhook binds an observed `entry.id` **only** when the NFC-normalised event text equals an active, unconsumed code for a channel currently `probing` — and the binding carries that code's `channel_id`. No founder click, no ambiguity between concurrent onboardings. Single-use, 15-minute expiry.
5. **Standby gate.** The channel cannot reach `active` if the probe message arrived in `entry.standby` rather than `entry.messaging` (§3.7). That means the Page Inbox is the primary receiver and Reception AI would answer nobody.
6. **Activate.** `active` only after at least one message event *and* (if comments are in scope) one comment event have routed end to end **and a reply was delivered**. Onboarding is not "config saved".

The tenant's own onboarding screen shows `waiting / matched` and nothing else. `unrouted_events` is founder-only.

**Onboarding client #3 is still filling in a form.** Steps 1–3 are API calls driven by that form; step 4 is sending one string from a phone. No code branch anywhere distinguishes a salon from an auto shop.

### 3.2.6 Transfers and offboarding

| Event | Transaction |
|---|---|
| **Offboard** | `tenant_channels.status='offboarded'`; identity rows stay `active=true` so the id remains a *known* state; bump `bindings:version`; the reconciler `DELETE /{page-id}/subscribed_apps` after 7 days. Inbound is 200-and-dropped with `channel_offboarded`. |
| **Transfer** (salon sold, franchise changes operator, tenant switches agency) | One transaction: old identity rows → `active=false, retired_at=now()`; new `tenant_channels` row; new identity rows `active=true`; one `channel_transfers` row naming the human actor and reason; bump `bindings:version`. Held provisional rows for that id are discarded, not re-routed. |
| **Second tenant claims a bound id** | Unique-index or EXCLUDE violation **at onboarding**. `channel_already_claimed`. The founder adjudicates. Never "most recent wins". |

### 3.2.7 Making the chokepoint mechanical

The draft claimed route code "should not be *able* to build a query without `withTenant()`". As written that is a naming convention, and the critique is right that it would not hold. Two facts make it urgent: supabase-js has no pre-bound client, and **composite foreign keys only constrain writes** — a read that omits `tenant_id` violates nothing, throws nothing, and returns another tenant's rows with HTTP 200 and `error: null`, which is precisely the failure signature `CLAUDE.md` was written about.

The concrete hazard is the KB retrieval at H12. The natural shape is a pgvector RPC (`select … from kb_chunks order by embedding <=> $1 limit 8`), and `.rpc()` has no `.eq()` to forget — it bypasses any query-builder wrapper entirely. The sibling audit already records that the analogous `increment_*` RPCs *exist in the database but are absent from the repo*: unreviewable, dashboard-applied, invisible to CI. One missing `where tenant_id = p_tenant_id` inside such a function and GS Auto Center's labour rates are retrieved into Matrix Eco Salon's system prompt — and, because §3.10.2 mandates prompt caching, written into a cache entry that then serves the contaminated prefix at 0.1× cost until the config version changes.

Three mechanisms, all cheap:

1. **`ctx.db.from(table)` returns a Proxy.** For every table in an explicit `TENANT_SCOPED` set it appends `.eq('tenant_id', ctx.tenantId)` before returning the builder, and throws on `.or()` or any raw filter that could widen the predicate.
2. **Every tenant-scoped RPC takes `p_tenant_id` as its first argument**, injected by `ctx.rpc()` and never passed by the caller. CI checks each such function body — read from `pg_get_functiondef` in the catalog, not from the repo — for a `where tenant_id = p_tenant_id` clause. A function that exists only in the dashboard fails the check by being absent from the catalog dump.
3. **`scripts/check-tenant-scoped.mjs`**, modelled on the sibling's `check-supabase-nostore.mjs`, fails the build on any direct import of the admin client outside `src/lib/withTenant.ts`. The sibling's lesson is that this class of rule only holds when a script enforces it offline.

Plus the two things that already hold: `tenant_id` on every log line and every cache/rate-limit key, and composite FKs carrying `tenant_id` on every child table, so a service-role write with the wrong tenant is refused by the database.

---

## 3.3 Signature verification with one app secret across all tenants

State it once, plainly:

> **`X-Hub-Signature-256` proves the request came from someone holding our app secret. It proves nothing whatsoever about which tenant the event belongs to.**

One Meta app has one app secret. Every subscribed Page and every Instagram account produces a signature under that same key. A valid signature over an entry claiming `entry.id = <Matrix's Page ID>` is exactly as valid as one claiming GS Auto's.

| | Question | Mechanism | Failure |
|---|---|---|---|
| Authenticity (H2) | Did Meta send this? | HMAC-SHA256 over raw bytes, constant-time | `401` |
| Identity (H4) | Whose event is it? | Server-side lookup in a table we own, unique-keyed | 200 + drop + alert |

**After resolution, cross-check the app.** `tenant_channels.meta_app_slug` must equal `matched_app_slug`. If a Page we believe is on `dala-main` delivers an event signed by `dala-legacy`'s secret, either our subscription state is wrong or someone has our other secret. Refuse the entry, `alert('app_mismatch')`. This is how authenticity gets tied back to identity, and it costs one string comparison. It matters more than it looks during the tenant-#1 cutover (§3.13), where a Page is legitimately subscribed to two apps at once.

---

## 3.4 Per-tenant page access tokens

### 3.4.1 Why this is not "secrets from the environment"

A Page access token is **per-tenant data**: it arrives at onboarding, it is one row among N, it rotates per tenant on Meta's schedule. `PAGE_ACCESS_TOKEN` as a single env var (`MESSENGER_SETUP.md:27`, read at `lib/messengerClient.js:68`, both verified) does not scale past one tenant, and the `||` fallback at `lib/messengerClient.js:67-69` is worse than not scaling: combined with `/me/messages`, tenant B's reply goes out on tenant A's token and posts as tenant A's salon, with a `200 OK`.

**Envelope encryption in application code, KEK in the Vercel environment.**

```sql
create table tenant_secrets (
  tenant_id      uuid not null,
  channel_id     uuid not null,
  kind           text not null check (kind in
                   ('meta_page_token','meta_ig_user_token','sip_password')),
  ciphertext     bytea not null,   -- AES-256-GCM(plaintext, DEK); iv || tag || ct
  wrapped_dek    bytea not null,   -- AES-256-GCM(DEK, KEK);       iv || tag || ct
  kek_version    int  not null,
  status         text not null default 'active'
                   check (status in ('active','rotating','revoked','indeterminate')),
  scopes         text[] not null default '{}',
  expires_at     timestamptz,      -- NULL = no scheduled expiry known
  refresh_after  timestamptz,      -- when the refresh job should act
  last_ok_at     timestamptz,
  last_error_code int,             -- Meta's numeric code. NEVER the token, never a body.
  last_error_at   timestamptz,
  created_at     timestamptz not null default now(),
  primary key (tenant_id, channel_id, kind),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id)
);
alter table tenant_secrets enable row level security;
revoke all on tenant_secrets from anon, authenticated;
-- no policy for anon/authenticated at all. Not even the tenant owner reads this table.
```

Four non-optional details:

1. **AAD binds ciphertext to its row.** Pass `tenant_id || channel_id || kind` as GCM additional authenticated data. Copying tenant A's ciphertext onto tenant B's row then fails authentication instead of decrypting into a working credential.
2. **`revoke all`, not merely "no policy".** RLS with no policy is default-deny today; a future `grant all on all tables in schema public to authenticated` — the exact residue found next door — silently re-opens it. Verify with the catalog: `aclexplode(coalesce(relacl, acldefault('r', relowner)))`, treating grantee 0 as PUBLIC, per table, independently. `revoke insert, update, delete` is not "cannot write": TRUNCATE bypasses RLS entirely.
3. **Decrypt per request, hold in request scope only.** No module-scope cache. Vercel reuses warm lambdas across tenants; a module-level `let token` is a cross-tenant leak with a fifteen-minute half-life. This is the same defect class as `lib/salonBrain.js:142`'s `cachedBasePrompt` (verified) — a module-scope singleton built from build-time `clientData`, which at one tenant is a sensible optimisation and at two serves tenant A's prices and phone number to tenant B.
4. **The token never appears in a log, an error, or a URL.** The ancestor gets this right (`lib/messengerClient.js:79` header not query string; thrown errors carry `fbCode`/`fbSubcode`, `:118-125`) and it must be preserved.

**Why envelope and not Supabase Vault.** Both are equivalent against a stolen database backup. They differ against the likelier incident for a solo founder on a public repo: a leaked `sb_secret_…` key. Vault's `decrypted_secrets` view decrypts on read for the role that already has full data access, so one leaked key yields every tenant's token in plaintext. Envelope splits the capability across two vendors. Vault being `public alpha` and mid-reimplementation is a secondary reason.

### 3.4.2 Acquisition inside a Business Portfolio

1. **System User** in Dalatech's Business Portfolio — its token is not attached to any person's password and survives staff turnover on either side.
2. Client grants **Partner access** to Dalatech's portfolio for their Page (Shape A). Shape B is Facebook Login for Business: the client clicks through a Dala AI onboarding page. Same code, different `auth_flavour` value and a different runbook (§3.17 Q3).
3. `GET /{page-id}?fields=name,access_token,…` with the System User token. Encrypt, store.
4. **Never `GET /me/accounts`** (§3.2.5 step 1).

Scope vocabulary is data, not a branch. Facebook Login: `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`, **`pages_read_user_content`**, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `business_management`. **`pages_read_user_content` was missing from this list until 2026-09-04** and it is the one that grants reading *customers'* comments and gates the `feed` webhook field; Meta also makes `pages_manage_engagement` depend on it, so a submission naming only the latter is incomplete (D-023). Instagram Login: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`. Two vocabularies for one capability → `granted_scopes[]` on the channel, selected from a small static map keyed by `auth_flavour`. `MESSENGER_SETUP.md:73-75` (verified) already names the FB-only subset and already notes App Review is required for the general public — the exact boundary Matrix-Chatbot sits inside and Dala AI sits outside.

### 3.4.3 What expires, and when

| Token | Lifetime | Killed by |
|---|---|---|
| Long-lived User token | ~60 days; expires after ~60 days of no requests | time, password change, permission revoke |
| Page token from a long-lived User token | "never expires" **while the granting user retains admin on the Page** | role loss, password change, app revoke, app-secret rotation, Meta security action, app returned to Dev mode |
| System User token | can be minted with **Never** expiry | asset unassigned, system user deleted, app secret rotated, manual revoke |
| Page token *derived from* a System User token | **[UNVERIFIED]** whether it inherits never-expiry | — |
| **Instagram User token (Instagram Login flavour)** | **hard 60 days**, refreshed via `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`; expires outright if unused for 60 days | **[HIGH — verify]** |

That last row is a correction the critique is right about and the draft got wrong. The draft asserted "token rotation is driven entirely by the `190` path; there is no timer". Under Instagram Login there **is** a timer, it is 60 days, and every such channel would have died on day 60 with the reactive `190` handler firing only after the first customer got silence. It also breaks the tidy claim that the two auth flavours are "the same code differing by config": one flavour needs a scheduled refresh job, and per non-negotiable #6 that job needs its own ceiling and alert path.

**"Never-expiring" means "no scheduled expiry", not "cannot be invalidated."** `MESSENGER_SETUP.md:27` is a fine instruction for one Page you control; across N client Pages it is a guarantee you do not have.

### 3.4.4 Detection

A dead token is **silent**. Reception AI simply stops replying; nothing throws, because no request arrives to fail. Detection must be active on four fronts.

**Reactive, on the send.** Classify the Graph error. Taxonomy read from Chatwoot's production Instagram handler and adopted wholesale:

| Code | Meaning | Action |
|---|---|---|
| `190` | token expired / invalidated | `status='revoked'`, **halt all outbound for that channel**, page the founder. Never retry a 190. Subcodes 460/463/467 **[UNVERIFIED]** — record, do not branch on them yet |
| `200`, `10` | missing permission / policy | terminal; `channel_permission_error`; **page** — usually a scope lost at App Review or a task role removed |
| `100` | missing permission, or non-existent user/object | terminal; if it names the recipient, mark the contact unreachable; do **not** touch token status |
| `230` | user consent / cannot be messaged | terminal, quiet |
| `9010` | bot validation | terminal, mark contact unknown |
| `613` | rate limit | **retryable**; back off *this tenant only*; re-send stored text, never regenerate |
| `2534014` | private reply already sent for this comment | **success-equivalent** (§3.8.4) |
| 5xx / network / timeout | transient | retryable |

**Proactive probe.** `GET /{external_id}?fields=id` per channel every 6 hours with the tenant's own token — one cheap Graph call against that tenant's own budget. Scheduled, therefore carrying `TOKEN_PROBE_MAX_CHANNELS_PER_RUN` and an alert path, and touching no model.

**Expiry watch.** A daily job over `tenant_secrets where refresh_after < now()`. For `auth_flavour='instagram_login'`, refresh at day 30, not day 55, with `TOKEN_REFRESH_MAX_CHANNELS_PER_RUN`. `token_expiring` is a **warn**; `token_revoked` is a **page**. Two distinct codes, because one is scheduled work and the other is an outage.

**Absence watchdog.** `tenant_channels.last_webhook_at`. Alert when a channel that received ≥1 webhook in the previous 7 days receives none in 24 h. This catches the case the probe cannot: a token that still works but a **subscription Meta disabled** (§3.10.5), or a channel that quietly became a secondary receiver (§3.7). You find out about that failure from the absence of requests, never from a request.

### 3.4.5 Inbound while a token is dead

**Persist everything, generate nothing, deliver nothing, flag it all.**

H7 still runs; nothing is lost. H11 check 5 refuses with `token_revoked`, **terminal** so QStash does not retry — generating a reply we cannot deliver is spend with zero value, and most of the backlog will be outside the 24-hour window by the time the token is restored anyway. Conversation state → `blocked_no_token`; every event reaches the Quality layer as an unanswered question, which is exactly what it is.

On restoration, a **bounded replay**: for each contact, only the most recent inbound message, and only if it is still inside the delivery window and inside `max_reply_age_minutes`. Not the backlog. A customer who asked three questions at 11 a.m. and gets three answers at 6 p.m. is worse than one answer to their last question, and replaying a queue is how a restoration turns into a send-rate spike that trips `613`.

### 3.4.6 Rotation

**KEK rotation** (ours, annual or on suspicion): add `META_TOKEN_KEK_V2` alongside V1; unwrap picks by `kek_version`; a resumable, idempotent admin job unwraps with V1 and re-wraps with V2, leaving `ciphertext` untouched; **confirm by querying `select count(*) from tenant_secrets where kek_version <> 2` — not by the job reporting success**; then remove V1. Zero plaintext touched, zero downtime.

**Token rotation** is two things, not one: the reactive `190` path (§3.4.4), and the scheduled Instagram-Login refresh (§3.4.3). Conflating them is how a channel dies on day 60.

**Failure modes.** KEK env var missing at boot → refuse to start; never a plaintext fallback, never a default. `wrapped_dek` fails to unwrap → 503 for that tenant, alert; never fall through to another tenant's secret or to an env var. GCM auth-tag mismatch → treat as tampering, alert, never decrypt-and-hope. No `tenant_secrets` row → distinct code `tenant_not_provisioned`, not 500 and not a silent skip; onboarding is incomplete and that is an operator-visible state.

---

## 3.5 Idempotency

Meta webhooks are at-least-once. Duplicates are normal.

### 3.5.1 The dedupe key, and why it is global

| Event kind | `event_key` |
|---|---|
| Messenger / IG DM | `msg:{message.mid}` |
| FB comment (`feed`) | `cmt:{value.comment_id}:{value.verb}` — verb included, an `edited` is a different event |
| IG comment | `cmt:{value.id}:add` |
| Postback | `pb:{mid or timestamp}:{payload_hash}` |

The uniqueness constraint is **global**: `unique (provider, event_key)`, not `(tenant_id, provider, event_key)`.

The draft scoped it by tenant, on the reasoning that "Meta ids are probably globally unique; the system does not bet a customer's conversation on 'probably'." The critique is right that this inverts. Two tenants receiving the same `mid` is not an id collision — it is **proof of a routing bug**, and a tenant-scoped constraint is exactly the shape that lets it through silently: `on conflict (tenant_id, …) do nothing` returns a fresh row for the second insert, and every downstream guard (budget, rate bucket, conversation mutex, the `outbound_sends` unique key) is scoped by the very field that is wrong. One customer message, answered twice, from two knowledge bases, on two tenants' money.

Handling on conflict: re-read the existing row and compare `tenant_id`. Equal → benign duplicate, `event.duplicate`. Different → `event_key_cross_tenant`, refuse, **page**. If a genuine non-routing-bug collision ever appears, this alert tells us so with evidence, which is the outcome the draft's own reasoning claimed to want.

Fair note: once `bindings_version` cache invalidation (§3.2.2) and the probe nonce (§3.2.5) land, the critique's specific scenario largely disappears. The global index is kept as a **tripwire**, not as a primary control — it costs one index and turns a silent condition into an alarm.

### 3.5.2 Three layers, one authority

1. **Postgres `inbound_events`** — `on conflict (provider, event_key) do nothing`. The **authority**. Executed at the edge, or in the worker when the edge insert did not land (§3.1 H7). Either way it runs exactly once per event.
2. **QStash `deduplicationId = provider:event_key`** — catches a redelivery racing the insert. Window is finite (**[UNVERIFIED]**, ~10 minutes) so it is an optimisation, not a guarantee. Note the ancestor uses the bare `mid` (`lib/messengerQueue.js:66`, verified), fine at one tenant.
3. **Redis seen-set** — saves a round-trip under a redelivery storm. Fails *open*, like the ancestor's `isAlreadyHandled` (`lib/conversationStore.js:49-58`, verified), which is safe **only because layer 1 is authoritative**. In the ancestor it is the only layer on the degraded inline path, and both layers fail together in exactly the case that matters — no QStash means no `deduplicationId` either.

### 3.5.3 The crash window: after Anthropic, before the Send API

**Posture: at-least-once *generation*, at-most-once *delivery*.**

The trade is asymmetric and the asymmetry is the argument. A duplicate generation costs single-digit cents, is bounded, is invisible to the customer, and is recoverable by not doing it again. A duplicate reply is customer-visible, damages the tenant's brand in front of their own customer, can trip per-thread throttling, and in the comment case can start a loop. **Money is the cheaper thing to risk.**

```
H13  model returns
     ── persist inbound_events.reply_text, reply_generated_at, model,
        token counts, cost_usd      (one write)
     ── settle spend_ledger
H14  insert into outbound_sends (tenant_id, inbound_event_id, kind)
       values (...) on conflict do nothing returning id, state, lease_until;
```

`outbound_sends` carries `unique (tenant_id, inbound_event_id, kind)`:

| State on retry | Action |
|---|---|
| row absent | claim: `state='claiming'`, `lease_until = now() + 60s`, send |
| `sent` | no-op, 200. **Never re-send.** |
| `claiming`, lease live | 503; QStash retries after the lease expires |
| `claiming`, lease expired | **do not re-send.** `state='indeterminate'`, `alert('reply_indeterminate')`, Quality flag, 200 |
| `failed_retryable` | re-send the **stored** `reply_text`. No model call. |
| `failed_terminal` | no-op, 200 |

The lease (60 s) sits comfortably above the Send timeout (10 s, `lib/messengerClient.js:14`, verified) so a live attempt cannot be judged expired.

**Defending `indeterminate`.** A worker that dies between the Send request leaving and the response arriving may or may not have delivered. Re-sending risks a duplicate; not re-sending risks silence. We choose silence, for the same reason the ancestor chooses it one layer up (`api/messenger.js:118-133`, verified): *an ambiguous failure is not a failure*. Silence is also not the end of the story — the event lands in the Quality layer as an unanswered question, which is a mechanism the product already has and a duplicate reply has no equivalent of.

So, directly: **a crash between the model call and the send may double-charge, and will not double-reply.** In practice it will rarely double-charge either, because the reply is persisted before the send and the retry reads it back.

### 3.5.4 Two more idempotency surfaces

- **Per-conversation serialisation.** Two rapid messages from one customer produce two workers, two model calls, replies in indeterminate order, and a history race. The ancestor's append is atomic (`lib/conversationStore.js:114-127`, verified) but generation is not serialised. Redis mutex `lock:{tenant}:{provider}:{contact}` with `SET NX PX 45000`; a worker that cannot take it returns 503. Phase 2: coalesce messages arriving within 4 s into one turn — better answers, fewer model calls, but it changes the ACK-to-reply latency profile and should be measured first.
- **`unsupported_media`**: a per-tenant canned line from `canned_responses`, sent through the same `outbound_sends` claim, plus a Quality flag. Never model-composed — the reasoning that pins `CHILDREN_REPLY` and every other canned line (`lib/salonBrain.js:41-81`, verified) applies here.

---

## 3.6 Fast-ACK and the durable queue

### 3.6.1 Why the pattern is non-negotiable

Meta retries a slow webhook and, after roughly an hour of continuous failure **[UNVERIFIED threshold]**, disables the subscription **for that asset** — one tenant goes dark, permanently, until someone manually re-subscribes, and nobody finds out from an error. The ancestor's ACK-first posture (`api/messenger.js:1-8`, `:109-145`, verified) is not a latency optimisation.

### 3.6.2 Stay on QStash

Already in the stack with the reasoning written down; at-least-once with retries and a signed callback is the right contract; the alternative (pgmq + Vercel cron) adds tens of seconds of polling latency to a customer-facing reply. Changes from the ancestor:

- **Envelope, not tenant.** §3.1 H7. This retires the concern the ancestor documents at `api/messenger-worker.js:45-52` (verified) — a signed QStash job that does not pin the URL claim is a valid job at any worker, so a body-carried `tenant_id` would be a cross-tenant primitive the moment a second worker endpoint exists.
- **Tenant-scoped `deduplicationId`** at the queue, global uniqueness at the database.
- **One QStash queue per tenant with bounded parallelism**, *if* named-queue parallelism works as expected — **[UNVERIFIED]**. The design must not depend on it: the authoritative concurrency control is the Redis semaphore in §3.10.2, implemented regardless.
- **`MAX_RETRIES = 3`** with the `upstash-retried` → `finalAttempt` mapping, but retries only for *classified retryable* failures. The ancestor rethrows on any brain failure (`lib/messengerProcess.js:100-108`, verified), so a missing API key or an exhausted balance burns four attempts and four model round-trips before the fallback.

### 3.6.3 The degraded inline path: remove it; add the sweeper

The ancestor processes inline when QStash is unconfigured or the publish hard-fails (`api/messenger.js:134-154`, verified). A multi-tenant system may not keep this:

1. **It spends inside the ACK budget.** A 25 s model timeout (`lib/salonBrain.js:38`, verified) behind a 12 s inline deadline (`api/messenger.js:27`) is already tight at one tenant. With entries for several tenants in one POST, one tenant's slow generation delays the ACK for everyone in that request.
2. **`withTimeout` does not cancel.** `api/messenger.js:29-41` races a timer and never aborts the underlying work — the handler returns 200 while an Anthropic call is still in flight. Untraceable, unattributed, unmetered.
3. **It runs precisely when durability and dedupe are absent**, and nothing alerts.

**Replacement.** Because H7 has two floors, a failed publish loses nothing. A cron every minute selects `inbound_events where state in ('pending_enqueue','persist_deferred') and received_at > now() - interval '20 minutes'`, ordered by `received_at`, capped at `SWEEPER_MAX_ROWS_PER_RUN` (default 200), re-publishing with the same `deduplicationId`. Older rows → `state='expired_unqueued'`, flagged to the Quality layer rather than answered late.

The sweeper is scheduled, so non-negotiable #6 applies: row ceiling, age cutoff, an alert **whenever it finds anything at all** (finding rows means the primary floor is failing), and it touches no model. All downstream spend still passes the H11 gate. `vercel.json` carries the sweeper, the reconciler, the token probe and the refresh job — and nothing that reaches Anthropic.

**BUILT 2026-09-06 as `src/lib/health/stranded.ts`, after this exact failure happened** (D-028). Two differences from the text above, both forced by what the schema became: the pre-queue states are `received` and `failed` here, because `pending_enqueue` is written *after* a successful publish; and the age cutoff is the tenant's own `max_reply_age_minutes` rather than a fixed twenty minutes, so the split lands exactly where a reply stops being wanted. It runs inside `/api/workers/health` rather than on its own `vercel.json` cron — QStash already schedules and already signs, and a second authentication path to do that is a credential to rotate for nothing.

---

## 3.7 The Handover Protocol — the branch the draft wrote as a throwaway

This is the single most damaging omission the critiques found, and it is right.

### 3.7.1 What goes wrong

When a Page has the **Page Inbox app as the primary receiver** — the default for many Pages, and the state a Page enters the moment anyone touches "Automated responses" or an inbox setting in Business Suite — our app is a *secondary* receiver. Meta then delivers messages in **`entry[].standby`**, not `entry[].messaging`. The webhook receives a well-formed, correctly-signed, correctly-routed event for the right tenant, drops it, and returns 200. **Reception AI answers nobody, and every health signal is green:** `last_webhook_at` is fresh, the reconciler sees a valid subscription, the token probe passes, `webhook.unrouted` is zero. The only symptom is the salon phoning the founder — which is precisely the "absence of signal" failure class this whole section exists to prevent, arriving through the one branch written as `// must not crash the loop`.

Confidence: **[HIGH — verify]**. This is the Handover Protocol as I understand it; the exact delivery-array semantics are on the re-verification list (§3.15).

### 3.7.2 The design

- **`standby` is never a drop.** Persist with `state='standby_not_primary'`. **Alert the founder on first occurrence per channel** — it means the channel is misconfigured, not that nothing happened.
- **H11 check 3** refuses standby events terminally with `channel_not_primary_receiver`. No spend on a message we are not entitled to answer.
- **Onboarding gate** (§3.2.5 step 5): a channel cannot reach `active` if its probe message arrived in `standby`.
- **`messaging_handovers` in `subscribed_fields`** by default, and a `thread_control` column on the conversation reflecting `pass_thread_control` / `take_thread_control` events.
- **Seam, not built in v1:** `pass_thread_control` to the Page Inbox when the bot decides a human should take over (the escalation path that today is a canned phone-number line at `lib/salonBrain.js:57-59`). Designing the column now costs nothing; building the handoff is a product decision.

### 3.7.3 Human takeover — the related product bug

When a salon receptionist replies from the Business Suite inbox, the bot has no idea and keeps answering the same customer in parallel. Two mechanisms detect it: thread control events, and **echoes** — an outbound message the bot did not send.

That makes `message_echoes` worth subscribing, against the ancestor's explicit instruction not to (`MESSENGER_SETUP.md:63`, verified). The costs are real: roughly double the inbound webhook volume, every echo classified and dropped on the ACK path. The benefit is two things at once — human-takeover detection, and the Instagram routing cross-check (§3.2.4) which does not exist without echoes.

**Decision: subscribe echoes, per tenant, defaulting on.** On an echo whose `mid` is not in our `outbound_sends`, set the conversation to `human_has_thread` with a `human_takeover_cooldown_minutes` (default 30, per tenant, data). H11 check 4 refuses during the cooldown, terminally, with no spend. The customer gets the receptionist, not both.

---

## 3.8 Comment replies

### 3.8.1 The fields are different, and one is a firehose

| | Facebook Page | Instagram |
|---|---|---|
| Webhook | `object:'page'`, `changes[].field='feed'` | `object:'instagram'`, `changes[].field='comments'` |
| Identify a comment | `value.item==='comment' && value.verb==='add'` | every event is a comment |
| Payload | `from`, `post_id`, `comment_id`, `message`, `created_time`, `is_hidden`, `parent_id` | `value.id`, `value.text`, `value.from.{id,username}`, `value.media.{id,media_product_type}` |
| Enrichment | often needed (media, parent) | album comments omit the album id — must query the comment for `media` |
| Public reply | `POST /{comment-id}/comments` **[UNVERIFIED edge]** | `POST /{ig-comment-id}/replies` |

There is no dedicated `comments` field on the Page object: you subscribe to `feed` and receive the Page's own posts, edits, reactions and hides alongside comments, then filter. Budget for that volume — it is why comments are a separate priority class in §3.10.2.

Every enrichment call is a Graph call against that tenant's rate budget and must be metered like any other. **Under a viral post it is the enrichment calls, not the replies, that exhaust the budget.**

### 3.8.2 Loop prevention

1. **`value.from.id` equals the channel's own external id** → drop, `comment_self`.
2. **`comment_id` already in `inbound_events`** → drop (§3.5.1).
3. **`tenant_channels.ignore_commenter_ids[]`** — a per-tenant list. A stylist commenting from her *personal* account is indistinguishable from a customer by id shape, and the bot must not talk over the salon's own staff. Config, added from the admin form, not a code branch.
4. **Caps, per tenant, as data:** one public reply per root comment thread ever; `comment_replies_per_post_per_hour` (default 10); `comment_replies_per_day` per channel. Exceeding a cap is `comment_cap_reached` — a Quality flag and, past a threshold, a founder alert saying "this post is going viral, come look."
5. **Never reply to a comment on a post older than `comment_max_post_age_days`** (default 30). Old posts attract spam and the tenant gets no value from the bot arguing with it in 2027.

### 3.8.3 Public vs private reply

Per-channel config, `comment_policy ∈ {none, public_only, private_only, both}`:

- **Public reply** — visible, permanent, the tenant's brand speaking. Default for v1 should be conservative: a short acknowledgement plus a pointer, never a price. The deliberate-omission machinery applies with more force here than in DMs, because a wrong price in a public comment is screenshot-able.
- **Private reply** (comment → DM) — `POST /{page-id}/messages` or `/{ig-user-id}/messages` with `recipient: { comment_id: "<id>" }`. Text only; Meta auto-appends a link to the post.

### 3.8.4 The private reply is single-use and expiring

| Property | Value | Confidence |
|---|---|---|
| Exactly one private reply per comment, **ever** | second attempt → subcode `2534014` | rule corroborated; the number **[UNVERIFIED]** |
| Window | **7 days from the comment's `created_time`**, not from webhook receipt | 7 days corroborated; the clock-start **[UNVERIFIED]**, and it is the detail that eats late retries |
| Content | text only | corroborated |

- Dedupe on `comment_id` **in Postgres, before the send**: `comment_replies` with `unique (tenant_id, provider, comment_id)` and a `private_reply_state` column. A duplicate QStash delivery must hit a uniqueness violation, not a second Graph call.
- **`2534014` is success-equivalent.** `private_reply_state='already_sent'`, never retry, never regenerate. Getting this wrong makes every retry burn a generation for a message Meta will refuse.
- **Compute the deadline from `value.created_time` and refuse before generating.** `now - created_time > 7d - 6h` → `private_reply_expired`, terminal, no spend, Quality flag.

---

## 3.9 Outbound eligibility — replacing the single 24-hour gate

The draft had a bug of its own making, and the critique found it. H11's window check was defined once, as `contacts.last_inbound_at + 24 hours`. A private reply to a comment goes, **by construction**, to someone who has never messaged the business: no `contacts` row, `last_inbound_at` NULL, `window_expires_at` NULL, gate refuses with `window_closed` before the model call — for every first-time commenter, i.e. for the entire comment-to-DM feature §3.8 spends a page designing. On Meta's side that send is perfectly legal; the 7-day private-reply allowance is a separate mechanism from the 24-hour messaging window, and §3.8.4 already models it correctly. The two sections were designed independently and the gate was the older one.

**Eligibility is per action type, not per contact.**

```ts
type Action = 'reply_dm' | 'private_reply' | 'comment_reply' | 'outbound_care';

function resolveOutboundEligibility(action: Action, ctx): Eligibility {
  switch (action) {
    case 'reply_dm':       // contacts.last_inbound_at + 24h; else window_closed
    case 'private_reply':  // comment.created_time + 7d, AND no prior private reply
    case 'comment_reply':  // no window at all — only the §3.8.2 caps
    case 'outbound_care':  // the OutboundPolicy object below
  }
}
```

### 3.9.1 Tracking the DM window

`contacts.last_inbound_at`, with `window_expires_at` a stored generated column. Updated at H7 from **`occurred_at`** (Meta's timestamp), never `received_at` — a delayed delivery must not extend a window that has already closed. The ancestor's 24-hour Redis TTL on history (`lib/conversationStore.js`) happens to be the same number; make the window an explicit column rather than inferring it from a cache TTL.

Two thresholds, both per-tenant data: **`max_reply_age_minutes`** (default 30; GS Auto Center may want 120) and the window itself. Beyond the window the send is rejected by Meta (code **[UNVERIFIED]** — classify any rejection naming the messaging window as terminal, and record the exact code the first time it appears, so the table is filled in from production rather than from a search result).

### 3.9.2 Follow-ups — the finding that changes the roadmap

Anything sent *after* the window is not Reception AI's to send, and as of 2026 there is essentially no compliant automated path on Meta:

- `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` **retired 2026-04-27**; requests carrying them return error `100`.
- Recurring Notifications ended 2026-02-10 outside AU/EU/JP/KR/UK.
- `HUMAN_AGENT` extends to 7 days but Meta **explicitly prohibits it for automated or bot messages and says it detects misuse**. Instagram availability is contested between sources.
- The only compliant route is template-approved Utility Messages under Marketing Messages on Messenger — approval-gated, category-constrained, possibly per-message priced.

**The design must not contain the word "tag" anywhere.**

```ts
type OutboundPolicy = {
  channel: 'messenger' | 'instagram' | 'sms';
  window_hours: number | null;         // 24 | 24 | null
  free_form_outside_window: boolean;   // false on both Meta channels, today
  template_required: boolean;
  ai_authored_allowed: boolean;        // false under HUMAN_AGENT
  per_message_cost_usd: number | null; // null ⇒ REFUSE. Never default to zero.
};
```

`per_message_cost_usd === null` refuses, for the same reason `BANK_BUILD_BUDGET_USD` is `0` next door: it is a value that refuses **without depending on a read that might be stale or wrong**. Customer Care AI's seam plugs in here as `action='outbound_care'` — one policy row per channel, and SMS is currently the only entry with `free_form_outside_window: true`, which is a business fact worth staring at (§3.17 Q1).

---

## 3.10 Rate limits and noisy neighbours

### 3.10.1 What Meta enforces

| System | Limit | Header | Scope |
|---|---|---|---|
| App-level (Platform) | `200 × app users` per hour | `X-App-Usage` (percentages) | **the whole app** |
| Page-level | `4,800 × engaged users` per 24 h sliding | `X-Page-Usage` | per Page |
| Business Use Case | separate budget per product per asset | `X-Business-Use-Case-Usage` | per business × product |
| Send API | 300 calls/s per Page (text); 10/s (audio/video) | — | per Page |

### 3.10.2 Our controls, sitting under Meta's

All in Upstash Redis, all keyed through `withTenant()` so the tenant comes from the registry lookup and never from the body.

| Control | Key | Purpose |
|---|---|---|
| Inbound admission | `rl:in:{tenant}:{provider}:{class}` | shed a storm before it becomes spend |
| Graph call bucket | `rl:graph:{tenant}:{provider}` | stay under Page/BUC |
| **Adaptive app gate** | `gate:app:{app_slug}` driven by `X-App-Usage` | see below |
| Model concurrency | `sem:model:{tenant}` (default 3) | one tenant cannot occupy every worker |
| Conversation mutex | `lock:{tenant}:{provider}:{contact}` | §3.5.4 |
| Spend reserve | `spend:{tenant}:{yyyymm}` + `spend_ledger` | the money ceiling |

**The global bucket cannot be sized from a formula, so it is not.** The draft specified "a global app bucket sized below Meta's". The critique is right that this cannot be computed: the app-level limit's denominator is *app users* — people who have authenticated to the Dala AI app via Facebook Login — and under the recommended System User + Partner access shape **no end user ever logs in**, so `200 × users` is an unknown that may be a floor rather than a ceiling. (The critique's specific claim that the count is ≈ 0 is itself plausible-but-unverified; the fix works regardless of the denominator, which is why the design does not depend on resolving it.) Replacement: `X-App-Usage` is already parsed on every response (§3.10.3), so make the **percentage the control input**, not merely a metric. Shed non-urgent classes at 70%, everything but DMs at 85%, alert at 70%, page at 90%. The percentage is the only quantity Meta actually tells you and it needs no knowledge of the denominator.

**Fair-sharing, when the global gate binds.** A single global gate drained first-come-first-served fair-shares no better than Meta's; it just moves the unfairness inside the system. Two cheap fixes, both data:

- **Reserved floors.** Each `active` channel holds `floor_t = capacity × rate_weight_t / Σ rate_weight`, which no other tenant's traffic can consume; only the surplus above `Σ floor` is contended.
- **Shed by share-already-consumed, descending** — never FIFO. At two tenants the ordering is what matters and the floors are close to free; at ten tenants both matter.

Emit the shed decision with both `tenant_id` and `blocked_by_tenant`, so the founder can see in one query that Matrix was starved by GS Auto rather than by Meta.

**Priority classes.** DMs are never shed before comments. A shed comment is persisted with `state='shed', shed_reason='rate_comment'` — persisted, so the Quality layer can see what was dropped and the founder can price it.

**Spend: reserve then settle.** Before the model call, atomically reserve an estimated worst-case cost (max_tokens at the model's output rate + measured prompt size) against the tenant's remaining monthly ceiling; after the response, settle to the actual from `usage`. Without a reserve, N concurrent workers each see the same "remaining" figure and collectively overshoot. `spend_ledger` in Postgres is the authority; Redis is the hot path. **If Redis cannot be consulted, the worker returns 503 and QStash retries.** The only fail-open in this entire system is the *ACK path itself* — which spends nothing, and where a non-200 risks unsubscription. That exception is documented here and nowhere else.

Log every response's `cache_read_input_tokens` / `cache_creation_input_tokens` / `input_tokens`, per tenant. The ancestor already does this (`lib/salonBrain.js:249-253`, verified) and the reason given there is exactly right: a cache miss is invisible in the reply and just quietly bills full price. **The prompt cache must be keyed per `(tenant_id, config_version)`** or it is a cross-tenant leak, not a cost regression.

### 3.10.3 Read Meta's own numbers

Parse `X-App-Usage`, `X-Page-Usage` and `X-Business-Use-Case-Usage` on **every** Graph response; store a high-water mark per channel per hour. These headers are the only visibility Meta gives. A channel at 80% `X-Page-Usage` is a Page about to go silent, and there is no other way to know.

Also record, per channel, **which of these headers actually appear on Send API responses**. That measurement settles which of the three systems governs the hot path — a question the design otherwise cannot answer — and it costs nothing.

### 3.10.4 Version pinning that verifies itself

Graph responses carry a **`facebook-api-version`** header naming the version that actually served the request **[HIGH — verify the header name]**. Compare it to the pinned version on every response, in the same parser that already reads the usage headers, and alert on mismatch. This converts an unverifiable documentation claim — that an expired version **silently falls back** to an older one rather than erroring **[UNVERIFIED]** — into a measurement the system takes on every call. A "monthly assertion against a documentation table" is a human process that will not survive month four.

One `GRAPH_VERSION` constant as `lib/messengerClient.js:9` already does (verified), plus `tenant_channels.graph_version_override` so a bump can be canaried on one tenant — but the *default* is one value for the whole deployment. Per-tenant version must not become a per-tenant code branch.

### 3.10.5 Back off the tenant, not the worker

On `613` or any classified rate-limit failure: increment that tenant's backoff, return 503, and **never re-enter generation** — the reply is already stored (§3.5.3), so the retry re-sends a thought already paid for. Backoff is per `(tenant, provider)`; a throttled Matrix must not slow GS Auto by a millisecond.

### 3.10.6 The subscription reconciler — both levels

An hourly cron (capped, no model) that for each `active` channel:

1. `GET /{page-id}/subscribed_apps` and compares the returned fields to `tenant_channels.subscribed_fields`. On mismatch or absence: re-`POST`, record `last_subscription_ok_at`, alert.
2. **`GET /{app-id}/subscriptions` with an app access token (`{app-id}|{app-secret}`), once per app per run** — and refuses to activate a channel, or alerts on an active one, when any entry in `subscribed_fields` is missing from the app-level list for that object.

Step 2 is a correction the critique is right about. Webhook delivery requires **two** independent subscriptions: the app must be subscribed to the field on the object, *and* to the specific asset. `POST /{page-id}/subscribed_apps?subscribed_fields=feed` returns `{"success": true}` even when the app has never enabled `feed` on the `page` object, and no `feed` events are ever delivered. The draft's reconciler compared the page-level list to the tenant config, found them identical, and reported healthy — a plausible success from a source that cannot see the truth, sitting inside the mechanism built to detect exactly that. It bites the first time a *new* field is requested, i.e. when comments are added for tenant #3.

Also: check that **`entry.standby` is empty** for recent events on that channel (§3.7). A channel that quietly became a secondary receiver passes every other check.

---

## 3.11 Multi-channel identity

**Decision: the same human on Messenger and Instagram is two contacts. Do not unify them automatically.**

```sql
create table contacts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  channel_id        uuid not null,
  provider          text not null,
  external_id       text not null,          -- PSID or IGSID
  identity_group_id uuid,                   -- NULL by default. The seam, unused in v1.
  display_name      text,
  last_inbound_at   timestamptz,
  window_expires_at timestamptz generated always as
                      (last_inbound_at + interval '24 hours') stored,
  thread_control    text not null default 'bot',   -- bot | human | unknown
  first_seen_at     timestamptz not null default now(),
  unique (tenant_id, provider, external_id),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id)
);
```

1. **There is no join key.** PSIDs are page-scoped, IGSIDs Instagram-scoped, both per business — the same person is already a different id at Matrix and at GS Auto. Meta gives no correlation identifier. Unification would rest on display name or profile photo, and a guess that merges two customers' histories is a privacy incident, not a bug.
2. **Nothing downstream needs it.** Token, window, send endpoint and rate budget are all per-channel; a "unified" thread would be split again at send time.
3. **Answer quality does not improve.** KB, refusal rules, closure message and price list are channel-independent.
4. **The reverse is expensive.** Un-merging means editing conversation history.

`identity_group_id` is set only by an explicit, founder-approved merge, or later by a customer volunteering a phone number that matches — a claim they made themselves. Never by a heuristic on names. Analytics AI reports per-contact and per-channel; a de-duplicated "unique humans" figure is a reporting-layer estimate with an error bar, not a change to the contact model.

---

## 3.12 The verification handshake with many tenants on one endpoint

`GET /api/meta/webhook/[app]?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`

The handshake is **per Meta app, not per tenant**. Meta calls it once when the callback URL is configured in the App Dashboard — never per Page. Subscribing a Page is a separate API call involving no handshake.

- **The handshake must not touch the database.** It knows nothing about tenants and must work before any tenant exists. It reads `META_VERIFY_TOKENS` (a JSON map `{app_slug: token | token[]}`) and nothing else. This handler makes no reads at all, which is a better defence against the Next caching trap than relying on the file's method exports.
- **Compare constant-time.** The ancestor uses `token === expected` (`api/messenger.js:65`, verified); `===` short-circuits on the first differing byte. Compare SHA-256 digests with `timingSafeEqual` — equal-length inputs, no length leak, free.

Failures: mode not `subscribe`, token mismatch, unknown `[app]` slug, or `META_VERIFY_TOKENS` missing → **`403`, always**, with `counter('webhook.verify_failed', { app_slug })`. A missing config is a 403, never a pass.

Rotating a verify token: add the new value alongside the old (the map value may be an array), re-verify in the App Dashboard, drop the old.

---

## 3.13 Cutover for tenant #1

The draft treated this as a scheduling question in an open-questions list. It is a design problem with two distinct catastrophic shapes, and the critique is right that neither is caught by anything else in this section.

**`POST /{page-id}/subscribed_apps` is additive, and both subscribers get the real event — MEASURED 2026-09-07 (D-043).** A Page can have several apps subscribed simultaneously, and Meta delivers the identical event to every one of them. This was asserted here from a wrong citation to §3.10.5 (rate-limit backoff) and has since been measured directly: tenant #0's Page subscribed to both `dalatech` and `DALA_AI`, one real message, delivered to `DALA_AI` in `entry.messaging` with `has_standby: false`. **A second subscriber is not a Handover demotion.** What the measurement does not cover is a Page that has a primary receiver configured — see §3.7, whose branch stands. Matrix Eco Salon is live *today* on the Matrix-Chatbot deployment, subscribed with `subscribed_fields=messages,messaging_postbacks` (`MESSENGER_SETUP.md:65-72`, verified). On the day Dala AI subscribes to that Page:

- **Shape 1 — double reply.** Every customer message produces two Anthropic calls and two replies from two systems. Dala AI's entire idempotency apparatus is internal to Dala AI and cannot see the old deployment's send: the dedupe layers are all in the wrong process. Worse, with echoes subscribed the old system's outbound reply arrives at the new system as a normal echo and nothing looks anomalous.
- **Shape 2 — dark Page.** Unsubscribe the old app first, and if the new app does not yet hold **Advanced Access on `pages_messaging`**, webhooks arrive and every Send fails. Matrix goes dark with a healthy `last_webhook_at`, a healthy token probe, and no `190`.

**The runbook, as one transaction with two-sided verification:**

1. `DELETE /{page-id}/subscribed_apps` with the **old** app's Page token.
2. `GET /{page-id}/subscribed_apps` queried with **each** app's token independently — the old app must be absent from the list, verified from a token that would still see it if it were present.
3. Only then may the Dala AI channel leave `probing` for `active` (§3.2.5 step 6), which itself requires a real message routed and a reply delivered.
4. `channel_dual_subscribed` is a **founder page** in §3.14, raised whenever step 2's check finds more than our own app.

### 3.13.1 Adding the mirror subscription without touching the incumbent's

The runbook above *removes* the old app. The mirror phase does not: it adds `DALA_AI`
alongside `dalatech` and leaves the incumbent exactly as it is for fourteen days. Since
D-043 measured that both subscribers receive the real event, this is the whole mechanism —
there is no forwarding hop to build.

**Do it by API, not through the App Dashboard.** On 2026-09-06 the console's *Add Page*
flow took Matrix's live bot offline for ten minutes. The picker is not an "add" control: it
writes the **complete set** of Pages granted to that app, so a Page that is not re-selected
is revoked, its subscription dies, and the ancestor stops receiving webhooks with no error
anywhere. It is the same trap as `subscribed_fields` — **a replacement presented as an
addition** — and the two are the only writes in this section that behave that way.

The grant step cannot be avoided entirely: `DALA_AI` must be granted access to Matrix's
Page by a Page admin, and that grant happens in Meta's login UI. What changes is *which*
app's Page set is at risk. Granting Matrix's Page to `DALA_AI` rewrites **`DALA_AI`'s**
list, which today holds only tenant #0's Page. So the worst case of a mis-clicked picker
there is that **our own test Page goes dark, not Matrix's**. Select both.

**The write.** One call, and the fields are the tenant's, not a copy of the incumbent's:

```bash
curl -X POST \
  -F 'subscribed_fields=messages' \
  -F 'access_token=<Matrix Page token ISSUED BY DALA_AI>' \
  'https://graph.facebook.com/v25.0/1520409424715591/subscribed_apps'
# => {"success": true}
```

**There is no app parameter.** The app is implied by which app issued the token, and that
is the entire safety model: a token pasted from the wrong place aims the write at the wrong
app's subscription and Meta reports success. `messages` alone is what
`tenant_channels.subscribed_fields` holds for tenant #0 and all the mirror needs; the
ancestor's own list is `messages,messaging_postbacks`, and it is irrelevant here because
this call cannot see it.

**Pre-flight — four reads, in this order, before the POST.**

1. **Which app issued this token.** The one check that matters.
   ```bash
   curl -G 'https://graph.facebook.com/v25.0/debug_token' \
     --data-urlencode 'input_token=<the token you are about to use>' \
     --data-urlencode 'access_token=1562862634970492|<DALA_AI app secret>'
   ```
   `data.app_id` must read **`1562862634970492`**. If it reads `1380702870025418`, the
   token is `dalatech`'s and the POST would **rewrite the incumbent's field list on their
   live Page**. Abort. Nothing later in this list protects against that; this is the check
   that does. (`data.profile_id` should name the Page too — **[UNVERIFIED field name]**;
   `app_id` is the one to decide on.)
2. **Which Page this token is for**, read independently of step 1:
   ```bash
   curl 'https://graph.facebook.com/v25.0/me?access_token=<the token>'
   # => {"id":"1520409424715591","name":"…"}
   ```
   The id must be the Page id you are about to put in the POST URL. This matters because a
   **User** token also authorises the call and would let the URL alone decide which Page's
   list is written.
3. **The app-level subscription exists for `messages` on `DALA_AI`** (§3.10.6): a
   page-level subscribe returns `{"success": true}` even when the app has never enabled the
   field on the `page` object, and no events are ever delivered.
   ```bash
   curl 'https://graph.facebook.com/v25.0/1562862634970492/subscriptions?access_token=1562862634970492|<DALA_AI app secret>'
   ```
   Tenant #0 receives `messages` today, so this should already pass; run it anyway, because
   the failure it catches is silent.
4. **The incumbent's list, from the incumbent's own token**, kept as the before-picture:
   ```bash
   curl 'https://graph.facebook.com/v25.0/1520409424715591/subscribed_apps?access_token=<Matrix Page token issued by DALATECH>'
   ```
   Run it again after the POST. If it changed, stop and restore. Reading it from
   `dalatech`'s own credential is the point — a token that would still see the subscription
   if it were there.

**Learn how to read step 4's response on tenant #0's Page first.** Whether
`GET /{page-id}/subscribed_apps` enumerates *all* subscribed apps or only the caller's is
**[UNVERIFIED]**, and tenant #0's Page is currently subscribed to both apps, so one read
there answers it at zero risk and tells you what "unchanged" looks like before it matters.

**Rollback** is the same asymmetry: `DELETE /{page-id}/subscribed_apps` with the
**`DALA_AI`** Page token removes `DALA_AI`'s subscription and cannot reach `dalatech`'s.

**What can still go wrong, and what it costs.** If Matrix's Page has a primary receiver
configured, `DALA_AI` lands in `entry.standby`, `worker/reception.ts` refuses it terminally
and alerts once a day (§3.7). That is a mirror that generates nothing — not an outage, and
not something that can reach a customer, because the channel is `shadow` and
`channel/delivery.ts` refuses the send on a positive allow-list. One message tells you.

**Echoes, if the comparison corpus is wanted later**, are a change to `DALA_AI`'s own
subscription row — `subscribed_fields=messages,message_echoes` on the call above, plus
`message_echoes` enabled at app level per step 3. It does not modify the incumbent's
subscription and does not require the ancestor to be reconfigured, so it is a smaller
decision than "a subscription change on their live Page" makes it sound. The ancestor's own
setup doc says not to subscribe echoes (`MESSENGER_SETUP.md:55-72`); that instruction is
about `dalatech`'s subscription and does not bind ours.

---

**Seriously consider reusing Matrix-Chatbot's existing Meta app as `dala-legacy`.** The `META_APP_SECRETS` map and the `meta_app_slug` column already support it; this converts "restart a ~20-day App Review with tenant #1 offline" into "add a second secret to a JSON env var". The section builds the multi-app machinery and the draft never used it for the one case that needs it.

Two qualifications the critique did not state and the founder must hear: reusing the legacy app helps **tenant #1 only** — it shortens nothing for tenants #2 and #3, who still require Advanced Access on the main app — and it permanently couples tenant #1's fate to whatever access state that legacy app holds. It buys time; it does not remove the App Review critical path (§3.17 Q7).

---

## 3.14 Consolidated failure modes

| Hop | Failure | Detection | Response | Alert |
|---|---|---|---|---|
| H1 | Body > 1 MB | size | 413 | rate-limited |
| H2 | Signature missing/invalid | HMAC | 401 | on a burst |
| H2 | App secret env missing | boot check | 401 + refuse to serve | page |
| H2/H4 | `meta_app_slug` ≠ `matched_app_slug` | post-resolution check | drop entry, `app_mismatch` | page |
| H3 | Unknown `body.object` | adapter miss | 200, counter | daily digest |
| H4 | **Unknown `entry.id`** | registry miss | **200 + drop + quarantine**, `tenant_unrouted` | page on first sight per id |
| H4 | Resolved only via messaging-level id | secondary path | **`routed_provisionally`, held, NOT enqueued** | `routing_needs_confirmation`, once per id |
| H4 | `entry.id` and `recipient.id` → different tenants | cross-check | **refuse the entry**, `routing_ambiguous` | page |
| H4 | Second tenant claims a bound id | unique/EXCLUDE violation at onboarding | onboarding refuses, `channel_already_claimed` | founder adjudicates; never "most recent wins" |
| H4 | Page transferred (salon sold) | manual | one transaction: retire rows, insert new, `channel_transfers` row, bump `bindings:version` | logged |
| H4 | Offboarded page still delivering | `status='offboarded'` | 200, no work; reconciler unsubscribes after 7 days; identity rows stay `active` so the id is a *known* state | daily digest |
| H5/H7 | **Event arrives in `entry.standby`** | classifier | persist `standby_not_primary`; H11 refuses; **channel cannot activate** | **page**, once per channel |
| H7 | Publish fails, insert holds | publish error | 200; sweeper re-publishes | alert if the sweeper finds rows |
| H7 | Publish times out (ambiguous) | timeout | 200; sweeper re-publishes, same `deduplicationId` | none |
| H7 | Insert fails, publish holds | insert error | 200, `webhook.persist_deferred`; worker inserts | digest |
| H7 | **Both floors fail** | both | **500**, `webhook.durability_lost` | **page immediately** |
| H7 | Duplicate delivery, same tenant | unique violation | 200, `event.duplicate` | none |
| H7 | **Duplicate delivery, different tenant** | global unique + tenant compare | refuse, `event_key_cross_tenant` | **page** — proof of a routing bug |
| H9 | Bad QStash signature | receiver | 401 | on a burst |
| H11 | Token missing | no row | 503 `tenant_not_provisioned` | page — onboarding incomplete |
| H11 | **Token revoked (`190`)** | Graph error | terminal; halt channel outbound; persist inbound; Quality flags all | **page** |
| H11 | **Token expiring (IG Login, day 30)** | `refresh_after` | refresh job acts | warn |
| H11 | Human replied from the inbox | echo / thread control | `human_has_thread` cooldown, no spend | none |
| H11 | Window closed / too old / private-reply expired | timestamps | terminal, **no spend**, Quality flag | digest |
| H11 | Redis unavailable | limiter error | **503**, retry. Never spend unmetered | page |
| H11 | Budget exhausted | ledger | per-tenant policy | notify tenant + founder |
| H13 | Anthropic 5xx / timeout / 429 | classify | retryable → 503 | digest; page on sustained |
| H13 | Anthropic 401 / credit exhausted | classify | **terminal** — no retries. The ancestor burns 4 attempts (`lib/messengerProcess.js:100-108`) | **page** |
| H14 | Send `613` | classify | back off *this tenant*; re-send stored text | digest |
| H14 | Send `200`/`10`/`100` | classify | terminal; `channel_permission_error` | **page** — a lost scope or task role |
| H14 | Send `230` / `9010` | classify | terminal, quiet; mark contact unreachable | none |
| H14 | Worker dies mid-send, lease expires | lease | `indeterminate`, **do not re-send**, Quality flag | digest |
| H14 | Private reply `2534014` | classify | **success-equivalent** | none |
| — | Channel silently unsubscribed by Meta | `last_webhook_at` + reconciler | auto re-subscribe | page |
| — | **App-level field never enabled** | `GET /{app-id}/subscriptions` | refuse activation / alert | page |
| — | **Page subscribed to two apps** (cutover) | `GET /{page-id}/subscribed_apps` per token | block activation, `channel_dual_subscribed` | **page** |
| — | Graph version drifted or expired | **`facebook-api-version` response header** compared on every call | — | page |

### 3.14.1 The alert path itself

`ops_alerts (tenant_id, code, severity, first_seen_at, last_seen_at, count, resolved_at)`, deduped by `(tenant_id, code)`, so a dead token pages once and then becomes a counter. Delivery on **two independent channels**, one of which is push — because the sibling's Brevo incident is the canonical lesson: **a 2xx from an email provider means "accepted for delivery", never "delivered"**, and a send from an unauthenticated domain returns 2xx and is silently dropped. Log the provider's message id on every alert send, so a dropped alert is traceable in the provider's own log.

Add a **daily heartbeat** — a message that arrives when nothing is wrong. The failure mode this whole section is built around is *absence of signal*, and an alert channel that is itself silent is indistinguishable from a healthy system.

### 3.14.2 Constraining the Quality-layer pipe

"Quality-layer flag" is the terminal action of roughly a dozen refusal paths above, and the Quality layer is the one component whose natural query shape has no `tenant_id` in it. The critique is right that this section owns the pipe even though it does not own the layer, and should constrain what goes down it:

- **The Quality job runs per tenant, through `withTenant()`, like everything else.** The founder's cross-tenant *view* is a read-only union at the reporting layer, never the generation input. Written cross-tenant, a drafting prompt for Matrix would contain GS Auto's `blocked_no_token` backlog, and the founder-approval step would not catch it — the proposal reads as reasonable Mongolian text about a service, and nothing on screen says whose customer asked.
- **`kb_change_proposals` carries `tenant_id`**, and its link table to source events carries a composite FK `(tenant_id, source_event_id) references inbound_events (tenant_id, id)`. A proposal citing another tenant's event cannot be inserted at all. That is the one check that still fires under `BYPASSRLS`.

---

## 3.15 What must be verified before this becomes code

Ordered by how much of the design depends on it. **A search summary is not a migration applied to the database.**

1. **The Handover Protocol delivery semantics** — that a secondary receiver's messages arrive in `entry[].standby`, and what `messaging_handovers` carries. §3.7 is built on it and it is the highest-impact silent failure in the section. **Half-answered 2026-09-07 (D-043):** two apps subscribed to the same Page both receive `entry.messaging`, so *being the second subscriber* does not demote you. Still open: what a Page with the Page Inbox app set as primary receiver actually delivers, which is the case §3.7 describes and the one the branch exists for.
2. **The Instagram messaging webhook payload — what `entry[].id` is under each auth flavour.** Tenant routing depends on it and my sources disagree with production code. Mitigated by the probe (§3.2.5), which is why the probe is mandatory.
3. **Whether an Instagram-Login user token really carries a hard 60-day life and the `ig_refresh_token` refresh path**, and whether a Page token derived from a **System User** token inherits never-expiry. Together these determine whether a refresh job exists and for which flavours.
4. **Meta's webhook retry schedule and the exact unsubscription threshold.** No longer a blocker — §3.1 H7's two floors remove the dependency — but it prices the `webhook.durability_lost` alert.
5. **The `facebook-api-version` response header name**, and whether an expired version silently falls back. §3.10.4 is load-bearing if it does.
6. **Private reply: subcode `2534014`, and whether the 7-day clock starts at comment creation or webhook receipt.**
7. **`GET /{app-id}/subscriptions` shape**, and the public comment-reply edge (`POST /{comment-id}/comments` vs `POST /{comment-id}`).
8. **The exact subscription call for Instagram Login** (`POST /{ig-user-id}/subscribed_apps`?).
9. **Whether `entry[].messaging` can hold more than one element.** (Written as a loop regardless.)
10. **Current Messenger/Instagram error table** — the outside-window code specifically, plus `190` subcodes.
11. **Which limiter headers actually appear on Send API responses** (§3.10.3 measures this from production rather than asking).
12. **QStash named queues with per-queue parallelism.** If absent, the Redis semaphore is the only concurrency control.
13. **Whether Dala AI needs Tech Provider status** or only Business Verification + Advanced Access. Tech Provider is a months-long track.

And before any of it ships: run the catalog verification pack (V1–V9) after **every** grant/policy migration, read every row, and check each table independently. The last failure next door was partial — one of four tables — and a spot check on the correct one confirmed the wrong conclusion. `supabase_migrations.schema_migrations` will freeze on this project too the moment one migration is applied through the dashboard editor; do not build the habit of consulting it.

---

## 3.16 Open questions — the founder's call

1. **Is Customer Care AI SMS-only, or does Dalatech commit to the Marketing/Utility Template approval track on Messenger?** The tags it would have used died 2026-04-27; `HUMAN_AGENT` forbids AI-authored text. The compliant Meta path is approval-gated, category-constrained and possibly per-message priced — a second product surface with its own App Review, not a feature toggle. If the answer is SMS-only, Customer Care does not exist until the Mongolian SIP trunk does, and that should be said out loud in the roadmap rather than implied by a gate.

2. **One Meta app, or a small number sharded by tenant cohort?** The schema supports both (`meta_app_slug` on the channel, a *set* of secrets in `META_APP_SECRETS`), and §3.13 gives an immediate reason to run two. One app means one shared hourly budget, one App Review verdict, and one blast radius: a policy strike takes down every tenant at once.

3. **Partner access or Facebook Login for Business as the house onboarding shape?** This is now more than an onboarding-friction question. It decides the Instagram auth flavour, the scope vocabulary, the send host, **whether a 60-day token-refresh job exists at all** (§3.4.3), and — because Business Use Case budgets are keyed to the owning business — which Meta limiter governs the hot path (§3.10.2). Partner access is durable and survives staff turnover but needs each Mongolian SMB to have a Business Portfolio and an admin who can navigate Business Settings. Facebook Login is two clicks and dies when the owner changes their password.

4. **What is a tenant's monthly AI ceiling, and what happens at zero?** Hard stop (Messenger goes silent mid-conversation, on a Saturday), degrade to a canned Mongolian "we'll come back to you", or auto-overage-bill. The H11 gate cannot be finished without this number. The middle option is the only one that is neither a broken product nor an unbounded bill, but it needs a pinned, natively-reviewed Mongolian sentence per tenant — a `canned_responses` row and a review step, not a string literal.

5. **When a page token dies at 2 a.m., who is woken, on what channel, and what is the promised time-to-restore in the tenant contract?** The technical detection is designed above; the human half is a business commitment.

6. **Are comment replies in v1 scope?** They expand the App Review surface (`pages_manage_engagement`, `instagram_manage_comments`), add per-event enrichment calls against each tenant's rate budget, put the bot's words on the tenant's public wall, and bring the whole loop-prevention apparatus of §3.8.2. DM-only first is a defensible v1 that ships months earlier.

7. **Does GS Auto Center wait for App Review, or do the first two tenants run under a narrower footprint?** Business Verification of a Mongolian legal entity plus ~20-day App Review is the critical path to Advanced Access. Running tenant #1 on its own Page under Standard Access — via the `dala-legacy` app of §3.13 — buys time at the cost of a second migration later.

8. **Do we subscribe `message_echoes`?** §3.7.3 says yes, defaulting on: it is the only detector for a receptionist replying from the inbox, and it is required for the Instagram routing cross-check. The cost is roughly double the inbound webhook volume and it contradicts the ancestor's explicit instruction (`MESSENGER_SETUP.md:63`). It is per-tenant config either way; the default is the founder's call.

9. **Does the founder's Quality layer run as `service_role` or as a scoped read-only admin role?** Reviewing conversations is inherently cross-tenant, so `service_role` is tempting — and it removes the last place RLS could catch a scoping bug in the founder's own tooling. A read-only `founder` role with a permissive `using (true)` SELECT policy costs one policy and keeps every write honest.