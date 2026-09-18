# Folding the website bot into tenant #0

`dalatech-chatbot` is Dalatech's own website assistant, live behind the widget on
`dalatech.online`. The founder's instruction:

> it's tenant #0's website bot and I want it folded into Dala AI as a second channel on
> that tenant. Diff its prompt against ours first — but finish the guard work before
> starting it.

This is that diff. **Nothing is ported yet**, because three of the findings below are the
founder's to settle and one of them reverses a decision he made three days ago.

The standing rule that makes this worth doing: *when the incumbent has a rule we do not,
that is a MEASURED LOSS, not a theoretical gap.* It has produced D-067, D-076 and D-081 in
seven days. Read here for the RULES, not only the architecture.

## What it is

| | |
|---|---|
| Entry point | `dalatech-messenger/api/chat.js`, 364 lines, one POST handler |
| Model | **`claude-haiku-4-5-20251001`**, `max_tokens` 400 |
| Prompt | two system instructions built as JS template literals in the route file |
| Surface | anonymous browser traffic through a widget, CORS-gated |
| Guards | per-IP rate limit (in-memory), message/history validation, an XSS pattern check |
| Spend | **none.** No budget, no ledger, no ceiling of any kind |

## The rules it has that we do not

### 1. It answers English in English

```
Хэл: монгол. Хэрэглэгч англиар бичвэл англиар хариулах.
```

We have **nothing**. Every gate block is written in Mongolian and no rule anywhere says
what to do with an English message. This is NOT D-067, which is about Mongolian typed in
Latin letters; this is a genuine English speaker, and on a website selling AI staff to
businesses, a proportion of the traffic will be.

Cost is real but unmeasured — this repo's corpus is Facebook DMs to a Mongolian salon,
which is the wrong population to estimate it from. **Not portable as-is**: a reply in
English is a customer-visible string in a language nobody has signed off, and the outbound
guard's script-share check (which exists to catch a Mongolian bot drifting into English)
would have to learn that this tenant may do it deliberately. Founder's call.

### 2. A hard length rule with a *structure*, not just a bound

D-081 gave us `02_style` — «Хариултаа товч, ойлгомжтой, Messenger-т тохирсон байдлаар бич».
The website bot's is stricter and, more usefully, **tells the model what to do when it has
too much to say**:

```
- Нэг хариулт нэг, ихдээ хоёр өгүүлбэр. Гурав дахь өгүүлбэр бичихгүй.
- Оршил, угтвар үг бичихгүй, асуултыг давтахгүй. Шууд хариултаар эхэлнэ.
- Хэлэх зүйл олон бол хамгийн чухал нэгийг нь хэлээд «Дэлгэрэнгүй тайлбарлах уу?» гэж асууна.
```

That last line is the one worth having. "Be brief" with no escape hatch makes a model choose
between truncating and disobeying; offering to continue gives it a third move. D-042 is the
adjacent evidence — the booking link arrives on the fourth reply because two reasonable
rules compose into a long interrogation, and a bot that can say *shall I go on?* has a way
out of that. **Founder-gated** (platform Mongolian, and `02_style` is signed).

### 3. Forbidden phrasings, including a rename map

```
4. Хуучин нэршил ("AI Chatbot", "AI Receptionist", "Combo") хэрэглэхгүй…
   "Ара" нь Далигийн, "Веда" нь Вирагийн хуучин нэр…
6. "Демо захиалах" гэж хэлэхгүй. Уриалга нь үргэлж хүсэлт илгээх…
```

We have the table — `forbidden_phrasings` — and the outbound guard reads it. These are
**rows, portable today**, and they are not customer-visible strings (they are the strings a
reply may NOT contain). The rename map is the interesting half: it is a rule about what the
company used to be called, which is exactly the sort of thing that exists only in the head
of whoever renamed it and is lost the moment the bot is replaced.

### 4. A prompt-cache floor gate

`scripts/check-prompt-floor.js` fails the build when the prompt shrinks toward the point
where it stops being cacheable, because:

