## 3. Meta webhook routing — one app, many pages

### 3.0 How to read this section

The ancestor at `/home/user/Matrix-Chatbot` is a *correct single-tenant webhook*. Its transport reasoning — verify over raw bytes, ACK before doing anything slow, hand off durably, never double-reply on an ambiguous failure — is the best thing in the repository and carries over almost intact. What does not carry over is that it has **no tenant at all**: it never reads `entry[].id` (`api/messenger.js:164-180` iterates `body.entry` and consumes only `entry.messaging`), it sends to `/me/messages` (`lib/messengerClient.js:10`), and its send credential is one global env var with a silent fallback (`lib/messengerClient.js:67-69`).

**Verification marks.** Everything cited as `path:line` I opened and read in this session. Meta's own documentation is unreachable from this machine (`developers.facebook.com` returns 403 on the CONNECT tunnel), so every platform claim carries one of:

- **[VERIFIED-LOCAL]** — read in a file here, line cited.
- **[CORROBORATED]** — two or more independent secondary sources agree, or one source is production code that was read (Chatwoot, `restfb`, `go-meta-webhooks`).
- **[UNVERIFIED]** — single source, or my own recall. **Not a fact.** Consolidated in §3.14.

Where a claim is uncertain, the design is built so the **system measures the truth rather than assuming it**. §3.2.4 (the nonce probe) and §3.5.3 (`debug_token`) are the two places this matters most: both replace a documentation question with an observation the running system makes for itself.

Internal failure codes are lowercase snake — `tenant_unrouted`, `token_revoked`, `not_primary_receiver`. One vocabulary across logs, counters, `ops_alerts.code`, and `inbound_events.state`. No per-site invention.

---

### 3.1 The request path, end to end

One deployment. One Meta app per callback path. `N` tenants, each with one or more channels.

```
Meta ──POST──▶ /api/meta/webhook/[app]
        H1  read raw bytes (no parser)
        H2  resolve [app] → app record; verify X-Hub-Signature-256   ── AUTHENTICITY
        H3  parse; dispatch on body.object
        H4  FOR EACH entry: resolve tenant from (object, entry.id)   ── IDENTITY
        H5  classify events inside the entry (msg / standby / comment / drop)
        H6  NFC-normalise; insert inbound_events (unique ⇒ dedupe)
        H7  publish {event_id} to QStash
        H8  200 to Meta                                     ◀── target p99 < 800 ms

QStash ──POST──▶ /api/meta/worker
        H9   verify Upstash signature over raw bytes
        H10  load inbound_events row by id — tenant re-derived from OUR row
        H11  gate: tenant → channel → credential → window → freshness
                   → app headroom → tenant rate → budget reserve
        H12  per-conversation mutex; load history + tenant knowledge
        H13  Anthropic call; persist reply text; settle spend_ledger
        H14  claim outbound_sends (lease); POST /{send_external_id}/messages
        H15  mark sent; append turn; release mutex; 200
```

The rule that shapes everything: **H1–H8 must not depend on anything slow and must not spend a cent.** All spend is behind H11, which runs identity → entitlement → budget in that order, each refusing on error.

#### H0 — Route shape and the Next.js caching trap

`app/api/meta/webhook/[app]/route.ts` exports `GET` (handshake, §3.13) and `POST`. Because it exports `POST`, Next 14.2's `hasNonStaticMethods` is true and `staticGenerationStore.revalidate` is set to 0 — so this file is not exposed to the GET-only caching trap documented in the sibling's `CLAUDE.md`. **That is an accident of this file's shape and must not be relied on anywhere else.** Every Supabase-JS client is constructed through `src/lib/supabase/fetch.ts` with `cache: 'no-store'`, and `scripts/check-supabase-nostore.mjs` is ported on day one.

Two notes that raise the stakes above the sibling's:

- A cached `channel_identity` read does not return stale data, it returns **another tenant's binding**, with HTTP 200 and `error: null`.
- The worker path (§3.3) uses a **direct Postgres connection, not PostgREST**, so it makes no `fetch` at all and is structurally outside the trap. The dashboard, the admin routes and the offboarding/reconciliation routes are inside it, and the reconciliation routes are the ones most likely to be written GET-only.

`[app]` is a slug, not a secret. Unknown slug → 401 at H2.

#### H1 — Read the raw body

Port `lib/rawBody.js` verbatim including the 1 MB cap (`lib/rawBody.js:10`). In App Router, `bodyParser: false` (`api/messenger.js:16-20`) becomes `await req.text()` **before** any `JSON.parse`, and nothing in `src/middleware.ts` may consume the stream first — `/api/meta/*` is excluded from the middleware matcher explicitly, because the sibling's open finding #7 is precisely a matcher swallowing a route nobody thought about.

| Failure | Response |
|---|---|
| Body > 1 MB | `413`, `webhook.body_too_large` |
| Stream error / truncated | `400`, `webhook.body_read_failed` (Meta retries) |

#### H2 — Authenticity

Port `verifyFacebookSignature` (`lib/messengerClient.js:25-42`) unchanged: `sha256=` prefix check, length check, `crypto.timingSafeEqual`, and **`return false` when the secret is absent** (`:26`). That last line is the whole posture: a missing secret is a 401, never "skip verification".

One change: `META_APP_SECRETS` is a JSON map `{ "<app_slug>": ["<current>", "<previous>"] }`. The `[app]` path segment selects the app record; the array exists so app-secret rotation is not a flag day. **An unknown slug is a 401 — we do not try every configured secret against it.** (The draft tried all secrets, Chatwoot-style; Chatwoot needs that because it has one shared callback URL. We give each app its own URL path, which makes the slug authoritative and makes the §3.4 app cross-check meaningfully stronger.) `matched_app_slug` is recorded on every accepted request.

App secrets are **app-level, not tenant-level**. They stay in the environment and never touch the database.

| Failure | Response |
|---|---|
| Header missing / not `sha256=` prefixed | `401`, `webhook.sig_missing` |
| HMAC mismatch against both of the app's secrets | `401`, `webhook.sig_invalid`; log the body's SHA-256, never the body |
| Unknown `[app]` slug | `401`, `webhook.unknown_app` |
| `META_APP_SECRETS` unset or unparsable | `401` **and** `startup.config_invalid` pages the founder. Never 200, never skip. |

#### H3 — Dispatch on `body.object`

```ts
const OBJECT_ADAPTERS = { page: pageAdapter, instagram: instagramAdapter } as const;
```

`api/messenger.js:99-101` (`body.object !== 'page'` → bare 200) is the single line that would make an Instagram rollout a silent no-op: the endpoint ACKs perfectly and answers nobody. Replace with a table lookup plus `counter('webhook.unknown_object', { object })` on a miss, still 200. An unrecognised object is a Meta product we have not built, not an attack.

#### H4 — Tenant resolution, per entry

§3.2. The invariant: **scoping is per `entry`, never per request.** One POST may carry entries for Matrix Eco Salon and GS Auto Center [CORROBORATED]. Failure on one entry does not affect the others.

#### H5 — Classify events inside the entry

Iterate `entry.messaging`, `entry.standby` and `entry.changes`. Write `entry.messaging` as a loop even if Meta documents at most one element [UNVERIFIED]. Carry the ancestor's three drop guards (`api/messenger.js:171-173`) and extend them:

| Condition | Action |
|---|---|
| `entry.standby` non-empty | **`event.standby`, its own counter, never folded into `event.unhandled`.** See below — this is the highest-severity classification in the table. |
| `message.is_echo` | drop, `event.echo` — **but record it**: for Instagram the echo's `sender.id` is a routing cross-check (§3.2.3) |
| `delivery` / `read` receipt | drop, `event.receipt` |
| sender id == the channel's own external id | drop, `event.self` — belt-and-braces beyond `is_echo`, as at `api/messenger.js:173` |
| attachment `type` in (`story_mention`, story reply) | **normal turn**, not media refusal. See below. |
| attachment `type` in (`image`,`video`,`audio`,`file`) with no text | `unsupported_media` → per-tenant canned reply + Quality flag (§3.6.4) |
| `changes[].field` in the channel's subscribed comment fields | comment pipeline (§3.8) |
| anything else | drop, `event.unhandled` with the field name in the counter |

**`standby` is the failure that certifies itself as healthy.** The Messenger handover protocol designates one app as **primary receiver** for a Page's threads; an app that is not primary receives inbound messages in `entry[].standby` rather than `entry[].messaging` [CORROBORATED]. Meta's own Page Inbox is an app and can hold primary receiver on any Page that has used Inbox features [UNVERIFIED whether that is the 2026 default]. So: onboarding completes, the token is valid, the subscription is live, `last_webhook_at` refreshes on every customer message, the §3.5.5 watchdog is green, `webhook.unrouted` is zero — and the bot answers nobody, forever. Every signal this design otherwise builds says fine.

Therefore: `standby` on a channel in `probing` is a **hard onboarding failure** with the named diagnosis `not_primary_receiver` and a remedy string in the UI (Page Settings → Advanced Messaging → Handover Protocol → set the Dala AI app as primary receiver). `standby` on an `active` channel that previously received `messaging` **pages the founder** — someone reassigned primary receiver, usually by opening Inbox. v1 detects the handover protocol and does not participate in it: we never call `take_thread_control`.

**Story replies and mentions must not be refused.** A large share of salon IG DM volume is story replies and story mentions, which arrive as messages carrying a story attachment, often *with* the customer's own text [CORROBORATED]. Answering "we can't read images, please call" to someone who wrote «энэ өнгө хэд вэ?» over the salon's story is a visibly broken bot. Classify on attachment `type`, never on absence-of-text. And persist **the fact that it was a story**, not the media URL: those URLs expire (~24 h [UNVERIFIED]), so a stored URL is a dead link by the time the founder reviews the Quality queue.

Dropping image-only messages the way the ancestor does (`api/messenger.js:174-175`, text only) is wrong for a salon anyway: "here's the colour I want" is a photograph, and silence is the worst possible answer.

#### H6 — Normalise and persist

NFC-normalise every piece of user text **at this boundary and nowhere else**. The ancestor never normalises anywhere — `grep -rn "normalize("` over the repo returns nothing — and the consequence is measurable: `'Байна уу'.normalize('NFD')` does not match `GREETING_REGEX` at `lib/salonIntents.js:26` while the NFC form does. Same customer, same message, different behaviour depending on their keyboard.

```sql
insert into inbound_events
  (tenant_id, channel_id, provider, kind, event_key, contact_external_id,
   occurred_at, received_at, payload, text_nfc, state)
values (...)
on conflict (tenant_id, provider, event_key) do nothing
returning id;
```

Rows returned are new; rows not returned are Meta redeliveries and are **not enqueued**. This is the idempotency authority (§3.6).

`occurred_at` carries a check constraint (§3.9.1) so a seconds/milliseconds unit error fails at the insert rather than silently at the send.

