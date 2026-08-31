## 4. Per-tenant knowledge base and the owner update flow

**Verified vs. assumed.** Everything with a `path:line` citation I read in the file this pass, or produced by executing the real module in `/home/user/Matrix-Chatbot` (Node 22, git HEAD `d7ae6c8`). Results marked **(measured)** came from running code against the ancestor in this session. Every token count is an **estimate**, labelled as one — there is no Anthropic API key and no tokeniser here; §4.3.2 gives the free procedure that replaces it with a fact, and §4.3.4 makes the design refuse to proceed on the estimate where the number is load-bearing. Where a review objection was raised and I disagree with it, the disagreement is stated inline in one line rather than dropped.

---

### 4.0 What is being replaced

The ancestor's knowledge base is one exported JavaScript object literal, `clientData` (`config/currentClient.js:5-120`): `branding`, `knowledge.{companyIntro, team, priceList, faqs, contact}`, `behavior.{tone, language}`. It is rendered into a Mongolian system prompt by `buildSystemPrompt` (`lib/systemPromptBuilder.js:41`, note: `async`), and the Messenger path appends a channel addendum and caches the result in a module-scope variable (`lib/salonBrain.js:142-149`).

Six properties of that arrangement decide the successor's shape.

**(a) The tenant is a build-time constant.** `lib/salonBrain.js:11`, `lib/salonIntents.js:17` and `api/chat.js:9` import `clientData` at module load. `lib/salonBrain.js:142` then caches the assembled prompt in `let cachedBasePrompt = null` — keyed by *nothing*. Two tenants on one warm Vercel lambda means tenant B is answered from tenant A's prices, staff and phone number. This is not a bug to patch; it is why the KB must become a row addressed by a server-derived tenant id.

**(b) Prices are display strings, not values.** **(measured)** **17 of the 40 price-list entries are strings, 23 are numbers** — `"66,000 – 88,000"` (a pre-formatted string with a U+2013 en dash) sits beside `55000` in one array. `lib/systemPromptBuilder.js:18-23` branches on `typeof`, and `:104-110` branches again in `priceOf`. **42% of the catalogue cannot be compared, summed, validated or attributed** — and Analytics AI's revenue attribution needs exactly that.

**(c) The taxonomy is three hardcoded buckets.** `lib/systemPromptBuilder.js:66-86` filters the team on `gender === 'female' | 'male' | 'manicure'` under three fixed Mongolian headings, with **no `else`** — a staff member with any other value silently vanishes from the prompt. `types/clientConfig.ts:20` enshrines this as `gender: 'female' | 'male' | 'manicure'`, a service line encoded as a gender. GS Auto Center's mechanics cannot be expressed at all.

**(d) Business policy is prose inside the shared template.** `lib/systemPromptBuilder.js:138-149` is the deposit table; `:131-132` the clarify-before-quoting rules; `:134` the Сор/CICA ambiguity rule; `:136` the canonical-naming rule with «гель маникюр» → «Гелэн будалт»; `:151-165` five example dialogues naming Оюунсүрэн and Г. Мөнхзаяа. All of it is Matrix Eco Salon policy, in a file called `systemPromptBuilder`.

**(e) The deliberate omission is a comment plus two copies of a string.** `config/currentClient.js:34-35` is a comment saying children's haircuts are excluded on purpose. The rule exists twice — `lib/systemPromptBuilder.js:135` and `CHILDREN_REPLY` at `lib/salonBrain.js:70-72`, reinforced in the Messenger addendum. Nothing checks that the omission is still an omission: add a children's price to `priceList` and the refusal and the catalogue contradict each other in silence.

**(f) Changing anything is a code change — and that is simultaneously the worst part of the flow and the only staleness detector the system has.** `CLIENT_ONBOARDING.md:7-9`: *"Open `/config/currentClient.js` and update the following sections"*, then rebuild and redeploy. This section replaces that. **It must not replace it without also replacing what it accidentally provided** — see §4.1.5.

---

### 4.1 Storage model: structured records, with typed free text as a bounded escape hatch

#### 4.1.1 The decision

**Structured records are primary. Free text exists, is typed, is size-capped, and is never where a price, a name, a phone number or a refusal lives.**

Three things the product needs that free-text documents cannot give:

1. **Analytics AI must attribute revenue to services** — `price_min` as an integer and a stable `service_id`, not a paragraph containing "66,000 – 88,000".
2. **The refusal list needs a machine-checkable invariant** — "no active service matches an active refusal topic" (§4.6.4). Over free text that is a regex over Mongolian, which §4.8 forbids. Over rows it is a join.
3. **The renderer must fail loudly on a dangling reference.** `lib/systemPromptBuilder.js:66-86` fails *silently* today. A foreign key cannot. The right instinct is already in the file at `lib/systemPromptBuilder.js:36-39`, which refuses to render an unrecognised price-list shape — *"refuse to render prices rather than risk serving a category (e.g. children's) the official list doesn't carry."*

Free text still earns a place: "we use ammonia-free colour", "parking is behind the Nomin hypermarket". Those go in `kb_note` — typed with a scope, ordered last, and capped, so a tenant cannot quietly turn the KB back into a blob.

#### 4.1.2 Schema

All tables carry `tenant_id uuid not null references tenant(id)` and `revision_id uuid not null`, and every foreign key between them is **composite, carrying both** — so a child row can never cross a tenant *or* a revision. Composite FKs are the one integrity check that still holds against a buggy `service_role` route, because `REFERENCES` checks are not subject to RLS.

```sql
create table kb_revision (
  tenant_id     uuid not null references tenant(id),
  id            uuid not null default gen_random_uuid(),
  seq           bigint not null,                    -- monotonic per tenant
  status        text not null check (status in ('draft','published','superseded')),
  parent_id     uuid,
  note          text,                               -- the editor's own words, Mongolian
  created_by    uuid not null references app_user(id),
  created_at    timestamptz not null default now(),
  published_by  uuid references app_user(id),
  published_at  timestamptz,
  content_hash  text,
  est_tokens    integer,                            -- measured, not estimated (§4.3.2)
  est_token_source text check (est_token_source in ('count_tokens','ratio_fallback')),
  primary key (tenant_id, id),
  unique (tenant_id, seq)
);
create unique index kb_revision_one_draft on kb_revision (tenant_id) where status = 'draft';

create table kb_service (
  tenant_id uuid not null, revision_id uuid not null, id uuid not null,
  category_id uuid not null,
  name        text not null,
  name_key    text generated always as (lower(normalize(name,NFC))) stored,
  search_key  text generated always as (fold(lower(normalize(name,NFC)))) stored,
  tier_id     uuid,                                  -- NULLABLE: tenants without tiers
  price_basis text not null check (price_basis in
                ('fixed','range','from','on_request','not_quoted')),
  price_min   integer check (price_min >= 0),         -- ₮ has no minor unit
  price_max   integer,
  currency    char(3) not null default 'MNT',
  unit        text not null default 'service'
                check (unit in ('service','hour','item','nail','litre','axle')),
  duration_min integer,
  aliases     text[] not null default '{}',
  active      boolean not null default true,
  confirmed_at timestamptz not null,                 -- §4.1.5 — freshness is a stored fact
  display_order int not null,
  primary key (tenant_id, revision_id, id),
  unique (tenant_id, revision_id, name_key),
  foreign key (tenant_id, revision_id, category_id)
    references kb_service_category (tenant_id, revision_id, id),
  foreign key (tenant_id, revision_id, tier_id)
    references kb_staff_tier (tenant_id, revision_id, id),
  constraint price_shape check (
    (price_basis = 'fixed' and price_min is not null and price_max is null)
 or (price_basis = 'range' and price_min is not null and price_max > price_min)
 or (price_basis = 'from'  and price_min is not null and price_max is null)
 or (price_basis in ('on_request','not_quoted') and price_min is null and price_max is null))
);
```

Plus, on the same pattern: `kb_service_category`, `kb_staff_group` (replaces the three hardcoded buckets), `kb_staff_tier` (replaces «Мастер»/«1-р зэрэг»), `kb_staff` (with its own `confirmed_at`), `kb_hours`, `kb_contact_channel(kind, value, label, public)` where `kind ∈ ('phone','email','address','maps','facebook','instagram','website','booking')` — which removes the phone number that currently exists twice, in two formats, both reaching the prompt (`config/currentClient.js:107` `"+976 7741 7777"` vs `lib/salonBrain.js:41` `'7741-7777'`).

And `kb_faq(question, answer_text, answer_url, display_order)` — **`answer_text` and `answer_url` as separate columns**, because `config/currentClient.js:91` stores `<br><br><a href=… target="_blank">` inside the answer, which the website renders and `lib/messengerText.js` then strips back out. Store the fact and the URL; let a per-channel renderer decide markup.

#### 4.1.3 The typed rule tables — this is the "no special cases" proof

Every hardcoded rule in `lib/systemPromptBuilder.js` is an instance of one of eight kinds. Enumerating them is what makes onboarding client #3 a form.

| Rule kind | Table | Matrix row (from the ancestor) | GS Auto Center row |
|---|---|---|---|
| Clarify a dimension before quoting | `kb_clarifier(dimension_label, question_mn, applies_to_category[])` | `:131` staff tier; `:132` gender | vehicle make/model/year; petrol or diesel |
| Colloquial name maps to ≥2 entries | `kb_disambiguation(colloquial, service_id[])` | `:134` «Сор», «CICA» | «тос солих» → {хөдөлгүүр, хурдны хайрцаг} |
| Customer alias → catalogue name | `kb_service.aliases` | `:136` «гель маникюр» → «Гелэн будалт» | «шингэн солих» → «Хөргөлтийн шингэн солих» |
| Conditional amount at booking | `kb_policy(kind, selector, amount, currency, label)` | `:141-149` 20,000₮ master / 10,000₮ 1st-degree / manicure / pedicure | `kind='diagnostic_fee'`, or zero rows |
| Never quote; say this instead | `kb_refusal_topic` (§4.6) | `:135` + `lib/salonBrain.js:70-72` | bodywork estimates |
| Pinned verbatim strings | `kb_canned_response(key, text, reviewed_by, reviewed_at)` | `lib/salonBrain.js:52` `CLOSING_LINE`, `:57-59` `HANDOFF_REPLY`, `:63-65` `FALLBACK_REPLY`, `:79-81` `BOOKING_LINE` | its own — `BOOKING_LINE` hardcodes **QPay** and «урьдчилгаа төлбөр» today |
| Time-boxed override | `kb_closure` (§4.2.2) | `config/closures.js:40-52` Naadam | Tsagaan Sar |
| Free-form context | `kb_note(title, body, scope, display_order)` | eco products, parking | tow-truck availability |

