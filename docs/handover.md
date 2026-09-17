# Thread control: the inbound half, and the reclaim path it is built for

**The inbound half is BUILT (2026-09-17).** The outbound half — `pass_thread_control`,
`take_thread_control` — is **not**, deliberately. Passing control is a live mutation of a
real salon's thread ownership: it cannot be rehearsed during a shadow mirror, and the
receiver configuration on Matrix's Page is not yet known.

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
        │
   (every conversation starts here: nobody has read the far side)
```

**`bot`** is reachable only from Meta naming us as the new owner. Nothing infers it, and
nothing needs to: the gate refuses on `human` alone.

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

## The reclaim path, for when the outbound half is built

1. The bot decides a person should take over → `pass_thread_control(target = Page Inbox)` →
   `thread_control = 'human'`, `source = 'handover'`, `thread_control_at = now` → **send the
   handover notice**.
2. Check 4 keeps the bot quiet for `tenants.human_takeover_cooldown_minutes`.
3. **Nobody picks it up.** No echo arrives on that thread within the reclaim window.
   `take_thread_control()` → `thread_control = 'bot'`, `source = 'reclaim'` → **send the
   reclaim line**.
4. A person *does* reply — an echo that is not ours — and the thread stays `human`.

**Step 3 is the whole reason to build any of this.** The founder's stated motive is that a
phone went unanswered for two days; a handover into an inbox nobody reads is the same
failure with better plumbing, and worse, because the customer gets silence from a bot that
has deliberately stopped talking. The reclaim is what stops that, so it is not an
enhancement to add later — it ships with the pass or the pass does not ship.

### Three open questions, all the founder's

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