> Haiku 4.5 will not cache a prefix shorter than 4,096 tokens, **and it does not say so**:
> the `cache_control` marker is ignored, `cache_creation_input_tokens` stays 0, and the
> only symptom is that the saving quietly disappears.

Its current margin is **125 tokens, about 3%** — a couple of bullet lines.

This is not costing us anything today and should not be written up as if it were: Matrix's
prefix is 9,738 tokens and tenant #0's is around 7,000, both far above any model's floor.
It becomes live the moment `docs/prefix-trim.md` is executed — and D-072 restored that
document to a **margin** lever, with the prefix measured at 86.7% of the bill. Trimming
toward an unchecked floor would remove the entire saving and report nothing. The floor is
model-specific and must be measured rather than copied from that script's comment, which
is calibrated for Haiku.

**Portable today and cheap**: a guard in `scripts/guards/` asserting a compiled prefix
clears a measured floor. It is the one item here with no founder gate on it.

### 5. A greeting short-circuit that costs nothing

```js
const isGreeting = /^(сайн|байна|уу|hi|hello|hey)/i.test(sanitizedMessage.trim());
if (isGreeting && sanitizedMessage.trim().length < 30 && !sanitizedHistory.length) { … }
```

A fixed Mongolian greeting, no model call. We have the mechanism — `deterministic_replies`
with `requires_empty_history` — and **zero rows for any tenant**. Greetings are 11 of 71
messages in Matrix's corpus (15%), each one currently a model call.

Note it lists the Latin forms rather than transliterating, which is the ancestor's lesson
and D-067's answer. And note what it still misses: «Sn bnu» matches none of those
alternatives, and D-067's addendum already establishes that the abbreviation space is not
enumerable. The rows are the founder's (a greeting is customer-visible Mongolian).

## What must NOT be ported

### The per-request prompt switch

```js
if (askingForContact) systemInstruction = buildContactSystemInstruction(…);
else                  systemInstruction = buildConversationSystemInstruction(…);
```

Two entirely different system prompts, chosen by a regex over the customer's message. In
this platform that is forbidden, and `prompt/render.ts` says why in its own opening
docstring:

> Selecting which gate checks to include based on the inbound message would shrink the
> prefix and take the cache hit rate to **zero**. […] Giving the renderer no access to a
> message or a clock makes the mistake unavailable rather than forbidden.

The renderer structurally cannot express this, which is the design working. The contact
answer becomes a `deterministic_replies` row or a `canned_responses` kind — not a prompt.

### Haiku for customer-facing Mongolian prose

The website bot runs `claude-haiku-4-5`. D-009 settled this for Reception after two bake-off
rounds and native-speaker review: **no Haiku for customer-facing Mongolian prose** — it is a
fluency ceiling, not a prompt gap. Folding this channel in *upgrades* it to Sonnet 5, which
is a quality gain and a cost increase, and the cost has to be sized before it is switched on
rather than after (see the ceiling section below).

### The prompt as a code literal

The whole product catalogue — five AI staff, their descriptions, their prices, the website
packages, the payment terms, the FAQ — is a template literal in a route file. Under "a
client is rows, never a code path" every line of it is tenant #0 data: `services`,
`service_variants`, `faqs`, `contact_points`, `tenant_booking`. That is the port, and it is
mostly mechanical.

## Three things that are the founder's

### A. Prices in the prefix — this contradicts D-075

D-075 is three days old and unambiguous:

> **Prices never enter `allowed_numbers` and never enter the prefix** (2026-09-15, D-075,
> founder's call).

The website bot's entire job is quoting Dalatech's price list — 250,000₮, 150,000₮,
750,000₮, 800,000₮, the team discounts, the deposit split. Fold it in under D-075 and the
channel cannot do the one thing it exists to do.

The two cases are genuinely different and that may be the resolution rather than a
reversal:

| | Matrix (D-075's case) | Tenant #0 (this case) |
|---|---|---|
| Catalogue | ~8 service rows whose names collide — «Сор» ⊂ «Оффис колор /Сор/», «Тэжээл» ⊂ «CMC тэжээл» | 5 named staff + 2 website packages, no subset collisions |
| Failure mode | a REAL price against the WRONG service, 3.2× apart, more plausible than an invented one | naming the wrong product of five distinctly-named ones |
| Who owns the list | the salon, and its rows disagree with the list it confirmed | Dalatech, who wrote both |

So the honest framing is that D-075's *reasoning* may not transfer, not that D-075 was
wrong. **It is still a reversal of a founder's call on a customer-visible behaviour about
money, and it is not mine to make.** Everything else here can proceed without it; this
channel cannot go live without it.

### B. The spend ceiling for anonymous traffic

The founder asked for "a spend cap, per-IP rate limit and Turnstile". Current state in the
sibling, and it is worse than absent:

- **No spend cap at all.** No budget, no ledger, no affordability term. This is precisely
  the shape `dalatech-english` closed by setting `BANK_BUILD_BUDGET_USD` to 0 — *"Before
  this the repo had no dollar ceiling at all."*
- **CORS fails OPEN.** `const allowAnyOrigin = allowedOrigins.length === 0;` — with
  `ALLOWED_ORIGINS` unset, every origin is allowed and the caller's own origin is echoed
  back. The one control stopping anyone embedding this widget on their own site and
  spending Dalatech's Anthropic budget defaults to off. CLAUDE.md rule 2, in a sibling repo.
- **The rate limit is in-memory.** `lib/rateLimiter.js` keeps its counters in a module-scope
  map, and on Vercel that is per-lambda-instance. 30 requests/minute per IP is 30 per
  instance per minute; under load, instances multiply. It is not the bound it reads as.

Folding in is a **strict improvement on all three**: this platform has `reserve_spend` /
`settle_spend`, a real `spend_ledger`, and `effectiveDailyCeiling` taking the lower of
`SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY` ($1.50) and the tenant row. What needs deciding is
the NUMBER, and that is money movement.

Two facts to size it with, neither of which is a recommendation:

- D-072 measured a cold reply at **$0.0406** on Sonnet 5 with Matrix's 9,738-token prefix.
  A website visitor is a cold start almost by definition.
- **The current channel's volume is unmeasured from here.** `lib/analytics.js` keeps its
  counters in memory and `logInteraction` writes to stdout, so there is no store to read. A
  ceiling sized from a guess on a surface with no authentication is the thing to avoid.

### C. Turnstile

Not present, and it is the only one of the three controls that distinguishes a browser from
a script. It needs a Cloudflare account and a site key — credentials, so the founder's.

Ordering matters: **Turnstile and the ceiling go in before the channel is live**, not after.
An anonymous surface with a ceiling and no bot check burns the ceiling; one with a bot check
and no ceiling burns the budget.

## What the port actually is

For the record, because it is smaller than it looks once the above is separated out:

1. `tenant_channels` gains a row for tenant #0 with a new `provider` — `website`. The
   existing row is `facebook_page`, and `decideCommentReply` / the Meta send path are keyed
   on the provider, so nothing crosses.
2. The catalogue becomes tenant #0 rows (`services`, `faqs`, `contact_points`).
3. The two prompt literals become: the platform gate blocks we already have, plus tenant
   L2/L3 sections the compiler renders.
4. A route that is not a Meta webhook — no HMAC, no QStash entry shape. The identity is a
   browser session, and the tenant is derived from the CORS origin, which is
   server-side and therefore satisfies rule 1 in a way a request body would not.
5. Turnstile + per-IP limit + `reserve_spend` before the provider call.

`dalatech-chatbot` retires when tenant #0's website channel serves the same widget.

## Not done, and why

Nothing in this document has been built. The founder's overnight instruction is to stop and
ask for money, customer-visible Mongolian, anything touching Matrix's live customers, or a
one-way door — and A, B and C are two of those categories between them. The port's
mechanical half (2 and 3 above) is blocked on A, because a catalogue rendered without prices
is a channel that cannot answer its own first question.