Two things fall out and are worth stating flatly.

**`kb_staff_tier` being nullable is the whole answer to "does GS Auto fit?"** Matrix declares two tiers and three groups; GS Auto declares three groups and zero tiers. The renderer emits a tier heading only when tiers exist and a group heading only when groups exist. No branch, no `if (tenant === …)`.

**`price_basis = 'not_quoted'` is the general form of Matrix's children's omission.** A row can exist in the catalogue, be visible to the owner, and carry no price — and the renderer emits the refusal, not a blank. Strictly better than today, where the omission is achieved by the row not existing (`config/currentClient.js:34-35`) and is therefore invisible and uncheckable.

#### 4.1.4 Write-time validation: one shape, enforced

`types/clientConfig.ts:37-71` is decorative — no TypeScript in the toolchain, nothing imports it, and it models `logoUrl`/`brandColor` both flat *and* nested (`:38-47`), which is why every consumer defends against both shapes at runtime (`lib/systemPromptBuilder.js:56-63`). The successor has **one** shape, validated by a Zod schema at the write boundary, with the database constraints as a second line.

All applied on write, all rejecting rather than coercing:

- **NFC-normalise, trim, collapse internal whitespace** on every text field (§4.8), then `check (name is normalized)` so a direct SQL write cannot bypass it.
- **Prices are integers.** The form accepts «66000», «66,000», «66 000»; it rejects «66,000 – 88,000» in the min field with a Mongolian error and offers to split it into a range. The en-dash display form is produced by the *renderer*, never stored.
- **`price_max > price_min`** — the reversed range an owner will eventually type is caught at the form, not by a customer.
- **Uniqueness on `name_key`** per revision.
- **Every reference resolves.** A dangling group/tier/category blocks the publish; it does not drop the row.
- **Length ceilings in characters** (`Array.from(s).length`), with a separate byte ceiling where a channel limit is in bytes.

#### 4.1.5 Freshness is a stored fact, not an assumption — and it replaces a detector this design would otherwise delete

Review raised this and it is the strongest objection in either critique, so it gets its own subsection. Every failure mode in the first draft was about a publish that happened being wrong; none was about a publish that never happens. The old flow made the founder perform every price change by hand (`CLIENT_ONBOARDING.md:7-9`) — a terrible update flow and an *excellent* staleness detector, because the founder was structurally in the loop and could not not know. Replacing it with a self-serve dashboard removes the detector and replaces it with an owner who has no reason to log in. Freshness gets strictly worse at the exact moment onboarding gets better.

The harm is concrete and monetary, not cosmetic. `BOOKING_LINE` (`lib/salonBrain.js:79-81`) directs the customer to **pay a QPay deposit** before arriving. A stale price means an argument at the till over money already taken. A stale roster is worse: the bot names individual stylists and quotes their tier price (Messenger addendum, `lib/salonBrain.js:97`), so Батзаяа (`config/currentClient.js:20`) resigning in March means the bot takes prepaid bookings for her through June.

Three mechanisms, all data:

1. **`confirmed_at` on `kb_service` and `kb_staff`**, stamped by an edit *or* by an explicit no-op confirmation. `tenant.stale_after_days`, default **90**.
2. **A one-tap confirmation loop.** Monthly: «Үнэ хэвээрээ юу? [Тийм] [Өөрчлөх]». `[Тийм]` writes `confirmed_at = now()` across the revision — **no edit, no diff, no probes, no publish transaction, no new revision.** It is delivered in the dashboard *and* as a Messenger postback to the registered owner PSID (§4.5.4), reusing the same seam.
3. **A founder alert when a tenant's oldest `confirmed_at` crosses the threshold.** This is the alert path non-negotiable #6 already demands for scheduled *spend*, reused for scheduled *silence*.

The fourth mechanism — at 2× the threshold, degrading the bot's own behaviour so prices render behind the tenant's pre-reviewed hedge or `price_basis` drops to `on_request` — degrades the product and is therefore the founder's call (§4.10). Without something in that slot, staleness is unbounded and self-concealing: nothing in the design gets worse as the KB ages, which is why nobody will fix it.

---

### 4.2 The prompt is a build artefact, not a runtime render

#### 4.2.1 Snapshots

**Publishing a revision renders the prompt once, hashes it, and stores it.** The hot path — a Messenger webhook at 21:40 on a Saturday — does **one indexed row read**: no joins, no template evaluation, no `filter` over staff.

```sql
create table kb_snapshot (
  tenant_id      uuid not null,
  revision_id    uuid not null,
  variant        text not null,      -- 'open' | 'closure:<id>' | 'closure_generic'
  channel        text not null,      -- 'messenger' | 'instagram' | 'web'
  global_block   text not null,      -- platform-wide, tenant-independent
  tenant_block   text not null,      -- this tenant's KB, fully rendered
  prompt_hash    text not null,
  probe_baseline jsonb,              -- answers under THIS revision, for the diff panel (§4.5.5)
  allowed_numbers integer[] not null, -- precomputed for the output checker (§4.6.5)
  built_at       timestamptz not null default now(),
  primary key (tenant_id, revision_id, variant, channel),
  foreign key (tenant_id, revision_id) references kb_revision (tenant_id, id)
);

alter table tenant add column live_revision_id uuid;
alter table tenant add constraint tenant_live_rev
  foreign key (id, live_revision_id) references kb_revision (tenant_id, id);
```

**Snapshots are immutable.** A published revision's rows never change; a "change" is a new revision. So an in-process cache of the rendered prompt is safe **if and only if it is keyed by `(tenant_id, revision_id, variant, channel)`**. That single keying rule is the fix for `lib/salonBrain.js:142`, and it should be enforced by a CI grep the way `scripts/check-supabase-nostore.mjs` enforces the Next.js cache rule next door: no module-scope prompt state without a revision-keyed map.

**The prompt hash is the audit trail.** Every AI call logs `(tenant_id, revision_id, prompt_hash)`. If a customer complains they were quoted 55,000₮, you can prove which revision said so.

#### 4.2.2 Closures: pre-rendered variants, plus a runtime flag that needs no publish and no founder

Today `lib/salonBrain.js:150-155` evaluates `activeClosure()` per request and appends `buildClosureSection(closure)` *after* the cached block. The reasoning at `lib/salonBrain.js:139-141` is correct and must be preserved — a warm lambda can outlive the end of a break, and a cached section would keep announcing a holiday after the salon reopened — but it leaves a volatile tail hanging off the system prompt.

At publish, render one snapshot per configured `kb_closure` plus one for `open`. At request time compute `variant` from the tenant's own timezone as a pure function of an **injected clock**. The whole system block is then stable content, the break starts and ends on the salon's calendar with no human action, and the transition costs exactly one prompt-cache write. It is also testable with a fake clock — which the ancestor's suite cannot do: `tests/closures.test.js` reads the real clock and has been red since the shipped Naadam default (`config/closures.js:40-52`) expired on 2026-07-17.

**But the most time-critical thing a salon owner ever does is close the salon at short notice**, and the first draft put that behind founder review *and* a full publish transaction. A death in the family (funerary obligation in Mongolia is same-day and non-negotiable), a burst pipe, the master stylist in hospital — at 21:40 on a Saturday the bot must stop sending customers to matrixecosalon.org and telling them to pay a QPay deposit for appointments that will not happen. That is not a wrong answer; it is money taken that must be refunded by hand on a Sunday.

The ancestor already solved the linguistic half and the successor must not throw it away. **(verified)** `config/closures.js:92-95` `spokenDate()` renders `"7 сарын 18"` and is documented as *"used only by fallbackMessage, in a labelled position where no case ending is required"*; `config/closures.js:103-107` `fallbackMessage()` is *"deliberately free of date suffixes: the reopening date sits after a colon, where Mongolian needs no case ending, so this stays correct for any date"*; and `:127` wires it in as `message: raw.message || fallbackMessage(reopenDate)`. That is a pre-solved proof that a **parameterised** closure sentence is safe without per-instance review.

So the row splits into two classes and one runtime flag:

| Piece | Class | Effect |
|---|---|---|
| `kb_closure.starts_on` / `ends_on` / `is_closed` | **self-serve** | dates only, zero prose |
| `kb_closure.verbatim_message` (custom prose) | **review-required** | as before |
| `kb_canned_response['closure_generic']` | reviewed **once at onboarding**, in the `fallbackMessage` shape, with a `{{reopen_date}}` sentinel | always present, so a generic variant always exists |
| `tenant.closed_from` / `tenant.closed_until` | **runtime flag on the tenant row** | selects the pre-rendered `closure_generic` variant on the next inbound message |

The unplanned-closure path is then: one toggle, two dates, **no review, no probes, no `count_tokens`, no publish transaction, no founder** — effective on the next inbound message. The renderer substitutes `{{reopen_date}}` with `spokenDate()` output at read time and hashes the substituted result for the ledger. That substitution changes the prefix bytes, so it costs exactly one cache write per closure; closures are rare and that is the correct place to spend it. **The verbatim rule is not weakened: the flag selects a pre-rendered, pre-reviewed sentence — the model still never composes a closure sentence or inflects a date.**

---

### 4.3 Retrieval: whole-KB-in-prompt now, with a named trigger for change

#### 4.3.1 Measured sizes (executed in this checkout, 2026-08-31)

| Segment | Characters (code points) | UTF-8 bytes |
|---|---:|---:|
| Full base prompt, `await buildSystemPrompt(clientData)` | **7,818** | 12,866 |
| — Cyrillic 4,768 · Latin 527 · digits 507 | | |
| Rendered price list, 40 services | **≈1,245** (≈31.1 chars/service) | 1,853 |
| `MESSENGER_ADDENDUM` (`lib/salonBrain.js:86-106`) | **3,163** | 5,584 |
| **Messenger system prompt = the cached block** | **10,981** | 18,450 |
| `buildClosureSection` (only while a break is active) | +1,408 | — |

The base prompt is ~61% Cyrillic by character; the rest is structure, digits and URLs. Note for the record: the comment at `lib/salonBrain.js:23` calling the prompt *"~12.8k characters"* is wrong — 12,866 is the **byte** count of the base prompt alone. Character/byte confusion is already live in this codebase, which is why §4.8's rule about never interchanging them is a rule and not a nicety.

