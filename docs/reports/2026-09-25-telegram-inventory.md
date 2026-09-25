# Telegram: every message, and a proposed clean set (2026-09-25)

**Nothing has been changed.** This is the list you asked to see first. Read from the code on `main` of each repository, plus today's live logs.

## Where messages come from

| Source | Sends to your Telegram |
|---|---|
| **dalatech-app** (app.dalatech.online) | Lead events, the 09:00 morning report, the 10:00 follow-ups, and replies to your commands |
| **dala-ai** (Дали platform) | Immediate alerts, the nightly digest and the flaw report |
| **dalatech-online** (dalatech.online) | One message per «Хүсэлт илгээх» demo request |
| **core-language-automation** | Core Language's weekly report (Sundays at 09:00) and «пост амжилтгүй» failures. Whether this reaches the same chat depends on its own `TELEGRAM_CHAT_ID` |
| dalatech-chatbot, Matrix-Chatbot | Nothing |
| dalatech-automation | Nothing on a schedule. Its Telegram jobs are turned off and run only by hand |

## 1. Every message kind

### Scheduled (arrives whether or not anything happened)

| # | Message | Source | When | Notes |
|---|---|---|---|---|
| S1 | **Follow-up reminder** «📞 Дагаж мэдэгдэх — #NNN … Демо илгээснээс хойш N өдөр болж байна» | app `api/follow-up.js` | Every day at 10:00, **one message per lead** with status `sent` whose demo went out 3+ days ago | **Never stops.** No limit, no "already reminded" flag, no test filter. Only a design click ends it. Links go dead after 7 days (demos are deleted) but the reminder keeps listing them. Today's log: #001 (78 days), #002 (32), #003 (31), three messages every morning |
| S2 | **Morning report** «🌅 DalaTech өдрийн тайлан» | app `api/morning-report.js` | Every day at 09:00 | Counts every lead, including tests. Its «ХАРИУ ӨГӨӨГҮЙ (3+ өдөр)» section repeats the S1 leads forever. Its domain-overdue line can never fire (it reads a field that is never written). Failed and held leads are counted nowhere |
| S3 | **Dala AI digest** «Dala AI — {date} … Nothing open. …» | dala-ai `alerts/digest.ts` | Daily (QStash) | Sent on clean days too, by design (a heartbeat). The repo can't settle its schedule: one source says 00:05 Ulaanbaatar, another 09:00. **If both schedules exist in QStash, S3 and S4 arrive twice.** Only the QStash console shows this |
| S4 | **Flaw report** «Flaws — {tenant}: k of n replies look wrong» | dala-ai `quality/flaws.ts` | Right after S3, always a separate message | Includes your own test turns on live tenants |
| S5 | **Still open after 3 days** «🔴 STILL OPEN after 4d: …» | dala-ai digest | Every 3 days per critical open condition | Today only "channel silence" conditions qualify |
| S6 | Core Language weekly report | core-language-automation | Sundays at 09:00 | A separate business |
| S7 | Local twins of S1 and S2 | app `routines/*.js` (PM2 on your PC) | Same times as S1 and S2 | If still registered in PM2, **every reminder and report arrives twice**. The README says to delete them; I can't see your PC |

### Real business events (a person did something)

| # | Message | Source | Act? |
|---|---|---|---|
| E1 | «🔔 Шинэ захиалга #NNN» (lead from the app form; held leads carry «RELEASE #NNN») | app `generate.js` | **Yes.** Fires for test leads too |
| E2 | «🔔 Вэбсайтаас шинэ хүсэлт» (dalatech.online form) | online `api/demo-request.js` | **Yes.** The two manual test workflows each send one «TEST — Claude» message per run |
| E3 | «🎨 Загвар сонгогдлоо» (a visitor picked a design) | app `choice.js` | **Yes, call them.** Would also fire for a click on a test demo |
| E4 | «❌ #NNN демо зогслоо (stage) … RELEASE #NNN» | app `process-lead.js` | **Yes** |
| E5 | «🟠 Гомдол / complaint comment — {tenant}» with a link | dala-ai `comments/complaint.ts` | **Yes.** Fires in shadow mode too |
| E6 | «🟠 Data deletion request(s) received today» | dala-ai data-deletion route | Legal record, though nothing can be done yet (the text says so) |

### Something broke (dala-ai, sent immediately)

