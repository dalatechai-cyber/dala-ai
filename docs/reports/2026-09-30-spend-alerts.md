# Spend alerts, the reply after a cap, and Tara Яармаг's emoji cap (2026-09-30)

Written for the founder. Two decisions below are yours; nothing in this file is live.
The code that shipped with it (D-159) only reports and pages. It stops no reply and moves no cap.

## What was true before, measured

- **No monthly view.** `monthly_ceiling_nanousd` had no reader (D-051, D-072). The first sign of a
  costly client was the daily cap refusing replies.
- **A cap refusal was silent to you.** The Messenger worker marked the event `shed` and answered
  QStash 200. The exhausted alert only fires after QStash's retries run out, and a 200 has none, so
  no alert was raised.
- **What a customer received after a refusal.** Messenger: nothing. The event is marked `shed`,
  no typing bubble is shown, and no message is sent (`src/lib/worker/reception.ts`). Website: the
  tenant's reviewed handoff line, or the callback line where there is no inbox, and a handoff alert
  (`src/lib/website/messageJob.ts`, D-139).
- **The live caps** (read from `tenant_budgets` on 2026-09-30):
  - Tara Яармаг: Reception is refused past **$1.90 a day**. Her row gives $2.00 × 0.95, which is
    lower than the compiled $2.00.
  - DalaTech: **$2.00 a day**, the compiled constant.
  - All tenants together: **$10.00 a day**.

  `docs/STATUS.md` said Tara's cap was $1.50; that was stale and is corrected.
- **This month's spend so far** (`spend_ledger`, September, Ulaanbaatar calendar):
  - Tara Яармаг: **₮12,922** ($3.69), 65% of the 20,000 ₮ normal limit.
  - DalaTech: **₮3,348** ($0.96).

  Tara will probably pass 70% before the month ends, so the first report on 1 October may show
  the alert.

## What now happens (D-159)

1. **Every daily report (00:05 Ulaanbaatar)** has a block with each client's model spend for the
   month:
   - the figure in ₮ (the ledger's own snapshotted figure), its share of 20,000 ₮, the figure in
     dollars, and the pace to month end;
   - 🟠 at 70% (the rulebook's alert) and 🔴 at 100%, which says that replies continue;
   - a count of the Messenger messages a cap refused on the day before, and the cap pages sent
     that day, with any that Telegram did not deliver;
   - UNREADABLE when a figure could not be summed. It is never shown as zero.
2. **The moment a cap refuses a reply**, you get one immediate 🔴 page. It names:
   - the tenant;
   - which cap refused (the tenant's, the platform's, or a budget that gives the surface nothing),
     when the counters show it;
   - both counters;
   - what the customer gets.

   Later refusals are silent while the episode is open. The hourly health run closes the episode
   once the day has rolled over, so a cap that trips again the next day pages again.
3. **No reply waits for any of this.** On Messenger the page is sent after the event is
   recorded, for a message the cap already refused. QStash's acknowledgement waits at most
   5 seconds for it, and the page cannot change that acknowledgement. On the website it
   runs after the visitor's response. The month block comes after the open conditions in the
   report, so it can never push a critical out of the message.

## Decision 1 — what a Messenger customer receives after a cap refusal

Today: **nothing**. Tara Яармаг's channel is `live`, so a real customer would go unanswered until
midnight. Two options, both drafted, neither built:

**A (recommended): serve the tenant's own reviewed `handoff` row**, the same sentence the
website already serves in this case. It needs no new Mongolian and costs no model spend. Tara's
row starts «Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад
бэлэн байна…».

The weakness: «I can't answer this question» is not quite why. Its strength: every word was
already approved, and the page (above) tells you at the same moment, so a person can follow up.

**B: a new line for this case only.** Drafted from vocabulary in Tara's approved rows
(«Уучлаарай», «боломжгүй», «манай ажилтан … удахгүй хариулна» from `handover_notice`):

> Уучлаарай, одоогоор шууд хариулах боломжгүй байна. Манай ажилтан Танд удахгүй хариулна.

It promises that staff will answer. That is true only if someone reads the Page inbox that day.
The wording is yours to judge; the native-language call is not mine to make.

Either option is a change to what a live customer sees, so it ships only with your yes. With a yes,
the build is small:
- In the refusal branch, send the chosen reviewed row through the same delivery path as the
  photo line.
- Only on a `live` channel, and never from a model.
- With the reply-case gate unchanged.

## Decision 2 — Tara Яармаг's emoji cap

Tara's `reply_style` is null, so the model's own emoji are uncapped (`docs/standards/dali.md` D7).
The evidence, measured on 2026-09-30:
- **Her approved rows:** 17 reviewed rows. 15 have no emoji. Two carry one 😊 each: the public
  comment reply and the photo hand-over notice. No refusal carries any.
- **Her replies over 30 days** (`outbound_messages`): 280 in all.
  - 262 have no emoji.
  - 15 have one.
  - 3 have two, which is more than any approved row.

**Proposal: `max_emoji = 1`.** It is the most any approved line of hers uses, it matches DalaTech's
approved look (D-133), and the code already removes every emoji on a complaint or a refusal.

The change affects only the three two-emoji replies a month; the second emoji is cut. Approved rows
are served whole and are never touched (`src/lib/reception/style.ts`). Only `max_emoji` is set;
her price layout stays exactly as it is. `0` is the alternative if you want none at all, as most
of her replies already have.

On your yes, it is one row (not applied; `reply_style` is read per reply, so it is live at once):

```sql
update tenants set reply_style = '{"max_emoji": 1}'::jsonb
 where slug = 'matrix-eco-salon' and reply_style is null;
```

## What needs a real month of data

- **Whether 20,000 ₮ and 70% are the right numbers.** Tara's first full month lands near 65–70%.
  One month is not a trend, and the rulebook says to revisit after the first month of real usage.
- **Whether the ₮ figure matches the Anthropic invoice.** Spend that reached the provider but not
  the ledger sits in `ledger_deadletter` and is not in the report. Reconcile the September
  invoice against the report's September figure once.
- **A real cap trip.** The page, its wording and its close are proven by unit tests only. No cap
  has tripped on the project since the $2.00 change.
- **The pace figure.** It assumes a flat month. Salons are not flat (D-016: 28 to 94 replies a
  day), so read it as a warning, not a forecast.