#### 4.3.2 Token count — an estimate, flagged as one, with the procedure to settle it

**I could not measure this.** No Anthropic API key, no tokeniser installed. Claude's tokeniser is byte-level BPE; English runs ≈4 chars/token (≈0.25 tok/char); Mongolian Cyrillic is 2 bytes/char in UTF-8 and is far less represented in BPE merge tables than Russian, so merges are shorter. The plausible band is **0.5–1.0 tokens per character** — 2× to 4× English per character. The commonly quoted "2–3×" sits inside that band and should be treated as the middle of a range, not a constant.

| | chars | @0.5 | @0.7 | @1.0 |
|---|---:|---:|---:|---:|
| Base prompt | 7,818 | 3,900 | 5,470 | 7,820 |
| **Cached Messenger block** | **10,981** | **5,490** | **7,690** | **10,980** |
| Price list, 40 services | 1,245 | 620 | 870 | 1,245 |
| Per service line | 31.1 | **15.6** | 21.8 | **31.1** |

**Working midpoint for this document: ~8,000 tokens for the cached block, ~22 tokens per service line.** Review correctly objected that the first draft then quoted derived numbers as if the band had collapsed. It had not:

| Derived claim | Honest range across the band |
|---|---|
| Catalogue headroom under a 12,000-token budget | **≈73 to ≈457 rows** (spine 9,736 chars → 4,870–9,740 tokens; remainder ÷ per-line) |
| GS Auto Center's 150 labour operations | 60% to **120%** of a 12,000-token budget — **at the pessimistic end tenant #2 does not fit** |
| Uncached cost per reply (Sonnet 5) | $0.0147 – $0.0257 |

*One correction to that objection:* it gave the headroom range as 171–548 rows by holding the spine fixed in tokens; the spine carries the same uncertainty as the catalogue, so the true range is wider and harsher — which strengthens rather than weakens the point.

**How to replace the estimate with a measurement today, writing no code:** the ancestor already logs it. `lib/salonBrain.js:243-253` prints `cache_read / cache_creation / uncached` from Anthropic's own `usage` object on every reply, with the comment explaining exactly why (*"a miss is invisible in the reply itself and would just quietly bill full price"*). **One line from a Vercel production log for the Matrix Page gives the exact token count of the current prompt. Do that before any of these figures sets a budget, a plan tier, or a price.** Second source: `POST /v1/messages/count_tokens` — free, no generation. Dala AI calls `count_tokens` at publish and stores the result in `kb_revision.est_tokens` with `est_token_source='count_tokens'`, so the number is a per-revision fact.

#### 4.3.3 The call: whole-KB in the prompt

**Whole-KB, for both launch tenants, and for any tenant under the ceiling in §4.3.4.** In order of weight:

1. **A retrieval miss on a small corpus is a worse failure than a large prompt.** With 40 services, the model reading all of them has a 100% recall floor. Retrieval buys a new failure class — the right row not retrieved, symptom "I don't have that information" about a service the salon plainly offers — to solve a problem you do not have.
2. **The refusal list and the pinned strings must never be retrieval-dependent.** A rule that is only in the prompt when a retriever decided the question was about children's haircuts is absent precisely when the retriever misfires. These stay in the prefix unconditionally, at every corpus size.
3. **Prompt caching makes the size nearly free** at any traffic level worth having (§4.4).
4. **Cross-item reasoning is the dominant query shape.** "Оюунсүрэнд цаг авъя" joins roster → tier → price list; the addendum spells this out at `lib/salonBrain.js:97`. Retrieval over service rows returns the price and not the roster.

#### 4.3.4 The trigger for changing — named, with numbers

Per-tenant `kb_prompt_token_budget`, **set from the first `count_tokens` measurement, not from the estimate**; a provisional default of 12,000 tokens until that measurement exists. **Publishing refuses if `est_tokens` exceeds it.** A refusal is the point: it stops the system without depending on a read that could be stale — the reasoning that made `BANK_BUILD_BUDGET_USD = 0` next door.

Move to retrieval when **any one** of these holds for a tenant:

- **(T1) Size.** `count_tokens` at publish exceeds the budget and the founder does not want to trim. On present estimates this can fire on **tenant #2**, which is a reason to measure before GS Auto onboards, not after.
- **(T2) Economics, denominated in dollars.** The first draft set this at "cache hit rate below 50%", which review is right to reject as an unfounded constant. The break-even hit rate is `h* = (w−1)/(w−0.1)` (§4.4.3): **21.7% at a 1.25× write multiplier, 52.6% at 2×.** A tenant at 40% is caching profitably under a 1.25× write and the old rule would have shipped them to an embedding vendor. *Partial defence of the objection's target:* 50% is nearly exactly right for a 2× write, so the fault is that a function of `w` was written down as a constant. Replace the ratio with a dollar test: **retrieval fires when the measured monthly prefix spend for that tenant exceeds `tenant.retrieval_trigger_usd`.** At a 12,000-token capped prefix and 600 replies/month, moving to retrieval saves ≈$0.010/reply ≈ **$6/tenant/month** — against a second API key, a second hot-path failure mode, and a re-embed step in the publish pipeline. Six dollars does not buy that.
- **(T3) Quality.** The Quality layer's unanswered-question rate rises for that tenant as the KB grows. The only one of the three requiring judgement.

#### 4.3.5 The migration path when a trigger fires — hybrid, not a rewrite

```
ALWAYS IN THE CACHED PREFIX (never retrieved):
  identity, staff roster + groups + tiers, hours, contact channels,
  policies (deposits, clarifiers, disambiguations), canned responses,
  refusal topics, closures, notes, and the TOP-N services by 90-day
  query frequency (N sized to fill the budget)

RETRIEVED PER TURN, INSERTED INTO `messages` (never the prefix):
  the long tail — at most K rows, rendered by the SAME renderer, so
  formatting never diverges between the two paths
```

Retrieved rows go into the **messages array, after the cached prefix**, so the prefix stays byte-stable and the cache still hits. Retrieved content in the system block would invalidate the cache every turn and cost more than the whole-KB approach it replaced.

**Retrieval order: deterministic first, embeddings last.** Service names are a closed vocabulary the tenant controls.

1. **Exact match on `name_key` and `aliases`** — resolves "Гелэн будалт хэд вэ" instantly.
2. **Trigram (`pg_trgm`) over `search_key`**, i.e. `fold(name_key)` with the layout map `ө→о, ү→у, й→и, ё→е` (§4.8.3). This matters: on Cyrillic, `similarity('үс засалт','ус засалт') = 0.538` but `similarity('өнгө','онго') = 0` — trigram collapses when every character differs, which is exactly the layout error. Folding first restores it.
3. **Embeddings** — only for descriptive queries naming no service ("үс минь эвдэрсэн, юу хийлгэх вэ").

**Embeddings, concretely.** Anthropic ships no embedding model, so this is a second vendor and a second spend surface. Candidates: Cohere `embed-multilingual-v3.0`, OpenAI `text-embedding-3-large`, Voyage `voyage-3`. *Assumed, not verified:* all three are weak on Mongolian specifically — it is low-resource in every published evaluation I am aware of and none list it as supported. **Benchmark before committing:** 100 real Mongolian customer questions from Matrix's history, labelled with the correct service row, recall@5 against the folded-trigram baseline. If embeddings do not beat trigram on that set, do not add the vendor. *I cannot verify current embedding prices from this environment — confirm before quoting a figure to anyone.*

**pgvector sits in the same Supabase Postgres.** The trap: an HNSW scan with a *post*-filter on `tenant_id` can return zero rows for the correct tenant when the top-k neighbours all belong to other tenants — a silent, plausible-empty, cross-tenant-shaped failure, the exact class this project distrusts. *Assumed, needs verification against the pgvector version Supabase ships:* ≥0.8 supports iterative index scans that make filtered search reliable. Until verified, use per-tenant partial indexes or a pre-filtered subquery, and add a test asserting that a tenant with few rows still gets them back when other tenants have many.

**The invariant that must survive retrieval:** if retrieval returns nothing, the model gets `HANDOFF_REPLY` (`lib/salonBrain.js:57-59`), never a licence to improvise, and every empty retrieval is logged to the Quality layer as an unanswered question.

---

### 4.4 Prompt caching as the central cost lever

#### 4.4.1 Prefix layout and where the breakpoints go

Anthropic's cache is prefix-based, ordered **tools → system → messages**; everything before a `cache_control` breakpoint is one entry keyed by its exact content.

```
tools:      [ tenant-stable tool definitions, if any ]        ── must be byte-stable
system: [
  block 0:  PLATFORM GLOBAL BLOCK                             ── cache_control ①
            language-quality rules, channel rules, output
            format, the "never invent a price" invariant
  block 1:  TENANT KB BLOCK  (kb_snapshot.tenant_block)       ── cache_control ②
            refusal gate · identity · staff · catalogue ·
            policies · canned responses · FAQs · hours ·
            contact · notes · closure variant
]
messages: [ …history…, {role:'user', content:'[огноо: …]\n<customer text>'} ]
                                                              ── NEVER cached
```

**Two breakpoints, not one.** Entry ① is `[global]`, shared by every tenant on the platform *within one model cohort*; entry ② is `[global + tenant]`. On a tenant-cache miss you pay the write only for the tenant delta and read the global part at 0.1×.

**Corrections review is right about, both folded:**

- The saving is **17.25%, not 9%**: `1,500×0.1 + 6,500×1.25 = 8,275` versus `8,000×1.25 = 10,000`. The draft's 9% does not reproduce from its own inputs.
- **On a Haiku-tier tenant the saving is zero, silently.** Haiku 4.5's minimum cacheable prefix is 4,096 tokens; breakpoint ① sits at ~1,500 cumulative tokens, so `cache_control` ① is ignored with no error. Since §4.4.4 puts small tenants on Haiku by plan, the optimisation was claimed for cold tenants and void for exactly that cohort. **The publish check must validate each breakpoint's *cumulative* prefix length against the tenant model's minimum, not the snapshot total** — and emit no breakpoint ① when the model minimum exceeds the global block. The first draft's failure mode #15 tested the total and would not have caught this.
- Cache entries are scoped per model (and per organisation), so "① is essentially always hot" holds only within a cohort. Split Haiku/Sonnet tiers and the Haiku global block is warmed only by the low-traffic tenants — the opposite of the argument being made for it.

