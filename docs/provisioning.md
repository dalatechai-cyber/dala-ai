# Provisioning: from a filled questionnaire to a live tenant

**Design only. Nothing here is built** (2026-09-16). D-078 found the gap this closes:
`scripts/provision/` is nine hand-written Matrix SQL files and no template, so client #3
does not fill in a config — somebody writes nine more files.

## What Matrix cost, because that is the number to beat

Days of back-and-forth, and the failures were not clumsiness — they are all legible now and
every one is a thing a pipeline can catch:

| What happened | What it cost | Catchable at intake? |
|---|---|---|
| No address supplied (D-069) | «Хаяг» was the first word a real customer typed; the bot labelled a phone as an address | **Yes** — a required field, absent |
| «Сор» vs «Оффис колор /Сор/» (D-075) | Two services 3.2× apart, one name a subword of the other; unresolvable | **Yes** — `subsetCollisions` |
| No Latin spellings (D-067) | The children's-services rule the founder approved does not fire for «huuhdiin» | **Yes** — ask for them; they cannot be derived |
| Prices never loaded (D-065) | Ш2's branches read as conditions on a list that is not there; the customer loses the better sentence | **Yes** — a required section, absent |
| A promotion end date (D-055) | `9` and `20` entered `allowed_numbers` and nobody meant them to | **Yes** — project the allow-list and show it |

## The shape

    questionnaire  →  intake document  →  validate  →  staged writes  →  two gates  →  publish
     (the client)      (one JSON file)     (refuses)    (idempotent)      (humans)     (compile)

### 1. Format — one intake document per tenant

The questionnaire is how a client answers; it is **not** the machine input. Whatever it
arrives as — a form, a spreadsheet, a phone call written up — it is transcribed into one
canonical file, `provision/<slug>.json`, and that file is the reviewable artefact. The same
shape as `prompt/platform-mn-review.json`: a thing a human reads and signs, not a thing a
script infers.

Why a file and not a form writing straight to rows: a row that appears with no document
behind it cannot be reviewed, re-run, diffed when the client changes their mind, or replayed
for client #4. And the transcription step is where a human notices «the salon said this
service doesn't exist».

Sections map to tables, one to one: `business` → `tenants`; `hours` → `business_hours` +
`tenant_closures`; `services[]` → `services` + `service_variants` + `service_aliases`;
`staff[]` → `staff_members`; `contacts[]` → `contact_points`; `booking` → `tenant_booking`;
`never_say[]` → `out_of_scope_topics` + `disclosure_rules`; `sentences{}` →
`canned_responses`; `faqs[]` → `faqs`; `channel` → `tenant_channels` (+ a sealed secret,
never in the file).

### 2. Validation — and it must refuse, not guess

D-057's rule applies exactly: **when a validator cannot complete, it says so; it never
answers with the part it managed.** Three classes, and they fail differently:

**Shape** — required fields, enums (`price_kind`, contact kinds, weekday 0–6), NFC
normalisation, no `unaccent`-style lossy folding. Fails the run.

**Semantic, and this is the valuable half.** Every one of these already exists in `src/`
and would be *assembled*, not invented:

- `subsetCollisions` (`services/match.ts`) — service names where one is a subword of
  another. **This is the check that would have caught «Сор» before a customer did.** It
  found a third pair nobody had asked about. Output goes back to the client: rename, or
  supply a clarify rule.
- `allowedNumbersFrom` (`prompt/render.ts`) — **project the allow-list and put it in front
  of a human before it is live.** Every numeral the bot will be permitted to say, listed.
  D-055 and D-074 are both "a numeral nobody meant to approve".
- `kindsRequiredByRules` / `kindsReferencedBy` (`gate/match.ts`) — every canned kind the
  tenant's own rules reference must exist. A rule pointing at a missing sentence is a 503
  at the first customer.
- `isTenantConfirmed` / `unconfirmedNames` (`provenance.ts`) — D-020's column. Which facts
  the client actually confirmed, versus which we inferred.
- Script check — which stems are Cyrillic-only. A topic rule with no Latin form does not
  fire for a Latin-script customer, and four of the corpus's first eleven turns were Latin.