| Failure | Response |
|---|---|
| Conflict (duplicate) | not an error: `event.duplicate`, no enqueue, 200 |
| Postgres unavailable / insert throws | **`500`** — see below |

**Returning 500 on a persistence failure is deliberate.** Meta's own retry is the only durable buffer available at that moment and it is free. The cost is the [UNVERIFIED] ~1-hour continuous-failure threshold after which Meta disables the subscription **per asset**, requiring a manual re-`POST /{page-id}/subscribed_apps`. Acceptable because (a) if Postgres has been down for an hour the product is down anyway and unsubscription is not the marginal harm, and (b) the reconciler (§3.10.5) detects and repairs an unsubscribed channel automatically. The alternative — 200-and-drop — silently loses customer messages and produces no signal at all, which is the failure class this whole architecture exists to avoid.

#### H7 — Durable enqueue

Publish `{ event_id }` and nothing else. **The tenant id is not in the message body.** The worker re-derives it from our own row. This satisfies non-negotiable #1 structurally rather than by discipline, and it retires the concern the ancestor documents at `api/messenger-worker.js:45-52`: a signed QStash job that does not pin the URL claim is a valid job at any worker, so a body-carried `tenant_id` would become a cross-tenant primitive the moment a second worker endpoint exists.

`deduplicationId` = `${tenant_id}:${provider}:${event_key}`. The ancestor uses the bare `mid` (`lib/messengerQueue.js:66`) — fine at one tenant, a cross-tenant collision surface at N.

Publishes are batched and time-boxed with the ancestor's `withTimeout` (`api/messenger.js:29-41`) at **1200 ms**, not 4000 (`api/messenger.js:24`), because we no longer need slack for an inline fallback.

| Failure | Response |
|---|---|
| Publish hard-fails | 200. Row stays `state='pending_enqueue'`; the sweeper picks it up (§3.7.3). No inline processing. |
| Publish times out (ambiguous) | 200. Row stays `pending_enqueue`; the sweeper re-publishes with the same `deduplicationId`, so a landed-but-timed-out publish is deduped by QStash and again by the `outbound_sends` claim. This preserves the ancestor's insight at `api/messenger.js:118-133` — *an ambiguous failure is not a failure* — without needing the inline branch. |
| QStash unconfigured | boot-time refusal in production, `startup.queue_unconfigured`. Never a silent degrade — `qstashEnabled()` (`lib/messengerQueue.js:37-43`) degrades silently today, and `memoryEnabled()` (`lib/conversationStore.js:130`) exists to report the equivalent for Redis and is never called anywhere. |

#### H8 — ACK

Always 200 once persistence succeeded, even if everything after it failed. Hard handler deadline 2500 ms.

#### H9–H15

Worker authenticity ports `api/messenger-worker.js:27-59` including the deliberate non-pinning of the URL claim (`:45-52`) — with one worker URL that reasoning still holds and pinning would 401 legitimate deliveries from Vercel's internal host. `MAX_RETRIES` (`lib/messengerQueue.js:13`) and the `upstash-retried` → `finalAttempt` mapping (`api/messenger-worker.js:68`) are unchanged, but retries are issued only for *classified retryable* failures — the ancestor rethrows on any brain failure (`lib/messengerProcess.js:101-109`), so a missing API key burns four attempts and four round-trips before the fallback.

Two rules govern H13–H15:

- **Persist the generated reply before attempting the send.** A send retry re-sends stored text and never re-enters the model. Today the ancestor regenerates on every attempt: `generateSalonReply` at `lib/messengerProcess.js:95`, `markHandled` only after a successful send at `:116`.
- **The Send URL is `POST /{send_external_id}/messages`, never `/me/messages`.** `lib/messengerClient.js:10` hardcodes `/me/messages`, which resolves the Page *from the token*. In a multi-tenant port that is the most dangerous line in the file: a token/tenant mismatch does not error, it **succeeds and posts as the wrong salon**. With an explicit id in the path the same mistake produces a catchable error. `POST /{page-id}/messages` is a supported Send API form [CORROBORATED], so this costs nothing.

---

### 3.2 Tenant resolution

#### 3.2.1 Schema

```sql
create extension if not exists btree_gist;

create table tenant_channels (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id),
  provider                text not null check (provider in ('facebook_page','instagram')),
  auth_flavour            text not null check (auth_flavour in ('facebook_login','instagram_login')),
  meta_app_slug           text not null,
  credential_id           uuid not null,           -- N channels may share ONE credential
  send_host               text not null,           -- 'graph.facebook.com' | 'graph.instagram.com'
  send_external_id        text not null,           -- the id in POST /{id}/messages
  display_name            text not null,
  status                  text not null default 'pending'
                            check (status in ('pending','probing','active','draining',
                                              'suspended','offboarded')),
  probe_nonce             text,
  probe_opened_at         timestamptz,
  graph_version_override  text,
  subscribed_fields       text[] not null default '{}',
  business_id             text,
  last_webhook_at         timestamptz,
  last_messaging_at       timestamptz,             -- distinct from standby arrivals
  last_subscription_ok_at timestamptz,
  created_at              timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, credential_id) references tenant_credentials (tenant_id, id)
);

create table channel_identity (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null check (provider in ('facebook_page','instagram')),
  external_id       text not null,
  tenant_id         uuid not null,
  channel_id        uuid not null,
  id_kind           text not null check (id_kind in
                      ('page_id','ig_user_id','ig_linked_page_id','observed_entry_id')),
  source            text not null check (source in ('onboarding_api','routing_probe','founder_manual')),
  verified_at       timestamptz,
  superseded_at     timestamptz,
  superseded_reason text,
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, channel_id)
    references tenant_channels (tenant_id, id) on delete restrict
);

-- one LIVE identity per (provider, external_id)
create unique index channel_identity_live
  on channel_identity (provider, external_id) where superseded_at is null;

-- and no external_id may be live under two different tenants, across providers
alter table channel_identity add constraint one_tenant_per_external_id
  exclude using gist (external_id with =, tenant_id with <>) where (superseded_at is null);

create index on channel_identity (channel_id);
```

Four constraints do the security work:

- **`channel_identity_live`** — one live identity maps to exactly one channel. No "most recent wins", no upsert, no tie-break. A second tenant claiming a bound id fails at onboarding, not at 2 a.m. in the routing path.
- **`one_tenant_per_external_id`** — the same numeric id may be held by one tenant under two providers (an IG channel legitimately stores both the IG user id and the linked Page id) and may never be live under two tenants.
- **`superseded_at`** — the draft's failure table contradicted itself: it required a transfer to insert a new binding *and* required the old identity row to be kept so an offboarded page does not become a permanent unknown-id alert. Those are mutually exclusive under a plain PK. The partial index resolves it: history is retained, the id is re-bindable, and the constraint still forbids two live claims.
- **The composite FK `(tenant_id, channel_id)`** — an identity row can never point at another tenant's channel. This is the one integrity check that still fires against a bug in worker code, because referential integrity is not subject to RLS.

Multiple live rows per channel are normal. An Instagram channel typically has three — IG user id from onboarding, linked page id as fallback, observed entry id from the probe. **Match either; the routing key is whatever arrived.**

#### 3.2.2 The lookup, and cache invalidation that does not depend on the cache

```ts
async function resolveEntry(object, entryId) {
  const provider = object === 'page' ? 'facebook_page' : 'instagram';
  const key = `route:${provider}:${entryId}`;              // NOT tenant-prefixed: it is pre-tenant
  const hit = await redis.get(key);                        // +30s positive, 10s negative
  if (hit === NEGATIVE) throw new Unrouted(provider, entryId);
  if (hit) return hit;
  const row = await db.channelIdentity.findLive(provider, entryId);
  if (!row) { await redis.setex(key, 10, NEGATIVE); throw new Unrouted(provider, entryId); }
  await redis.setex(key, 30, row);
  return row;
}
```

The negative cache is short so a channel bound during onboarding routes within seconds while an unknown id under a comment storm does not hammer Postgres. If Redis is unavailable, fall through to Postgres: resolution is a *read*, and failing it closed drops legitimate traffic. The fail-closed posture belongs on the spend path, not here.

**The stale-binding window is closed by a drain state, not by a purge.** The tenant-leak critique is right that a 60-second positive TTL with no invalidation hook means a rebind mis-attributes messages for up to a minute — persisted under the wrong `tenant_id`, answered from the wrong knowledge base, charged to the wrong ledger, and every downstream layer faithfully following. Its proposed fix (an epoch counter plus a purge job) is more machinery than needed. The rule instead:

> **Any change to a live `channel_identity` row goes through one admin transaction that (1) sets `superseded_at` on the old row and moves the old channel to `draining`, (2) purges the specific `route:` keys, and (3) refuses to activate the new binding until `positive_ttl + 30 s` has elapsed.** The purge is the belt; the drain window is the braces, and the drain window is what makes it correct when the purge silently fails.

#### 3.2.3 What `entry[].id` actually contains

| `body.object` | `entry[].id` | Mark |
|---|---|---|
| `page` | the Facebook **Page ID** | [CORROBORATED] — consistent across every source and with the ancestor's operation |
| `instagram` | the **Instagram professional account ID** (`17841…` shape) — not the linked Page ID, not the consumer's IGSID | **[UNVERIFIED]** under *both* auth flavours. Chatwoot, a production multi-tenant inbox, reads `entry.id` but resolves its channel from `messaging.sender.id` (echoes) / `messaging.recipient.id` (inbound), and maintains two channel tables keyed by `instagram_id` with an explicit priority rule. A serious implementation does not trust the invariant blindly. |

The routing rule, written to be correct under either answer:

```
for entry of body.entry:
    binding = resolve(body.object, entry.id)
    if !binding:
        for m of entry.messaging ?? []:
            candidate = m.message?.is_echo ? m.sender?.id : m.recipient?.id
            binding = resolve(body.object, candidate)
            if binding: counter('webhook.routed_by_messaging_id'); break
    if !binding: REFUSE (§3.2.6)
    for m of entry.messaging ?? []:                       # cross-check even on a hit
        expected = m.message?.is_echo ? m.sender?.id : m.recipient?.id
        if expected && expected != entry.id:
            counter('webhook.entry_id_mismatch', {provider, channel_id})
            if resolve(body.object, expected) is a DIFFERENT channel:
                REFUSE the entry; alert routing_ambiguous          # never guess
```

**The meta-reality critique is right that this fallback is not an independent mitigation, and the section must not read as though it is.** The known Instagram problem is not that `entry.id` and `recipient.id` disagree with each other — it is that both may carry an id from a *different family* than the one onboarding stored from `instagram_business_account{id}`. In that case the secondary lookup misses identically and contributes nothing. So, stated plainly:

