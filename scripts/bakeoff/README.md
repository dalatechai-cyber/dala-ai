# Reception model bake-off

Settles [`DECISIONS.md`](../../docs/DECISIONS.md) D-009 — which model Reception AI runs —
and with it every ceiling downstream, because the ceiling derives from the margin floor
and the margin depends on the per-reply cost.

**Two arms, on the real Matrix prefix and the six seeded probe prompts:**

| Arm | Model | Why it is in |
|---|---|---|
| **D** | `claude-sonnet-5` | The incumbent, for a production-observed reason (`salonBrain.js:16-18`) |
| **E** | `claude-haiku-4-5` | Half the price — *if* its 4,096-token cache minimum is cleared |

## What you need locally

1. **Node 18+** — for global `fetch`. No dependencies, nothing to install.
2. **The ancestor checkout**, because the prefix is read from it rather than copied
   here — a second copy of the salon's price list is a second thing that can drift:
   ```bash
   git clone https://github.com/dalatechai-cyber/Matrix-Chatbot
   ```
   Expected at `/home/user/Matrix-Chatbot`; override with `--ancestor <path>`.
3. **`ANTHROPIC_API_KEY` in your environment.** Read from the environment only — the
   script has no flag for it and never logs it.
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

Nothing else — the bake-off reads a checked-out prefix and calls Anthropic. It needs no
database, no Supabase project and no deployment, and that is a statement about its
requirements, not about what exists.

## The commands

**First — free, spends nothing.** Token counts for both models, and the answer to the
question the whole decision turns on: does the prefix clear Haiku's 4,096-token cache
minimum? Below it, `cache_control` is ignored with **no error**.

```bash
node scripts/bakeoff/run.mjs --dry-run
```

**Then the bake-off.** 2 arms × 6 probes × 3 repeats = 36 calls.

```bash
node scripts/bakeoff/run.mjs --harden --out bakeoff-hardened.json
```

`--harden` appends [`hardening-mn.txt`](hardening-mn.txt) to the prefix: Mongolian-quality
and misbehaviour rules **written in Mongolian**, naming the specific wrong forms observed
in the first run with worked wrong-examples. This is the M0 precedent from Core English —
a rule that only describes the right answer loses to the model's disposition; a rule that
forbids the *specific* wrong answer holds. It requires having seen the failure, which is
why the block exists only after a native-speaker review of an unhardened run.

Omit `--harden` to reproduce the unhardened baseline:

```bash
node scripts/bakeoff/run.mjs --out bakeoff-plain.json
```

The block adds 2,568 characters (+23%), which raises per-reply cost slightly for both
arms and pushes both further clear of Haiku's cache minimum.

Useful flags:

```bash
node scripts/bakeoff/run.mjs --repeats 5          # more samples per probe
node scripts/bakeoff/run.mjs --max-usd 0.25       # tighter ceiling (default 0.50)
node scripts/bakeoff/run.mjs --ancestor ~/src/Matrix-Chatbot
node scripts/bakeoff/run.mjs --out results.json   # default bakeoff-results.json
```

## Measuring what the prefix is made of

Separate from the bake-off, and free — it makes no API call:

```bash
node scripts/bakeoff/compose.mjs             # per-section table
node scripts/bakeoff/compose.mjs --markdown  # regenerates the table in docs/prefix-trim.md
```

It splits the real prefix on the ancestor's own `=== TITLE ===` delimiters and classifies
each section as platform, tenant or examples — which is the input to the margin-recovery
argument in [`docs/prefix-trim.md`](../../docs/prefix-trim.md).

It exists because that figure was typed by hand and drifted: two documents in this repo
carried two different answers for the same prefix, and neither summed to its own total.
So the script **throws** on a section it cannot classify rather than bucketing it as
"other", and asserts the parts sum to the whole. Both of the original errors would now
stop it instead of producing a plausible table.

**Not wired into CI, deliberately** — it needs the ancestor checkout, which is private, so
a CI step needing it fails to clone and skips green. That already happened here once. The
accounting is tested against a synthetic fixture in
[`test/compose.test.mjs`](test/compose.test.mjs), which does run in CI.

## What it costs

