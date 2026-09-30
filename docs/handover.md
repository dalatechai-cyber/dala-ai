# Thread control: the inbound half, and the reclaim path it is built for

**The inbound half is BUILT (2026-09-17), and since 2026-09-19 it can actually fire:**
`tenant_channels.meta_app_id` was NULL on every channel, which made every verdict `unknown`
and every handover event a parse-and-discard. Both `facebook_page` channels now carry an id
(D-089); the `web` channel does not and will not, because handover is Meta-only.

**The outbound CALLS are written (`src/lib/handover/graph.ts`, D-090) and wired to nothing.**
Passing control is a live mutation of a real salon's thread ownership: it cannot be
rehearsed during a shadow mirror, and the receiver configuration on Matrix's Page is not yet
known.

**The staff-hold reclaim is BUILT (founder, 2026-09-30, superseding D-162) and inert** until
a tenant has a reviewed `handover_reclaim` row; no tenant has one. See
[The staff-hold reclaim](#the-staff-hold-reclaim-built-2026-09-30-inert-until-a-reviewed-row)
below. It needs no Graph call.

## What is unverified, and stays unverified until a real event

`developers.facebook.com` is refused by this environment's egress proxy — **403 through the
CONNECT tunnel, measured 2026-09-17**. No session here can read Meta's current docs. So:

| Claim | Status |
|---|---|
| Handover calls need only `pages_messaging` (already Advanced Access) | **unverified** — console |
| No App Review beyond that | **unverified** — console |
| The Page Inbox app id is `263902037430900` | **unverified** — appears in tests as a fixture, and nothing depends on it being right |
| Handover events arrive in `entry.messaging[]` | **unverified** — so `entry.messaging_handovers[]` is searched too |
| Control never returns on its own | **unverified**, and the reclaim design assumes it does not |

`parseHandoverEvents` counts what it cannot classify (`unrecognised`) and the worker logs
it as `handover_unrecognised`. **That counter is the instrument**: the first real handover
event on a live Page is what settles the shape, and an entry carrying a handover key that
we could not read is the most informative thing this path can emit.

## The state machine

Three states on `conversations.thread_control`. `unknown` is the default for every
conversation, including every one that predates `0027`.

```
                   pass_thread_control → us
        ┌──────────────────────────────────────────────┐
        │                                              ▼
   ┌─────────┐   pass → someone else / take from us  ┌─────┐
   │ unknown │ ───────────────────────────────────►  │human│
   └─────────┘   echo whose mid is not ours (live)   └─────┘
        ▲                                              │
        │          cooldown elapses (no Graph call)    │
        │  ◄───────────────────────────────────────────┘
        │   (a customer's NEXT message is answered; one held
        │    during the cooldown is not re-driven by this)
        │
   staff-hold reclaim (echo only): human → bot, source `reclaim`,
   after the reviewed line is sent. See below.
        │
   (every conversation starts here: nobody has read the far side)
```

**`bot`** is reachable from Meta naming us as the new owner, and from the staff-hold reclaim
(source `reclaim`), which writes it only after the reviewed line was sent. The gate refuses
on `human` alone.

### Why `unknown` is the default and why that is safe

`bot` would be convenient and is a claim this platform cannot support — nobody has ever
read the far side of a Meta thread, and D-062 is eleven days of exactly that mistake.
D-063's addendum is the rule: a migration adding a discriminator with a default is
retroactively deciding the semantics of every row already there, and those rows are the
ones that motivated the change.

So the default is honest, and **H11 check 4 refuses only on a positively-established
`human`.** The two halves are one design. Widen the gate to refuse on `unknown` and every
tenant goes silent at once.

### Echo detection is off unless the channel is `live`

The trap that would have made this actively harmful, and it is specific to how Matrix is
being run today. An echo is "an outbound message whose `mid` is not one of ours", and the
inference is "therefore a person typed it". On Matrix's Page that inference is **false in
the ordinary case**: the ancestor is live there answering customers all day, while Dala AI
is in `shadow` and has never sent anything, so `provider_message_id` is null on every draft
we have ever written. Every ancestor reply is an echo that is not ours.

Wired naively, day one of this feature marks every active conversation `human`, check 4
silences the mirror on exactly the conversations worth measuring, and the fourteen days
produce nothing — while the cause looks like a quiet afternoon.

So an echo moves control only where `delivery_mode = 'live'`. Elsewhere it is **counted**
and nothing moves: the count is worth having, the inference is not.

## The staff-hold reclaim (BUILT 2026-09-30, inert until a reviewed row)

The founder's rule (2026-09-30, superseding D-162): *"If staff have taken over a chat and
nobody has replied within 2 hours during the salon's opening hours, Дали sends one approved
line and resumes."*

**The fault it fixes.** A staff echo (or a Meta handover event) makes a thread `human`, and
check 4 holds the customer's message for the cooldown. A held message is never looked at
again: nothing re-drives it after the cooldown. Measured read-only on Tara's Page: one
customer wrote two seconds after a staff reply and waited ~33 hours for the next staff
answer; another waited ~24.5 hours.

**How it runs.**

1. The hourly health run (`src/lib/worker/health.ts`, sixth step) calls
   `reclaimHeldConversations` (`src/lib/handover/reclaim.ts`). It reads live, token-active
   Messenger and Instagram channels, their `human` conversations active in the last 48 hours,
   each tenant's `business_hours`, `tenant_closures`, timezone and `handover_reclaim` row.
2. `decideReclaim` (pure) decides per conversation. It sends only when: the thread is `human`
   from an `echo`; the customer's latest stored message is strictly after
   `thread_control_at` (the last staff activity); no reply of ours was drafted and sent since
   it; at least **120 open minutes** have passed since it (the silence watch's own walk,
   `openMinutesSince` in `health/silence.ts`, so closed nights and closure days do not
   count); the salon is open now; and the message is under **23 hours** old.
3. It re-enqueues the held message's own stored webhook event to the reception worker with
   `reclaimMid`, as the catch-up does with `catchUpMid`. The worker (`src/lib/worker/reclaim.ts`)
   re-checks everything against fresh reads, then serves the reviewed row's bytes through the
   ordinary send path: `draftOnce` under `reclaim:<mid>` (Meta's own id), the person-replied
   re-check (`personRepliedSince`), `claim`, `deliver`. No model, no spend. Before a send (not
   before finishing a line already sent) it also re-checks the 23-hour window by Meta's own
   timestamp and that the salon is **open now** (`openAt`, the same helper the sweep uses; a
   QStash redelivery can land after closing). Unreadable or unentered hours refuse.
   A reclaim job re-uses the held message's `webhook_events` row but is **not a delivery of
   it**: it does not bump `attempts` and cannot raise `webhook.delivery_exhausted`.
4. After a confirmed send it flips the thread back: `thread_control = 'bot'`, `source =
   'reclaim'`, conditional in SQL on the thread still being `human` with no staff activity
   since the message, so a staff echo landing in between wins. The customer's NEXT message
   is answered by Дали. The held message itself is not answered by the model; the line is
   the answer.
5. A person is told (`conversation.needs_person`, reason `reclaim_sent`) and the flag
   `handover_reclaim` is written. **This is the only page on the reclaim path.** It is
   raised only after a flip the job itself made, and the flip is conditional on `human`, so a
   second job for the same message cannot page again.

**Latency.** Hourly: the line goes out at the first run after the 120th open minute, so up
to about three hours after the customer wrote on an open afternoon, and the next opening
morning when the window runs across closing time. The cadence lives in the QStash console,
not in this repository.

**What is not sent to, and why.** The sweep pages nobody. Every case below is a count in the
hourly health receipt (`reclaim: { <reason>: n }`), not an alert.

| Case | What happens |
|---|---|
| No reviewed `handover_reclaim` row | Nothing: no send, no flip, no page. Counted `no_reviewed_line`, only for conversations that would otherwise have been sent to |
| Message 23 h old or more (Meta's 24-hour window, less an hour for the queue: QStash's last redelivery was measured ~33 min after the first) and no line sent yet | Nothing sent, **not paged**, counted `window_missed` on each run while inside the 48 h lookback. Not paged because the sweep cannot tell a customer it failed from one it could never have served (aged out before the reviewed row existed, before the first sweep after a deploy, or while a closure ate the two open hours), and switching the feature on would page every 23–48 h old held message at once. A line already `sent` whose flip was lost is still finished at any age |
| Thread `human` from `handover` (a Meta handover event, or the bot's own media hand-off) or `passed` | Nothing sent, **not paged**, counted `meta_holds_thread` at the moment a send would have happened. Not sent because if Meta really holds the thread in another app a send needs `take_thread_control` first, which has never been exercised. Not paged because the bot's own media hand-off writes `handover` too, so "staff took the chat through Meta's inbox" would be false for every photo, and it would re-create the media hand-off page the founder switched off for Tara (D-153) |
| A person's echo is stored since the message (worker) | Nothing sent; the `reclaim:<mid>` row is drafted and marked `refused` (`reclaim_person_replied`), so it is terminal: the sweep counts `reclaim_refused` and never re-enqueues it |
| The send failed and Meta's answer says no retry fixes it (`retryable: false`: recipient unreachable, consent, a revoked token) | The row goes `failed` → `refused` (`reclaim_send_not_retryable: <failure>`), terminal as above. A retryable failure stays `failed` and the next hour's job re-claims it |
| Salon closed when the job runs (a late redelivery), or hours unentered or unreadable | Nothing sent or drafted (worker refuses `closed_now`, `hours_not_configured`, `unreadable`); the next sweep decides again |
| Staff replied after the customer, or a reply of ours exists | Nothing |
| Any read the decision needs is unreadable | Nothing for that conversation this hour, counted `unreadable`; the channel or conversation list unreadable makes the health run 503 |
| Shadow channel (testers included) | Never reaches the sweep; the worker refuses `not_delivering` as well |

**Crash order.** Send, then flip. A crash between them leaves the row `sent` and the thread
`human`; the next sweep sees the `sent` row and re-enqueues, and the worker's claim answers
`already_sent`, so only the flip runs. A retryable send failure leaves the row `failed`,
which the next hour's job re-claims. Every refusal in the worker is a 200: the hourly sweep
is the retry, and a 503 would page the founder through the exhaustion alert about an
optional line.

**Not verified:** anything against the live project. The unit tests stub the database; no
reclaim has run on a real Page, and none can until the founder approves the wording and a
reviewed row exists. The behaviour of a send on a thread Meta assigned to the Page Inbox
through a handover event is unknown here, which is why those threads are counted, not sent to.

## The pass path, for when the outbound half is built

1. The bot decides a person should take over → `pass_thread_control(target = Page Inbox)` →
   `thread_control = 'human'`, `source = 'handover'`, `thread_control_at = now` → **send the
   handover notice**.
2. Check 4 keeps the bot quiet for `tenants.human_takeover_cooldown_minutes`.
3. **Nobody picks it up.** No echo arrives on that thread within the reclaim window.
   `take_thread_control()` → `thread_control = 'bot'`, `source = 'reclaim'` → **send the
   reclaim line**.
4. A person *does* reply — an echo that is not ours — and the thread stays `human`.

(Step 3 as written here, a 15-minute reclaim of our own passes with `take_thread_control`,
is **retired** with the sweeper that implemented it. Nothing writes `passed`. If the pass is
ever built, its reclaim is the staff-hold reclaim above plus the Graph take, decided then.)

**Step 3 is the whole reason to build any of this.** The founder's stated motive is that a
phone went unanswered for two days; a handover into an inbox nobody reads is the same
failure with better plumbing, and worse, because the customer gets silence from a bot that
has deliberately stopped talking. The reclaim is what stops that, so it is not an
enhancement to add later — it ships with the pass or the pass does not ship.

### Three open questions — ANSWERED 2026-09-19 (D-091)

1. **The reclaim window is 15 minutes.**
2. **A staff reply resets the clock**, and `applyThreadControl` now refreshes
   `thread_control_at` on a human echo. The refresh is only safe because the reclaim bounds
   it; they are one design.
3. **The customer sees the pass.** Both sentences are drafted and unsigned in
   `prompt/drafts/handover_notice_and_reclaim.mn.txt`.

**CLOSED 2026-09-20 by `0033`** (founder's call: reclaim only our own passes). It was the
last thing blocking the sweeper: the reclaim window (15) is shorter than
`human_takeover_cooldown_minutes` (30), so a sweeper that reclaimed ANY `human` thread would
make the cooldown unreachable. Step 3 scopes the reclaim to threads *we* passed, and
`thread_control_source` could not express that — it said `handover` both when we pass and
when a person takes the thread through Meta's UI.

`passed` is that fourth value. The 15-minute sweeper that reclaimed only `passed` threads
was replaced on 2026-09-30 by the staff-hold reclaim above, which counts `passed` threads
(`meta_holds_thread`) rather than sending to or paging on them. Two things about the old sweeper were carried into the new one:

- **It re-decides every row it reads.** The query narrows on `thread_control_source` and
  `decideReclaim` then asks the same question again. That is D-064's rule applied before the
  fact: a filter is an optimisation, the verdict is the rule, and a filter that silently
  stops excluding anything reads as a safety check for as long as nobody tests it.
- **It refuses to reclaim without a reviewed line, and that is the worse outcome in the
  moment.** The thread stays `human` and the bot stays quiet. Reclaiming silently would mean
  a customer who was told a person was coming, got nobody, and then gets a bot carrying on
  as if nothing happened — the sentence is what makes the reclaim honest, so a reclaim
  without it is a different behaviour rather than a degraded one. `no_reviewed_line` is
  counted so the skip is legible: with no row this otherwise returns a clean-looking sweep.

Neither half of the pass is built, and nothing writes `passed`. The sentences are unsigned;
the new reclaim wording is the founder's to approve.

### The original wording of those three questions

1. **The reclaim window.** Distinct from the cooldown: the cooldown is how long the bot
   stays quiet after a person takes over, the reclaim window is how long we wait before
   concluding nobody is coming. Matrix's corpus («2 өдөр залгаж байна») says the honest
   number is minutes, not hours.
2. **Does an active human conversation extend the silence?** `applyThreadControl`
   deliberately does *not* refresh `thread_control_at` when control has not changed, because
   refreshing on every echo extends the quiet for as long as a person keeps typing — which
   sounds protective and is how a bot stays off for an afternoon. Whether a *replying*
   human should extend it is a product call, not a bug.
3. **Does the customer see the handover at all?** A silent pass is less noisy; an announced
   one sets an expectation the salon then has to meet. Both sentences below are drafted so
   the choice is between texts rather than between text and nothing.
