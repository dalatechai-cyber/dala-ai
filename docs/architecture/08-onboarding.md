## 8. Matrix onboarding checklist and platform topology

**Evidence convention.** Claims about existing code are marked **(verified: `path:line`)** and were read in the file on this machine or produced by running the code in this checkout (Node 22). Claims I could not confirm are marked **(ASSUMED)** and carry the check that would confirm them. Nothing marked ASSUMED may become a checklist step's *pass criterion* until it is verified — that distinction is the whole lesson of `supabase_migrations.schema_migrations` next door (`dalatech-english/docs/security-audit-2026-08-23.md:305-331`).

Three claims this section leans on hardest, re-verified by execution in this checkout on 2026-08-31:

```
detectShortcutIntent('Уучлаарай асуумаар байна', {hasHistory:false})   -> 'greeting'
detectShortcutIntent('Facebook хаяг байна уу',   {hasHistory:true})    -> 'location'
detectShortcutIntent('Байна уу'.normalize('NFD'),{hasHistory:false})   -> null   (NFC form -> 'greeting')
npm test                                                               -> 16 pass, 2 fail
```

---

## 8.1 Platform topology

### 8.1.1 Framework: Next.js 14.2 App Router on Vercel, TypeScript

The candidates are the sibling's stack (Next.js 14.2 App Router, TypeScript, Vercel) and the ancestor's (bare Vercel Node functions in `api/*.js`, ESM, no framework, Vite for a widget — verified: `Matrix-Chatbot/package.json`, `Matrix-Chatbot/vercel.json`).

**Choose Next.js 14.2 App Router.** In order of weight:

1. **Dala AI needs an authenticated admin dashboard on day one and the ancestor's stack has no answer for it.** The Quality layer, the tenant config editor, the spend view and the onboarding runbook are all UI over Supabase with a session. `@supabase/ssr` + middleware session refresh is solved next door and unsolved in a bare-functions repo. Hand-rolling session handling is exactly the "re-implement the gate locally" that `guardAiRoute()` exists to prevent.
2. **The sibling's hard-won libraries port directly.** `src/lib/supabase/fetch.ts` (the `no-store` client), `src/lib/rateLimit.ts` (fail-closed, with the `@upstash/ratelimit` timeout trap handled and an explicit `FAIL_OPEN_KEYS` set), and `scripts/check-supabase-nostore.mjs` are all Next-shaped. Porting them to bare functions means rewriting the reasoning, and the reasoning is the asset.
3. **TypeScript as a CI gate is not optional.** The ancestor shipped `types/clientConfig.ts` as pure decoration — no TypeScript in the toolchain, nothing imports it, and it has already diverged (it models branding both flat and nested, and types `TeamMember.gender: 'female' | 'male' | 'manicure'`, encoding a service line as a gender — verified: `Matrix-Chatbot/types/clientConfig.ts:17-21, 37-47`). Consumers defend against both shapes at runtime instead (`Matrix-Chatbot/lib/systemPromptBuilder.js:56-63`).
4. **One deployment, one domain, one env surface.** Meta needs a single stable callback URL per app per object. Splitting webhooks and dashboard doubles the deployments, env vars, and places a per-tenant secret can leak.

**What the choice costs, and how each cost is paid:**

| Cost | Mitigation |
|---|---|
| **The GET-caching trap.** A route handler exporting only `GET` caches every Supabase read for a **year**; `export const dynamic = 'force-dynamic'` does not stop it. Only `cache: 'no-store'` on the fetch does. In Dala AI the hazard is worse than next door: a cached `tenant_channels` or `tenant_config` read returns a **stale other-tenant** value with HTTP 200 and `error: null`. | Port `src/lib/supabase/fetch.ts` and wire it into every client on day one. Port `scripts/check-supabase-nostore.mjs` into CI **both directions** (it also builds a client without the opt-out and asserts it does *not* send `no-store`, so the assertion cannot silently become vacuous). CI greps ban a bare `createClient` outside `src/lib/supabase/`. |
| No `bodyParser: false` escape hatch. The ancestor disables the parser to HMAC the exact bytes (verified: `Matrix-Chatbot/api/messenger.js:16-20`; reasoning at `Matrix-Chatbot/lib/rawBody.js:1-10`). | App Router hands you the stream. Use `Buffer.from(await req.arrayBuffer())` — **not** `await req.text()`, which decodes to UTF-16 and re-encodes; byte-identical only for well-formed UTF-8 and a needless assumption on a signature path. |
| Middleware can swallow the webhook. The sibling's soft-404 is exactly this shape: the matcher redirects sessionless requests to `/buy`, so a new file-like route silently serves the wrong page. A sessionless Meta POST is the most sessionless request there is. | The matcher **excludes `/api/webhooks/:path*` and `/api/workers/:path*` explicitly**, and a test imports the matcher config and runs those paths through it. A named CI check, not a comment. |
| Cold-start weight on a latency-sensitive ACK path. | The webhook route does no model work before the 200. Pin `export const runtime = 'nodejs'` (needed for `node:crypto.timingSafeEqual` and the Upstash SDKs) and set `maxDuration` explicitly per route. The ancestor never set one (verified: `Matrix-Chatbot/vercel.json` has no `functions` block) while `salonBrain.js` sets `UPSTREAM_TIMEOUT_MS = 25000` (verified: `:38`) and `messenger.js` an `INLINE_DEADLINE_MS = 12000` (verified: `:27`). Whether either exceeds the plan's limit is **(ASSUMED unknown)** — measured in step 6. |

**Note the webhook route exports both `GET` (verify handshake) and `POST` (events), so `hasNonStaticMethods` is true and `revalidate` is 0 for that route.** Do not treat that as protection. Every cron route and every admin read route will be GET-only, and those are exactly where a stale `tenant_channels` row does the damage. The opt-out belongs in the client, once, for all routes.

### 8.1.2 Repo layout

```
dala-ai/
├─ src/
│  ├─ middleware.ts                       # session refresh; webhook/worker paths EXCLUDED from matcher
│  ├─ app/
│  │  ├─ api/
│  │  │  ├─ webhooks/meta/route.ts         # GET verify handshake + POST events. ACK-fast, no model work.
│  │  │  ├─ workers/inbound/route.ts       # QStash worker: message -> reply
│  │  │  ├─ workers/comment/route.ts       # QStash worker: comment -> reply   (PHASE 2)
│  │  │  ├─ admin/tenants/…                # founder-only CRUD (config, budgets, channels)
│  │  │  ├─ admin/probe/send/route.ts      # POST-only: one-off send to a named PSID, founder-only
│  │  │  ├─ admin/quality/proposals/…      # KB change proposals: list / approve / reject
│  │  │  └─ cron/                          # reconcile-subscriptions, token-health, silence-watchdog
│  │  ├─ (admin)/…                         # dashboard UI (founder)
│  │  └─ (tenant)/…                        # tenant-owner read-only view — PHASE 2, see §8.9 Q1
│  ├─ lib/
│  │  ├─ tenant/resolve.ts                 # (object, entry[].id) -> tenant. THE only routing path.
│  │  ├─ tenant/withTenant.ts              # the chokepoint: scope + entitlement + budget, in that order
│  │  ├─ tenant/db.ts                      # db(tenantId).from('conversations') — tenant_id pre-bound
│  │  ├─ meta/graph.ts                     # version pin, send client, per-tenant token (NO env fallback)
│  │  ├─ meta/signature.ts                 # HMAC over raw bytes, against a SET of app secrets
│  │  ├─ meta/errors.ts                    # 190 / 613 / 100 / 2534014 taxonomy
│  │  ├─ budget/ledger.ts                  # reserve -> settle; 503 on any error
│  │  ├─ budget/limits.ts                  # Upstash, fail closed, explicit FAIL_OPEN_KEYS
│  │  ├─ prompt/build.ts                   # ORDERING AND INTERPOLATION ONLY — no Mongolian sentence
│  │  ├─ prompt/render.ts                  # price/currency/number formatting, driven by tenant columns
│  │  ├─ match/engine.ts                   # the ONE matcher engine: NFC + Unicode token boundaries
│  │  ├─ text/mn.ts                        # NFC, fold table, grapheme-safe slicing, byte vs char
│  │  ├─ clock.ts                          # the ONLY new Date() in src/
│  │  ├─ alerts/telegram.ts                # parses {"ok":true}, records delivery_status
│  │  └─ supabase/{fetch,admin,server,client}.ts
├─ supabase/
│  ├─ migrations/                          # applied BY HAND via the dashboard editor (assume it, plan for it)
│  └─ verify/                              # V1..V9 + collation assertion, as runnable .sql
├─ scripts/
│  ├─ check-supabase-nostore.mjs           # ported verbatim from the sibling
│  ├─ check-tenant-scoping.mjs             # the no-unscoped-query guard
│  ├─ check-text-safety.mjs                # ASCII-regex / \b / \w / byte-length guard over src/
│  ├─ check-prompt-blocks.mjs              # no Cyrillic string literal in src/lib/prompt/
│  ├─ check-matchers.mjs                   # matcher-row safety (see §8.1.6 note)
│  ├─ check-env-example.mjs                # every process.env.X in src/ appears in .env.example
│  └─ verify-catalog.mjs                   # runs supabase/verify/*.sql, prints every row, exits non-zero
├─ tests/                                  # node:test, clock injected everywhere
├─ config/platform.ts                      # PLATFORM constants only — never a tenant fact
├─ docs/onboarding/                        # per-tenant runbook + the pasted verification output
└─ .env.example
```

**The rule the layout encodes:** `config/platform.ts` may contain the Graph version default, model IDs, timeouts and ceilings. It may not contain a company name, a phone number, a price, a Mongolian customer-facing sentence, or a Page ID. Everything in the ancestor's `config/currentClient.js` (121 lines, one exported object literal) becomes rows.

**And a second, stronger rule that the first one does not imply:** `src/lib/prompt/` may contain ordering and interpolation and **no Mongolian sentence**. This is the finding the config-not-code critique is right about and it is the largest single gap in the draft — see §8.1.7.

### 8.1.3 Environments

| Environment | Vercel | Supabase | Meta app | Purpose |
|---|---|---|---|---|
| **production** | `dala-ai` production domain, e.g. `app.dalatech.online` | **prod project** | the Live app | Real tenants. |
| **preview** | per-PR URLs (unstable) | **staging project** | none — previews never receive Meta webhooks | Code review. |
| **staging** | pinned branch deployment on a stable subdomain, e.g. `staging.dalatech.online` | **staging project** | a **second, Dev-mode Meta app** subscribed to a founder-owned test Page + test IG account | Rehearse every migration, every catalog query, and the whole Meta path without touching a customer. |

**Yes, there is a staging Supabase project.** (a) The RLS/grant migrations must be rehearsed somewhere, because the failure mode is *partial application* and the discovery mechanism is a catalog query you have to have written and run before; (b) the migration ledger stops being a ledger the moment you apply one migration through the dashboard editor, so "which environment is at which state" must be answered from the catalog and you want to practise that; (c) the Meta pipeline can only be exercised end to end against a real Page, and that Page must not be a customer's.

**Two safety properties baked into the split:**

- `DALA_ENV !== 'production'` **hard-refuses any Send API call to a channel whose `mode = 'live'`.** A preview deployment that somehow received a real event cannot message a real customer. Five lines in `src/lib/meta/graph.ts`.
- The staging Meta app has a **different app secret**, which is why signature verification takes a *set* of secrets rather than one value. That same mechanism gives app-secret rotation with no downtime — and, critically, it is what makes the mirror of §8.2 Phase D work if the founder ever chooses a separate Dala AI app.

### 8.1.4 Environment variables — platform-level only

Every value below is one value for the whole deployment. **If a value would need a second copy for a second tenant, it is not an env var; it is a row.**

