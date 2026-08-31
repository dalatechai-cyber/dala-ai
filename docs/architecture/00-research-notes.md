# Research notes — verified source material

Gathered 2026-08-30 during the architecture design run. Each note states its own
verification status; read those marks before building on any claim.

---

# Meta Graph API facts for a multi-tenant Messenger + Instagram bot (as of 2026-08-30)

## READ THIS FIRST — a verification caveat that changes how you must use this document

**`developers.facebook.com` is blocked by this session's network egress policy.** Both `WebFetch` and `curl` return `403` on the CONNECT tunnel (`curl: (56) CONNECT tunnel failed, response 403`). So are `communityforums.atmeta.com`, `code.peren.gouv.fr` (a mirror of Meta's platform docs), `developers.chatwoot.com`, `medium.com`, `stackoverflow.com`, `www.postman.com`, `dev.to`, `ppc.land`, and `ayrshare.com`. **I could not open a single page of Meta's primary documentation.**

What *did* work: `WebSearch` (which surfaces indexed content, including from Meta doc pages), `github.com` and `raw.githubusercontent.com` via WebFetch, and the local filesystem.

Therefore every claim below carries one of three marks, and **you must respect the difference**:

| Mark | Meaning |
|---|---|
| **VERIFIED (local)** | I read it in a file on this machine. Cited `path:line`. |
| **SEARCH-CORROBORATED** | Two or more independent sources agree via WebSearch, or one source is production code I read. Primary Meta URL cited but **not opened**. Treat as strong but re-checkable. |
| **SINGLE-SOURCE** | One secondary source. Treat as a lead, not a fact. |
| **UNVERIFIED / RECALLED** | From my own prior knowledge, not confirmed this session. **Do not build on it without checking.** |

This matters exactly the way `supabase_migrations.schema_migrations` matters next door: a plausible answer from a source that cannot actually see the truth is worse than no answer. Anything below marked SINGLE-SOURCE or UNVERIFIED must be re-run against `developers.facebook.com` from an unblocked network **before** it becomes a line of code. A consolidated re-verification list is at the end.

---

## 0. What the single-tenant ancestor actually does today (VERIFIED — local)

Read in full: `/home/user/Matrix-Chatbot/MESSENGER_SETUP.md`, `/home/user/Matrix-Chatbot/lib/messengerClient.js`, `/home/user/Matrix-Chatbot/api/messenger.js`.