**Advisory** — things to surface, not block: ranges as a share of the price list (17 of
Matrix's 40), how many refusal rows end at the same phone number, emoji in proposed
sentences (no approved line has one).

### 3. What writes the rows

`scripts/provision/apply.ts --slug <slug> --file provision/<slug>.json [--publish]`,
replacing the nine SQL files. Three properties, each learned the hard way:

- **Idempotent**, by natural key, so a re-run after a corrected answer is safe.
- **Dry run by default**, printing exactly what it will write — and byte-identical to what
  it then does. D-074: the publish script renders from the operator's checkout, so the
  order is **deploy, `git pull`, run** — three steps, not two.
- **It never sets `reviewed_at`.** The pipeline writes rows; it does not approve them.

Publishing goes through `compileAndPublish` and nothing else (D-058): a publish whose
`content_hash` no reader can reproduce is not trusted.

### 4. Two human gates, and they are not the same gate

**The Mongolian gate — ours.** Every customer-visible sentence, signed by the founder, the
native speaker. The pipeline's job is to make this one sitting rather than a week: emit
**one document containing every sentence the tenant will ever send**, with its kind and the
rule that triggers it. Nothing serves until `reviewed_at` is set — `gate/match.ts` already
refuses with `canned_response_unreviewed`, and `inbound/imageReply.ts` refuses an unreviewed
row. The mechanism exists; what is missing is the document.

**The facts gate — the client's.** Prices, hours, the address, the booking URL. We cannot
confirm these and must not: the whole price guarantee rests on a tenant having *said* the
number. This gate wants a signature — who at the client confirmed, and when — landing in
`confirmed_at`. The questionnaire is that signature if it is dated and attributed.

A third, smaller: **the ambiguity gate**, where the collision report goes back and the
client picks. Matrix's «Сор» is still open and no amount of code will close it.

### 5. When it is incomplete — which it always will be

Matrix's chemistry answers were in flight for days. Refusing to provision until every field
is present would have meant provisioning nothing. The rule this platform already lives by:

> **Absence must be a recorded state, never a gap.**

`hasTenantData`, `not_provisioned`, `price_kind='none'` with a bound refusal, `UNREADABLE`
rather than zero — all of these exist because a missing thing that looks like a present
thing is how this platform has hurt itself most. So:

- **Stage it.** Routing → sentences → knowledge → live, which is what Matrix's nine files
  did by hand. Each stage has a completeness predicate and the tenant sits at the last stage
  it fully satisfies.
- **A missing section produces an explicit refusal**, never silence and never an invention.
  `price_kind='none'` with a bound refusal topic is the pattern: the service is named, no
  number is anywhere in the prompt, and the customer gets a sentence rather than a guess.
- **A readiness report names what is missing**, so nobody has to remember. One line in the
  daily digest per tenant not yet live: *waiting on address, Latin spellings, 12 prices.*

### 6. What it would take

**Most of the hard part is written.** Every semantic check above is an existing exported
function with tests. This is assembly, plus a schema, plus a writer.

| Piece | Rough size | Depends on |
|---|---|---|
| Intake JSON schema + example | small | agreeing the questionnaire's fields map 1:1 to tables |
| Validator (shape + wiring the five existing checks) | **medium — the valuable part** | nothing new |
| `apply.ts` writer, idempotent, dry-run | medium | the schema |
| Review document generator (every sentence, one page) | small | the schema |
| Readiness report + digest line | small | `alerts`/digest, both built |
| Per-vertical gate blocks, signed | **one reading evening per vertical** | the founder; `0018` is already built and inert |

Two things are **not** in scope and should not be smuggled in: sealing the Meta token stays
a separate credentialed step (`scripts/kek/seal.ts`), and nothing here publishes on the
client's behalf.

**The honest estimate:** a working pipeline for a tenant in an already-written vertical is
days, not weeks, because the checks exist. The first tenant in a *new* vertical still costs
a reading evening — and that cost is per vertical, once, not per client.

### 7. What this design deliberately does not do

- **It does not auto-approve Mongolian.** Ever. A pipeline that could would defeat the one
  gate standing between a customer and a sentence nobody read.
- **It does not infer a missing fact.** Not a price, not an address, not a Latin spelling.
  Every one of those is a question for the client, and inventing one is the failure mode
  this whole platform is built against.
- **It does not resolve ambiguity.** `subsetCollisions` reports; the client renames.
