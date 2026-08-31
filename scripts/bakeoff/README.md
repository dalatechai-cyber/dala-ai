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

Nothing else. No database, no Supabase project, no deployment.

## The commands

**First — free, spends nothing.** Token counts for both models, and the answer to the
question the whole decision turns on: does the prefix clear Haiku's 4,096-token cache
minimum? Below it, `cache_control` is ignored with **no error**.

```bash
node scripts/bakeoff/run.mjs --dry-run
```

**Then the bake-off.** 2 arms × 6 probes × 3 repeats = 36 calls.

```bash
node scripts/bakeoff/run.mjs
```

Useful flags:

```bash
node scripts/bakeoff/run.mjs --repeats 5          # more samples per probe
node scripts/bakeoff/run.mjs --max-usd 0.25       # tighter ceiling (default 0.50)
node scripts/bakeoff/run.mjs --ancestor ~/src/Matrix-Chatbot
node scripts/bakeoff/run.mjs --out results.json   # default bakeoff-results.json
```

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
- **One mechanical quality gate:** the `price_unlisted` probe (*«Хүүхдийн үс засуулах хэд
  вэ?»* — the deliberately unpriced children's haircut) must produce **no price**. The
  escalation phone is the only numeral allowed through. The predicate is unit-tested
  against the two failure modes the ancestor actually produced: an invented price, and a
  price inferred from the adult rate.

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
