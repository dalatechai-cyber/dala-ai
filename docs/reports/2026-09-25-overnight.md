# Overnight report — 2026-09-25

For the founder. Covers the overnight brief. Written at 2026-09-25 ~03:40 UTC (11:40
Ulaanbaatar) and updated at the end of the session (see the last section).

## At a glance

| Goal | State |
|---|---|
| 1. Comment replies in shadow | **Done, running in shadow on Matrix.** Nothing is posted. 8 of the 42 real comments on record would have been answered |
| 2. Watch live DMs | **No real customer DM since the cutover test turns** (last one 22:19 UTC). Nothing to fix |
| 3. Speed | **Built and deployed**, ≈0.45 s off every no-model reply. **The "after" number still needs one real turn** |
| 4. Flaw report gap | **Done.** «ci henbe» is now flagged twice (old name + internal instructions) |
| 5. Tara rebrand, two branches | **Done, merged and deployed** (PR #169). Inert until a second branch is entered. No price, address or link changed |
| 6. Typing bubble from live logs | **Not confirmed yet** — there has been no live reply since the logging went in. Found and fixed a real ordering bug on the way |
| Spend | **$0.0349** model spend since the cutover (your 7 test turns). This session called the model zero times |

PRs: [#168](https://github.com/dalatechai-cyber/dala-ai/pull/168) (goals 1, 3, 4, 6 — merged
and deployed at 03:24 UTC), [#169](https://github.com/dalatechai-cyber/dala-ai/pull/169)
(goal 5 — merged and deployed at 03:30 UTC). Decisions: D-122 (comments), D-123 (flaw report), D-124 (speed, typing), D-125
(branches).

---

## 1. Comment replies — in shadow

**What runs now on Matrix's Page:** `comment_delivery_mode = shadow`, `comment_policy = both`.
Every comment is classified, and a reply-worthy one gets both rows drafted (public line +
private message), never sent. DMs stay live; the two switches are independent.

- **Own switch:** `tenant_channels.comment_delivery_mode` (off / shadow / live). Live posts
  only while the token is active.
- **Who gets a reply:** questions and requests for information only — price, location,
  booking, hours, «ib», «pm», «info», «дэлгэрэнгүй», phone, a question about a service.
  Rows, not code: 40 rules from a salon template (`scripts/provision/templates/`).
- **Never:** praise, emoji, stickers, jokes (laughter words or 😂 suppress any reply), the
  Page's own comments, and **tags of a person** — read from Graph's `message_tags`, because
  the webhook only carries a tag as a name in the text.
- **One reply per person per post.** The per-thread rule stays.
- **Complaints:** no reply, a flag row, and a Telegram alert with the text and a link to the
  comment. This fires in shadow too.
- **The reply:** your approved public line and private message, both stored as reviewed
  rows. When the customer answers the private message, it arrives as a normal DM.
- **Also closed:** posts older than 30 days are never answered (the archive-spam risk
  docs/comments.md called a precondition for live).

**Tests:** all 42 real comments and at least 30 written examples each of question, praise,
tag, emoji, complaint, joke and Latin-typed — 260+ cases, permanent in CI. **Zero replies to
praise or tags**, asserted as a count. I then probed the rules with 52 comments they had not
been tuned on; 5 misses and 3 false alarms were fixed and all 52 added to the tests.

**Which real comments would have got a reply** (Sep 20 – Sep 24):

| Event | Comment | Rule |
|---|---|---|
| 203 | une hed ve | price (your test comment) |
| 205 | une hed ve | price (tenant #0's Page commenting) |
| 212 | Яармаг хаяг хаана вэ | location |
| 219 | Зэсэн улаан туяа арилдагуу | service question |
| 412 | Хаяг хуучиндаа юу? | location |
| 492 | Amjilt nzdaa 🤗💪🏻 Haashaa nuuj bga we | location (praise + "where are you moving to?") |
| 685 | Woow hayg huuchindaa yu | location |
| 705 | Ashgui de. Tsag avch boloh yum uu? | booking |
| 706 | Yag haana be | — same person, same post as 705: one reply per person |

8 replies. The other 34 (praise, «Амжилт хүсье», emoji, 9 stickers/photos, a reply to
another customer with «hehe») stay silent. No complaint has arrived on the wall yet.

**Before you switch comments live — your call, not done:**
1. **The per-post cap is now 20** (it was 1). With 1, only one person per post per day could
   ever be answered, which contradicts "one reply per person per post". 20 is a flood
   ceiling. Tell me if you want a different number.
2. **The Graph reads (tags, post age) and the private message have never run against Meta**
   — this environment cannot reach graph.facebook.com. The first real comment in shadow
   exercises the reads; the private message only runs when live. Read the first shadow
   comment's logs (`comment_lookup_incomplete` means a read failed) before switching.
3. **The complaint alert's link** is built as `{post permalink}?comment_id={id}`. Standard
   Facebook form, not verified from here.
4. Switch: `update tenant_channels set comment_delivery_mode = 'live' where id = '1fb6d543-3e14-4f42-ab9e-fd39cbc09cd5';`

**Known and left:** a bare service noun on its own («Үс будуулах», «Usnii emchilgee») gets
no reply. On a public wall I kept precision over recall; the shadow list will say how often
it happens.

## 2. Live DMs overnight

**Every real conversation since the 21:54 UTC cutover:** only your 8 test turns
(21:54–22:19 UTC, one conversation). D-119 and D-120 already cover what went wrong in them;
all six cases from that night pass the reply-case gate (6/6 in tonight's production build).
**No real customer has written since 22:19 UTC** (checked at 03:28 UTC and again at the end).
The only webhook since was a reaction at 01:26.

Is the silence a fault? The watchdog reads `healthy` (webhooks inside its 3-hour open-time
window), feed deliveries are still arriving, and previous mornings were just as sparse (0–6
messages an hour before noon). So nothing points to a broken subscription, but I cannot
prove from here that none is broken. If it is still silent past 14:00 Ulaanbaatar, run
`scripts/diagnose/meta-subscription.ts` (D-062).

Found by re-reading the history with the new flaw check (goal 4): 21 replies from before the
rebrand greeted as «Матрикс эко салон», including the **live 09-21 03:28 reply** «Сайн байна
уу! Матрикс эко салон танд юугаар туслах вэ?». The current prefix no longer says Матрикс
anywhere except inside the website URL, so this is history, not a live bug.

## 3. Speed — no-model replies

**Before** (measured on the 7 live turns at cutover):

| Step | Time |
|---|---|
| Customer → our webhook (Meta) | 0.6–1.7 s |
| Webhook → worker start (queue hop) | ~0.9 s |
| Worker reads before the reply, all one after another | ~1.25 s |
| Row-answered reply | 0.11–0.17 s |
| Trace + claim | 0.1 s |
| Send to Meta | ~0.6 s |
| **Total for a no-model reply** | **≈3.8 s** |

**Cut, without weakening any guard** (each refusal is still checked in the same order):
- the attempt count, tenant and channel reads run together (−~110 ms);
- the reply context (10 reads, ~450 ms) loads while the message is being stored (−~300 ms);
- the trace is written together with the claim (−~50 ms);
- the platform spend-counter seed runs with the ceiling read (−~50 ms). No money logic
  changed: the reservation and charge are the same statements in the same order.

**Expected ≈0.45 s faster. After: not measured yet** — no real turn has arrived since the
deploy at 03:24 UTC. The next one's `reply_timing_ms` log line will show it: `context_load`
should be near 0 and `attempt_write` should absorb the tenant and channel reads.

**Not cut, on purpose:** the queue hop (durability), the Meta send, and running the spend
guard in parallel with the history read (it would hold a reservation for a turn that can
still fail — the money direction).

## 4. Flaw report — the «ci henbe» gap

The morning report now reads what a reply SAYS, not only how the conversation went:
- **`old name (…)`** — the reply uses a former name. The names are data
  (`tenants.former_names`, Matrix = {Матрикс, Matrix}), and links are ignored, so quoting
  matrixecosalon.org is not flagged.
- **`internal (…)`** — the reply mentions internal instructions unasked: a gate label (Ш0), an
  internal id (`refusal_public_channel`), a section heading in capitals, or words like
  «заавар», «дотоод», «мэдээллийн сан». Approved lines are cut out first; if the customer
  asked about the bot, it is not flagged.

On the 201 replies on record: 23 flagged, all correct on reading. The live «ci henbe» reply
gets **both** flags: «Матрикс» and «Дотоод зааврынхаа талаар…».

## 5. Two branches (Tara rebrand)

Merged and deployed (PR #169). A tenant can now have branches, each with its own address, map link, phone,
hours and prices. Only what differs is stored per branch. With two or more confirmed
branches, the bot:
- answers directly when the fact is the same everywhere;
- **asks which branch** when the answer differs and the customer has not said;
- gives only the named branch's facts when they have (Cyrillic or Latin spelling);
- never states one branch's price or address for the other.

**With one branch (today) nothing changes** — proven byte-identical against the old code, and
the live prefix does not contain the branch section. **No current price, address or link was
touched.** The new tables are on the project (0047, additive).

How to add the second branch when the salon sends it: the exact rows are in D-125.

## 6. Typing bubble

Nothing recorded whether it worked — the effect swallowed every outcome. It now logs
`typing_indicator` with its outcome and duration. **Unconfirmed on live traffic**, because no
live reply has gone out since 03:24 UTC.

**A real bug found on the way:** for a reply that needs no model, the reply was ready about
150 ms after the bubble was requested, and the bubble was not awaited. So the bubble could
reach Meta AFTER the answer and hang «typing…» under it for up to 20 s. The send now waits
for the bubble, at most 1.5 s. For a model reply the wait is 0; for a no-model reply it is at
most ~200 ms, which the speed work above more than covers.

## Wording waiting for your native read

1. **Which-branch question** (`clarify_branch`, draft `prompt/drafts/branch_clarify.mn.txt`):
   - A (recommended): «Та манай аль салбарын талаар асууж байна вэ? Яармаг салбар уу, эсвэл {ХОЁР ДАХЬ САЛБАР} уу?»
   - B: «Манайх хоёр салбартай. Та аль салбарын талаар асууж байна вэ?»
   Until you approve a row, a branch-dependent answer gets the handoff line, never a guess.
2. **New prompt headings the model reads** (not customer-facing, but Mongolian):
   «=== САЛБАРУУД ===», «=== ХОЛБОО БАРИХ — {салбар} ===», «=== БАЙГУУЛЛАГЫН АЖЛЫН ЦАГ — {салбар} ===»,
   «=== ҮНИЙН ЖАГСААЛТ — {салбар} ===».
3. No new wording came out of live DMs overnight: there were none.

## Spend

- Model: **$0.0349** since the cutover — the 7 test turns at 21:54–21:58 UTC. None since.
- This session: **$0**. The production build's reply-case gate ran 6/6 cases, all answered
  by rows, so no model call.
- Well under the $5 limit.

## Things only you can do

- Approve (or change) the per-post cap of 20 and the `clarify_branch` wording.
- Switch comments live when you're ready (checklist in §1).
- The pre-rebrand items from D-114/D-125 still apply when the new data arrives: the
  «Салбарууд» document says one branch, the handoff line lists phones, and `booking_line` has
  the old domain. Edit them and republish together, or every reply returns 503 `canned_stale`.

## End-of-session update

(filled in below at the end of the session)