| # | Message | Level | Act? | Problem |
|---|---|---|---|---|
| B1 | Customer not answered: «Inbound event … refused every time» (exhausted) or «… past this tenant's N-minute reply limit» (stranded) | 🔴 | **Yes, the customer is waiting** | Your own test DMs to tenant #0 can trigger it. It produced 37 false criticals on 09-22 to 09-24 before D-113 |
| B2 | Event re-published (rescued) | 🟠 | No, unless "REFUSED" | Sent every time, even when the rescue worked |
| B3 | Standby: «another app is the PRIMARY receiver» | 🔴 | **Yes** | Once per channel per day while it lasts |
| B4 | Model retired (404) | 🔴 | **Yes** | Its key has no date, so it fires once ever. A second occurrence is silent |
| B5 | Model swapped / prompt cache cold | 🟠 | Investigate | Cache-cold can trip on a quiet tenant with nothing broken |
| B6 | Page token revoked / permission refused | 🔴 | **Yes** | Once ever per channel: a second revocation after re-sealing is silent |
| B7 | Credential failure 1–2 in a row / channel halted after 3 / halt cap | 🟠/🔴 | **Yes** (halted = a stopped channel) | |
| B8 | KEK unavailable / credential won't decrypt | 🔴 | **Yes** | Once ever per tenant or channel |
| B9 | Credential expires in ≤7 days | 🔴 | **Yes** | Once ever. Its 30-day early warning is **written to the database and never sent anywhere** |
| B10 | Reply delivery unknown (timeout) | 🟠 | Weak: no link, no conversation | |
| B11 | Retention purge backlog | 🟠 | Investigate | |
| B12 | «ℹ️ Page …: recovered» | ℹ️ | No | Often the recovery of a fault that was never announced, because faults go to the digest and usually clear before it runs |
| B13 | «⚠️ Test gate OVERRIDDEN for deploy …» | — | Audit only: you triggered it yourself | |

The dalatech-app build-flow messages are covered in §3: preview ready (APPROVE/CHANGE), build failed, domain live, domain still pending after 72 h, and the replies to your commands.

**On a quiet day today you receive at least 6 messages: S1 ×3, S2, S3, S4.** With a duplicate QStash digest or the PM2 twins, up to 11. Not one of them asks you to do anything new.

## 2. Test leads and test demos

Nothing in any repository recognises a test. There is no flag and no filter in dalatech-app, dala-ai or dalatech-online. The test runs already mark themselves, so a rule can use data that exists today. A lead is a test if any of these hold:
- the email contains `+test@`
- the name or business starts with `TEST`
- the phone is all zeros
- the notes start with `TEST —`

A test would then be saved, but nothing sent. **Which of #001, #002 and #003 are tests is your call;** I can't read the lead store from here.

## 3. `#NNN finish`

**What it does.** The cloud only files the request: it saves your notes and photos, sets the lead to `ready_to_finish`, and replies «Мэдээлэл хадгаллаа…». The build itself runs in `routines/watch.js` **on your PC under PM2**. That process researches, plans, generates up to 3 times with `claude-opus-4-6`, self-reviews, and deploys a production site (≈$1–5 per run by the token caps; not measured). It then sends «урьдчилсан хувилбар бэлэн боллоо» with APPROVE and CHANGE. After that: `APPROVE` deletes the demos, and `DOMAIN` buys a domain for real or attaches your own.

**Does it work today?** The code path is intact, but I can't confirm it runs, because it depends on the watcher on your PC. If the PC is off, the lead waits silently and nothing warns you. It also breaks today's rules:
- the production prompts **still ask for invented prices, names, a founding story and social links**;
- your visitor's form notes are dropped;
- the demo-only «Жишээ» marking is skipped.

It also accepts `finish` on a lead whose domain is already live, which redeploys to a new project and leaves the domain on the old one.

**Do you need it?** Only when a client pays for the full website. It is the only path from a demo to a paid site. **Proposal:** keep it, but don't trust it with a real client until these are fixed:
- the watcher warns you when it's off, or the build moves to the cloud;
- the production prompts follow the facts rules;
- the form notes reach the build.

## 4. Proposed clean set (for your approval)

**Stay, immediately (you must act):**
- E1 real lead (app); E2 real website request; E3 design chosen
- E4 demo failed; production build failed
- E5 complaint comment
- B1 customer not answered (real customers only)
- B3 standby; B4 model retired; B6 token revoked; B7 channel halted; B8 credential unreadable; B9 credential ≤7 days
- The replies to your own commands (APPROVE/CHANGE/DOMAIN/RELEASE)

**Merge into one daily report at 09:00** (replacing S2 + S3 + S4, with S5 folded in):
- today's leads and their state, including failed and held leads, which today appear nowhere;
- **follow-ups**, as one line per real lead on days 3, 7 and 14 only, then dropped. Leads whose demos are deleted drop out;
- Dali: open conditions, the one-line heartbeat, the flaw report and anything still open;
- the demoted warnings: B2 rescued events, B5 model and cache, B7 1–2 credential failures, B10, B11, B12 recoveries, E6 deletion requests, and the 30-day credential warning (sent at last).

**Stop:**
- S1 as separate daily messages;
- **everything about test leads and test demos** (new-lead, reminders, report counts, design clicks);
- your own test turns in the flaw report (tell me your PSID, or which tenant to treat as a test);
- the duplicates: the PM2 twins (S7) and the second QStash digest schedule if one exists;
- the unused `sendTelegramConfirmation`.

**Fix while there:** the "once ever" keys (B4, B6, B8, B9) should alert again if the problem comes back. Messages should show the tenant's name, not a raw ID.

**Outside this plan:** the Core Language messages (S6), which belong to a separate business.

**Result:** a quiet day becomes **one message**. Everything else arrives only when you have something to do.
