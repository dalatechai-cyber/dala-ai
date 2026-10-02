# Billing wording — DRAFTS, unsigned (D-156)

What DalaTech sends its own clients: the invoice, the two reminders, the receipt, the pay
page's labels, and the words of computed invoice lines. **Nothing loads these files** in a
deployment. A live client receives nothing until the founder signs them:

    node scripts/prompt/sign-drafts.ts --dir prompt/drafts/billing              # read, get the set id
    node scripts/prompt/sign-drafts.ts --dir prompt/drafts/billing --set <id> --by Bilguun

Signing moves them into `prompt/platform/`, records their hashes, and writes the seed
migration (layer null: they are never part of a tenant's prompt). Then `supabase db push`.

Before signing, the founder can see them in a real inbox on a TEST account only:
`node scripts/billing/tick.ts --mode test --drafts` (every message is marked as a draft).

## Placeholders

`{name}` is filled by the platform; a block that uses any other name, or leaves out a
required one, refuses to render (`src/lib/billing/templates.ts`).

| Block | Must contain | May contain |
|---|---|---|
| `*_subject` | `{invoice_no}` | `{period}`, `{client}` |
| invoice / reminder bodies | `{client}` `{invoice_no}` `{amount}` `{lines}` `{due_date}` `{pay_link}` | `{period}` |
| `billing_receipt_body` | `{client}` `{invoice_no}` `{amount}` `{paid_date}` | `{period}`, `{pay_link}` |
| `billing_period_month` | `{year}` `{month}` | |
| `billing_period_range` | `{start}` `{end}` | |
| `billing_page_title` | | `{invoice_no}` |
| `billing_page_status_paid` | | `{paid_date}` |
| `billing_page_qr_valid` | `{time}` (the countdown, `4:59`) | |
| `billing_line_months` | `{label}` `{months}` | |
| `billing_line_team_discount` | `{count}` `{percent}` | |
| `billing_line_annual_free` | `{months}` | |

What the values look like: `{amount}` «250,000₮»; `{due_date}` / `{paid_date}` «2026.10.05»;
`{lines}` one line per item, «• Дали — AI хүлээн авагч: 250,000₮»; `{period}` is
`billing_period_month` for a monthly fee («2026 оны 10-р сарын»), `billing_period_range` for
an annual or hosting invoice («2026.11.01 – 2027.10.31 хугацааны»), and the first line's
label for a one-off charge. `{period}` is written in the genitive so «{period} төлбөрийн»
reads as one phrase.

Dates and amounts are never followed by a case suffix in these drafts («2026.10.05-ны»),
because the right suffix depends on the number's last word and the platform cannot choose it.

## 2026-10-02: three lines for the e-mail redesign (Ора's layout) — SIGNED 2026-10-02

Approved by the founder in chat on 2026-10-02 and signed (`prompt/platform/`, seed `0077`).

The billing e-mails now share Ора's approved e-mail layout. Three new lines, copied from
Ора's e-mails (`ora` repo, `docs/WORDING_REVIEW.md` M29, M31, M32) with only Ора's name
changed to DalaTech's contract:

| Block | Draft | Where it shows |
|---|---|---|
| `billing_mail_fallback_link` | Товч ажиллахгүй бол энэ холбоосыг хуулж, хөтөчдөө нээнэ үү: | Small grey line under the pay button, above the raw link (Ора M29) |
| `billing_mail_footer_why` | Та DalaTech-ийн үйлчилгээний гэрээтэй тул энэ имэйлийг DalaTech илгээв. | Footer under the card: who sent it and why (Ора M31 says «Та Ора-гийн бүртгэлтэй тул…») |
| `billing_mail_footer_contact_label` | Асуулт байвал: | Footer: «DalaTech \| dalatech.online \| Асуулт байвал: hello@dalatech.online» (Ора M32) |

Until they are signed, a real client's e-mail leaves them out: the raw link is shown under
the button with no label, and the footer reads «DalaTech | dalatech.online |
hello@dalatech.online» with no sentence. Nothing else depends on them.

## 2026-10-02: the pause notice, unsigned

Sent once, by e-mail, after the founder pauses a client for an unpaid invoice (Telegram
«Pause» button). Planned by the next hourly run, cancelled unsent if the invoice is paid
first or the founder resumes by hand. Branded like the reminders (pay button, bank box, PDF).

**Resume is automatic (founder, 2026-10-02):** once the invoice the pause was for is paid in
full (QPay, or a bank transfer the founder records), the engine resumes the client and tells
the founder «resumed after payment» (`engine.ts`, `autoResume`); the Resume button stays for
exceptions. The founder approved the lines on 2026-10-02 with «Төлбөр баталгаажмагц үйлчилгээ
сэргэнэ» (true for a recorded bank transfer too, not only QPay).

| Block | Draft |
|---|---|
| `billing_pause_subject` | Үйлчилгээ түр зогслоо ({invoice_no}) |
| `billing_mail_pause_title` | Үйлчилгээ түр зогслоо |
| `billing_mail_pause_intro` | Сайн байна уу, {client}. / Таны DalaTech-ийн үйлчилгээ төлбөр төлөгдөөгүй тул түр зогслоо. Төлбөр баталгаажмагц үйлчилгээ сэргэнэ. Асуулт байвал hello@dalatech.online хаягаар холбогдоно уу. |
| `billing_pause_body` | The plain-text fallback: the same sentences, the pay link, invoice number, amount, lines, «Хүндэтгэсэн, DalaTech». No due date: it has passed. |

Approved by the founder on 2026-10-02 (subject, heading, greeting, text, plain-text lines).
