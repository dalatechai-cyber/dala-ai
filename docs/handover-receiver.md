# Matrix's receiver configuration — what the evidence says

> Handover — receiver configuration on Matrix's Page is step zero and unknown, and getting
> it wrong takes their live bot offline. Tell me what you find; don't touch it.

Nothing was touched. `developers.facebook.com` and `graph.facebook.com` are both
unreachable through this environment's proxy, so the App Dashboard could not be read —
but the question turns out to be answerable **from our own delivery data**, which nobody
had looked at for this.

## The measurement

Every webhook entry this platform has ever stored, by container (2026-09-18):

| tenant | events | `entry.messaging` | `entry.standby` |
|---|---|---|---|
| matrix-eco-salon | **140** | **140** | **0** |
| dalatech (tenant #0) | 5 | — | — (raw payload purged) |
| unrouted | 2 | — | — (purged) |

140 consecutive real deliveries across four days, 2026-09-14 to 2026-09-18, and **not one
of them arrived in `entry.standby`**. Traffic is still arriving; the newest is stamped
16:23 UTC today.

## What it means, and the one link that is inferred rather than measured

Meta's Handover Protocol designates one app on a Page as the **primary receiver**, which
gets messages in `entry.messaging`. Other subscribed apps get `entry.standby`.

Two readings fit 140/140:

- **H1 — Dala AI's app is the primary receiver.**
- **H2 — no receiver configuration exists**, and every subscribed app gets `entry.messaging`
  by plain fan-out. That is exactly what D-043 measured on tenant #0's Page.

**H1 is refuted by the ancestor.** `Matrix-Chatbot/api/messenger.js:168` reads
`entry.messaging || []`, and the string `standby` does not occur anywhere in its source —
so it can only answer what arrives in `entry.messaging`. It is live on that Page and
answering all day (D-080; D-063's addendum measured its worker invocations at 37, 30 and 9
per day). A Page has exactly one primary receiver, so two apps both receiving
`entry.messaging` is not a primary/secondary pair.

**So: there is almost certainly no Handover receiver configuration on Matrix's Page.** Both
apps are ordinary subscribers and Meta fans out to both.

The inferred link, stated plainly because CLAUDE.md is emphatic about exactly this: the
argument depends on *"an app that is not the primary receiver gets `entry.standby`"*, which
is Meta's documented behaviour and **which I could not check, because the documentation is
blocked from here**. An unfalsifiable claim in this repository is a claim to re-ask the
founder about. The 140/140 measurement is solid; the step from it to "no configuration
exists" carries that one dependency.

## Three instruments agree, and all three have never fired

| | |
|---|---|
| `conversations.thread_control` | **47 rows, every one `unknown`.** Nothing has ever been marked `human` or `bot`, so D-080's check 4 has never refused a conversation |
| `quality_flags` handover codes | **zero rows.** `handover_unrecognised` — the counter built precisely because the event shape is unverified — has never fired, so no handover event of any shape has ever arrived |
| `tenant_channels.meta_app_id` | **NULL on both channels**, so every handover verdict is `unknown` by construction |

Three independent signals, all consistent with a Page where the protocol is simply not in
use.

## Why getting it wrong takes their bot offline — the specific mechanism

This is the part worth carrying, because the danger is not where it looks.

The risk is **not** in the subscription (`subscribed_apps`, D-043's replacement-presented-
as-an-addition trap). It is in the **receiver assignment itself**:

> Assigning Dala AI as primary receiver on Matrix's Page demotes the ancestor to secondary.
> The ancestor reads only `entry.messaging`. It would receive **nothing**, answer nothing,
> and go silent the instant the assignment took effect.

Total, immediate, and with no error anywhere — the ancestor would log a healthy zero. It is
the same shape as D-062's eleven-day outage: a channel that is dead and looks quiet.

And the converse is what blocks the feature: **`pass_thread_control` can only be called by
the primary receiver.** So the outbound half of the Handover Protocol cannot work at all
until an assignment is made, and making that assignment is the thing that kills the
incumbent. There is no ordering of those two steps that is safe while the ancestor is
still serving Matrix's customers.

**That makes Handover a post-cutover feature, not a pre-cutover one.** It is not blocked on
code — `0027`, `thread_control`, `parseHandoverEvents` and check 4 all exist — it is blocked
on the ancestor still being the bot that answers. Sequenced the other way round it is safe:
retire the ancestor first, then assign, then `pass_thread_control` has a primary receiver to
be called by and nothing to knock offline.

## What is still unknown

- **Whether the Page Inbox app is in the picture.** CLAUDE.md notes that a Page whose
  primary receiver is the Page Inbox app is a different mechanism that still yields standby.
  Nothing here distinguishes "no configuration" from "a configuration that happens to route
  messaging to everyone", and only the App Dashboard or `GET /{page-id}/subscribed_apps`
  can.
- **Whether a human replying from the Page Inbox produces an event we would see.** D-080's
  echo detector exists but `delivery_mode` is `shadow`, so echoes are counted and move
  nothing. With `thread_control` at `unknown` for all 47 conversations, the mirror has never
  had to decide.

Neither is worth a Graph call from here, and neither can be answered by one that this
environment can make.

## Recommendation

Do nothing to Matrix's Page. The measurement above is the answer to step zero, the feature
is correctly inert, and the safe sequence is cutover first.
