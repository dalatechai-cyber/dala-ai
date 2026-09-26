# Telegram cleanup — what changed, the new 09:00 report, and where the new tokens go

2026-09-26. Follows `2026-09-25-telegram-inventory.md`, whose proposal the founder approved
(immediate / one 09:00 daily report / stop).

## 1. Done

| | Where | What |
|---|---|---|
| Test leads send nothing | dalatech-app #8 | A lead whose name starts `TEST`/`ТЕСТ`, whose email contains `+test@`, or whose phone is all zeros: no Telegram, no lead email, no demo email, no failure notice. It is still saved, so the pipeline can be tested. |
| #001, #002, #003 stopped | dalatech-app #8 | Follow-ups now fire only on day 3, 7 and 14 after the demo was sent, never again after that, and never for a test lead. #001–#003 are 31–78 days old, so none of them will fire again. Day 7 and 14 will rarely fire: demos are deleted 7 days after they are made. |
| Test demo requests send nothing | dalatech-online #46 | Same rule on the website's «Хүсэлт илгээх» form; the answer says `skipped_test`. |
| The 30-day credential warning | dala-ai (this PR) | It used to be written and shown nowhere. Now it is an open item that the daily report lists every morning until the credential is re-sealed. |
| Criticals that could fire once ever | dala-ai (this PR) | Retired model, KEK unavailable, credential will not decrypt, token revoked, permission refused, credential expiring. Each is now an episode: it pages once, closes when the thing works again (a successful reply or send, or a re-seal), and pages again if it recurs. Closing is silent. |
| One 09:00 report | dala-ai (this PR) + dalatech-app #8 | Built and switched **off**. Nothing changes until the switch in §3. |

Nothing will page at deploy. The only old rows under these keys are two `token_revoked` and two
`undecryptable` events (DalaTech's and Matrix's Page, the latest 2026-09-25 18:53 UTC), and an
episode opens only on a new failure. Both page tokens' data access runs to 2026-12-20 and
2026-12-24, so the 30-day warning first appears around 2026-11-20.

## 2. Sample of the new 09:00 report

Rendered by the production code (`node scripts/alerts/sample-daily-report.ts`). The data is
invented, and the DalaTech section is exactly what dalatech-app's own sample prints. This is
the only Telegram message of the morning. It is split into (1/2), (2/2) only past ~3,900
characters. Anything a person must act on at once (a real lead, a failed demo, a halted
channel, a critical) still arrives immediately, as before.

```
DalaTech — лидүүд
📊 Нийт: 7 · Шинэ хүсэлт (өнөөдөр): 1 · Демо бэлдэж байна: 1 · Демо илгээгдсэн: 3 · Загвар сонгосон: 1
⚡ ЯАРАЛТАЙ:
- #029 Хан Моторс — демо зогссон (generate:2) → RELEASE #029
- #030 Алтай Тур ХХК — хүлээлгэсэн → RELEASE #030
📞 Дагаж мэдэгдэх (өнөөдөр):
- #021 Эрдэнэ Барилга — Эрдэнэбат, 8808-3030 · 7 өдөр · https://erdene-barilga-q4w9n-minimal.vercel.app
- #026 Мөнх Шүдний Эмнэлэг — Мөнхзул, 9909-1515 · 3 өдөр · https://munkh-dental-x8d2m-minimal.vercel.app

──────────

Dala AI — 2026-09-25
2 open conditions. silence watchdog last ran 35m ago (2 channels).
1 inbound dropped unanswered (yesterday): sticker ×1.
No public comments capped (yesterday).
No shadow drafts lost (yesterday).

🔴 channel.no_messages · 9h
Page 100000000000001: webhooks are arriving but nothing became a message for at least 5h of open time with nothing, since 2026-09-25T16:00:00.000Z — a secondary-receiver (standby) Page, or the persis…

🟠 secret.expiring · 30h
Credential page_token for tenant 00000000-0000-4000-8000-000000000001: data access lapses in 24 day(s). Re-authorize and re-seal before then — nothing here renews it automatically. `debug_token` give…

──────────

Yesterday (2026-09-25) — 3 recorded for this report, not paged:
🟠 model.cache_cold_run ×2 — The last 10 reception calls all read ZERO cached tokens. Prompt caching appears to have stopped. This is not an error and nothing will fail — it is a bill, rou…
ℹ️ channel.recovered ×1 — Page 100000000000001: recovered — channel.no_webhooks is clear.

──────────

Flaws

Жишээ салон — 2026-09-25: 2 of 14 replies look wrong.

3f9a1c2e · corrected
C: Маргааш 11 цагт үс засуулж болох уу?
B: Маргааш бид амарна. Нөгөөдөр 10:00-аас ажиллана.

b71d04aa · handoff, repeated
C: Кератин эмчилгээ хэд вэ?
B: Уучлаарай, энэ талаар манай ажилтан тантай удахгүй холбогдоно.

Mark one wrong: select mark_reply_wrong('<ref>', '<the right reply>');
```

