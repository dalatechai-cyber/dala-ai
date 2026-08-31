# Prefix trim — the margin-recovery path

D-009 settled on Sonnet 5, which clears the quality bar and misses the margin one:
**29% against a 60% target** at the volume a *successful* salon produces. Haiku would have
closed that gap and cannot, so the gap closes by making the prefix cheaper instead.

This is a plan with measured inputs, not a proposal. Nothing here has been applied.

## Measured composition

The live Matrix Reception prefix, 11,321 characters, by section:

| Section | chars | share | class |
|---|---:|---:|---|
| СУВГИЙН ЗААВАР (Facebook Messenger) | 2,725 | 24.1% | platform |
| ҮНИЙН МЭДЭЭЛЭЛ ӨГӨХ ДҮРЭМ | 1,849 | 16.3% | platform |
| ХАРИУЛАХ ЗААВАР | 1,342 | 11.9% | platform |
| ҮНИЙН ЖАГСААЛТ | 1,249 | 11.0% | **tenant** |
| ЖИШЭЭ ЯРИ | 873 | 7.7% | examples |
| ХЭЛНИЙ ЧАНАРЫН ХАТУУ ДҮРЭМ | 692 | 6.1% | platform |
| ТҮГЭЭМЭЛ АСУУЛТ | 648 | 5.7% | **tenant** |
| УРЬДЧИЛГАА ТӨЛБӨРИЙН ДҮРЭМ | 494 | 4.4% | **tenant** |
| КОМПАНИЙН ТАНИЛЦУУЛГА | 300 | 2.6% | **tenant** |
| МАНАЙ БАГ | 295 | 2.6% | **tenant** |
| ХОЛБОО БАРИХ МЭДЭЭЛЭЛ | 255 | 2.3% | **tenant** |
| ХЭЛНИЙ ДҮРЭМ | 164 | 1.4% | platform |
| preamble | 51 | 0.5% | platform |

**platform 6,823 (60%) · tenant 3,241 (29%) · examples 873 (8%)**

The headline: **less than a third of what Reception pays for on every message is the
salon's own knowledge.** The rest is instruction that is byte-identical for every tenant.

## The levers, ranked by value

Token figures use ~1.8 chars/token and are **estimates**. The real numbers are in the
`usage` blocks of the bake-off results — read them from there before committing to any
saving.

### L3 — platform-first ordering, one shared cache entry — *the big one*

6,823 characters are identical across every tenant. Render them **first**, with their own
cache breakpoint, and they become **one Anthropic cache entry for the whole platform**
instead of one per tenant.

Saves nothing at one tenant and roughly `(N−1) × 6,823 chars` of cache-write cost at N
tenants. It changes no wording, so it carries **no quality risk** — which makes it the
first thing to do, not the last. It requires the compiler to emit platform blocks before
tenant blocks and to place the breakpoint between them; `prompts/platform/reception-mn.txt`
is already written to sit there.

### L1 — consolidate the overlapping instruction blocks

`ҮНИЙН МЭДЭЭЛЭЛ ӨГӨХ ДҮРЭМ` (1,849) and `ХАРИУЛАХ ЗААВАР` (1,342) overlap heavily with
each other and with the Ш1–Ш6 boundary gate, which states the same refusals as a
first-line decision procedure. Pool of 3,191 characters; **assume ~30% removable ≈ 950
chars (~530 tokens)** until someone reads the two side by side and marks the actual
duplication.

Carries real quality risk: these blocks are what keep prices correct. Any cut must be
validated by the bake-off before shipping.

### L2 — the few-shot examples

873 characters. The Ш1–Ш6 gate may already do what they were doing. **This is a bake-off
arm, not an assumption** — run with and without, compare on the same probes.

## What NOT to trim

The tenant knowledge (3,241 chars) is the product. `ҮНИЙН ЖАГСААЛТ` at 1,249 characters is
the salon's actual price list; cutting it is how a bot starts inventing prices, which is
the failure mode the entire boundary gate exists to prevent.

The `ХЭЛНИЙ ЧАНАРЫН ХАТУУ ДҮРЭМ` block (692) is tempting now that Sonnet is clean without
extra fluency rules — but this block is the *ancestor's* original, written after observed
production garbling («чадам туслаарай», the invented Russian «дополнительн»). It predates
this bake-off and was in the prefix for both arms. **Removing it is its own experiment**,
not a freebie.

## How a trim gets validated

Any cut is a change to what customers read, so it goes through the same gate the model
choice did:

1. Apply the trim to a copy of the prefix.
2. Run the bake-off on Sonnet 5 with and without, same probes, same repeats.
3. The ungrounded-numeral gate must stay clean, and `price_unlisted` must still refuse.
4. A native speaker reads both sets of replies. **No trim ships on a machine verdict** —
   that is the whole lesson of D-009, where every automated check passed on output a
   native speaker called broken.

## Expected recovery, honestly bounded

L1 and L2 together are ~1,800 characters, roughly **16% of the prefix**. Prefix cost is
most of the per-reply cost on a cache hit, so the realistic ceiling here is a low-teens
percentage improvement on Reception spend — that moves 29% margin to somewhere in the low
30s. **It does not reach 60% on its own.**

L3 is the one that scales, and it scales with tenant count rather than with wording.

So the honest position: the prefix trim is worth doing, and the margin problem is not
solved by prompt engineering alone. The other levers are commercial — the price, the
target margin, or the volume band a ₮250,000 plan is sold against — and those are the
founder's call, not this document's.