| Fact | Evidence |
|---|---|
| Graph version pinned to **`v25.0`** in one const | `lib/messengerClient.js:9` |
| Send URL is **`/me/messages`** — the Page is resolved *from the token*, never named | `lib/messengerClient.js:10` |
| Page token comes from **one global env var** with a silent fallback | `lib/messengerClient.js:67-69` (`explicit \|\| process.env.PAGE_ACCESS_TOKEN`) |
| Token is sent as `Authorization: Bearer` — never in a URL/query string | `lib/messengerClient.js:79` |
| `X-Hub-Signature-256` verified as HMAC-SHA256 over raw bytes, constant-time | `lib/messengerClient.js:25-42`; raw body preserved via `api/messenger.js:16-20` (`bodyParser: false`) |
| **Only `object === 'page'` is processed**; anything else gets a bare `200` | `api/messenger.js:99-101` |
| **`entry[].id` is never read.** Tenant routing does not exist. | `api/messenger.js:164-180` — the loop iterates `body.entry` but uses only `entry.messaging` |
| `FACEBOOK_PAGE_ID` is used only as a self-echo guard, not for routing | `api/messenger.js:168, 173` |
| Webhook ACKs `200` fast; slow work goes to QStash; hard-failed enqueues fall back inline; timed-out enqueues deliberately do **not** retry inline (double-reply avoidance) | `api/messenger.js:109-145` |
| Setup doc instructs a **"never-expiring long-lived Page access token"** in `PAGE_ACCESS_TOKEN` | `MESSENGER_SETUP.md:27` |
| Subscribes the app to the Page with `POST /v25.0/{PAGE_ID}/subscribed_apps`, fields `messages,messaging_postbacks` | `MESSENGER_SETUP.md:62-72` |
| Setup doc already names the correct permission set for FB-only: `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, and notes App Review is needed for the general public | `MESSENGER_SETUP.md:73-75` |
| Version policy already understood: "~quarterly, removed after ~2 years" | `MESSENGER_SETUP.md:87-90`, `lib/messengerClient.js:3-5` |

**The five things that must change for multi-tenancy** (named specifically, per the assignment):

1. `api/messenger.js:99` — `object !== 'page'` returns 200 and drops. Instagram arrives as `object: 'instagram'` and is **silently discarded today**. Reception AI on Instagram does not exist in this codebase.
2. `api/messenger.js:164-180` — `entry[].id` must become the tenant routing key, resolved through a server-side registry. And note the array: **one POST can carry entries for several different tenants.** Scoping must be per-entry, never per-request.
3. `lib/messengerClient.js:10` — `/me/messages` must become `/{page-id}/messages` (or `/{ig-id}/messages`). With `/me`, a token/tenant mismatch **succeeds** and posts as the wrong salon. It is the single most dangerous line in the file for a multi-tenant port: there is no error to catch.
4. `lib/messengerClient.js:67-69` — the `|| process.env.PAGE_ACCESS_TOKEN` fallback is exactly the "fallback to a default credential" the project forbids. In a multi-tenant build it means *tenant B's message goes out on tenant A's token*. The token must be a required argument resolved from the tenant record; missing → refuse, never fall back.
5. `MESSENGER_SETUP.md:27` — one env var per credential does not scale to N tenants. Page tokens become per-tenant **data** (see §2.6).

Also note `api/messenger.js:169` (`if (ev.message?.is_echo) continue`) — the echo guard is currently a filter. In multi-tenant Instagram, echoes are *load-bearing for routing* (see §3.3).

---

## 1. Current stable Graph API version and deprecation cadence

**Latest version: `v26.0`. Previous: `v25.0`.**

- **v25.0 released 2026-02-18.** SEARCH-CORROBORATED (Meta's own blog post title indexed as `developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25/` — the date is in the URL path, which is strong; plus Swipe Insight coverage).
- **v26.0 released 2026-07-29.** SEARCH-CORROBORATED (ppc.land "as Graph API v26.0 lands today"; unalsoft blog dated 2026-07-31 discussing v26; a third-party Instagram messaging guide showing live `https://graph.instagram.com/v26.0/<IG_ID>/messages`).
- **Cadence: roughly every 5-6 months**, not quarterly. v22.0 → 2025-01-21; v25.0 → 2026-02-18; v26.0 → 2026-07-29. SEARCH-CORROBORATED. *(`MESSENGER_SETUP.md:89`'s "~quarterly" is now optimistic — it means you get less warning per calendar year, not more.)*
- **Support lifetime: at least 2 years.** Two formulations appear in the wild and they are **not equivalent** — flag this:
  - "Each version is guaranteed to operate for at least two years [from its release]."
  - "A version is no longer usable two years after the date the *subsequent* version is released."
  
  SEARCH-CORROBORATED that both phrasings circulate; **UNVERIFIED which one Meta's `/docs/graph-api/changelog/versions/` table actually implements.** The difference is up to ~6 months of runway. Do not plan an upgrade window on the looser reading.
- **On expiry, calls do not 404 — they silently fall back to the oldest available version.** SINGLE-SOURCE ("then calls silently fall back to an older version"). This is a *behaviour-change-without-an-error* failure exactly like the `GET`-only-route caching trap next door: your requests keep returning `200` while the response shape shifts under you. **If true, pinning a version is not enough — you need a startup assertion that the pinned version is still live.**
- Known upcoming: v19 deprecated 2026-05-21, v20 deprecated 2026-09-24. SINGLE-SOURCE.
- A 2026 example of a *non*-standard schedule: 47 commerce endpoints blocked at v26 launch, extended to all versions ~2026-10-27. SEARCH-CORROBORATED. **Meta does break things faster than the 2-year policy when it wants to.**

**Design consequence.** One `GRAPH_VERSION` constant, as `lib/messengerClient.js:9` already does, is right. Add: (a) the version in every outbound log line, (b) a monthly automated check of the versions table, (c) **per-tenant** version override capability in config so you can canary a bump on one tenant — but a *default* that is one value for the whole deployment. Do not let per-tenant version become a per-tenant code branch.

---

## 2. Page access tokens for Pages in a Business Portfolio

### 2.1 The trap is real

`GET /me/accounts` returning an **empty list** for Pages owned by a Business Portfolio is a widely reported, reproducible condition — there are dedicated Meta Developer Community threads titled "/me/accounts returns empty array" and "me/accounts endpoint is empty for user with a Facebook page". SEARCH-CORROBORATED (thread titles indexed; threads themselves not openable).

**Root cause (SINGLE-SOURCE, plausible, must confirm):** `/me/accounts` enumerates Pages via the person's *personal profile* role. When a Page is owned by a Business Portfolio and the person's access is granted through a **business** role (or through Partner access), the Page is not on their personal list. The commonly reported fix is **Advanced Access to `business_management`**; a second commonly reported (and bad) "fix" is downgrading to v16.

**Do not architect on `/me/accounts`.** It is the `information_schema.role_table_grants` of the Meta API: it returns an empty, plausible, *permission-filtered* answer instead of an error. Same failure shape as the one already documented in `CLAUDE.md`.

### 2.2 The four ways to get a Page token, ranked

| # | Method | Needs | Verdict |
|---|---|---|---|
| 1 | **System User** in Dalatech's Business Portfolio, Page assigned as an asset, app installed → `GET /{page-id}?fields=access_token` | `business_management` + the page scopes; Page must be an assigned asset | **Production answer.** Token is not tied to any person. |
| 2 | `GET /{page-id}?fields=access_token,name` with a **User** token | User has a task role on that Page; `pages_show_list`, usually `pages_read_engagement` and/or `business_management` | Works when you already know the Page ID. Good for onboarding. Token inherits the *user's* fate. |
| 3 | `GET /{business-id}/owned_pages` and `GET /{business-id}/client_pages` | `business_management` | **Discovery**, not credentials. Enumerates what the portfolio owns vs. manages for clients; then per Page do #2. Also `pending_owned_pages` / `pending_client_pages` for un-accepted invitations. |
| 4 | `GET /me/accounts` | `pages_show_list` | **The trap.** Use only as a convenience in the onboarding UI, never as the source of truth, and never treat empty as "no pages". |

Endpoints #3 exist and are documented (`/docs/marketing-api/reference/business/owned_pages/`, `.../client_pages/`, `.../pending_client_pages`, `.../pending_owned_pages`). SEARCH-CORROBORATED (doc URLs indexed with those exact paths; pages not openable). Exact field lists UNVERIFIED.

`GET /{page-id}?fields=access_token` is real and documented; the canonical request form is `https://graph.facebook.com/{version}/{page_id}?fields=name,access_token&access_token={user_access_token}`. SEARCH-CORROBORATED (Postman's official Meta collection has a request literally named "Get Specific Page Access Token").

### 2.3 System User tokens — the key facts

- A System User **lives in the Business Portfolio, not in a person.** Its tokens "do not expire and are not attached to anyone's password." SEARCH-CORROBORATED.
- Creation path: Business Settings → Users → System Users → Add → assign role → **Assign Assets** (select the Pages) → **Generate New Token** (pick the app, pick the permissions). SEARCH-CORROBORATED.
- This is the standard model for production/programmatic access precisely because it survives staff turnover. SEARCH-CORROBORATED.
- **UNVERIFIED:** whether a Page token *derived from* a System User token (via `GET /{page-id}?fields=access_token`) also carries never-expiry, or whether you should call the Page endpoints with the System User token directly. Both patterns are used in the wild. **Check this before designing the refresh path — it determines whether you need one.**

### 2.4 What expires, and when

| Token | Lifetime | Killed by |
|---|---|---|
| Short-lived User | ~1-2 hours (**UNVERIFIED** exact) | time |
| Long-lived User | **~60 days**; expires after ~60 days of no requests, then full re-login. SEARCH-CORROBORATED. | time, password change, permission revoke |
| Page token from a **short-lived** User token | short-lived | time |
| Page token from a **long-lived** User token | **"never expires" — as long as the granting user retains admin access to the Page.** SEARCH-CORROBORATED. | user loses the Page role, user changes password, user revokes the app, app secret rotated, Meta security action, app moved to Dev mode |
| System User token | can be generated with **"Never"** expiry. SEARCH-CORROBORATED. | asset unassigned, system user deleted, app secret rotated, manual revoke |

**"Never-expiring" means "no scheduled expiry", not "cannot be invalidated."** `MESSENGER_SETUP.md:27` says "never-expiring" and that is fine for one Page you control; across N client Pages it is a guarantee you do not have. Chatwoot — a production multi-tenant inbox — handles this by catching **Graph error code `190`** and flipping the channel into an `authorization_error!` state rather than retrying. **VERIFIED by reading production code**: `raw.githubusercontent.com/chatwoot/chatwoot/develop/app/services/instagram/message_text.rb` handles `190` (token expired → `channel.authorization_error!`), `230` (user consent, ignore), `9010` (bot validation → unknown contact), `100` (missing permission / nonexistent user → fallback). Copy this taxonomy.

*(Error-190 subcodes — 460 password changed, 463 expired, 467 invalid — are **UNVERIFIED / RECALLED**.)*

### 2.5 Permissions — what each one buys (VERIFIED by reading `restfb`'s enum, which transcribes Meta's descriptions)

Source read: `raw.githubusercontent.com/restfb/restfb/master/src/main/java/com/restfb/scope/FacebookPermissions.java`

| Permission | Meta's description (verbatim from restfb) | Needed for |
|---|---|---|
| `pages_messaging` | "This allows you to send and receive messages through a Facebook Page." | Reception AI inbound/outbound on Messenger |
| `pages_manage_metadata` | "allows you to subscribe and receive webhooks about activity on the Page, and to update settings on the Page" | `POST /{page-id}/subscribed_apps` |
| `pages_show_list` | "Provides the access to show the list of the Pages that you manage." | onboarding UI only |
| `pages_read_engagement` | "read content (posts, photos, videos, events) posted by the Page, read followers data including name, PSID, and profile picture, and read metadata and other insights" | reading comments/posts; customer profile |
| `pages_manage_engagement` | "create, edit, and delete comments posted on the Page" | **replying to FB comments** |
| `business_management` | "Read and write with Business Management API" | `/{business-id}/owned_pages`, System User flows, the `/me/accounts` fix |
| `instagram_basic` | "Provides the ability to read Instagram accounts you have access to." | IG account metadata |
| `instagram_manage_messages` | "allows business users to read and respond to Instagram Direct messages" | Reception AI on IG DMs |
| `instagram_manage_comments` | *(restfb's text here is a copy-paste of `instagram_basic` — restfb's own bug, not Meta's)* | replying to IG comments |

**Naming split you must handle in config, not in code (SEARCH-CORROBORATED):** the Instagram-Login flavour uses different scope strings — `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_content_publish`. These replaced the older `business_*` short forms, which were deprecated 2025-01-27. The Facebook-Login flavour keeps `instagram_basic` / `instagram_manage_messages` / `instagram_manage_comments`. **Two vocabularies for the same capability → put the scope list in the tenant/connection config as data, keyed by auth flavour.**

### 2.6 Per-tenant page tokens are a key-management problem (design note, not a Meta fact)

The non-negotiable "secrets from the environment only" does not survive contact with N tenants: a Page token is *per-tenant data* that must live in a row. Minimum bar:
- Encrypted at rest with a key from the environment (envelope encryption; the KEK in env, the DEK per row), **never** in a plain column.
- Never in a log line, never in an error message, never in a URL. `lib/messengerClient.js:79` already gets the header-not-query-string part right — keep it.
- Never selectable by any client role. Same posture as `certificates` / `test_history` next door: `authenticated` gets nothing, service-role only, plus a restrictive `_no_client_writes`-style policy, verified per-table against `pg_policies` / `aclexplode(pg_class.relacl)`.
- A per-tenant `token_status` column driven by error `190`, and a health probe. **A dead token is silent** — Reception AI simply stops replying for that salon and nothing throws.

---

## 3. One Meta app, many Pages — how events route

### 3.1 The mechanism

One app, **one callback URL**, one verify token, one app secret. Registering the callback in the App Dashboard **does not subscribe anything**; subscription is a separate per-asset call: `POST /{page-id}/subscribed_apps?subscribed_fields=...` with that Page's token. SEARCH-CORROBORATED (and VERIFIED locally at `MESSENGER_SETUP.md:65-72` that this is what the working integration does).

Audit with `GET /{page-id}/subscribed_apps` (SINGLE-SOURCE for the GET form; the POST form is verified locally).

### 3.2 Payload shape (VERIFIED by reading typed production code)

Source read: `raw.githubusercontent.com/pnmcosta/go-meta-webhooks/main/entry.go` and `changes.go`

```go
type Entry struct {
    Id        string      `json:"id"`
    Time      int64       `json:"time"`
    Messaging []Messaging `json:"messaging,omitempty"`
    Changes   []Change    `json:"changes,omitempty"`
}
type Change struct {
    Field string      `json:"field,omitempty"`
    Value interface{} `json:"value,omitempty"`
}
```

Top level: `{ object, entry: [...] }`. `object` is per-request; `entry` is an **array of distinct event sources** and "may contain multiple entries depending on activity levels from multiple accounts or pages". SEARCH-CORROBORATED.

> **Tenant scoping is per-entry.** One HTTP request can legitimately mix two salons. Any design that resolves "the tenant" once per request is wrong.

### 3.3 What identifies the account — the exact answer, and the exact caveat

**Facebook Page (`object: "page"`): `entry[].id` is the Page ID.** SEARCH-CORROBORATED, consistent across every source, and consistent with `messagingnot using it` in the ancestor.

**Instagram (`object: "instagram"`): `entry[].id` is the *Instagram professional account ID*** — not the linked Page ID, and not the IGSID of the consumer. SEARCH-CORROBORATED, and confirmed by a real payload:

```json
{ "object": "instagram",
  "entry": [{ "id": "17841400000000000", "time": 1747800000,
    "changes": [{ "field": "comments", "value": {
      "id": "18012345678901234", "text": "...",
      "from": { "id": "987654321012345", "username": "..." },
      "media": { "id": "17900112233445566", "media_product_type": "REELS" }}}]}]}
```

Note the `17841...` prefix — that is the classic Instagram professional-account ID shape.

**In messaging payloads the same value also appears as `messaging[].recipient.id`** (and, for echoes, as `messaging[].sender.id`). The consumer is identified by an **IGSID** — an Instagram-scoped ID, unique *per business account per person*, so the same human is a different ID at Matrix Eco Salon and at GS Auto Center. SEARCH-CORROBORATED.

**The caveat that will bite you.** Chatwoot — production, multi-tenant, thousands of installs — **does not route Instagram by `entry[].id`.** I read the code:

- `app/controllers/webhooks/instagram_controller.rb` accepts only `params['object'].casecmp('instagram').zero?`, and resolves the account via `instagram_ids_from_entry`, which takes `messaging.dig(:sender, :id)` **for echo messages** and `messaging.dig(:recipient, :id)` **for inbound**.
- `app/jobs/webhooks/instagram_events_job.rb` reads `entry.id` as `ig_account_id` but then looks the channel up from the messaging IDs, and maintains **two** channel tables — `Channel::Instagram` (Instagram Login) and `Channel::FacebookPage` (Facebook Login) — both keyed by `instagram_id`, with an explicit comment that *"priority is for instagram channel which created via instagram login."* It also applies a **2-second delay on echo events** to avoid a race where Meta's echo arrives before the send-API call returns.

Read that as: the "same value in `entry.id`, `recipient.id` and your stored account ID" invariant is **not something a serious implementation trusts blindly**, and the two Instagram auth flavours can yield IDs you must reconcile. There are Meta community threads titled *"Mismatch Between IDs in Instagram Business Webhooks and …"*.

**My recommended routing rule (design, derived):**

```
for each entry in body.entry:
    key = (body.object == 'page')
          ? entry.id                                   # Page ID
          : entry.id                                   # IG professional account ID
    tenant = registry.lookup(body.object, key)         # server-side, exact match
    if tenant is null:
        counter('webhook.unrouted', object=body.object) ; log key ; DROP ; 200
    # cross-check, do not trust:
    for m in entry.messaging or []:
        expected = m.message?.is_echo ? m.sender.id : m.recipient.id
        if expected != key: counter('webhook.entry_id_mismatch') ; prefer `expected`
```

Registry table sketch:

```sql
create table channel_identity (
  provider      text not null check (provider in ('facebook_page','instagram')),
  external_id   text not null,          -- Page ID, or IG professional account ID
  tenant_id     uuid not null references tenant(id),
  auth_flavour  text not null check (auth_flavour in ('facebook_login','instagram_login')),
  primary key (provider, external_id)   -- one identity -> exactly one tenant, enforced by PK
);
```

The PK is the whole point: **an identity can never map to two tenants**, and an unknown identity has nowhere to go but the drop path. Never `upsert` a tenant from a webhook. Never take a tenant hint from the body beyond this lookup.

**UNVERIFIED and important:** whether Meta guarantees `entry[].messaging` contains at most one element (I recall the docs saying "this array will only contain one messaging object" for page messaging). Write the loop as a loop regardless.

---

## 4. Instagram messaging vs Facebook messaging

| | Facebook Messenger | Instagram DMs |
|---|---|---|
| Webhook `object` | `"page"` | `"instagram"` |
| `entry[].id` | Page ID | IG professional account ID |
| Subscription call | `POST /{page-id}/subscribed_apps` | `POST /{page-id}/subscribed_apps` (FB Login) — the IG account is reached *through* the Page. SEARCH-CORROBORATED. For Instagram Login, the subscription is on the IG account. **UNVERIFIED exact form** (`POST /{ig-user-id}/subscribed_apps` is the reported shape, SINGLE-SOURCE). |
| App-Dashboard subscription | subscribe the **`page`** object | subscribe the **`instagram`** object |
| One subscription for both? | **No.** You register **one callback URL** and subscribe **both objects to it separately.** SEARCH-CORROBORATED ("you can subscribe to more fields under Instagram and other objects using the same URL", but "registering the callback URL … does not automatically subscribe any Page, User, or Instagram Account"). |
| Send endpoint | `POST /{page-id}/messages` (the ancestor uses `/me/messages` — `lib/messengerClient.js:10`) on `graph.facebook.com` | `POST /{ig-user-id}/messages`. Host is `graph.facebook.com` for the Facebook-Login flavour, `graph.instagram.com` for the Instagram-Login flavour. SEARCH-CORROBORATED; a live example seen as `https://graph.instagram.com/v26.0/<IG_ID>/messages`. |
| Credential | Page access token | FB Login flavour: the **Page** access token, with `instagram_manage_messages` granted. Instagram Login flavour: an **Instagram User** access token. SEARCH-CORROBORATED. |
| Recipient ID | PSID (page-scoped) | IGSID (Instagram-scoped, per business account) |
| Permission set | `pages_messaging` (+ `pages_manage_metadata`, `pages_show_list`) | `instagram_basic` + `instagram_manage_messages` + `pages_messaging`; or `instagram_business_basic` + `instagram_business_manage_messages` |

**Two auth flavours, one product.** Facebook Login for Business is what an agency/SaaS with many client accounts should use — it integrates with Business Portfolio asset assignment. Instagram Login (Business Login for Instagram) is simpler for a single self-serve account. SEARCH-CORROBORATED. **Pick one for Dala AI and make the other a config value, not a branch** — the tenant record carries `auth_flavour`, and the send-client selects host + path + token column from a small table keyed on it. That is data, not a code branch.

**Design consequence for the port:** `api/messenger.js:99` (`body.object !== 'page'` → 200-and-drop) is the exact line that must become an object→adapter dispatch. Today, subscribing the `instagram` object would produce a bot that ACKs perfectly and answers nobody — a silent failure with a 200, which is the failure class `CLAUDE.md` is already scarred by.

---

## 5. Comment webhooks

### 5.1 Facebook Page comments

- Delivered on `object: "page"`, **field `feed`**. The value carries `item` (`"comment" | "post" | "photo" | "video" | …`), `verb` (`"add" | "edited" | "remove" | "hide"`), plus `from`, `post_id`, `comment_id`, `message`, `created_time`, `is_hidden`. SEARCH-CORROBORATED.
- A comment is `field: "feed"` + `item: "comment"` + `verb: "add"`. **There is no dedicated `comments` field on the page object** — you subscribe to the firehose of `feed` and filter. Budget for that: you will receive your own page's posts and edits too.
- Payloads often omit media and parent-comment info; enrichment requires a follow-up Graph read. SEARCH-CORROBORATED. **That read costs a call against the tenant's rate budget — meter it.**
- **Reply publicly:** `POST /{comment-id}/comments` with `message`. Needs a Page token whose grantor has the **MODERATE** task, plus `pages_read_engagement` + `pages_manage_engagement`. SEARCH-CORROBORATED. *(One indexed source says `POST /{comment-id}` for posting comments; the `/{comment-id}/comments` edge is the well-established form. **Re-verify the exact edge.**)*

### 5.2 Instagram comments

- Delivered on `object: "instagram"`, **field `comments`**, with `entry[].id` = the IG professional account ID. Payload: `value.id` (comment ID), `value.text`, `value.from.{id,username}`, `value.media.{id,media_product_type}`. SEARCH-CORROBORATED, with a concrete payload (§3.3).
- Requires `instagram_manage_comments` granted, **and the app in Live mode**, to receive notifications. SEARCH-CORROBORATED.
- **Album gotcha:** comment webhooks on albums do **not** include the album ID — you must query the comment ID and request the `media` field. SEARCH-CORROBORATED. Another paid Graph call per event.
- **Reply publicly:** `POST /{ig-comment-id}/replies` with `message`. SEARCH-CORROBORATED.

### 5.3 Private replies (comment → DM) — the important one for Reception AI

| Property | Value | Mark |
|---|---|---|
| Endpoint | `POST /{page-id}/messages` (FB) / `POST /{ig-user-id}/messages` (IG) with `recipient: {"comment_id": "<id>"}` | SEARCH-CORROBORATED (two independent sources give the identical `{"comment_id": …}` recipient block) |
| Limit | **Exactly one private reply per comment, ever.** A second attempt returns **error subcode `2534014`**. | SEARCH-CORROBORATED (subcode from one source — treat the *number* as SINGLE-SOURCE, the *rule* as corroborated) |
| Window | **7 days**, clocked **from the comment's creation timestamp**, not from webhook receipt | SEARCH-CORROBORATED (both the FB and IG sources say 7 days; the "clocked from creation, not receipt" detail is SINGLE-SOURCE and is the one that will silently eat your late retries) |
| Content | **Text only.** The message auto-appends a link to the post/comment. | SEARCH-CORROBORATED |

**This shapes the queue design.** A private reply is a **non-idempotent, single-use, expiring** action:
- Dedupe on `comment_id` in a `private_reply_sent` table with a unique constraint, **before** the send — not after, and not only in Redis. A duplicate QStash delivery must hit a DB uniqueness violation, not a second Graph call.
- Treat subcode `2534014` as **success-equivalent** (already replied), never as a retryable error. Getting this wrong makes every retry burn an AI generation for a message Meta will refuse.
- Compute the deadline from `value.created_time`, and **refuse to spend on generation** if the comment is already older than 7 days minus a safety margin. That check is free and must come *before* the Anthropic call — it is a budget gate, and it belongs in the same fail-closed ordering as identity → entitlement → budget.

### 5.4 Rate limits specific to comments

No comment-specific limit surfaced. Comment reads/writes fall under the general Page + BUC limits in §8. **UNVERIFIED** whether private replies carry their own throttle.

---

## 6. `X-Hub-Signature-256` — confirmed: it does NOT identify the tenant

**Confirmed.** The signature is `sha256=` + HMAC-SHA256 of the **raw request body**, keyed by the **app secret**. SEARCH-CORROBORATED, and VERIFIED as the working implementation locally at `lib/messengerClient.js:25-42`.

One app → one app secret → **every** subscribed Page and IG account produces a signature under the *same key*. A valid signature proves:
- the payload was not tampered with, and
- it was produced by someone holding your app secret (i.e. Meta, or anyone who has leaked it).

It proves **nothing whatsoever** about which tenant the event belongs to.

**What actually identifies the tenant:** the server-side registry lookup on `(object, entry[].id)` described in §3.3 — a lookup you control, in a table you own, with a primary key that forbids ambiguity. Nothing from the request body may substitute for it.

Two hardening notes from production code I read:
- Chatwoot's `MetaTokenVerifyConcern` (verbatim, `app/controllers/concerns/meta_token_verify_concern.rb`) collects **a set of candidate app secrets** — globals plus per-channel `provider_config` secrets under keys `app_secret`, `app_secret_key`, `client_secret`, `api_secret` — and accepts if **any** matches, using `ActiveSupport::SecurityUtils.secure_compare` over `request.raw_post`. That is the shape you need if Dala AI ever runs more than one Meta app (e.g. a legacy app for Matrix and a new one for everyone else). It also means **the number of app secrets is itself config, not a constant.**
- The raw body must be captured before any JSON parsing. `api/messenger.js:16-20` already does this with `bodyParser: false`. **In Next.js App Router the equivalent is `await req.text()` before `JSON.parse` — and you must not let any middleware consume the stream first.**

Failure modes to specify: missing header → 401; malformed prefix → 401; **app secret env var missing → 401, never "skip verification"** (Chatwoot's `meta_signature_verification_required?` returning `true` unconditionally is the right default; a config flag that can turn it off is a foot-gun). Signature valid but `entry.id` unknown → **200 + drop + alert**, never 4xx (a 4xx to Meta risks the subscription being disabled, see §8).

---

## 7. The 24-hour window and message tags — **the biggest finding for Customer Care AI**

### 7.1 Standard window

Inside **24 hours** of the user's last message, a business may send freely (Messenger and Instagram alike). SEARCH-CORROBORATED. Reception AI lives entirely inside this window and is unaffected by everything below.

### 7.2 The legacy message tags are DEAD as of 2026-04-27

**`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, and `POST_PURCHASE_UPDATE` were retired on 2026-04-27. API requests containing them return error code `100`.** SEARCH-CORROBORATED across four independent sources (Manychat's community product-update post, chatbotscape, chatimize, and a summary citing the Messenger Platform changelog).

Also: **Recurring Notifications ended 2026-02-10 globally** (except AU, EU, JP, KR, UK), replaced by the **Marketing Messages on Messenger** API. SEARCH-CORROBORATED (single strong source, corroborated in framing by a second).

Replacement: **Utility Templates inside the Marketing Messages on Messenger API** — a template-approval + category-selection workflow analogous to WhatsApp templates. Covers order confirmations, shipping updates, account notifications, and **appointment/event reminders** outside the 24-hour window. SEARCH-CORROBORATED.

### 7.3 `HUMAN_AGENT` survives — but it is not for you

- Extends the window to **7 days**. SEARCH-CORROBORATED.
- **"Meta explicitly prohibits using it for automated or bot messages and detects misuse."** SEARCH-CORROBORATED, stated in near-identical terms by three sources.
- Availability on Instagram is **CONTESTED**: Chatwoot's user guide is titled *"What is Human Agent tag in Instagram/Messenger channel"* (implying both), while another source states "the 7-day human-agent extension lives only on Messenger, not Instagram" and "several outside-window mechanisms exist only on Messenger and have never been available on the Instagram Messaging API." **UNRESOLVED — founder-level risk, flagged in the open questions.**

### 7.4 What this means for Customer Care AI — state it plainly

**Customer Care AI as specified — outbound reminders, win-back, review requests — cannot be delivered on Messenger by an AI under any tag that exists today.**

- Tags: gone (2026-04-27).
- `HUMAN_AGENT`: exists, but sending AI-composed text under it is a policy violation Meta says it detects. An AI writing a message and a human clicking "send" is the boundary, and it is a *product* boundary, not a technical one.
- Marketing/Utility Templates: the only compliant path. But it is **template-approved, category-gated, and per-template** — i.e. the exact opposite of free-form AI generation, and plausibly metered/paid (**UNVERIFIED** whether Marketing Messages on Messenger carries per-message pricing like WhatsApp; if it does, it is a *new* unmetered-spend surface and rule #5 applies to it).
- SMS via the Mongolian SIP trunk: gated, does not exist yet — and is now revealed as **not merely one channel among several but the only unencumbered one** for Mongolian outbound.

**Design instruction that follows:** do **not** build the Customer Care seam around "message tags". Build it around a per-channel **outbound eligibility policy** resolved as data:

```ts
type OutboundPolicy = {
  channel: 'messenger' | 'instagram' | 'sms';
  window_hours: number | null;        // 24 for messenger/instagram, null for sms
  free_form_outside_window: boolean;  // false everywhere on Meta today
  template_required: boolean;         // true for messenger outside window
  ai_authored_allowed: boolean;       // false under HUMAN_AGENT
  per_message_cost_usd: number | null;// must be non-null before any send is permitted
};
```

A send is refused unless the policy permits it **and** the tenant's ledger can afford `per_message_cost_usd`. `per_message_cost_usd === null` means "unknown price" and must **refuse**, not default to zero — the same reasoning that made `BANK_BUILD_BUDGET_USD` zero next door: a value that refuses without depending on an unreliable read.

---

## 8. Rate limits — what a multi-tenant app must watch

Three independent, simultaneously-enforced systems. SEARCH-CORROBORATED throughout; individual numbers marked.

| System | Limit | Header | Scope |
|---|---|---|---|
| **App-level (Platform)** | `200 × (number of app users)` calls **per hour** | `X-App-Usage` — `{call_count, total_cputime, total_time}`, each a percentage | **Your whole app — shared across every tenant** |
| **Page-level** | `4,800 × (engaged users)` per **24h sliding window**, per Page | `X-Page-Usage` | Per Page |
| **Business Use Case (BUC)** | Separate budget **per product per asset** — `pages`, `instagram`, `messenger`, `ads_insights`, `ads_management`, `leadgen`, `custom_audience` each carry their own | `X-Business-Use-Case-Usage`, keyed by business ID | Per business × product |
| **Messenger Send API** | **300 calls/sec per Page** for text/links/reactions/stickers; **10 calls/sec per Page** for audio/video. Plus `200 × engaged users` per rolling 24h. | — | Per Page |

Additional: "your app may be rate limited if too many messages are being sent to a single thread." SEARCH-CORROBORATED. Error **`613`** = "Calls to this api have exceeded the rate limit" — the canonical Messenger throttle error, widely reported. SEARCH-CORROBORATED. *(Errors `4`, `17`, `32`, `80006` are **UNVERIFIED / RECALLED**.)*

**The multi-tenant conclusion, stated as a rule:**

> The **app-level** budget is the shared resource. It scales with *your app's* user count, not with any tenant's. A single misbehaving tenant — a viral post generating a comment storm at GS Auto Center — consumes headroom that belongs to Matrix Eco Salon. **Meta will not fair-share for you.**

So:
1. **Per-tenant token bucket in your own layer**, before the Graph call. Upstash is already in the stack for exactly this. Key it `ratelimit:meta:{tenant_id}:{provider}`, and — per rule #1 — the tenant in that key must come from the registry lookup, never the body.
2. **A global app-level bucket sized below Meta's**, so you throttle yourself before Meta throttles you. Meta's throttle is opaque and page-wide; yours is observable and per-tenant.
3. **Parse `X-App-Usage` / `X-Page-Usage` / `X-Business-Use-Case-Usage` on every response** and store the high-water mark per tenant. These are the only visibility you get. A tenant sitting at 80% `X-Page-Usage` is a page about to go silent.
4. **Fail closed.** When your limiter cannot be consulted, refuse — same policy as `src/lib/rateLimit.ts`, same `FAIL_OPEN_KEYS` discipline (the webhook *ACK* may fail open, since a non-200 risks unsubscription; the *Graph call and the Anthropic call* must not).
5. `613` and any 4xx-with-rate-limit must **back off that tenant only** — never the whole worker — and must not re-enter the Anthropic generation path on retry. The reply is already generated; retry the send, not the thought. (The ancestor's inline/queue split at `api/messenger.js:109-145` is the right skeleton; what it lacks is per-tenant isolation.)

**Webhook delivery reliability (SEARCH-CORROBORATED, from a Meta Developer Community thread's indexed text):** *"If delivery of a notification continues to fail for 1 hour, you will receive a Webhooks Disabled alert, and your app will be unsubscribed from the webhooks for the Page or Instagram Professional account. Once you have fixed the issues you will need to subscribe to the Webhooks again."*

That is a **per-asset** unsubscription. Consequences:
- The ancestor's "ACK 200 fast, never let slow work delay it" posture (`api/messenger.js:6-8, 24-27, 149-153`) is not a nicety, it is the thing standing between you and a silently-unsubscribed tenant. **Carry it over verbatim.**
- A tenant can end up unsubscribed and you will not find out from a request — you find out from the *absence* of requests. **You need a per-tenant "last webhook received at" watchdog** and a periodic reconciliation of `GET /{page-id}/subscribed_apps` against your registry. That reconciliation is a scheduled job → rule #6 applies: explicit ceiling, explicit alert path, and it must not touch Anthropic.
- Meta webhooks are **at-least-once**: duplicates are expected. Dedupe on `message.mid` (messaging) and `value.id` (comments) with a DB uniqueness constraint. The ancestor already reasons about this at `api/messenger.js:118-127` (a timed-out enqueue is deliberately *not* retried inline, because it may have landed) — that instinct is correct and must be promoted into a real idempotency key. *(Meta's exact retry schedule is **UNVERIFIED**.)*

---

## 9. App Review, Advanced Access, and Business Portfolio onboarding

### 9.1 What you need approved

Messaging the general public across Pages the app does not own requires **Advanced Access** on every permission in §2.5. SEARCH-CORROBORATED, including the precise boundary:

> "App Review is required if your app needs Advanced Access, but **not** required if you only send and receive messages for your **own** Facebook Page."

That boundary is exactly where Dala AI sits and Matrix-Chatbot did not. Matrix-Chatbot could plausibly have run on Standard Access against its own Page. **Dala AI cannot.** `MESSENGER_SETUP.md:73-75` already anticipates this.

Also SEARCH-CORROBORATED: *"If you are building an app that publishes posts, reads engagement data, or moderates comments on Facebook Pages you do not personally own, the core Page management permissions all require a full Facebook App Review before your app can use them on real client Pages."* — that sentence covers the comment-reply feature specifically.

And: *"To receive webhooks notifications while your app is in Live mode, app users must grant your app the `instagram_manage_comments` permission."*

### 9.2 Prerequisites and timeline

- **Business Verification** of Dalatech's Business Portfolio — legal registration documents, utility bills, or tax certificates that **match the Business Manager details precisely**. Must complete *before* any Advanced Access submission. SEARCH-CORROBORATED. For a Mongolian entity this is the long pole; it involves document formats Meta may or may not accept from MN.
- **App Review turnaround: ~20 days in 2026**, up from a previously advertised 10. SEARCH-CORROBORATED (a source specifically titled "Meta App Review Now Takes 20 Days: Why It's Slower in 2026"). One source cites "~24 hours" for some flows — that is not the flow you are in.
- **Screencast requirement:** demonstrate sending a message to your Page and the message being received and replied to within 24 hours. A working prototype is required *before* submission. SEARCH-CORROBORATED.
- **UNVERIFIED:** whether Dala AI needs formal **Tech Provider** status. That programme is documented for WhatsApp; the search results conflate it with Messenger/Instagram. Since Customer Care's SMS path bypasses WhatsApp entirely, this may be moot — **but confirm, because Tech Provider onboarding is a months-long track, not a days-long one.**

### 9.3 Onboarding client #3's Page — two shapes, pick one

**Shape A — Partner access (recommended).** The client's Business Portfolio grants Dalatech's Business Portfolio **Partner access** to the Page. Path: *Business Settings → Users → Partners → Add → "Give a partner access to your assets" → enter Dalatech's business ID → select the Page.* Only admins can do this; the partner must have a Business Manager. SEARCH-CORROBORATED. One source stresses assigning **Full control** for the Page, since partial access limits actions when the Page is connected to a third-party tool.

Then: assign the Page to Dalatech's **System User**, install the app, mint the Page token via `GET /{page-id}?fields=access_token`. The client keeps ownership; Dalatech's credential survives any individual person leaving either company.

**Shape B — Facebook Login for Business.** The client logs into a Dala AI onboarding page and grants the app their Page. Simpler UX, but the token's life is coupled to that human's Page role and password. For a salon where the owner's nephew set up the Page, this breaks at the worst moment.

**Both shapes are the same code.** The difference is a value in `channel_identity.auth_flavour` plus which token-acquisition runbook you follow. Onboarding client #3 stays "fill in a config."

**What onboarding must produce, per tenant, as data:**

```
tenant_id, provider ('facebook_page'|'instagram'), external_id,
auth_flavour, encrypted_page_token, token_status, granted_scopes[],
subscribed_fields[], graph_version_override (nullable),
business_id (nullable), last_webhook_at, outbound_policy_ref
```

Nothing in that list is code. If client #3 needs a column you do not have, add the column — do not add a branch.

---

## Failure modes, consolidated

| Failure | Symptom | Correct response |
|---|---|---|
| Page token expired/revoked | Graph `190` | Mark tenant `token_status='authorization_error'`, **stop all sends for that tenant**, alert founder. Never retry a `190`. (Pattern read from Chatwoot production code.) |
| Token present but wrong tenant's | With `/me/messages`: **succeeds, posts as the wrong salon.** With `/{page-id}/messages`: fails. | Never use `/me`. Cross-check `entry.id` against the token's owning tenant before the send. |
| `entry.id` not in registry | — | 200 + drop + `webhook.unrouted` counter + alert. **Never auto-create a tenant.** |
| Signature invalid / app secret missing | — | 401. Missing secret is 401, not "skip". |
| Webhook handler slow | Meta unsubscribes the Page after ~1h of failures | ACK 200 before all slow work (carry `api/messenger.js:109-154` over). Watchdog on `last_webhook_at`. Periodic `GET /{page-id}/subscribed_apps` reconciliation. |
| Event delivered twice | Duplicate reply, duplicate AI spend | DB-unique on `message.mid` / comment `value.id`, checked **before** the Anthropic call. |
| Private reply retried | Subcode `2534014` | Treat as success. Never regenerate. |
| Private reply arrives late | Silent failure at day 7 (clocked from comment creation) | Deadline check **before** generation. |
| Rate limited (`613`) | — | Back off *that tenant*, retry the **send** only, never re-enter generation. |
| One tenant floods the app-level budget | Other tenants' calls start failing | Per-tenant bucket + a global bucket sized under Meta's + usage-header monitoring. |
| Graph version expires | **Silent fallback to an older version**, `200` with a different shape | Startup + monthly assertion that the pinned version is live. |
| Message tag used | Error `100` since 2026-04-27 | Do not build tags. Build the outbound-policy object. |
| Instagram event arrives | Today: `200` + dropped, no log | Object→adapter dispatch, plus a counter on unrecognised `object` values. |

---

## Must re-verify before writing code (blocked from primary source this session)

Run every one of these against `developers.facebook.com` from an unblocked network. **A search summary is not a migration applied to the database.**

1. `/docs/graph-api/changelog/versions/` — the actual release/expiry table, and **which** of the two 2-year formulations it implements.
2. Whether an expired version silently falls back rather than erroring. This determines whether a version pin is safe.
3. Exact field lists and paging for `/{business-id}/owned_pages` and `/client_pages`.
4. Whether a Page token derived from a **System User** token inherits never-expiry.
5. `/docs/messenger-platform/instagram/features/webhook/` — the canonical Instagram messaging webhook payload, and an unambiguous statement of what `entry[].id` is under **each** auth flavour. This is the single highest-value item on the list: tenant routing depends on it and my sources disagreed with production code.
6. The exact subscription call for Instagram Login (`POST /{ig-user-id}/subscribed_apps`?).
7. Whether `HUMAN_AGENT` is supported on Instagram. Sources directly contradict each other.
8. Marketing Messages on Messenger / Utility Templates: eligibility, approval process, regional availability **in Mongolia**, and **per-message pricing**.
9. The public comment-reply edge: `POST /{comment-id}/comments` vs `POST /{comment-id}`.
10. Private-reply error subcode `2534014` and the exact clock start for the 7-day window.
11. Meta's webhook retry schedule and the precise unsubscription threshold.
12. Whether `entry[].messaging` is guaranteed to hold at most one element.
13. Whether Dala AI requires Tech Provider status, or only Business Verification + Advanced Access.
14. Current Messenger/Instagram error-code table (`613`, `100`, `190` subcodes, `2018108`, `551`).

---

## Open questions — the founder's call, not mine

1. **Customer Care AI on Messenger may not be buildable as specified.** The tags it would have used died 2026-04-27; the surviving `HUMAN_AGENT` path forbids AI-authored text. The compliant path is template-approved Utility Messages — approval-gated, category-constrained, possibly per-message priced. Does Customer Care ship as **SMS-only** (fully gated on the SIP trunk, so the feature does not exist until the trunk does), or does Dalatech commit to the Utility Template approval track on Messenger as a second, separate product surface?
2. **Which Instagram auth flavour is the house standard** — Facebook Login for Business (fits Business Portfolio + Partner access + agency operations, more moving parts) or Instagram Login (simpler, weaker for many-client management)? This decides the token model, the scope vocabulary, and the send host. Supporting both is possible as config but doubles the onboarding runbook and the App Review surface.
3. **Partner access or Facebook Login for onboarding?** Partner access is durable and survives staff turnover but requires each Mongolian SMB to have a Business Portfolio and an admin who can navigate Business Settings. Facebook Login is a two-click flow whose credential dies when the owner changes their password. For a salon in Ulaanbaatar, which friction is acceptable?
4. **Business Verification is the critical path.** ~20-day App Review *plus* verification of a Mongolian legal entity, and no Advanced Access before it clears. Does tenant #2 (GS Auto Center) wait for approval, or does Dalatech run the first two tenants under a narrower footprint (own-Page Standard Access) and accept a second migration later?
5. **One Meta app or one per tenant?** One app is the design premise and is right — but it means one shared app-level rate budget, one shared App Review verdict, and one shared blast radius: a policy strike takes down every tenant simultaneously. Is that concentration acceptable, or is a small number of apps (sharded by tenant cohort) worth the operational cost? Chatwoot's per-channel app-secret support exists precisely because real deployments end up wanting this.
6. **What happens when a tenant's page token dies at 2am?** Reception AI goes silent with no error anywhere — the customer just gets nothing. Who is paged, on what channel, and what is the promised time-to-restore in the tenant contract?
7. **Comment replies expand the App Review surface** (`pages_manage_engagement`, `instagram_manage_comments`) and add per-event enrichment calls against each tenant's rate budget. Is comment handling in the v1 scope, or does Reception AI ship DM-only first and add comments after Advanced Access is secured?
---

I stood up a local PostgreSQL 16.13 cluster and verified every claim below by execution. Scratch scripts are in `/tmp/pgwork/*.sql`; the database is `dalaai` on the local cluster.

---

# Multi-tenant RLS in Supabase/Postgres — research for Dala AI

## 0. What is verified vs. assumed

**Verified by execution** on a local PostgreSQL **16.13** cluster (`C.UTF-8` database collation) modelling Supabase's roles — `anon`, `authenticated`, `service_role` (created `BYPASSRLS`), plus `auth.uid()` / `auth.jwt()` reading `current_setting('request.jwt.claims')`: everything in §3, §4, §5, the timing table in §2.4, and every Cyrillic result in §7.

**Verified by reading a file**: `/home/user/dalatech-english/docs/security-audit-2026-08-23.md` (full), `/home/user/Matrix-Chatbot/lib/messengerClient.js:68`, `/home/user/dalatech-english/docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md:~1020`.

**Verified by reading vendor docs** (fetched through the Supabase docs MCP and Context7's mirror of postgresql.org; direct HTTP to `supabase.com` and `postgresql.org` is blocked by this session's egress proxy): §1 references, §2.1 hook contract, §6 Vault/pgsodium/key-model status.

**Two version gaps to hold in mind.** The local cluster is PG16; Supabase production next door is **PG17.6** (`security-audit-2026-08-23.md:433`), which adds the `MAINTAIN` privilege — so the ACL residue on a PG17 project is `Dxtm` (4 privileges), not PG16's `Dxt` (3). And the local database is `C.UTF-8` while a Supabase project is created `en_US.UTF-8` (§7.1 covers what that changes, and what it does not).

---

## 1. Tenant scoping: `tenant_id` column vs. schema-per-tenant vs. database-per-tenant

### Recommendation: **shared schema + `tenant_id uuid not null` + RLS.** Not close.

The decisive argument is not performance or cost. It is your own hard test: *onboarding client #3 must be filling in a config, not writing code.* Schema-per-tenant makes onboarding a **DDL operation** — `create schema`, replay N migrations, re-grant, re-policy — and makes every future migration an N-times loop that can fail partway. You already have the canonical war story for partial application: `20260817` was applied to one of four tables and the gap was invisible for weeks (`security-audit-2026-08-23.md:291-302`). Schema-per-tenant multiplies that exact failure surface by the number of tenants and gives it a new axis (per-tenant drift) that no catalog query you write today will think to check.

| | 2 tenants | 20 tenants | 200 tenants |
|---|---|---|---|
| **Shared schema + RLS** | Onboarding = 1 `insert into tenants`. Migration = 1 run. Cross-tenant analytics (the Analytics AI monthly report) = 1 query with `group by tenant_id`. Risk: one bad policy or one service-role route missing a `.eq('tenant_id', …)` leaks everything. | Unchanged. Indexes need `tenant_id` as leading column. | Unchanged. Consider `partition by hash (tenant_id)` only if a table passes ~50M rows; not before. |
| **Schema-per-tenant** | Feels clean at 2. | 20 migration runs per deploy, each independently failable. `search_path` becomes a security control, and `search_path` is the single most common Postgres privilege-escalation vector. Cross-tenant reporting = dynamic SQL over `information_schema`. | Thousands of relations; `pg_dump`, autovacuum, and the planner's catalog cache all degrade. Connection pooling breaks: PgBouncer transaction mode cannot safely carry a per-session `search_path`. |
| **Database-per-tenant** | Only justifiable for a contractual data-residency requirement. | One Supabase project per tenant = one bill, one set of keys, one auth config, one migration run **each**. For a solo founder this is the end of the product. | Not a solo-founder architecture. |

Two further reasons specific to Dala AI:

- **Quality layer and Analytics AI are inherently cross-tenant.** The Quality layer reviews conversations across all tenants to propose KB updates for the founder; Analytics produces per-tenant reports the founder compares. Both are `select … where tenant_id = …` / `group by tenant_id` in a shared schema, and both are painful dynamic SQL in schema-per-tenant.
- **The webhook path has no session.** A Meta webhook POST arrives with no user JWT. Whatever isolation model you pick, the inbound path runs as `service_role` and derives the tenant from the payload's `entry[].id` (the Page ID). That means **RLS is not what protects the inbound path in any of the three models** — see §5. Schema-per-tenant buys you nothing there, and costs you everything at onboarding.

**One structural rule that makes the shared-schema choice safe:** `tenant_id` is `not null` on every tenant-scoped table, and every foreign key between tenant-scoped tables is a **composite** FK that carries `tenant_id`:

```sql
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  ...
  unique (tenant_id, id)                    -- makes the composite FK below possible
);

create table messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  conversation_id uuid not null,
  ...
  foreign key (tenant_id, conversation_id)
    references conversations (tenant_id, id)  -- a child can NEVER cross tenants
);
```

This is the cheapest available defence against the failure mode RLS cannot catch: a service-role route that looked up a `conversation_id` correctly but wrote the wrong `tenant_id`. The database refuses it. **Note the sharp edge** (Postgres docs, verified): `REFERENCES` and referential-integrity checks are *not* subject to RLS, so this constraint keeps working under any policy — which is what you want here, and is the same fact that makes a `REFERENCES` grant to `anon` a real (if minor) problem.

Sources: [Supabase RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL 5.9 Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), [Multi-tenant SaaS: RLS vs schema-per-tenant vs database-per-tenant](https://aliasghar.me/blog/multi-tenant-saas-data-isolation).

---

## 2. Carrying tenant identity into RLS

Three mechanisms. They are not equivalent, and the right answer is **two of them, for two different callers**.

### 2.1 JWT custom claim via the Custom Access Token Hook

A Postgres function is registered as an auth hook; it runs **before every token is issued** and can add claims. Verified from the docs, the hook's `authentication_method` input enum includes `token_refresh`, so it runs on refresh as well as sign-in — meaning claims re-materialise every refresh cycle, not only at login.

```sql
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable as $$
declare claims jsonb; t uuid;
begin
  select tm.tenant_id into t
  from public.tenant_members tm
  where tm.user_id = (event->>'user_id')::uuid
  order by tm.created_at limit 1;

  claims := event->'claims';
  claims := jsonb_set(claims, '{app_metadata, tenant_id}',
                      coalesce(to_jsonb(t::text), 'null'::jsonb));
  return jsonb_set(event, '{claims}', claims);
end $$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant all on table public.tenant_members to supabase_auth_admin;
revoke all on table public.tenant_members from authenticated, anon, public;
create policy "auth admin reads memberships" on public.tenant_members
  as permissive for select to supabase_auth_admin using (true);
```

Read in a policy as `(select auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid`.

**Correctness caveats, in order of how likely they are to bite you:**

1. **The claim is a snapshot, stale until the next refresh.** Revoking a user's membership does not take effect until their access token expires (default 1 hour). For Dala AI this is acceptable — the dashboard users are two salon owners and you — but it must be a *decision*, not an accident. If you ever need instant revocation, the JWT claim cannot be the only check.
2. **Put the claim under `app_metadata`, never `user_metadata`.** `user_metadata` is user-writable through `auth.updateUser()`; `app_metadata` is not. A `tenant_id` in `user_metadata` is a self-service tenant-switch button. This is the exact shape of the `profiles.tier` freeze already in place next door.
3. **The hook is `stable` and runs inside the Auth server's transaction.** If it throws, token issuance fails — sign-in breaks for everyone. That is fail-closed, which is right, but it means the hook must be trivially simple. One `select`, no network, no `pg_net`.
4. **A hook returning an error object rejects the login.** The docs show `jsonb_build_object('error', jsonb_build_object('http_code', 403, …))`. Useful for suspending a delinquent tenant, and worth designing in from the start.

### 2.2 `tenant_members` join table checked in the policy

The general form. Correct, always-current, no staleness. Two traps, **both verified by execution**:

**Trap A — the silent-empty trap, and it is the audit's own failure class.** A policy that joins `tenant_members` runs that join *under `tenant_members`'s own RLS*. If `tenant_members` has RLS enabled with no policy for `authenticated`, the join returns nothing and **the outer query returns zero rows with no error**:

```
--- EXISTS join on tenant_members (RLS on, no policies) ---
 Seq Scan on perf_rows (actual rows=0 loops=1)
   Filter: (hashed SubPlan 2)
   Rows Removed by Filter: 200000
   SubPlan 2
     ->  Seq Scan on tenant_members tm (actual rows=0 loops=1)
           Filter: (false AND (user_id = …))     -- ← the deny-all policy collapsed to false
 Execution Time: 3599.326 ms
```

An empty dashboard, 3.6 seconds, HTTP 200, `error: null`. This is precisely "fails by returning a plausible answer instead of an error" (`security-audit-2026-08-23.md:364`) — now demonstrated inside RLS itself. **The fix is a `SECURITY DEFINER` function**, which bypasses `tenant_members`'s RLS and makes the policy independent of a second table's policy state:

```sql
create or replace function public.current_tenant_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(tm.tenant_id), '{}')
  from public.tenant_members tm
  where tm.user_id = (select auth.uid())
$$;
revoke execute on function public.current_tenant_ids() from public, anon;
grant  execute on function public.current_tenant_ids() to authenticated;
```

`set search_path = ''` is mandatory on any `SECURITY DEFINER` function — without it the function is a privilege-escalation primitive. Note the audit already flags the sibling's `increment_*` RPCs as unreviewable precisely because their `security definer` / `search_path` properties are not in the repo (`security-audit-2026-08-23.md:232`).

**Trap B — the containment operator is not index-eligible.** See the timings below. `@> array[tenant_id]` reads elegantly and forces a sequential scan.

### 2.3 `current_setting()`

Only for **direct Postgres connections that are not PostgREST** — a worker on a direct connection, or a local test harness. Under Supabase's Data API this is what `auth.jwt()` is already built on (`current_setting('request.jwt.claims', true)`), so using it directly adds nothing.

**It is dangerous as an application-level pattern with a pooler.** `set` is session-scoped; `set local` is transaction-scoped. With PgBouncer in transaction mode, a `set` leaks the previous request's tenant into the next request on the same backend. If you ever run a direct-connection worker: **`set local`, inside an explicit transaction, always.** For Dala AI, don't — go through PostgREST or service-role routes.

### 2.4 The performance trap, measured

200,000 rows, 100,000 matching the tenant. PG 16.13, `explain (analyze, timing off)`.

| Policy predicate | Index on `tenant_id`? | Plan | Execution |
|---|---|---|---|
| `tenant_id = (auth.jwt()->>'tenant_id')::uuid` | **no** | Seq Scan, function in filter | **224.485 ms** |
| `tenant_id = (select (auth.jwt()->>'tenant_id')::uuid)` | **no** | Seq Scan, `Filter: (tenant_id = $0)` + InitPlan | **15.119 ms** |
| `tenant_id = (auth.jwt()->>'tenant_id')::uuid` | yes | Bitmap Index Scan | 13.651 ms |
| `tenant_id = (select (auth.jwt()->>'tenant_id')::uuid)` | yes | **Index Only Scan**, `Index Cond: (tenant_id = $0)` | **8.838 ms** |
| `tenant_id = any ((select public.current_tenant_ids())::uuid[])` | yes | **Index Only Scan**, `Index Cond: (tenant_id = ANY ($0))` | **7.031 ms** |
| `(select public.current_tenant_ids()) @> array[tenant_id]` | yes | **Seq Scan** — containment is not an index condition | **54.674 ms** |
| `exists (… tm.user_id = auth.uid())`, unwrapped | yes | Seq Scan + hashed SubPlan | 67.705 ms |
| `exists (… tm.user_id = (select auth.uid()))` | yes | Seq Scan + InitPlan | 37.289 ms |

Four conclusions, each falsifiable and each falsified-or-confirmed above:

1. **The `(select …)` wrap is worth ~15× when the predicate cannot become an index condition** (224 → 15 ms). This is Supabase lint `0003_auth_rls_initplan`.
2. **With a suitable index the planner already hoists a `stable` function** (13.7 vs 8.8 ms) — so "the wrap always gives 100×" is folklore. It gives ~1.5× here and 15× there. Do it anyway: it is free, and you cannot predict which queries lose their index.
3. **The index is the bigger lever.** `create index … on t (tenant_id)` — and for tables you always filter twice, `(tenant_id, created_at desc)` with `tenant_id` **leading**, so the same index serves the policy and the ordering.
4. **Predicate shape decides index eligibility.** `= scalar` and `= ANY(array)` are index conditions; `array @> array[col]` is not. Prefer `= any ((select public.current_tenant_ids())::uuid[])`. (The parenthesisation matters and is easy to get wrong: `= any ((select f()))` is parsed as `= ANY (subquery)` and fails with `operator does not exist: uuid = uuid[]` — I hit this. The `::uuid[]` cast forces the array-expression reading.)

**Also: name the role in every policy.** `to authenticated` means the policy is not even evaluated for `anon`. Free, and it halves the policy expressions on every query.

### 2.5 Recommendation

**Use both, for different callers.**

- **Dashboard (`authenticated`, a handful of tenant owners):** policies use `= any ((select public.current_tenant_ids())::uuid[])` backed by the `SECURITY DEFINER` function over `tenant_members`. Always current, no staleness, no `app_metadata` correctness burden, one membership row per tenant-owner. At your scale the function's cost is a single indexed lookup, hoisted once per query.
- **The custom access token hook is worth adding anyway**, but for `is_founder` (the Quality-layer admin gate) rather than `tenant_id` — a boolean whose staleness window is harmless and which you want available to middleware *without* a database round trip on every page load.
- **`current_setting()`: do not use directly.**

---

## 3. `PERMISSIVE` vs `RESTRICTIVE` — what the pattern actually stops

### 3.1 The composition rule

Postgres combines all `PERMISSIVE` policies for a command with `OR`, all `RESTRICTIVE` with `AND`, and `AND`s the two groups:

```
restrictive_1 AND restrictive_2 AND … AND (permissive_1 OR permissive_2 OR …)
```

Two consequences that people get wrong:

- **A restrictive policy alone grants nothing.** With RLS enabled and *only* restrictive policies, the permissive group is empty and everything is denied. Restrictive policies only ever *narrow*.
- **RLS enabled with no policies at all is default-deny.** Verified: `tenants` and `tenant_members` had RLS on and zero policies; `authenticated` held `SELECT` in the ACL and still saw nothing.

### 3.2 What `as restrictive for all using (true) with check (false)` blocks — verified, and there is a hole

This is the sibling's `_no_client_writes` shape. I gave `authenticated` full DML grants **and** a permissive `for all` own-tenant write policy, then tried each verb:

```
--- INSERT ---  ERROR:  new row violates row-level security policy "conversations_no_client_writes"
--- UPDATE ---  ERROR:  new row violates row-level security policy "conversations_no_client_writes"
--- DELETE ---  DELETE 1        ← the row was deleted
```

**`with check (false)` does not stop `DELETE`.** `DELETE` has no `WITH CHECK` clause; it is governed by `USING` alone, and this policy's `USING` is `true`. In Core English the hole is masked twice over — there is no permissive write policy (so `DELETE` matches zero rows) and `authenticated` holds no `DELETE` grant. Remove either mask and deletes go through. It is not a live finding next door; it **is** a pattern that must not be copied forward unexamined.

**Separately verified:** without a permissive write policy, `UPDATE` and `DELETE` return `UPDATE 0` / `DELETE 0` — **silently, no error.** Anything that treats "0 rows affected" as success will report a successful write that never happened.

### 3.3 The shape to use in Dala AI

Per-command restrictive denies. Verified: blocks all three write verbs while leaving `SELECT` working, even with a permissive `for all` write policy present and full DML grants held.

```sql
create policy conv_no_client_insert on conversations
  as restrictive for insert to anon, authenticated with check (false);
create policy conv_no_client_update on conversations
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy conv_no_client_delete on conversations
  as restrictive for delete to anon, authenticated using (false);
```

Do **not** collapse these into `as restrictive for all using (false) with check (false)` — `for all` applies `USING` to `SELECT`, and you would silently blind the dashboard.

Which Dala AI tables need this: `conversations`, `messages`, `spend_ledger`, `usage_counters`, `analytics_reports`, `kb_change_proposals`, `tenant_secrets`, `webhook_events`. Every one holds a value the *server* asserts. The tenant owner may read them and may not author them — the audit's distinction between the row's owner and the row's content (`security-audit-2026-08-23.md:126-130`).

Tables the tenant owner may legitimately write (`kb_documents` drafts, `business_hours`) get a normal permissive own-tenant `for all` policy **with `with check` repeating the tenant predicate** — otherwise a tenant can `update … set tenant_id = <other tenant>` and hand the row away. `USING` gates which rows you may touch; `WITH CHECK` gates what they may become. Omitting `WITH CHECK` on an `UPDATE` policy is a tenant-hopping write.

### 3.4 What no policy stops: `TRUNCATE`

Verified end to end:

```
=== restrictive with check(false) in force, authenticated holds TRUNCATE ===
truncate conversations;          → TRUNCATE TABLE
select count(*) from conversations;  → 0
```

```
=== after: revoke truncate, references, trigger … from anon, authenticated ===
truncate conversations;          → ERROR:  permission denied for table conversations
select count(*) ...              → 2 rows intact
```

Postgres docs, verbatim: *"Operations that apply to the whole table, such as TRUNCATE and REFERENCES, are not subject to row security."* The restrictive policy is irrelevant. Only the **ACL** stops it — which is `security-audit-2026-08-23.md:427-435`, now demonstrated rather than asserted.

`REFERENCES` (pin rows against deletion via an FK), `TRIGGER` (attach a trigger that executes as the table owner), and PG17's `MAINTAIN` sit in the same bucket. **Enumerate the ACL; do not assume `revoke insert, update, delete` finished the job.**

Sources: [PostgreSQL CREATE POLICY](https://www.postgresql.org/docs/17/sql-createpolicy.html), [PostgreSQL 5.9 Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), [PostgreSQL TRUNCATE](https://www.postgresql.org/docs/17/sql-truncate.html).

---

## 4. Catalog verification SQL — runnable, and every one executed

Run these after **every** migration that touches a grant or a policy, and paste the output into the migration's PR. They are the post-deploy check that `supabase_migrations.schema_migrations` cannot be (`security-audit-2026-08-23.md:309-331`).

### V1 — RLS state, per table

```sql
select c.relname,
       c.relrowsecurity                      as rls_enabled,
       c.relforcerowsecurity                 as rls_forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
order by 1;
```

### V2 — the "did I forget a table" check

```sql
select n.nspname || '.' || c.relname as table_name,
       case when not c.relrowsecurity
              then 'RLS DISABLED — table is wide open to any role with a grant'
            when not exists (select 1 from pg_policy p where p.polrelid = c.oid)
              then 'RLS ON, NO POLICIES — default-deny (intended? or forgotten?)'
       end as problem
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
  and (not c.relrowsecurity
       or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
order by 1;
```

Verified output on my harness:

```
      table_name       |            problem
-----------------------+--------------------------------
 public.owned_t        | RLS ON, NO POLICIES (deny-all)
 public.tenant_members | RLS ON, NO POLICIES (deny-all)
 public.tenants        | RLS ON, NO POLICIES (deny-all)
```

**This query must return zero rows in CI, or every row must be on a written allow-list.** It catches the *entire class* of the `20260817` failure — a table nobody remembered to migrate.

### V3 — the true ACL, with both null-traps closed

```sql
select c.relname,
       case when a.grantee = 0 then 'PUBLIC'
            else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind in ('r','p')
group by 1, 2
order by 1, 2;
```

**Two traps in this query that the audit's version does not close, both verified:**

- **`relacl IS NULL` yields zero `aclexplode` rows.** A table created and never `GRANT`ed carries a null ACL meaning "owner-implicit defaults". A bare `aclexplode(c.relacl)` reports it as *no grants at all* — another plausible-empty answer. `coalesce(c.relacl, acldefault('r', c.relowner))` materialises the implicit ACL.

  ```
  relname     | relacl_is_null
  fresh_table | t
  aclexplode rows for fresh_table | 0        ← without coalesce
  ```

- **`PUBLIC` is grantee OID 0, and `pg_get_userbyid(0)` returns the string `'unknown (OID=0)'`** — it does not error. A grant to `PUBLIC` (which every role including `anon` inherits) would appear under a nonsense name and be skimmed past. Verified.

### V4 — the liar, for comparison

```sql
select count(*) from information_schema.role_table_grants where table_schema = 'public';
```

Verified live, same database, same instant, two different roles:

| Querying role | `role_table_grants` rows for `public` | rows naming `anon`/`authenticated` | `aclexplode` rows |
|---|---|---|---|
| `postgres` (superuser, grantor) | 67 | many | 72 |
| `auditor` (plain login role) | 5 | **0** | 72 |

`0` from the view; `72` from the catalog. Same database, same moment. This reproduces `security-audit-2026-08-23.md:336-350` exactly. **Never use `information_schema.role_table_grants` to verify a security boundary.**

### V5 — client roles holding more than `SELECT` (version-agnostic; catches PG17 `MAINTAIN`)

```sql
select c.relname,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind in ('r','p')
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'))
group by 1, 2
having string_agg(a.privilege_type, ',' order by a.privilege_type) <> 'SELECT'
order by 1, 2;
```

Because it compares against the literal string `'SELECT'` rather than enumerating a hardcoded list of forbidden privileges, it catches `MAINTAIN` on PG17 and anything Postgres 18+ adds later, without an edit. Verified: correctly flagged the one table where I had re-granted DML.

### V6 — every tenant-scoped table carries `tenant_id`, and `tenant_id` leads an index

```sql
select c.relname,
       (a.attname is not null) as has_tenant_id,
       exists (select 1 from pg_index i
               where i.indrelid = c.oid and i.indkey[0] = a.attnum) as tenant_id_leads_an_index
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attribute a
    on a.attrelid = c.oid and a.attname = 'tenant_id'
   and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relkind in ('r','p')
order by 1;
```

Verified; correctly reported `has_tenant_id = t, tenant_id_leads_an_index = f` for the tables I had not indexed. This is both a correctness check and the §2.4 performance check in one.

### V7 — policies that are not tenant-scoped

```sql
select p.tablename, p.policyname, p.cmd, p.roles, p.qual, p.with_check
from pg_policies p
where p.schemaname = 'public'
  and p.permissive = 'PERMISSIVE'
  and p.roles && array['anon','authenticated','public']::name[]
  and (coalesce(p.qual,'') !~ 'tenant_id' or coalesce(p.qual,'') in ('true','(true)'))
order by 1, 2;
```

A blunt text match on the policy body — deliberately over-eager. Every hit is either a real leak or a documented exception. Verified: it correctly surfaced a legitimate `user_id`-scoped policy for review.

### V8 — who bypasses RLS

```sql
select rolname, rolbypassrls, rolsuper from pg_roles
where rolbypassrls or rolsuper order by 1;
```

Verified output: `postgres` (super + bypass), `service_role` (bypass, not super). **If any role you did not expect appears here, stop.**

### V9 — full policy bodies

```sql
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' order by tablename, policyname;
```

`pg_policies.permissive` is the literal text `'PERMISSIVE'` / `'RESTRICTIVE'` — verified, so V7's filter is safe.

**Operational rule, from `security-audit-2026-08-23.md:475`:** run V1–V9 and read **every row**. The last failure was partial — one of four tables — and a spot check on the one that happened to be correct confirmed the wrong conclusion.

---

## 5. `service_role`, `BYPASSRLS`, `FORCE ROW LEVEL SECURITY` — and the real last line of defence

### 5.1 Verified facts

| Question | Answer | How verified |
|---|---|---|
| Does `service_role` bypass RLS? | **Yes, completely.** | As `service_role`: saw both tenants' rows, and inserted a row into the *other* tenant while an RLS policy scoped the table to one. |
| Is `BYPASSRLS` the mechanism? | **Yes** — it is a role attribute, `pg_roles.rolbypassrls = true`. | V8 above. Supabase docs confirm the hosted `service_role` carries it. |
| Does `FORCE ROW LEVEL SECURITY` make `service_role` respect policies? | **No.** | `alter table conversations force row level security;` then queried as `service_role` → still saw all rows. |
| What does `FORCE` change? | It subjects the **table owner** to RLS. | Table owned by `tbl_owner`, RLS on, no policies: owner saw **1** row. After `force`: owner saw **0**. |

Docs, verbatim: *"Superusers and roles with the BYPASSRLS attribute always bypass the row security system … Table owners also bypass row security by default, though they can choose to be subject to it using FORCE ROW LEVEL SECURITY."*

**So `FORCE` is not the control you want here**, which matches the sibling's finding that `relforcerowsecurity = false` is correct there (`security-audit-2026-08-23.md:392-394`). Its only real use in a Supabase project is defence against a compromised `postgres`-owned function, and it will break your own migrations if you enable it carelessly.

### 5.2 The 2026 key model — relevant, and it changes your rotation story

Verified from Supabase docs:

- Legacy `anon` / `service_role` keys are JWTs signed by the shared project JWT secret. **They keep working until the end of 2026.**
- The replacements are `sb_publishable_…` and `sb_secret_…`. They are **not JWTs**, are **independently named and revocable**, and you can mint **one secret key per backend component**. Secret keys return **HTTP 401 from a browser** (User-Agent matched).
- New keys go on the **`apikey` header, never `Authorization: Bearer`** — a Bearer send is parsed as a JWT and rejected with `Invalid JWT`. This specifically breaks `pg_net` / Database Webhooks unless you move the key to `apikey`.
- Separately, **JWT Signing Keys** replace the shared HS256 secret with a rotatable asymmetric key (ES256 recommended). Public keys are published at `/auth/v1/.well-known/jwks.json`; rotation signs nobody out.

**Design consequence for Dala AI:** start on the new key model on day one. Mint **separate named secret keys** — `webhook-ingest`, `worker`, `analytics`, `admin` — so a leak from the Meta webhook path forces one rotation, not a full-project one. Do the JWT signing-keys migration at project creation, when there is nothing to break.

### 5.3 The actual last line of defence

**There is none inside Postgres.** A service-role route with a bug in its tenant scoping reads and writes every tenant's data. RLS is not evaluated; `FORCE` does not help; the ACL grants `service_role` everything. This is the single most important consequence of this whole research pass, and every "we have RLS" reassurance must be read against it.

Dala AI's inbound path — Messenger/Instagram webhook → tenant lookup → Anthropic → send — has **no user session at any point**. It runs as `service_role` from end to end. So RLS protects the *dashboard*, and protects essentially nothing on the path that carries all the volume and all the spend.

What has to substitute for it, in order:

1. **`tenant_id` derived server-side from a verified signal, never from anything shaped like input.** Meta webhooks carry `entry[].id` (the Page ID). Resolve `page_id → tenant_id` through a unique index on `channel_bindings(platform, external_page_id)`. **A `page_id` with no binding is a hard 404-and-drop, never a default tenant.** The single biggest tenant-misidentification risk is a `?? DEFAULT_TENANT` fallback written for local testing.
2. **Verify `X-Hub-Signature-256` before parsing the body** — already done single-tenant at `/home/user/Matrix-Chatbot/api/messenger.js:86` against `process.env.FACEBOOK_APP_SECRET`. Multi-tenant, the app secret may still be one app-wide value, but the check must precede the tenant lookup, and the comparison must be `timingSafeEqual`. An unsigned request never reaches the tenant resolver.
3. **One chokepoint function that both scopes and meters** — `withTenant(req, handler)` — resolving the tenant, opening the spend ledger, and returning a client that has `tenant_id` pre-bound. Route code should not be *able* to build a query without it. This is the `guardAiRoute()` lesson: one gate, no local re-implementations (`CLAUDE.md`, "The AI route guard").
4. **Composite foreign keys carrying `tenant_id`** (§1) — the one check the database *does* still enforce against a service-role bug.
5. **A `tenant_id` on every log line and every cache/rate-limit key**, so a scoping bug is visible in logs rather than only in a customer complaint.
6. **A read-only dashboard identity for yourself** that is *not* `service_role`, so the Quality layer's day-to-day review runs under RLS and a scoping bug surfaces as a missing row rather than a cross-tenant leak.

Sources: [Supabase Postgres roles](https://supabase.com/docs/guides/database/postgres/roles), [Migrating to publishable and secret API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys), [JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys), [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html).

---

## 6. Per-tenant secrets — Meta page access tokens

### 6.1 Status of the options, as of 2026-08-30

**`pgsodium` is deprecated. Confirmed, in Supabase's own words:** the extension page is titled *"pgsodium (pending deprecation)"* and states *"Supabase DOES NOT RECOMMEND any new usage of pgsodium"* and *"we do not recommend using either [Server Key Management or Transparent Column Encryption] on the Supabase platform due to their high level of operational complexity and misconfiguration risk."*

**What replaced it: nothing, for column encryption.** There is no successor TCE feature. Supabase's stated position is that projects are *"encrypted at rest by default which likely is sufficient for your compliance needs."*

**Supabase Vault survives, but read the fine print.** The pgsodium page: *"The Vault extension won't be impacted. Its internal implementation will shift away from pgsodium, but the interface and API will remain unchanged."* So `vault.create_secret()` / `vault.decrypted_secrets` are the stable contract. However, the Features matrix lists **Vault as `public alpha`** — the only database feature at that stage. The root key is held by Supabase outside the database and is retrievable via a separate API endpoint.

### 6.2 The three options against your actual threat model

Your threat model is the sibling's: **public repository, attacker has the full source**, plus a solo operator on Vercel + Supabase. The asset is a per-tenant Meta Page access token that can read a salon's entire DM history and post as the business.

| Option | What a full DB dump yields | What a leaked `sb_secret_` key yields | Operational load |
|---|---|---|---|
| **Vault** (`vault.decrypted_secrets`) | Ciphertext only — key is off-box. Good. | **Every tenant's token in plaintext.** The view decrypts on read, and `service_role` can read it. | Lowest. One `create_secret` per tenant. Public alpha. |
| **Envelope encryption in app code**, per-tenant DEK wrapped by a KEK in the Vercel env | Ciphertext only. | **Ciphertext only** — the KEK is in Vercel's env, not in Supabase, and a Supabase key does not grant Vercel env access. | ~120 lines: `wrap`/`unwrap` with `node:crypto` AES-256-GCM. |
| **External KMS / Infisical / Doppler** | Ciphertext only. | Ciphertext only, plus audited per-decrypt access. | A fourth vendor, a network hop in the webhook hot path, and a new failure mode on every inbound message. |

### 6.3 Recommendation: **envelope encryption in application code, KEK in the Vercel environment**

The deciding argument is the **blast-radius difference in the middle column**. Vault and envelope encryption are equivalent against a stolen database backup. They are *not* equivalent against a leaked service key — and a leaked service key is the more likely incident for a solo founder on a public repo. Vault puts the decryption capability behind the same credential that already has full data access; envelope encryption splits it across two vendors, so an attacker needs both a Supabase secret key **and** the Vercel project environment.

Vault being `public alpha` and mid-reimplementation is a secondary reason, not the main one.

```sql
create table tenant_secrets (
  tenant_id     uuid   not null references tenants(id),
  kind          text   not null,               -- 'meta_page_token' | 'ig_token' | 'sip_password'
  ciphertext    bytea  not null,               -- AES-256-GCM(plaintext, DEK), iv || tag || ct
  wrapped_dek   bytea  not null,               -- AES-256-GCM(DEK, KEK), iv || tag || ct
  kek_version   int    not null,
  status        text   not null default 'active',  -- active | rotating | revoked
  last_ok_at    timestamptz,
  last_error    text,                           -- Meta error code; NEVER the token
  created_at    timestamptz not null default now(),
  primary key (tenant_id, kind)
);
alter table tenant_secrets enable row level security;
-- no policy for anon/authenticated at all: not even the tenant owner reads this table.
-- service_role reaches it via BYPASSRLS; anon/authenticated hold zero privileges.
revoke all on tenant_secrets from anon, authenticated;
```

Four details that matter:

1. **AAD binds ciphertext to its row.** Pass `tenant_id || kind` as GCM additional authenticated data. Copying `tenant_secrets` row A's ciphertext onto row B then fails authentication instead of decrypting. This is exactly the trick Vault's own TCE uses (*"if an attacker were to copy an encrypted value from another row to the current one, the signature would be rejected"*) and you get it for ~one line.
2. **`revoke all … from anon, authenticated`, then verify with V3 and V5.** Not "no policy" — no *privilege*. Belt and braces, because a future `grant all on all tables in schema public to authenticated` (which is what produced the residue next door) would otherwise silently re-open it.
3. **Never log a decrypted token, and never log `wrapped_dek`.** The sibling still logs QPay bank details on error (`security-audit-2026-08-23.md:236`) — this is that bug's larger sibling. Log `tenant_id`, `kind`, `kek_version`, and Meta's numeric error code only.
4. **Decrypt-per-request, cache in memory for the request only.** No module-scope cache — Vercel reuses warm lambdas across tenants, and a module-level `let token` is a cross-tenant leak with a 15-minute half-life.

### 6.4 Key-rotation story

Two independent rotations, and conflating them is how this goes wrong.

**KEK rotation (your key, on your schedule — annually, or on suspected compromise).** Because the DEK is wrapped, **no plaintext is ever touched**:

1. Add `META_TOKEN_KEK_V2` to Vercel alongside `META_TOKEN_KEK_V1`. Unwrap reads `kek_version` and picks the right KEK; both are live.
2. A one-shot admin route walks `tenant_secrets`, unwraps each `wrapped_dek` with V1, re-wraps with V2, sets `kek_version = 2`. Ciphertext untouched. Fully resumable, idempotent, zero downtime.
3. Confirm `select count(*) from tenant_secrets where kek_version <> 2` is `0` **by querying the database**, not by the job reporting success.
4. Remove `META_TOKEN_KEK_V1` from Vercel.

**Token rotation (Meta's schedule, and mostly not yours).** A long-lived Page access token does not expire on a timer, but Meta invalidates it when the granting user changes their password, revokes the app, loses their Page role, or the app is put into a restricted state. The failure surfaces as a Graph API `OAuthException` code `190`. **Design the seam now:** on a `190`, set `status = 'revoked'`, record `last_error`, stop retrying that tenant, and alert. A revoked token must never be retried in a loop — that is how a webhook queue turns into a rate-limit ban on the shared Meta app.

**Supabase's own key rotation is a third, separate axis** and the new model makes it cheap: `sb_secret_…` keys are individually named and revocable (§5.2), and JWT signing keys rotate without signing users out.

### 6.5 Failure modes

| Failure | Behaviour |
|---|---|
| KEK env var missing at boot | **Refuse to start / 503 the route.** Never fall back to a default or a plaintext column. This is the `CLAUDE.md` rule: *no fallback to a default credential.* |
| `wrapped_dek` fails to unwrap (wrong KEK version, corrupted row) | 503 for that tenant, alert, do **not** fall through to another tenant's secret or to an env var. |
| GCM auth-tag mismatch | Treat as tampering. Alert. Never decrypt-and-hope. |
| Meta returns `190` | `status = 'revoked'`, alert the founder, stop sending for that tenant. Inbound events still persist (so nothing is lost) but no outbound call is attempted. |
| A tenant has no `tenant_secrets` row | 503 with a distinct code (`tenant_not_provisioned`), not 500 and not a silent skip. Onboarding is incomplete; that is an operator-visible state. |

Sources: [pgsodium (pending deprecation)](https://supabase.com/docs/guides/database/extensions/pgsodium), [Supabase Vault](https://supabase.com/docs/guides/database/vault), [Supabase Features matrix](https://supabase.com/docs/guides/getting-started/features).

---

## 7. Postgres text handling for Mongolian Cyrillic

All results in this section were executed. Local database collation is `C.UTF-8`; Supabase creates projects `en_US.UTF-8`. Where that difference matters I say so.

### 7.1 Collation

| Test | Result |
|---|---|
| `lower('ҮС ЗАСАЛТ')` under `C.UTF-8` | `үс засалт` ✓ |
| `upper('өнгө')` under `C.UTF-8` | `ӨНГӨ` ✓ |
| `'Үс Засалт' ILIKE '%засалт%'` under `C.UTF-8` | `true` ✓ |
| `lower('ҮС ЗАСАЛТ' collate "C")` | **`ҮС ЗАСАЛТ`** — unchanged ✗ |
| `('Үс' collate "C") ILIKE ('%үс%' collate "C")` | **`false`** ✗ |

**The finding: `C.UTF-8` handles Cyrillic case folding correctly; plain `C` / `POSIX` does not, silently.** `en_US.UTF-8` (Supabase's default) also handles it — glibc's ctype tables are not English-specific.

**Recommendation:** accept the project default (`en_US.UTF-8`), and add a catalog assertion, because `datcollate` **cannot be changed after database creation**:

```sql
select datname, datcollate, datctype, pg_encoding_to_char(encoding)
from pg_database where datname = current_database();
-- must be UTF8, and datcollate must NOT be 'C' or 'POSIX'
```

Put that in the same verification pack as V1–V9. It costs nothing and the failure it catches is unfixable-in-place.

Supabase images set `LANG=en_US.UTF-8` and `datcollate = 'en_US.UTF8'`; ICU collations are available. ([supabase/postgres#30](https://github.com/supabase/postgres/issues/30))

### 7.2 `citext` vs `lower()` vs ICU nondeterministic collations

| Test | Result |
|---|---|
| `'ҮС'::citext = 'үс'::citext` | `true` ✓ |
| `'ҮС' = 'үс'` (plain text) | `false` |
| `'ҮС ЗАСАЛТ' collate mn_ci = 'үс засалт' collate mn_ci` where `mn_ci` = ICU `und-u-ks-level2`, `deterministic = false` | `true` ✓ |

`citext` works on Cyrillic, but the PG docs are explicit that **its case folding depends on `LC_CTYPE`** and *"is not truly case-insensitive by Unicode standards"*, and they recommend nondeterministic collations instead. Since `LC_CTYPE` is fixed at database creation and I demonstrated it going wrong under `C`, `citext` inherits a fragility you cannot repair later.

**Recommendation: neither, mostly.** Normalise at the application boundary and store the normalised form:

```sql
kb_key text generated always as (lower(normalize(title, NFC))) stored
```

`stored` generated columns are indexable, deterministic, and visible in the catalog — you can *see* the normalisation rule rather than trusting that every writer applied it. Use an ICU nondeterministic collation only where you genuinely need CI comparison inside SQL (a unique constraint on a tenant slug, say), and know the cost the docs name: no B-tree deduplication, **no pattern matching** (`LIKE`/`ILIKE`/regex do not work on a nondeterministic-collated column), and a general slowdown.

Sources: [PostgreSQL citext](https://www.postgresql.org/docs/17/citext.html), [PostgreSQL Collation Support](https://www.postgresql.org/docs/17/collation.html).

### 7.3 `unaccent` — **do not install it**

```
      w      | unaccented  | unchanged
-------------+-------------+-----------
 Ё           | Е           | f     ← Mongolian letter Ё destroyed
 ё           | е           | f     ← same
 Й           | Й           | t
 й           | й           | t
 Ө           | Ө           | t
 Ү           | Ү           | t
 Улаанбаатар | Улаанбаатар | t
```

**Verified: `unaccent` maps `Ё → Е` and `ё → е`.** `Ё` is a full letter of the Mongolian Cyrillic alphabet (ёстой, Ёндон, ёс), not a decoration. Meanwhile `Й`, `Ө`, `Ү` pass through untouched.

That mixture is the dangerous part. `unaccent` is *partially* destructive on Mongolian, so it looks harmless in nine tests out of ten and then silently conflates a small set of words. (`Й` survives because Postgres' rules are generated from `Latin-ASCII` transliteration plus explicit special cases, and `Ё` was given a special case while `Й` was not.)

**Recommendation:** do not create the extension. If you later want fuzzy matching that tolerates the real Mongolian confusions — `Ө`↔`О`, `Ү`↔`У`, `Й`↔`И`, which are typing-layout errors, not diacritics — write an explicit rules table you control:

```sql
create table mn_fold (src text primary key, dst text);
insert into mn_fold values ('ө','о'), ('ү','у'), ('й','и'), ('ё','е');
```

Then you own the mapping, it is inspectable in the catalog, and it is per-purpose (search folding — never applied to stored canonical text).

Sources: [PostgreSQL unaccent](https://www.postgresql.org/docs/17/unaccent.html), [generate_unaccent_rules.py](https://github.com/postgres/postgres/blob/master/contrib/unaccent/generate_unaccent_rules.py).

### 7.4 Full-text search with no Mongolian dictionary

```
to_tsvector('english','Үс засалт хэд вэ') → 'вэ':4 'засалт':2 'хэд':3 'үс':1
to_tsvector('simple' ,'Үс засалт хэд вэ') → 'вэ':4 'засалт':2 'хэд':3 'үс':1     -- identical
to_tsvector('simple','ҮС ЗАСАЛТ ХЭД ВЭ') → 'вэ':4 'засалт':2 'хэд':3 'үс':1     -- case-folded ✓
```

**Verified:** there is no Mongolian FTS configuration, and `english` and `simple` produce *identical* output on pure Mongolian text — the Snowball English stemmer does not touch Cyrillic tokens. `simple` lowercases and applies a stop-word list, and lowercasing Cyrillic works.

But the two configurations **diverge on mixed text**, which is what a salon actually receives:

```
to_tsvector('english','Тос солих services and the booking')
  → 'book':6 'servic':3 'солих':2 'тос':1        -- Latin stemmed, 'and'/'the' dropped
```

```
to_tsvector('english','Matrix Eco Salon-д үс засалт хийлгэх')
  → 'eco':2 'matrix':1 'salon':4 'salon-д':3 'д':5 'засалт':7 'хийлгэх':8 'үс':6
```

Note `salon-д` is split into `salon-д`, `salon`, and `д` — the parser treats the Latin-Cyrillic hyphenated form as a compound. That is actually useful (Mongolian case suffixes attach to Latin brand names constantly), and it is a good reason not to strip hyphens.

**Recommendation: `simple`, explicitly named at every call site, and pinned.**

- Set `default_text_search_config = 'pg_catalog.simple'` **and** write `to_tsvector('simple', …)` explicitly everywhere. A generated `tsvector` column that depends on the session GUC is a bug waiting for a config change.
- `simple` has **no Mongolian stop-word list**, so particles (`нь`, `ба`, `юм`, `вэ`, `бол`) index as content and wreck ranking. Build a small `mn.stop` list from your own conversation corpus — this is a tuning task for month two, not a launch blocker.
- **For the salon KB, FTS is probably the wrong tool anyway.** Customer questions are short, misspelt, and code-switched. `pg_trgm` similarity or pgvector embeddings will beat lexeme matching. Verified on Cyrillic: `similarity('үс засалт','ус засалт') = 0.538` (the `ү`/`у` typo, still a strong match) but `similarity('өнгө','онго') = 0` — trigram similarity collapses when *every* character differs, which is exactly the `ө`→`о` layout error. So: **fold `ө→о`, `ү→у`, `й→и` into a separate search column before trigram matching** (§7.3), or use embeddings, which are indifferent to it.

### 7.5 What breaks if you assume ASCII — the SQL/JavaScript asymmetry

This is the single most surprising result of the section. **Postgres regexes are locale-aware; JavaScript regexes are not.**

| Expression | Postgres | JavaScript |
|---|---|---|
| `\w` on `'үс засалт'` | **`true`** | **`false`** |
| word boundary on `засалт` | `\yзасалт\y` → **`true`** | `/\bзасалт\b/` → **`false`** |
| same, with `u` flag | n/a | `/\bзасалт\b/u` → **still `false`** |
| `[a-z]+` on `'засалт'` | `false` | `false` |
| `\p{L}+` with `u` flag | n/a | **`true`** |
| lowercase | `lower()` ✓ | `.toLowerCase()` ✓ |

So a validation regex ported from SQL to Node — or written by someone who tested it in `psql` — **changes meaning**. And `u` does not fix `\b`: in JavaScript `\b` is defined in terms of `\w`, and `\w` is permanently `[A-Za-z0-9_]`. There is no flag. You must write `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with the `u` flag, or not use word boundaries at all.

Everything else, measured on `'Үс засалт'`:

| Trap | Measurement |
|---|---|
| **Byte length ≠ character length** | `length` = **9**, `octet_length` = **17**. JS: `.length` = 9, `Buffer.byteLength` = 17. Mongolian Cyrillic is 2 bytes/char in UTF-8, so every ASCII-derived length budget is **~1.9× too small**. This is a live risk for Meta's 2000-character message limit and for any `varchar(n)` sized by eye. |
| **`length` vs `substr` vs JS slicing** | Postgres `left()` / `substr()` are **character**-based and safe. JS `.slice()` is **UTF-16 code-unit**-based — safe for the Cyrillic BMP range, but it will split an emoji, and salon DMs are full of emoji. Use `Array.from(s).slice(0, n).join('')` or `Intl.Segmenter`. |
| **NFC vs NFD** | `normalize('Й', NFD) = 'Й'` → **`false`**. NFD is 4 bytes, NFC is 2. In JS, `'Й' === 'Й'` → **`false`**; after `.normalize('NFC')` → **`true`**. iOS keyboards and copy-paste from PDFs produce NFD. `Й`, `й`, `Ё`, `ё` are the affected Mongolian letters (they have canonical decompositions; `Ө` and `Ү` do not — verified). **Two visually identical KB entries that never match each other.** |
| **`ILIKE` / `~*` under `C`** | Silently fail on Cyrillic (§7.1). |
| **Sorting** | `order by name` under `C.UTF-8` is **byte order**, not Mongolian alphabetical order — `Ө` (U+04E8) and `Ү` (U+04AE) sort after all basic Cyrillic instead of in their alphabet positions. Use `collate "mn-MN-x-icu"` if it exists on your project, otherwise `und-x-icu`, for any user-visible staff or service list. |

**The rules this produces, and they belong in `CLAUDE.md` on day one:**

1. **NFC-normalise at every input boundary** — webhook body, dashboard form, KB import — and never anywhere else. `normalize(x, NFC)` in SQL, `.normalize('NFC')` in JS. Add a `check (body is normalized)` constraint on the columns that matter; Postgres has `IS NORMALIZED` and it is cheap because checking is faster than converting.
2. **No `\b`, no `\w`, no `[a-z]` in any JavaScript regex over user text.** `\p{L}`, `\p{N}` with the `u` flag, or nothing. Add an ESLint rule or a CI grep — this is exactly the kind of thing that gets reintroduced by a copy-paste six months from now.
3. **No unanchored regex over user text at all** where a prompt-injection or a false-positive intent match is the consequence. The audit is blunt that `sanitizeForPrompt` is *"a fixed-phrase regex strip … trivially bypassed … not a security control"* (`security-audit-2026-08-23.md:228-231`). Do not build the Mongolian version of it and then rely on it.
4. **Every length budget in characters, computed with `Array.from(s).length` for emoji-safety, and every byte budget with `Buffer.byteLength`.** Never interchange them.
5. **`unaccent` is not installed** (§7.3).

---

## 8. What to carry across from the audit, encoded as Dala AI rules

1. **The catalog is the only source of truth.** `supabase_migrations.schema_migrations` will be frozen on the Dala AI project too, the moment you apply one migration through the dashboard editor. Do not create the habit of consulting it.
2. **V1–V9 (§4) run after every grant/policy migration, and the output goes in the PR.** Read every row. The last failure was partial.
3. **`information_schema.role_table_grants` is banned in this codebase.** Verified again above: 0 rows vs 72, same instant, same database.
4. **`aclexplode(coalesce(relacl, acldefault(...)))`, and special-case grantee 0 as PUBLIC.** Both null-traps are demonstrated in §4.
5. **Restrictive denies are per-command, never `for all using(true) with check(false)`** — §3.2 shows that shape lets `DELETE` through.
6. **`revoke insert, update, delete` is not "cannot write."** `TRUNCATE` is verified to bypass every policy. On PG17 there are seven privileges plus `MAINTAIN`; V5 is version-agnostic on purpose.
7. **Ownership RLS checks who a row belongs to, never what it says** — so every server-asserted table (`spend_ledger`, `usage_counters`, `analytics_reports`) is `SELECT`-only to clients, with a restrictive per-command deny.
8. **Fail closed, and never `try { check() } catch { continue }`.** The tenant resolver, the entitlement check and the budget check each return 503 on error. A 503 costs a retry; failing open costs money — and now it also costs *another tenant's* money, which is worse, because it is not yours to lose.
9. **Nothing spends on a schedule without a ceiling and an alert path.** The Analytics AI monthly report is the first scheduled spender Dala AI will have. It needs a per-tenant dollar ceiling and a ledger *before* it is scheduled, not after — the sibling shipped a generator whose only bound was a cached read (`CLAUDE.md`, "The quiz bank build is CLOSED").
10. **The Next.js GET-caching trap applies unchanged.** Any `GET`-only route handler caches Supabase reads for a year; `dynamic = 'force-dynamic'` does not stop it; only `cache: 'no-store'` does. Port `src/lib/supabase/fetch.ts` and `scripts/check-supabase-nostore.mjs` on day one. For Dala AI the specific hazard is a tenant-config or channel-binding read returning a *stale other-tenant* value.
11. **Hardening technique, from the bake-off (`plan-2026-08-24…md:~1020`): a rule that only describes the right answer loses to a model's disposition; a rule that forbids the specific wrong answer does not.** For Reception AI's children's-haircut omission, "refer to the salon phone" will lose. "Never state or estimate a price for a children's haircut; the correct reply is <phone>; do not say 'ойролцоогоор', do not reason from the adult price" will hold. That requires *measuring the failure first*.

---

## 9. Open questions — the founder's call, not mine

1. **Does a tenant owner get a login at all in v1?** Everything in §2 about `authenticated`, the join table and the access-token hook exists to serve a dashboard. If Matrix and GS Auto get a weekly PDF instead, RLS-for-humans is dead weight in v1 and the entire security budget should go to §5.3 — the service-role path, where all the volume and all the spend actually are. This is the single highest-leverage decision in this document.
2. **Can one person hold two tenants?** It changes `current_tenant_ids()` from a scalar to a set, changes the JWT-claim option from viable to not, and changes every dashboard URL. Cheap to decide now, expensive later. (My §2.5 recommendation assumes yes, because it costs almost nothing to allow.)
3. **One Meta app for all tenants, or one per tenant?** One shared app means one `FACEBOOK_APP_SECRET`, one App Review, one rate-limit pool — and **one tenant's abuse can get every tenant banned**. Per-tenant apps mean per-tenant App Review, which is weeks of latency on every onboarding and breaks the "filling in a config" test. This is a business-risk call, and the schema (`channel_bindings` with an `app_id` column) should accommodate both regardless of which you pick.
4. **What is the per-tenant monthly dollar ceiling, and what happens when a tenant hits it?** Hard stop (the salon's Messenger goes silent mid-conversation, on a Saturday), degrade to a canned Mongolian "we'll get back to you" reply, or auto-overage-bill. §5.3 cannot be finished without this number, because the ledger check is what the chokepoint enforces.
5. **When Meta invalidates a page token (`OAuthException 190`), who is woken and how?** Reception AI is silently dead for that tenant until someone re-authorises. Is that a push notification to you, an email to the tenant, or a dashboard banner nobody reads? The sibling's lesson applies with force: a provider returning success is not delivery, and the Brevo incident was only caught because a `profiles` row had no matching log line.
6. **Is the founder's Quality-layer identity `service_role` or a scoped admin role?** Reviewing every tenant's conversations is inherently cross-tenant, so it is tempting to run it as `service_role`. But doing so removes the last place RLS could catch a scoping bug in your own tooling (§5.3, point 6). A read-only `founder` role with a permissive `using (true)` SELECT policy costs one policy and keeps writes honest.
7. **Vault or envelope encryption?** I recommend envelope (§6.3) on blast-radius grounds, and the argument is not close for a public repo. But it is ~120 lines you own and must test, versus one Supabase function call. If you would rather ship and revisit, say so explicitly in the commit — the same way `BANK_BUILD_BUDGET_USD = 0` records a decision rather than an accident — because the migration from Vault to envelope later is a plaintext-touching operation and genuinely harder than doing it now.

**Sources**

- [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase — RLS Performance and Best Practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)
- [Supabase — Database Advisor lint 0003_auth_rls_initplan](https://supabase.com/docs/guides/database/database-advisors?lint=0003_auth_rls_initplan)
- [Supabase — Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
- [Supabase — Custom Claims & RBAC](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac)
- [Supabase — Migrating to publishable and secret API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [Supabase — JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase — Vault](https://supabase.com/docs/guides/database/vault) · [pgsodium (pending deprecation)](https://supabase.com/docs/guides/database/extensions/pgsodium) · [Features matrix](https://supabase.com/docs/guides/getting-started/features)
- [Supabase — Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles)
- [PostgreSQL — CREATE POLICY](https://www.postgresql.org/docs/17/sql-createpolicy.html) · [5.9 Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) · [ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html) · [TRUNCATE](https://www.postgresql.org/docs/17/sql-truncate.html)
- [PostgreSQL — citext](https://www.postgresql.org/docs/17/citext.html) · [Collation Support](https://www.postgresql.org/docs/17/collation.html) · [unaccent](https://www.postgresql.org/docs/17/unaccent.html) · [Text Search Dictionaries](https://www.postgresql.org/docs/17/textsearch-dictionaries.html) · [String Functions (`normalize`)](https://www.postgresql.org/docs/17/functions-string.html)
- [postgres/postgres — generate_unaccent_rules.py](https://github.com/postgres/postgres/blob/master/contrib/unaccent/generate_unaccent_rules.py)
- [supabase/postgres — Set default encoding and collation to UTF-8 (#30)](https://github.com/supabase/postgres/issues/30)
- [Multi-tenant SaaS: RLS vs schema-per-tenant vs database-per-tenant](https://aliasghar.me/blog/multi-tenant-saas-data-isolation) · [Building SaaS with PostgreSQL — Multi-Tenancy Patterns Compared](https://www.adiagr.com/blog/07-saas-postgres-multitenancy-patterns/) · [Multi-Tenant Database Isolation: RLS vs Schema-per-Tenant](https://propelius.tech/blogs/multi-tenant-database-isolation-postgresql-rls-schema/)
---

# Matrix-Chatbot — Inventory for the Reception AI Successor

**Method note.** Everything below marked *verified* was read in the file at the cited line, or produced by running code in this checkout (Node 22, `npm test`, and ad-hoc probes against the real modules). Everything marked *assumed* is inference I could not confirm from the repo. Repo root: `/home/user/Matrix-Chatbot`. Git HEAD: `d7ae6c8` (prompt-caching merge); branches `main` and `claude/dala-architecture-tenant-model-n6bjg4`.

**The one-sentence summary:** the Messenger half of this repo (`api/messenger*.js`, `lib/messenger*.js`, `lib/conversationStore.js`, `lib/rawBody.js`) is careful, well-reasoned production code whose *transport* design carries over almost intact; the *knowledge, prompt, intent and website* half is a single-tenant artifact with a second tenant's dead code still inside it, and must be rebuilt as data.

---

## 1. Component inventory

### Runtime — Messenger path (the ancestor of Reception AI)

| File | What it does | Key exports |
|---|---|---|
| `api/messenger.js` (198 L) | Facebook webhook. `GET` = verify handshake; `POST` = raw-body HMAC check → filter to actionable text events → durable enqueue → fast 200. Body parser disabled (`:16-20`). | default `handler`; internal `extractActionableEvents` (`:164`), `safeInlineProcess` (`:187`), `withTimeout` (`:29`) |
| `api/messenger-worker.js` (88 L) | QStash-invoked worker. Verifies Upstash signature over raw body, parses the event, calls the shared processor. Non-2xx to trigger a retry; on final attempt sends the fallback and returns 200. | default `handler` |
| `lib/messengerProcess.js` (123 L) | The pipeline shared by worker and inline fallback: dedup → typing indicator → history read → deterministic shortcut *or* model → send → mark handled → append turn. | `processMessengerEvent(event, {finalAttempt})` |
| `lib/messengerQueue.js` (84 L) | Upstash QStash hand-off. Resolves the worker URL, gates on config presence, publishes with `deduplicationId: mid` (`:66`). | `MAX_RETRIES`, `getWorkerUrl`, `qstashEnabled`, `enqueueEvent`, `getReceiver` |
| `lib/messengerClient.js` (208 L) | Meta Graph client, pinned `v25.0` (`:9`). HMAC-SHA256 signature verification with `timingSafeEqual`; Send API for text, button templates, sender actions. Token in `Authorization` header, never a URL (`:79`). | `verifyFacebookSignature`, `chunkMessage`, `sendMessengerText`, `sendMessengerButtons`, `sendSenderAction`, `GRAPH_VERSION` |
| `lib/messengerText.js` (84 L) | Normalises the brain's (occasionally HTML) output to Messenger plain text; caps a reply to one atomic Send call. | `htmlToMessengerText`, `capToSingleMessage` |
| `lib/conversationStore.js` (132 L) | Upstash Redis: per-PSID history (`msgr:hist:<psid>`, `:88`) and per-mid dedup (`msgr:done:<mid>`, `:53`). Tight client bounds (`:30-35`). Every op swallows errors. | `isAlreadyHandled`, `markHandled`, `getHistory`, `appendTurn`, `memoryEnabled` (**dead — never called**) |
| `lib/rawBody.js` (33 L) | Streams the exact request bytes for HMAC, capped at 1 MB (`:10`). | `readRawBody` |
| `lib/salonBrain.js` (260 L) | The Anthropic call. Imports `clientData` + `buildSystemPrompt`, appends a Messenger channel addendum and an optional closure section, sends one cached system block, logs cache token counts. | `generateSalonReply`, `buildClosureSection`, `HUMAN_PHONE`, `SALON_NAME`, `CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY` |
| `lib/salonIntents.js` (94 L) | Two deterministic no-model shortcuts (location, greeting), built from `clientData` + active closure. | `detectShortcutIntent`, `buildLocationResponse`, `buildGreetingResponse` |

### Runtime — website path

| File | What it does | Key exports |
|---|---|---|
| `api/chat.js` (417 L) | The website chatbot endpoint. CORS → in-memory rate limit → validate → *four* inline intent branches (greeting/location/facebook/contact) → `buildSystemPrompt` → Anthropic Haiku. **~80 lines of it are dead code from a previous tenant.** | default `handler` |
| `lib/systemPromptBuilder.js` (189 L) | Renders `clientData` into the ~7.8k-character Mongolian system prompt. Also hardcodes the salon's pricing rules, deposit table and example dialogue. | `buildSystemPrompt(client)` |
| `lib/validator.js` (235 L) | Message/history validation, XSS pattern check, and a "is this a professional question" gibberish filter. | `validateMessage`, `validateHistory`, `isValidEmail`†, `isValidPhone`†, `sanitizeHtml`†, `hasSuspiciousPatterns`, `isProfessionalQuestion`, `ValidationLimits` († dead) |
| `lib/rateLimiter.js` (83 L) | In-process `Map` counter + a module-scope `setInterval` sweeper (`:8-15`). | `checkRateLimit`, `applyRateLimitHeaders` |
| `lib/cors.js` (36 L) | Origin allow-list from `ALLOWED_ORIGINS`. | `applyCors` |
| `lib/logger.js` (40 L) | Fire-and-forget POST of a truncated message/reply preview to `LOG_WEBHOOK_URL`. Silent failure (`:17-19`). | `logInteraction` |
| `lib/analytics.js` (167 L) | In-memory singleton counter class + a regex intent classifier. | `analyticsTracker` |
| `api/analytics.js` (26 L) | Unauthenticated `GET` returning the in-memory summary, incl. the last 10 free-text feedback entries. | default `handler` |
| `api/feedback.js` (62 L) | Unauthenticated `POST` 1–5 rating + free text into the in-memory array. | default `handler` |
| `api/health.js` (54 L) | Unauthenticated `GET`; reports uptime, heap/RSS, and whether `ANTHROPIC_API_KEY` is set. | default `handler` |

### Config & data

| File | What it is |
|---|---|
| `config/currentClient.js` (121 L) | **The entire knowledge base**, as a committed JS object literal: branding, 9-person team, 40-item price list, 4 FAQs, contact block. |
| `config/closures.js` (179 L) | Holiday-break window logic. UTC+8 salon clock (`:32`), a shipped default Naadam closure (`:40-52`), env override `SALON_CLOSURE_START/END/TITLE/MESSAGE`. |
| `types/clientConfig.ts` (72 L) | A `ClientConfig` interface. **Not enforced anywhere** — no TypeScript in the build, nothing imports it. |
| `vercel.json` (14 L) | Build command, `outputDirectory: public`, two rewrites. **No `crons`, no `functions` block.** |
| `package.json` (29 L) | ESM, no framework. Deps: `@upstash/qstash`, `@upstash/redis`, `node-fetch`, `papaparse`, `react`. `npm run check` syntax-checks only `api/chat.js`, `public/app.js`, `public/widget.js`; `npm test` runs one file. |

### Frontend & docs (throw-away)

`public/index.html`, `public/app.js`, `public/widget.js`, `public/react-chat-widget.js` (202 KB built bundle, committed), `src/components/ChatWidget.jsx`, `src/clientConfig.js`, `src/chat-widget-entry.jsx`, `tailwind.config.js`, `vite.config.js`, `postcss.config.js`.

19 markdown files. Three describe **other products entirely**: `README.old.md` ("DalaTech.ai AI Sales Consultant… powered by Google Gemini"), `DEPLOY.md` ("the Japan Tok Mongolia chatbot"), `docs/PRODUCT_VALIDATION.md` + `scripts/README.md` ("226 products… Japan Tok", documenting `scripts/check-products.js` **which does not exist** — `scripts/` contains only the README). `MATRIX_IMPLEMENTATION.md` describes a Google-Sheets price feed that is no longer how prices work. `PRODUCTION_READINESS.md` still instructs the operator to set `GEMINI_API_KEY` (`:250`, `:67`) and references `public/test.html`, which does not exist. **Do not carry any of these forward.** `MESSENGER_SETUP.md` (90 L) is the one accurate operational document.

---

## 2. Every place the single tenant is hardcoded

This is the multi-tenancy work-item list. All line numbers verified.

### 2a. The config import — the structural root of the problem

Four modules `import { clientData } from '../config/currentClient.js'` at **module load time**, so the tenant is a build-time constant baked into the module graph:

- `lib/salonBrain.js:11`
- `lib/salonIntents.js:17`
- `api/chat.js:9`
- `src/clientConfig.js:9`

Plus `import { activeClosure } from '../config/closures.js'` at `lib/salonBrain.js:13` and `lib/salonIntents.js:18`.

Consequence: `lib/salonBrain.js:142-149` caches the assembled base prompt in a **module-scope singleton** (`cachedBasePrompt`). With two tenants sharing one warm lambda, the first tenant's prompt is served to the second. This single variable is the highest-severity multi-tenancy defect in the repo, and it is invisible at one tenant.

`lib/salonBrain.js:46` — `export const SALON_NAME = clientData.branding?.companyName` — a module-level constant used in log lines (`lib/messengerProcess.js:80, 88, 117`), so every log line is stamped with the *build's* tenant, not the *request's*.

### 2b. Env vars that are implicitly per-tenant (one Page only)

| Var | Site | Why it is per-tenant |
|---|---|---|
| `MESSENGER_VERIFY_TOKEN` | `api/messenger.js:63` | One verify token per Meta webhook subscription; compared with `===` (not constant-time) at `:65` |
| `FACEBOOK_APP_SECRET` | `api/messenger.js:86` | Signs every event; one Meta app |
| `FACEBOOK_PAGE_ID` | `api/messenger.js:165` | Self-message guard; a single Page id |
| `PAGE_ACCESS_TOKEN` | `lib/messengerClient.js:68` | **The send credential.** Read straight from `process.env` inside the client, so the send path has no idea which tenant it is sending as |
| `SALON_CLOSURE_START/END/TITLE/MESSAGE` | `config/closures.js:140, 141, 150, 151` | Env-named holiday for one business |
| `MESSENGER_PUBLIC_URL` | `lib/messengerQueue.js:23` | One worker callback URL |
| `ALLOWED_ORIGINS` | `lib/cors.js:10` | One tenant's website origins |
| `LOG_WEBHOOK_URL` | `lib/logger.js:3` | One destination for all customer message previews |

`lib/messengerClient.js:67-69` is the key-management item: `function pageToken(explicit) { return explicit || process.env.PAGE_ACCESS_TOKEN; }`. The `opts.token` seam already exists in all three send functions (`:101`, `:146`, `:199`) — it is threaded nowhere. Making the caller supply a per-tenant token is a small change to `messengerClient`; *sourcing and encrypting* that token is the real problem and is not solved here at all.

### 2c. Tenant facts hardcoded in code, outside the config

- `lib/salonBrain.js:41` — `export const HUMAN_PHONE = '7741-7777';` The phone is **also** in `config/currentClient.js:107` as `"+976 7741 7777"`. The same fact exists twice, in two formats, and both reach the same prompt (`lib/salonBrain.js:72` vs `lib/systemPromptBuilder.js:135`).
- `lib/salonBrain.js:52` — `CLOSING_LINE` (fixed Mongolian sign-off).
- `lib/salonBrain.js:57-59` — `HANDOFF_REPLY`, interpolating `HUMAN_PHONE`.
- `lib/salonBrain.js:63-65` — `FALLBACK_REPLY`, same.
- `lib/salonBrain.js:70-72` — `CHILDREN_REPLY`. **The deliberate omission is encoded in code, not data.**
- `lib/salonBrain.js:79-81` — `BOOKING_LINE` hardcodes the string `QPay-ээр` (the payment rail) and the phrase `урьдчилгаа төлбөр` (deposit). GS Auto Center may use neither.
- `lib/salonBrain.js:19` — `const ANTHROPIC_MODEL = 'claude-sonnet-5'` — model tier is a per-deployment constant, not a per-tenant plan attribute.
- `lib/salonBrain.js:34` — `CACHE_TTL = '1h'`, justified in a comment (`:23-33`) by *this Page's* observed inter-message gap distribution.
- `lib/salonIntents.js:75` — button title `'Байршил харах 📍'`; `:71-72` — `Манай салоны хаяг:` ("our **salon's** address").
- `lib/salonIntents.js:93` — the whole greeting sentence.
- `config/closures.js:40-52` — a **shipped default closure** for Naadam 2026-07-11..17, with Matrix's message text, active for any deployment that does not set the env override.
- `config/closures.js:32` — `SALON_UTC_OFFSET_MINUTES = 8 * 60` — Mongolia-only, fine for now, wrong as a platform constant.
- `lib/validator.js:224` — `hasBusinessContext = /салон|үйлчилгээ|үнэ|цаг|хаана|service|price/i` — the word **салон** is in the platform's input filter.
- `api/chat.js:59` — refusal text says "Ask about the **salon's** services".
- `api/chat.js:126, 153` — hand-built HTML location/Facebook answers.
- `lib/messengerClient.js:156` — default button title `'Нээх'` (Mongolian).

### 2d. The prompt template is the salon's business rules, not a template

`lib/systemPromptBuilder.js` presents itself as generic (it takes a `client` argument) but hardcodes Matrix's operating policy:

- `:29` — currency symbol `₮` appended unconditionally to every price.
- `:69-84` — team rendering is three fixed buckets keyed on `gender: 'female' | 'male' | 'manicure'` with fixed Mongolian headings *Эмэгтэй үсчид / Эрэгтэй үсчид / Маникюр баг*. **A team member with any other value silently vanishes from the prompt** — there is no `else`. GS Auto Center's mechanics cannot be expressed at all.
- `:114` — `Та бол "${companyName}" компанийн AI туслах юм.` — the only genuinely generic line.
- `:131` — the "ask which stylist tier" rule.
- `:132` — the "ask male or female" rule.
- `:134` — the Сор / CICA ambiguity rule, naming four specific services.
- `:135` — the children's-price refusal, a **second copy** of `CHILDREN_REPLY`.
- `:136` — service-name canonicalisation, with «гель маникюр» → «Гелэн будалт» as a literal example.
- `:138-149` — **the entire deposit table** (20,000₮ master, 10,000₮ 1st-degree, manicure/pedicure splits). Pure business policy, in a shared template.
- `:151-165` — five example dialogues naming the stylists Оюунсүрэн and Г. Мөнхзаяа, and ending bookings with the website's *"Цаг захиалах" button* CTA — which does not exist on Messenger, and which `lib/salonBrain.js:93` then has to spend prompt tokens contradicting.
- `:184-186` — the button CTA rule again, plus HTML-formatting rules for location and Facebook that `lib/messengerText.js` then has to strip back out.

`lib/salonBrain.js:86-106` (`MESSENGER_ADDENDUM`) is 3,163 characters of channel instructions, of which roughly half exists to *undo* website-specific rules in the base template. Two channels sharing one template, each partially cancelling the other, is a pattern that does not scale to four AI roles.

### 2e. Dead code from the *previous* tenant, still shipping

`api/chat.js:337-383` — `generateSystemPrompt()` builds a completely different persona: *"Та бол «X» компанийн Ахлах AI Борлуулалтын Зөвлөх"* (Senior AI Sales Consultant) with ROI objection-handling and lead capture. That is the DalaTech.ai B2B bot this repo was cloned from. Its only caller is `buildConversationSystemInstruction()` at `:385-387`, which **nothing calls** (verified by grep). ~50 lines of another tenant's prompt in the production bundle. Together with the Japan Tok docs, this is the single-tenant-fork failure mode, already visible once in this codebase.

Also dead: `lib/conversationStore.js:130` `memoryEnabled` (never called anywhere — so the operator has no signal that Redis is missing), `lib/validator.js:122/133/145` (`isValidEmail`, `isValidPhone`, `sanitizeHtml`), `lib/analytics.js:59` `trackConversationStart` (so `totalConversations` is permanently 0 and `/api/analytics` reports it as a real number).

### 2f. Frontend brand strings (all thrown away)

`public/index.html:6,21,25,50-51`; `public/widget.js:17,316`; `public/app.js:1,10,22,31,57,240,258,266-267,281-282` (localStorage keys `matrix-chat-history` / `matrix-chat-messages`, and a welcome message that still says **"Matrix Hair Salon"** and **"Яармаг салбар"** — a stale brand name; the config says "Matrix Eco Salon"). `package.json:2,5`. `vercel.json:11` (`/favicon.ico` → `/logo.jpg`).

---

## 3. What is genuinely good — carry the reasoning, not just the code

**1. Fast-ACK + durable hand-off (`api/messenger.js:109-145`, `lib/messengerQueue.js`).**
Meta retries a webhook that is slow to 200 and eventually **disables the subscription** — a silent, total outage for that tenant that nobody notices until a customer complains. The webhook therefore does nothing expensive before the ACK: it verifies, filters, publishes to QStash, returns 200. The model call and Send API happen in a separate invocation with at-least-once delivery and 3 retries (`lib/messengerQueue.js:13`).

The subtlety worth preserving is at `api/messenger.js:118-133`: the enqueue is time-boxed at 4s, and a **timeout is treated differently from a hard failure**. A timed-out publish may still have landed at QStash; processing it inline as well would double-reply the customer. So only *definitive* rejections fall back to inline. That distinction — ambiguous failure ≠ failure — is the kind of thing that gets lost in a rewrite and shows up as duplicate messages in production.

**2. Raw-body signature verification (`lib/rawBody.js`, `lib/messengerClient.js:25-42`).**
The body parser is disabled (`api/messenger.js:16-20`, `api/messenger-worker.js:15-19`) because HMAC is over the exact bytes Meta signed; re-serialising parsed JSON changes escaping and key order and never matches. `readRawBody` also caps at 1 MB (`lib/rawBody.js:10`). Verification is length-checked then `crypto.timingSafeEqual` (`:35-41`), and **fails closed when the secret is absent** (`:26`). Same discipline on the worker side for QStash. Carry this wholesale.

**3. Echo and receipt filtering (`api/messenger.js:164-180`).**
Three independent guards: `is_echo` (`:171`), delivery/read receipts (`:173`), and — explicitly *"defensive, beyond is_echo"* — refusing any event whose sender is the Page itself (`:173`). A bot that answers its own outbound message loops until Meta rate-limits the Page. Belt-and-braces here is correct; keep all three, and add the same for Instagram.

**4. Per-PSID conversation keying (`lib/conversationStore.js:88, 114-127`).**
History lives at `msgr:hist:<psid>` with a 24 h TTL matching Messenger's standard messaging window, trimmed to 12 messages. The append is an atomic `RPUSH` + `LTRIM` + `EXPIRE` **pipeline, not read-modify-write** (`:119-123`) — two rapid messages from the same person cannot clobber each other's turn. Under multi-tenancy this key becomes `<tenant>:msgr:hist:<psid>`, and it must, because PSIDs are page-scoped: the same human messaging two Dala AI tenants has two different PSIDs, but a PSID collision across tenants is not something to bet a customer's chat history on.

**5. `null` ≠ `[]` for history availability (`lib/conversationStore.js:84-101`, consumed at `lib/messengerProcess.js:50-60`).**
`getHistory` returns `null` when Redis is unreachable and `[]` only when Redis genuinely answered "no turns". The greeting shortcut fires only when history is *confirmed* empty; on `null` the code assumes an ongoing conversation. Without this, a Redis hiccup mid-conversation makes the bot greet an existing customer from scratch. This is a small, easily-lost distinction that encodes real operational experience.

**6. Deliberate price omissions, pinned verbatim (`lib/salonBrain.js:67-72`, `:98`; `lib/systemPromptBuilder.js:135`).**
Children's haircuts are a business decision to *not* answer. The rule is stated twice, and both times the model is instructed to reproduce a fixed sentence **letter for letter** rather than compose one. The comments (`:48-51`, `:54-56`) record why: live replies contained garbled Mongolian and a stray Russian word (`дополнительн`) that the model had invented in filler and apology positions. Every canned line — closing, handoff, fallback, children, booking, closure — is pinned for the same reason. **In Dala AI this must be a first-class config concept: a per-tenant list of `(topic, verbatim response, never quote a price)` rules**, not prose in a prompt.

**7. Prompt caching, done with the receipts (`lib/salonBrain.js:216-222, 243-253`).**
One cache block covering exactly the system prompt, with the breakpoint deliberately placed so the customer's own conversation stays *outside* it (`:210-215`) — so no customer's messages are ever written into an entry every other customer reads. `1h` TTL is chosen against measured inter-message gaps (`:26-33`), and every response logs `cache_read / cache_creation / uncached` token counts, because a cache miss is invisible in the reply and just quietly bills full price. Carry both the placement rule and the observability.

**8. The closure module's design (`config/closures.js`).**
Three good decisions: the customer-facing sentence is **never composed by the model** (Mongolian date suffixes are not safely generated — `:22-26`); the closure is evaluated **per request, not cached with the base prompt** (`lib/salonBrain.js:139-155`), because a warm lambda can outlive the end of a break; and a malformed env closure is ignored with a warning rather than silently announcing a wrong break (`:113-121`, `:133-136`).

**9. One atomic send (`lib/messengerText.js:66-84`, `lib/messengerProcess.js:96-99, 111-116`).**
The reply is capped to a single Send API call before sending, and `markHandled` runs only *after* the customer has received it. If the send fails, nothing was delivered, the mid stays unmarked, and the retry is clean — no half-delivered, re-sent chunk.

---

## 4. What is wrong or risky

### CRITICAL — nothing meters spend

**4.1 No budget, no ledger, no ceiling anywhere.** `generateSalonReply` (`lib/salonBrain.js:177`) checks only that `ANTHROPIC_API_KEY` exists (`:178-181`) and calls the API. There is no per-day cap, no per-conversation cap, no spend accounting, no alert path. Grep confirms: no cost, budget, quota or ledger symbol exists in the repo. The only bound on Messenger spend is how fast a human can type into the Page. On a 1M-token/$2-in model with a ~6k-token system prompt, a scripted attacker messaging the Page is unbounded cost, and the first signal is the Anthropic bill.

**4.2 `/api/chat` is an open, unauthenticated Anthropic proxy.** `api/chat.js` has no auth of any kind. The only gate is `applyCors` — and `lib/cors.js:16-17` reads:

```js
const allowAnyOrigin = allowedOrigins.length === 0;
const originAllowed = allowAnyOrigin || !origin || allowedOrigins.includes(origin);
```

Two fail-open paths: (a) if `ALLOWED_ORIGINS` is unset the allow-list is empty and **everything is allowed**; (b) `|| !origin` means **any request with no `Origin` header passes even when the list is configured** — which is every `curl`, every script, every server-to-server call. CORS is a browser-side control and was never an authorization gate; here it is the *only* thing in front of a paid model call. Anyone who finds the URL can spend the founder's money.

**4.3 The rate limiter is not a rate limiter.** `lib/rateLimiter.js:4` is a per-process `Map`. Vercel runs many concurrent lambda instances and recycles them constantly, so the counter is per-instance and per-cold-start; an attacker gets 30/min *per instance they happen to land on*, and a burst spawns instances. `lib/rateLimiter.js:8-15` also registers a module-scope `setInterval` in a serverless function. **And the entire Messenger path — the one that actually calls Sonnet — has no rate limiting at all.** (Contrast `dalatech-english`'s `src/lib/rateLimit.ts`, which is Redis-backed, per-account, and fails closed.)

**4.4 Timeouts exceed a plausible function limit.** `UPSTREAM_TIMEOUT_MS = 25000` (`lib/salonBrain.js:38`) and `INLINE_DEADLINE_MS = 12000` (`api/messenger.js:27`). `vercel.json` has **no `functions` block**, so the platform default applies. *Assumed, not verified:* on a Hobby plan that default is 10 s, which would kill the inline degraded path before its own deadline fires — the tokens are spent, the lambda is frozen, the customer gets nothing, and the log shows only a truncated invocation. Worth confirming against the actual Vercel plan.

**4.5 `withTimeout` does not cancel.** `api/messenger.js:29-41` races a timer against a promise but never aborts the underlying work. On the inline path (`:150-153`) the handler returns 200 while an Anthropic call is still in flight. Spend continues on a request nobody is waiting for.

### CRITICAL — nothing survives a second tenant

**4.6 The module-scope prompt cache.** `lib/salonBrain.js:142` `let cachedBasePrompt = null` — built once per process from the build-time `clientData`. Two tenants on one warm lambda: tenant B is answered with tenant A's prices, staff names and phone number. This is a cross-tenant data leak, not a bug.

**4.7 The Redis namespace has no tenant.** `msgr:hist:<psid>` (`lib/conversationStore.js:88`) and `msgr:done:<mid>` (`:53`). One Upstash database shared across tenants means one PSID or mid collision crosses a tenant boundary. The keys must carry the tenant id, and the tenant id must be derived server-side from the Page that received the event — never from the payload.

**4.8 The worker deliberately does not pin the URL claim.** `api/messenger-worker.js:45-52` documents the choice: *"only our QStash signing key can produce a valid signature, and Vercel's internal host can differ from the public URL."* Correct at one tenant. With one QStash account and per-tenant worker endpoints, a signed job for tenant A is a **valid** signed job at tenant B's worker URL — the signature says "this came from our QStash", not "this was addressed to this tenant". Bind the tenant inside the signed body and re-derive/validate it in the worker.

**4.9 The in-memory analytics singleton.** `lib/analytics.js:165` is a process-global counter with no tenant dimension, and `/api/analytics` (unauthenticated, `api/analytics.js:13-18`) would serve whatever any tenant's traffic happened to put in the instance the request landed on. Analytics AI needs a per-tenant persisted store; nothing here is reusable.

**4.10 The tenant is a git branch.** `CLIENT_ONBOARDING.md:7-9` — "Open `/config/currentClient.js` and update the following sections" — then `npm run build:react` and redeploy. Onboarding client #3 today means editing code and shipping a deployment. That is exactly the failure mode Dala AI's hard test forbids.

### HIGH — Cyrillic / ASCII assumptions in matching (all confirmed by running the real modules)

**4.11 `GREETING_REGEX` is unanchored at the right edge.** `lib/salonIntents.js:26` — `/^(сайн|байна|уу|hi|hello|hey)/i`. There is no word boundary and no terminator, so it matches any message whose *first two letters* are `уу`. Verified:

```
detectShortcutIntent('Уучлаарай асуумаар байна', {hasHistory:false})  →  'greeting'
```

`Уучлаарай` ("excuse me / sorry") is one of the commonest openers in Mongolian customer service. A first-time customer who opens with an apology gets the canned welcome and their actual question is never answered by the model. `сайн` prefixes `сайхан`; `байна` prefixes plenty. The fix cannot be `\b` — Dala AI must use explicit Unicode-aware token boundaries, not the ASCII `\b`.

**4.12 No NFC normalisation, anywhere.** `grep -rn "normalize("` over the whole repo returns **nothing**. Mongolian Cyrillic `й` (U+0439) and `ё` (U+0451) are canonically decomposable. Verified:

```
'Байна уу'.normalize('NFD')  →  detectShortcutIntent → null   (NFC form → 'greeting')
'Байршил хаана вэ'.normalize('NFD') → 'location'              (no decomposable letters)
```

So the same class of message matches or does not match depending on **which letters it happens to contain** and which keyboard/IME the customer used — a silent, per-word, impossible-to-reproduce inconsistency. Every regex in the repo over user text has this property: `lib/salonIntents.js:21,25,26`; `api/chat.js:91-94`; `lib/analytics.js:85-114`; `lib/validator.js:196-202, 211, 221-224`.

**4.13 The location shortcut has no history gate and fires on a substring.** `lib/messengerProcess.js:58-83` runs the location check on *every* message, mid-conversation included, and `хаяг` ("address") is matched anywhere in the text. Verified:

```
detectShortcutIntent('Facebook хаяг байна уу', {hasHistory:true})  →  'location'
```

The customer asked for the Facebook page and gets a Google Maps card. `lib/salonIntents.js:25` already special-cases the email false positive (`и-мэйл хаяг`) — a hand-patched symptom of an unanchored pattern over user text, which will keep producing new symptoms.

**4.14 The gibberish filter uses the Russian vowel set.** `lib/validator.js:201` — `/^[^аеёиоуыэюя\s]{20,}$/i`, commented *"Very long sequence without Mongolian vowels"*. It is missing **ө (U+04E9)** and **ү (U+04AF)**, the two vowels that most distinguish Mongolian from Russian. Verified: `cls.test('үүүү…')` and `cls.test('өөөө…')` both return `true` — i.e. those are classified as *absence of vowels*. Practical impact today is low (the pattern needs a 20+ character token with no space), but this exact assumption — "Cyrillic means Russian" — will produce a real customer-facing rejection the moment the class is used on a longer span. `lib/validator.js:196-199` is ASCII-only in the same function (`[a-z]`, `[qwerty]`), and `:168` `/on\w+\s*=/i` uses ASCII `\w`.

**4.15 `isProfessionalQuestion` silently refuses a paying customer.** `api/chat.js:58-73`: if the filter returns false, the customer gets a canned "I don't have information about that" **with HTTP 200**, no model call, and `filtered: true` in a log nobody reads. A heuristic that can be wrong (see 4.14) is wired to a silent refusal. If Dala AI keeps a filter like this, a rejection must be observable and reviewable — which is precisely what the Quality layer is for.

**4.16 Character-count vs byte-count.** `lib/messengerText.js:78` and `lib/messengerClient.js:52` measure `.length` (UTF-16 code units) against Messenger's 2000-*character* cap. Verified `'😊'.length === 2`. This over-counts, so it errs safe here — but the same reflex applied anywhere Cyrillic length matters (2 bytes/char in UTF-8) will be wrong in the unsafe direction. `lib/messengerClient.js:59` can also hard-split a surrogate pair mid-emoji when no boundary is found; `:157-158` guards against exactly this in button titles but the chunker does not.

### HIGH — idempotency and duplicate delivery

**4.17 The dedup check fails open.** `lib/conversationStore.js:49-58` — `isAlreadyHandled` returns `false` on any Redis error or when Redis is unconfigured, and `markHandled` (`:64-72`) silently no-ops. The comment calls this deliberate ("a Redis outage never blocks a reply"), and at one tenant with QStash dedup underneath (`lib/messengerQueue.js:66`) that is defensible. But the two layers fail together in the case that matters: the **degraded inline path** (`api/messenger.js:147-154`) runs when QStash is unconfigured or hard-failed, which is exactly when there is no `deduplicationId` protection either. Meta redelivers on a missing/slow 200, and the customer gets the same answer twice — after paying for it twice.

*Assumed, not verified:* QStash's `deduplicationId` window is finite (Upstash documents ~10 minutes). A Meta redelivery outside that window is not deduped by QStash and lands on a fail-open Redis check.

**4.18 The degraded path is silent.** Nothing alerts when `qstashEnabled()` is false (`lib/messengerQueue.js:37-43`) or when Redis is absent. `memoryEnabled()` exists for exactly this and is never called. The system degrades from "durable, deduped, with memory" to "best-effort, may double-reply, amnesiac" with no operator signal beyond a `console.error` line.

**4.19 Retry burn on a permanent error.** `lib/messengerProcess.js:101-109` rethrows on any brain failure when `finalAttempt` is false, so QStash retries 3 times. A permanent condition — missing API key, exhausted credit, 401 — burns four attempts (and four HTTP round-trips) before the fallback. Dala AI should distinguish retryable (5xx, 429, timeout) from terminal (4xx auth, budget exhausted) and stop.

### MEDIUM — data exposure and secrets

**4.20 `/api/analytics` is unauthenticated and returns customer free text.** `api/analytics.js:13-18` → `lib/analytics.js:141-142` returns `recent: customerSatisfaction.slice(-10)` — the last ten free-text feedback submissions, verbatim. Anyone who GETs the URL reads them. `/api/feedback` (`api/feedback.js:47`) writes into that unbounded array with no auth, so it is also a memory-growth vector on a warm instance.

**4.21 Customer message text is shipped to an arbitrary webhook.** `lib/logger.js:12-16, 28-29` POSTs a 180-char preview of the customer's message *and* the bot's reply to `LOG_WEBHOOK_URL`, with a bare `catch {}` (`:17-19`). It is wired into `api/chat.js` only, not the Messenger path. Under Dala AI this is per-tenant customer data leaving the system to a destination configured by a single global env var.

**4.22 `/api/health` leaks process internals.** `api/health.js:21-26, 37` reports heap/RSS/external memory, uptime, and whether the API key is configured — unauthenticated (CORS is not a gate, see 4.2).

**4.23 PSIDs in logs, no tenant scope.** `lib/messengerProcess.js:39, 80, 88, 103, 117` log `psid=` and `mid=`. PSIDs are pseudonymous but are stable per-person-per-page identifiers. Every log line is stamped with the build-time `SALON_NAME`, not the request's tenant.

*To its credit:* no secret is ever logged. `lib/messengerClient.js:79` puts the token in a header not a URL; error objects carry `fbCode`/`fbSubcode` but not the token (`:118-125`); `lib/salonBrain.js:228-231` converts upstream failures to a clean message rather than surfacing the key. Preserve all of this.

### MEDIUM — correctness and hygiene

**4.24 The only test suite is red today.** `npm test` → **16 pass, 2 fail** (verified by running it). Both failures (`tests/closures.test.js:204` "the prompt carries the break while the salon is closed", `:226` "a warm process picks up the end of the break without a restart") assert that the *shipped default* Naadam closure is active — it ended 2026-07-17, and today is 2026-08-30. The tests read the real clock instead of injecting one, so they were time-bombed from the day they were written. This matters more than it looks: `tests/closures.test.js:1-6` says the load-bearing claim is *"once the break ends the bot must be what it was before"* — the suite that guards it has been failing for six weeks and nothing noticed. **Dala AI's tests must inject the clock.**

**4.25 The model ID carries a date suffix.** `api/chat.js:13` — `'claude-haiku-4-5-20251001'`. Against the current model table this should be `claude-haiku-4-5`. Also note the two channels run **different models** (`lib/salonBrain.js:19` Sonnet 5 vs Haiku here) — deliberate and documented (`:16-19`), but it means the website and the Page give measurably different answer quality from the same knowledge base.

**4.26 The website path does no prompt caching.** `api/chat.js:182` calls `buildSystemPrompt` on **every request** (no memoisation, unlike `lib/salonBrain.js:142`) and passes it as a plain string at `:327` with no `cache_control`. The prompt comfortably exceeds Haiku's 4096-token minimum cacheable prefix, so this is pure avoidable spend on every website message.

**4.27 `types/clientConfig.ts` is decorative.** No TypeScript in the toolchain, nothing imports it, and it does not match reality: it models `logoUrl`/`brandColor` both flat *and* nested (`:38-47`), carries a `bankDetails` type nothing uses (`:31-35`), and `TeamMember.gender: 'female' | 'male' | 'manicure'` (`:20`) encodes a service line as a gender. Every consumer defends against both shapes at runtime instead (`lib/systemPromptBuilder.js:56-63`, `api/chat.js:339-345`). **In Dala AI the config schema must be validated at write time and be the only shape that exists.**

**4.28 `formatPriceList` fails safe — keep this.** `lib/systemPromptBuilder.js:36-38`: an unrecognised price-list shape returns "no pricing information available" rather than attempting to render. The comment gives the reason — *"refuse to render prices rather than risk serving a category (e.g. children's) the official list doesn't carry."* That is the correct instinct and the right precedent for tenant config that arrives malformed.

---

## 5. The knowledge base as it exists today

### 5a. Shape

`config/currentClient.js` is one exported object literal, 121 lines, three top-level keys:

```js
export const clientData = {
  branding: { companyName, brandColor, accentColor, logoUrl },        // :6-11
  knowledge: {
    companyIntro: "…",                                                 // :13   one paragraph, contains a URL
    team:      [{ name, role, gender }],                               // :16-29  9 members
    priceList: [{ service_name, price }],                              // :36-86  40 items
    faqs:      [{ question, answer }],                                 // :88-105  4 items, answers contain raw HTML
    contact:   { phone, email, address, facebook, mapsUrl,
                 website, booking }                                    // :106-114
  },
  behavior: { tone: "formal", language: "mn" }                         // :116-119
};
```

Notable properties of the data itself:

- `price` is **`number | string`** in the same array — `55000` (`:39`) alongside `"66,000 – 88,000"` (`:38`). The renderer handles both (`lib/systemPromptBuilder.js:18-23`), and `priceOf` (`:106-110`) repeats the branch. Ranges are pre-formatted strings using an **en dash**, so they are display strings, not values — they cannot be compared, summed, or validated.
- `gender` on a team member takes `'female' | 'male' | 'manicure'` (`:18-28`) — two genders and one service line in one field, because the prompt renders it as three headings.
- FAQ answers contain raw HTML (`:91`: `<br><br><a href=… target="_blank">`), which the website renders and `lib/messengerText.js` then strips. Knowledge carries channel-specific presentation.
- `behavior.tone` and `behavior.language` are **read nowhere in the Messenger path** — only `api/chat.js:344-345` reads them, and only inside the dead `generateSystemPrompt`. They are inert.
- The deliberate omission (children's prices) exists only as a **comment** at `:34-35` and as pinned strings in two code files. It is not data.

### 5b. How it becomes a prompt

`lib/systemPromptBuilder.js:41-188` is one template literal with ten interpolation points. Order: language rules → company intro → team (three hardcoded buckets, `:69-84`) → rendered price list (`:6-39`, `₮` appended) → 8 pricing rules → the deposit table → 5 example dialogues → FAQs → contact block → 10 answering rules.

`lib/salonBrain.js:143-149` appends `MESSENGER_ADDENDUM` and caches the result in a module-scope variable; `:150-155` appends the closure section fresh on every request.

### 5c. Size (measured in this checkout, 2026-08-30)

| Segment | Characters | UTF-8 bytes |
|---|---:|---:|
| Base prompt (`buildSystemPrompt(clientData)`) | 7,824 | 12,866 |
| `MESSENGER_ADDENDUM` | 3,163 | 5,584 |
| **Messenger system prompt (cached block)** | **10,987** | **18,450** |
| `buildClosureSection` (only during a break) | +1,408 | — |

**Token count: not measured.** No API key in this environment. For predominantly Mongolian Cyrillic (2 bytes/char, and Mongolian is far less represented in BPE vocabularies than Russian), a defensible estimate is **~6,000–9,000 tokens**. Do not treat that as a fact — the exact figure is already being logged in production at `lib/salonBrain.js:249-253` (`cache_read / cache_creation / uncached`), so one line from a Vercel log gives the real number. Two things follow regardless of where in that range it lands: the prompt clears even Haiku's 4096-token minimum cacheable prefix comfortably, and the code comment at `lib/salonBrain.js:23` calling it *"~12.8k characters"* is wrong — 12,866 is the **byte** count of the base prompt; the character count of the full cached block is 10,987.

Note also that the base prompt has grown to ~7.8k characters for **40 services and 9 staff**. A tenant with a real catalogue — GS Auto Center's parts and labour lines — cannot be rendered whole into a system prompt. Reception AI needs retrieval over a per-tenant knowledge store, not full inlining, and the retrieval boundary needs the same hardening the pinned lines got.

### 5d. What has to change for this to be per-tenant DATA

1. **Row, not module.** `clientData` becomes rows in a Postgres schema loaded per request from a tenant id derived server-side (from the Page/IG account id on the inbound event, resolved through a `channel_bindings` table — never from the payload's own claim). Every module-scope cache keyed only by "nothing" becomes a cache keyed by `(tenant_id, config_version)`, or it is a cross-tenant leak (4.6).
2. **Prices as values, not display strings.** Split `price` into `price_min` / `price_max` / `currency` / `unit` and render at prompt-build time. The current `number | string` union with an en dash is unvalidatable and unqueryable, and Analytics AI will need to attribute revenue against it.
3. **Team taxonomy as tenant-defined dimensions.** Replace `gender: 'female'|'male'|'manicure'` and the three hardcoded headings (`lib/systemPromptBuilder.js:69-84`) with a per-tenant list of `staff_groups` (label + ordering) and a group reference on each member. Matrix declares three groups with Mongolian labels; GS Auto Center declares "Мотор", "Явах анги", "Цахилгаан". **No code changes between them.** Today, a member whose group is unrecognised silently disappears from the prompt — the new renderer must fail loudly instead (`lib/systemPromptBuilder.js:36-38` is the right precedent).
4. **Business rules as rows.** The deposit table (`:138-149`), the ambiguity rule (`:134`), the clarification rules (`:131-132`) and the canonical-naming rule (`:136`) are Matrix policy sitting in shared template text. They become typed per-tenant rule rows: `pricing_rules`, `disambiguation_pairs`, `clarify_before_quoting`, and a **`refusal_topics` table** carrying `(topic matcher, verbatim response, quote_price: false)` — which is how the children's omission stops being a comment plus two copies of a string, and starts being a thing the founder can add for tenant #3 from an admin form.
5. **Pinned strings become per-tenant, native-reviewed rows.** `CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY`, `BOOKING_LINE` (`lib/salonBrain.js:52-81`) all move into a `canned_responses` table with a `reviewed_by`/`reviewed_at` column, because the whole reason they exist is that a human checked the Mongolian. `BOOKING_LINE` in particular currently hardcodes **QPay** and the word *deposit*; it becomes a per-tenant booking hand-off template with the tenant's own link and payment language.
6. **Closures become rows, not env vars.** `SALON_CLOSURE_*` (`config/closures.js:140-151`) is one global holiday for one business, plus a **default closure shipped in code** (`:40-52`) that would apply to every tenant that failed to override it. Replace with a `tenant_closures` table (`start`, `end`, `title`, `verbatim_message`) and **no default**. Keep three properties exactly: the message is quoted verbatim and never model-composed; the window is evaluated per request against the tenant's own timezone (not a `SALON_UTC_OFFSET_MINUTES` constant); and a malformed row is ignored with an alert rather than announced.
7. **Channel presentation out of the knowledge.** FAQ answers currently carry `<br>` and `<a href>` (`config/currentClient.js:91`) which one channel renders and another strips. Store the fact and the URL; let a per-channel renderer decide the markup.
8. **A validated write path.** `types/clientConfig.ts` is unenforced and already diverged (4.27). The schema needs runtime validation at write time (one shape, no flat-or-nested union), a version number, and an audit row — which is also the surface the Quality layer writes its proposed knowledge-base updates into, pending the founder's approval.
9. **The tenant-derived cache key is the acceptance test.** Reception AI is correct when two tenants' events processed in the same warm instance cannot influence each other — prompt, history key, dedup key, rate-limit key, budget counter, log line. That is testable offline with a fake clock and two fake tenants, and it is the test this repo could never have written.

---

## Open questions — the founder's call

1. **Does Matrix's website chatbot survive at all?** `api/chat.js` and the whole `public/` + `src/` widget are a separate channel from Reception AI. Are they in scope for Dala AI (a third channel alongside Messenger and Instagram), migrated to a thin embed against the same tenant config, or retired with the salon keeping this repo running as-is?
2. **What happens to the running production deployment during the migration?** Matrix Eco Salon is live on this codebase today. Is Dala AI a cutover (one Page, one moment, one rollback plan) or does Matrix run on both while tenant #2 onboards?
3. **Where does the per-tenant Page access token live?** Vercel env vars do not scale past one tenant. The realistic options are an encrypted column with a KMS-held key, a Supabase Vault secret per tenant, or a dedicated secrets store — each with a different answer to "what does a founder do at 2 a.m. when a token expires". This needs deciding before the schema, not after.
4. **Is the Meta app shared or per-tenant?** One Dala AI app subscribed to every tenant's Page means one `FACEBOOK_APP_SECRET`, one App Review, one blast radius — and one Meta policy action can take down every tenant simultaneously. Per-tenant apps mean per-tenant App Review, which may make onboarding #3 a multi-week process regardless of how good the config is.
5. **What is a tenant's monthly AI budget, and what happens when it is spent?** The three honest options — stop answering, fall back to the human-handoff line, or keep answering and bill the overage — are a pricing decision, not an engineering one. The fail-closed machinery cannot be designed until this is answered.
6. **Do Matrix's pinned Mongolian strings get re-reviewed?** They were native-speaker reviewed for *this* prompt in *this* context. Moving them into a per-tenant table and changing the surrounding prompt is a change to the conditions they were validated under.
7. **Should the deliberate-omission concept be a product feature the tenant controls?** "Never quote a price for X; say this instead" is genuinely valuable and genuinely dangerous — a tenant who sets it carelessly gets a bot that refuses to sell. Founder-approved only, or self-serve with review?