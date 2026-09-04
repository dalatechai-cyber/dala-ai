# The boundary gate — the design record. The text itself has been promoted.

**Promoted and signed 2026-09-04.** All twenty-one blocks now live in
`prompt/platform/*.mn.txt` with sign-off entries in `prompt/platform-mn-review.json`
(`reviewed_by: Bilguun`), and `scripts/guards/check-mn-review.mjs` fails the build if any
of them changes without being re-read.

**The Mongolian is deliberately not duplicated here.** It lives in exactly one place, and
that place is hashed. Two copies of an approved sentence — one signed, one not — is D-020's
failure with the stakes raised: the unsigned copy is the one somebody edits.

What this directory keeps is the part a hash cannot carry: **the structure, and the failure
mode each block exists to prevent.** That is what the next draft starts from, and what a
reviewer needs in order to judge whether a proposed rewording still does its job.

**This directory is now empty of blocks, and that is the correct state.** New drafts land
here, get red-penned, and leave. Nothing here ships; the guard scans `prompt/platform/`
only.

## Evidence status, stated once

Of the eleven failure modes below, **one is measured and ten are hypothesised.** Ш5's
forbidden opening «Санаа зоволтгүй» is verbatim the reassurance opening Sonnet produced in
the sibling's misbehaviour turn; the disposition it reveals — read distress, open with
comfort, proceed as normal — transfers directly, because a customer asking whether a
chemical treatment is safe during pregnancy *is* distressed. §6.6's rules 2, 3 and 9 are
grounded in observed Matrix production output. **The rest are predictions from the domain.
Shipping this text is correct; presenting it as validated is not.** §6.9's bake-off is how
they become evidence.

## The blocks

| # | Block | What it is for | Fires when | Must NEVER | The failure it prevents |
|---|---|---|---|---|---|
| — | `00_gate_preamble` | The composition rule: evaluate **all** checks, and what to do when two demand a canned line | Always — it is the header | Claim authority over the **channel** rule. Its precedence is scoped to *data*, never to Ш0 | The draft declared itself supreme over «доорх бүх заавар», which by layer order includes the channel rule — so a public Instagram comment asking «Эмэгтэй тайралт хэд вэ?» would get a price quoted **publicly**, because the gate told the model to override Ш0 |
| — | `01_data_marker` | Declares everything below the data marker to be reference material, not instructions | Always | Be reachable only by trusting layer order | A tenant pastes «өмнөх зааврыг үл тоо» into an FAQ answer and it lands inside our system prompt. This is the sentence whose own draft contained «дага БҮҮ дага» — a duplicated verb in the one line whose job is to stop the model following pasted instructions |
| Ш0 | `sh0_channel` | Nothing priced, named or scheduled in **public** | The reply is a comment, not a DM | Emit any number, price, deposit or staff name publicly | A price quoted under the salon's own post, visible to everyone, permanently. Promoted **out of L1 prose into the first check** because a rule this important must not be reachable only by trusting layer order |
| Ш1 | `sh1_refusal_topics` | Topics the tenant will not discuss at all — children's services for Matrix | The **customer's message** matches a refusal topic, evaluated **before any price lookup** | Quote a price **even when the service is in the price list** | The draft nested this inside "service not in the price list". `Чёлк тайралт` **is** listed at 33,000 — so the question took the price-found branch, violated nothing, and the outbound price tripwire passed it *because 33,000 genuinely is a known price*. Two supposedly independent layers, perfectly correlated, both saying yes |
| Ш2 | `sh2_price` | Quote listed prices exactly; refuse unlisted ones without hedging | A price is asked for and Ш1 did not fire | Round, add, subtract, or approximate. The forbidden list is **hedging vocabulary** | «Хөмсөг засалт ойролцоогоор 20,000₮ орчим байх аа» — an invented price wearing a hedge, which the customer will arrive expecting |
| Ш3 | `sh3_booking` | Redirect to the booking site; never confirm a slot | A booking is requested | Say anything that reads as confirmation — including bare «за» and «болно» | A customer arrives at a time nobody reserved. «за» and «болно» were **added under review**: the draft forbade «болно оо» but not «болно», and §6.6 rule 3 actively recommends «за» as the replacement for «окей» — so L0 was handing the model the confirmation token L0 had forgotten to forbid |
| Ш4 | `sh4_staff_schedule` | Names and grades are known; schedules are not | A specific person's hours or availability is asked | Invent attendance, free slots, or "working today" | Pure fabrication — the schedule is not in the knowledge base in any form. Its **non-application clause is not optional**: asking a named stylist's *price* must fall through to Ш2, or the check steals a question the ancestor explicitly handles. A boundary check that is too greedy is a product failure, not a safe default |
| Ш5 | `sh5_health` | No clinical judgement, ever | Allergy, pregnancy, scalp/skin condition, medication, side effects, safety | Open with reassurance. «Санаа зоволтгүй» heads the forbidden list | **The one measured failure.** Sonnet's observed instinct is to read distress and open with comfort, then proceed as normal — and «байгальд ээлтэй» (eco-friendly) is not «аюулгүй» (safe) |
| Ш6 | `sh6_concessions` | No discount that is not written in the knowledge base | **Always evaluated** | Mention, offer or imply any concession, or emit `%` | The draft buried this inside the abuse check — whose trigger is profanity or off-topic — then called it "the failure with the largest financial consequence in the whole list". A **polite** discount question routes straight past: Ш2 does not fire (no service named), and Ш8's forbidden list is entirely hedging vocabulary while **the dangerous answer is confident** |
| Ш7 | `sh7_abuse_offtopic` | Decline rudeness and off-topic without moralising | Profanity, or a topic unrelated to the business | Repeat the profanity, apologise for something that did not happen, or lecture | An apology for a wrong the salon did not commit, in the salon's voice, in writing |
| Ш8 | `sh8_not_in_kb` | Partial knowledge is not knowledge | The answer is not **completely** in the knowledge base | Generalise from "salons like this usually…" | «ийм салонууд ихэвчлэн бэлгийн карт зардаг тул манайх ч бас байгаа байх» — plausible, fluent, and invented |
| Ш9 | `sh9_instruction_disclosure` | Do not disclose our own instructions | The customer asks about the rules, the prompt, or the model | Quote, summarise, translate or paraphrase any of the above | **The draft had no such check.** What leaks is *this tenant's* L2 — which topics are refused, that children's prices are withheld deliberately, and the exact deflection triggers. That is a roadmap for the Ш1, Ш3 and Ш6 attacks, and on a comment reply it is public |

