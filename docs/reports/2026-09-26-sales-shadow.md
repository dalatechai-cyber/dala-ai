# Sales next step: the retrospective shadow (2026-09-26)

What would have happened last week if both bots had been salespeople (D-127). Nothing was
sent and nothing was written: this is the new decision code run over every real DM on both
Facebook Pages from **2026-09-18 19:00 to 2026-09-25 19:02 UTC** (146 customer messages, 39
conversations), read-only from the live project. Reproduce it with
`node scripts/sales/retro.ts`; `scripts/sales/retro.test.ts` pins every number below.

The words are not written yet. Every row the bot would add is recorded as `unwritten`, and
the drafts are in `prompt/drafts/sales_next_step_tara.mn.txt` and
`sales_next_step_dalatech.mn.txt`.

## In numbers

1. **Tara: 17 of 37 conversations would have ended with a next step.** 16 offers (14 booking,
   2 call-back) plus one conversation whose reply already carried the booking link. In 10 of
   the 17 the step comes with the **first** reply, in 6 with the second, and in one (a
   40-message run) with the sixth.
2. **The 20 Tara conversations without one:**
   - **12 got no reply at all.** Every one is 22–24 Sept (35 messages flagged `reply_too_late`
     when the queue came back). No next step can fix a conversation nobody answered.
   - **5 got only refusals or the handoff line.** For example, bc2f1048: all six replies were
     «…үнийн мэдээлэл надад байхгүй…». The rule says no sales line under a refusal, so these
     customers get none. The refusal line already gives both phone numbers. **Your call:**
     should a refusal carry the call-back ask instead of the numbers?
   - **3 were a greeting answered with a question** («Сайн байна уу! … Танд юугаар туслах
     вэ?»). In two the customer never wrote again. In the third (8d5788e9) the next reply was
     the handoff line.
3. **DalaTech: 1 of 2 conversations.** «вэбсайт хэд вэ» → the demo. But that reply failed to
   send. The customer asked again 8 minutes later and that reply was sent, yet
   once-per-conversation had already spent the step on the failed one. The live hook counts
   the same way: it records when a reply is drafted, before the send. It should move to after
   a confirmed send before anything goes live.