> **The routing probe (§3.2.4) is the sole mitigation for the Instagram id-family question. It is mandatory, not polish.** `tenant_channels.status='active'` is unreachable for an `instagram` channel without at least one probe-matched `observed_entry_id` row.

The fallback stays because it costs nothing and catches the *other* mismatch. `webhook.routed_by_messaging_id` or `webhook.entry_id_mismatch` firing in production pages the founder on first occurrence: both mean documentation and reality have diverged and the answer must be written down.

The **ambiguity refusal** is the important half. If `entry.id` and `recipient.id` resolve to two different tenants, we do not pick one. That is the only condition under which a routing bug becomes a cross-tenant message leak, and there is no defensible tie-break.

#### 3.2.4 The routing probe — challenge/response, not pick-from-a-list

Both critiques independently found the same hole, and they are right: the draft's probe was the one place in the design where a `channel_identity` row — the root of trust that non-negotiable #1 exists to protect — was created from a value that arrived in a request body, gated only by a human confirming an opaque 17-digit number they have no way to verify. Once the app is Live with Advanced Access, *any* Page admin can grant the app their Page and their webhooks are HMAC-valid; a burst timed into an open probe window puts a stranger's id at the top of the list, and a mis-click permanently binds a stranger's Page to Matrix Eco Salon, after which every constraint in §3.2.1 faithfully enforces the wrong binding.

The probe is therefore a nonce challenge:

1. **Discovery (never `/me/accounts`).** From Dalatech's System User token: `GET /{business-id}/owned_pages` and `GET /{business-id}/client_pages` [CORROBORATED]. `GET /me/accounts` is the `information_schema.role_table_grants` of the Meta API — for a Page owned by a Business Portfolio accessed through a business role it returns an **empty array with HTTP 200** [CORROBORATED], not an error. It may appear in the onboarding UI as a convenience; it is never the source of truth and empty is never "no pages".
2. **Credential.** `GET /{page-id}?fields=name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}` with the System User token. Store the Page ID (`page_id`), every Instagram id returned (`ig_user_id`), and the Page ID again under `provider='instagram', id_kind='ig_linked_page_id'`. Encrypt and store the token (§3.5). Immediately `debug_token` it (§3.5.4) and record `profile_id`.
3. **Subscribe.** `POST /{page-id}/subscribed_apps` with the channel's field list — the ancestor's `MESSENGER_SETUP.md:65-72` curl, parameterised by tenant. Record the response into `subscribed_fields`.
4. **Probe.** `status='probing'`; `probe_nonce` is minted (e.g. `DALA-7F3K2`, ASCII, alphabet excluding `O/0/I/1`) and shown in the onboarding UI with the instruction *"send this exact code as a DM to the Page and to the Instagram account."* At H4, an unrouted entry's `text_nfc` is matched **in memory** against every open probe nonce with `text.normalize('NFC').toUpperCase().includes(nonce)` — no `\b`, no `[a-z]`, no regex over user text at all. Exactly one match binds; zero or two matches never bind. The candidate is inserted with `id_kind='observed_entry_id', source='routing_probe', verified_at=now()`. Only a boolean is stored (§3.2.6): the message text never lands in a tenant-less table.
5. **Activate.** `status='active'` only after a probe-matched message event routed end to end *and* a reply was delivered — and, if comments are in scope, one comment event routed too. Onboarding is not "config saved"; it is "an observed webhook matched and a reply arrived on a phone."

**The probe timeout has a named diagnosis, and this is the second thing both critiques got right.** Instagram messaging through a third-party app requires, on the tenant's side and only in the Instagram mobile app, that the account is Professional, is linked to the Facebook Page, and has the connected-tools / "Allow access to messages" switch **on** [CORROBORATED that a toggle exists and gates delivery; **[UNVERIFIED]** its current label]. With it off, every API call succeeds — `subscribed_apps` returns success, the token debugs clean, the Page reports a linked `instagram_business_account` — and **zero IG webhooks are delivered**. The probe then hangs at `probing` forever and the only artefact is silence, which `unrouted_events` has no vocabulary for, because nothing arrived to be unrouted.

| What we observed in the window | Diagnosis | Remedy shown |
|---|---|---|
| nothing at all for this app | `no_delivery` | FB: re-run `subscribed_apps`, confirm the Page. IG: the connected-tools switch, Professional account, Page link — as a config string, so the menu path can be corrected without a deploy |
| events arrived in `entry.standby` | `not_primary_receiver` | Page Settings → Advanced Messaging → Handover Protocol |
| events arrived unrouted, no nonce present | `nonce_absent` | "send the code exactly as shown" |
| events routed to an existing live binding | `already_bound_elsewhere` | founder adjudicates; never auto-rebind |

**Onboarding client #3 is still filling in a form.** Steps 1–3 are API calls driven by that form; step 4 is typing a five-character code into two apps. No code branch anywhere distinguishes a salon from an auto shop.

#### 3.2.5 Page transfer, offboarding, and why a transfer mints a new channel

The tenant-leak critique is right that the draft's transfer path leaked three ways — the route cache, PSID-keyed history, and surviving `contacts` rows — and that PSIDs being page-scoped does *not* separate the old and new owners of the **same** page. Its fix was a purge job. The cheaper and more reliable fix is a rule:

> **A transfer never mutates a `tenant_channels` row's `tenant_id`. It supersedes the identity, offboards the old channel, and creates a new channel row for the new tenant.**

Because every Redis key and every child row is prefixed with `channel_id` (§3.3.3), the previous owner's history and contacts become *unreachable* rather than needing deletion. Purging them is then a data-retention obligation on a schedule, not a correctness mechanism that must not fail. The one transaction: supersede the identity row, set the old channel `draining` → `offboarded`, purge the `route:` keys, wait out the drain window, insert the new channel + identity, run the probe. Anything less is a `update channel_identity set tenant_id = …` in the Supabase SQL editor — which is exactly the habit `CLAUDE.md` records this project already having for migrations.

An **offboarded page still delivering** is answered 200 with no work, `channel_offboarded`, and the reconciler unsubscribes it after 7 days. Its identity row is kept (superseded) so the id is a known state rather than a permanent unknown-id alert.

#### 3.2.6 What "refused" means

An unknown `entry.id` is refused. Precisely:

- **HTTP 200 to Meta.** Not 404, 400 or 500. Repeated non-2xx gets the *asset* unsubscribed [UNVERIFIED threshold], and an unknown id is by definition not an asset we can repair by being noisy at Meta.
- **Nothing processed.** No enqueue, no model call, no send, no spend, no tenant guessed. **There is no `?? DEFAULT_TENANT` in this codebase, in any environment, including local development.** A fallback written "just for testing" is the single most likely origin of a cross-tenant leak.
- **`counter('webhook.unrouted', { provider, app_slug })`** and a log line carrying the id. A Page/IG account id is public; the payload is not.
- **Quarantined, without customer text.**

```sql
create table unrouted_events (
  provider    text not null,
  external_id text not null,
  app_slug    text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  count       bigint not null default 1,
  shape       jsonb not null default '{}',   -- {object, fields[], items[], verbs[], key_names[]}
  nonce_matched_channel_id uuid,             -- set only by an in-memory probe match
  expires_at  timestamptz not null default now() + interval '7 days',
  primary key (provider, external_id)
);
revoke all on unrouted_events from anon, authenticated;
```

The draft stored `sample_payload jsonb`. The tenant-leak critique is right to kill it: any transient unbinding routes a *live tenant's* customer DMs into a table with no `tenant_id`, no RLS story, and no restrictive per-command deny, and then renders them in an onboarding UI. **Store the shape — object, field, item, verb, key names — never the values.** Add the table to the catalog verification pack and to the `revoke all` list.

Caps: 500 distinct ids, 7-day TTL, upserted by `(provider, external_id)` so a storm produces one row with a counter. First occurrence per id pages the founder once through `ops_alerts` (§3.13.1); thereafter it is a dashboard number. **Never auto-create a tenant from a webhook. Not behind a flag, not in staging.**

---

### 3.3 The isolation mechanism (this is what actually protects the hot path)

RLS protects the dashboard and protects **nothing** on the path that carries all the volume and all the spend: there is no user session anywhere between the Meta webhook and the Send API. The draft acknowledged this and then relied on `withTenant()` as a convention plus composite FKs. The tenant-leak critique is right that this is not a mechanism: composite FKs constrain writes that reference a parent, and do nothing for **reads**, nor for writes into tables with no tenant-scoped parent (`inbound_events`, `spend_ledger`, `ops_alerts`). One forgotten `.eq('tenant_id', …)` in a Quality-layer or reprocess route returns every tenant's rows with HTTP 200 and `error: null` — the project's own thesis failure, reproduced at the layer that matters most.

#### 3.3.1 A worker role that does not bypass RLS

```sql
create role dala_worker login;               -- NOT bypassrls, NOT superuser
grant usage on schema app to dala_worker;
grant select, insert, update on <tenant tables> to dala_worker;
-- no delete, no truncate, no references, no trigger, no maintain

create policy worker_tenant_scope on inbound_events
  for all to dala_worker
  using      (tenant_id = current_setting('dala.tenant_id')::uuid)
  with check (tenant_id = current_setting('dala.tenant_id')::uuid);
```

`withTenant(tenantId)` opens an **explicit transaction** and issues `set local dala.tenant_id = '<uuid>'` before handing out a connection. `set local` is transaction-scoped and therefore pooler-safe in PgBouncer transaction mode; the RLS research's warning was about session-scoped `set`, which we never use.

Note the deliberate omission of the `missing_ok` argument: `current_setting('dala.tenant_id')` with the GUC unset **raises**, aborting the query, rather than returning null and silently matching zero rows. A loud failure beats a plausible empty answer — that is the entire lesson of the sibling audit.

Consequences worth stating:

- **The worker path uses a direct Postgres connection, not supabase-js/PostgREST**, because `set local` inside a transaction is not expressible over REST. This is not a cost: it also puts the entire hot path structurally outside the Next.js fetch-cache trap (§H0).
- **`service_role` is reserved for migrations, the reconciler's own bookkeeping, and the small set of genuinely tenant-less tables** (`unrouted_events`, platform ledger rows). Those routes are named, few, and reviewed.
- Enforcement: a CI grep banning direct client construction outside `src/lib/tenant/`, and catalog check **V8** (`select rolname from pg_roles where rolbypassrls or rolsuper`) asserting `dala_worker` never appears.

#### 3.3.2 One chokepoint

`withTenant()` is the `guardAiRoute()` of this codebase: **one gate, no local re-implementations.** It returns a context carrying the scoped DB handle, a mandatory Redis key-prefixer, a logger pre-stamped with `tenant_id`/`channel_id`, the spend ledger handle, and **the Anthropic client**. There is no multi-tenant constructor for the model client — see §3.3.4.

#### 3.3.3 Every Redis key comes from `ctx.key()`

