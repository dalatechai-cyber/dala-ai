# Client billing by QPay — the founder's runbook (D-156)

DalaTech invoices its own clients: the monthly fee on the 1st (Ulaanbaatar), paid by QPay
into the **same merchant Core Language uses**, recorded automatically, reminded on the 3rd
and 6th, summarised to you on the 6th, and on the 13th (contract 4.9: more than 7 days late) you
are **asked** — never automatically —
whether to pause a client who has not paid. Annual-prepay clients get one yearly invoice and
nothing monthly. This file is what you do, once and then never.

Nothing in Core Language changes. Its orders stay in its own database; ours are in this
project, numbered `DT-…` (test ones `TEST-…`), and every QPay description begins `DalaTech`,
so the two are told apart in the QPay merchant app.

## Where the client reads it (your choice per client)

| Option | Built | What happens |
|---|---|---|
| **E-mail** (recommended) | yes | Invoice, reminders, receipt go to the client's address from `hello@dalatech.online` (the authenticated domain Core Language sends from). **Reply-To is you**, because that address has no inbox. You get a Telegram copy of every invoice. |
| **A link you forward** | yes | A client with no e-mail on file: each message comes to you on Telegram, ready to forward (Messenger, Viber, anything). The pay page link works everywhere. |
| **Messenger from our Page** | **no** | Meta allows a Page to message a person only within 24 h of their last message, except under a message tag; whether an invoice or a payment reminder fits a tag (`POST_PURCHASE_UPDATE` / `ACCOUNT_UPDATE`) is a Meta policy question this repo cannot check (the App Dashboard is blocked here), and a page echo would also reach the handover logic. Not built until you decide. |

## One-time setup

1. **Approve the wording** — the 22 drafts in `prompt/drafts/billing/` (invoice, reminders,
   receipt, pay page, line labels). Then sign and seed them:

       node scripts/prompt/sign-drafts.ts --dir prompt/drafts/billing             # read; prints the set id
       node scripts/prompt/sign-drafts.ts --dir prompt/drafts/billing --set <id> --by Bilguun

   then commit, and `supabase db push` (with `0065_billing`).
2. **Schema: done.** `0065_billing` was applied to the project on 2026-09-28 (D-156 addendum).
3. **Vercel environment (Production and Preview):**
   - copy from Core Language's Vercel project, same names: `QPAY_USERNAME`, `QPAY_PASSWORD`,
     `QPAY_MERCHANT_ID`, `QPAY_BANK_CODE`, `QPAY_BANK_ACCOUNT`, `QPAY_ACCOUNT_NAME`, `BREVO_API_KEY`;
   - `QPAY_TERMINAL_ID=DALATECH_AI` (the terminal Core Language uses);
   - `SUPABASE_SECRET_BILLING` — a new secret key in Supabase (Settings → API keys);
   - `BILLING_LINK_SECRET` — 32+ random characters (`openssl rand -base64 36`);
   - `BILLING_FOUNDER_EMAIL` — your address;
   - `BILLING_MODE=test`.
   Preflight refuses the deploy if `BILLING_MODE` is `test`/`live` and any of these is missing.
4. **QStash, after the merge** (before it the route does not exist in production and QStash
   would log a 404 every hour): one schedule, cron `0 * * * *`, POST,
   `https://api.dalatech.online/api/workers/billing`, empty body. With `BILLING_MODE` unset it
   answers "disabled".

## The test (you pay 100₮ yourself)

In your shell, with the same `DALA_PUBLIC_URL` and `BILLING_LINK_SECRET` as Vercel, the QPay
and Brevo variables, `TELEGRAM_*`, `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_PUBLISH`:

    node scripts/billing/account.ts propose --test --name "Туршилтын харилцагч" --email <you> \
      --staff "Туршилт=100" --start <this month, e.g. 2026-09> --apply
    node scripts/billing/account.ts confirm --schedule <id> --fingerprint <fp> --by Bilguun

- **On time:** the next hourly run invoices it for this month, due today (or run it now:
  `node scripts/billing/tick.ts --mode test`; add `--drafts` to see the unsigned wording). Open
  the e-mail's link: the page makes a QPay code and counts down its five minutes («QR код 4:59
  хүчинтэй»); when it runs out, «Шинэ QR код авах» makes a new one. Pay the 100₮. Within
  seconds (callback) or the hour (check) you get the receipt and a ✅ on Telegram.
