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