`ctx.key(...)` mandatorily prefixes `t:{tenant_id}:c:{channel_id}:`. That includes conversation history, which the draft omitted from its control table and which the ancestor keys as bare `msgr:hist:{psid}` (`lib/conversationStore.js:88`) and `msgr:done:{mid}` (`:53`). A PSID is page-scoped, so two *different* pages never collide — but the same page transferred between owners would, which §3.2.5 closes by minting a new `channel_id`.

Preserve the ancestor's atomic append pipeline (`RPUSH` + `LTRIM` + `EXPIRE`, `lib/conversationStore.js:119-123`) rather than read-modify-write, and preserve the `null` ≠ `[]` distinction at `:84-101` consumed at `lib/messengerProcess.js:50-60`: `null` means Redis is unreachable and is **not** "new customer", so a Redis hiccup mid-conversation cannot make the bot greet an existing customer from scratch.

#### 3.3.4 No model call may carry two tenants' text

Stated as a rule because the Quality layer will otherwise batch to amortise the prompt, and a proposal generated from Matrix's conversation will land in GS Auto's knowledge base:

1. **No Anthropic call may contain text from more than one tenant.** Enforced structurally: the model client is a method on the `withTenant()` context. The Quality layer loops per tenant.
2. **Quality-layer and Analytics spend settles to a platform ledger row (`tenant_id is null`)** with its own ceiling and alert path per non-negotiable #6 — never charged to whichever tenant happened to be first in a batch.
3. **Applying a KB proposal takes `tenant_id` from the proposal row**, verified equal to the target document's tenant, never from the admin form.

And the prompt cache is keyed `(tenant_id, config_version)` or it is a cross-tenant leak. This is the defect class of `lib/salonBrain.js:142`'s module-scope `cachedBasePrompt`, built once per process from build-time `clientData` (`:11`, `:144-146`): at one tenant a sensible optimisation, at two it serves tenant A's prices, staff names and phone number to tenant B.

---

### 3.4 Signature verification with one app secret across all tenants

> **`X-Hub-Signature-256` proves the request came from someone holding our app secret. It proves nothing whatsoever about which tenant the event belongs to.**

One Meta app has one app secret. Every subscribed Page and every Instagram account produces a signature under that same key. A valid signature over an entry claiming Matrix's Page ID is exactly as valid as one claiming GS Auto's — Meta signs both, and so would anyone who obtained the secret.

| | Question | Mechanism | Failure |
|---|---|---|---|
| Authenticity (H2) | Did Meta send this? | HMAC-SHA256 over raw bytes, constant-time | `401` |
| Identity (H4) | Whose event is it? | Server-side lookup in a table we own, uniquely keyed | 200 + drop + alert |

Two hardening details:

- **After resolution, cross-check the app.** `tenant_channels.meta_app_slug` must equal `matched_app_slug`. If a Page we believe is on `dala-main` delivers an event signed by `dala-legacy`'s secret, our subscription state is wrong or someone has our other secret. Refuse the entry, `alert('app_mismatch')`. One string comparison, and it ties authenticity back to identity.
- **`meta_signature_verification_required` is not a config flag.** There is no environment in which it is off. "No fallback to a default credential" extends to "no fallback to no credential."

---

### 3.5 Per-tenant credentials

#### 3.5.1 Why this is not "secrets from the environment"

A Page access token is **per-tenant data**: it arrives at onboarding, it is one row among N, it rotates on Meta's schedule per tenant, and it must be readable by a worker running for that tenant only. `PAGE_ACCESS_TOKEN` as a single env var (`MESSENGER_SETUP.md:27`, read at `lib/messengerClient.js:68`) does not scale past one tenant, and the `||` fallback at `lib/messengerClient.js:67-69` is worse than not scaling: combined with `/me/messages`, tenant B's reply goes out on tenant A's token and posts as tenant A's salon, with a 200 OK.

#### 3.5.2 One credential, N channels

The draft keyed secrets `(tenant_id, channel_id, kind)`. The meta-reality critique is right that this is wrong on the platform's own terms: under the Facebook-Login flavour, Instagram messaging authenticates with the **Page** token — the draft says so itself in §3.4.2 and then contradicts it in the schema. Two channels would hold two separately-enveloped copies of one secret, so a `190` on the Messenger send would revoke one row and leave the Instagram row `active`, still sending on a credential Meta already invalidated, burning retries and rate budget forever.

```sql
create table tenant_credentials (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  kind        text not null check (kind in ('meta_page_token','meta_ig_user_token','sip_password')),
  ciphertext  bytea not null,     -- AES-256-GCM(plaintext, DEK); iv || tag || ct
  wrapped_dek bytea not null,     -- AES-256-GCM(DEK, KEK);       iv || tag || ct
  kek_version int  not null,
  status      text not null default 'active'
                check (status in ('active','rotating','revoked','indeterminate')),
  -- everything below is written from debug_token, never typed by a human
  profile_id             text,
  app_id                 text,
  granted_scopes         text[] not null default '{}',
  token_expires_at       timestamptz,   -- null = no scheduled expiry
  data_access_expires_at timestamptz,   -- the SECOND clock
  last_debug_at          timestamptz,
  last_ok_at             timestamptz,
  last_error_code        int,           -- Meta's numeric code. NEVER the token, never a body.
  last_error_at          timestamptz,
  created_at             timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table tenant_credentials enable row level security;
revoke all on tenant_credentials from anon, authenticated;
-- no policy for anon/authenticated at all. Not even the tenant owner reads this table.
```

Four details that are not optional:

1. **AAD binds ciphertext to its row.** Pass `tenant_id || credential_id || kind` as GCM additional authenticated data. Copying tenant A's ciphertext onto tenant B's row then fails authentication instead of decrypting into a working credential.
2. **`revoke all`, not merely "no policy".** RLS with no policy is default-deny today; a future `grant all on all tables in schema public to authenticated` — exactly the residue found next door — silently re-opens it. Verify per table with `aclexplode(coalesce(relacl, acldefault('r', relowner)))`, treating grantee 0 as PUBLIC. `revoke insert, update, delete` is not "cannot write": `TRUNCATE` bypasses RLS entirely, and PG17 adds `MAINTAIN`.
3. **Decrypt per request, hold in request scope only.** No module-scope cache. Vercel reuses warm lambdas across tenants; a module-level `let token` is a cross-tenant leak with a fifteen-minute half-life.
4. **The token never appears in a log, an error, or a URL.** The ancestor gets this right: token in `Authorization: Bearer` (`lib/messengerClient.js:79`), thrown errors carry `fbCode`/`fbSubcode` but not the token (`:118-125`).

**Envelope, not Supabase Vault.** Both are equivalent against a stolen database backup. They differ against the likelier incident for a solo founder on a public repo: a leaked `sb_secret_…` key. Vault's `decrypted_secrets` decrypts on read for the role that already has full data access — one leaked key yields every tenant's token in plaintext. Envelope splits the capability across two vendors; the attacker needs the Supabase key **and** the Vercel project environment. Vault being `public alpha` and mid-reimplementation is a secondary reason.

#### 3.5.3 Acquisition inside a Business Portfolio

1. **System User** in Dalatech's Business Portfolio — token not attached to any person's password, survives staff turnover on either side [CORROBORATED]. Business Settings → Users → System Users → assign the client's Page as an asset → Generate New Token against the Dala AI app.
2. Client grants **Partner access** to Dalatech's portfolio for their Page, Full control (Shape A). Shape B (Facebook Login for Business) is the same code with a different `auth_flavour` and a different runbook. §3.16 Q3.
3. `GET /{page-id}?fields=name,access_token,…` with the System User token. Encrypt, store, `debug_token`.
4. **Never `GET /me/accounts`** — §3.2.4 step 1.

Scope vocabulary is data, not a branch. Facebook Login: `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `business_management`. Instagram Login: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments` (the older `business_*` short forms were deprecated 2025-01-27) [CORROBORATED, from `restfb`'s transcription of Meta's own descriptions plus search]. Two vocabularies for one capability → a static map keyed by `auth_flavour`, and the *granted* set is written from `debug_token`, not from what we asked for.

`MESSENGER_SETUP.md:73-75` already names the FB-only subset and already notes App Review is required for the general public — the exact boundary Matrix-Chatbot sits inside (its own Page) and Dala AI sits outside.

#### 3.5.4 `debug_token` — the call that answers three of our open questions for free

The draft's proactive health probe was `GET /{external_id}?fields=id` every 6 hours, and it listed "does a System-User-derived Page token inherit never-expiry?" as blocked on Meta's documentation. The meta-reality critique is right that this is the wrong posture — the same posture §3.2.4 gets right for routing and got wrong here. One call answers it:

```
GET /debug_token?input_token=<the page token>&access_token=<app-id>|<app-secret>
```

Returns `is_valid`, `app_id`, `expires_at` (0 = never), **`data_access_expires_at`**, `scopes`, `granular_scopes`, and **`profile_id`** — the id the token is actually scoped to [CORROBORATED].

Three consequences:

- **Replace the 6-hourly probe with `debug_token`.** Same call count, strictly more information.
- **`profile_id` gives a direct token↔channel assertion.** Refuse any send where the credential's `profile_id` does not correspond to the channel's `send_external_id`, at onboarding and on every probe — instead of inferring a mismatch from a send failure after a customer is already waiting.
- **`data_access_expires_at` is a second clock on the same credential.** Facebook enforces a data-access expiration separately from token expiration [CORROBORATED]; a Page token can stop returning data while `expires_at` still reads 0. Repeating `MESSENGER_SETUP.md:27`'s "never-expiring" and then cautioning that it means "no scheduled expiry, not cannot be invalidated" was still one clock short.

#### 3.5.5 What expires, and when — including the row the draft did not have

| Credential | Lifetime | Killed by |
|---|---|---|
| Short-lived User token | ~1–2 h [UNVERIFIED exact] | time |
| Long-lived User token | ~60 days; expires after ~60 days of no requests | time, password change, permission revoke |
| Page token from a long-lived User token | "never expires" **while the granting user retains admin on the Page** | user loses the Page role, password change, app revoke, app-secret rotation, Meta security action, app returned to Dev mode |
| System User token | can be minted with **Never** expiry | asset unassigned, system user deleted, app secret rotated, manual revoke |
| Page token derived from a System User token | **[UNVERIFIED]** whether it inherits never-expiry — **and no longer blocking: `debug_token` reports the actual `expires_at` per token** | as above |
| **Instagram long-lived User token (Instagram Login flavour)** | **60 days, and it must be proactively refreshed** via `GET /refresh_access_token` while still valid and at least 24 h old [CORROBORATED] | time — **on a timer** |

