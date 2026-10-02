# Fallback for Tara's hand-off: pass the chat to the Page inbox, plus the daily count

Status: **DECLINED by the founder (2026-10-02 night): not built.** The pass silences Дали
without pointing staff to the chat. Kept as the record of why. The founder takes a staff
routine to the Tara owner and asks whether her manager wants the same hand-off alert
(Telegram now, SMS later); nothing is built for that until the founder says.

Original proposal (founder, 2026-10-02 evening): Replaces
option A of [`tara-staff-handoff.md`](tara-staff-handoff.md) (the Page inbox label), which is
stopped: Meta refuses the label API until the Page accepts the Page Contact Terms, and Meta's
own acceptance link is broken (see [`meta-support-page-contact-tos.md`](meta-support-page-contact-tos.md)).
`tenants.needs_person_page_label` is NULL on every tenant, DalaTech included (DalaTech's set back to NULL on
the evening of 2026-10-02 and read back).

The daily count (option D) is already merged and runs in the 00:05 report:
«Chats that needed a person (yesterday): <tenant> N, staff replied to M by report time».
It measures whatever is chosen here.

## What the pass would do

When a Tara chat pages the founder as needing a person (complaint, request for a person,
voice message, hand-off line served), the platform also calls Meta's `pass_thread_control`
for that customer, naming the Page inbox (app `263902037430900`) as the new owner. Дали then
stays quiet on that chat. If no member of staff replies within **2 open hours**, the platform
takes the chat back (`take_thread_control`), sends Tara's approved take-back line and answers
again. The founder's Telegram page is unchanged.

## What Tara's staff would see in Meta Business Suite

Exactly, as far as anything here can show it:

```
Inbox ▸ Messenger                                   (the chat, in the main list)
──────────────────────────────────────────────────────────────────────────────
 Customer          хүнтэй ярих
 Tara Salon        Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан
 (Дали)            Танд туслахад бэлэн байна. Та 76001888 эсвэл 91005498 дугаараар
                   холбогдоно уу.
                   … then nothing from Дали until a person replies, or for 2 open hours
──────────────────────────────────────────────────────────────────────────────
```

- **No label, no badge, no colour, no note.** Meta's pass carries a `metadata` text, but it
  goes to the receiving app, and nothing here shows the Business Suite inbox displays it.
- **What Meta's documentation says changes** (quoted from search snippets of
  `developers.facebook.com/docs/messenger-platform/conversation-routing`; the page itself is
  blocked here): "When the Page inbox has control of the conversation, all messages from the
  conversation move to the Inbox folder and wait for a human agent to respond." So a chat a
  member of staff had marked **Done** comes back into the main list. A chat already in the
  main list looks the same as before.
- **Honest consequence:** on most chats the pass is invisible to staff. Its real effect is
  that Дали stops talking, so a staff reply is not interleaved with bot replies. It does not,
  by itself, tell staff which chats are waiting. Today's 0 of 8 is a "which chat" problem.

## What the customer would see

- The hand-off line above, as today (already approved). **No new sentence**: the drafted
  pass notice («Хамт олон маань энэ яриаг аван тантай холбогдоно…», unsigned) would repeat it.
- If nobody replies in 2 open hours: Tara's approved take-back line, as the staff-hold
  take-back sends today: «Уучлаарай, хүлээлгэсэнд. Би үргэлжлүүлэн туслая. Танд юугаар туслах вэ?»
- Risk, said plainly: between the pass and the take-back, Дали answers **nothing** on that
  chat, up to about 3 hours on an open afternoon and until the next opening morning near
  closing time. With 0 of 8 paged chats picked up last week, that is the likely experience
  until staff change habit. The take-back bounds it; it does not remove it.

## What must be true first (founder, from Meta's Page settings, not from this repo)

1. **Conversation routing on Tara's Page `1520409424715591`.** Meta Business Suite ▸ Settings ▸
   Advanced messaging (or Page settings ▸ Advanced messaging ▸ Conversation routing): which
   app is the **default app**, and is DALA_AI listed? A pass only works from the app that holds
   the thread. Measured here: 1,893 Tara deliveries since 2026-09-14, **0 standby, 0 handover
   events**, and staff replies arrive as echoes from the inbox app. That fits "no routing
   configured", in which case Meta may refuse the pass. Unverified until one real call.
2. **One test on DalaTech's Page first**, as with the label: pass one chat, see what the inbox
   shows, reply as staff, confirm Дали stays quiet and the reply is seen; then let 2 open hours
   pass with no reply and confirm the take-back.

## What building it means (for sizing, not for doing)

- The calls exist and are tested (`src/lib/handover/graph.ts`, D-090) and are wired to nothing.
- New: a per-tenant switch (off by default, like the label), the pass at the needs-person
  page, marking the thread `passed`, and extending the hourly take-back to `passed` threads
  with a `take_thread_control` before the line. Today it deliberately skips them
  (`meta_holds_thread`, `reclaim.ts`). `docs/handover.md`: the take-back ships with the pass
  or the pass does not ship.
- No model, no spend. Customer-visible change (Дали goes quiet), so it waits for the founder's
  go and the owner being told first.

## Recommendation

Do (1) first: it is a two-minute look in Page settings and decides whether the pass can work
at all. If it can, test it on DalaTech's Page. Weigh, before Tara: the pass silences Дали but
does not point staff at the chat. If the goal is "staff find the waiting chats", the cheapest
working signal left is outside Meta's inbox (option C, one e-mail per page to the owner, or a
phone call from the founder's relay). The daily count tells you within a week whether either
moved the 0 of 8.
