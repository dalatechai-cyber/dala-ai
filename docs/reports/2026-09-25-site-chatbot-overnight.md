# Overnight report: the site chatbot, the demo form, caching, the move into Dala AI

For the founder. Covers the overnight brief of 2026-09-25. Tara Salon's tenant, data and
channel were not touched: every database read tonight was read-only, and nothing was
written to the dala-ai project.

## At a glance

| Goal | State |
|---|---|
| 1. No invented contact details | **Done, live and verified.** Every reply from the site chatbot now goes through a facts-from-data guard. Live check: **11/11 clean** on production. 16 permanent tests run in the deploy build. [dalatech-chatbot#32](https://github.com/dalatechai-cyber/dalatech-chatbot/pull/32), [#33](https://github.com/dalatechai-cyber/dalatech-chatbot/pull/33) |
| 2. Demo form end to end | **Half done, half blocked on you.** The dalatech.online «Хүсэлт илгээх» form works: one fake lead, success shown 1.47 s after tapping submit, Telegram and email both sent. **I did not run the app.dalatech.online demo generator.** One lead there costs an estimated $3–5 of Fable 5 tokens, which is over your $3 cap. I also found a lost-lead bug there (§2.3) |
| 3. Caching | **Measured. Recommendation: no.** Zero real chats in the only log window that exists (24 h). Even at 20 conversations a day it saves about $4 a month (§3) |
| 4. Move into Dala AI | **Plan written (§4). Not built.** Four of the steps are decisions only you can make: credentials, the spend cap, prices, and a republish that changes tenant #0's live Facebook answers |
| Spend | **≈ $0.12** of Haiku tonight, all from the live chatbot checks. $0 on Fable 5 or Sonnet |

---

## 1. No invented contact details — done

### What was wrong
The 99273339 answer came from the site chatbot (`dalatech-chatbot`, the widget on
dalatech.online), not from Dala AI. Its only protection was a sentence in the prompt:
"never write a phone number". An instruction asks the model to behave. It doesn't check
what the model wrote.

### What I built (live since 06:37 UTC)
- **One data file, `lib/facts.js`**, holds everything the bot may state:
  - the email dalatech.ai@gmail.com
  - the location «Улаанбаатар, Монгол» (what the website's Байршил section shows)
  - the three allowed sites: dalatech.online, www.dalatech.online and app.dalatech.online
  - one price row per product, copied verbatim from the prompt
  - **no phone number.** The site publishes none, so any phone number in a reply is
    invented by definition.
- **A guard on every reply, `lib/factsGuard.js`.** This is the same approach as Tara's
  facts-from-data guard (`guard/facts.ts`, D-120). The guard refuses a reply that contains
  any of these:
  - a phone number (8 formats of 99273339 tested)
  - an email, web address or street address that isn't in the data
  - a price that isn't in the data
  - a real price on the wrong product, or of the wrong kind (a setup fee called monthly)

  A refused reply is thrown away whole. The visitor gets the data rows instead: the
  product's price line, the location, and the email plus request-form line. Nothing is
  rewritten and nothing served is new wording. Each refusal is logged with what the model
  tried to say.
- The prompt gained the location and two rules:
  - no district, street or unit numbers
  - no totals the model works out itself

  The guard is what enforces them.

### Verified on the live site
Eleven real questions go to the production bot from GitHub Actions (this environment
can't reach the site directly), and every reply goes through the guard. The questions:
«утас хэд вэ», «хаана байдаг», «үнэ хэд вэ», «Утасны дугаараа өгөөч», «Оффис чинь аль
дүүрэгт байдаг вэ?», «Далигийн үнэ хэд вэ?», «Дали Вира хоёрыг авбал нийт хэд вэ?»,
«Вэбсайт хийлгэх үнэ хэд вэ?», «и-мэйл хаяг», and two in English.

| Run | Result |
|---|---|
| Before the guard (06:30) | 9/11. The bot invented **400,000₮, 360,000₮ and 300,000₮** for Dali + Vira (sums and a discount it worked out itself). It made no phone number today |
| After #32 (06:37) | 11/11 clean. The guard stopped two replies: the Dali + Vira sums, and a wrong range for «үнэ хэд вэ» («AI ажилтан 250,000₮–250,000₮/сар»; staff actually cost 150,000–250,000₮) |
| After #33 (06:40) | **11/11 clean.** The Dali + Vira question was served the two price rows, and the English phone question was answered in English |

**What a visitor now sees for «утас хэд вэ»:** «Бидэнд нийтэлсэн утасны дугаар
байхгүй…» plus the email and the request form. The model wrote that itself, and it passed.
**For «хаана байдаг»:** «Байршил: Улаанбаатар, Монгол» plus the same two ways to reach us.

### Permanent tests
There are 16 tests in `test/facts.test.js`. They cover:
- the 99273339 incident in 8 formats
- the three questions above, using the live replies as fixtures
- the Dali + Vira sum
- ordinary answers that must never be refused
- a drift test that fails the build if the prompt and the data file disagree about a price

**These tests gate the deploy now, and the old checks never did.** The project builds
from `dalatech-messenger/vercel.json`, whose build command never ran `npm run check`. That
means the "cacheable prompt" gate and the spend-guard check, whose comments say they fail
the deploy, had never run in production. I read this off the build log. Fixed in #32; the
build log now shows `pass 14/14` (16 after #33).

### Two side fixes
- **English questions answered in Russian.** "What is your phone number?" came back in
  Russian. Phone questions use a second, smaller prompt that never had the main prompt's
  language rule. It has the same rule now (#33).
- **Fallback for a generic price question.** When a refused reply was about "the staff"
  in general, the fallback showed only the website prices. It now shows all five staff rows.

### What the guard cannot see
- a number written out in words («хоёр зуун тавин мянга»)
- an address with none of the address words it looks for

Both would appear in the log's `modelReplyPreview`. The fallback is in Mongolian even when
the visitor wrote in English.

### Your call
- The fallback text joins existing prompt lines, e.g. «Дали — Хүлээн авагч. Үнэ:
  250,000₮/сар, суурилуулалт 150,000₮». It's worth a native read.
- A visitor who asks "how much for Dali and Vira together" no longer gets a total. They
  get both price rows. That follows your rule (prices only from data). If you want totals
  and discounts shown, they have to become rows too.

## 2. Demo form, tested end to end

There are two forms, so I covered both.

### 2.1 dalatech.online «Хүсэлт илгээх» — tested live, works
I drove it in a real iPhone-sized browser from GitHub Actions
([dalatech-online#40](https://github.com/dalatechai-cyber/dalatech-online/pull/40), manual-only
workflow). One fake lead: name «TEST — Claude», business «TEST — Claude (бодит бизнес биш)»,
phone 00000000, request `4196ea17`, 2026-09-25 06:32:03 UTC.

| What the visitor sees | Time from page open |
|---|---|
| Page loaded | 0.45 s |
| «Хүсэлт илгээх» → dialog «1 / 3-Р АЛХАМ — Юу сонирхож байна?» | 0.97 s |
| «2 / 3 — Танай бизнес», then «3 / 3 — Хэрхэн холбогдох вэ?» | 1.7 s / 2.5 s |
| Taps «Хүсэлт илгээх» → button reads «Илгээж байна…» | 3.0 s |
| **«Хүсэлт хүлээн авлаа. Бид 00000000 дугаар руу удахгүй залгана.»** | **1.47 s after the tap** |

- **Server:** the lead is logged at 06:32:03.593 and the API answered `telegram: sent,
  email: sent` inside those 1.47 s. Both channels are therefore **under 1.5 s**.
- **What arrives for you:**
  - **Telegram:** accepted by Telegram's API. I can't read your chat from here, so please
    confirm you see it.
  - **Email:** sent, but **not to dalatech.ai@gmail.com**. No form lead has ever arrived
    in that inbox; it goes to whichever address `GMAIL_USER` / `DEMO_NOTIFY_EMAIL` names in
    Vercel. Check that it's an inbox you read.
- **The fake lead is clearly marked** («TEST — Claude», note «Бодит хүсэлт биш… устгаж
  болно»). I can't delete a Telegram message or an email from here. Delete them when you
  see them.

### 2.2 app.dalatech.online (the "demo within seconds" generator) — NOT run, needs your OK
- **Why not:** one lead starts three Fable 5 generations. Fable 5 costs $10/$50 per MTok,
  with ~24k characters of prompt and up to 32k output tokens each. That's an estimated
  **$3–5 per lead**, over your $3 cap.
- **What I checked without spending:**
  - The hourly cron runs.
  - Upstash answers (~160 ms).
  - Telegram sends (the 09:00 report and 10:00 follow-up went out today).
  - The last app lead email reached dalatech.ai@gmail.com from hello@dalatech.online.
- **Not proven:** there have been only 3 leads ever, the last on Aug 23, **the same day
  demos were switched to Fable 5**. So the Fable 5 pipeline has never run in production.
  Whether the key has Fable 5 access, and whether 32k output tokens fit in 540 s, is
  unproven.
- **To run it:** reply "run the app test". It's one lead, about $3–5.

### 2.3 Found, not changed (these change what visitors see, so they're your call)
1. **app.dalatech.online can lose a lead while saying thank you.** The success screen
   («Баярлалаа… хүлээн авлаа») shows *before* the server is called, and any failure is
   only written to the browser console. If the save fails (Upstash down, a validation
   error, a dropped connection), the visitor sees success and the lead is gone. dalatech.online's
   form does this right: it waits for the server, keeps what was typed, and offers
   Messenger or email on failure.
   *Proposal:* show «Илгээж байна…» until the server answers, and on failure keep the
   form with the same fallback dalatech.online uses.
2. **The promise doesn't match the product.**
   - The site says «демо вэбсайтаа хэдхэн секундэд өөрөө үүсгэж үзнэ үү» (a few seconds).
   - The app says «Бэлэн болсон демог 24 цагийн дотор… имэйл хаяг руу илгээх болно».
   - The pipeline deploys in ~12–15 min, and `DEMO_DELAY_HOURS=24` holds the email for a day.

   *Proposal:* either change the site copy to what's true (e.g. «24 цагийн дотор
   имэйлээр») or set the delay to 0 and promise «15 минутын дотор».
3. **A timed-out generation can be billed twice.** The Anthropic SDK in dalatech-app
   (0.30.1) retries twice by default. A 540 s generation that times out gets retried inside
   a function that dies at 600 s. *Proposal:* `maxRetries: 0` on that call. It's a one-line
   backend change, but it's in the money path of a pipeline I couldn't test.

## 3. Caching — recommend NO

**Traffic.** The runtime log keeps 1 day, and in that day there were **0 real chat
requests** and 0 form submissions. There is no longer record: no analytics, and the
in-memory counter resets per instance. I can't give you a monthly number, and I'd rather
say that than guess.

**Measured cost per reply** (Haiku 4.5, token counts logged by the route tonight):
- Main prompt: ~4,480 input + ~130 output tokens = **$0.0051** per reply
- Contact prompt: ~480 input tokens = **$0.0013** per reply
- Cache reads today: 0. Caching is not switched on.

**What caching would do.** It uses the 5-minute cache: writes cost 1.25× and reads 0.1×,
on the 4,440-token prompt.

| Conversation | Without | With | Saving |
|---|---|---|---|
| 1 turn | $0.0051 | $0.0062 | **−22% (costs more)** |
| 3 turns | $0.0162 | $0.0093 | 42% |
| 5 turns | $0.0285 | $0.0137 | 52% |

| Traffic (3-turn conversations) | Monthly bill | Saved by caching |
|---|---|---|
| Measured today (0/day) | $0 | $0 |
| 5 a day | $2.43 | $1.03 |
| 20 a day | $9.73 | $4.13 |
| 100 a day | $48.64 | $20.65 |

**No.** At measured traffic it saves nothing. One-question visits cost 22% more. The bot
is also being retired into Dala AI, which already caches its prompt, so the saving would
last only until the move. Revisit only if the move slips and traffic passes ~50
conversations a day. The prompt now clears Haiku's 4,096-token caching floor by 344
tokens, and that gate finally runs in the build.

## 4. Plan: the site chatbot becomes tenant #0's `web` channel in Dala AI

### What already exists (measured tonight, read-only)
- **Dala AI already has the website channel**, built 2026-09-18/19 (D-086), inert:
  - `POST /api/web/session` (mint: the tenant's own server signs a request with a
    per-tenant secret; Turnstile sits behind that signature)
  - `POST /api/web/message` (the same reply path, prompt, guards and facts guard as Tara)
  - a per-address and per-session rate limiter, 2-hour sessions, and a turn cap per
    session (max 40)
- **Tenant #0 has a `web` channel row** (`22e3c169…`), and `dalatech.online` and
  `www.dalatech.online` are verified in `tenant_domains`.
- **It is completely off today, three ways:**
  - no web mint secret has been sealed, so every mint is refused
  - `TURNSTILE_SECRET_KEY` is unset, so the mint fails closed
  - no page calls it
- **Spend:** the website shares tenant #0's `reception` budget. That's $0.50/day × 0.95
  = **$0.475/day**, under the $2.00 platform cap.

### What the visitor notices: nothing, if done this way
Keep the widget exactly as it is: the same button, the same iframe, the same chat screen
from dalatech-chatbot. Change only what's behind it:
- dalatech-chatbot's server becomes "the tenant's own server". It holds the mint secret,
  mints a Dala AI session, and relays each message to `/api/web/message`.
- Turnstile runs in the iframe in invisible/managed mode, so most visitors see nothing.
- A switch (`CHAT_BACKEND=legacy|dala`) lets you flip back in one env change without a
  deploy.

The one visible difference is the answers: Sonnet 5 writes better Mongolian than Haiku
(D-009), and Dala AI's rules are stricter.

### The four decisions that are yours, and must come first
1. **Prices (the blocker).**
   - What Dala AI tenant #0 can price today: one row (`price_overview`) that answers
     exactly «үнэ хэд вэ»-shaped messages (D-088).
   - «Далигийн үнэ хэд вэ?» gets the "price unlisted" refusal. The current site bot
     answers it correctly and now safely, so moving as-is is a **measured regression**.
   - Options:
     - (a) allow per-product price rows for tenant #0. You rejected this on 09-19 because
       of match ordering, so it would need an ambiguity verdict first.
     - (b) accept the regression.
     - (c) let the facts guard serve price rows from the prefix for this tenant: prices
       enter the prompt, and D-075 is reversed for tenant #0 only, as a row setting.

   My recommendation is (c). The site bot's clean 11/11 tonight is that exact design
   working.
2. **Republish tenant #0.** Its knowledge rows (7 documents, 8 FAQs, 2 contacts, seeded
   09-19) exist, but **the live prompt (seq 3, 09-19 05:24) predates them.** Today tenant
   #0 answers almost everything, on Facebook too, with the handoff line. Republishing
   fixes that for both channels, but it changes tenant #0's live Facebook answers, so it
   needs your OK. Add a `contact_points` address row «Улаанбаатар, Монгол» at the same time.
3. **The spend cap (money).**
   - At $0.475/day and ~$0.038 for a cold 3-turn Sonnet conversation (tenant #0's prompt
     is 10,770 chars ≈ 7.6k tokens: ~$0.032 for the first turn at the 1-hour cache write,
     ~$0.003 for each later one), the cap is **~12–14 website conversations a day**, shared with
     tenant #0's Facebook DMs.
   - A bot flood that gets past Turnstile could take tenant #0's DMs down for the rest of
     the day. Tara is not affected: budgets are per tenant.
   - Either raise tenant #0's daily ceiling, or I add a per-channel sub-cap (code, then
     your number).
4. **Credentials.**
   - A Cloudflare Turnstile site and secret key. The secret goes to dala-ai as
     `TURNSTILE_SECRET_KEY`; the site key goes to the widget.
   - A web mint secret. It's sealed into `tenant_secrets` for channel `22e3c169…` and set
     in dalatech-chatbot as an env var.
   - Also a `tenant_domains` row for `dalatech-chatbot.vercel.app`: the iframe's origin is
     what calls `/api/web/message`, and it must be verified by you.

### Order of steps (each one reversible until step 7)
1. You decide 1–3 above. I build the per-channel sub-cap if you choose it.
2. Republish tenant #0 through `scripts/publish/tenant.ts` (the reply-case gate runs).
   Check Facebook answers the next morning.
3. You create the Turnstile keys and the mint secret. I seal the secret; the switch stays
   `legacy`.
4. I build the relay in dalatech-chatbot behind `CHAT_BACKEND` (default `legacy`), with
   tests against a fake Dala AI. Visitors notice nothing.
5. Test on a preview deployment with `CHAT_BACKEND=dala`: the same 11 live questions, a
   Turnstile pass/fail, and a spend-cap trip.
6. You flip `CHAT_BACKEND=dala` in production. Watch one day of `spend_ledger` and the
   flaw report.
7. After a clean week: retire `/api/chat` in dalatech-chatbot and delete its Anthropic key.

### Risks
- The prices regression (decision 1).
- The shared cap (decision 3).
- **Turnstile has never met Cloudflare** (D-086: unreachable from this environment). Step
  5 is its first real run.
- Sonnet costs about 2.3× Haiku per 3-turn conversation ($0.038 vs $0.016), which is the price of the better Mongolian.
- If the relay fails, the visitor must get the email/form line, never a spinner. That's a
  test in step 4.

## Waiting for your decision
1. Run the app.dalatech.online test lead (~$3–5 of Fable 5)? (§2.2)
2. Fix the app's lost-lead success screen and the "seconds" vs "24 hours" promise. Wording
   is yours. (§2.3)
3. `maxRetries: 0` on Fable 5 generation (§2.3)
4. Migration: prices (a/b/c), republish tenant #0, the spend cap, the credentials (§4)
5. A native read of the fallback lines the guard serves (§1)
6. Confirm the Telegram test message arrived, and tell me which inbox `GMAIL_USER` is (§2.1)

## Spend
- Haiku (site chatbot): 33 live test questions over three runs, **≈ $0.12**
  (baseline $0.039 measured from logged tokens; the two later runs are similar).
- Fable 5 / Sonnet 5 / dala-ai: **$0**.
- Well under the $3 cap.

## Links
- [dalatech-chatbot#32](https://github.com/dalatechai-cyber/dalatech-chatbot/pull/32) (guard, merged, live)
- [dalatech-chatbot#33](https://github.com/dalatechai-cyber/dalatech-chatbot/pull/33) (follow-ups, merged, live)
- [dalatech-online#40](https://github.com/dalatechai-cyber/dalatech-online/pull/40) (form end-to-end test)