- **Late:** `node scripts/billing/charge.ts --account <id> --key late-test --line "Туршилт=100" --issued <7 days ago> --due <4 days ago> --by Bilguun --apply`;
  the next run asks you about pausing (test accounts pause nothing). Pay it late: ✅.
- **Wrong amount:** QPay's QR fixes the amount, so a wrong QPay payment cannot be produced by
  paying. Test it as a transfer: `node scripts/billing/settle.ts bank --invoice TEST-… --amount 50 --ref TEST-1 --paid-on <today> --by Bilguun`
  on an unpaid test invoice → ⚠️ mismatch, no receipt. Settle it with `settle.ts resolve`.

## The branded invoice (0070) — four steps, once

Until all four are done, invoices keep going out as the plain e-mail and Telegram says why once.

1. **Sign the wording:** `node scripts/prompt/sign-drafts.ts --dir prompt/drafts/billing`, read it, then sign with `--set <id> --by Bilguun`, and push. Claude applies the seed.
2. **Your details** in Vercel → dala-ai → Settings → Environment Variables (Production):
   `BILLING_ISSUER_NAME` (your full name, as you sign), `BILLING_ISSUER_PHONE`,
   `BILLING_BANK_ACCOUNT` (Khan Bank), `BILLING_BANK_HOLDER` (the name on the account).
   `BILLING_FOUNDER_EMAIL` is already the e-mail shown. Preflight refuses `BILLING_MODE=live` without them.
3. **No "Unsubscribe":** Brevo adds that link to every e-mail, and a client who presses it
   never gets another invoice. Copy `RESEND_API_KEY` from the dalatech-online project (or
   make a new sending-only key on the Resend account where dalatech.online is verified), add
   it to dala-ai, and set `BILLING_EMAIL_VIA=resend`.
4. **pay.dalatech.online:** Vercel → dala-ai → Settings → Domains → add `pay.dalatech.online`;
   at the DNS host of dalatech.online add the CNAME record Vercel shows (the same kind as
   `api`). Once Vercel shows it Valid, set `BILLING_PAY_ORIGIN=https://pay.dalatech.online`
   and redeploy. Until then the address is `api.dalatech.online/pay/DT-…-XXXXXX`. Never set
   it before the host answers: an address in a sent e-mail cannot change.

Contract numbers are printed when the account has one: `billing_accounts.contract_ref`.

## Going live — your approval of the first real run

For each client: `node scripts/billing/account.ts propose --tenant <slug> --name "<legal name>" --email <…> --staff "<staff>=<monthly>" … --start <first month>`,
read it, `--apply`, `confirm`. Then:

    node scripts/billing/report.ts preview      # exactly what the 1st will invoice, and what is unconfirmed

and set `BILLING_MODE=live` in Vercel. That switch is the approval.

## Every month: nothing

Unless a Telegram message asks you something:

| Message | What you do |
|---|---|
| 🧾 invoice copy / ✅ paid / 📊 summary (6th) / 📒 ledger (1st) | nothing |
| ✉️ Forward to … | forward it (clients without e-mail only) |
| ⏸ … has not paid (13th) | tap **Pause** and confirm, or ignore it |
| ✅ … paid, with **Resume** | tap it (the contract: restore within 1 working day) |
| ⚠️ payments total … against … | `settle.ts resolve --outcome paid` (accept) or `void`, or wait for the rest |
| ⚠️ … is recorded on …, which you WITHDREW | QPay-reported: refund it, or apply it by hand. Recorded by hand: check it was real money |
| 🟠 Billing: … | it says what happened and the one command that fixes it (e.g. a QPay payment it could not read: `settle.ts qpay --payment-id …`, plus `--qpay-invoice <code>` when the invoice has several QPay codes) |

A bank transfer instead of QPay (contract 4.5): `settle.ts bank …` — the one thing you type.
Bookkeeping: the 1st's 📒 message and CSV e-mail, or `node scripts/billing/report.ts ledger --month YYYY-MM`.
No VAT and no e-barimt: DalaTech is not VAT-registered (contract 4.6); the receipt says so.

## Decisions waiting for you

- **Pause question: decided (2026-09-28)** — the 13th, per contract 4.9.
- **The first month** (4.3: "counted from the act's signature date"): not prorated
  automatically. Invoice a first partial month with `charge.ts`; the schedule starts on the
  next 1st.
- **«Анхны 10 бизнес»** (free setup, first month 50%): a one-off line via `charge.ts`.
- **MCC code:** invoices reuse Core Language's `8299` (education). Whether QPay wants a
  software code for DalaTech's invoices on the same merchant is a question for QPay.