| Var | What it is | Missing / wrong → |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | project URL | boot failure |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (new key model) | dashboard cannot read |
| `SUPABASE_SECRET_WEBHOOK` | `sb_secret_…`, named key for the ingest path | webhook 503 |
| `SUPABASE_SECRET_WORKER` | `sb_secret_…`, named key for the worker | worker 503 |
| `SUPABASE_SECRET_ADMIN` | `sb_secret_…`, named key for admin/cron | admin 503 |
| `TENANT_KEK_V1` | 32-byte base64 KEK for envelope encryption of tenant secrets | **refuse to boot.** Never fall back to plaintext. |
| `TENANT_KEK_ACTIVE_VERSION` | `1` | refuse to boot |
| `META_APP_ID` | the Live app's ID | send/subscription calls fail |
| `META_APP_SECRETS` | **comma-separated set** (live app + rotation-in-progress + staging app + the incumbent's app during the mirror window) | **401 every webhook.** Never "skip verification". |
| `META_WEBHOOK_VERIFY_TOKEN` | the handshake token. **Platform-level, not per-tenant** — one app, one callback URL, one verify token. The ancestor's `MESSENGER_VERIFY_TOKEN` (verified: `Matrix-Chatbot/api/messenger.js:63`) reads as per-tenant only because there is exactly one Page. | handshake fails; subscription cannot be (re)created |
| `META_GRAPH_VERSION` | default Graph version, e.g. `v26.0`. Per-tenant override is a **nullable column**, for canarying a bump on one tenant. | pin lost |
| `ANTHROPIC_API_KEY` | one platform key; per-tenant attribution is the **ledger**, not separate keys | every reply 503 |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | limiter + dedupe + history + mode cache | **fail closed** on cost-bearing paths |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | durable hand-off | degraded inline path, and it must alert (step 33) |
| `WORKER_PUBLIC_URL` | stable base QStash calls back on | queue unusable |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | the alert path | **alerts silently vanish** — see step 8 |
| `PLATFORM_MONTHLY_CEILING_USD` | global kill ceiling above the sum of tenant ceilings | unbounded platform spend |
| `CRON_SECRET` | bearer for cron routes | cron routes must 401 |
| `DALA_ENV` | `production` \| `staging` \| `preview` | the send-guard above cannot fire |
| `SENTRY_DSN` | optional | errors only in Vercel logs |

**Explicitly NOT environment variables — these are per-tenant DATA:**

| Value | Where it lives | The ancestor's version of the mistake |
|---|---|---|
| Page access token, IG token | `tenant_secrets`, envelope-encrypted, AAD = `tenant_id‖kind` | `process.env.PAGE_ACCESS_TOKEN`, read *inside* the client with a silent `||` fallback (verified: `Matrix-Chatbot/lib/messengerClient.js:67-69`). In a multi-tenant build that fallback sends tenant B's message on tenant A's token. **The token must be a required argument; missing → refuse.** |
| FB Page ID, IG account ID | `tenant_channels.external_id` | `process.env.FACEBOOK_PAGE_ID`, used only as a self-echo guard (verified: `Matrix-Chatbot/api/messenger.js:165,173`) |
| Holiday closures | `tenant_closures` rows, **no default** | `SALON_CLOSURE_*` env vars **plus a closure shipped in code** that applies to any deployment failing to override it (verified: `Matrix-Chatbot/config/closures.js:40-52`) |
| Salon timezone | `tenants.timezone` | `const SALON_UTC_OFFSET_MINUTES = 8 * 60` (verified: `Matrix-Chatbot/config/closures.js:32`) |
| Escalation phone, booking URL, deposit rules, prices, staff, FAQs, hours, never-quote topics, canned lines, prompt blocks, examples | tenant config tables (§8.1.7) | `HUMAN_PHONE`, `CLOSING_LINE`, `HANDOFF_REPLY`, `FALLBACK_REPLY`, `CHILDREN_REPLY`, `BOOKING_LINE` as module constants (verified: `Matrix-Chatbot/lib/salonBrain.js:41,52,57-59,63-65,70-72,79-81`) |
| Currency, symbol position, thousands separator, range joiner | `tenants` columns | `₮` appended unconditionally (verified: `Matrix-Chatbot/lib/systemPromptBuilder.js:29`); `toLocaleString()` at `:20,:109` |
| Widget allowed origins | `tenants.allowed_origins[]` | `ALLOWED_ORIGINS` (verified: `Matrix-Chatbot/lib/cors.js:10`) |
| Conversation-preview log destination | per-tenant, opt-in, or not at all | `LOG_WEBHOOK_URL` — one global destination receiving a 180-char preview of every customer message and reply, with a bare `catch {}` (verified: `Matrix-Chatbot/lib/logger.js:12-19`) |
| Model tier | `tenants.plan` → model, so a plan change is a row | `const ANTHROPIC_MODEL = 'claude-sonnet-5'` (verified: `Matrix-Chatbot/lib/salonBrain.js:19`) |

### 8.1.5 The admin dashboard's place

Route group `(admin)`, same deployment, gated by an `is_founder` boolean claim minted by the Supabase custom access-token hook (a boolean whose staleness window is harmless, unlike `tenant_id`). Four surfaces:

1. **Onboarding** — the checklist of §8.2 rendered with an `onboarding_steps` row per step (`step_key`, `tenant_id`, `status`, `evidence` text, `verified_at`, `verified_by`, `incumbent_ok_at`). A step cannot be marked done without pasting evidence. This is the mechanical enforcement of "never mark work done without running it".
2. **Tenant config editor** — writes validated at write time against the one schema that exists, versioned (`config_version` increments), audited (`audit_log`). Every write invalidates the prompt cache key `(tenant_id, config_version)`.
3. **Spend + health** — ledger by tenant, `X-App-Usage`/`X-Page-Usage` high-water marks, `last_webhook_at`, `token_status`, alert history with `delivery_status`.
4. **Quality queue** — proposed KB updates, founder-approve-only, never auto-applied. Admin-only, never client-facing.

**The founder's day-to-day identity in the dashboard is NOT `service_role`.** It is a `founder` role with a permissive `using (true)` SELECT policy and no write grants. Reviewing conversations is inherently cross-tenant, which makes `service_role` tempting — and using it removes the last place RLS could catch a scoping bug in your own tooling. One extra policy buys back that check.

### 8.1.6 CI checks from day one

Each maps to a failure that has already happened in one of the two sibling repos.

| # | Check | What it catches | Provenance |
|---|---|---|---|
| 1 | `next lint` | — | sibling parity |
| 2 | `tsc --noEmit` | config-schema drift | `types/clientConfig.ts` was decorative and diverged (verified: `Matrix-Chatbot/types/clientConfig.ts:37-47`) |
| 3 | `check-supabase-nostore.mjs` | a Supabase client not sending `cache: 'no-store'`, **and** a vacuous assertion | ported from the sibling |
| 4 | `check-tenant-scoping.mjs` | any raw `.from('<tenant-scoped table>')` outside `src/lib/tenant/db.ts`; any `getAdminClient()` outside a 3-file allowlist; any `process.env.*TOKEN*` read inside `src/lib/meta/` | `Matrix-Chatbot/lib/messengerClient.js:67-69` — the fallback credential. Makes the unscoped query *unwriteable*, not merely discouraged. |
| 5 | `check-text-safety.mjs` | `\b`, `\B`, `\w`, `\W` in any regex literal under `src/`; any regex literal with a non-ASCII character and no `u` flag; `.length` on a variable named `*text`/`*message`/`*body` without `Array.from` | `GREETING_REGEX = /^(сайн|байна|уу|hi|hello|hey)/i` classifies `Уучлаарай асуумаар байна` as `'greeting'` (verified by running the module; source `Matrix-Chatbot/lib/salonIntents.js:26`). JS `\b` is defined in terms of `\w` and no flag fixes it. |
| 6 | `check-prompt-blocks.mjs` | **any Cyrillic string literal under `src/lib/prompt/`** | §8.1.7. This is the check that keeps the prompt as data. |
| 7 | `check-matchers.mjs` | matcher rows that are unsafe (see the note below) | `хаяг` matching anywhere turns `Facebook хаяг байна уу` into a Maps card (verified by running the module) |
| 8 | `node --test tests/mn.*.test.js` — the **Cyrillic suite** | NFC/NFD equivalence; `'Үс засалт'` is 9 chars / 17 bytes; `Уучлаарай…` is not a greeting; `Facebook хаяг байна уу` is not a location; `ө`/`ү` in every vowel class; grapheme-safe truncation of an emoji | `'Байна уу'.normalize('NFD')` → no match (verified). Vowel class `/^[^аеёиоуыэюя\s]{20,}$/i` is missing `ө` and `ү` (verified: `Matrix-Chatbot/lib/validator.js:201`). |
| 9 | clock-injection rule: **ban `new Date()` outside `src/lib/clock.ts`** | time-bombed tests | `npm test` in the ancestor is **16 pass, 2 fail today** (verified by running it). Both failures assert the shipped default Naadam closure (2026-07-11..17) is active; they read the real clock and have been red for six weeks with nobody noticing. |
| 10 | `check-env-example.mjs` | every `process.env.X` in `src/` present in `.env.example` | the sibling shipped with 10 env vars used in code and absent from its example file — a fresh clone could not boot |
| 11 | `verify:catalog -- --project staging` (any PR touching `supabase/`) | V1–V9 + collation assertion, **printing every row**, non-zero exit on any violation | `20260817` was applied to one of four tables and the gap was invisible for weeks |
| 12 | `gitleaks` | committed credential | — |

**On check 7, and a place where I think the config-not-code critique's fix is the wrong shape.** The critique is right that moving matchers into rows moves them out of reach of check 5 — the guard and the data went in opposite directions. But its proposed remedy, "run `check-text-safety`'s assertions over the rows", does not fit the design it itself recommends: once matchers are a closed vocabulary of typed kinds there are no regexes in rows for a regex-shaped guard to inspect. The right row-level check is a different one, and `check-matchers.mjs` implements it: reject a token shorter than 4 characters; reject a token that is a proper prefix of any `services.canonical_name` or `staff.name` for that tenant; and require a **dry run against the last 500 stored messages for that tenant** showing exactly which turns would newly match, displayed to the founder before save. That is what catches `засвар` swallowing a garage's whole vocabulary; a regex linter never would.

### 8.1.7 The prompt is data too — the largest correction to the draft

The draft moved the *knowledge* into rows and left the *prompt* in code. Measured in the ancestor, that leaves roughly half the prompt behind. The base prompt is 7,824 characters, of which the row-backed parts (40 price lines, 9 staff lines, 4 FAQs, contact block) are about half. The other half is Matrix business policy written as Mongolian prose inside one template literal:

- `systemPromptBuilder.js:130` — the price-range rule, *naming ₮ inside the instruction*
- `:141-149` — the entire deposit table (20,000₮ master, 10,000₮ 1st-degree, 20,000₮ manicure, 10,000₮ pedicure-only) — verified
- `:153, :158, :165` — worked example dialogues naming **Оюунсүрэн** and **Г. Мөнхзаяа**, quoting 20,000₮, and ending on the website's *"Цаг захиалах" button* — verified
- `:179` — answering rule 2: write prices with a thousands separator and the **₮** sign — verified
- plus `salonBrain.js:86-106`, a further 3,163 characters of channel addendum, roughly half of which exists only to *cancel* the website rules above

If that stays in `prompt/build.ts`, GS Auto Center's rendered prompt contains "ask whether the customer is male or female", the Сор/CICA disambiguation, a haircut deposit table and three haircut examples — and the founder writes `if (vertical === 'salon')`. That is the branch the hard test forbids.

**Four more tables, and one CI check.**

```sql
create table prompt_blocks (
  tenant_id   uuid references tenants(id),        -- NULL = platform block, inherited by all
  scope       text not null check (scope in ('platform','tenant')),
  block_key   text not null,                      -- 'language_rules','channel_messenger','pricing_rules',…
  channel     text check (channel in ('messenger','instagram','web')),  -- null = all channels
  sort        int  not null,
  body        text not null,
  reviewed_by text, reviewed_at timestamptz,
  check ((scope = 'platform') = (tenant_id is null))
);

create table prompt_examples (
  tenant_id uuid not null references tenants(id),
  sort int not null,
  user_turn text not null,
  assistant_turn text not null,        -- prices as {{price:Эмэгтэй тайралт (Мастер)}} placeholders
  reviewed_by text, reviewed_at timestamptz
);

create table deposit_rules (
  tenant_id uuid not null references tenants(id),
  applies_to_kind text not null check (applies_to_kind in ('staff_group','service_category')),
  applies_to_key  text not null,
  amount_min numeric not null, currency text not null,
  primary key (tenant_id, applies_to_kind, applies_to_key),
  foreign key (tenant_id, applies_to_kind, applies_to_key)
    references config_keys (tenant_id, kind, key)   -- see below
);

create table config_keys (                -- the single referent for group/category keys
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('staff_group','service_category')),
  key  text not null,
  label text not null, sort int not null,
  primary key (tenant_id, kind, key)
);
```

`staff` then carries `foreign key (tenant_id, group_key) references config_keys (tenant_id, 'staff_group', key)` — expressed as a generated `kind` column so the composite FK is legal. This closes the bug the config-not-code critique found: renaming a staff group through the admin form currently silently orphans staff rows, reproducing `systemPromptBuilder.js:69-84`'s no-`else` silent-omission in data instead of code, and step 25's runtime "fail loudly" only fires *after* go-live, when a customer asks. With the FK, a rename either cascades or is refused at write time.

**The `scope` column matters and neither critique mentions it.** Channel behaviour and language-quality rules are *platform* policy, not tenant policy — every tenant should inherit one copy, so a prompt fix is one row edit rather than N. Only pricing/clarification/deposit/example blocks are tenant-scoped. Without this split, the addendum's 3,163 characters get copied per tenant and drift.

**Currency and number formatting become columns, and the instruction line is generated:** `tenants(currency_code, currency_symbol, symbol_position check in ('prefix','suffix'), thousands_sep, range_joiner)`. The prompt's own formatting instruction is rendered from those five values, never written. Otherwise the first non-₮ tenant gets rows saying `1,200 USD` two paragraphs below an instruction saying to write prices with ₮, and the model invents a resolution — the same class as the escalation phone existing twice in two formats (step 28), except unreachable from the admin form.

**Prices inside examples are interpolated, never duplicated.** The ancestor already does this correctly via `priceOf` (verified: `Matrix-Chatbot/lib/systemPromptBuilder.js:106-112`) — carry it; it is the one place the template refuses to state a fact twice.

**The check that makes it stick:** `check-prompt-blocks.mjs` fails the build on any Cyrillic string literal under `src/lib/prompt/`. Greppable, unambiguous, and it fails the day someone reaches for the shortcut.

---

## 8.2 Onboarding checklist — Tenant #1, Matrix Eco Salon

**Actors:** **F** = founder (Dalatech) · **S** = salon owner (Matrix Eco Salon) · **A** = automated.

**The structural correction that governs the whole checklist.** The draft pointed the production callback URL at Dala AI in Phase D and then ran shadow, acceptance and cutover planning — a stretch of days to weeks. Because an app has **one callback URL per object**, that change stops the incumbent receiving events instantly and completely. Matrix Eco Salon's Messenger would have answered nobody for the entire interval, with no alarm: `webhook_silence` watches for the *absence* of webhooks, and webhooks would be arriving fine. The ops-reality critique is right, and this is the single most consequential fix in this revision.

**The replacement is a mirror in the incumbent, running old → new.** The old bot stays subscribed and stays primary. It forwards a copy of each verified request to Dala AI. Consequences:

- Dala AI is exercised on **live customer traffic** for as long as you like, at zero risk, because it is not on the delivery path.
- A Dala AI outage costs the salon **nothing**.
- Meta's retries and QStash's three retries (`Matrix-Chatbot/lib/messengerQueue.js:13`) still protect the customer's message, because the incumbent still owns the ACK.
- The production callback-URL change becomes a **single action inside the cutover step**, and rolling it back restores exactly the pre-cutover state — mirror included.

The draft's proxy ran new → old and, as the critique observes, that direction spends Meta's only retry lever on a 200 and then forwards fire-and-forget at most once. A cold lambda on the old project easily exceeds a 3 s timeout, and the message is then gone: Meta will not resend, QStash never saw it, and the old bot logs nothing because nothing arrived. That is a working production bot made strictly less reliable, with a missing-reply failure signature the founder would read as quiet traffic.

**One part of that critique I do not adopt.** It offers, as a fallback if new → old is forced, "forward before the ACK and return non-200 to Meta on a hard forward failure". Do not do this. Returning non-200 to Meta because a *secondary* forward failed puts the Page's subscription at risk — Meta disables a subscription after roughly an hour of failing deliveries — for a reason that has nothing to do with the bot that is actually serving customers. Trading a possible dropped message for a possible total, silent, per-asset outage is the wrong trade. Mirror old → new, or do not mirror.

Steps run in order within a phase. Phases A and B run **in parallel from day one**, because App Review is a ~20-day pole and platform work is not.

---

### Phase A — The platform stands up (no tenant exists yet)

#### 1. Repo, CI, and a green pipeline on an empty app — F
- **Do:** create `dala-ai` from §8.1.2 with a health route and nothing else. Wire all twelve CI checks. Make checks 4, 5, 6 and 7 fail deliberately once each (a `\b` regex, a raw `.from('conversations')`, a Cyrillic literal in `prompt/build.ts`, a 3-character matcher token), confirm CI goes red, then remove them.
- **Verify:** four red CI runs in the history, each showing the specific guard that fired. A guard that has never failed is a guard you cannot distinguish from a no-op — the same reasoning that makes `check-supabase-nostore.mjs` assert both directions.

#### 2. Supabase projects (production + staging) — F
- **Verify, on each project independently:**
  ```sql
  select datname, datcollate, datctype, pg_encoding_to_char(encoding), version()
  from pg_database where datname = current_database();
  ```
  Assert encoding `UTF8` and `datcollate` **not** `C` and **not** `POSIX`. `datcollate` cannot be changed after database creation, so this is the one check whose failure is unfixable in place. Paste output into `docs/onboarding/platform.md`.

#### 3. Schema + RLS migrations — F, then A
- **Do:** apply the full set to **staging first**, through the same path you will use in production (the dashboard SQL editor — assume it, because that is what happens, and it is what freezes the ledger).
- **Produces:** `tenants`, `tenant_members`, `tenant_channels`, `tenant_secrets`, `tenant_config_versions`, `config_keys`, `services`, `service_prices`, `staff`, `faqs`, `business_hours`, `tenant_closures`, `canned_responses`, `refusal_topics`, `clarify_before_quoting`, `disambiguation_pairs`, `deposit_rules`, `booking_handoff`, `contact_points`, `prompt_blocks`, `prompt_examples`, `conversations`, `messages`, `webhook_events`, `private_reply_sent`, `spend_ledger`, `usage_counters`, `tenant_budgets`, `analytics_reports`, `kb_change_proposals`, `alerts`, `audit_log`, `onboarding_steps`.
- **Verify:** `npm run verify:catalog -- --project staging`. **V2 must return zero rows.** Read every row of V1–V9; do not spot-check. Paste into the PR.
- **If it fails:** the failure will be partial. One of thirty-odd tables. That is the shape.

#### 4. Supabase keys and JWT signing — F
- **Do:** start on the **new key model** (`sb_publishable_…` / `sb_secret_…`), minting a **separately named secret key per component** (`webhook-ingest`, `worker`, `analytics`, `admin`). Do the JWT signing-keys migration now, at project creation, when there is nothing to break.
- **Verify:** revoke the `analytics` key on staging, confirm the analytics path 401s and the webhook path still works, re-mint. A blast-radius property you have not tested is a hope.

#### 5. Platform env vars — F
- **Verify:** `check-env-example.mjs` green; a founder-authed `/api/admin/health` reports **present/absent only, never a value**. Absent `TENANT_KEK_V1` must make the deployment refuse to serve, not degrade.

#### 6. Deploy; prove the ACK path and the middleware exclusion — F
- **Verify (four separate assertions):**
  1. `GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=<wrong>&hub.challenge=x` → **403**; right token → **200** with the literal challenge as `text/plain`. (The ancestor compares with `===` at `Matrix-Chatbot/api/messenger.js:65`; use `timingSafeEqual`, it is free.)
  2. `POST` with no signature → **401**. Signature under a wrong secret → **401**. `META_APP_SECRETS` unset → **401**, never "skip".
  3. `GET /api/webhooks/meta` returns the handshake, **not** a dashboard redirect — proving the matcher exclusion.
  4. Deploy a temporary route that sleeps 20 s and call it; record the actual platform timeout. This settles the ancestor's unresolved 25 s vs 12 s vs plan-default question (**ASSUMED unknown** until measured).

#### 7. Staging tenant-zero: the whole pipeline against a Page nobody's customers use — F
- **Do:** create a Dev-mode Meta app; a founder-owned Facebook Page and a linked Instagram professional account; run the *entire* rest of this checklist (steps 18–40, including a rehearsed mirror and a rehearsed flip) against them in staging.
- **Verify:** the acceptance matrix of step 36 passes on staging before any Matrix asset is touched, and the flip-and-rollback of step 40 is rehearsed and timed.
- **Why this step exists:** every ASSUMED item in this section — multi-app subscription behaviour, the exact IG subscription call, whether a System-User-derived Page token inherits never-expiry, whether `entry[].messaging` holds at most one element — is answerable here in one afternoon, for free, and is expensive to discover on a customer's Page.

#### 8. Telegram alerting, proven by a real alert **and a real failure** — F
- **Do:** `src/lib/alerts/telegram.ts` must **parse the response body for `"ok": true`**, record `message_id` on success, and write `alerts.delivery_status = 'failed'` plus a `console.error` on failure.
- **Verify:** trip a real alert on staging (a signed payload with an unknown `entry[].id`); confirm it lands on the founder's phone. Then **break the bot token deliberately** and confirm the failure is recorded and visible in the dashboard.
- **Why the negative test:** Brevo returned 2xx for a send from an unauthenticated domain and silently dropped it; the code treated any 2xx as success and a registration produced no warning, no error and no email. **An alerting path that fails silently is worse than no alerting path, because it is believed.**

#### 9. Freeze the defaults — F
- **Do:** `PLATFORM_MONTHLY_CEILING_USD` set. Default per-tenant `monthly_ceiling_usd` for a new tenant is a **small explicit number, never null**; a null ceiling must refuse, not mean unlimited.
- **Verify:** insert a tenant with no budget row; the first cost-bearing call returns **503 `tenant_not_provisioned`**, not a reply.
- **Provenance:** `BANK_BUILD_BUDGET_USD = 0` next door is zero precisely because zero is the only value that refuses without depending on a read. The safe default is the one that does not need a lookup to be safe.

---

### Phase B — Meta: business, app, permissions, App Review (starts day 1, in parallel)

**Standing pass criterion for steps 13, 14, 15, 20 and 22.** Every one of these touches the Page, the app install or the token that the **live incumbent is currently serving customers on**. Each step's final action is therefore: *send one Messenger message to the Page from a phone and confirm the OLD bot replies.* Ten seconds. Record `incumbent_ok_at` on the `onboarding_steps` row. Without it, an asset reassignment that perturbs the incumbent's token or `subscribed_apps` state goes unnoticed for days while attention is on Dala AI's logs, and the rollback target — the thing the whole plan depends on — is quietly the broken thing, with no known-good boundary to return to.

#### 10. Business Portfolio and Business Verification — F
- **Do:** submit Business Verification with legal registration documents that **match the Business Manager details precisely**.
- **Verify:** status reads *Verified*. Advanced Access is gated on it.
- **Timeline risk:** this is the critical path for a Mongolian entity and the one step whose duration Dalatech does not control. Start day 1 regardless of code progress.

#### 11. App strategy decision — F, **recorded in writing**
- **(A) Reuse the Meta app Matrix-Chatbot already runs on**, renamed. It already carries whatever access makes the current production bot work for real customers, so tenant #1 needs no new review; the existing Page token stays valid; and the cutover is one field edit with a 30-second rollback. (Whether renaming triggers re-review is **ASSUMED unknown** — check in Business Settings before committing.)
- **(B) A new "Dala AI" app.** Clean branding, but needs its own Advanced Access before it can message the public, and the mirror requires the old app's secret to be added to `META_APP_SECRETS` (which the set already supports).
- **Recommendation: (A).** It removes App Review from tenant #1's critical path entirely and makes the cutover a single reversible edit.
- **Verify:** write the decision and its reason into `docs/onboarding/matrix.md` and the commit message, the way `BANK_BUILD_BUDGET_USD = 0` records a decision rather than an accident.

#### 12. Permissions and App Review — F
- **Do:** request Advanced Access on `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `business_management`, `instagram_basic`, `instagram_manage_messages` — and, **only if comment handling is in v1**, `pages_manage_engagement` and `instagram_manage_comments`. Submit with the screencast (message sent to the Page, received, replied to inside 24 h). The ancestor's setup doc already names the FB-only subset and the review boundary (verified: `Matrix-Chatbot/MESSENGER_SETUP.md:73-75`).
- **Verify:** on approval, confirm **from the API, not the dashboard**: `GET /me/permissions` with the System User token lists each permission `status: granted`. A dashboard badge is a UI; the token's actual scopes are what will or will not work at 2 a.m.
- **The boundary:** review is required for Advanced Access, not for messaging your *own* Page. Matrix-Chatbot sat on the permissive side of that line. **Dala AI does not**, because the Pages are its clients'.

#### 13. Salon grants access to its Page — S, with F on a call
- **Do (Shape A, recommended):** *Business Settings → Users → Partners → Add → Give a partner access to your assets*, granting Dalatech's Business Portfolio **Full control** of the Page (partial access limits actions once a third-party tool is connected). Only a Page admin can do this.
- **Do (Shape B, fallback):** the owner completes a Facebook Login for Business flow on a Dala AI onboarding page.
- **Verify:** `GET /{business-id}/client_pages` (and `/owned_pages`) returns the Page. **Not `GET /me/accounts`** — see step 15. **Then the incumbent-health check.**
- **Practical note:** a salon's Page was often set up by a relative, and the person with admin rights may not be the person you are talking to. Budget a second appointment; this is the single most common place a Mongolian SMB onboarding stalls.

#### 14. Assign assets to the System User; install the app — F
- **Do:** create (or reuse) a System User in Dalatech's portfolio, assign the Page **and** the linked Instagram account as assets, install the app, generate a token with step 12's scopes and expiry **Never**.
- **Verify:** `GET /debug_token?input_token=<system user token>` shows the expected app ID, scopes, `expires_at: 0`. **Then the incumbent-health check.**
- **Why not a personal token:** a Page token derived from a long-lived *User* token dies when that user changes their password, loses the Page role, or revokes the app. A System User survives staff turnover on both sides.

#### 15. Mint the Page access token — F. **Do not use `/me/accounts`.**
- **Do:** `GET /{page-id}?fields=name,access_token` with the System User token.
- **The trap, stated plainly:** `GET /me/accounts` returning an **empty array** for a Page owned by a Business Portfolio is a widely reported, reproducible condition. It enumerates Pages via the person's *personal profile* role; a Page reached through a business role is simply not on that list. It returns an empty, plausible, permission-filtered answer **instead of an error** — the same failure shape as `information_schema.role_table_grants` and `supabase_migrations.schema_migrations`. Use it at most as an onboarding-UI convenience; **never treat empty as "no pages"**.
- **Verify:** `GET /{page-id}?fields=id,name` **with the newly minted Page token** returns the salon's Page with the expected name. A token that cannot read its own Page will not send on it. **Then the incumbent-health check.**
- **(ASSUMED unknown):** whether a System-User-derived Page token inherits never-expiry. Resolve with `debug_token` on the *Page* token, not the System User token, and record the answer — it determines whether a refresh path is needed at all.

#### 16. Instagram — capture the professional account and its link — F
- **Verify:** `GET /{page-id}?fields=instagram_business_account{id,username}` returns the salon's handle. Record **both** the IG account ID (the `17841…`-shaped value) and `linked_page_id`; routing needs the first, subscription and token path need the second.

#### 17. Record the granted scope set as data — F
- **Do:** write `tenant_channels.granted_scopes[]` from `GET /me/permissions`, and `auth_flavour = 'facebook_login'`.
- **Why it is data:** the Instagram-Login flavour uses a different scope vocabulary (`instagram_business_basic`, `instagram_business_manage_messages`, …) for the same capability. Two vocabularies for one capability becomes a per-tenant code branch if you let it; keyed on `auth_flavour`, it is a lookup table.
- **But `'instagram_login'` is not in the `check` constraint at launch.** The config-not-code critique is right that an enum value no step ever executes is not config — the send client's host, path and token column all differ under it (`graph.instagram.com` vs `graph.facebook.com`, IG User token vs Page token), and the IG-Login subscription call is itself **(ASSUMED)**. Ship the constraint as `check (auth_flavour in ('facebook_login'))` with a comment naming the reason, and widen it only after step 7 has rehearsed the flavour end to end. A constraint that refuses is honest; an enum value that has never executed is a promise the schema cannot keep. Whether to fund that rehearsal is §8.9 Q5.

---

### Phase C — Tenant record, channel identities, secrets

#### 18. Create the `tenants` row — F
- **Do:** `tenants(id, slug='matrix-eco-salon', display_name='Matrix Eco Salon', timezone='Asia/Ulaanbaatar', locale='mn-MN', currency_code='MNT', currency_symbol='₮', symbol_position='suffix', thousands_sep=',', range_joiner=' – ', plan, status='onboarding')`.
- **Name check:** canonical name is **`Matrix Eco Salon`** (verified: `Matrix-Chatbot/config/currentClient.js:7`). The shipped frontend still says "Matrix Hair Salon" and "Яармаг салбар" — a stale brand. Confirm the current name with the owner.
- **`timezone` and `business_hours` must be set here, before step 33 enables the silence-watchdog.** The watchdog fires "in-hours only"; a tenant with no hours rows either alerts continuously or never, and both look like the watchdog working. (The ops-reality critique caught this and it is a real gap.)
- **Verify:** read the row back with the `founder` role, not `service_role`.

#### 19. Insert `tenant_channels` rows — F
```sql
create table tenant_channels (
  provider        text not null check (provider in ('facebook_page','instagram')),
  external_id     text not null,           -- FB Page ID, or IG professional account ID
  tenant_id       uuid not null references tenants(id),
  auth_flavour    text not null check (auth_flavour in ('facebook_login')),  -- see step 17
  linked_page_id  text,                    -- IG rows: the Page the IG account is reached through
  meta_app_id     text not null,
  mode            text not null default 'off'
                    check (mode in ('off','shadow_routing','shadow','live')),
  subscribed_fields text[] not null default '{}',
  graph_version_override text,
  token_status    text not null default 'unprovisioned',
  last_webhook_at timestamptz,
  last_send_ok_at timestamptz,
  primary key (provider, external_id)      -- one identity -> exactly ONE tenant
);
```
- **The four modes:** `off` = ingest refused. `shadow_routing` = ingest, resolve tenant, persist, **no model call, no send** (free). `shadow` = generate and store, do not send (costs money). `live` = generate and send.
- **Do:** two rows, both `mode='off'`.
- **Verify:** the primary key is the guarantee, so test it — attempt to insert the same `(provider, external_id)` against a second tenant and confirm the insert **fails**. An identity that could map to two tenants is the whole ballgame.
- **Never** auto-create a tenant from a webhook. An unknown `entry[].id` has one destination: drop, count, alert.

#### 20. Store the tokens, encrypted — F
- **Do:** envelope-encrypt into `tenant_secrets(tenant_id, kind, ciphertext, wrapped_dek, kek_version, status, last_ok_at, last_error)`. AES-256-GCM, per-row DEK wrapped by `TENANT_KEK_V1`, **AAD = `tenant_id ‖ kind`**. `revoke all on tenant_secrets from anon, authenticated;` — no policy *and* no privilege.
- **Verify (three assertions, then the incumbent-health check):**
  1. `select * from tenant_secrets` as `authenticated` → **permission denied**, not an empty result. (Empty is what a missing policy looks like; denied is what a missing grant looks like. You want the second.)
  2. Decrypt-and-re-encrypt round-trips, in a script printing only a SHA-256 prefix of the plaintext.
  3. Copy `ciphertext` from a staging tenant's row into another tenant's row; decryption **throws** on the auth tag. That is the AAD doing its job.
- **Never:** log a decrypted token or `wrapped_dek`; put a token in a URL; cache a token at module scope. Vercel reuses warm lambdas across tenants; a module-level `let token` is a cross-tenant leak with a 15-minute half-life. (The ancestor gets the header-not-query-string part right — verified: `Matrix-Chatbot/lib/messengerClient.js:79` — carry it verbatim.)

#### 21. Prove a send works, before any customer is involved — F
- **Do:** with `mode='off'`, call founder-only `POST /api/admin/probe/send` with `{tenant_id, provider, recipient_psid: <founder's own PSID>, text: 'Dala AI probe <uuid>'}`. The client resolves the token from `tenant_secrets` and posts to **`POST /{page-id}/messages`** — never `/me/messages`.
- **Verify:** the message arrives; `last_send_ok_at` is set. Then the **negative** test: point the row at the wrong tenant's token and confirm the send **fails**.
- **This is the single most dangerous line in the ancestor for a multi-tenant port** (verified: `Matrix-Chatbot/lib/messengerClient.js:10` — `SEND_URL = …/v25.0/me/messages`). With `/me`, a token/tenant mismatch **succeeds** and posts as the wrong salon. There is no error to catch. Addressing the send to the explicit Page ID converts a silent cross-tenant post into a 4xx.

---

### Phase D — The mirror: live traffic, zero risk, no subscription change

#### 22. Deploy the mirror **in the incumbent** — F
- **Do:** one addition to `Matrix-Chatbot/api/messenger.js`, immediately after the signature check at line 86 and before `extractActionableEvents` at line 103 (both verified). It forwards `rawBody` and the `x-hub-signature-256` header to `https://<prod>/api/webhooks/meta`:
  - **fire-and-forget, not awaited, 2 s timeout, no retry** — a Dala AI outage must be invisible to the salon;
  - gated on an Upstash flag with a 15 s in-process TTL, **not** an env var, so it can be turned off with a Redis `SET` in under a second rather than a 60–90 s redeploy;
  - one extra Redis GET on a path that already reads Redis.
- Dala AI verifies the forwarded signature through its normal path — same app secret under plan A; under plan B, add the old app's secret to `META_APP_SECRETS` (which is a set for exactly this reason). `webhook_events.source` records `'mirror'` vs `'meta'`.
- **Verify:** deploy with the flag **off**; confirm the incumbent still replies normally. Then flip the flag on and confirm it still replies normally. **The incumbent's behaviour must be indistinguishable with the mirror on and off** — that is the whole point.

#### 23. Routing-only shadow: prove tenant resolution on real traffic, for free — F
- **Do:** set both `tenant_channels` rows to `mode='shadow_routing'`. Leave it running for the whole of Phases E–G — days, at zero Anthropic cost.
- **Verify — this is the load-bearing check of the phase:**
  1. `webhook_events` rows exist with `object='page'`, the raw `entry[].id`, and a resolved `tenant_id`.
  2. **`entry[].id` equals the `external_id` stored in step 19.** Log `webhook.entry_id_match` on equality, `webhook.entry_id_mismatch` on inequality.
  3. Same on Instagram once the salon's IG receives a DM: assert `entry[].id` equals the stored IG account ID, and cross-check `messaging[].recipient.id` for inbound and `messaging[].sender.id` for echoes against the same value.
  4. Dedup holds: a mirrored request replayed twice produces one `webhook_events` row.
- **Why this is the verification and not the dashboard:** the salon's Facebook URL in the existing config is `profile.php?id=100067872726164` (verified: `Matrix-Chatbot/config/currentClient.js:110`) — a numeric ID whose provenance is a URL, not the API. **The ground truth for routing is the ID Meta puts in `entry[].id`.** The running deployment is not a source either: `FACEBOOK_PAGE_ID` is documented as optional (verified: `Matrix-Chatbot/MESSENGER_SETUP.md:30`) and may not even be set.
- **A caveat worth respecting:** Chatwoot, a production multi-tenant inbox, does *not* route Instagram by `entry[].id` alone; it resolves from the messaging IDs and keeps two channel tables for the two auth flavours. Treat the match assertion as a **routing invariant you monitor**, not one you assume. If the mismatch counter is ever non-zero, prefer the messaging-derived ID and alert.
- **Iterate the loop:** `body.entry` is an array of distinct event sources and one HTTP request can legitimately carry entries for two different tenants. **Any design resolving "the tenant" once per request is wrong.** The ancestor iterates `body.entry` but never reads `entry.id` (verified: `Matrix-Chatbot/api/messenger.js:164-180`) — tenant routing does not exist there — and `body.object !== 'page'` returns a bare 200 (verified: `:99-101`), so **Instagram events are silently discarded today**. Subscribing the `instagram` object to the ancestor would produce a bot that ACKs perfectly and answers nobody.

---

### Phase E — Tenant configuration (the knowledge base becomes data)

The source is `Matrix-Chatbot/config/currentClient.js`. Measured in this checkout: **40 price rows** (17 ranges, 23 scalars), **9 team members** in 3 groups, **4 FAQs**. The rendered base prompt is **7,824 characters / 12,866 bytes** — note the code comment calling it "~12.8k characters" (verified: `Matrix-Chatbot/lib/salonBrain.js:23`) is confusing bytes for characters.

#### 24. Services and prices, as values not display strings — F, confirmed by S
- **Do:** migrate 40 rows into `services(tenant_id, id, canonical_name, category, sort)` + `service_prices(tenant_id, service_id, price_min, price_max, unit, confirmed_at, confirmed_by)`. The 17 ranges are **en-dash-separated strings** and must be parsed into `price_min`/`price_max`. Currency and formatting come from the `tenants` columns (§8.1.7), never from the renderer.
- **Verify:** re-render every row into the ancestor's display form and **diff against the original 40 strings**. Any row that does not round-trip byte-for-byte is **quarantined for manual entry, never guessed**.
- **`confirmed_at IS NULL` is a degradation, not a blocker.** The ops-reality critique is right that gating go-live on the owner confirming 40 prices hands the launch date to a salon owner's admin time. So an unconfirmed price routes that service through the existing `refusal_topics` behaviour — do not quote, give the escalation phone. The machinery already exists for children's haircuts and costs nothing extra.
- **With one floor the critique does not set.** A bot that says "call us" on 28 of 40 services is technically passing and commercially useless, and the salon will judge it accordingly. Go-live therefore requires: the escalation phone, the booking link, the never-quote list, **and the top 15 services by shadow-observed demand confirmed** (Phase D's routing-only shadow gives you that ranking for free, before you ask). The rest converge live.
- **Precedent to preserve:** `formatPriceList` returns "no pricing information available" rather than rendering an unrecognised shape, with the comment *"refuse to render prices rather than risk serving a category (e.g. children's) the official list doesn't carry"* (verified: `Matrix-Chatbot/lib/systemPromptBuilder.js:36-38`). Keep that instinct; make it louder — a malformed row must fail the render and alert, not silently omit a service.

#### 25. Staff, staff groups, and deposit rules — F, confirmed by S
- **Do:** `config_keys` rows for the three groups (`Эмэгтэй үсчид`, `Эрэгтэй үсчид`, `Маникюр баг` — verified: `Matrix-Chatbot/lib/systemPromptBuilder.js:74,78,82`), `staff` rows with a **composite FK** to them, and `deposit_rules` rows for the four amounts (20,000 master, 10,000 1st-degree, 20,000 manicure, 10,000 pedicure-only — verified: `:141-149`). GS Auto Center will declare `Мотор`, `Явах анги`, `Цахилгаан`. **No code changes between them.**
- **The bug being fixed:** the ancestor's team renderer is three hardcoded buckets keyed on `gender: 'female'|'male'|'manicure'` with no `else` (verified: `:69-84`), so **a member with any other value silently vanishes from the prompt**. The FK makes a group rename impossible-or-cascading at write time; the renderer additionally fails loudly on an unknown group rather than omitting.
- **Verify:** render the prompt and count staff lines; assert it equals `select count(*) from staff where tenant_id = …`. A count check catches the silent-omission class a visual read does not. Then rename a group in staging and confirm the write is refused or cascades — never orphans.

#### 26. FAQs, hours, closures — F, confirmed by S
- **Do:** FAQs into `faqs(tenant_id, question, answer, sort)` with **presentation stripped**. Current answers carry raw HTML (`<br><br><a href=…>` — verified: `Matrix-Chatbot/config/currentClient.js:91`) which the website renders and the Messenger path strips back out. Store the fact and the URL; a per-channel renderer decides markup.
  Hours into `business_hours` rows **and** keep the human-reviewed sentence: `Даваа-Бямба: 10:00-20:00, Ням: 11:00-19:00` (verified: `:95`).
  Closures into `tenant_closures(tenant_id, start_date, end_date, title, verbatim_message)` — **no default row.** The ancestor ships a default Naadam closure in code applying to any deployment that fails to override it (verified: `Matrix-Chatbot/config/closures.js:40-52`).
- **Verify:** S confirms hours by reading them back on the phone. Then assert the three properties the ancestor got right and that must survive: the closure message is quoted **verbatim, never model-composed** (Mongolian date suffixes are not safely generated — `config/closures.js:22-26`); the window is evaluated **per request** against the tenant's own timezone, not cached with the prompt (`lib/salonBrain.js:139-155`); a malformed row is **ignored with an alert**, not announced (`config/closures.js:113-121`).

#### 27. Booking hand-off — F, confirmed by S
- **Do:** `booking_handoff(tenant_id, mode check in ('link','phone','none'), url, verbatim_line, payment_rail)`. Matrix: `mode='link'`, `url='https://www.matrixecosalon.org/'` (verified: `Matrix-Chatbot/config/currentClient.js:112`), `payment_rail='QPay'`.
- **The bug being fixed:** `BOOKING_LINE` hardcodes `QPay-ээр` and the phrase `урьдчилгаа төлбөр` (verified: `Matrix-Chatbot/lib/salonBrain.js:79-81`). GS Auto may use neither. **`mode` must include `'phone'` and `'none'` from day one**, or tenant #3 is a code change.
- **Verify:** open the booking URL and complete a booking as far as the payment step. A link in a config that 404s is a config that has never been checked.

#### 28. Escalation phone — F, **by dialling it**
- **The fact as it exists:** `HUMAN_PHONE = '7741-7777'` (verified: `Matrix-Chatbot/lib/salonBrain.js:41`) and `phone: "+976 7741 7777"` (verified: `config/currentClient.js:107`). **The same fact, twice, in two formats, and both reach the prompt** — the addendum's children's rule uses `7741-7777` (`lib/salonBrain.js:70-72, 98`) while the base prompt interpolates `${contact.phone}` (`lib/systemPromptBuilder.js:135`). The repo's docs mention **three** numbers (`7741-7777, 7741-7771, 7741-7776`).
- **Do:** one row: `contact_points(tenant_id, kind='escalation_phone', dial_form='+97677417777', display_form='7741-7777', verified_at, verified_by)`. Every pinned line interpolates `display_form`. One fact, one row, one format.
- **Verify:** **dial it.** A human at Matrix Eco Salon answers during business hours and confirms this is the number customers should be given. Record `verified_at`. Nothing in the repo is evidence that any of the three is currently correct.

#### 29. Never-quote list, clarification rules, pinned lines, prompt blocks and examples — F, native-reviewed, S signs off

**Tables:**
```sql
create table refusal_topics (
  tenant_id uuid not null references tenants(id),
  topic_key text not null,
  matcher   jsonb not null,          -- CLOSED VOCABULARY, validated at write time
  decision_question  text not null,  -- "is the last message about a child's service or price?"
  verbatim_response  text not null,
  forbidden_openings text[] not null default '{}',   -- platform defaults inherited, tenant may extend
  quote_price boolean not null default false,
  reviewed_by text, reviewed_at timestamptz,
  primary key (tenant_id, topic_key)
);

create table clarify_before_quoting (
  tenant_id uuid not null references tenants(id),
  trigger  jsonb not null,           -- same closed vocabulary
  ask_for  text[] not null,          -- Matrix: ['stylist_tier','gender']; GS Auto: ['vehicle_model','year']
  verbatim_question text not null,
  reviewed_by text, reviewed_at timestamptz
);
```

**Matchers are a closed vocabulary of typed kinds, never a regex.** `{kind:'any_token', tokens:['хүүхэд','хүүхдийн']}` and `{kind:'phrase', text:'…'}` cover both known tenants. **One** engine (`src/lib/match/engine.ts`) NFC-normalises both sides and matches on Unicode token boundaries (`(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])`, `u` flag), so the boundary logic is written once and tested once. This is the direct fix for the two live production bugs re-verified above: `/^(сайн|байна|уу|…)/i` classifying `Уучлаарай асуумаар байна` as a greeting, and `хаяг` matched anywhere turning `Facebook хаяг байна уу` into a Maps card — the latter already carrying a hand-patched `EMAIL_CONTEXT_REGEX` special case (verified: `Matrix-Chatbot/lib/salonIntents.js:22-26`), which is a symptom, not a fix. Row safety is enforced by `check-matchers.mjs` (§8.1.6).

**Hardening the refusal, using the technique that is known to work.** A rule that only *describes* the right answer loses to a model's disposition; a rule that *forbids the specific wrong answer* does not (`dalatech-english/docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md`, "the technique that worked" — Sonnet went 0/3 → 3/3 on exactly this change). But the draft stored the hardened rule as authored Mongolian prose and required a 20-phrasing measurement study **per topic, per tenant**, which is a week's work, not a form field. The config-not-code critique is right that this breaks §8.4's own claim.

**So the structure is a template and the content is columns.** One platform-level `prompt_blocks` template renders every refusal identically: the first-line gate (`decision_question`), the verbatim response, the forbidden-openings list interpolated from the array, and the explicit "if no, continue normally". `forbidden_openings` ships with a **Mongolian platform default set** — `ойролцоогоор`, `орчим`, `болов уу`, `магадгүй` — that every tenant inherits and any tenant may extend. Per-tenant measurement becomes an optional tightening, not a launch gate. Note the ancestor already forbids one specific wrong answer here — «том хүн үү, хүүхэд үү» (verified: `Matrix-Chatbot/lib/salonBrain.js:98`) — so it is a tenant extension, not an invention.

**Pinned lines:** `canned_responses(tenant_id, key, text, reviewed_by, reviewed_at)` for `closing`, `handoff`, `fallback`, `booking`, seeded from `Matrix-Chatbot/lib/salonBrain.js:52,57-59,63-65,79-81`. **Carry the reasoning, not just the strings:** the comments record that live replies contained garbled Mongolian and an invented Russian word (`дополнительн`) in filler and apology positions, so closings and handoffs are reproduced letter for letter rather than composed (verified: `:48-51, :54-56`).

**Prompt blocks and examples:** seed `prompt_blocks` (scope `platform` for channel/language rules, scope `tenant` for pricing/clarification/deposit rules) and `prompt_examples` from `systemPromptBuilder.js:124-186` and `salonBrain.js:86-106`, with prices as `{{price:…}}` placeholders and the button-CTA rules **dropped rather than migrated** — they are website-only, and roughly half the 3,163-character Messenger addendum exists solely to cancel them.

- **Verify:** S reads and signs off every pinned Mongolian sentence in its new context (`reviewed_by`, `reviewed_at` populated). These strings were validated for *that* prompt in *that* surrounding; moving them into rows and rebuilding the prompt around them changes the conditions under which they were reviewed.

#### 30. Render, size, and pin the config version — F
- **Do:** build the prompt from rows. Cache it keyed **`(tenant_id, config_version)`** — never a bare module-scope singleton.
- **The bug being fixed, and it is the highest-severity multi-tenancy defect in the ancestor:** `let cachedBasePrompt = null` at module scope, built once per process from the build-time `clientData` (verified: `Matrix-Chatbot/lib/salonBrain.js:142`). Two tenants on one warm lambda means tenant B is answered with tenant A's prices, staff names and phone number. It is a cross-tenant data leak and it is completely invisible at one tenant. Related: `SALON_NAME` is a module constant stamped into every log line (verified: `:46`, used at `lib/messengerProcess.js:80,88,117`), so every log line carries the *build's* tenant, not the *request's*.
- **Verify (five assertions):**
  1. Character and byte counts logged; compare against the 7,824 / 12,866 baseline.
  2. **Real token count** from one live call's `usage` — the ancestor already logs `cache_read / cache_creation / uncached` per response (verified: `lib/salonBrain.js:249-253`), so one Vercel log line gives the truth rather than an estimate.
  3. Prompt caching is actually reading: a second call within the TTL shows `read > 0, write = 0`. A cache miss is invisible in the reply and quietly bills full price. Keep the breakpoint at the end of the system block so the customer's own history stays **outside** the cached entry (verified: `:210-222`).
  4. **The two-tenant test:** render for Matrix and a staging fake tenant in the same process, alternating, 20 times; every rendered prompt matches its own tenant. This is the test the ancestor could never have written.
  5. **The GS Auto test — do this before Matrix goes live.** Render a full prompt from a synthetic GS Auto config (three mechanic groups, per-hour and per-part units, `booking_handoff.mode='phone'`, a `clarify_before_quoting` row for vehicle model and year, no children's topic). **Every Mongolian sentence that comes out wrong is a row that does not exist yet.** This is the single best test of whether the config is really a config, and it costs an afternoon.

---

### Phase F — Budget and alerts

#### 31. Set the tenant budget and confirm the ordering — F
- **Do:** `tenant_budgets(tenant_id, monthly_ceiling_usd, alert_threshold_pct, on_exhausted, effective_from)`. `on_exhausted` is a founder decision (§8.9 Q3): `'stop'`, `'canned'` (a pinned Mongolian line with the phone), or `'overage'`.
- **The gate is identity → entitlement → budget, in that order, each refusing on error.** In `withTenant()`:
  1. signature valid, else 401;
  2. `(object, entry[].id)` resolves to a tenant with `status='active'` and a mode that permits the work, else 200-drop + alert;
  3. `reserve(tenant, estimated_usd)` — insert a `spend_ledger` row `state='reserved'` keyed on a unique `ref_key` (the `mid` or `comment_id`), refusing if `sum(usd) + estimate > ceiling`. Any error → **503**. Never `try { check() } catch { continue }` — that exact pattern was the HIGH finding next door. After the Anthropic response, `settle()` writes real token counts.
  The reservation is what makes "charged before the call is made" true rather than aspirational; the unique `ref_key` is what makes a QStash retry re-use the reservation instead of double-charging.
- **Verify:** set `monthly_ceiling_usd = 0` on a staging tenant; a message produces the configured `on_exhausted` behaviour and **no Anthropic request** — confirmed in the Anthropic console, not only your own logs. Confirm a **503** (not a reply) when the ledger table is made unreadable.

#### 32. Trip a deliberately low threshold and confirm the Telegram alert fires — F
- **Do:** on Matrix, still in `shadow_routing`, set `alert_threshold_usd = 0.01`; send three test messages after step 35 turns generation on.
- **Verify (four assertions, all required):**
  1. A Telegram message reaches the **founder's phone** within 60 s, naming tenant, amount, ceiling, and a dashboard link.
  2. `alerts.delivery_status = 'sent'` with Telegram's `message_id` recorded — not merely "HTTP 200". Telegram returns `{"ok": true, "result": {…}}`; parse `ok`. A 2xx from a messaging provider means *accepted*, never *delivered*.
  3. **Dedupe:** three more messages produce **no second alert** within the hour.
  4. **Restore, then verify the restore by reading the row back from the database**, not from the admin UI. The UI is a view; the row is the fact.
- **Also exercise the platform-ceiling equivalent once on staging**, so the global kill path has fired at least once before it is needed.

#### 33. Wire the standing alert set — F
- **Do:** `token_revoked_190`, `budget_80pct`, `budget_exhausted`, `unrouted_webhook`, `webhook_silence`, `mirror_forward_failure_rate`, `send_failure_rate`, `entry_id_mismatch`, `platform_ceiling_80pct`, `catalog_drift`, `qstash_unconfigured`.
- **`webhook_silence` deserves its own sentence.** A tenant can be silently unsubscribed by Meta after roughly an hour of failing deliveries, and a dead Page token produces the identical symptom. **You do not find out from a request; you find out from the absence of requests.** Nothing in the ancestor watches for absence. The degraded path is equally silent: nothing alerts when `qstashEnabled()` is false (verified: `Matrix-Chatbot/lib/messengerQueue.js:37-43`), and `memoryEnabled()` exists for precisely this purpose and is **never called anywhere** (verified: `Matrix-Chatbot/lib/conversationStore.js:130`).
- **Requires `tenants.timezone` and `business_hours` from step 18** — the watchdog is in-hours only.
- **Verify:** fire each alert kind at least once on staging, by construction. An alert that has never fired is untested code on the path you will most need at 2 a.m.

---

### Phase G — Catalog verification in production

#### 34. Run V1–V9 on the production project and paste the output — F
- **Do:** apply the migration set to production through the SQL editor (same path as staging), then run the pack **against production**:
  - **V1** RLS state per table (`relrowsecurity`, `relforcerowsecurity`, policy count).
  - **V2** the "did I forget a table" query — **must return zero rows**, or every row is on a written allow-list.
  - **V3** the true ACL via `aclexplode(coalesce(c.relacl, acldefault('r', c.relowner)))`, grantee `0` rendered as `PUBLIC`. Both null-traps matter: a table created and never granted carries a **null** `relacl` and a bare `aclexplode` reports it as *no grants at all*; and `pg_get_userbyid(0)` returns the string `'unknown (OID=0)'` rather than erroring, so a grant to PUBLIC appears under a nonsense name and gets skimmed past.
  - **V5** client roles holding more than `SELECT`, compared against the literal string `'SELECT'` so it catches PG17's `MAINTAIN` and anything PG18 adds without an edit.
  - **V6** every tenant-scoped table has `tenant_id` and `tenant_id` leads an index.
  - **V7** permissive policies for `anon`/`authenticated`/`public` whose body does not mention `tenant_id`.
  - **V8** `select rolname, rolbypassrls, rolsuper from pg_roles where rolbypassrls or rolsuper` — expect exactly `postgres` and `service_role`. **Any other row: stop.**
  - **V9** full policy bodies. Plus the collation assertion from step 2.
- **Verify:** paste **every row** into `docs/onboarding/matrix.md` and the PR. **Read every row.** Check **each table independently** — the last failure next door was partial, one of four tables, and a spot check on the one that happened to be correct confirmed the wrong conclusion.
- **Do not** consult `supabase_migrations.schema_migrations` (records nothing for dashboard-applied SQL; identical whether a migration ran or never ran) and **do not** consult `information_schema.role_table_grants` (permission-filtered; returned zero rows for tables the raw ACL proves carry grants).
- **Expected end state per table, asserted individually:**
  - `tenant_secrets`: `anon` and `authenticated` appear in **no row at all**. `service_role` holds the full set.
  - `conversations`, `messages`, `spend_ledger`, `usage_counters`, `analytics_reports`, `kb_change_proposals`, `webhook_events`, `alerts`, `audit_log`: `authenticated` holds **`SELECT` and nothing else**; `anon` holds nothing. Plus **per-command restrictive denies** — `for insert with check (false)`, `for update using (false) with check (false)`, `for delete using (false)` — *not* the sibling's `for all using (true) with check (false)` shape, which does **not** stop `DELETE` (`DELETE` has no `WITH CHECK`, and that policy's `USING` is `true`). It is masked next door by the absence of both a permissive write policy and a `DELETE` grant; remove either mask and deletes go through.
  - Tenant-writable tables: permissive own-tenant policy whose **`WITH CHECK` repeats the tenant predicate**, or a tenant can `update … set tenant_id = <other tenant>` and hand the row away.
- **And know what none of this protects.** The webhook path has no user session at any point; it runs as `service_role` from ingest to send, and `service_role` holds `BYPASSRLS`. `FORCE ROW LEVEL SECURITY` does not change that — it subjects the table *owner* to RLS, not a `BYPASSRLS` role. **RLS protects the dashboard and protects essentially nothing on the path that carries all the volume and all the spend.** What substitutes: server-derived tenant from `entry[].id` with no `?? DEFAULT_TENANT` anywhere, the `withTenant` chokepoint, composite foreign keys carrying `tenant_id` (referential integrity is *not* subject to RLS, which is what makes it the one check the database still enforces against a service-role bug), and `tenant_id` on every log line and every cache/rate-limit key.

---

### Phase H — Shadow generation and acceptance

#### 35. Shadow generation run — F, 48–72 hours
- **Do:** move both channels to `mode='shadow'`. Dala AI now generates the reply it *would* send, stores it against the conversation, and does not send. The incumbent keeps answering customers; the mirror keeps feeding.
- **Produces:** a side-by-side of every real customer turn: old reply vs new reply. Also the demand ranking that step 24's top-15 floor uses.
- **Verify:** the founder reads **every** pair for the window. Any divergence in a *price*, a *phone number*, a *staff tier*, or the *children's refusal* is a blocker, not a note.
- **Budget note:** shadow spends real money — both bots call Anthropic. Meter it against the tenant ceiling like any other spend and cap the window explicitly. Note this is the *first* step where that is true; Phase D's routing-only shadow was free, which is why it ran for days and this runs for two.

#### 36. The live acceptance matrix — F, **from phones that are not the founder's**
- **Why strangers' phones:** the founder's account may hold a role on the Page or the app. In Dev mode, role-holders are the *only* accounts that work. A pass from the founder's phone cannot distinguish "Live mode and Advanced Access work" from "you are an app tester".
- **Why two of them, and why order matters.** The greeting shortcut fires **only when history is confirmed empty** — verified in the ancestor as `hasHistory: historyItems == null ? true : historyItems.length > 0` (`Matrix-Chatbot/lib/messengerProcess.js:58-60`), with `null` deliberately meaning "assume ongoing". So T1, run first from one phone, destroys the precondition for T8 and T10, and those two rows — which encode the ancestor's confirmed live bugs — would pass **vacuously**. The ops-reality critique caught this and it is the most dangerous single defect in the draft's test plan. Each row below carries its required starting state; virgin-PSID rows run first, on **different PSIDs**; the reset between runs is `del <tenant>:msgr:hist:<psid>` plus deleting that PSID's `conversations` rows.
- **Book it as an appointment.** Eighteen rows across Messenger, Instagram and comments is a 60–90 minute session with two people who owe you nothing.

| # | State | Channel | Input | **Pass** | **Fail** | Observe in |
|---|---|---|---|---|---|---|
| T1 | virgin A | Messenger | `Сайн байна уу` | Greeting naming *Matrix Eco Salon*, Mongolian, ≤ 1 message, < 30 s | Any Russian/English loanword; a second message; > 30 s | Messenger + `messages` |
| T8 | virgin B | Messenger | `Уучлаарай асуумаар байна` | Answered as a real question | The canned first-time greeting — the ancestor's live bug | Messenger |
| T10 | virgin C | Messenger | `Байна уу` in **NFD** form | Identical behaviour to the NFC form | Different behaviour — proving no NFC normalisation on input | `messages.body` + `IS NORMALIZED` |
| T2 | any | Instagram DM | `Үс засалт хэд вэ?` | Reply arrives; `entry[].id` matched the stored IG account ID; tiers quoted, not one price | No reply (the ancestor's silent-drop class); one price, no tier clarification | Instagram + `webhook_events` |
| T9 | has history | Messenger | `Facebook хаяг байна уу` | The Facebook answer | A Maps card — the ancestor's substring false positive | Messenger |
| T4 | has history | Messenger | `Маргааш Оюунсүрэнд цаг авмаар байна` | Contains the master-stylist deposit (20,000₮) **and** `matrixecosalon.org`; **does not** contain «товчлуур дээр дарж» | Any website-button mention; the generic handoff instead of a booking answer | Messenger |
| T5 | has history | Messenger | `Хүүхдийн үс засалт хэд вэ?` | **Primary:** the reply, NFC-normalised and whitespace-collapsed, equals `refusal_topics.verbatim_response`, optionally followed by the tenant's `closing` line and nothing else. **Secondary net:** no `₮`, no `\d{4,}` after stripping the phone, none of `forbidden_openings` | Any price, range, hedge, or "adult or child?" question | Messenger + `tests/acceptance` |
| T7 | has history | Messenger | A question the KB genuinely does not cover | The pinned handoff sentence **verbatim**, with the escalation phone | An invented price, service, or plausible guess | Messenger |
| T6 | has history | Messenger | An off-topic, profane turn | **Opens with a boundary**, then one redirect sentence | A reassurance opener («Санаа зоволтгүй»); engaging; an invented apology | Messenger |
| T17 | has history | Messenger | With a closure row active: `Маргааш цаг гарах уу?` | The closure sentence **verbatim**, no date invented, no booking offered | Any composed date; a booking offer during the break | Messenger |
| T18 | has history | Messenger | A question whose honest answer exceeds the cap, containing emoji | One message, natural boundary, **no split emoji**, phone-handoff suffix | A split surrogate pair; two messages | Messenger |
| T3 | — | FB comment | Public comment asking opening hours | Public reply posted **once**; a private reply used at most once, a second attempt treated as **success** (subcode `2534014`), never retried; a comment older than 7 days minus margin **refused before any Anthropic call** | Two replies; a retry that regenerates; spend outside the window | `private_reply_sent` + `spend_ledger` |
| T11 | — | — | Replay the exact same signed body twice | **One** reply, **one** `messages` row, **one** `spend_ledger` row | Two of anything | DB |
| T12 | — | — | Alternate 20 events between Matrix and a staging fake tenant in one warm instance | Every reply from its own tenant's config; separate history keys, ledger rows, log lines | Any cross-contamination | `spend_ledger` + logs |
| T13 | — | — | Signed payload, unknown `entry[].id` | **200**, dropped, `webhook.unrouted` incremented, alert fired, **no tenant created** | 4xx (risks unsubscription); a tenant auto-created; silence | `alerts` |
| T14 | — | — | Forged signature; missing signature; `META_APP_SECRETS` unset | **401** in all three | Any 200 | logs |
| T15 | — | — | Corrupt the stored token to force Graph `190` | `token_status='authorization_error'`, **all sends stopped for that tenant**, alert fired, **no retry** | A retry loop; other tenants affected | `tenant_secrets` + `alerts` |
| T16 | — | Messenger | Ceiling already exceeded | The configured `on_exhausted` behaviour, **zero Anthropic requests** | A reply generated anyway; a 500 | Anthropic console + `spend_ledger` |

**On T5's criterion.** The config-not-code critique is right that the draft's Matrix-specific negative regex has to be re-authored per tenant and is therefore not a platform test. Byte-equality to the row is the tenant-independent criterion and it writes itself from the data. But exact equality alone would **fail a correct bot**: the ancestor's own rules require a closing line in some positions (verified: `Matrix-Chatbot/lib/salonBrain.js:105`), so the assertion must permit `verbatim_response` optionally followed by the tenant's `closing` and nothing else. The negative regex is kept as a secondary net for the case where the model paraphrases *around* the pinned sentence.

**T5, T6, T8, T9, T10, T11, T12 also exist as offline tests** in `tests/acceptance/` with the clock injected, so a regression is caught in CI and not by a customer.

---

### Phase I — Cutover

#### 37. Understand what happens if both are subscribed — F
- **Same Meta app (step 11 plan A):** an app has **one callback URL per object**. Pointing it at Dala AI *replaces* the old endpoint instantly and completely; the existing Page token stays valid; rollback is editing one field back. **There is no window in which both reply.**
- **Different Meta apps (plan B):** each app subscribes independently and — **(ASSUMED, the highest-value item to verify in step 7)** — may each receive its own copy of every event. If that is true, any overlap means **both bots reply to every customer**. If it is false and only one app can hold a Page subscription, subscribing the new app *silently unsubscribes* the old one and the transition is a hard swap with no overlap. **These two possibilities require opposite plans**, which is why the answer must be measured on the founder's own test Page before Matrix is touched.

#### 38. Build the cutover controls before scheduling — F
Three controls, all rehearsed on staging:
1. **The mirror flag** (step 22) — Redis `SET`, sub-second, both directions.
2. **The mode switch** — `update tenant_channels set mode = …`, cached 60 seconds, and **that TTL is a documented constant, not an incidental**, because it bounds rollback latency.
3. **The drain guard.** The send path **re-reads `mode` immediately before the Graph call** and drops if it is not `live` — the same shape as the `DALA_ENV` guard, applied at the last possible moment instead of the first. Without it, rolling back leaves N already-reserved, already-enqueued QStash events with three retries each that fire *after* the rollback and produce exactly the double replies the rollback exists to stop, worst under load, for the deepest queue. The ops-reality critique is right, and note the fix is only safe because the mirror runs old → new: dropping a queued event is harmless precisely because the incumbent already received and answered it.
- **Verify:** rehearse the flip **and the rollback** on staging, timing both. The runbook states the drain window in seconds, computed from the configured QStash backoff, with the sentence *"expect stragglers for N seconds; do not re-flip."* If rollback takes longer than 120 seconds, the design is wrong; fix it before scheduling.

#### 39. Schedule the window — F, agreed with S
- **Do:** **Tuesday or Wednesday, 09:00–10:00 Ulaanbaatar**, before the 10:00 opening (verified from the FAQ hours). Never Friday, never Saturday, never before a public holiday, never during an active closure.
- **Choose the hour quantitatively:** `messages` per hour over the preceding 14 mirror days, by weekday and hour. If the chosen hour is not in the bottom quartile, choose another hour. Phase D gives you this data for free.
- **Verify:** S confirms in writing, knows "the bot may be quiet for two minutes", and a **named human at the salon is reachable by phone for the full hour**. That is the one thing that turns a two-minute blip into a lost customer.

#### 40. Flip — F, with the rollback already typed into a second terminal
- **Order of operations (plan A):**
  1. Pre-flight: both channels `mode='shadow'`, `token_status='ok'`, budget set, `last_webhook_at` within the hour, T1–T18 green, shadow diff reviewed, **incumbent confirmed replying** one last time.
  2. Probe from stranger A; confirm the **old** bot answers.
  3. `update tenant_channels set mode='live' where tenant_id=…` — one statement, both rows. Wait out the 60 s cache.
  4. **In the App Dashboard, point the `page` and `instagram` callback URLs at `https://<prod>/api/webhooks/meta`.** This is the only moment in the entire checklist that the production callback URL changes.
  5. Turn the mirror flag **off** (the incumbent no longer receives anything, so it is inert either way — turning it off removes a confusing log line).
  6. Probe from stranger B. Confirm **exactly one** reply, from Dala AI, identifiable by a `messages` row and a `spend_ledger` row.
  7. Watch 60 minutes: every conversation read, reply latency, ledger totals, zero `entry_id_mismatch`, zero `webhook.unrouted`.
- **Rollback** (any of: a wrong price, a double reply, > 60 s latency, a children's-price leak, any cross-tenant symptom):
  1. `update tenant_channels set mode='shadow'` — the drain guard stops in-flight sends within seconds.
  2. Point the callback URLs back at the incumbent.
  3. Turn the mirror flag back on.
  That restores **exactly** the pre-cutover state, mirror included. The old bot has been running the whole time; nothing needs to warm up, redeploy, or be re-authorised.
- **Do not** delete, unsubscribe, or decommission anything on cutover day.

---

### Phase J — Handover and standing operations

#### 41. What the salon owner is handed — F to S, in person or on a call, in Mongolian
**v1 recommendation: the owner changes nothing directly.** Every knowledge write is customer-facing Mongolian text, and the pinned lines exist precisely because unreviewed Mongolian reached customers and was garbled (`Matrix-Chatbot/lib/salonBrain.js:48-51`). Self-serve editing of a price list is defensible; self-serve editing of the sentences a bot says is not, yet.

- **The owner can change, by messaging or calling the founder:** prices and service names; roster and tiers; hours; FAQ answers; a holiday closure (with the exact sentence they want customers told); the booking link; the escalation phone; adding a topic to the never-quote list.
- **Turnaround:** a price or roster change live within **one business day**; a closure announcement within **4 business hours**, because a closure that lands late is worse than no closure.
- **The owner cannot change:** anything that spends money, any Meta credential, the model, the prompt structure, another tenant's anything.
- **Produces:** a one-page Mongolian handout — what the bot does, what it deliberately refuses (children's prices → the phone), which services currently say "call us" and why, the founder's phone and Telegram, and the sentence to send if something looks wrong.
- **Verify:** S makes one real change request end to end during the handover call (change one FAQ answer) and sees it live. A support channel that has never carried a request is untested.

#### 42. The support contract — F and S
- **Coverage:** the salon's own hours — Mon–Sat 10:00–20:00, Sun 11:00–19:00, Asia/Ulaanbaatar.
- **Targets:** reply latency p95 < 30 s in-hours. Detection of a total outage < 15 minutes (the `webhook_silence` watchdog). On a confirmed outage the founder **phones the salon** and Meta's Page away-message is switched on manually so customers see something rather than nothing. Time-to-restore target: **4 business hours**.
- **Explicitly out of scope:** Meta platform outages; the salon's own booking website; and a **token revocation caused by an action on the salon's side** (a password change, an app revoke, a Page role removed). In that case the SLA clock **pauses** until the owner re-authorises, and the handout says so in plain Mongolian — otherwise the first such incident is an argument.
- **Escalation:** Telegram to the founder → phone → (nobody else exists in week one; say so rather than implying a team).

#### 43. Standing operations, not decommissioning — F
- **Do:** three crons, each with an explicit ceiling and an alert path, **none touching Anthropic**:
  1. `reconcile-subscriptions` (daily) — `GET /{page-id}/subscribed_apps` per channel, diffed against `tenant_channels.subscribed_fields`; alert on drift. This is how you learn Meta unsubscribed you.
  2. `token-health` (daily) — a cheap `GET /{page-id}?fields=id` per channel; a `190` sets `token_status` and alerts.
  3. `silence-watchdog` (hourly, in-hours only) — `last_webhook_at` older than N hours during business hours → alert.
- **Do NOT** delete the Matrix-Chatbot deployment, revoke its token, or unsubscribe anything for **14 days**. It is the rollback target. Keep its Vercel project, env vars and Upstash resources intact and paid for.
- **Verify:** each cron's first run inspected by hand, and each made to alert once by construction.

---

## 8.3 Definition of done — Tenant #1

Tenant #1 is done when every one of these is true **and has an artifact**:

1. `tenant_channels` holds two rows, `mode='live'`, and `entry[].id` from a real delivery **equals** the stored `external_id` for both — logged, not asserted from memory.
2. The Page token is in `tenant_secrets`, envelope-encrypted, and the AAD tamper test failed as designed. `select` as `authenticated` returns **permission denied**, not empty.
3. No environment variable holds a Matrix-specific value. `grep -ri 'matrix\|7741\|засалт' src/ config/` returns nothing outside tests and fixtures. `check-prompt-blocks.mjs` is green.
4. A message from a phone with no relationship to the Page gets a correct Mongolian answer on **both** Messenger and Instagram.
5. **T1–T18 all pass**, with timestamps, observation points, and the virgin-PSID discipline recorded. T5 passes on byte-equality to the row, not a hand-authored regex.
6. V1–V9 plus the collation assertion were run **against production**, every row read, **each table checked independently**, output pasted in `docs/onboarding/matrix.md`.
7. A budget ceiling exists, is non-null, and the exhausted path was exercised with **zero Anthropic requests confirmed in the console**.
8. The Telegram alert fired for a deliberately low threshold, landed, recorded `message_id`, deduped, and the **failure** path was exercised by breaking the token.
9. The old bot is silent, still deployed, the mirror is still deployable, and rollback has been **rehearsed and timed under 120 seconds**.
10. Duplicate delivery produces one reply and one ledger row (T11); the two-tenant warm-instance test is green (T12); the **synthetic GS Auto render** (step 30.5) produced no Mongolian sentence that needed a code change.
11. Every log line carries `tenant_id` — checked by reading 20 consecutive production log lines, not by reading the code.
12. The escalation phone was **dialled** and a human at Matrix confirmed it.
13. The booking URL was opened and a booking driven to the payment step.
14. S signed off every pinned Mongolian sentence in its new context (`reviewed_by`/`reviewed_at` populated on every `canned_responses` and `refusal_topics` row).
15. The top 15 services by shadow-observed demand are `confirmed_at`-stamped; every unconfirmed service demonstrably routes to the escalation phone rather than quoting.
16. The three crons have each run once, been inspected, and been made to alert once.
17. S has made one real change request end to end and seen it live.
18. `incumbent_ok_at` is populated on every step that touched the Page, the app or the token.

---

## 8.4 Tenant #3 — two tracks, and only one of them is the platform's test

The draft measured one list against "longer than a morning means the platform is not built". That conflates work the founder controls with work a client controls. **The platform is proved by the first track; the second is a calendar problem and is tracked, not measured.** The ops-reality critique is right about this, and applying the wrong criterion would send the founder off to re-engineer something that is fine.

### Track 1 — founder work. Target: one morning. This is the platform's test.

1. **Create the `tenants` row** (admin form) — including `timezone`, `currency_*`, `business_hours`. *Verify:* read back as `founder`.
2. **Insert two `tenant_channels` rows, `mode='off'`.** *Verify:* duplicate-identity insert fails.
3. **Assign Page + IG as System User assets; install the app.** *Verify:* `debug_token` shows expected scopes.
4. **Mint the Page token** via `GET /{page-id}?fields=access_token` — never `/me/accounts`. *Verify:* the token reads its own Page.
5. **Store the tokens encrypted** (automatic on save). *Verify:* AAD tamper test.
6. **Probe send to the founder's own PSID.** *Verify:* arrives; wrong-tenant token fails.
7. **`POST /{page-id}/subscribed_apps`** — the callback URL and verify token already exist. *Verify:* `GET /{page-id}/subscribed_apps` lists the app.
8. **`mode='shadow_routing'`; one message; assert the `entry[].id` match.** *Verify:* `webhook.entry_id_match`.
9. **Enter the config** the client supplied: services + prices, `config_keys` + staff, deposit rules, FAQs, hours, booking hand-off, escalation phone, never-quote list, clarify rules, canned lines, tenant prompt blocks and examples (admin forms). *Verify:* prompt renders; staff-line count equals row count; every price round-trips; matcher dry-run reviewed; phone dialled; booking link opened.
10. **Set the budget.** *Verify:* exhausted path produces the configured behaviour and no Anthropic call.
11. **Run the acceptance matrix** — the tenant-independent rows (T1, T2, T6, T7, T11, T13, T14, T16) plus this tenant's own never-quote row (T5, criterion generated from the row) and clarify row. *Verify:* pass/fail recorded, virgin-PSID discipline observed.
12. **Run V2 and V5 only** (CI) — the full V1–V9 pack is a *schema* check and does not change per tenant; V2 catches a table added since. *Verify:* zero rows.
13. **`mode='live'`; handover.**

**No cutover phase** (no incumbent). **No App Review** (the app is approved). **No migrations. No code.**

### Track 2 — client lead time. Expect 1–3 weeks. Tracked, not measured.

- Owner grants Partner access to the Page in Business Settings (**most common stall point**; the person with admin rights is often not the person you are talking to).
- Owner supplies or corrects the price list, roster, hours, booking link, escalation phone, never-quote topics.
- Owner or a native reviewer signs off the pinned Mongolian sentences.
- A borrowed phone for the acceptance session.

The `confirmed_at` degradation of step 24 applies here too: an unconfirmed price refuses and refers to the phone, so Track 2 does not have to complete before Track 1 can finish.

### Gaps that would still force a code change — named honestly

| Gap | Why it is a gap | Status |
|---|---|---|
| **Booking mode.** A tenant with no booking site needs "call to book". | If `mode` ships with only `'link'`, tenant #3 is a code change. | **Closed now** — enum `'link'\|'phone'\|'none'`, three renderers, step 27. |
| **Currency, symbol position, units.** `₮` appended unconditionally in the ancestor; GS Auto prices per-hour and per-part. | A `unit` column that does not exist is a migration plus a renderer change — and the *instruction line* naming ₮ is a second, unreachable copy of the fact. | **Closed now** — five `tenants` columns + a `unit` column, and the formatting instruction is generated, step 18/§8.1.7. |
| **Rule vocabulary.** Matrix needs "clarify tier before quoting" and "disambiguate Сор/CICA"; GS Auto needs "do not quote before knowing vehicle model and year". | If not expressible as a `clarify_before_quoting` row with a typed matcher, it becomes a per-tenant prompt fragment — the beginning of a branch. | **Closed now**, and **proved** by the synthetic GS Auto render in step 30.5, before tenant #1 goes live. |
| **Prompt scaffolding, answering rules, deposit table, examples.** Half the ancestor's prompt. | If they stay in `build.ts`, GS Auto's prompt contains haircut examples and a "male or female?" rule. | **Closed now** — `prompt_blocks` (with `scope`), `prompt_examples`, `deposit_rules`, and CI check 6. §8.1.7. |
| **`auth_flavour = 'instagram_login'`.** | A value no step executes is not config; the send host, path and token column all differ. | **Deliberately excluded from the constraint** until step 7 rehearses it. §8.9 Q5. |
| **Non-Mongolian tenants.** | The Cyrillic suite, the fold table and the pinned-line review are Mongolian-specific. | **Accept the gap. Do not pre-build it. Record it.** |
| **Comment handling per tenant.** | Expands App Review surface and adds enrichment calls against the tenant's rate budget. | Per-tenant capability flag; ship DM-only. |
| **Token acquisition is a Business-Manager runbook, not a form.** | Track 2 items 1 are human clicks in two portfolios. | **Accept and name it.** A Facebook-Login-for-Business onboarding page would automate it into two clicks, at the cost of a credential coupled to one human's password. §8.9 Q4. |

---

## 8.5 Risks and rollback

| Risk | Blast radius | Detect | Rollback |
|---|---|---|---|
| **Cutover produces double replies** | Every customer, visibly | Stranger probe at 40.6; customer report | `mode='shadow'` (drain guard) → callback URL back → mirror on. Under 120 s, rehearsed. |
| **Cutover produces zero replies** | Every customer, invisibly | The probe; `webhook_silence` within the hour | Same |
| **The mirror itself breaks the incumbent** | Every customer, during Phase D | The mirror's own on/off A-B test in step 22; `mirror_forward_failure_rate` | Redis `SET` the flag off — sub-second, no redeploy |
| **Business-Settings work perturbs the incumbent's token** | Silent outage during Phases B–C | `incumbent_ok_at` on steps 13/14/15/20/22 | Known-good boundary is a timestamp; undo the last asset change |
| **Wrong price quoted** | Customer arrives expecting a different number | Shadow diff (35); T-row assertions | Roll back; fix the row; re-shadow |
| **Children's price leaks** | The salon's explicit business decision violated | T5's byte-equality assertion run against **every** shadow reply, not only the test | Roll back; extend `forbidden_openings` from the observed failures |
| **Cross-tenant leak** (once tenant #2 exists) | Catastrophic, unrecoverable in reputation | T12; `tenant_id` on every log line; the composite FK refusing at the database | Both tenants `mode='off'` immediately — the one failure where silence beats service |
| **Page token dies at 2 a.m.** | Tenant silently stops replying; no error anywhere | `token-health` cron + `webhook_silence` | Cannot self-heal — needs re-authorisation. This is why the SLA pauses (42). |
| **Meta unsubscribes the Page after webhook failures** | Total outage for that tenant; you learn from the *absence* of requests | `reconcile-subscriptions` daily + `webhook_silence` | Re-run `POST /{page-id}/subscribed_apps` |
| **Runaway spend on one tenant** | The founder's card | Reservation refuses before the call; 80% alert | `mode='off'`; the ceiling already stopped it |
| **App-level rate budget consumed by one tenant** | *Other* tenants' calls start failing — Meta does not fair-share | Per-tenant token bucket + a global bucket sized **below** Meta's + `X-App-Usage` high-water marks per response | Throttle the noisy tenant only, never the worker |
| **Graph version expires** | Calls keep returning 200 with a different response shape **(ASSUMED: silent fallback — verify)** | Startup assertion + monthly check that the pin is still live | Bump `META_GRAPH_VERSION`; canary via one tenant's override |
| **A migration applied to some tables and not others** | A boundary that reads as closed and is open — the exact failure next door | V2 non-zero; per-table independent checks | Re-apply; re-verify; paste again |

### What I would NOT do in week one

- **No tenant #2.** Matrix runs 14 days live before GS Auto is touched. T12 is a lab test; two tenants in production is the real one, and you want it deliberate.
- **No comments, on either network.** Comment replies expand the App Review surface, require an enrichment Graph call per event against the tenant's rate budget, and bring the single-use, non-idempotent, 7-day-expiring private-reply mechanic. Ship DM-only.
- **No Customer Care AI, no SMS, no SIP.** Beyond the trunk not existing: the Messenger message tags it would have used were retired 2026-04-27 and now return error `100`; the surviving `HUMAN_AGENT` tag forbids AI-authored text and Meta says it detects misuse. **Design the seam as an `OutboundPolicy` object where `per_message_cost_usd === null` refuses**, and build nothing.
- **No Voice AI.** Seam only.
- **No tenant-owner login.** §8.9 Q1.
- **No auto-applied Quality proposals.** Founder approval, always.
- **No scheduled spenders.** The Analytics AI monthly report is Dala AI's first and does not ship until the ledger has a month of real data, a per-tenant dollar ceiling *and* an alert path. `vercel.json` carries only the three non-Anthropic crons. Next door, a generator whose only bound was a cached read ran hourly and the read was blind.
- **No retrieval / RAG.** Matrix's whole KB renders to 7,824 characters — inline it. Retrieval becomes necessary when a tenant's catalogue does not fit, and GS Auto may be that tenant; solve it then, with the same hardening the pinned lines got.
- **No `unaccent`.** It maps `Ё → Е` and `ё → е` — full letters of the Mongolian alphabet — while leaving `Й`, `Ө`, `Ү` untouched. Partially destructive is worse than fully destructive: it looks harmless in nine tests out of ten.
- **No `citext`.** Its case folding depends on `LC_CTYPE`, fixed at database creation. Normalise at the boundary; store a `stored` generated column.
- **No CSP promotion to enforcing**, no second Meta app, and **no deleting the old deployment** — it is the rollback target for 14 days minimum.

---

## 8.6 Failure modes

**Meta review is delayed (or refused).** The mitigation is structural: step 11 plan A removes App Review from tenant #1's critical path by reusing the app that already serves Matrix's customers. If plan B is forced, the honest response is to **not cut over** — the incumbent keeps working and Dala AI runs on the mirror indefinitely, accumulating shadow diffs at the cost of double Anthropic spend (cap the window and budget accordingly). This is a real advantage of the mirror over the draft's proxy: a delay is now free rather than a decision. Business Verification is the deeper pole and starts day 1. If review is *refused*, the failure is informational: read the rejection, fix the screencast or the use-case description, resubmit — and tell the salon nothing about their service changes, because it does not.

**The Page token cannot be obtained.** Distinguish three cases; the symptom is identical and the fixes differ. (a) `/me/accounts` returned empty — that is the trap, not the answer; use `GET /{business-id}/client_pages` then `GET /{page-id}?fields=access_token`. (b) The Page is not an assigned asset of the System User — fix in Business Settings; no API call will fix it. (c) The salon's admin has not accepted the Partner invitation — check `pending_client_pages`. **Do not fall back to a personal long-lived user token to unblock the launch.** It works, it passes every test, and it dies at the worst moment when the owner's nephew changes his password. If none resolves within a week, the correct move is Facebook Login for Business as a *documented, temporary* shape with `auth_flavour` recorded on the row, so the eventual migration is a token swap rather than archaeology.

**The owner never fills in the config.** The most likely failure of all, and a process failure, not a technical one. In order: (1) **the config is pre-filled from the ancestor repo before the owner is ever asked** — 40 prices, 9 staff, 4 FAQs already exist; the owner *corrects* rather than *authors*, a much smaller ask; (2) one thing at a time in a single 30-minute call, not a form; (3) go-live gates on the four facts that produce a *wrong* answer (escalation phone, booking link, never-quote list, top-15 prices) and not on the ones that produce a merely thinner answer; (4) unconfirmed prices **degrade to the escalation phone** rather than blocking, so "we'll fill it in later" cannot silently become a bot that guesses; (5) missing *required* fields fail the render loudly and block `mode='live'` at the database level. If a required field is still missing after two weeks, do not launch — say so plainly rather than launching a bot that guesses.

**The cutover collides with a busy salon day.** Prevented by step 39's window and its quantitative hour selection from mirror data. If it happens anyway — a walk-in rush, a promotion, an inbound spike — **abort rather than continue**: the flip is a handful of statements and so is the abort, and the cost of postponing is one week. And regardless: a named human at the salon must be reachable by phone for the full hour.

**Dala AI is down during Phase D.** Nothing happens to the salon. That is the entire justification for the mirror direction, and it is the difference between a two-week rehearsal that costs nothing and one that puts a live business on a bot with no rehearsal history.

---

## 8.7 Summary — what specifically must change from the ancestor

| # | Ancestor | Must become |
|---|---|---|
| 1 | `api/messenger.js:99-101` — `object !== 'page'` → bare 200 | An `object → adapter` dispatch plus a counter on unrecognised objects. Instagram is silently discarded today. |
| 2 | `api/messenger.js:164-180` — iterates `body.entry` but never reads `entry.id` | `entry[].id` is the routing key, resolved through `tenant_channels` **per entry**, never per request. |
| 3 | `lib/messengerClient.js:10` — `/me/messages` | `/{page-id}/messages` and `/{ig-id}/messages`. With `/me`, a token/tenant mismatch **succeeds** and posts as the wrong salon. |
| 4 | `lib/messengerClient.js:67-69` — `explicit \|\| process.env.PAGE_ACCESS_TOKEN` | A required argument resolved from `tenant_secrets`. Missing → refuse. The `opts.token` seam already exists at `:101, :146, :199` and is threaded nowhere. |
| 5 | `lib/salonBrain.js:142` — module-scope `cachedBasePrompt` | Cache keyed `(tenant_id, config_version)`. A cross-tenant leak, invisible at one tenant. |
| 6 | `lib/conversationStore.js:53, 88` — `msgr:done:<mid>`, `msgr:hist:<psid>` | `<tenant>:msgr:done:<mid>`, `<tenant>:msgr:hist:<psid>`. Same for every rate-limit and budget key. |
| 7 | `lib/salonBrain.js:46` — `SALON_NAME` in every log line | `tenant_id` from the *request*, on every log line. |
| 8 | `api/messenger-worker.js:45-52` — deliberately does not pin the URL claim | Bind the tenant **inside** the signed body and re-derive it in the worker. One QStash key signs jobs for every tenant. |
| 9 | `lib/salonIntents.js:21-26` — unanchored regexes plus a hand-patched email special case | One matcher engine, closed vocabulary, NFC, Unicode token boundaries. `\b` is not the fix — JS `\b` is defined in terms of `\w` and no flag changes it. |
| 10 | No `normalize()` anywhere in the repo | NFC at every input boundary; `IS NORMALIZED` check constraints on stored text. |
| 11 | `lib/validator.js:201` — vowel class missing `ө` and `ү` | Own the fold table explicitly; test it. |
| 12 | `config/currentClient.js`, `closures.js` `DEFAULT_CLOSURES`, `SALON_*` env vars | Rows. No shipped default closure, no per-business env var. |
| 13 | `lib/systemPromptBuilder.js:124-186` + `lib/salonBrain.js:86-106` — half the prompt is Matrix policy in a template literal | `prompt_blocks` (scoped platform/tenant), `prompt_examples`, `deposit_rules`. CI fails on a Cyrillic literal in `src/lib/prompt/`. |
| 14 | `systemPromptBuilder.js:29,179` — `₮` in the renderer *and* in the instruction | Five `tenants` formatting columns; the instruction line generated from them. |
| 15 | No budget, no ledger, no ceiling anywhere in the repo | Reserve → settle, 503 on any error, before the call. |
| 16 | `tests/closures.test.js` — 2 of 18 red, time-bombed (verified today) | Inject the clock; ban `new Date()` outside `src/lib/clock.ts`. |

**Carry over verbatim, with their reasoning:** fast-ACK before any slow work (`api/messenger.js:109-154`); raw-body HMAC with `timingSafeEqual`, fail-closed on a missing secret (`lib/messengerClient.js:25-42`, `lib/rawBody.js`); the ambiguous-failure-≠-failure distinction on a timed-out enqueue (`api/messenger.js:118-133`); the triple echo/receipt/self guard (`:169-173`); `null ≠ []` for history availability (`lib/conversationStore.js:84-101`, consumed at `lib/messengerProcess.js:50-60`); one atomic send before `markHandled` (`lib/messengerProcess.js:111-116`); prompt-cache breakpoint placement plus the token-count logging that proves a hit (`lib/salonBrain.js:210-222, 243-253`); the closure module's three properties (`config/closures.js`); `priceOf`'s refusal to duplicate a fact (`lib/systemPromptBuilder.js:106-112`); and `formatPriceList`'s refusal to render an unknown shape (`:36-38`).

---

## 8.8 Open questions — the founder's call, not mine

1. **Does the tenant owner get a login in v1?** Everything in the RLS design serving `authenticated` exists for a dashboard. If Matrix and GS Auto get a monthly report and a phone number instead, RLS-for-humans is dead weight in v1 and the entire security budget belongs on the service-role webhook path, where all the volume and all the spend are. The highest-leverage decision in the design; it changes step 41 materially.

2. **Reuse the existing Matrix Meta app, or create a new "Dala AI" app?** Reuse removes App Review from tenant #1's critical path, makes the cutover a single reversible edit, keeps the existing Page token valid, and lets the mirror run under one app secret — but it inherits an app named and reviewed for one salon and concentrates every future tenant into a blast radius that already has history. I recommend reuse-then-rename; the rename's review implications are unverified and must be checked first.

3. **What is Matrix's monthly ceiling, and what happens when it is hit?** Hard stop (the salon's Messenger goes silent, possibly on a Saturday), a canned Mongolian "we'll call you back" with the phone, or auto-overage. The chokepoint cannot be finished without this number, and the shadow window's double spend needs it before step 35, not after.

4. **Partner access or Facebook Login for onboarding tenant #3?** Partner access is durable and survives staff turnover on both sides but requires each Mongolian SMB to have a Business Portfolio and an admin who can navigate Business Settings. Facebook Login is two clicks and dies when the owner changes their password. For a salon in Ulaanbaatar, which friction is acceptable — and is the answer different for a garage?

5. **Is `instagram_login` worth rehearsing before it is needed?** It is excluded from the `check` constraint at launch because no step exercises it (§8.2 step 17). Closing it costs a second founder-owned Instagram account not linked to a Page, plus half a day in step 7 — and it also settles two of this section's ASSUMED items. Leaving it open means the first Instagram-only tenant is a debugging session against blocked Meta documentation, on a live customer. Pre-build or accept?

6. **Does Matrix's website chatbot survive?** `api/chat.js` and the `public/`+`src/` widget are a separate channel, and `api/chat.js` is an unauthenticated Anthropic proxy whose only gate is CORS with two fail-open paths (verified: `Matrix-Chatbot/lib/cors.js:16-17` — an empty `ALLOWED_ORIGINS` allows everything, and `|| !origin` passes every request without an `Origin` header, i.e. every `curl`). In scope as a third Dala AI channel, migrated to a thin embed against the same tenant config, or retired? **If it stays as-is, it is an open unmetered spend surface the whole Dala AI budget design does not cover** — that should be a decision, not an oversight.

7. **Does Matrix keep two answer qualities?** The website runs Haiku and Messenger runs Sonnet from the same knowledge base (verified: `Matrix-Chatbot/api/chat.js:13` vs `Matrix-Chatbot/lib/salonBrain.js:19`) — deliberate and documented, but the same question gets measurably different Mongolian depending where it is asked. Intentional product behaviour, or an artifact to remove?

8. **Do the pinned Mongolian strings get re-reviewed?** They were native-speaker reviewed for *that* prompt in *that* context. Moving them into rows and rebuilding the prompt around them changes the conditions under which they were validated. Re-review is a real cost (a person's time); skipping it is a real risk (the exact failure they were written to prevent).

9. **Is "never quote a price for X" self-serve or founder-approved?** Genuinely valuable and genuinely dangerous — a tenant who sets it carelessly ships a bot that refuses to sell, and `check-matchers.mjs`'s dry-run is a safety net, not a substitute for judgement.

10. **Who is woken when a token dies at 2 a.m., and what is promised?** Reception AI goes silent with no error anywhere; the customer just gets nothing. Telegram to the founder is the design above, but the *contractual* answer — time-to-restore, and what the salon is told — belongs in the contract before the first outage, not after it.