4. **Leads: none for Tara. One for DalaTech, and it is not a customer.** In 1baff6cb someone
   wrote to the DalaTech Page asking to put «utasaa 7600****» (the salon's own number) in the
   chat. The detector is right that it is a phone number. It cannot know it is the salon
   talking to its supplier. So the first week of real traffic has **no customer who gave a
   phone number**. The lead half is tested on written cases only (`phone.test.ts`).
5. **Related service: 1.** «афро хими гэдэг нь ямар хими бэ» → «Хими арчилт». Customers
   rarely name a listed service exactly, and never in Latin letters («shuluun himi» does not
   match «Шулуун хими» offline). Live, the tenant's Latin spellings (D-120) are applied, so
   the live rate should be higher than this.
6. **Pushy check.** No offer lands after a complaint, a refusal, a photo, or a person in the
   thread. None lands on a reply that asks the customer something, or on a bare greeting or
   stray key («л»). The one conversation where a staff member took over (63a52c70) gets its
   offer on the bot's first reply, 29 s before the staff member's first message.

## How each reply was classified (so you can check it)

- **Reply facts come from the stored replies, in SQL.** These are the reviewed lines each
  reply contains, whether it ends with a question, whether it is a greeting row, and whether
  it carries the booking or demo link. Eleven replies from 09-19 carry the pre-rebrand number
  «7741-7777». They are matched as the refusal and handoff lines they were. Without that they
  would have read as answers and been offered a next step.
- **Complaints are the tenants' own `comment_rules` escalate rows**, so the classifier stays
  rows (D-122).
- **"A person held the thread"** means a `human_has_thread` or `human_replied_before_send`
  flag, or `thread_control = human`, before the message.
- **The corpus is transcribed from the live table.** The md5 of its 146 texts reproduces the
  live value (`51ae6b3a…`) before any number was computed.

## Where Tara's lead should go: a Telegram message to the salon

| | Telegram to a salon chat | Page inbox label (`custom_labels`) |
|---|---|---|
| Time to a call-back | A push notification on staff phones within seconds | None. Staff see it only when they open the inbox and filter by label |
| What staff use | Unknown. **Please ask the salon** | The Page inbox: their replies arrive stamped with the inbox app (D-126). But they already see the customer's message there, so a label adds a filter, not an alert |
| What it needs | A salon group with the platform bot added, and its chat id as a tenant row. The bot and the sending code exist (`alerts/alert.ts`; `.env.example` already says "one bot: founder alerts AND per-tenant handoff") | A new Graph write on a live Page. The permission it needs cannot be checked from here (developers.facebook.com is blocked) |
| If it fails | It is visible: the row stays `delivered = false` and the digest shows it | Nobody sees it unless we log it. A label on the wrong person is silent |

**Recommendation: Telegram to a chat the salon's staff read**, because a call-back lead goes
cold in minutes and only Telegram notifies anyone. Two conditions:

- The salon's staff must actually use Telegram on their phones. If they do not, use the label.
- Never the founder's alert chat: that chat also carries customers' demo requests (D-063).

DalaTech's leads go to your alert chat, at most one alert per conversation. That keeps the
noise to a few messages a week, and each one has a person on the other end.

## What this does not show

- **How the words land.** No body exists yet, so nobody has seen a customer react to one.
- **The live hook's own numbers.** It records on every reply once `0051` is pushed and
  `scripts/provision/sales-playbook.ts` has switched a tenant to `shadow`. Until then it logs
  `sales_shadow_unusable` and does nothing else.
- **The DalaTech website chat.** Only the Messenger worker is hooked.

## Per conversation

Each line is one customer message (UTC), quoted exactly, with phone numbers masked and text
cut at 70 characters. It shows what the shadow would have recorded for the reply to it:
**booking**, **callback** or **demo** is the step offered, and whether it was chosen by the
customer's words or is the tenant's default. «already in the reply» means the reply carried
the link itself. **related** is the suggested service. **lead** is a masked phone number.
Messages with nothing to record are left out. A conversation with none says why.

**04da5da6** (Tara, 2 msg, 09-19 02:08:15–02:08:23 UTC)
- 02:08:23 «Onoodriin tsag bgaa yu» → **booking** (default)

**13b11b2a** (Tara, 6 msg, 09-19 01:21:52–01:24:20 UTC)
- 01:21:52 «тайралт будалт хими» → **booking** (default)
- 01:24:20 «афро хими гэдэг нь ямар хими бэ» → — already_offered + **related** «Хими арчилт» (named «Афро хими»)

**18904151** (Tara, 1 msg, 09-22 04:52:37–04:52:37 UTC)
- no next step: no_reply

**1baff6cb** (DalaTech, 2 msg, 09-19 12:15:34–12:16:18 UTC)
- 12:16:18 «Odoo holbogdoj baigaa chatandaa utasaa 7600**** taviad uguurei holbog…» → — lead_given · **lead** 7600****

**243ed63c** (Tara, 1 msg, 09-20 01:26:31–01:26:31 UTC)
- no next step: reply_asks

**275d11ad** (Tara, 3 msg, 09-19 15:49:21–15:49:59 UTC)
- 15:49:37 «үнийн мэдээлэл» → **booking** (default)

**2c9b7be6** (Tara, 2 msg, 09-24 00:04:42–00:04:50 UTC)
- no next step: no_reply

**34bf5f0a** (Tara, 4 msg, 09-20 12:30:26–12:31:51 UTC)
- 12:31:24 «Office color ungu har usni ungute usend orohu» → **booking** (default)

**439eb189** (Tara, 1 msg, 09-19 12:12:27–12:12:27 UTC)
- no next step: reply_asks

**4d6313c2** (Tara, 4 msg, 09-24 05:15:55–05:18:08 UTC)
- no next step: no_reply

**5069c02c** (Tara, 1 msg, 09-23 06:44:39–06:44:39 UTC)
- no next step: no_reply

**507bf8a2** (Tara, 1 msg, 09-21 12:38:33–12:38:33 UTC)
- 12:38:33 «hi hayar» → **booking** (default)

**58d1fb2a** (Tara, 3 msg, 09-22 07:47:11–07:52:47 UTC)
- no next step: no_reply

**5fae54e5** (Tara, 1 msg, 09-22 23:42:26–23:42:26 UTC)
- no next step: no_reply

**63a52c70** (Tara, 5 msg, 09-25 14:16:46–14:22:45 UTC)
- 14:16:46 «Hi gun bor barag har usiig tsairuulaltguigeer iimerhu bolgj boldog uu» → **booking** (default)

**683d04ec** (Tara, 2 msg, 09-20 12:19:04–12:21:44 UTC)
- 12:19:04 «сайн байна уу / үнийн мэдээлэл авья» → **booking** (default)

**684638bf** (Tara, 2 msg, 09-19 13:19:31–13:21:56 UTC)
- 13:21:56 «Yag ingej budaad dolgiontoi himi hij boldoguu» → **booking** (default)

**6f16316f** (Tara, 1 msg, 09-20 16:47:14–16:47:14 UTC)
- no next step: refusal_or_handoff

**7a702ad9** (Tara, 1 msg, 09-20 02:14:28–02:14:28 UTC)
- 02:14:28 «Sn bnu Badmaa stylestiin dugaar hed we» → **callback** (intent words)

**7b8efaa8** (DalaTech, 4 msg, 09-25 18:53:42–19:02:24 UTC)
- 18:53:42 «вэбсайт хэд вэ» → **demo** (default)

**7e979e1d** (Tara, 1 msg, 09-25 04:55:22–04:55:22 UTC)
- 04:55:22 «Яармаг салбарын утсыг өгөөч» → **callback** (intent words)

**835f7540** (Tara, 2 msg, 09-19 04:42:44–04:44:21 UTC)
- no next step: refusal_or_handoff

**8d5788e9** (Tara, 2 msg, 09-21 03:27:32–03:28:20 UTC)
- no next step: reply_asks, refusal_or_handoff

**95a96291** (Tara, 1 msg, 09-20 05:49:40–05:49:40 UTC)
- 05:49:40 «Hi unuudur tsag bnu» → already in the reply (link)

**a70ce9fe** (Tara, 2 msg, 09-25 11:05:44–11:06:16 UTC)
- 11:05:44 «Hi margaash tanaih ajilahu» → **booking** (default)

**a83b3f4a** (Tara, 3 msg, 09-22 10:28:47–10:32:25 UTC)
- no next step: no_reply

**ae046d6e** (Tara, 1 msg, 09-19 13:18:51–13:18:51 UTC)
- no next step: refusal_or_handoff

**ae5e2376** (Tara, 1 msg, 09-23 22:04:08–22:04:08 UTC)
- no next step: no_reply

**b139dfe5** (Tara, 3 msg, 09-19 09:53:35–10:09:36 UTC)
- 09:53:37 «tanaih haana bdag we» → **booking** (default)

**b2da1770** (Tara, 1 msg, 09-23 15:26:07–15:26:07 UTC)
- no next step: no_reply

**b5cd9893** (Tara, 40 msg, 09-21 02:02:24–16:22:36 UTC)
- 02:54:50 «uscinii» → **booking** (default)
- 03:11:26 «Маникюр хэд вэ?» → already in the reply (link)
- 03:13:24 «Будаг хэд вэ?» → already in the reply (link)
- 03:14:41 «Мастер үсчинд орвол дээр юу?» → already in the reply (link)
- 03:16:08 «Шампунь зардаг уу?» → already in the reply (link)
- 03:49:53 «sain bnu» → already in the reply (link)
- 03:51:36 «us budalt» → already in the reply (link)
- 16:09:12 «Цаг захиалмаар байна, утас хэд вэ?» → already in the reply (link)
- 16:11:33 «Шампунь зардаг уу?» → already in the reply (link)

**bc2f1048** (Tara, 6 msg, 09-19 00:40:00–00:46:20 UTC)
- no next step: refusal_or_handoff

**bd091b47** (Tara, 3 msg, 09-19 12:34:31–12:36:03 UTC)
- 12:34:31 «оройн мэнд. тайралт будалт ямар үнэтэй вэ» → **booking** (default)

**bdd7d67e** (Tara, 13 msg, 09-24 21:25:07–22:19:54 UTC)
- 21:25:18 «tara salon mun uu?» → **booking** (default)

**c2b7cf83** (Tara, 7 msg, 09-19 13:44:59–13:48:24 UTC)
- 13:44:59 «Medeelel awii» → **booking** (default)

**c5d43142** (Tara, 3 msg, 09-24 02:28:41–02:28:58 UTC)
- no next step: no_reply

**d690ca41** (Tara, 3 msg, 09-23 04:13:31–04:18:50 UTC)
- no next step: no_reply

**e1b9434b** (Tara, 1 msg, 09-19 02:20:15–02:20:15 UTC)
- no next step: refusal_or_handoff

**ebb3272f** (Tara, 6 msg, 09-23 07:06:06–07:10:20 UTC)
- no next step: no_reply