The ancestor gets the important half right for the right reason. `lib/salonBrain.js:208-215` places the single breakpoint at the end of the system prompt with the comment that *"`messages` (this customer's own history) stays outside it and is never written to the cache."* **Carry that verbatim.** A customer's message inside an entry every other customer of that Page reads is a data-protection incident, not a performance regression.

#### 4.4.2 What must NOT be in the prefix

Each of these will be proposed by someone eventually:

- **Customer name, PSID, IGSID, profile data.**
- **Timestamps, "today is …".** Note a live gap: `lib/systemPromptBuilder.js:183` instructs the model to use «Маргааш» correctly and **the prompt contains no date anywhere**, so it cannot. The fix is to inject the date — bracketed, **in the final user message**, never in the system block.
- **Conversation id, `mid`, request id, trace id.**
- **Anything the Quality layer computes per turn.**
- **Rate-limit or budget state.**
- **A per-request tool definition.** Tools precede system in the prefix, so a tool schema carrying a conversation id breaks the entire cache — the most expensive possible place for a variable.

#### 4.4.3 The economics, worked — with the break-even stated as algebra

Sonnet 5 ($2.00/MTok in, $10.00/MTok out). Cache read = 0.1× = $0.20/MTok; cache write (5-minute TTL) = 1.25× = $2.50/MTok. Messages ~600 tokens + output ~250 tokens = $0.0037 fixed tail.

| Per reply | prefix 5,500 tok | prefix 8,000 tok | prefix 11,000 tok |
|---|---:|---:|---:|
| No caching | $0.0147 | $0.0197 | $0.0257 |
| Cache **write** (miss) | $0.0175 | $0.0237 | $0.0312 |
| Cache **read** (hit) | $0.0048 | $0.0053 | $0.0059 |

A hit is **3.1×–4.4× cheaper**; a miss is **~20% more expensive across the whole band** — the absolute cost carries the token uncertainty but the ratio does not.

**Break-even, which the first draft never derived.** Prefix cost relative to uncached is `0.1h + w(1−h)`; setting it to 1 gives

> **h\* = (w − 1) / (w − 0.1)**  →  **21.7% at w = 1.25**, **52.6% at w = 2.0**

Expressed in run length instead: an entry must serve `N ≈ 1.28` messages at 1.25×, `N ≈ 2.11` at 2×. The hit-rate form is the useful one because it is a field the ledger already stores; the run-length form is not measurable.

**⚠️ A pricing caveat that must be verified before this sets policy.** The brief gives "cache write ~1.25×" without distinguishing TTL. My understanding is that the **1-hour** TTL carries a **2×** write multiplier — *and I could not verify it here.* It moves `h*` from 21.7% to 52.6%, and it makes a 1-hour miss **81% more expensive** than no caching (not the 60% the first draft asserted: $0.0357 vs $0.0197). It also means the ancestor's own reasoning at `lib/salonBrain.js:26-33` — which assumes *"each miss costs 1.25x to rewrite"* while choosing the 1-hour TTL — is arithmetically wrong for the option it chose. (Its "~89% / ~69% of current spend" figures imply hit rates of ~33% and ~50%, which are not mutually consistent under any single arrival distribution; the *direction* of its conclusion survives, the percentages do not.) **Re-derive against the current published price sheet.** The design accommodates either answer by making TTL a per-tenant field.

#### 4.4.4 TTL: the default is `1h`, not `5m` — the first draft had this backwards

Review is right and I am folding the correction wholesale. Modelling arrivals as Poisson over a 12-hour business day, a message hits if the gap since the previous one is under the TTL, so `P(hit) = 1 − e^(−TTL/mean gap)`. Relative **prefix** cost is `0.1h + w(1−h)`:

| msg/day | mean gap | 5m hit | 5m @1.25× | 1h hit | 1h @1.25× | 1h @2.0× |
|---:|---:|---:|---:|---:|---:|---:|
| 5 | 144 min | 3% | 1.21 | 34% | 0.86 | 1.35 |
| 10 | 72 min | 7% | 1.17 | 57% | 0.60 | 0.93 |
| **20** | **36 min** | **13%** | **1.10** | **81%** | **0.32** | **0.46** |
| 40 | 18 min | 24% | 0.97 | 96% | 0.14 | 0.17 |
| 200 | 4 min | 75% | 0.39 | 100% | 0.10 | 0.10 |

The 1-hour TTL beats uncached above **≈3 msg/day at w=1.25** and **≈9 msg/day at w=2.0**; the 5-minute TTL does not break even until ≈35 msg/day. Defaulting a new tenant to `5m` picks the one setting on the menu that loses money at low volume. The ancestor already worked this out and chose `1h` for exactly this reason (`lib/salonBrain.js:26-33`, verified: *"what matters is the gap between ANY two messages the Page receives … those gaps are mostly 5-30 minutes: a 5-minute entry expires between most messages"*).

**`tenant.prompt_cache_ttl ∈ ('none','5m','1h')`, default `1h`.** Demote to `none` only when the *measured* hit rate falls below `h*` for the applicable `w`. `none` remains a real, correct setting for a tenant receiving a handful of messages a day. Keep `5m` off the default path.

*One framing correction the first draft got wrong and review caught:* adding small tenants does not degrade any existing tenant's cache economics — each tenant's arithmetic depends only on its own arrival rate. The correct statement is that **caching economics are per-tenant and gain nothing from platform scale**, which is a milder and more accurate claim.