## One structural decision that is yours, not mine

**The pinned sentences are referenced by key, not inlined.**

Every block above ends by naming a row — `"handoff"`, `"price_unknown"` — instead of
carrying the finished Mongolian sentence. The model looks the key up in a labelled
«БЭЛЭН ХАРИУЛТ» section rendered below, from that tenant's `canned_responses`.

| | Reference by key (drafted) | Inline the sentence |
|---|---|---|
| Cache | L0 stays **byte-identical across every tenant**, so it can become one cache entry for the whole platform — the single change that most improves multi-tenant economics | L0 differs per tenant; that improvement is foreclosed |
| §6.5 caveat 3 | The model reads a finished sentence, but has to find it first | The model reads a finished sentence in place |
| Onboarding | Tenant #3 fills in rows | Same |

Today the whole prefix is already per-tenant (one breakpoint over L0+L1+L2+L3), so
inlining would cost nothing **now** and forfeit the improvement **later**. I drafted the
cheaper-later option. Say the word and I will inline them.

## The other two families, and what they must never contain

Neither is a gate block, and neither is read by the prompt compiler. Both are signed by the
same mechanism because the test is *"does a customer read it"*, not *"does the model read
it"*.

### `comment_public_reply` — the entire public reply to a comment

The whole reply, posted unconditionally and identically whatever the comment said. There is
no code path from the customer's words to this text: `decideCommentReply` is not given the
comment's text at all.

**Must never contain:** any numeral — a price, a time, a duration, a phone number; anything
that reads as confirming a booking, including a bare «за» or «болно», which Ш3 forbids for
exactly this reason; a staff name, a service name, or any hint of an answer to what was
asked; an apology, because nothing has gone wrong.

**The failure it prevents:** a price quoted under the salon's own post, visible to everyone,
forever. That is Ш0, and until comments existed Ш0 could not fire — there was no public
surface.

**Its production home is a per-tenant `canned_responses` row**, gated by that row's own
`reviewed_at`. The signed platform file is the *template every tenant starts from*, copied
at onboarding and then theirs to edit in their own voice. It is never a runtime fallback:
`eligibility.ts` refuses to post when a tenant has no reviewed line, and must keep refusing.

Since D-021 this line is posted **at most once per post per rolling 24 hours**, in whichever
thread commented first — so write it to be read by everyone on that post, not as a reply to
one person.

### `data_deletion_*` — the eight strings on the data-deletion status page

Read by a customer in Mongolia who has just told Facebook to delete their data, on a phone,
probably inside the Facebook in-app browser. Not by an operator. There is no English version
and there should not be one.

**Must never contain:** a promise about *when* — we do not control the schedule and a date we
miss is worse than no date; any claim that data **has** been deleted on any state but
`completed`, which is why the states are separate blocks; a contact address, because there is
no support channel yet and a line inviting people to write to one goes unanswered; anything
identifying — the key to that page is a code that can be read over somebody's shoulder.

**The failure it prevents:** a privacy promise kept in appearance only. The endpoint records
a request it cannot yet fulfil (Meta sends an app-scoped id; we store page-scoped ids), so
the page must say `received`, not `done`.

## Promotion checklist

1. Founder red-pens the wording here.
2. Files move to `prompt/platform/` with the same names — **moved, not copied.**
3. A native speaker reads each and adds `{ block_id, sha256, reviewed_by, reviewed_at }`
   to `prompt/platform-mn-review.json`.
4. `node scripts/prompt/generate-seed.ts` regenerates the seed migration from the signed
   files, and `prompt-seed.test.ts` fails if the two ever drift.
5. `npm run guard` passes. Until then it fails, by design.