If the DalaTech section cannot be fetched, its place reads `DalaTech app section UNREADABLE —
<reason>`. It is never silently missing.

## 3. Switching over (founder, after approving the sample)

1. Generate one long random value for `DAILY_REPORT_SECRET`. Set the same value in Vercel
   **dalatech-app** and **dala-ai** (Production).
2. In **dala-ai**, set `DAILY_REPORT_V2` = `true`. The build refuses any other spelling, and
   refuses `true` without the secret.
3. In **dalatech-app**, set `DAILY_REPORT_MERGED` = `true`. Its own 09:00 report and follow-up
   message then stop, since their content is in the merged report.
4. In the QStash console keep **one** schedule for `/api/workers/digest`: `5 16 * * *`
   (00:05 Ulaanbaatar; changed from 09:00 by the founder on 2026-09-26). Delete any
   `0 1 * * *` (09:00) schedule, or the report arrives twice.
5. Redeploy both projects.

To undo: delete `DAILY_REPORT_V2` in dala-ai and `DAILY_REPORT_MERGED` in dalatech-app.

Also set `CRON_SECRET` in dalatech-app. While it is unset, its three cron endpoints are open to
anyone who knows the URL. They were left open rather than closed so the 09:00 report cannot
die silently.

## 4. Keeping DalaTech and Core Language apart

**Where the 23 August message came from.** The website's demo form (`dalatech-online`,
`api/demo-request.js`) sent «Шинэ демо хүсэлт» into the Core Language chat. That form reads
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, so on that day those two variables in the
`dalatech-online` Vercel project held the Core Language bot. Vercel does not let this session
read the current values, so whether they still do is unknown. The rotation below settles it
either way.

**Every sender, and which business it belongs to:**

| Sender | Where | Variables | Sends |
|---|---|---|---|
| dala-ai | Vercel `dala-ai` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | DalaTech |
| dalatech-app (leads, demos, commands) | Vercel `dalatech-app` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | DalaTech |
| Website demo form | Vercel `dalatech-online` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | DalaTech — **the one that leaked on 08-23** |
| dalatech-automation | GitHub secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | DalaTech (manual runs only) |
| PC copies (`routines/*.js`, #finish builder) | `.env` on the Windows PC | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | DalaTech |
| core-language-automation | GitHub secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Core Language only (weekly report, failed posts) |

No code sends one business's messages on purpose through the other's bot. The mix-up is purely
configuration: all five DalaTech senders and Core Language use the **same variable names**, so
pasting one project's values into another raises no error. Also note that if both bots talk to
you in a private chat, the chat id is your own Telegram user id and is the **same number** for
both bots. The **token** decides which chat a message appears in, so the token is what must
never be shared.

No Telegram sender exists in dalatech-chatbot, Matrix-Chatbot, dalatech-english or
dalatech-chinese. The Vercel projects `japantok-chatbot`, `gs-autocenter-chatbot` and
`messenger` were not read. If any of them holds either old token, it goes quiet after the
rotation; nothing else breaks.

## 5. Where the new tokens go

**Rotate the Core Language token too.** The 08-23 message proves it was placed in at least one
DalaTech project, and it may be in the PC's `.env` as well. Rotating only the DalaTech token
would leave any copy of it working. In @BotFather, `/revoke` on each bot issues the new token and
kills the old one immediately.

**New DalaTech token.** Set it with the DalaTech chat id, explicitly, in every place below,
including places you believe are already right:

| Place | Token variable | Chat variable |
|---|---|---|
| Vercel `dalatech-app` (Production) | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_CHAT_ID` |
| Vercel `dalatech-online` (Production) | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_CHAT_ID` |
| Vercel `dala-ai` (Production) | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_ALERT_CHAT_ID` |
| GitHub `dalatech-automation` → Settings → Secrets → Actions | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_CHAT_ID` |

Then:

- Redeploy the three Vercel projects. A changed variable reaches only new deployments.
- Re-register dalatech-app's webhook, or RELEASE, APPROVE, DOMAIN and #finish stop answering.
  Open this once in a browser, with the new token in place of `<NEW>`:
  `https://api.telegram.org/bot<NEW>/setWebhook?url=https://app.dalatech.online/api/telegram`
- If this is a brand-new bot rather than a revoked-and-reissued one, press **Start** in its chat
  first. Telegram refuses a bot's first message otherwise.

**New Core Language token.** Put it in GitHub `core-language-automation` secrets
`TELEGRAM_BOT_TOKEN` (and `TELEGRAM_CHAT_ID` if the chat changes), and nowhere else.

**What stops.** Everything on the PC that talks to Telegram, including the #finish builder's
«урьдчилсан хувилбар бэлэн боллоо» notice. #finish is left as it is, as asked. Its builds still
run on the PC, but their notice will not reach you until #finish moves to the cloud.

## 6. Not covered

- Your own test messages to Дали on Messenger are not filtered, because your Messenger id for
  that Page is not known here.
- These rules are in the code, but the running copies on the PC keep the old code. After the
  rotation they cannot send anyway.
