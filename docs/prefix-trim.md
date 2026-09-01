# Prefix trim — the margin-recovery path

D-009 settled on Sonnet 5, which clears the quality bar and misses the margin one:
**29% against a 60% target** at the volume a *successful* salon produces. Haiku would have
closed that gap and cannot, so the gap closes by making the prefix cheaper instead.

This is a plan with measured inputs, not a proposal. Nothing here has been applied.

## Measured composition

The live Matrix Reception prefix, 11,321 characters. **Re-run it rather than
trusting this table** — `node scripts/bakeoff/compose.mjs --markdown` regenerates it,
and the numbers below are that command's output:

| Section | chars | share | class |
|---|---:|---:|---|
| СУВГИЙН ЗААВАР (Facebook Messenger) | 2,769 | 24.5% | platform |
| ҮНИЙН МЭДЭЭЛЭЛ ӨГӨХ ДҮРЭМ | 1,883 | 16.6% | platform |
| ХАРИУЛАХ ЗААВАР | 1,366 | 12.1% | platform |
| ҮНИЙН ЖАГСААЛТ | 1,272 | 11.2% | **tenant** |
| ЖИШЭЭ ЯРИ | 891 | 7.9% | examples |
| ХЭЛНИЙ ЧАНАРЫН ХАТУУ ДҮРЭМ | 726 | 6.4% | platform |
| ТҮГЭЭМЭЛ АСУУЛТ | 672 | 5.9% | **tenant** |
| УРЬДЧИЛГАА ТӨЛБӨРИЙН ДҮРЭМ (цаг авах үед) | 544 | 4.8% | **tenant** |
| КОМПАНИЙН ТАНИЛЦУУЛГА | 330 | 2.9% | **tenant** |
| МАНАЙ БАГ | 313 | 2.8% | **tenant** |
| ХОЛБОО БАРИХ МЭДЭЭЛЭЛ | 285 | 2.5% | **tenant** |
| ХЭЛНИЙ ДҮРЭМ | 185 | 1.6% | platform |
| (preamble) | 51 | 0.5% | platform |
| ҮНИЙН ЖАГСААЛТЫН САН НӨӨЦ | 34 | 0.3% | **tenant** |

**platform 6,980 (61.7%) · tenant 3,450 (30.5%) · examples 891 (7.9%)** — and those
three sum to 11,321, every character of the prefix.

The headline: **under a third of what Reception pays for on every message is the
salon's own knowledge.** The rest is instruction that is byte-identical for every
tenant.

### Corrected 2026-09-01, and why the first numbers were wrong

**Three documents carried three different answers** for the same prefix:

| Document | Published | Sums to |
|---|---|---|
| this file, earlier revision | platform 6,823 (60%) · tenant 3,241 (29%) | 10,937 — not 11,321 |
| `ROADMAP.md` | 64% platform / 24% tenant | — |
| `ARCHITECTURE.md` | 7,266 (64%) · 873 (8%) · 2,747 (24%) | 10,886 — not 11,321 |

None was right, and two of the three did not sum to the prefix they were measuring. The
third document was found only after the first two were corrected, which is itself the
argument for generating the figure instead of typing it: a hand-typed number does not
announce its own copies.

Two causes, both worth naming because both are the same mistake:

1. The measurement counted section *bodies* and dropped the `=== TITLE ===` delimiter
   lines. Those are real tokens that are really paid for on every message.
2. `УРЬДЧИЛГАА ТӨЛБӨРИЙН ДҮРЭМ` — 544 characters, the salon's own deposit policy, and
   therefore **tenant** knowledge — was not in the classification at all, so it fell
   out of the tenant total silently. That single omission is most of the gap between
   "24%" and the true 30.5%.

The fix is not a corrected number, because a corrected number typed by hand drifts
the same way. It is `scripts/bakeoff/compose.mjs`, which **refuses to run** on a
section it cannot classify and asserts that the parts sum to the whole. Both failures
above would now be errors rather than a plausible-looking table.

The direction of the original argument survives — platform instruction really is the
majority of the prefix, and L3 really is the lever that scales. The tenant share being
30.5% rather than 24% makes the trim slightly *less* promising, not more, and that is
reflected below.

## The levers, ranked by value

Token figures use ~1.8 chars/token and are **estimates**. The real numbers are in the
`usage` blocks of the bake-off results — read them from there before committing to any
saving.

### L3 — platform-first ordering, one shared cache entry — *the big one*

6,980 characters are identical across every tenant. Render them **first**, with their own
cache breakpoint, and they become **one Anthropic cache entry for the whole platform**
instead of one per tenant.

Saves nothing at one tenant and roughly `(N−1) × 6,980 chars` of cache-write cost at N
tenants. It changes no wording, so it carries **no quality risk** — which makes it the
first thing to do, not the last. It requires the compiler to emit platform blocks before
tenant blocks and to place the breakpoint between them; `prompts/platform/reception-mn.txt`
is already written to sit there.

### L1 — consolidate the overlapping instruction blocks

`ҮНИЙН МЭДЭЭЛЭЛ ӨГӨХ ДҮРЭМ` (1,883) and `ХАРИУЛАХ ЗААВАР` (1,366) overlap heavily with
each other and with the Ш1–Ш6 boundary gate, which states the same refusals as a
first-line decision procedure. Pool of 3,249 characters; **assume ~30% removable ≈ 975
chars (~540 tokens)** until someone reads the two side by side and marks the actual
duplication.

Carries real quality risk: these blocks are what keep prices correct. Any cut must be
validated by the bake-off before shipping.

### L2 — the few-shot examples

891 characters. The Ш1–Ш6 gate may already do what they were doing. **This is a bake-off
arm, not an assumption** — run with and without, compare on the same probes.

## What NOT to trim

The tenant knowledge (3,450 chars) is the product. `ҮНИЙН ЖАГСААЛТ` at 1,272 characters is
the salon's actual price list; cutting it is how a bot starts inventing prices, which is
the failure mode the entire boundary gate exists to prevent.

The `ХЭЛНИЙ ЧАНАРЫН ХАТУУ ДҮРЭМ` block (726) is tempting now that Sonnet is clean without
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

L1 and L2 together are ~1,866 characters, roughly **16% of the prefix**. Prefix cost is
most of the per-reply cost on a cache hit, so the realistic ceiling here is a low-teens
percentage improvement on Reception spend — that moves 29% margin to somewhere in the low
30s. **It does not reach 60% on its own.**

L3 is the one that scales, and it scales with tenant count rather than with wording.

So the honest position: the prefix trim is worth doing, and the margin problem is not
solved by prompt engineering alone. The other levers are commercial — the price, the
target margin, or the volume band a ₮250,000 plan is sold against — and those are the
founder's call, not this document's.
