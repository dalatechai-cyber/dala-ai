# Provisioning: from a filled questionnaire to a live tenant

**Built 2026-09-16** (D-079), to this design. The sections below describe what exists;
where the built thing departs from the design, §6 says so and why.

D-078 found the gap it closes: `scripts/provision/` was nine hand-written Matrix SQL files
and no template, so client #3 did not fill in a config — somebody wrote nine more files.
Those nine remain, as Matrix's history. Nothing reads them.

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

### 6. What it took, and where it departed from the estimate

| Piece | Where it lives |
|---|---|
| Intake reader | `src/lib/provision/intake.ts` |
| Validator, readiness | `src/lib/provision/validate.ts` |
| Readiness recorder | `src/lib/provision/record.ts` |
| Review sheet | `src/lib/provision/reviewSheet.ts` |
| Writer | `scripts/provision/apply.ts` |
| Worked example | `intake/example-auto.json` |
| | 31 tests |

Two things are **not** in scope and were not smuggled in: sealing the Meta token stays a
separate credentialed step (`scripts/kek/seal.ts`), and nothing here publishes on the
client's behalf. The per-vertical gate blocks still cost **one reading evening per
vertical** — the founder's, once per vertical, never per client. `0018` and the loader's
selection are built and inert, waiting on a signature.

**Three departures from the design, each because building it found something:**

1. **The readiness state needed no new table.** The design assumed one. `alerts` already
   carries exactly the right model since `0025`: `route: 'digest'` puts a row in front of a
   human at 09:00 without a Telegram, and `repeat_policy: 'on_change'` is an episode that
   opens, holds and resolves. A tenant waiting on its price list does not become newly
   incomplete every morning — that is D-063's question answered for onboarding, and the
   answer is the mechanism D-063 built. So: no migration, nothing blocked on a push, and
   `digest.ts` is untouched. The readiness line appears in the digest because it is an open
   episode, not because the digest learned about provisioning.

2. **An `ask_client` finding had to be able to hold `ready`.** As designed, only blockers
   held provisioning, so a document with an unresolved «Сор» collision reached `ready` —
   which is the exact failure the check was added to prevent, one layer up. `Finding` now
   carries `holdsReady`, and the criterion is consequence rather than severity: set it when
   a *wrong answer could reach a customer while the question is open*. A name collision
   qualifies (a real price against the wrong service, D-075); a missing Latin stem does not
   (a rule that fails to fire leaves the model answering unrefused, which the outbound guard
   still bounds).

3. **The reader was accepting unknown keys and casting.** Found by writing the example.
   `raw as IntakeDocument` handed the writer whatever else was in the file, unexamined,
   under a name that claimed it had been checked — "answer with what you managed" (D-057)
   wearing a type annotation. And a questionnaire exported with `never_say` instead of
   `neverSay` parsed perfectly, yielded an empty rule list, and would have let the bot
   discuss the one topic the business said it must never discuss. The document is now built
   field by field from what was validated, and an unrecognised key is reported.
   `_`-prefixed keys are annotations and are dropped.

### 7. What this design deliberately does not do

- **It does not auto-approve Mongolian.** Ever. A pipeline that could would defeat the one
  gate standing between a customer and a sentence nobody read.
- **It does not infer a missing fact.** Not a price, not an address, not a Latin spelling.
  Every one of those is a question for the client, and inventing one is the failure mode
  this whole platform is built against.
- **It does not resolve ambiguity.** `subsetCollisions` reports; the client renames.
