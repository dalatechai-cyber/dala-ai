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
```

**No noise figure is given here on purpose.** This corpus is direct messages, and nobody
sends a salon a DM to say «гоё» — so its praise and emoji counts (1 and 0) are facts about
the wrong population and would read as a measurement of the thing the founder actually
described. The noise rate is the one half of this design that rests on his reading of his
own feed, and printing a number beside it would bury that.

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
`decideCommentReply` receives the enum. `CommentVerdict` is **four** values — the three a
rule may declare (`RuleVerdict`: `escalate`, `reply`, `ignore`) plus `unclassified`, which
is the absence of a matching rule and is deliberately unwritable in a row. There is still no
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
reading them says which. `comment_unclassified` is written for each — **with the comment's
ids and its shape, never its text.** `quality_flags` is not reached by `ops.purge_expired`,
so a copy of a customer's words there would outlive the `webhook_events` row it was copied
from and sit under weaker rules than the original. The operator joins back on `comment_id`
while the payload exists; after that the words are gone, which is correct rather than
unfortunate. The fourteen days still produce a stem list rather than a score.

An **escalated** comment is written the same way, under `comment_escalated`. It has to be:
a public complaint that refused a reply, incremented a counter and left no durable trace is
the one outcome here nobody could act on tomorrow.

D-070's rule applies directly: a mechanism whose correct behaviour and its worst behaviour
look identical from outside is not yet a mechanism. `ignore` and "the classifier has no
rules loaded" must not produce the same counters, so a tenant with zero enabled rules
refuses the whole job as `no_comment_rules` rather than silently classifying everything as
`ignore`.

## A pre-existing defect found while wiring this up

`post_too_old` measures the **comment's** age, not the post's. It is configured by
`comment_max_post_age_days`, §3.8.2 rule 5 justifies it as *old posts attract spam and the
tenant gets no value*, and the value it compares is `value.created_time` on the comment. So
**a brand-new spam comment on a four-year-old post has an age near zero and passes** —
precisely the case the rule was written to stop.

Four things agreed with each other and all four were wrong: the refusal's name, the config
column's name, the docstring, and a test called *"a comment on a post older than the tenant
window"* that constructed an old COMMENT. The branch immediately above it even says
*"Refusing is the direction that cannot put a reply under a four-year-old post."* It is
CLAUDE.md's own lesson — a rule and the code it describes have to be read together, because
each one alone reads as correct.

What it actually does is worth keeping, so it is renamed rather than deleted: `comment_too_old`
bounds how stale a **delivery** this platform will act on, which is a real guarantee against
a replayed or long-delayed webhook.

**The post-age rule is not implemented and cannot be from this payload**: the `feed` webhook
carries `post_id` and no post creation time, and a Facebook post id is not a timestamp.
Closing it needs `GET /{post-id}?fields=created_time` — a Graph read this platform does not
make, on a path that must fail closed. That is a design decision, not a rename, so it is
recorded rather than taken. `eligibility.test.ts` asserts the gap, so it goes red the day
somebody closes it.

## Known and deliberately not fixed here

Three findings from the design review are real, traced to code, and left alone on purpose —
each needs a mechanism this branch would have to invent, and none can fire while
`comment_policy` is `none`.

**The post's age is still not checked.** `comment_too_old` bounds how stale a *delivery*
we act on, which is a real guarantee and not the one §3.8.2 rule 5 asks for. Closing it
needs `GET /{post-id}?fields=created_time` — one Graph read per distinct post per entry,
cacheable, on a path that must fail closed when the read fails. Building that inside a
classifier change would widen it into a Graph-enrichment change.

**The per-post cap checks and writes in two steps.** `repliesPerPost` counts, then
`draftOnce` inserts, and two workers racing the same post can both read a count below the
cap. The thread rule does not have this problem because a unique index adjudicates it; the
post cap has no such key. The honest fix is the shape `0015` used for the spend RPCs — a
`security definer` function taking `pg_advisory_xact_lock` on `(tenant_id, post_id)` — and
that is a migration and an RPC, not a filter. The exposure is bounded meanwhile: the cap is
per post per day and the loser of the race posts one extra reply, not a stream.

**An ignored commenter's comment does not claim its thread.** A stylist commenting from her
personal account is refused by the ignore list, and the refusal persists nothing — so a
customer replying to her in the same thread arrives in a later delivery, finds no
`outbound_messages` row for that thread, and is answerable. Fixing it means a durable
thread-level claim for a comment we deliberately did not answer, which is a new kind of row.

## What is blocked, and on whom

| | Blocked on | Why it cannot be done here |
|---|---|---|
| **App Review** — `pages_read_user_content` + `pages_manage_engagement` | **The founder** | **This is the first gate and the table omitted it.** D-023 settled the submission as the comment delta and nothing else: `pages_read_user_content` gates the `feed` webhook field itself, and Meta makes `pages_manage_engagement` *depend on* it, so the two go together or neither. Until both are granted there is no feed to subscribe to and no way to post a reply — every other row below is downstream of this one |
| Subscribing `feed` | **The founder** | One Graph write on Matrix's live Page. `POST /{page-id}/subscribed_apps` **replaces** the field list rather than adding to it (D-043, D-062) — sending `feed` alone drops `messages` and takes the DM mirror offline. It must be `messages,feed`. Facebook is unreachable from this environment in any case |
| `comment_policy` → `public_only` | **The founder** | A config row, but it is the switch that makes the surface live |
| `comment_public_reply` | **The founder** | Customer-visible Mongolian. Neither tenant has one; the path refuses without it |
| The stem lists | Proposable here | Stems are not customer-visible strings. The corpus suggests the first set; the salon's own vocabulary confirms it |

None of these blocks building and testing the classifier, which is what the branch does —
but note the ORDER, because the earlier draft of this table implied the feed subscription
was step one. It is not. App Review is, it is the multi-week item, and the two Graph
permissions it grants are what make every other row here reachable at all.
