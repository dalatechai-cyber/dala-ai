/**
 * The four client e-mails (invoice, two reminders, receipt) rendered with FAKE data, to look
 * at the design without a database, a QPay call or a send.
 *
 *     node scripts/billing/preview.ts --out <dir> [--logo https://…/dalatech-wordmark.png] [--signed-only]
 *
 * Writes `<kind>.html`, `<kind>.txt`, `<kind>.subject.txt` and, for the invoice and the
 * reminders, `<kind>.pdf`, as the engine would plan them. Wording is read from disk: the
 * signed blocks in `prompt/platform/` and the unsigned drafts in `prompt/drafts/billing/`,
 * so a draft line shows and the e-mail carries the TEST mark, exactly as `tick.ts --drafts`
 * gives a test account. `--signed-only` leaves the drafts out: what a real client would get
 * today. Nothing here reads the environment or the network.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderMail, type MailKind } from '../../src/lib/billing/mail.ts';
import { renderInvoicePdf } from '../../src/lib/billing/pdf.ts';
import { BILLING_BLOCK_KEYS, render, type BillingBlockKey, type Wording } from '../../src/lib/billing/templates.ts';
import type { Invoice } from '../../src/lib/billing/engine.ts';
import { die, flag, has } from './_common.ts';

const CMD = 'preview';
const out = flag(CMD, 'out') ?? die(CMD, 'usage: node scripts/billing/preview.ts --out <dir> [--logo <https url>] [--signed-only]');
const logoUrl = flag(CMD, 'logo') ?? '';
const signedOnly = has('signed-only');

function blocksIn(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((x) => x.startsWith('billing_') && x.endsWith('.mn.txt'))) {
    const key = f.slice(0, -'.mn.txt'.length);
    if ((BILLING_BLOCK_KEYS as string[]).includes(key)) m.set(key, readFileSync(`${dir}/${f}`, 'utf8').trim().normalize('NFC'));
  }
  return m;
}
const signed = blocksIn('prompt/platform');
const drafts = signedOnly ? new Map<string, string>() : blocksIn('prompt/drafts/billing');
const wording: Wording = { source: drafts.size > 0 ? 'draft' : 'signed', blocks: new Map([...signed, ...drafts]) };

// Fake data only: no real client, invoice, account or link.
const FAKE_ISSUER = { name: 'Б. Билгүүн', phone: '9911 2233', email: 'hello@dalatech.online', bankAccount: '5000000000', bankHolder: 'Б. Билгүүн' };
const FAKE_ACCOUNT = { displayName: 'Туршилт ХХК', contractRef: 'DT-2026/000' };
const FAKE_PAY_URL = 'https://pay.dalatech.online/TEST-202610-0001-PREVIEW';
const invoice: Invoice = {
  id: '00000000-0000-0000-0000-000000000001', accountId: '00000000-0000-0000-0000-000000000002',
  periodKey: 'monthly_fee:2026-10', invoiceNo: 'TEST-202610-0001', kind: 'monthly_fee',
  lines: [{ label: 'Дали — AI хүлээн авагч', amount_mnt: 250000 }], amountMnt: 250000,
  periodStart: '2026-10-01', periodEnd: '2026-10-31', issuedOn: '2026-10-01', dueOn: '2026-10-05',
  isTest: true, status: 'open', paidSumMnt: 0, paidAt: null, qpayInvoiceId: null, qpayCheckedAt: null,
  createdAt: new Date('2026-09-30T16:00:00Z'),
};
const paid: Invoice = { ...invoice, status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-03T04:00:00Z') };

const SUBJECT: Record<MailKind, BillingBlockKey> = {
  invoice: 'billing_invoice_subject',
  reminder_before: 'billing_reminder_before_subject',
  reminder_after: 'billing_reminder_after_subject',
  receipt: 'billing_receipt_subject',
};

const period = render(wording, 'billing_period_month', { year: '2026', month: '10' });
mkdirSync(out, { recursive: true });
let failed = false;
for (const kind of ['invoice', 'reminder_before', 'reminder_after', 'receipt'] as const) {
  const inv = kind === 'receipt' ? paid : invoice;
  const values = { client: FAKE_ACCOUNT.displayName, invoice_no: inv.invoiceNo, ...(period.ok ? { period: period.text } : {}) };
  const subject = render(wording, SUBJECT[kind], values);
  const mail = renderMail({
    kind, wording, invoice: inv, account: FAKE_ACCOUNT, issuer: FAKE_ISSUER, payUrl: FAKE_PAY_URL, logoUrl,
    ...(period.ok ? { period: period.text } : {}),
  });
  if (!subject.ok || !mail.ok) {
    process.stderr.write(`${kind}: ${!subject.ok ? subject.why : mail.ok ? '' : mail.why}\n`);
    failed = true;
    continue;
  }
  writeFileSync(`${out}/${kind}.subject.txt`, `${wording.source === 'draft' ? '[TEST] ' : ''}${subject.text}\n`);
  writeFileSync(`${out}/${kind}.html`, mail.html);
  writeFileSync(`${out}/${kind}.txt`, mail.text);
  if (kind !== 'receipt') {
    const pdf = await renderInvoicePdf({ wording, invoice: inv, account: FAKE_ACCOUNT, issuer: FAKE_ISSUER, payUrl: FAKE_PAY_URL });
    if (pdf.ok) writeFileSync(`${out}/${kind}.pdf`, Buffer.from(pdf.base64, 'base64'));
    else { process.stderr.write(`${kind} pdf: ${pdf.why}\n`); failed = true; }
  }
  process.stdout.write(`${kind}: ${subject.text}\n`);
}
process.exit(failed ? 1 : 0);
