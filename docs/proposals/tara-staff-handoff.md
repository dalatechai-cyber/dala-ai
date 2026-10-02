# How Tara's staff learn that a chat needs a person — options for the founder

Status: **A + D chosen by the founder (2026-10-02); built, switched OFF, not live.** Written
2026-10-02 from the code and the live database (read-only).

**What was built:** `tenants.needs_person_page_label` (`0079`, NULL on every tenant), the label
call (`src/lib/handover/pageLabel.ts`, Messenger only, one 5-second budget after the reply, never
throws), and the daily report line «Chats that needed a person (yesterday): … staff replied to … by report time»
(`src/lib/handover/needsPersonReport.ts`). **To switch on (founder's go):** apply `0079`, merge,
prove one label on DalaTech's own Page, then set Tara's label text.

## What happens today

- When a Tara customer complains, asks for a person, sends a voice message or is served the
  `handoff` line, the founder's Telegram is paged at once (D-158, `src/lib/handover/needsPerson.ts`).
  The salon is told nothing by the platform: no Telegram bot for Tara (founder's decision),
  `sales_playbooks.lead_route = none`, and `page_label` / `tenant_telegram` have no sender.
- Nothing passes the chat to a person (`pass_thread_control` is built in `handover/graph.ts`
  and wired to nothing, D-162/D-164). The bot keeps answering.

## What the live data shows (read 2026-10-02)

| | Count |
|---|---|
| `conversation.needs_person` pages for Tara, last 7 days | 8 (7 hand-off line, 1 voice), all delivered to Telegram |
| Of those 8 chats, a staff reply in the Page inbox within 24 h of the page | **0** |
| Staff replies in Tara's Page inbox overall, last 14 days (Page Inbox app 263902037430900 echoes) | 22, latest 2026-10-02 06:57 UTC |

Control: the same query finds Tara's staff replies when it is not limited to the paged chats,
so the zero is not a broken query. Staff do work in the inbox; they are just not finding the
chats where the bot promised a person. Not visible from here: whether someone phoned the
customer instead. The founder knows; the database does not.

## Options

### A. Mark the chat in the Page inbox with a label (recommended first step)

The platform adds a Page label (for example «Ажилтан хариулах») to the customer when a page
fires. Staff see it on the chat in Meta Business Suite and can filter the inbox by it.

- Customer sees: nothing changes.
- Staff do: filter by the label a few times a day; remove the label when done.
- Build: small. One Graph call beside the existing page, a per-tenant switch (off by default),
  tests. No model, no spend.
- **Unverified, founder only:** that Page custom labels still work for this app and permission
  set. `developers.facebook.com` is blocked here. Proof would be one label on DalaTech's own
  Page before Tara.
- Label text is staff-facing Mongolian: the founder approves it.

### B. Pass the chat to the Page inbox (Meta hand-over)

The bot calls `pass_thread_control` to the Page Inbox, goes quiet on that chat, and takes it
back after two opening hours of staff silence (the reclaim, D-164, live for Tara).

- Customer sees: the bot stops answering that chat until staff reply or the reclaim fires.
- Build: medium. Graph calls exist but have never run on a real Page; `passed` threads are
  today counted, not reclaimed (`docs/handover.md`), so the reclaim must be extended first.
- Risk: with 0 of 8 chats picked up today, this turns "bot answers, nobody follows up" into
  "bot goes silent, nobody follows up" for up to about 3 hours. `docs/handover.md`: the
  reclaim ships with the pass or the pass does not ship.

### C. E-mail the salon owner

One e-mail per page to an address the salon gives, through the same Brevo sender as billing.

- Customer sees: nothing changes. Build: small. Wording: new Mongolian, the founder's.
- Unknown: whether the owner reads e-mail during the day.

### D. Keep the founder relay, and show the loop in the daily report

No salon-side change. The daily report adds one line per tenant: chats paged yesterday, and
how many got a staff reply. The founder sees the 0 of 8 every morning.

- Build: small, no customer or staff change. Useful with any option above.

## Recommendation

A plus D. A puts the signal where staff already work, with no change for the customer. D
tells you whether A worked. Consider B only once D shows staff answer labelled chats.

## Two more gaps seen while reading (not part of the choice)

1. A request for a person in words that none of the nine DM rows cover is not paged. The rows
   are the tenant's data. Adding stems is a data change for the founder, not code.
2. Дали standard K4 "DM booking request ⇒ founder told": not built.
