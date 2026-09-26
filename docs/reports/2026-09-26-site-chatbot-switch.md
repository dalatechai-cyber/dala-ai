# Morning steps: move the dalatech.online chat onto Dala AI (D-138)

Nothing is live. The site chat keeps using the old bot until you do step 9. The code is
merged, and the switch `CHAT_BACKEND` is unset, which means off.

Two values here are secrets, the salt and the mint secret. Don't paste them into chat.
**A Vercel environment change only takes effect after a Redeploy.** Every step below that
changes a variable ends with one.

## A. Dala AI (Vercel project `dala-ai`, Production)

1. **`CLIENT_IP_SALT` is unset**, and the web routes refuse every request without it.
   - Run `openssl rand -base64 32` and add the output as `CLIENT_IP_SALT`.
   - You don't need to keep a copy. If it is ever changed, the rate-limit buckets reset and
     nothing else happens.
2. **`TURNSTILE_SECRET_KEY` is already set** (the last build log says so). Check which
   Cloudflare widget it belongs to:
   - It must be the widget whose hostnames include `dalatech-chatbot.vercel.app`. The chat
     runs inside an iframe served from that host.
   - If it isn't, go to Cloudflare → Turnstile → Add widget. Name it `dala web chat`, give it
     the hostnames `dalatech-chatbot.vercel.app` and `dalatech.online`, and set the mode to
     **Managed**. Then replace the secret with this widget's secret.
3. Redeploy dala-ai. In the build log, preflight should print `ok CLIENT_IP_SALT` and
   `ok TURNSTILE_SECRET_KEY`.

## B. The mint secret (§5 C of the 2026-09-25 report, unchanged)

4. On your machine, run `MINT=$(openssl rand -base64 32)`.
5. In a dala-ai checkout, run `npm install` and export `TENANT_KEK_ACTIVE_VERSION` and
   `TENANT_KEK_V1` from your own copy. Then run:
   `printf %s "$MINT" | node scripts/kek/seal.ts --tenant 919e21d4-224d-44b3-bb62-273caa6237ce --channel 22e3c169-2350-45de-9806-d5c96587ce9f --kind web_mint_secret`
6. The script prints SQL and writes nothing. Run that SQL in the Supabase SQL editor, then
   check that the row exists:
   `select kind, kek_version, status from tenant_secrets where channel_id = '22e3c169-2350-45de-9806-d5c96587ce9f';`
   It should return one row: `web_mint_secret`, `active`.

## C. The site chatbot (Vercel project `dalatech-chatbot`, Production)

7. Add these four variables:
   - `DALA_WEB_MINT_SECRET` = `$MINT`, exactly: no trailing space and no newline
   - `DALA_API_URL` = `https://api.dalatech.online`
   - `DALA_WEB_CHANNEL_ID` = `22e3c169-2350-45de-9806-d5c96587ce9f`
   - `TURNSTILE_SITE_KEY` = the site key of the widget from step 2
8. **Try it before any visitor sees it.**
   - Set `CHAT_BACKEND` = `trial`, then Redeploy.
   - Visitors still get the old bot.
   - Open `https://dalatech-chatbot.vercel.app/?dala=1` and ask «Далигийн үнэ хэд вэ?»,
     «үнэ хэд вэ», and leave a test phone number. You should get the Page's answers, and a
     «📞 New lead» in Telegram.
   - If the chat says «Уучлаарай, системд алдаа гарлаа…», open Vercel → dala-ai → Logs and
     search `[web]`. The refusal code names the cause.

## Switch on, and switch back

9. **On:** set `CHAT_BACKEND` = `dala` in dalatech-chatbot, then Redeploy.
10. **Back instantly (seconds, no build):** Vercel → dalatech-chatbot → Deployments → the
    previous production deployment → **Instant Rollback**. Then set `CHAT_BACKEND` to
    `legacy` (or delete it), so the next deploy stays off.
11. **Emergency stop on the Dala AI side, no deploy:**
    `update tenant_channels set delivery_mode = 'off' where id = '22e3c169-2350-45de-9806-d5c96587ce9f';`
    - Open conversations stop on their next message, which is new tonight.
    - The chat then shows the polite "unavailable" line. It does not fall back to the old
      bot; step 10 does that.
    - `'live'` turns it back on.

## What it does when on
- **Same answers as the Page.** The web and Page snapshots share one revision
  (`ca202860`, read tonight).
- **Same follow-up, once per conversation.** A phone number left in the chat now reaches
  Telegram; this was missing on the web path and is fixed tonight.
- **Limits:**
  - per visitor: 20 turns per session, 10 messages a minute, 6 new sessions a minute, and
    a Turnstile check per session
  - per address: 60 messages a minute
  - the shared $2.00/day Reception cap. A flood can use it up for the Facebook Page too.
- **If Dala AI is down or slow**, the visitor sees the old bot's error line plus the email
  and form lines within 40 s. A message is never sent twice after a timeout.

## Decide
- Tenant #0's `handoff` line promises «Хамт олон маань хариулах болно». On the website,
  nobody is told about the conversation unless the visitor leaves a number. Keep it, or
  write a web-specific line.
- Only the iframe page moves. `widget.js` and the React widget stay on the old bot, and
  dalatech.online uses neither.