**The draft's claim "there is no timer" was false**, and false for a configuration the schema treats as first-class (`auth_flavour='instagram_login'`, `send_host='graph.instagram.com'`) and that §3.16 Q3 leaves deliberately open. As written, every Instagram-Login channel would die exactly 60 days after onboarding, in a cohort, and the entirely reactive `190` machinery would detect it perfectly one day too late — after the refresh window closed, when the only recovery is re-authenticating a salon owner by phone.

Fix: `token_expires_at` on the credential (null = no scheduled expiry) plus **one scheduled refresher** that refreshes any credential with `token_expires_at < now() + 14 days`. Per non-negotiable #6 it carries an explicit ceiling (`CRED_REFRESH_MAX_PER_RUN`), an alert path, and touches no model. The defensible version of the original sentence is: *there is no timer for System-User-derived Page tokens.*

#### 3.5.6 Detection

A dead token is **silent**. Reception AI simply stops replying; nothing throws, no request arrives to fail. Three independent fronts:

**Reactive — classify the Graph error.** Taxonomy read from Chatwoot's production Instagram handler and adopted wholesale:

| Code | Meaning | Action |
|---|---|---|
| `190` | token expired / invalidated | credential `status='revoked'`, **halt outbound on every channel pointing at it**, page. Never retry a 190. Subcodes 460/463/467 [UNVERIFIED] — record, do not branch. |
| `200`, `10` | missing permission / policy | terminal for this send; `channel_permission_error`; see the app-wide rule below |
| `100` | missing permission, or non-existent user/object | terminal; if it names the recipient, mark the contact unreachable; do **not** touch credential status |
| `230` | user consent / cannot be messaged | terminal, quiet |
| `9010` | bot validation | terminal, mark contact unknown |
| `613` | rate limit | retryable; back off *this tenant only*; re-send stored text, never regenerate |
| `2534014` | private reply already sent for this comment | **success-equivalent** (§3.8.4) |
| 5xx / network / timeout | transient | retryable |

**Advanced Access is app-scoped, and a per-channel diagnosis for its loss is actively misleading.** For an app messaging Pages it does not own, the likelier cause of a sudden `#200`/`#10` is not a per-Page task role — it is the app losing Advanced Access: a lapsed Data Use Checkup, a failed re-attestation, a policy action, or a knock back to Development mode. That failure is **simultaneous across every tenant**, and the draft's response was to page the founder once per channel with the wrong cause and the wrong remedy while the entire platform was dark. Rule: **if `#200`/`#10`/`#190` fires on two or more distinct credentials within N minutes, suppress the per-channel pages and raise one `app_access_degraded` at top severity**, keyed by `matched_app_slug`, with the remedy line *"check App Dashboard → App Review → Permissions and Data Use Checkup before touching any tenant's Page."*

**Proactive — `debug_token` per credential every 6 hours** (§3.5.4), ceiling'd and alerting, no model.

**Absence watchdog — `tenant_channels.last_messaging_at`**, deliberately distinct from `last_webhook_at`, because `standby` arrivals refresh the latter and are exactly the failure mode we are watching for. Alert when a channel that received ≥1 messaging event in the previous 7 days receives none in 24 h. This catches what the probe cannot: a token that still works and a **subscription Meta disabled**. You find out about that failure from the absence of requests, never from a request.

#### 3.5.7 What happens to inbound while a credential is dead

**Persist everything, generate nothing, deliver nothing, flag it all.**

- H6 still runs. Nothing is lost.
- H11 refuses with `token_revoked` — **terminal**, so QStash does not retry. Generating a reply we cannot deliver is spend with zero value, and by restoration most of the backlog is outside the 24-hour window anyway.
- Conversation state `blocked_no_token`; every event reaches the Quality layer as an unanswered question, which is exactly what it is.
- On restoration, a **bounded replay**: per contact, only the most recent inbound message, only inside the 24-hour window and inside `max_reply_age_minutes`. Not the backlog. Three separate answers at 6 p.m. to questions asked at 11 a.m. is worse than one answer to the last one, and replaying a queue is how a restoration becomes a send-rate spike that trips `613`.

#### 3.5.8 Rotation

**KEK rotation** (ours, annual or on suspicion): add `META_TOKEN_KEK_V2` alongside V1; unwrap picks by `kek_version`; a resumable job unwraps with V1 and re-wraps with V2, leaving `ciphertext` untouched; **confirm with `select count(*) from tenant_credentials where kek_version <> 2` — by querying the database, not by the job reporting success**; then remove V1. Zero plaintext touched, zero downtime. Consolidating to one credential row per secret (§3.5.2) also removes the half-rotated-pair state the per-channel schema could reach.

**Token rotation:** the `190` path for System-User-derived Page tokens; the 14-day refresher for Instagram-Login user tokens (§3.5.5).

**Failure modes.** KEK env var missing at boot → refuse to start; never a plaintext fallback, never a default. `wrapped_dek` fails to unwrap → 503 for that tenant, alert; never fall through to another tenant's secret or to an env var. GCM auth-tag mismatch → treat as tampering, alert, never decrypt-and-hope. No credential row → distinct code `tenant_not_provisioned`, not 500 and not a silent skip — onboarding is incomplete and that is an operator-visible state.

---

### 3.6 Idempotency

Meta webhooks are at-least-once. Duplicates are normal.

#### 3.6.1 The dedupe key

| Event kind | `event_key` |
|---|---|
| Messenger / IG DM | `msg:{message.mid}` |
| FB comment (`feed`) | `cmt:{value.comment_id}:{value.verb}` — an `edited` on the same comment is a different event we may legitimately want |
| IG comment | `cmt:{value.id}:add` |
| Postback | `pb:{mid or timestamp}:{payload_hash}` |

Unique on `(tenant_id, provider, event_key)`. Meta ids are probably globally unique; we do not bet a customer's conversation on "probably".

#### 3.6.2 Three layers, one authority