**Model tier is a per-tenant-plan field**, not a module constant as at `lib/salonBrain.js:19` (and note the website path's `'claude-haiku-4-5-20251001'` at `api/chat.js:13` carries a date suffix that should not be there). On Haiku, `cache_control` below 4,096 tokens is ignored with no error and the only symptom is `cache_read = 0` forever — so the publish pipeline checks **each breakpoint** against the model minimum and warns loudly (§4.4.1).

#### 4.4.5 Observability, and reserve-before / settle-after

A cache miss is invisible in the reply and quietly bills full price. Persist the counts per tenant:

```
ai_call_ledger(tenant_id, conversation_id, revision_id, prompt_hash, model,
               reserved_usd, cache_read_tokens, cache_creation_tokens,
               uncached_input_tokens, output_tokens, usd_cost, created_at)
```

Review raises a real tension with non-negotiable #5 ("charged against that tenant's ceiling BEFORE it is made"): the cost of a call is not knowable before it is made — **$0.0053 on a hit vs $0.0237 on a miss is a 4.5× spread on the dominant term**, and a burst of concurrent inbound messages all clear the same stale balance. The resolution is **reserve at the miss price, settle to actual from `usage` after the call.** `reserved_usd` is written before the upstream call; `usd_cost` replaces it from the response. The check still fails closed and still returns 503 on any error — it simply refuses to under-quote itself.

Because rows carry `revision_id` and `prompt_hash`, a spike in `cache_creation_tokens` is attributable to a publish in one `group by`, and the per-tenant 30-day hit rate driving §4.3.4's T2 and §4.4.4's TTL choice is one query away.

#### 4.4.6 What these ceilings are NOT — the gap this section must not paper over

Review's sharpest cost finding: **every ceiling named in this section is a publish-time or preview-time gate. None of them is a runtime spend control.** `kb_prompt_token_budget` is a *size* gate. The preview cap bounds the dashboard. Neither notices that a tenant is spending too much right now. At this section's own per-reply prices:

| Path | Volume | Cost |
|---|---|---|
| Scripted sender, 1 msg/sec | 3,600 replies/hr | **$19/hr, $458/day** |
| Scripted sender, 1 msg/10s (human-plausible) | 360/hr | $1.91/hr, $46/day |
| One viral post → private replies to 3,000 comments | 3,000 one-shot generations | **~$16 in an afternoon** |
| Retry storm | 500-message backlog | **$10.60 for 500 answers** |

The retry row is not hypothetical: `MAX_RETRIES = 3` (`lib/messengerQueue.js:13`, verified) and `lib/messengerProcess.js:101-105` **rethrows into the generation path** — a transient Anthropic 529 burns four *generations* per message. And note that Meta's own per-thread throttle does not protect you, because generation happens *before* the send.

None of this is §4's to build — it belongs to the chokepoint guard — but §4 must not imply otherwise, and it must name the three controls it depends on:

1. **A per-conversation reply cap and a per-tenant rolling-hour token ceiling**, checked before generation in the same fail-closed order (identity → entitlement → budget), with `HANDOFF_REPLY` as the over-cap response — a reviewed string that costs $0.
2. **Retry re-sends the stored reply; it does not re-enter generation.** The reply was already paid for.
3. **Two ceilings, not one.** `customer_facing_usd` and `operator_facing_usd`. Preview probes and Quality-layer proposal runs draw only from the operator bucket. Otherwise a Saturday afternoon of price editing can silently exhaust the budget Reception AI needs at 18:00 the same day.

---

### 4.5 The owner update flow

#### 4.5.1 Who this person actually is

The owner of Matrix Eco Salon, on an Android phone, in Mongolian, between clients. She will not open a laptop, will not learn a schema, and if the flow takes more than about ninety seconds she will phone the founder instead — which is the outcome to design against, because it is what happens today. *(Review identifies her as Оюунсүрэн, the Мастер үсчин at `config/currentClient.js:18`, inferred from the Gmail address at `:108`; that identification is an inference, not a verified fact, and the design does not rest on it — what matters is that the login-holder is a working stylist with her hands in someone's hair for ninety minutes at a stretch, not a desk worker.)*

#### 4.5.2 Getting in — the step every flow starts with, and the one the first draft assumed away

The first draft said "a magic-link or phone-OTP login via Supabase Auth" in a single clause and listed no failure mode for it. Neither channel is established for Dala AI: **SMS is gated on the Mongolian SIP trunk that does not exist**, and email is the sibling's precise scar — Brevo returns **2xx and silently drops** a send from an unauthenticated domain (`CLAUDE.md`, 2026-08-25), producing a login that fails with no error on either side.

*Where I part company with the objection:* that scar is about the **sender domain**, which Dala AI controls from day one — send from the DKIM/SPF-authenticated apex (`dalatech.online`, never a subdomain), log the provider `messageId` on every send, and treat 2xx as "accepted", never "delivered". Email magic-link is usable. What it cannot be is the **only** path at 21:40.

So the routine path requires no delivery at all:

- **The session is established once, in person, on her actual phone, at onboarding, with the founder present.** 90-day sliding refresh; `tenant.owner_session_last_seen` tracked; the founder re-establishes it **proactively before it lapses**, not at the moment she needs it.
- **Delivery-based login is the recovery path, not the daily one**, and its failure gets a row in §4.9 with an alert path that is not email.

**And this is where the multi-tenancy test is actually at risk.** The two moments that matter most — an unplanned closure and a failed login, both at night, both urgent — were both routed through the founder in the first draft. If the realistic path for anything time-critical is "phone the founder", then onboarding client #3 is not filling in a config; it is acquiring a third source of 9pm phone calls. The config-vs-code test is passed on the **provisioning** axis and was being failed on the **operating** axis, and the operating axis is the one that recurs forever. §4.2.2 and this subsection are the two fixes.

#### 4.5.3 Roles — three, not one

The first draft admitted exactly one publisher (`owner`) while `kb_change.actor_kind` already listed `'staff'` — attributable and powerless. The person who *knows* the KB changed is usually the front desk: they took the call where a stylist resigned, they printed the new list.

| Role | Can | Cannot |
|---|---|---|
| `staff` | edit the draft revision; run the freshness confirmation | publish |
| `owner` | everything `staff` can, plus publish the **self-serve** class; toggle the closure flag | publish the review-required class |
| `founder` | everything, plus the review-required class and all `kb_proposal` decisions | — |

Owner approval of a staff edit is a single tap on the diff.

| Class | Fields | Publisher |
|---|---|---|
| **Self-serve** | prices, durations, hours, staff roster, groups/tiers, categories, FAQ text, notes, contact values, closure **dates** and the closed flag | `owner` |
| **Review-required** | every `kb_canned_response`, every `kb_refusal_topic`, `kb_closure.verbatim_message` (custom prose only), the booking link and payment language, the escalation phone | `founder` |

The reason for the second class is recorded in the ancestor and is not bureaucratic: `lib/salonBrain.js:48-51` (verified) explains the canned lines exist *because* live replies contained garbled Mongolian and an invented Russian word (`дополнительн`), and each was native-speaker reviewed for that exact prompt. Editing a reviewed string clears `reviewed_by`/`reviewed_at` and blocks the publish until re-reviewed. That answers the ancestor research's open question about re-review mechanically: **the review is a column.**

#### 4.5.4 The channels — one primary, three supporting, two rejected

**PRIMARY — a mobile-first web dashboard in Mongolian.** Not an app. One field per screen, large touch targets, autosaving drafts, the price as a single tappable number. The only path that can carry authentication, validation, preview, attribution and audit.

**SUPPORTING — CSV / spreadsheet import, one-way.** Every salon and garage in UB has its price list in a sheet or a photo. Paste or upload, map columns, show what parsed alongside what will be discarded, land it **in the draft** under the identical validation. Import is not a sync; the sheet is never authoritative.

**SUPPORTING (v1) — Messenger postback proposals from a pre-registered owner PSID.** The owner is in Messenger every day anyway. The ancestor already has both primitives: `sendMessengerButtons` (`lib/messengerClient.js:145`, verified) and `messaging_postbacks` already in the subscription set (`MESSENGER_SETUP.md:62`, verified) — so this needs **no new permission and no App Review delta**. Restricted to three kinds — `confirm_freshness`, `set_staff_inactive`, `update_price` for one named service — confirmed by a **postback button and never by parsing free-form Mongolian**, which §4.8.4 forbids outright. The button is not a convenience; it is the only compliant form. «Батзаяа ажиллахаа больсон уу? [Тийм] [Үгүй]» is one tap, no login, no dashboard, no typing. It creates a `kb_proposal` with `source='owner_message'`; it does not publish.

**SUPPORTING (Phase 2) — a photo of the printed price list**, extracted by the Quality layer into a **proposal**, never a publish. An AI call, therefore metered against the operator bucket before it is made.

**REJECTED — a Google Sheet as source of truth.** Tried in this very codebase and abandoned: `MATRIX_IMPLEMENTATION.md:4` describes a system that *"dynamically fetches service prices from a Google Sheets CSV file"*, `types/clientConfig.ts:57` still carries an orphaned `googleSheetUrl?: string`, and the live config has **no `googleSheetUrl` at all**. A shared link is an unauthenticated write path; edits carry no trustworthy attribution; there is no validation (nothing stops `"66,000 – 88,000"` in a numeric field — precisely how that string reached `config/currentClient.js:38`), no preview, no approval, no rollback; and a fetch in the request path adds an upstream dependency to the hot path.

**REJECTED as a write path — free-form messages to the bot ("үнэ 70000 болголоо").** A PSID is not proof of ownership; parsing free-form Mongolian commands is the unanchored-regex trap in its purest form; a misparse writes a wrong price to production. The postback form above is the acceptable version.

#### 4.5.5 The flow

```
  ┌───────────┐  edit    ┌──────────┐ validate ┌─────────┐  publish  ┌─────────────┐
  │ live rev  │────────▶ │  DRAFT   │────────▶ │  VALID  │─────────▶ │ rev 13 LIVE │
  │  (seq 12) │  (rows)  │ (seq 13) │ (zod+db) │  DRAFT  │           └──────┬──────┘
  └───────────┘          └──────────┘          └─────────┘                  │
        ▲                                                                   ▼
        │  rollback = clone rev N into draft, publish as rev 14   blast-radius probes
        └──  (FORWARD-ONLY: the pointer never moves back)          run AFTER publish
```

**1. Edit.** All edits land in the single draft (`kb_revision_one_draft` guarantees exactly one). Autosaved. Two editors are handled by optimistic concurrency on the draft, showing "Х has changed this since you opened it" rather than last-write-wins.

**2. Validate** — per field, immediately, in Mongolian (§4.1.4). Publish stays disabled while any error stands.

**3. Diff** — field-level, in Mongolian, in business language: «Эмэгтэй тайралт (Мастер): 66,000 – 88,000 → 70,000 – 92,000». Not a JSON diff. This is free and always shown.

**4. Probes — moved off the critical path.** The first draft ran ~12 model calls before every publish and showed the owner twelve pairs of Mongolian paragraphs to compare on a phone. Review is right that she will not read them: she will tap through, and failure mode #19's "publish without probes" escape is the route she learns on day two. Worse, it makes editing feel slow and expensive, which feeds the staleness problem of §4.1.5. And the cost was real — **recomputed: $0.118 per side-by-side preview of 12, $35/month at the stated cap of 10/day**, drawn from the same budget that answers customers, with the draft-side cache write wasted outright whenever the draft is never published.

*One line of disagreement:* the objection says probes "buy zero safety". They buy zero safety **for the self-serve class**; they buy real safety for the founder-reviewed class, where someone sits at a desk and reads them. So they are scoped, not deleted:

- **Self-serve class:** publish immediately. Probes run **asynchronously after publish**, scoped to blast radius — the probes whose question text matches the changed rows' `name_key`/`aliases`, typically one to three, not twelve. The "before" panel is free because `kb_snapshot.probe_baseline` stored the previous revision's answers at *its* publish. And because the probes run against the newly-live prefix, their cache write is the one the first real customer would have paid anyway — **marginal cost ≈ $0.008, versus $0.118**. If a post-publish probe answer contains a figure outside `kb_snapshot.allowed_numbers` (§4.6.5), or a refusal topic fires differently than before, the revision is flagged and the founder alerted.
- **Review-required class:** blocking pre-publish probes, as before. Capped in **dollars** (`tenant.preview_budget_usd`), not in counts, and drawn from the operator bucket. The ledger is consulted before the calls and returns 503 on error — never `try { check() } catch { continue }`.

**5. Publish** — one transaction, with **`count_tokens` outside it**:

```
-- BEFORE the transaction (network allowed here, and only here):
render snapshots (one per variant × channel)
POST /v1/messages/count_tokens  → est_tokens, est_token_source='count_tokens'
   on unavailability: est_tokens = chars × (this tenant's measured chars-per-token
   from ai_call_ledger) × 1.2 ; est_token_source='ratio_fallback'

BEGIN
  publish-time invariants (§4.6.4, §4.9) — any failure aborts everything
  freeze draft → 'published', assign seq, compute content_hash, stamp publisher
  insert kb_snapshot rows (including 'closure_generic'), precompute allowed_numbers
  refuse if est_tokens > kb_prompt_token_budget
  per-breakpoint minimum check against the tenant's model (§4.4.1)
  flip tenant.live_revision_id
  clone a fresh draft forward
  write kb_change rows for every differing field
COMMIT
```

Review is right that a third-party network call inside `BEGIN…COMMIT` is wrong twice over: it holds a Postgres transaction across an internet round trip, and — the owner-facing half — a brief Anthropic outage at 21:40 would fail a price change atomically with a Mongolian error about a token budget she has never heard of. **A token count is a size gate, not a spend gate; failing it closed puts the cost on the salon rather than on the founder's bill.** Hence the ratio fallback, recorded in `est_token_source` so a budget decision is never quietly made on an estimate. Publish itself stays all-or-nothing: a half-applied KB is the multi-table partial-migration failure that bit the sibling, reproduced at runtime.

**6. Rollback is forward-only.** "Revert to the version from 12 August" clones revision N's rows into the draft and publishes them as N+2. The pointer never moves backwards, no revision is ever mutated, the audit log reads as a straight line, and `ai_call_ledger.revision_id` never dangles.

#### 4.5.6 Propagation: how fast, and why a stale prefix cannot happen

**Latency from publish to live: the next inbound message.** The webhook reads `tenant.live_revision_id` and the matching `kb_snapshot` row — one indexed read. There is no TTL to wait out because there is no time-based cache in this path.

| Where a stale prompt could hide | Closure |
|---|---|
| **In-process (warm lambda)** — the `lib/salonBrain.js:142` bug | Keyed by `(tenant_id, revision_id, variant, channel)`. A published revision is immutable, so a hit on that key is current by definition, and a new revision is a new key. CI grep for module-scope prompt state. |
| **Redis**, if a snapshot is cached for latency | Same composite key. Nothing is ever keyed by `tenant_id` alone. |
| **Anthropic's prompt cache** | **Cannot go stale by construction** — the key *is* the prefix content. No purge API needed. Publishing costs one cache write per (tenant, variant, channel) in use: ~$0.02 at 8,000 tokens on Sonnet 5. Ten publishes a day ≈ twenty cents. |
| **Next.js route handlers** | The snapshot read goes through a Supabase client constructed with `cache: 'no-store'`. A `GET`-only route handler caches every Supabase read for a **year** and `export const dynamic = 'force-dynamic'` does not stop it. Port `src/lib/supabase/fetch.ts` and `scripts/check-supabase-nostore.mjs` on day one; here the hazard is a snapshot or channel-binding read returning a stale *other tenant's* value. |

**Scheduled publishes** (`kb_revision.publish_at`) are low-risk — the job flips a pointer and touches no upstream API — but still need an alert path, because the symptom of failure is "the new price never went live" and nobody notices for a week.

#### 4.5.7 A change mid-conversation

Customer asks a price at 14:02; the owner publishes a new one at 14:04; the follow-up arrives at 14:06.

**The new revision wins. Correctness beats consistency** — continuing to quote a withdrawn price is the worse outcome, because it is a price the salon must honour or argue about. But it must not be silent: `message.revision_id` is stamped on every turn, and a conversation whose turns straddle revisions **where a currency figure appeared under the earlier one** is flagged to the Quality layer as `revision_straddle`. The founder sees "this customer was quoted 66,000₮ then 70,000₮ in one conversation" and decides whether to reach out. A review item, not an automated apology.

#### 4.5.8 The freshness loop, end to end

`confirmed_at` (§4.1.5) → `tenant.stale_after_days` crossed → founder alert **and** a one-tap prompt delivered on both the dashboard and the Messenger postback channel → `[Тийм]` writes `confirmed_at` with no revision, no probes, no cost; `[Өөрчлөх]` deep-links into the edit screen. Ninety seconds is the budget for the whole interaction, and the `[Тийм]` path is two.

---

### 4.6 The "never say this" list

#### 4.6.1 What it generalises

Matrix's children's-haircut omission (`config/currentClient.js:34-35`; `lib/systemPromptBuilder.js:135`; `CHILDREN_REPLY` at `lib/salonBrain.js:70-72`; reinforced in the Messenger addendum) is one instance of a general product concept: **a topic the business will not price or discuss through the bot, where the correct behaviour is a fixed sentence and a human handoff.** GS Auto's version is bodywork estimates. Every tenant will have at least one.

#### 4.6.2 The data

```sql
create table kb_refusal_topic (
  tenant_id uuid not null, revision_id uuid not null, id uuid not null,
  topic_key          text not null,
  label_mn           text not null,
  trigger_examples   text[] not null,      -- 5–15 REAL customer phrasings, NFC
  forbidden_outputs  text[] not null,      -- the specific WRONG answers, OBSERVED
  verbatim_response  text not null,        -- exact reply, NFC, reviewed
  allow_price        boolean not null default false,
  escalation_channel uuid not null,        -- FK → kb_contact_channel (the phone)
  reviewed_by        uuid not null references app_user(id),
  reviewed_at        timestamptz not null,
  active             boolean not null default true,
  primary key (tenant_id, revision_id, id),
  foreign key (tenant_id, revision_id) references kb_revision (tenant_id, id),
  foreign key (tenant_id, revision_id, escalation_channel)
    references kb_contact_channel (tenant_id, revision_id, id),
  constraint examples_nonempty  check (cardinality(trigger_examples)  >= 3),
  constraint forbidden_nonempty check (cardinality(forbidden_outputs) >= 1)
);
```

Matrix's row, populated from what is already in the code plus what has been observed:

```
topic_key         : 'children_services'
label_mn          : 'Хүүхдийн үйлчилгээ'
trigger_examples  : {'хүүхдийн үс засалт хэд вэ','хүүхэд авчирвал болох уу',
                     '5 настай хүүхдийн үс','хүүхдийн тайралт','хүүхэд засуулах'}
forbidden_outputs : {'ойролцоогоор','хагас үнэ','насанд хүрэгчдийн үнийн тал хувь',
                     'Та хүүхэд үү, том хүн үү?','магадгүй 20,000₮ орчим'}
verbatim_response : 'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.
                     Та салоны 7741-7777 дугаараар холбогдож лавлана уу.'
allow_price       : false
```

#### 4.6.3 Rendering — the boundary-hardening technique, applied

This is the direct application of the technique in `/home/user/dalatech-english/docs/plan-2026-08-24-quiz-bank-and-chat-bakeoff.md` (§"The technique that worked", ~line 1020), whose finding was measured: Sonnet failed 7/7 under a rule that *described* the right answer and went to 3/3 under one that **named the specific wrong openings as forbidden**.

> **A rule that only describes the right answer loses to a model's disposition; a rule that forbids the specific wrong answer does not.** That requires having *seen* the failure — the argument for measuring before hardening.

Two changes took it from 0/3 to 3/3: **promote the rule to a first-line gate with an explicit decision step**, and **name the observed failure outputs as forbidden, with a worked wrong-example.**

The ancestor is halfway there and which half is instructive. `lib/systemPromptBuilder.js:135` is rule 7 of 8, buried and purely descriptive. The Messenger addendum line is better: it forbids a specific wrong behaviour (*«том хүн үү, хүүхэд үү» гэх мэт асуулт БҮҮ асуу*) and pins the reply letter-for-letter. Someone watched the model fail and hardened against that failure. **That instinct is the product feature; make it the schema.**

The renderer emits refusal topics **first inside the tenant block, before the catalogue**, as a gate:

```
=== ХАРИУЛАХГҮЙ СЭДЭВ (ЭНЭ ХЭСЭГ БУСАД БҮХ ЗААВРААС ДЭЭГҮҮР) ===
АЛХАМ 1. Хэрэглэгчийн СҮҮЛИЙН мессежийг эхлээд шалга: доорх сэдвүүдийн
аль нэгэнд хамаарах уу?

СЭДЭВ: Хүүхдийн үйлчилгээ
  Ийм төрлийн асуултууд: «хүүхдийн үс засалт хэд вэ» · «хүүхэд авчирвал
  болох уу» · «5 настай хүүхдийн үс» · «хүүхдийн тайралт» · «хүүхэд засуулах»
  ХАМААРВАЛ: ямар ч тоо, ямар ч үнэ, ямар ч хүрээ БҮҮ хэл. Доорх өгүүлбэрийг
  нэг ч үсэг өөрчлөхгүйгээр яг хэвээр нь бич:
  «Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.
   Та салоны 7741-7777 дугаараар холбогдож лавлана уу.»
  ЭДГЭЭРИЙГ ХЭЗЭЭ Ч БҮҮ БИЧ (буруу хариултын жишээ):
    ✗ «ойролцоогоор …»   ✗ «хагас үнэ»   ✗ «магадгүй 20,000₮ орчим»
    ✗ «насанд хүрэгчдийн үнийн тал хувь»  ✗ «Та хүүхэд үү, том хүн үү?»
  Насанд хүрэгчдийн үнээс тооцоолж БҮҮ гарга. Тодруулга БҮҮ асуу.

АЛХАМ 2. Аль нь ч хамаарахгүй бол доорх зааврын дагуу хэвийн үргэлжлүүл.
```

Three properties the ancestor's rendering lacks: it is **first**, it has an **explicit two-step decision**, and it carries **worked wrong examples** from `forbidden_outputs`.

**Where `forbidden_outputs` comes from is the operational heart.** It cannot be invented at the form — hardening works because it names failures you have observed. So the Quality layer feeds it: every reply the §4.6.5 checker suppresses or flags becomes a candidate `forbidden_output`, presented to the founder as a one-tap "add this to the never-say list". The list gets stronger from its own failures, which is the only mechanism that scales past the founder's imagination.

#### 4.6.4 The publish-time invariant — the omission must actually be an omission

Today the exclusion holds only because nobody has added a children's price, recorded solely as a comment. Make it a check inside the publish transaction:

```sql
select s.name, r.topic_key
from kb_service s
join kb_refusal_topic r using (tenant_id, revision_id)
where s.active and r.active and not r.allow_price
  and s.search_key like any (
        select '%' || fold(lower(normalize(e, NFC))) || '%'
        from unnest(r.trigger_examples) e );
```

A hit aborts the publish with: «"Хүүхдийн тайралт" гэсэн үйлчилгээ нэмэгдсэн боловч "Хүүхдийн үйлчилгээ" сэдэв хаалттай хэвээр байна. Аль нэгийг нь сонгоно уу.» The owner resolves the contradiction instead of shipping it. **This check runs over the tenant's own KB text, never over customer input** — which is what makes a `like`/fold match acceptable here (§4.8.4).

#### 4.6.5 The output-side checker — a closed-world numeric guard

The prompt gate is necessary and not sufficient. Add a deterministic check — **on the model's output, never on the customer's input.**

> **Invariant: every currency figure in a reply must appear in the live revision.**

Extract every digit run of length ≥ 3 from the reply, strip separators (`,` `.` U+00A0 U+202F space), compare against `kb_snapshot.allowed_numbers` — every `price_min`, `price_max` and `kb_policy` amount, precomputed once per snapshot. A figure not in that set is a fabricated price.

Why this is safe where input matching is not: **digits and `₮` are not Cyrillic and carry none of the normalisation, case-folding or layout-confusion hazards of §4.8.** Microseconds, no model call, and it catches hallucinated prices *generally* — not only refusal topics. It is the strongest single quality control here and it is nearly free.

Two honest caveats:

- **Legitimate arithmetic** ("20,000₮ deposit leaves 46,000₮") trips it. Mitigate by forbidding arithmetic in the prompt — `lib/systemPromptBuilder.js:129` already forbids inventing prices — and by a per-tenant allow-list for non-price figures. The phone number and opening hours are already in the KB, so they join the allowed set automatically.
- **Ship it flag-only first.** Log violations to the Quality layer, measure the false-positive rate over two weeks of real traffic, then promote to *suppress and send the canned handoff*. Same report-only-then-enforce discipline the sibling applies to its CSP, and for the same reason: a checker that suppresses good answers is worse than the fabrications it prevents.

---

### 4.7 Versioning, audit, and the Quality layer's proposals

#### 4.7.1 Audit

Every published revision carries `created_by`, `published_by`, `published_at`, `parent_id`, `note`, `content_hash`, `est_tokens`, `est_token_source`. Publish also writes one `kb_change` row per differing field:

```sql
create table kb_change (
  tenant_id uuid not null, id bigserial,
  revision_id uuid not null,
  entity      text not null,          -- 'kb_service' | 'kb_canned_response' | …
  entity_id   uuid,
  field       text not null,
  before_val  jsonb, after_val jsonb,
  actor_id    uuid not null references app_user(id),
  actor_kind  text not null check (actor_kind in ('owner','staff','founder','quality_ai')),
  source      text not null check (source in
                ('dashboard','csv_import','photo_import','owner_postback','quality_proposal')),
  proposal_id uuid,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, id)
);
```

`actor_kind = 'quality_ai'` exists so an AI-originated change is never indistinguishable from a human one; every such row carries its `proposal_id`.

#### 4.7.2 Quality-layer proposals

```sql
create table kb_proposal (
  tenant_id uuid not null, id uuid not null default gen_random_uuid(),
  status    text not null check (status in ('pending','approved','rejected','superseded','expired')),
  kind      text not null check (kind in
              ('add_service','update_price','add_faq','add_alias','add_refusal_trigger',
               'add_forbidden_output','add_note','set_staff_inactive','confirm_freshness')),
  source    text not null check (source in ('quality_ai','owner_postback','photo_import')),
  target_entity text, target_id uuid,
  patch     jsonb not null,
  rationale_mn text not null,
  evidence  jsonb not null,           -- conversation_ids + message_ids, no raw PII
  confidence numeric,
  proposed_by_model text,
  proposed_at timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  decided_by uuid references app_user(id), decided_at timestamptz,
  applied_revision_id uuid,
  primary key (tenant_id, id)
);
```

Non-negotiable rules:

- **A proposal never auto-applies.** Approving copies `patch` into the draft; it does not publish. Two gates, not one.
- **Refusal-topic and canned-response proposals are founder-only, always.**
- **Evidence is IDs, not text.** Copying customer message text into a proposals table creates a second, less-protected copy of customer data.
- **Proposals expire at 30 days.** An inbox that only grows is an inbox nobody reads.
- **Generating proposals spends money on a schedule**, so non-negotiable #6 applies in full: an explicit per-tenant ceiling drawn from the **operator** bucket (§4.4.6), a ledger row per run, and an alert path when the ceiling is hit. It must not be scheduled at all until that ledger exists — the sibling shipped a generator whose only bound was a cached read, now closed at `BANK_BUILD_BUDGET_USD = 0`.

#### 4.7.3 RLS posture for the KB tables

Two classes, and the distinction is the sibling audit's: *an own-row policy checks **who** the row belongs to, never **what it says**.*

| Class | Tables | Client (`authenticated`) |
|---|---|---|
| **Owner-authored** | `kb_service`, `kb_staff*`, `kb_faq`, `kb_hours`, `kb_note`, `kb_service_category`, `kb_closure` dates, the draft `kb_revision` | Permissive own-tenant `for all`, **with `WITH CHECK` repeating the tenant predicate** — omitting it is a tenant-hopping `update … set tenant_id = <other>` |
| **Server-asserted** | `kb_snapshot`, `kb_change`, `kb_proposal`, `ai_call_ledger`, published `kb_revision`, `kb_refusal_topic`, `kb_canned_response` | **`SELECT` only**, plus per-command restrictive denies |

Restrictive denies must be **per command**, never `as restrictive for all using(true) with check(false)`: `DELETE` has no `WITH CHECK` clause and that shape lets deletes through (verified by execution in the RLS research). And `for all using(false)` applies `USING` to `SELECT` and would silently blind the dashboard.

```sql
create policy kb_snapshot_no_client_insert on kb_snapshot
  as restrictive for insert to anon, authenticated with check (false);
create policy kb_snapshot_no_client_update on kb_snapshot
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy kb_snapshot_no_client_delete on kb_snapshot
  as restrictive for delete to anon, authenticated using (false);
revoke all on kb_snapshot from anon, authenticated;
grant select on kb_snapshot to authenticated;
```

Then **verify against the catalog, per table, independently** — `pg_policies`, `pg_class.relrowsecurity`, `aclexplode(coalesce(relacl, acldefault('r', relowner)))` with grantee OID 0 special-cased as `PUBLIC`. Never `information_schema.role_table_grants` (permission-filtered, returns empty silently). Never `supabase_migrations.schema_migrations` (not a ledger for dashboard-applied SQL). `revoke insert, update, delete` is not "cannot write" — `TRUNCATE` bypasses every policy and only the ACL stops it. The last failure next door was partial, one table of four.

---

### 4.8 Mongolian Cyrillic through the whole KB path

#### 4.8.1 Normalise at the boundary, once, and prove it

**NFC-normalise at every input boundary** — dashboard submit, CSV import, photo extraction, Meta webhook body — and nowhere else. `.normalize('NFC')` in JS, `normalize(x, NFC)` in SQL. Then make it provable:

```sql
alter table kb_service add constraint name_is_nfc check (name is normalized);
```

`IS NORMALIZED` is cheap because checking is faster than converting, and the constraint means a direct SQL write cannot introduce an NFD row.

**Why this is not theoretical — (measured) in this checkout.** I NFD-normalised the service names in `clientData` and re-ran `buildSystemPrompt`. `priceOf` (`lib/systemPromptBuilder.js:104-110`) does exact `===` comparison and returns `''` on no match, so occurrences of a currency symbol with no number went from **1 (a legitimate formatting rule) to 4**, and **two of the prompt's own worked example dialogues rendered as**:

> `AI: "Сайн байна уу? Үнэ нь үсчний зэрэглэлээс хамаардаг. Мастер үсчин ₮, харин 1-р зэргийн үсчин ₮-ийн үнэтэй байна. …"`
>
> `AI: "Оюунсүрэн бол мастер үсчин тул эмэгтэй тайралт ₮ байдаг. …"`

A currency symbol with no number, in the model's *worked examples*, teaching it that the correct answer omits the price. No error, no warning, HTTP 200. The trigger is that «Эмэгтэй тайралт (Мастер)» contains **й**, which has a canonical decomposition — `'Эмэгтэй тайралт (Мастер)' === 'Эмэгтэй тайралт (Мастер)'.normalize('NFD')` is `false`. iOS keyboards and PDF copy-paste produce NFD, and a price list will be pasted from somewhere. Affected letters: **й, Й, ё, Ё**. **ө** and **ү** have no decomposition and are unaffected — which is exactly what makes it intermittent and unreproducible for whoever reports it.

#### 4.8.2 Keys, uniqueness, lookup

Store the normalisation rule in the schema, not in the hope every writer applied it:

```sql
name_key   text generated always as (lower(normalize(name, NFC))) stored
search_key text generated always as (fold(lower(normalize(name, NFC)))) stored
unique (tenant_id, revision_id, name_key)
```

Stored generated columns are indexable, deterministic and **visible in the catalog** — you can read the rule rather than trust it. `C.UTF-8` and `en_US.UTF-8` both case-fold Cyrillic correctly (`lower('ҮС ЗАСАЛТ')` → `үс засалт`); plain `C`/`POSIX` **silently does not**. `datcollate` cannot be changed after database creation, so assert it in the post-migration pack:

```sql
select datname, datcollate, pg_encoding_to_char(encoding)
from pg_database where datname = current_database();
-- must be UTF8; datcollate must NOT be 'C' or 'POSIX'
```

#### 4.8.3 `fold()` is ours; `unaccent` is banned

**Do not create the `unaccent` extension.** Verified by execution in the RLS research: it maps **Ё → Е** and **ё → е**, destroying a full letter of the Mongolian alphabet (ёстой, Ёндон, ёс), while **Й, Ө, Ү pass through untouched.** That mixture is the danger — harmless in nine tests out of ten, then silently conflating a small set of words.

Instead, an explicit, inspectable, tenant-independent rules table covering the *actual* Mongolian confusions, which are keyboard-layout errors, not diacritics:

```sql
create table mn_fold (src text primary key, dst text);
insert into mn_fold values ('ө','о'), ('ү','у'), ('й','и'), ('ё','е');
-- fold(text) applies these; used ONLY for search_key, never for stored canonical text
```

`fold()` is never applied to anything a customer reads, and never to `name` itself.

#### 4.8.4 No ASCII assumptions, and where regex is and is not allowed

Postgres regexes are locale-aware; JavaScript regexes are not. `\w` matches `'үс засалт'` in Postgres and **does not** in JavaScript; `\yзасалт\y` matches in Postgres, `/\bзасалт\b/` does not in JS — **and the `u` flag does not fix it**, because JS defines `\b` in terms of `\w` and `\w` is permanently `[A-Za-z0-9_]`. A validation regex ported from `psql` to Node changes meaning.

1. **No `\b`, no `\w`, no `[a-z]` in any JavaScript regex over Mongolian text.** Use `\p{L}`, `\p{N}` with `u`, or `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])`. Enforce with an ESLint rule or CI grep — this gets reintroduced by copy-paste six months later.
2. **No unanchored regex over *customer* text as a gate on anything.** The ancestor demonstrates why twice. `lib/salonIntents.js:26` — `/^(сайн|байна|уу|hi|hello|hey)/i` — has no right boundary, so `detectShortcutIntent('Уучлаарай асуумаар байна')` returns `'greeting'`: a customer opening with an apology, one of the commonest Mongolian service openers, gets the canned welcome and their real question is never answered. And `lib/salonIntents.js:21` matches `хаяг` anywhere, so `'Facebook хаяг байна уу'` returns `'location'` and the customer gets a Google Maps card — which is why `:25` exists as a hand-patched email special case, a symptom-level fix that will keep producing new symptoms.
3. **The asymmetry that makes this workable:** regex over **our own output** (§4.6.5) and over **the tenant's own KB text** (§4.6.4) is fine — closed, controlled, NFC-normalised vocabularies. Regex over **customer input** is not. Intent recognition over customer Mongolian is the model's job, under a hardened rule, not a regex's. This is also why the owner-message write path (§4.5.4) is postback-only.
4. **`sanitizeForPrompt` is not a security control** and neither is any Mongolian equivalent. The sibling's audit is explicit: *"a fixed-phrase regex strip … trivially bypassed."* Do not build the Mongolian version and then rely on it.
5. **Lengths in characters, computed emoji-safely.** Postgres `length` is characters, `octet_length` is bytes: `'Үс засалт'` is 9 and 17 — **every ASCII-derived length budget is ~1.9× too small.** In JS use `Array.from(s).length` for characters and `Buffer.byteLength(s)` for bytes, never interchanged. The ancestor over-counts at `lib/messengerText.js:78` and `lib/messengerClient.js:52` (errs safe there, wrong reflex), and `lib/messengerClient.js:59` can hard-split a surrogate pair mid-emoji, which `:157-158` guards for button titles but the chunker does not.
6. **Sorting.** `order by name` under `C.UTF-8` is byte order, so **Ө** (U+04E8) and **Ү** (U+04AE) sort after all basic Cyrillic. Any user-visible list uses `collate "mn-MN-x-icu"` if available, otherwise `und-x-icu`.
7. **FTS: `simple`, named explicitly at every call site**, with `default_text_search_config = 'pg_catalog.simple'` pinned. There is no Mongolian configuration; `english` and `simple` produce identical output on pure Mongolian but diverge on the mixed Latin/Cyrillic a salon actually receives. `simple` has no Mongolian stop-word list, so particles (нь, ба, юм, вэ, бол) index as content — a month-two tuning task, and a reason to prefer folded-trigram over FTS for the catalogue lookup anyway.

---

### 4.9 Failure modes

| # | Failure | Detection | Behaviour |
|---|---|---|---|
| 1 | **`tenant.live_revision_id` is null** (onboarding incomplete) | one read | `503 tenant_not_provisioned` — a distinct code, not 500, not a silent skip. Founder alerted. Never answers from a default or from another tenant. |
| 2 | **`kb_snapshot` row missing** for the live revision + variant | one read | `503 kb_snapshot_missing`. **Never re-render in the hot path** — that is the module-cache bug's cousin and produces an un-hashed prompt nobody can audit. Alert; the publish pipeline is broken. |
| 3 | **KB published but empty** | publish invariant | Publish blocked. Precedent: `lib/systemPromptBuilder.js:36-39` refuses rather than renders nothing plausible. |
| 4 | **Snapshot exists, catalogue block empty** (renderer bug) | hash mismatch; `est_tokens` far below the revision's history | Publish blocked at render; if it ever reaches serving, the reply path falls back to `FALLBACK_REPLY` rather than answering from a spine with no prices. |
| 5 | **Price is a range** | `price_basis` | Not a failure — a first-class case. `range` renders «66,000 – 88,000₮»; both endpoints join `allowed_numbers`, so quoting either is legal and quoting a midpoint is not. |
| 6 | **`price_max < price_min`** | `price_shape` CHECK | Rejected at the form, in Mongolian. Cannot reach a revision. |
| 7 | **Two services with the same name** | `unique (tenant_id, revision_id, name_key)` | Rejected. `name_key` is NFC+lowercased, so spellings differing only by normalisation collide correctly. |
| 8 | **Staff member references a missing group** | composite FK | Publish aborts. Today this **silently drops the person** (`lib/systemPromptBuilder.js:66-86`, no `else`) and the bot then denies a real stylist works there. |
| 9 | **Two policy rules match one selector with different amounts** | publish-time overlap check | Publish blocked, both shown. Otherwise the deposit table contradicts itself and the model picks arbitrarily. |
| 10 | **Refusal topic contradicts the catalogue** | §4.6.4 | Publish blocked; owner resolves. |
| 11 | **An FAQ answer contradicts a price** | **not machine-checkable — stated plainly** | Caught, if at all, by post-publish probes and Quality-layer review. Residual risk. FAQ answers should not restate prices; the form warns when a currency figure is typed into one. |
| 12 | **Owner deletes a service the bot has been quoting** | publish diff × 30-day quote history from `ai_call_ledger` | **Hard delete is not offered.** `active = false`; history retained. Preview shows «Энэ үйлчилгээг сүүлийн 30 хоногт 14 удаа хэлсэн байна». A `kb_retirement` row renders a compact "no longer offered" line for 30 days. Conversations quoting it in the last 7 days are flagged. |
| 13 | **A change lands mid-conversation** | `message.revision_id` | New revision wins; conversation flagged `revision_straddle` if a price was quoted under the old one (§4.5.7). |
| 14 | **Rendered prompt exceeds the token budget** | `count_tokens` before the transaction | **Publish refuses.** Owner shown what to trim, or founder raises the budget explicitly; past the point of sense, §4.3.4's T1 fires. |
| 15 | **`count_tokens` unavailable at publish** | network error before `BEGIN` | Fall back to the tenant's measured chars-per-token × 1.2, record `est_token_source='ratio_fallback'`, **proceed unless the estimate exceeds budget.** A size gate must not fail a Saturday price change — the cost of that failure lands on the salon, not on the Anthropic bill. |
| 16 | **A breakpoint sits below the model's minimum cacheable prefix** | per-breakpoint cumulative-token check at publish | Loud warning; emit no breakpoint ① when the model minimum exceeds the global block. `cache_control` is otherwise **silently ignored** and the only symptom is `cache_read = 0` forever. |
| 17 | **Cache hit rate collapses after a publish** | `ai_call_ledger` grouped by `revision_id` | Expected for one TTL window; alert if it persists — something per-request has leaked into the prefix. |
| 18 | **Two editors publish concurrently** | `kb_revision_one_draft` + optimistic concurrency | Second publish fails naming the other editor, not last-write-wins. |
| 19 | **A reviewed canned string is edited without review rights** | `reviewed_by` cleared on edit; publish gate | Publish blocked until re-reviewed. |
| 20 | **Preview budget exhausted** (review-required class) | dollar check **before** the calls, operator bucket | 503 with a distinct code; publish still permitted **without** probes, with an explicit "you did not preview this" confirmation. Never `try { check() } catch { continue }`; never a silent block of a legitimate price change either. |
| 21 | **Publish transaction fails halfway** | transaction | Nothing changes. The draft survives with the owner's edits intact; the live pointer is untouched. |
| 22 | **Retrieval (once enabled) returns nothing** | empty result | `HANDOFF_REPLY`, never improvisation; logged to the Quality layer as unanswered. |
| 23 | **NFD text enters the KB** | `check (name is normalized)` + NFC at every boundary | Rejected at write. Without both, #7 becomes invisible and worked examples render with an empty price — **(measured)**, §4.8.1. |
| 24 | **A stale prompt is served** | — | Structurally impossible for the Anthropic cache (content-addressed). Possible only via a local cache keyed by anything other than `(tenant_id, revision_id, variant, channel)` — CI grep plus the no-store Supabase client. |
| 25 | **The KB goes stale because nobody edits it** | `confirmed_at` vs `tenant.stale_after_days` | Founder alert + one-tap confirmation loop on dashboard **and** Messenger postback (§4.1.5). Without this the design deletes the only staleness detector the ancestor had. |
| 26 | **The owner needs to close the salon at short notice and cannot** | — | `tenant.closed_from/closed_until` is a self-serve runtime flag selecting the pre-rendered `closure_generic` variant: no review, no probes, no publish, effective next inbound message (§4.2.2). |
| 27 | **The owner cannot log in** | `owner_session_last_seen` | 90-day sliding session established in person; founder re-establishes **proactively before it lapses**. Delivery-based login is recovery only, from the DKIM/SPF-authenticated apex domain, with the provider `messageId` logged — a 2xx from an email provider means "accepted", never "delivered" (§4.5.2). Alert path is not email. |
| 28 | **Runtime spend runs away** (attack, viral post, retry storm) | rolling-hour token ceiling + per-conversation reply cap, reserved at the miss price | Refuse with `HANDOFF_REPLY` ($0). **Not built in this section** — §4.4.6 names it as a dependency so nobody mistakes the publish-time gates for a spend control. |

---

### 4.10 Open questions — the founder's call

1. **Does the tenant owner get a self-serve publish at all in v1, or does every change go through you?** This section assumes self-serve for prices/hours/staff/closure-dates and founder review for verbatim strings and refusal topics. Founder-review-everything is defensible for two tenants and removes a class of risk — but it makes you the bottleneck on a Saturday price change, which is the phone call the dashboard exists to prevent. It determines whether the dashboard needs full auth, RLS-for-humans and a review queue in v1, or whether all of that defers and the security budget goes to the service-role webhook path where all the volume and all the spend actually are.

2. **What happens to the bot's own behaviour when the KB goes stale past 2× the threshold?** Alerting and a one-tap confirm are in the design and are not the founder's call. Whether prices then render behind a pre-reviewed hedge, or `price_basis` degrades to `on_request`, **is** — it degrades the product to protect against a wrong prepaid deposit. Without something in that slot, staleness is unbounded and self-concealing.

3. **What is the per-tenant monthly AI ceiling, split how, and what happens at it?** Every figure in §4.4.3 is a cost per reply, not a budget. The three honest options — stop answering, degrade to the canned handoff, or bill the overage — are a pricing decision. The customer/operator bucket split (§4.4.6), the preview budget (§4.5.5) and the proposal ceiling (§4.7.2) all hang off this number.

4. **Do Matrix's existing pinned Mongolian strings get re-reviewed before launch?** They were native-speaker reviewed for *this* prompt in *this* context (`lib/salonBrain.js:48-51`). Moving them into `kb_canned_response` and putting a refusal gate at the top of a restructured block changes the conditions they were validated under. My recommendation is yes, with `reviewed_at` left null so the publish gate forces it — which costs a review session before tenant #1 migrates.

5. **Is the "never say this" list a product feature the tenant controls, or founder-only?** Genuinely valuable and genuinely dangerous: an owner who adds "prices" to it gets a bot that refuses to sell. My design makes it founder-only. Self-serve-with-review is possible; self-serve-without-review is not.

6. **How long is KB history kept?** Matrix at ~60 rows per revision is nothing; GS Auto at 400 rows × weekly publishes is ~20k rows/year — still nothing, but unbounded. Full row-level history for 24 months with `kb_change` and `kb_snapshot` kept forever? Or everything forever, revisited at ten tenants? Cheap now, migration-shaped later.

7. **Does the Matrix website chatbot (`api/chat.js`, `public/`, `src/`) read from the same KB, or is it retired?** If it survives, `kb_snapshot.channel` already accommodates it and the FAQ text/URL split is required rather than tidy. If it is retired, the salon keeps the old repo running and the two knowledge bases diverge from day one — which is the situation that produced the duplicated phone number (`config/currentClient.js:107` vs `lib/salonBrain.js:41`) in the first place.

8. **Is `photo of the price list → proposal` in scope for v1?** It is the single feature most likely to make onboarding client #3 feel like filling in a config rather than doing data entry — and it is a new AI spend surface, a new failure mode (OCR on Mongolian Cyrillic is not reliable), and a new place for a wrong price to enter. My recommendation is Phase 2, behind founder approval, with CSV import shipping first.

9. **Which price sheet is authoritative for the cache-write multiplier?** The 1.25× vs 2× question (§4.4.3) moves the break-even hit rate from 21.7% to 52.6%, flips the TTL default's margin at low volume, and changes a 1-hour miss from 20% to 81% more expensive than no caching. It is a five-minute check against Anthropic's published pricing and it should be done before `tenant.prompt_cache_ttl` gets a default in code.