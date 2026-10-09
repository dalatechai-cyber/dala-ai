# Runbook: tell each Tara branch's own staff when Дали hands a chat to a person

What and why: D-183 in `docs/DECISIONS.md`. Off for every branch until step 5. Each branch is
switched on separately; one branch's alerts can never reach the other branch's chat.

What staff get, within seconds of the hand-off, in their own Telegram group:

```
🔔 Tara Salon — Яармаг
📷 2026-10-09 14:32
https://business.facebook.com/latest/inbox/all?asset_id=1520409424715591&selected_item_id=…&thread_type=FB_MESSAGE
```

(📷 photo/video/link, ⚠️ complaint, 🙋 asked for a person, 🎤 voice message, ⏰ Дали took the
chat back after staff went quiet.) At most one delivered ping per chat per 30 minutes; a ping
Telegram refused is retried on the chat's next hand-off. Your own Telegram alerts keep coming as
today, and if a branch's ping cannot be delivered you get one alert a day for that branch
(«staff hand-off ping was NOT delivered»).

## Why Telegram, and not the alternatives

| Route | Why not (today) |
|---|---|
| Page inbox label «needs a person» | Meta refuses it until the Page accepts the Contact Terms, and Meta's link to accept them is broken (`docs/proposals/meta-support-page-contact-tos.md`). |
| Messenger message from the Page to a staff member | The Page may only write to someone who wrote to it in the last 24 hours; a quiet day breaks it. |
| Passing the thread to the Page Inbox (`pass_thread_control`) | Declined 2026-10-02: it silences Дали without pointing staff at the chat. |
| E-mail | Works, but a phone does not ring for it; staff check it hours later. Possible second route later (`handoff_targets` has an `email` kind). |
| SMS | No provider. |

Telegram: the bot already exists and already sends your alerts; delivery takes seconds; a group
rings every staff phone in it; the alert carries a link straight to the chat.

## Steps (per branch; do Яармаг first)

1. **Merge and deploy** the pull request «Staff hand-off ping per branch» (dala-ai). Nothing
   changes on deploy: no branch has a target yet.
2. **Check the link form once.** Take one «Open the chat» link from the list of Яармаг's
   unanswered photo chats the overnight session left for you (outside the repository: it holds
   customers' ids) and open it while logged in as a Page admin. *You should see:* that customer's chat in Business Suite's inbox.
   If it opens the inbox but not the chat, tell Claude: the link form changes, nothing else.
3. **Decide the bot first (your call).** The platform bot (`TELEGRAM_BOT_TOKEN`, the one that sends
   your alerts) is shared with dalatech-app, which has a webhook on it
   (`docs/reports/2026-09-26-telegram-cleanup.md`). In a group, a bot with Telegram's default
   privacy mode only receives commands, mentions and replies to its own messages; a staff member
   who REPLIES to a ping would therefore reach dalatech-app's `/api/telegram`. Check that
   dalatech-app ignores chats it does not know before adding the bot to a staff group; if it does
   not, a separate bot for staff is a new token (a credential: yours to create and add to Vercel)
   and a small code change.
4. **The branch's group.** On the branch owner's phone: Telegram → new group «Tara Яармаг —
   чат» with the staff who answer the Page inbox. Add the bot. Tell staff not to reply to the bot;
   they answer the customer through the link.
5. **The chat id.** Open the group in Telegram Web (web.telegram.org/a/): the address ends with
   `#-…`; that negative number (e.g. `-1001234567890`; a supergroup's starts with `-100`) is the
   chat id. **Do not call `getUpdates`, `deleteWebhook` or `setWebhook`** for this bot: while
   dalatech-app's webhook is set, `getUpdates` answers 409, and removing the webhook breaks
   dalatech-app. Never use your own alerts chat or the chat dalatech-online posts demo requests
   into: the template cannot tell those apart from a staff group.
6. **Switch the branch on.** Copy `scripts/provision/tara-staff-alerts-TEMPLATE.sql`, replace
   `REPLACE_WITH_BRANCH_SLUG` with `matrix-eco-salon` (Яармаг) or `tara-park-od` (Парк Од) and
   `REPLACE_WITH_CHAT_ID` with the number, run it in the SQL editor → «Success». At once, no
   publish. *Refuses:* the placeholders, a malformed id, a branch that already has one, a chat
   id already used by the other branch. `verified_at` is the time you ran it, i.e. «the founder
   confirmed this chat is this branch's staff group»; step 7 proves the bot can post there.
7. **Test.** From your own phone, send a hair photo to that branch's Page, then «hedve» after
   reading the question. *You should see:* the hand-off notice in Messenger, your own Telegram
   alert, and in the branch group a ping like the one above whose link opens your chat. Vercel →
   dala-ai → Logs: `[worker] staff_notify` with `"outcome":"sent"`.

*Off again:* `scripts/provision/tara-staff-alerts-TEMPLATE-revert.sql` with the slug (at once).

## What the logs say

`[worker] staff_notify {"outcome":"off"}`: the branch has no target (the default).
`"recent"`: the same chat got a delivered ping inside 30 minutes. `[worker] staff_notify_undelivered`:
Telegram refused (bot removed from the group, wrong id, a group upgraded to a supergroup, which
changes its id) or the target table was unreadable; your own hand-off alert still went, and you
also get one «ping NOT delivered» alert per branch per day. Every ping is a `handoffs` row with a `staff_notifications` row
saying whether Telegram accepted it.