1. **Postgres `inbound_events`** — `on conflict … do nothing returning id`. The **authority**, and it fails *closed*: if the insert cannot run we 500 and Meta retries.
2. **QStash `deduplicationId`** — catches a redelivery racing the insert. Finite window [UNVERIFIED, ~10 min], so an optimisation, not a guarantee.
3. **Redis negative cache on `event_key`** — saves a round-trip under a storm. Fails *open* (like the ancestor's `isAlreadyHandled`, `lib/conversationStore.js:49-58`), which is safe **only because layer 1 is authoritative**. In the ancestor it is the only layer on the degraded inline path, and both layers fail together in exactly the case that matters: no QStash means no `deduplicationId` either.

#### 3.6.3 The crash window: after Anthropic, before the Send API

**Posture: at-least-once *generation*, at-most-once *delivery*.** A duplicate generation costs single-digit cents, is bounded, is invisible to the customer. A duplicate reply is customer-visible, damages the tenant's brand in front of their own customer, can trip per-thread throttling, and in the comment case can start a loop. Money is the cheaper thing to risk.

```
H13  model returns → persist reply_text, reply_generated_at, model,
                     token counts, cost_usd; settle spend_ledger
H14  insert into outbound_sends (tenant_id, inbound_event_id, kind)
       on conflict do nothing returning id, state, lease_until;
```

`unique (tenant_id, inbound_event_id, kind)`, with a state machine:

| State on retry | Action |
|---|---|
| row absent | claim: `state='claiming'`, `lease_until = now() + 60s`, send |
| `sent` | no-op, 200. **Never re-send.** |
| `claiming`, lease live | 503; QStash retries after the lease expires |
| `claiming`, lease expired | **do not re-send.** `state='indeterminate'`, `alert('reply_indeterminate')`, Quality flag, 200 |
| `failed_retryable` | re-send the **stored** text. No model call. |
| `failed_terminal` | no-op, 200 |

The 60 s lease sits comfortably above the 10 s Send timeout (`lib/messengerClient.js:14`) so a live attempt is never judged expired.

**Defending `indeterminate`.** A worker that dies between request and response may or may not have delivered. We choose silence, for the same reason the ancestor chooses it one layer up: `api/messenger.js:118-133` deliberately does not process a timed-out enqueue inline, because the publish may have landed. *An ambiguous failure is not a failure.* Silence is not the end of the story either — the event reaches the Quality layer as an unanswered question, a mechanism a duplicate reply has no equivalent of.

So, directly: **a crash between the model call and the send may double-charge and will not double-reply** — and in practice rarely double-charges, because the reply is persisted before the send and the retry reads it back.

#### 3.6.4 Two more surfaces

- **Per-conversation serialisation.** Two rapid messages produce two workers, two model calls, two replies in indeterminate order, and a history race. The ancestor's append is atomic (`lib/conversationStore.js:119-123`) but generation is not serialised. A Redis mutex `ctx.key('lock', contact)` with `SET NX PX 45000`; a worker that cannot take the lock returns 503. Phase 2: coalesce messages within 4 s into one turn — better answers, fewer calls, but it changes the ACK-to-reply latency profile and should be measured first.
- **`unsupported_media`** — a per-tenant canned line from `canned_responses`, sent through the same `outbound_sends` claim so it cannot double-send, plus a Quality flag. Never model-composed, for the same reason `CHILDREN_REPLY` (`lib/salonBrain.js:70`) and every other canned line (`:41`, `:52`, `:57-59`, `:63-65`) is pinned verbatim.

---

### 3.7 Fast-ACK and the durable queue

#### 3.7.1 Why the pattern is non-negotiable

Meta retries a slow webhook and, after roughly an hour of continuous failure [UNVERIFIED threshold], disables the subscription **for that asset** — one tenant dark, permanently, until someone re-subscribes, and nobody finds out from an error. The ancestor's ACK-first posture (`api/messenger.js:6-8`, `:109-145`) is not a latency optimisation; it is the thing standing between the business and a silently unsubscribed tenant.

#### 3.7.2 Stay on QStash

It is already in the stack with the reasoning written down (`lib/messengerQueue.js:1-7`); at-least-once with retries and a signed callback is the right contract; the alternative (pgmq + a Vercel cron) adds tens of seconds of polling latency to a customer-facing reply. Changes: body is `{ event_id }` only; `deduplicationId` is tenant-scoped; `MAX_RETRIES` stays 3 with the `upstash-retried` mapping, but only for classified-retryable failures.

**Per-tenant named queues with bounded parallelism** would be a cheap second isolation layer, but I could not confirm the feature this session [UNVERIFIED]. **The design must not depend on it.** The authoritative concurrency control is the Redis semaphore in §3.10.2, implemented regardless.

#### 3.7.3 Remove the degraded inline path; add a fair sweeper

The ancestor processes inline before the ACK when QStash is unconfigured or a publish hard-fails (`api/messenger.js:134-154`). A multi-tenant system may not keep this:

1. **It spends inside the ACK budget.** A 25 s model timeout (`lib/salonBrain.js:38`) behind a 12 s inline deadline (`api/messenger.js:27`) is tight at one tenant; with entries for several tenants in one POST, one tenant's slow generation delays the ACK for everyone in that request.
2. **`withTimeout` does not cancel.** `api/messenger.js:29-41` races a timer and never aborts the work — the handler returns 200 while an Anthropic call is still in flight. Untraceable, unattributed, unmetered spend.
3. **It is the silent-degrade path**, running precisely when durability and dedupe are absent, and nothing alerts.

**Replacement: the sweeper.** Because H6 persists before H7, a failed publish loses nothing. A cron every minute re-publishes `state='pending_enqueue'` rows younger than 20 minutes with the same `deduplicationId`; older rows become `expired_unqueued` and go to the Quality layer rather than being answered late.

**It must be round-robin over tenants, not global FIFO.** The draft ordered by `received_at` under a global cap, which the tenant-leak critique correctly shows starves the quiet tenant: a 15-minute QStash outage during GS Auto's comment storm leaves 6,000 GS Auto rows ahead of Matrix's three DMs, which then age out unanswered — and nobody is paged, because the sweeper's "found rows" alert already fired for GS Auto and `ops_alerts` dedupes by `(tenant_id, code)`. So: `select distinct on (tenant_id) …` in a loop, or a per-tenant slice of `ceil(cap / N_active_tenants)` with the remainder contended. The same fix applies to the credential probe (`CRED_PROBE_MAX_PER_RUN`) and the reconciler. And **`expired_unqueued` writes an `ops_alerts` row for the tenant it happened to**, so starvation is visible for the victim, not only for the cause.

The sweeper is a scheduled job: row ceiling, age cutoff, an alert when it finds anything at all (finding rows means QStash is failing), and **no model**. `vercel.json` carries the sweeper, the reconciler and the credential probe/refresher, and nothing else. The sibling's rule, learned expensively, is that *nothing spends on a schedule*; none of these four reaches Anthropic.

---

### 3.8 Comment replies

#### 3.8.1 The fields are different, and one is a firehose

| | Facebook Page | Instagram |
|---|---|---|
| Webhook | `object:'page'`, `changes[].field='feed'` | `object:'instagram'`, `changes[].field='comments'` |
| Identify a comment | `value.item==='comment' && value.verb==='add'` | every event is a comment |
| Payload | `from`, `post_id`, `comment_id`, `message`, `created_time`, `is_hidden`, `parent_id` | `value.id`, `value.text`, `value.from.{id,username}`, `value.media.{id,media_product_type}` |
| Enrichment | often needed (media, parent) | album comments omit the album id — must query the comment for `media` |
| Public reply | `POST /{comment-id}/comments` | `POST /{ig-comment-id}/replies` |

The draft marked the public-reply edge [UNVERIFIED] with an alternate reading (`POST /{comment-id}`). The meta-reality critique settles it in the design's favour and I accept that: `POST /{comment-id}/comments` is the well-established edge. It stays on the pre-code checklist as a one-minute curl, at the bottom.

There is **no dedicated `comments` field on the Page object**: you subscribe to `feed` and receive the Page's own posts, edits, reactions and hides alongside comments, then filter [CORROBORATED]. Budget for that volume — it is why comments are a separate priority class in §3.10.2. Every enrichment call is a Graph call against that tenant's rate budget and is metered like any other (non-negotiable #5). Under a viral post, the enrichment calls — not the replies — are what exhaust the budget.

#### 3.8.2 Loop prevention

1. **`value.from.id` equals the channel's own external id** → drop, `comment_self`. Covers the bot's own reply and anything the tenant posts *as the Page*.
2. **`comment_id` already in `inbound_events`** → drop (§3.6.1).
3. **A per-tenant do-not-reply list.** A stylist commenting from their *personal* account is indistinguishable from a customer by id shape, and the bot must not talk over the salon's own staff. **The meta-reality critique is right that this cannot be a text field in an onboarding form** — a commenter's `from.id` is scoped to that Page and the salon owner cannot look it up anywhere, so as specified the list would be empty in production and the guard would never fire. It is an **action in the Quality layer on an observed comment** ("never reply under this person"), seeded from real comment events. The data model was right; the entry path did not exist.
4. **Caps, per tenant, as data:** one public reply per root comment thread ever; `comment_replies_per_post_per_hour` (default 10); `comment_replies_per_day` per channel. Exceeding a cap is `comment_cap_reached` — a Quality flag, and past a threshold a founder alert saying "this post is going viral, come look."
5. **Never reply to a comment on a post older than `comment_max_post_age_days`** (default 30). Old posts attract spam and the tenant gets no value from the bot arguing with it in 2027.

#### 3.8.3 Public vs private, chosen as config

`tenant_channels.comment_policy` ∈ `none | public_only | private_only | both`.

**Public replies** are permanent and are the tenant's brand speaking; v1 default is conservative — a short acknowledgement plus a pointer, never a price. The deliberate-omission machinery applies with more force here than in DMs, because a wrong price in a public comment is screenshot-able.

**Private replies** (comment → DM): `POST /{page-id}/messages` (or `/{ig-user-id}/messages`) with `recipient: { comment_id: "<id>" }` [CORROBORATED]. Text only; Meta auto-appends a link to the post.

#### 3.8.4 The private reply is single-use and expiring

| Property | Value | Mark |
|---|---|---|
| Exactly one private reply per comment, **ever**; second attempt → subcode `2534014` | rule [CORROBORATED]; the number [UNVERIFIED] |
| Window **7 days from the comment's `created_time`**, not from webhook receipt | 7 days [CORROBORATED]; clock-start [UNVERIFIED] and it is the detail that eats late retries |
| Text only | [CORROBORATED] |

- Dedupe on `comment_id` **in Postgres before the send** via `comment_replies` with `unique (tenant_id, provider, comment_id)`. A duplicate QStash delivery must hit a uniqueness violation, not a second Graph call.
- **`2534014` is success-equivalent.** `private_reply_state='already_sent'`, never retry, never regenerate. Getting this wrong makes every retry burn a generation for a message Meta will refuse.
- **Compute the deadline from `created_time` and refuse before generating:** `now - created_time > 7d - 6h` → `private_reply_expired`, terminal, no spend, Quality flag. Free, and it belongs in the same fail-closed ordering as identity → entitlement → budget. It is a budget gate wearing a policy hat.

---

### 3.9 The 24-hour messaging window

Inside 24 hours of the customer's last message, a business may reply freely on Messenger and Instagram [CORROBORATED]. **Reception AI lives entirely inside this window** and is unaffected by §3.9.3.

#### 3.9.1 Tracking it, with a margin and a unit check

```sql
alter table contacts add column last_inbound_at timestamptz;
alter table contacts add column window_expires_at timestamptz
  generated always as (last_inbound_at + interval '23 hours 30 minutes') stored;

alter table inbound_events add constraint occurred_at_sane
  check (occurred_at between received_at - interval '7 days'
                        and received_at + interval '1 hour');
```

Two fixes the meta-reality critique is right about:

- **The margin.** The draft gave the 7-day private-reply window a six-hour safety margin with explicit reasoning, and then evaluated the 24-hour window with none. The failure is identical: at 23h58m our clock says open, we clear the gate, we pay for a generation, and the send is rejected because Meta's clock or Meta's definition of "last inbound" differs by minutes. That is precisely what the "checks 4 and 5 are free and come before check 7" ordering exists to prevent. Both margins live in `tenants` as data.
- **The unit check.** `messaging[].timestamp` and `entry[].time` are milliseconds [CORROBORATED]. A seconds/ms confusion produces a `window_expires_at` in 1970 (everything refused, no spend, loud) or in 56000 (everything accepted, every send rejected, quiet). Only one direction is safe, and the check constraint makes the error fail at the insert.

`window_expires_at` is computed from `occurred_at` (Meta's timestamp), never `received_at` — a delayed delivery must not extend a window that has already closed. The ancestor's 24-hour Redis history TTL (`lib/conversationStore.js`) is a coincidence of the same number; the window is an explicit column, not an inference from a cache TTL.

#### 3.9.2 Answering late

- **`max_reply_age_minutes`** (default 30, per tenant). Beyond it an auto-reply is worse than none — a customer who asked at 11:00 and gets an automated price list at 17:00 reads it as a broken bot. `reply_too_late`, no spend, Quality flag. GS Auto Center may well want 120.
- **The window itself.** Beyond it the send is rejected by Meta (code [UNVERIFIED]; classify any rejection naming the messaging window as terminal and **record the exact code the first time it appears**, so the table is filled from production rather than from a search result). `window_closed` **before** the model call.

#### 3.9.3 Follow-ups — the finding that changes the roadmap

- `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` were **retired 2026-04-27**; requests carrying them return error `100` [CORROBORATED, four independent sources].
- Recurring Notifications ended 2026-02-10 outside AU/EU/JP/KR/UK [CORROBORATED].
- `HUMAN_AGENT` extends to 7 days but Meta **explicitly prohibits it for automated or bot messages and says it detects misuse** [CORROBORATED]. Instagram availability is contested between sources [UNVERIFIED].
- The only compliant route is template-approved Utility Messages under Marketing Messages on Messenger — approval-gated, category-constrained, possibly per-message priced.

**So the design contains no message tags anywhere.** Outbound eligibility is a resolved policy object:

```ts
type OutboundPolicy = {
  channel: 'messenger' | 'instagram' | 'sms';
  window_hours: number | null;          // 24 | 24 | null
  free_form_outside_window: boolean;    // false on both Meta channels, today
  template_required: boolean;
  ai_authored_allowed: boolean;         // false under HUMAN_AGENT
  per_message_cost_usd: number | null;  // null ⇒ REFUSE. Never default to zero.
};
```

`per_message_cost_usd === null` refuses, for the same reason `BANK_BUILD_BUDGET_USD` is `0` next door: it is a value that refuses **without depending on a read that might be stale or wrong**. Customer Care AI's seam plugs in here — one policy row per channel, and SMS is currently the only entry with `free_form_outside_window: true`, which is a business fact worth staring at (§3.16 Q1).

---

### 3.10 Rate limits and noisy neighbours

#### 3.10.1 What Meta enforces

| System | Limit | Header | Scope |
|---|---|---|---|
| App-level | `200 × app users` per hour | `X-App-Usage` | **the whole app — shared across every tenant** |
| Page-level | `4,800 × engaged users` / 24 h sliding | `X-Page-Usage` | per Page |
| Business Use Case | separate budget per product per asset | `X-Business-Use-Case-Usage` | per business × product |
| Send API | 300 calls/s per Page (text); 10/s (audio/video) | — | per Page |

**The app-level budget is the shared resource and Meta will not fair-share it.** A viral post at GS Auto Center consumes headroom belonging to Matrix Eco Salon.

#### 3.10.2 Our controls, sitting under Meta's

All in Upstash Redis, all keyed through `ctx.key()` so the tenant comes from the registry lookup and never from the body:

| Control | Key | Purpose |
|---|---|---|
| Inbound admission | `…:rl:in:{provider}` token bucket, per class | shed a storm before it becomes spend |
| Graph call bucket | `…:rl:graph:{provider}` | stay under Page/BUC |
| **Global app bucket** | `rl:graph:app:{app_slug}`, sized **below** Meta's, **partitioned** | see below |
| Model concurrency | `…:sem:model` (default 3) | one tenant cannot occupy every worker |
| Conversation mutex | `…:lock:{contact}` | §3.6.4 |
| Spend reserve | `…:spend:{yyyymm}` + `spend_ledger` | the money ceiling |

**Priority classes:** DMs are never shed before comments. When the comment bucket is empty the event is persisted with `state='shed', shed_reason='rate_comment'` — persisted, so the Quality layer can see what was dropped and the founder can price it.

**The global app bucket is checked at H11, before the model, and is partitioned.** The draft placed it only among the Graph-call controls at H14, and the tenant-leak critique correctly shows the reverse leak that produces: GS Auto's firehose drains the shared app budget; Matrix's Saturday DMs pass H11 (Matrix's own bucket is idle), reach Anthropic, get generated, get settled into Matrix's ledger — and then fail at H14 on a resource Matrix has no control over. Two changes:

1. **A non-consuming headroom check at H11.** If global headroom is below a floor, refuse with `app_budget_low` and spend nothing.
2. **Reserve a share.** Each `active` channel gets `floor(app_budget / N_active_channels)` that only it may draw; the surplus is contended. A tenant may exhaust the surplus and can never take another tenant's reserved headroom.

**The critique's third suggestion — "refund or never-settle the ledger entry for an undelivered reply" — is half wrong, and the half that is wrong matters.** Anthropic charged us the moment the response came back; that money cannot be un-spent, and a ledger that pretends otherwise is a ledger that lies. What is fixable is (a) not spending it, which is what the headroom precheck does, and (b) making it **visible**: `spend_ledger.outcome ∈ ('delivered','undelivered_window','undelivered_send_failed','undelivered_indeterminate')`. The founder can then see exactly what a noisy neighbour cost a quiet one and decide to credit it — a business decision with the numbers in front of them, rather than an accounting fiction.

**Spend: reserve then settle.** Before the model call, reserve an estimated worst case (`max_tokens` at the model's output rate plus the measured prompt size) atomically in Redis and check it against the tenant's remaining monthly ceiling; settle to actuals from `usage` afterwards. Without a reserve, N concurrent workers each see the same "remaining" figure and collectively overshoot. Postgres `spend_ledger` is the monthly authority; Redis is the hot path. **If Redis cannot be consulted the worker returns 503 and QStash retries.** Cost-bearing paths fail closed; **the only fail-open in this system is the ACK path itself**, which spends nothing and where a non-200 risks unsubscription — documented here and nowhere else.

Log every response's `cache_read_input_tokens` / `cache_creation_input_tokens` / `input_tokens` per tenant, as the ancestor already does (`lib/salonBrain.js:250`) for exactly the right reason: a cache miss is invisible in the reply and just quietly bills full price.

#### 3.10.3 Read Meta's own numbers

Parse `X-App-Usage`, `X-Page-Usage`, `X-Business-Use-Case-Usage` on **every** Graph response; store a high-water mark per channel per hour. These headers are the only visibility Meta gives. A channel at 80% `X-Page-Usage` is a Page about to go silent. Alert at 70%, page at 90%.

#### 3.10.4 Back off the tenant, not the worker

On `613` or any classified rate-limit failure: increment that tenant's backoff, return 503, and **never re-enter generation** — the reply is stored (§3.6.3), so the retry re-sends a thought already paid for. Backoff is per `(tenant, provider)`; a throttled Matrix must not slow GS Auto by a millisecond.

#### 3.10.5 The subscription reconciler

Hourly, capped, round-robin, no model: for each `active` channel, `GET /{page-id}/subscribed_apps` and compare to `tenant_channels.subscribed_fields`. On mismatch or absence, re-`POST /{page-id}/subscribed_apps`, record `last_subscription_ok_at`, alert. This is the automatic repair for the unsubscription risk accepted at H6, and the only way to detect a subscription Meta disabled while the token stayed perfectly valid.

---

### 3.11 Multi-channel identity

**Decision: the same human on Messenger and Instagram is two contacts. Do not unify them automatically.**

```sql
create table identity_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  created_by text not null check (created_by in ('founder_merge','customer_phone_claim')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table contacts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  channel_id        uuid not null,
  provider          text not null,
  external_id       text not null,          -- PSID or IGSID
  identity_group_id uuid,                   -- NULL by default; the seam, unused in v1
  display_name      text,
  last_inbound_at   timestamptz,
  window_expires_at timestamptz generated always as
                      (last_inbound_at + interval '23 hours 30 minutes') stored,
  first_seen_at     timestamptz not null default now(),
  unique (tenant_id, provider, external_id),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_id)       references tenant_channels (tenant_id, id),
  foreign key (tenant_id, identity_group_id) references identity_groups (tenant_id, id)
);
```

The `identity_groups` table and its composite FK exist because the tenant-leak critique is right: the draft's bare `identity_group_id uuid` with no constraint was the one unscoped column in an otherwise meticulous table, and the first query joining on it — a "everything about this customer" view, or Analytics AI's unique-humans figure — would cross the tenant boundary with no error. One table and one FK, now, while it costs nothing.

Why not unify:

1. **There is no join key.** PSIDs are page-scoped, IGSIDs are Instagram-scoped, both are per-business, and Meta gives no correlation identifier [CORROBORATED]. Unification would rest on display name or profile photo — a guess, and a guess that merges two customers' histories is a privacy incident, not a bug.
2. **Nothing downstream needs it.** Token, window, send endpoint and rate budget are all per-channel; a "unified" thread would be split again at send time.
3. **Answer quality does not improve.** The knowledge base, refusal rules, closure message and price list are channel-independent.
4. **The reverse is expensive.** Un-merging means editing conversation history.

`identity_group_id` is only ever set by an explicit founder-approved merge, or by a customer volunteering a phone number that matches an existing contact — a claim they made themselves. Never by a heuristic on names. If the founder later wants a de-duplicated "unique humans" figure, that is a reporting-layer estimate with an error bar, not a change to the contact model.

---

### 3.12 The verification handshake with many tenants on one endpoint

`GET /api/meta/webhook/[app]?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`

The handshake is **per Meta app, not per tenant**. Meta calls it once when the callback URL is configured in the App Dashboard, never per Page; subscribing a Page is a separate API call involving no handshake [CORROBORATED]. Two consequences:

- **It must not touch the database.** It knows nothing about tenants and must work before any tenant exists. It reads `META_VERIFY_TOKENS` (`{app_slug: [token, …]}`) from the environment and makes no reads at all — which also removes any question about the Next caching trap for this handler.
- **Compare constant-time.** The ancestor uses `token === expected` (`api/messenger.js:65`), which short-circuits on the first differing byte. Compare SHA-256 digests with `timingSafeEqual`: equal-length inputs, no length leak, costs nothing.

Failures: mode not `subscribe`, token mismatch, unknown slug, or `META_VERIFY_TOKENS` missing → **`403`, always**, with `counter('webhook.verify_failed', { app_slug })`. A missing config is a 403, never a pass.

Rotating a verify token: add the new value to the app's array, re-verify in the App Dashboard, drop the old. The handshake is idempotent and re-triggerable at any time.

---

### 3.13 Consolidated failure modes

| Hop | Failure | Detection | Response | Alert |
|---|---|---|---|---|
| H1 | Body > 1 MB | size | 413 | rate-limited |
| H2 | Signature missing/invalid | HMAC | 401 | on a burst |
| H2 | Unknown `[app]` slug | app map miss | 401 | on a burst |
| H2 | App secret env missing | boot check | 401 + refuse to serve | page |
| H2/H4 | `meta_app_slug` ≠ `matched_app_slug` | post-resolution check | drop entry, `app_mismatch` | page |
| H3 | Unknown `body.object` | adapter miss | 200, counter | daily digest |
| H4 | **Unknown `entry.id`** | registry miss | **200 + drop + quarantine (shape only)** | page on first sight per id |
| H4 | **Page claimed by a second tenant** | partial-unique / EXCLUDE violation at onboarding | onboarding refuses, `channel_already_claimed` | founder adjudicates; never "most recent wins" |
| H4 | Page transferred (salon sold) | manual | supersede identity → drain → new channel + new binding → probe | logged |
| H4 | Offboarded page still delivering | `status='offboarded'` | 200, no work; reconciler unsubscribes after 7 days; superseded identity retained | daily digest |
| H4 | `entry.id` and `recipient.id` → different tenants | cross-check | **refuse the entry**, `routing_ambiguous` | page |
| H4 | Route cache stale after a rebind | — | drain window ≥ TTL + 30 s; explicit purge as belt | — |
| H5 | **Events arriving in `entry.standby`** | separate counter | probing → `not_primary_receiver` (hard onboarding failure); active → halt-and-page | **page** |
| H5 | Story reply / mention | attachment `type` | normal turn; persist the fact, not the expiring URL | — |
| H6 | Postgres down | insert throws | **500** (Meta retries) | page immediately |
| H6 | Duplicate delivery | unique violation | 200, no enqueue | none |
| H6 | `occurred_at` unit error (s vs ms) | check constraint | insert fails loudly | page |
| H7 | Publish hard-fails / times out | publish result | 200; `pending_enqueue`; sweeper re-publishes, same `deduplicationId` | alert if the sweeper finds rows |
| H9 | Bad QStash signature | receiver | 401 | on a burst |
| H10 | `inbound_events` row gone | miss | 200 | none |
| H11 | No credential row | miss | 503 `tenant_not_provisioned` | page — onboarding incomplete |
| H11 | **Credential revoked (`190`)** | Graph error | terminal; halt outbound on **every channel using that credential**; persist inbound; Quality flags all | **page** |
| H11 | Instagram-Login token nearing 60 days | `token_expires_at` | refresher at T-14d | page if a refresh fails |
| H11 | `profile_id` ≠ channel's asset | debug_token | refuse all sends on that channel | **page** |
| H11 | Window closed / message too old | timestamps (with margin) | terminal, **no spend**, Quality flag | digest |
| H11 | **Global app headroom below floor** | non-consuming check | refuse, `app_budget_low`, **no spend** | page (a neighbour is flooding) |
| H11 | Redis unavailable | limiter error | **503**, retry. Never spend unmetered | page |
| H11 | Budget exhausted | ledger | per tenant policy: hard stop / canned line / overage | notify tenant + founder |
| H13 | Anthropic 5xx / timeout / 429 | classify | retryable → 503 | digest; page on sustained |
| H13 | Anthropic 401 / credit exhausted | classify | **terminal**, no retries. The ancestor burns 4 attempts here (`lib/messengerProcess.js:101-109`) | **page** |
| H14 | Send `613` | classify | back off this tenant; re-send stored text | digest |
| H14 | **`#200`/`#10` on ≥2 credentials in N min** | cross-channel correlation | suppress per-channel pages; raise `app_access_degraded` | **page, top severity** |
| H14 | Send `#100`/`#230`/`#9010` | classify | terminal; mark contact unreachable where applicable | none |
| H14 | Worker dies mid-send, lease expires | lease | `indeterminate`, **do not re-send**, Quality flag | digest |
| H14 | Private reply `2534014` | classify | **success-equivalent** | none |
| — | Channel silently unsubscribed | `last_messaging_at` watchdog + reconciler | auto re-subscribe | page |
| — | IG connected-tools switch off | probe timeout with no delivery | `ig_messaging_access_off` + remedy string | onboarding UI |
| — | Graph version expired | canary shape diff (§3.14) | — | page |

#### 3.13.1 The alert path itself

`ops_alerts (tenant_id, code, severity, first_seen_at, last_seen_at, count, resolved_at)`, deduped by `(tenant_id, code)` so a dead credential pages once and then becomes a counter — with the §3.7.3 caveat that a per-tenant dedupe key must not hide a *second* tenant's instance of the same code.

Delivery on **two independent channels, one of them push**, because the sibling's Brevo incident is the canonical lesson: **a 2xx from an email provider means "accepted for delivery", never "delivered"**, and a send from an unauthenticated domain returns 2xx and is silently dropped. Log the provider's message id on every alert send. Add a **daily heartbeat** — a message that arrives when nothing is wrong — because the failure mode this whole section is built around is *absence of signal*, and an alert channel that is itself silent is indistinguishable from a healthy system.

---

### 3.14 Verified, assumed, and what must be checked before code

**Verified by reading a file in this session** (all line numbers confirmed): the ancestor pins Graph `v25.0` at `lib/messengerClient.js:9` and sends to `/me/messages` at `:10`; HMAC verification with `timingSafeEqual` and secret-absent-returns-false at `:25-42`; token in a Bearer header at `:79`; the `|| process.env.PAGE_ACCESS_TOKEN` fallback at `:67-69`; a 10 s Send timeout at `:14`; `bodyParser:false` at `api/messenger.js:16-20` with the 1 MB raw-body cap at `lib/rawBody.js:10`; `object !== 'page'` → bare 200 at `api/messenger.js:99-101`; `entry[].id` never read at `:164-180`; the three drop guards at `:171-173`; the ambiguous-enqueue reasoning at `:109-145`; `withTimeout` that does not cancel at `:29-41`; the 4 s / 12 s deadlines at `:24`/`:27`; `token === expected` at `:65`; `deduplicationId: event.mid` at `lib/messengerQueue.js:66` and `MAX_RETRIES = 3` at `:13`; the deliberate non-pinning of the QStash URL claim at `api/messenger-worker.js:45-52`; regeneration on every retry at `lib/messengerProcess.js:95, 101-109, 116`; fail-open dedupe at `lib/conversationStore.js:49-58`; the atomic history pipeline at `:119-123`; unprefixed `msgr:hist:{psid}` / `msgr:done:{mid}` at `:88`/`:53`; the never-called `memoryEnabled` at `:130`; the module-scope `cachedBasePrompt` built from build-time `clientData` at `lib/salonBrain.js:11, 142-146`; pinned canned lines at `:41, 52, 57-59, 63-65, 70`; cache-token logging at `:250`; the unanchored `GREETING_REGEX` at `lib/salonIntents.js:26`.

**Everything about Meta's platform is [CORROBORATED] or [UNVERIFIED], never verified.** Run these against `developers.facebook.com` from an unblocked network before writing code, ordered by how much depends on them. A search summary is not a migration applied to the database.

1. **The Instagram messaging webhook payload — what `entry[].id` is under each auth flavour.** Tenant routing depends on it and my sources disagree with production code. Mitigated by the mandatory probe (§3.2.4).
2. **The handover protocol / primary receiver:** confirm `entry[].standby` semantics, whether Page Inbox holds primary receiver by default in 2026, and whether there is an API to *read* the current primary receiver (which would turn §3.5.6's detection from reactive into proactive).
3. **The Instagram "allow access to messages" / connected-tools toggle** — exact current label and menu path, for the remedy string.
4. **Instagram Login long-lived token refresh:** `GET /refresh_access_token`, the 60-day lifetime, and the ≥24 h / still-valid preconditions. §3.5.5 is built on it.
5. **`debug_token` field set**, and specifically `data_access_expires_at` behaviour for a *derived Page* token.
6. **The Graph versions table**, which of the two "two-year" formulations Meta implements, and whether an expired version silently falls back rather than erroring. **The draft's "startup + monthly assertion that the pinned version is live" names a check with no endpoint behind it** — the versions table is a documentation page, and `GET /v26.0/me` succeeds under the fallback too, so what would get written is a check that cannot distinguish healthy from failed, which is worse than none because it retires the concern. Replace with: pin the version, log it on every outbound call, keep `graph_version_override` per channel so a bump can be canaried on one tenant, and run **one weekly canary whose response *shape* is diffed against a stored fixture**, plus an honest calendar reminder. An honest manual control beats a fake automated one.
7. **Meta's webhook retry schedule and the exact unsubscription threshold.** The H6 "return 500" decision is priced against it.
8. **Private reply:** subcode `2534014`, and whether the 7-day clock starts at comment creation or webhook receipt.
9. **The exact subscription call for Instagram Login** (`POST /{ig-user-id}/subscribed_apps`?).
10. **Whether `entry[].messaging` can hold more than one element.** (Written as a loop regardless.)
11. **The current error table** — the outside-window code specifically, plus `190` subcodes.
12. **QStash named queues with per-queue parallelism.** If absent, the Redis semaphore is the only concurrency control and must be sized accordingly.
13. **Whether Dala AI needs Tech Provider status** or only Business Verification + Advanced Access. Tech Provider is a months-long track.
14. **The public comment-reply edge** — `POST /{comment-id}/comments`. Treated as settled; a one-minute curl to confirm.

And before any of it ships: run the catalog verification pack (V1–V9) after **every** grant/policy migration, read every row, and check each table independently — `tenant_credentials`, `unrouted_events`, `channel_identity`, `inbound_events`, `spend_ledger`, `ops_alerts`. The last failure next door was partial, one of four tables, and a spot check on the correct one confirmed the wrong conclusion. `supabase_migrations.schema_migrations` will freeze on this project the moment one migration is applied through the dashboard editor; do not build the habit of consulting it. Add to the pack: `select rolname, rolbypassrls from pg_roles` asserting `dala_worker` is absent, and the database-collation assertion (`datcollate` must not be `C`/`POSIX`, and it cannot be changed after creation).

---

### 3.15 Open questions — the founder's call

1. **Is Customer Care AI SMS-only, or does Dalatech commit to the Marketing/Utility Template approval track on Messenger?** The tags it would have used died 2026-04-27; `HUMAN_AGENT` forbids AI-authored text. The compliant Meta path is approval-gated, category-constrained and possibly per-message priced — a second product surface with its own App Review, not a feature toggle. If the answer is SMS-only, Customer Care does not exist until the Mongolian SIP trunk does, and that belongs in the roadmap explicitly rather than implied by a gate.

2. **One Meta app, or a small number sharded by tenant cohort?** One app is the design premise and the schema supports both (`meta_app_slug` per channel, per-app secrets and verify tokens in the environment). One app means one shared hourly rate budget, one App Review verdict, and one blast radius: a policy strike or a lapsed Data Use Checkup takes down every tenant at once — which §3.5.6's `app_access_degraded` rule now detects but cannot prevent.

3. **Partner access or Facebook Login for Business as the house onboarding shape — and which Instagram auth flavour follows from it?** Partner access is durable and survives staff turnover on both sides, but requires each Mongolian SMB to have a Business Portfolio and an admin who can navigate Business Settings. Facebook Login is two clicks and dies when the owner changes their password. Instagram Login additionally brings a **60-day refresh treadmill** (§3.5.5) that the Facebook-Login flavour does not have — a real operational cost that should weigh on this decision. Supporting both is config, but the runbook and the App Review surface double.

4. **What is a tenant's monthly AI ceiling, and what happens at zero?** Hard stop (Messenger goes silent mid-conversation, on a Saturday), degrade to a canned Mongolian "we'll come back to you", or auto-overage-bill. H11 cannot be finished without this number. The middle option is the only one that is neither a broken product nor an unbounded bill, and it needs a pinned, natively-reviewed sentence per tenant — a `canned_responses` row and a review step, not a string literal.

5. **Who eats a noisy neighbour's cost?** §3.10.2 now records `spend_ledger.outcome='undelivered_*'` so a reply Matrix paid for and could not send because GS Auto drained the shared app budget is *visible*. It cannot be refunded — the money left the building at H13. Does Dalatech credit it, absorb it, or write the ceiling so it cannot happen? This is a pricing decision the ledger can inform but not make.

6. **When a credential dies at 2 a.m., who is woken, on what channel, and what is the promised time-to-restore in the tenant contract?** Reception AI goes silent with no error anywhere and the customer simply gets nothing. The technical detection is designed above; the human half is a business commitment.

7. **Are comment replies in v1 scope?** They expand App Review (`pages_manage_engagement`, `instagram_manage_comments`), add per-event enrichment calls against each tenant's rate budget, put the bot's words on the tenant's public wall, and bring the whole loop-prevention apparatus — including a do-not-reply list that only exists once the Quality layer can seed it from observed comments (§3.8.2). DM-only ships months earlier.

8. **Does GS Auto Center wait for App Review, or do the first two tenants run under a narrower footprint?** Business Verification of a Mongolian legal entity plus ~20-day App Review is the critical path to Advanced Access, and nothing about messaging Pages Dalatech does not own is possible without it. Running tenant #1 on its own Page under Standard Access is what Matrix-Chatbot does today and buys time — at the cost of a second migration later.

9. **Who runs the routing probe, and is the tenant allowed to see the probe UI at all?** §3.2.4 now binds only on a nonce match, which removes the mis-click risk. But if the salon owner drives their own onboarding, they see a screen listing ids their own webhook produced. Founder-only onboarding is safer and slower; self-serve is the only shape that scales past a dozen tenants. This decides whether `unrouted_events` needs a tenant-scoped view at all.

10. **Does the founder's Quality layer run as `service_role` or as the scoped `dala_worker`-style role?** Reviewing conversations is inherently cross-tenant, so `service_role` is tempting — and it removes the last place a scoping bug in the founder's own tooling would surface as a missing row rather than a cross-tenant leak. §3.3.4 already forbids one model call carrying two tenants' text; running the loop under the scoped role costs one policy and makes that rule enforced rather than merely stated.