# Which comments deserve a reply

The design for the comment classifier, proposed before it is built, per the founder:

> Most of a salon's comments are «гоё», tags and emoji; answering all is noise, answering
> none misses «хэдэн төгрөг вэ» asked in public. Propose the design against the real feed
> first.

## The real feed does not exist, and that is the first finding

It was asked for and it is not reachable. Four measurements, all made 2026-09-18:

| | |
|---|---|
| `webhook_events` | **89 rows, 82 unpurged, every one an entry with `messaging`. Zero with `changes`.** Not one comment delivery has ever arrived. |
| `tenant_channels.subscribed_fields` | `["messages"]` on **both** Pages. `feed` is not subscribed, so Meta has never had reason to send one. |
| `tenant_channels.comment_policy` | `none` on both. Even with deliveries, `decideCommentReply` refuses at its first check. |
| `canned_responses` | No `comment_public_reply` row for either tenant. Even past the policy, the decision refuses `no_reviewed_line`. |

`graph.facebook.com` and `www.facebook.com` both fail outright through this environment's
egress proxy (re-measured: connection refused, not a 403), so the feed cannot be read
around the platform either.

So the design below is grounded in the one real Mongolian corpus this platform has: **71
inbound direct messages from Matrix's live customers**, 2026-09-14 to 2026-09-18. That is
a different surface and the difference is stated wherever it bites. It is not the feed,
and no sentence here should be read as though it were.

**The ancestor has nothing to port.** `Matrix-Chatbot` handles no comments at all — the
only match for the word in its source is a code comment in `lib/cors.js`. For the first
time in a week (D-067, D-076, D-081) the incumbent does not have a rule we lack, so this
surface carries no measured regression against it. It is new ground.

## Question-shape is the wrong signal, measured

The obvious classifier asks *is this a question?* — a `?`, a final interrogative particle
(«вэ», «уу», «юу»), an interrogative word («хэд», «хаана», «яаж»). Against the corpus:

```
question-shaped            20/71  (28%)
bare noun phrase, ≤3 tokens 37/71  (52%)   no question marker at all
praise / thanks              1/71  ( 1%)
emoji-only                   0/71  ( 0%)
```

**It is wrong in both directions at once.** The 52% it ignores is the demand:

> «Хаяг» · «Хими» · «Мэдээлэл» · «Salbaruud» · «Tsagiin huwaari» · «Цаг авах» ·
> «Usnii emchilgee» · «Үс будуулах» · «Эмэгтэй хими»

These are bare topic nouns, and they are exactly the customers worth answering. Meanwhile
the greetings it *does* fire on are the ones to stay silent for — «Сайн байна уу», «sn bna
uu», «Sain bna u», «Уу» — because «уу» **is** the interrogative particle. A detector built
on it greets the greeters and ignores the buyers.

## Topic-shape is the signal

Matching stems per topic instead, using the platform's own `containsStem` and
`matchesStemSequence`. Measured against the rule set now in `classify.test.ts`, which is
the shape a salon operator would write — Cyrillic and romanised spellings side by side:

```
reply           46/71  (65%)
escalate         4/71  ( 6%)      71% actioned
ignore           1/71  ( 1%)
unclassified    20/71  (28%)
```

and the 28% left silent is almost entirely right to be silent:

| | n | Silence is |
|---|---|---|
| Greetings — «Сайн байна уу», «hi», «Sn bnu?», «Ж» | 11 | **correct.** A public greeting needs no public reply |
| Mid-conversation fragments — «Эмэгтэй 1р зэргийн», «Хийлгэх юм», «Иймэрхүү», «Emegtei / Master» | 5 | **correct on comments.** These answer a question the bot asked; a comment thread is effectively single-shot |
| Genuine misses — «Мэдээлэл», «Үс будуулах», «Очиж үсчинтэйгээ уулзаж…», «Us toslogtood bn» | 4 | a stem away each; a config edit, not a code change |

They are left in rather than tuned away. A rule set edited until this corpus scores well is
a rule set measured against its own training data, and the shadow phase exists to find
exactly these four against the real feed.

Two method notes, both corrections to this document's own earlier drafts:

- **The first pass measured 56% and was measuring its own bug.** It reimplemented
  `containsStem` by splitting the subject into tokens and testing `startsWith`, which makes
  every multi-word stem silently unmatchable — so the booking intent, the clearest in the
  corpus, scored zero. `containsStem` is a Unicode-boundary substring match, not a token
  split. This is D-077's lesson in a third file: **a diagnostic that reimplements the thing
  it measures is measuring the reimplementation.** The figures above import the real functions.