**Projected ≈ $0.07 at the defaults**, against a $0.50 ceiling — materially less than the
~$0.45 originally budgeted, because caching makes the repeats nearly free after the first
call in each arm.

Spending is bounded twice, deliberately:

- the projected cost is computed **before the first call** and the run **refuses** if it
  exceeds `--max-usd`;
- the running total is checked **before every call thereafter**, so it stops mid-run
  rather than overshooting.

## What it measures

Everything from the real `usage` block. Nothing estimated.

- **Cost per reply** per arm, using the same prices seeded into `model_prices`.
- **Whether caching actually engaged** — `cache_creation_input_tokens` and
  `cache_read_input_tokens`. For Haiku this is the whole economic question, and its
  failure mode is silence, not an error.
- **An ungrounded-numeral gate on EVERY probe.** Any number a reply states that does not
  appear in the prefix was invented. The escalation phone is exempt.
  **The first version watched only the children's-haircut probe**, and a native-speaker
  review caught a deposit figure quoted on a *different* probe that the gate never looked
  at. Widened, and unit-tested.
- **A stricter rule still on `price_unlisted`** (*«Хүүхдийн үс засуулах хэд вэ?»* — the
  deliberately unpriced children's haircut): **no number at all**, grounded or not. A price
  copied from an adjacent service is still the wrong answer.

## What it does NOT measure

**Mongolian naturalness.** A script cannot settle that and this one does not pretend to.
Every reply is printed and written to the results file for a native speaker to read. That
review is a gate on shipping, not a nice-to-have — `canned_responses.reviewed_at` is null
until someone signs off, and the prompt renderer refuses to build a prompt containing an
unreviewed line.

## Reading the result

Haiku wins on cost by roughly 2× **only if its cache minimum is cleared**. If `--dry-run`
reports `NOT MET`, Haiku pays full rate on the prefix every single message and its
headline price advantage evaporates — that is the cliff, and it is why this measurement
exists rather than an argument about model tiers.

The decision is commercial, not technical: at the D-004 floor price the allowable spend is
₮80,000 ≈ $22.86/month, and the arm that clears the 60% margin at the volume a *successful*
salon produces is the one that ships. Record the outcome in D-009 and only then set the
ceilings.

## A second model in the seat: `arms.ts` (Egune vs Sonnet 5)

`arms.ts` answers a tenant's whole test set through `gateTenant` — the D-120 gate the
production build runs — so the prompt, deterministic rows, pinned lines and every guard are
production's own, and ONLY the model seat changes between arms. The tenant's live rows come
from `tara-live.json`, a read-only dump served by `fixtureDb.ts` (writes throw), and the run
refuses to start unless the dumped `prompt_stable` hashes to its snapshot's `content_hash`.

```bash
EGUNE_API_KEY=…     node scripts/bakeoff/arms.ts --arm egune  --tag night1 [--egune-model egune1-14b]
ANTHROPIC_API_KEY=… node scripts/bakeoff/arms.ts --arm sonnet --tag night1
node scripts/bakeoff/compare.mjs --a sonnet-night1 --b egune-night1 [--b-usd-in X --b-usd-out Y] > report.md
```

Or, with both keys as repository secrets, run the **Bake-off arms (Egune vs Sonnet 5)**
workflow from the Actions tab; the report lands in the run summary. `api.egune.com` is not
reachable from the Claude Code cloud environment unless it is added to that environment's
allowed domains.

The set: every active `reply_cases` row (judged against the founder's expected answer),
`testset.json`'s cases and conversations (replies fed back as history), and
`tara-set.json`. `testset.json`'s attachment cases are left out — the runner is text-only.
Only the prompt and these messages are sent to a model; the two personal names in the set
(«Badmaa», «оюунаа») are staff names already in Tara's prompt.

Re-dump `tara-live.json` after any republish (the hash check will refuse a stale one):
one `select jsonb_build_object(…)` over the tables `reception/load.ts` and
`replycases/run.ts` read, with `tenants` pruned to the six columns they use.

`egune.ts` is the only Egune code, and nothing in `src/` imports it. Egune's pricing, context
window and data terms were not readable from here (every official page is behind the egress
proxy); the wire shape comes from the official `egune` npm SDK. `compare.mjs` computes
Egune's cost only when a price is passed in.