- **Both "over-matches" the probe reported were the probe's fault.** «цагаан будаг» firing
  `service` via `будаг`, and «цагаан өнгө» firing it via `өнгө`, are correct — those are
  service questions about white dye and white colour. The trap strings contained genuine
  service words. No true over-match was found.

### The floor, and what it costs

`MIN_STEM_CHARS = 4` exists because a short stem over-matches: `үс` (hair) also fires on
«үсэрсэн» (jumped). It has a real cost here. **«цаг» — appointment, the single most
valuable intent a salon has — is three characters**, and it also begins «цагаан» (white),
so a bare `цаг` fires booking on a colour question.

**And it is not one word.** «хэд» — *how much* — is three characters as well, and it also
begins «хэдийнээ»; so the two most commercially important words a salon's customers type
are both below the floor, and both for good reason. That was found by a test failing, not
by reading: the first rule set carried `хэдэ`, which catches «хэдэн» and misses «хэд болох
вэ», and the corpus contains both.

`matchesStemSequence` is the answer and it already exists, built for outbound forbidden
phrases. Its own docstring uses `['цаг', 'авл']` as the worked example. Ordered stems
within a code-point window catch «Цаг авах», «цаг авдаг уу», «Цаг авах гэсэн юм», «tsag
avii» and «цагаа авмаар байна», and do not fire on «цагаан». `['хэд','вэ']` within 24 characters does the same for price.
A sequence is bounded by its ordering and its window, which is why `['цаг','ав']` is
admissible where a bare `цаг` is not — that exemption is a property of the mode, not a
per-row override, and `parseMatcher` enforces its limits: at least two stems (one stem in a
sequence is `contains_stem` with the floor removed) and a window no wider than 40 code
points (an unbounded window is the unanchored matcher rule 6 forbids, wearing a
tightening's clothes).

What the exemption does **not** buy, stated because it is real: «цагаан авна» — *I will
take white* — fires `['цаг','ав']`, nine characters apart. On this surface it costs nothing,
because both readings are a customer worth answering and the reply is one fixed sentence
either way. Where the matched TOPIC selects what is said, it would be a genuine mislabel.

### Latin script is rows, not code

52% of the corpus carries no Cyrillic. Per D-067 and the ancestor's own
`/^(сайн|байна|уу|hi|hello|hey)/i`, the fix is to **list** the Latin spellings beside the
Cyrillic ones — `hayg`/`xayg` beside `хаяг`, `himi` beside `хими`. No transliteration
engine, no romanisation standard. Stems are not customer-visible strings, so they are not
founder-gated; **which** spellings Matrix's customers use is a data question the corpus
answers.

## The cap makes this a prioritiser, not a filter

`comment_replies_per_post_per_day` is **1** (0009, the founder's call). Replies are decided
as each delivery arrives, first-come-first-served. So:

> If the first comment on a post is «гоё» and it takes the day's one reply, the «хэдэн
> төгрөг вэ» that arrives an hour later gets nothing.

The cap does not merely bound noise — it makes noise **displace** signal. A false positive
is not one wasted comment, it is one lost question. That inverts the usual bias:

**On the public surface, precision matters more than recall.** Silence is not a failure to
answer; it is holding the day's one reply for something worth spending it on. This is the
opposite of the DM surface, where an unanswered message is simply unanswered.

Not proposed: holding comments in a window to pick the best one. A late reply on a public
wall is worse than a prompt one, and the delay would be visible to everyone reading.

## Three verdicts, not two

The corpus contains four complaints in 71 messages (5.6%), and the classifier finds all
four:

> «Утсаа авахгүй байна» — *you are not answering the phone*
> «2 өдөр залгаж байна» — *I have been calling for two days*
> «ai bish huntei holbogdmoor bna» — *I want to talk to a human, not an AI*
> «asuult oilgoh tuvshnii bish bna» — *it is not at the level of understanding questions*

In a DM these are bad. **In a public comment they are the most important thing on the
wall**, and the pinned line — *come to DM* — is close to the worst available response: a
brush-off to a visible complaint, in the salon's own voice, permanently, under their own
post, where their other customers are reading it.

So the classifier returns three verdicts and not two:

| Verdict | Effect |
|---|---|
| `reply` | eligible for the pinned line, subject to every existing check |
| `escalate` | **posts nothing**, writes a flag for the operator, does **not** consume the post's daily allowance |
| `ignore` | nothing, counted |

**`escalate` is evaluated before `reply`, and the precedence is total and declared in
code, not a `priority` column.** One of the four complaints — «ai bish huntei holbogdmoor
bna» — contains `holbog` and is caught by the *contact* topic, so under any ordering where
`reply` can win it would be answered "come to DM" to a customer explicitly asking not to
talk to a bot. This is D-066's ordering lesson: guard item 0 runs before every other check.

A `priority` integer was rejected for D-075's reason — ambiguity must be a verdict, never a
tie broken silently. With a total order over three verdicts there is no tie to break.

## The classifier never touches the reply text

`comments/eligibility.ts` states the safety argument this feature rests on:

> `decideCommentReply` never receives the customer's words. […] "Never answer prices,
> availability or treatment questions in a comment regardless of what is asked" is not a
> rule the code follows; it is a sentence that cannot be expressed in this function's
> inputs.

A classifier reads the comment text, so the naive wiring — adding `text: string` to
`decideCommentReply` — destroys exactly that. D-082 names the shape: *the bug was not that
somebody chose the wrong string, it was that the parameter accepted one.*

So the classifier is a **separate function whose output is an enum**, and
`decideCommentReply` receives the enum. `CommentVerdict` is three values; there is still no
parameter through which a question about prices could influence an answer, and the reply is
still the tenant's reviewed row, byte for byte.

## It must not be a model, and that is a security argument

A public comment is attacker-controlled text from anyone with a Facebook account. Three
reasons the classifier is deterministic rows rather than a model call:

1. **Injection has nowhere to land.** With a fixed reply and an enum verdict, the worst a
   crafted comment can achieve is a wrong enum — it cannot produce prose. A model in this
   loop would put attacker-supplied text in front of the model on the one surface where
   output is public and permanent.
2. **Cost.** A popular post draws dozens of comments. Each would be a cold classification
   for a reply that is one fixed sentence. D-072 measured a cold reply at $0.0406 against a
   $1.50 daily surface cap.
3. **"Client #3 fills in a config."** A stem list is reviewable, diffable and editable by
   the operator. A prompt is none of those.

## Rows, not code

Rules live in a new `comment_rules` table using the **same `matcher` jsonb** as
`out_of_scope_topics`, parsed by the same `parseMatcher`, so there is one matcher language
across the platform. `MatcherSpec` gains a `stem_sequence` mode wrapping the existing
`matchesStemSequence`. Nothing in `src/` names a topic, a stem or a tenant: a salon that
sells something no other salon sells is rows.

## Shadow first, and the shadow phase's product is the silence

Comments run in `shadow` before they go live, as the founder requires, and `worker/
comments.ts` already splits generate from deliver so a shadow run exercises the thread rule
and the per-post cap rather than stubbing them.

The thing to measure is **not** the replies. It is the comments that got **no verdict** —
every one is either a stem the operator should add or a silence that is correct, and only
reading them says which. `comment_unclassified` is written for each, with the text, so the
fourteen days produce a stem list rather than a score.

D-070's rule applies directly: a mechanism whose correct behaviour and its worst behaviour
look identical from outside is not yet a mechanism. `ignore` and "the classifier has no
rules loaded" must not produce the same counters, so a tenant with zero enabled rules
refuses the whole job as `no_comment_rules` rather than silently classifying everything as
`ignore`.

## What is blocked, and on whom

| | Blocked on | Why it cannot be done here |
|---|---|---|
| Subscribing `feed` | **The founder** | One Graph write on Matrix's live Page. `POST /{page-id}/subscribed_apps` **replaces** the field list rather than adding to it (D-043, D-062) — sending `feed` alone drops `messages` and takes the DM mirror offline. It must be `messages,feed`. Facebook is unreachable from this environment in any case |
| `comment_policy` → `public_only` | **The founder** | A config row, but it is the switch that makes the surface live |
| `comment_public_reply` | **The founder** | Customer-visible Mongolian. Neither tenant has one; the path refuses without it |
| The stem lists | Proposable here | Stems are not customer-visible strings. The corpus suggests the first set; the salon's own vocabulary confirms it |

None of these blocks building and testing the classifier, which is what the branch does.
