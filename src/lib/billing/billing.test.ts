import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { addDays, daysBetween, dottedDay, previousMonth, stageFor, billingToday } from './calendar.ts';
import { actionKindOf, linksFor, parsePayRef, payRef, payRefCode, payRefMatches, signLink, verifyLink } from './links.ts';
import { outlineOf, parseAmount, paymentTime, quickQr, readPaymentCheck } from './qpay.ts';
import { BILLING_BLOCKS, BILLING_BLOCK_KEYS, formatMnt, render, renderLines, type Wording } from './templates.ts';
import { parseStaff, propose, teamDiscountPercent, type Phrases } from './amounts.ts';
import { sendBrevoEmail, sendFounderTelegram, sendResendEmail, textToHtml } from './send.ts';
import { issuerFromEnv, telHref } from './issuer.ts';
import { esc, mailReady, MAIL_KEYS, MAIL_OPTIONAL_KEYS, renderMail } from './mail.ts';
import { renderInvoicePdf } from './pdf.ts';
import { ledgerCsv, retryAt, summaryText, type Account, type Invoice } from './engine.ts';
import { renderPayPage } from './page.ts';
import { runBillingWorkerJob } from './jobs.ts';

const SECRET = 'x'.repeat(40);
const NOW = new Date('2026-10-01T01:00:00Z');

// --- calendar -------------------------------------------------------------------------

test('calendar arithmetic is on the calendar day, across month and year ends', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(daysBetween('2026-10-05', '2026-10-08'), 3);
  assert.equal(daysBetween('2026-10-08', '2026-10-05'), -3);
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-10'), '2026-09');
  assert.equal(dottedDay('2026-10-05'), '2026.10.05');
  assert.throws(() => addDays('2026-10-5', 1));
});

test('today is the Ulaanbaatar day: 16:30 UTC on the 30th is already the 1st there', () => {
  assert.equal(billingToday(new Date('2026-09-30T16:30:00Z')), '2026-10-01');
  assert.equal(billingToday(new Date('2026-09-30T15:59:00Z')), '2026-09-30');
});

test("the founder's rhythm for a fee issued on the 1st and due on the 5th", () => {
  const inv = { status: 'open', issuedOn: '2026-10-01', dueOn: '2026-10-05' };
  const at = (d: string) => stageFor(inv, `2026-10-${d}`);
  assert.deepEqual([at('01').reminderBefore, at('02').reminderBefore, at('03').reminderBefore, at('05').reminderBefore], [false, false, true, true]);
  assert.deepEqual([at('05').reminderAfter, at('06').reminderAfter, at('12').reminderAfter, at('13').reminderAfter], [false, true, true, false]);
  // Contract 4.9: a pause only when MORE than 7 days late — the 13th for a fee due on the 5th.
  assert.deepEqual([at('08').pauseAsk, at('12').pauseAsk, at('13').pauseAsk, at('20').pauseAsk], [false, false, true, true]);
  assert.equal(at('13').daysLate, 8);
  // Paid, mismatched or withdrawn: nothing.
  for (const status of ['paid', 'mismatch', 'void']) {
    const s = stageFor({ ...inv, status }, '2026-10-08');
    assert.deepEqual([s.reminderBefore, s.reminderAfter, s.pauseAsk], [false, false, false]);
  }
});

test('an invoice first seen already late gets the one message that fits today, not every one it missed', () => {
  const s = stageFor({ status: 'open', issuedOn: '2026-10-07', dueOn: '2026-10-07' }, '2026-10-07');
  assert.deepEqual([s.reminderBefore, s.reminderAfter, s.pauseAsk], [false, false, false]);
  const t = stageFor({ status: 'open', issuedOn: '2026-09-01', dueOn: '2026-09-05' }, '2026-09-28');
  assert.deepEqual([t.reminderBefore, t.reminderAfter, t.pauseAsk], [false, false, true]);
});

// --- links ----------------------------------------------------------------------------

const INV = '11111111-2222-4333-8444-555555555555';
const ACC = '66666666-7777-4888-8999-aaaaaaaaaaaa';

test('a link opens only what it was signed for', () => {
  const t = signLink(SECRET, { k: 'pay', id: INV, exp: 0 });
  assert.deepEqual(verifyLink(SECRET, t, 'pay', NOW), { k: 'pay', id: INV, exp: 0 });
  assert.equal(verifyLink(SECRET, t, 'callback', NOW), null, 'a pay link is not a callback');
  assert.equal(verifyLink('y'.repeat(40), t, 'pay', NOW), null, 'another secret');
  const [p, m] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ k: 'pay', id: ACC, exp: 0 })).toString('base64url');
  assert.equal(verifyLink(SECRET, `${forged}.${m}`, 'pay', NOW), null, 'a payload swapped under the same mac');
  assert.equal(verifyLink(SECRET, `${p}.${m}x`, 'pay', NOW), null);
  assert.equal(verifyLink(SECRET, 'garbage', 'pay', NOW), null);
  assert.throws(() => signLink('short', { k: 'pay', id: INV, exp: 0 }));
});

test('a pause link expires, and its kind is read only to choose what to verify it as', () => {
  const links = linksFor('https://dala.example.com/', SECRET);
  const url = links.action('pause', ACC, INV, NOW);
  assert.ok(url.startsWith('https://dala.example.com/billing/action?t='));
  const token = new URL(url).searchParams.get('t') ?? '';
  assert.equal(actionKindOf(token), 'pause');
  assert.deepEqual(verifyLink(SECRET, token, 'pause', NOW)?.inv, INV);
  assert.equal(verifyLink(SECRET, token, 'resume', NOW), null);
  assert.equal(verifyLink(SECRET, token, 'pause', new Date(NOW.getTime() + 15 * 86_400_000)), null, 'expired after 14 days');
  assert.match(links.pay(INV, 'DT-202610-0001'), /^https:\/\/dala\.example\.com\/pay\/DT-202610-0001-[0-9A-HJKMNP-TV-Z]{6}$/u);
  assert.ok(links.callback(INV).startsWith('https://dala.example.com/api/billing/qpay?t='));
});

// --- QPay -----------------------------------------------------------------------------

test('a QPay payment is recorded only when every settled row names its id and amount', () => {
  const ok = readPaymentCheck({ rows: [
    { payment_id: 'P1', payment_status: 'PAID', payment_amount: '100.00', payment_date: '2026-10-03T05:00:00Z' },
    { payment_id: 'P0', payment_status: 'NEW', payment_amount: '100' },
  ] }, 'Q1', NOW);
  // The NEW row is a payment still in flight: its code is asked about again, never closed on this.
  assert.deepEqual(ok, { ok: true, determined: true, invoiceStatus: null, pending: true, payments: [{ key: 'qpay:P1', amountMnt: 100, paidAt: new Date('2026-10-03T05:00:00Z') }] });

  const noId = readPaymentCheck({ rows: [{ payment_status: 'PAID', payment_amount: 100 }] }, 'Q1', NOW);
  assert.equal(noId.ok && !noId.determined && noId.reason, 'a settled payment has no payment_id');
  const noAmount = readPaymentCheck({ rows: [{ payment_id: 'P1', payment_status: 'PAID', payment_amount: '' }] }, 'Q1', NOW);
  assert.ok(noAmount.ok && !noAmount.determined);
  const zero = readPaymentCheck({ rows: [{ payment_id: 'P1', payment_status: 'PAID', payment_amount: '0' }] }, 'Q1', NOW);
  assert.ok(zero.ok && !zero.determined, 'a settled 0 is contradictory, not a payment of nothing');
  const odd = readPaymentCheck({ rows: [{ payment_id: 'P1', payment_status: 'PARTIAL', payment_amount: 50 }] }, 'Q1', NOW);
  assert.ok(odd.ok && !odd.determined, 'an unknown status is not evidence');
  // `payments` when `rows` is empty.
  const legacy = readPaymentCheck({ rows: [], payments: [{ payment_id: 7, status: 'SUCCESS', amount: '1,000' }] }, 'Q1', NOW);
  assert.ok(legacy.ok && legacy.determined && legacy.payments[0]?.key === 'qpay:7' && legacy.payments[0]?.amountMnt === 1000);
  // Paid with no rows: undetermined, never a made-up key the real payment id would double.
  const bare = readPaymentCheck({ invoice_status: 'PAID', paid_amount: 100 }, 'Q1', NOW);
  assert.ok(bare.ok && !bare.determined);
  const blind = readPaymentCheck({ invoice_status: 'PAID' }, 'Q1', NOW);
  assert.ok(blind.ok && !blind.determined);
  // Nothing yet.
  const none = readPaymentCheck({ count: 0, rows: [] }, 'Q1', NOW);
  assert.ok(none.ok && none.determined && none.payments.length === 0);
  assert.equal(parseAmount(' 250,000 '), 250000);
  // A time without a zone is Ulaanbaatar's, never the machine's: 23:30 on the 31st stays October.
  assert.equal(paymentTime('2026-10-31 23:30:00')?.toISOString(), '2026-10-31T15:30:00.000Z');
  assert.equal(paymentTime('2026-10-31T23:30')?.toISOString(), '2026-10-31T15:30:00.000Z');
  assert.equal(paymentTime('2026-10-31T15:30:00Z')?.toISOString(), '2026-10-31T15:30:00.000Z');
  assert.equal(paymentTime('2026-10-31T23:30:00+08:00')?.toISOString(), '2026-10-31T15:30:00.000Z');
  assert.equal(paymentTime('yesterday'), null);
  const zoned = readPaymentCheck({ rows: [{ payment_id: 'P9', payment_status: 'PAID', payment_amount: 5, payment_date: '2026-10-31 23:30:00' }] }, 'Q1', NOW);
  assert.ok(zoned.ok && zoned.determined && zoned.payments[0]?.paidAt.toISOString() === '2026-10-31T15:30:00.000Z');
  assert.equal(parseAmount(1.5), null);
});

/**
 * QPay Quick QR's real /payment/check answer for the first real payment (TEST-202609-0001,
 * 100₮, 2026-09-28), rebuilt from the outline production logged (billing.qpay_undetermined):
 * the same keys, types, lengths and QPay words; the identifying values are invented.
 */
const REAL_QUICK_QR_ANSWER = (invoiceId: string) => ({
  id: invoiceId,
  invoice_status: 'PAID',
  invoice_status_date: '2026-09-28T03:02:41.000Z',
  payments: [{
    amount: '100.00',
    currency: 'MNT',
    ebarimt_customer_no: null,
    id: '100000000000001',
    note: null,
    paid_by: 'P2P',
    payment_description: 'DalaTech TEST-202609-0001',
    payment_name: 'Нэхэмжлэл',
    payment_status: 'SUCCESS',
    payment_status_date: '2026-09-28T03:02:41.000Z',
    terminal_id: 'DALATECH_AI',
    transactions: [{}],
    wallet_customer_id: 'f0e1d2c3-0000-4000-8000-000000000001',
  }],
});

test('QPay Quick QR\'s real answer is read: the payment is recorded under its own id, once', () => {
  const inv = 'a1b2c3d4-2222-4333-8444-555555555555';
  const real = REAL_QUICK_QR_ANSWER(inv);
  // The outline of the rebuilt answer is the outline production logged, byte for byte.
  assert.equal(outlineOf(real), '{id: string(36 digits+latin+other), invoice_status: "PAID", invoice_status_date: string(24 digits+latin+other), '
    + 'payments: [{amount: string "100.00", currency: "MNT", ebarimt_customer_no: null, id: string(15 digits), note: null, '
    + 'paid_by: string(3 digits+latin), payment_description: string(25 digits+latin+other), payment_name: string(9 other), '
    + 'payment_status: "SUCCESS", payment_status_date: string(24 digits+latin+other), terminal_id: string(11 latin+other), '
    + 'transactions: [object], wallet_customer_id: string(36 digits+latin+other)}]}');
  assert.deepEqual(readPaymentCheck(real, inv, NOW), {
    ok: true, determined: true, invoiceStatus: 'PAID', pending: false,
    payments: [{ key: 'qpay:100000000000001', amountMnt: 100, paidAt: new Date('2026-09-28T03:02:41.000Z') }],
  });
  // Every safety stays: an answer about another invoice, a payment in another currency, two
  // disagreeing ids, no id, or no readable amount records nothing.
  const refused = (body: unknown): string => {
    const r = readPaymentCheck(body, inv, NOW);
    assert.ok(r.ok && !r.determined, JSON.stringify(body));
    return r.ok && !r.determined ? r.reason : '';
  };
  const row = real.payments[0] as Record<string, unknown>;
  assert.match(refused({ ...real, id: '99999999-2222-4333-8444-555555555555' }), /another QPay invoice/u);
  assert.match(refused({ ...real, payments: [{ ...row, currency: 'USD' }] }), /not in MNT/u);
  assert.match(refused({ ...real, payments: [{ ...row, payment_id: '100000000000002' }] }), /two different ids/u);
  assert.equal(refused({ ...real, payments: [{ ...row, id: null }] }), 'a settled payment has no payment_id');
  assert.match(refused({ ...real, payments: [{ ...row, amount: '100.50' }] }), /no readable amount/u);
  assert.match(refused({ ...real, invoice_id: '99999999-2222-4333-8444-555555555555' }), /another QPay invoice/u);
  assert.match(refused({ ...real, payments: [{ ...row, payment_currency: 'MNT', currency: 'USD' }] }), /not in MNT/u);
  assert.match(refused({ ...real, payments: [{ ...row, payment_amount: '200' }] }), /two different amounts/u);
  assert.match(refused({ ...real, rows: [{ payment_id: 'P1', payment_status: 'PAID', payment_amount: 100 }] }), /two payment lists/u);
  // The same UUID in another case is the same invoice.
  const upper = readPaymentCheck({ ...real, id: inv.toUpperCase() }, inv, NOW);
  assert.ok(upper.ok && upper.determined && upper.payments.length === 1);
  // Still unpaid: nothing to record, and nothing refused.
  const open = readPaymentCheck({ id: inv, invoice_status: 'OPEN', payments: [] }, inv, NOW);
  assert.ok(open.ok && open.determined && open.payments.length === 0);
});

const QCFG = { username: 'u', password: 'p', terminalId: 'T', merchantId: 'M', bankCode: '050000', bankAccount: 'A', accountName: 'N' };

function fakeFetch(responses: Array<Response | Error>, seen: Array<{ url: string; body: unknown }> = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (next === undefined) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

test('creating a QPay invoice: refused, unknown and ok are three different answers', async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const q = quickQr(QCFG, fakeFetch([
    new Response('{}', { status: 400 }),
    new Error('timeout'),
    new Response('{}', { status: 502 }),
    new Response(JSON.stringify({ qr_text: 'x' }), { status: 200 }),
    new Response(JSON.stringify({ id: 'Q1', invoice_id: 'Q2' }), { status: 200 }),
    new Response(JSON.stringify({ invoice_id: 'Q1', qr_text: 'QRT', qr_image: 'AAAA', urls: [{ name: 'Khan', link: 'khanbank://q' }, { name: 'bad' }] }), { status: 200 }),
  ], seen));
  const input = { amountMnt: 100, description: 'DalaTech TEST-1', callbackUrl: 'https://d.example/api/billing/qpay?t=x' };
  assert.equal((await q.createInvoice('t', input) as { outcome: string }).outcome, 'refused');
  assert.equal((await q.createInvoice('t', input) as { outcome: string }).outcome, 'unknown');
  assert.equal((await q.createInvoice('t', input) as { outcome: string }).outcome, 'unknown', '5xx: it may have been made');
  assert.equal((await q.createInvoice('t', input) as { outcome: string }).outcome, 'unknown', '2xx with no id: made, and unnamed');
  assert.equal((await q.createInvoice('t', input) as { outcome: string }).outcome, 'unknown', 'two different ids');
  const made = await q.createInvoice('t', input);
  assert.ok(made.ok && made.invoiceId === 'Q1' && made.qrText === 'QRT' && made.urls.length === 1);
  const body = seen[0]?.body as Record<string, unknown>;
  assert.equal(body['callback_url'], input.callbackUrl);
  assert.equal(body['amount'], 100);
  assert.equal(body['description'], 'DalaTech TEST-1');
});

// --- wording --------------------------------------------------------------------------

const w = (entries: Record<string, string>): Wording => ({ source: 'signed', blocks: new Map(Object.entries(entries)) });

test('a block renders only with exactly its placeholders', () => {
  assert.deepEqual(render(w({}), 'billing_invoice_subject', { invoice_no: 'DT-1' }), { ok: false, why: 'billing_invoice_subject is not signed' });
  assert.equal(render(w({ billing_invoice_subject: 'Нэхэмжлэх {invoice_no} {amount}' }), 'billing_invoice_subject', { invoice_no: 'DT-1', amount: '1₮' }).ok, false, 'an unknown name');
  assert.equal(render(w({ billing_invoice_subject: 'Нэхэмжлэх' }), 'billing_invoice_subject', {}).ok, false, 'a required name missing');
  const r = render(w({ billing_invoice_subject: 'Нэхэмжлэх {invoice_no} $& {period}' }), 'billing_invoice_subject', { invoice_no: 'DT-1', period: '10-р сарын' });
  assert.deepEqual(r, { ok: true, text: 'Нэхэмжлэх DT-1 $& 10-р сарын' });
  assert.equal(render(w({ billing_invoice_subject: '{invoice_no} {period}' }), 'billing_invoice_subject', { invoice_no: 'DT-1' }).ok, false, 'an optional name used without a value');
});

test('amounts are written as the price rows write them', () => {
  assert.equal(formatMnt(250000), '250,000₮');
  assert.equal(formatMnt(100), '100₮');
  assert.equal(formatMnt(1234567), '1,234,567₮');
  assert.equal(formatMnt(-40000), '−40,000₮');
  assert.throws(() => formatMnt(1.5));
  assert.equal(renderLines([{ label: 'Дали', amount_mnt: 250000 }, { label: 'Хөнгөлөлт', amount_mnt: -25000 }]), '• Дали: 250,000₮\n• Хөнгөлөлт: −25,000₮');
});

/** The drafts (or, once signed, the platform files) — every key exactly once, every one renderable. */
function wordingOnDisk(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ['prompt/drafts/billing', 'prompt/platform']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.startsWith('billing_') && x.endsWith('.mn.txt'))) {
      const key = f.slice(0, -'.mn.txt'.length);
      assert.ok(!out.has(key), `${key} is both a draft and signed`);
      out.set(key, readFileSync(`${dir}/${f}`, 'utf8').trim());
    }
  }
  return out;
}

test('DONE-TEST: every billing block exists on disk, is NFC, and renders with its placeholders', () => {
  const blocks = wordingOnDisk();
  assert.deepEqual([...blocks.keys()].sort(), [...BILLING_BLOCK_KEYS].sort());
  const values: Record<string, string> = {
    client: 'Туршилт ХХК', invoice_no: 'TEST-202610-0001', amount: '100₮', lines: '• Туршилт: 100₮', due_date: '2026.10.05',
    pay_link: 'https://dala.example.com/pay/x', period: '2026 оны 10-р сарын', paid_date: '2026.10.03', year: '2026', month: '10',
    start: '2026.11.01', end: '2027.10.31', label: 'Дали', months: '12', count: '2', percent: '10', time: '4:59', phone: '9911 2233',
  };
  for (const key of BILLING_BLOCK_KEYS) {
    const body = blocks.get(key) as string;
    assert.equal(body, body.normalize('NFC'), key);
    const r = render({ source: 'draft', blocks }, key, values);
    assert.ok(r.ok, `${key}: ${r.ok ? '' : r.why}`);
    assert.doesNotMatch(r.ok ? r.text : '', /\{[^{}\s]+\}/u, `${key} left a placeholder`);
  }
  assert.equal(Object.keys(BILLING_BLOCKS).length, 68);
});

// --- amounts --------------------------------------------------------------------------

const PHRASES: Phrases = {
  months: (label, n) => `${label} × ${n}`,
  teamDiscount: (c, p) => `team ${c} ${p}%`,
  annualFree: (n) => `free ${n}`,
};

test('the contract: multi-staff discount, annual prepay, and the most favourable one only', () => {
  assert.deepEqual([1, 2, 3, 4, 7].map(teamDiscountPercent), [0, 10, 15, 20, 20]);
  const one = propose([{ label: 'Дали', monthlyMnt: 250000 }], { annual: false }, PHRASES);
  assert.equal(one.amountMnt, 250000);
  assert.equal(one.lines.length, 1);

  const two = propose([{ label: 'Дали', monthlyMnt: 250000 }, { label: 'Нова', monthlyMnt: 150000 }], { annual: false }, PHRASES);
  assert.equal(two.amountMnt, 360000);
  assert.deepEqual(two.lines.at(-1), { label: 'team 2 10%', amount_mnt: -40000 });
  assert.equal(two.lines.reduce((s, l) => s + l.amount_mnt, 0), two.amountMnt);

  const yearOne = propose([{ label: 'Дали', monthlyMnt: 250000 }], { annual: true }, PHRASES);
  assert.equal(yearOne.amountMnt, 2500000, '12 months for 10');
  assert.equal(yearOne.kind, 'annual_prepay');

  const four = [250000, 150000, 350000, 250000].map((m, i) => ({ label: `S${i}`, monthlyMnt: m }));
  const yearFour = propose(four, { annual: true }, PHRASES);
  assert.equal(yearFour.amountMnt, 9600000, '12 months at 20% off (9.6 months) beats 10 months (10,000,000)');
  assert.equal(yearFour.lines.reduce((s, l) => s + l.amount_mnt, 0), yearFour.amountMnt);

  const yearTwo = propose(four.slice(0, 2), { annual: true }, PHRASES);
  assert.equal(yearTwo.amountMnt, 4000000, '10 months (4,000,000) beats 12 at 10% off (4,320,000)');
  assert.throws(() => propose([], { annual: false }, PHRASES));
});

test('the command-line form of a staff price', () => {
  assert.deepEqual(parseStaff('Дали — AI хүлээн авагч=250,000'), { label: 'Дали — AI хүлээн авагч', monthlyMnt: 250000 });
  assert.deepEqual(parseStaff('A=B=100'), { label: 'A=B', monthlyMnt: 100 });
  assert.throws(() => parseStaff('Дали'));
  assert.throws(() => parseStaff('Дали=2.5'));
});

// --- sending --------------------------------------------------------------------------

test('e-mail: accepted, retried, refused and unknown are told apart; Reply-To is the founder', async () => {
  process.env['BREVO_API_KEY'] = 'k';
  process.env['BILLING_FOUNDER_EMAIL'] = 'founder@example.com';
  const seen: Array<{ url: string; body: unknown }> = [];
  const f = fakeFetch([
    new Response(JSON.stringify({ messageId: '<m1>' }), { status: 201 }),
    new Response('{}', { status: 503 }),
    new Response('{}', { status: 400 }),
    new Error('aborted'),
  ], seen);
  const msg = { to: 'c@example.mn', subject: 's', text: 'a <b>\nhttps://x.example/pay/1' };
  assert.deepEqual(await sendBrevoEmail(msg, f), { outcome: 'sent', providerMessageId: '<m1>' });
  assert.equal((await sendBrevoEmail(msg, f)).outcome, 'retry');
  assert.equal((await sendBrevoEmail(msg, f)).outcome, 'terminal');
  assert.equal((await sendBrevoEmail(msg, f)).outcome, 'unknown');
  const body = seen[0]?.body as Record<string, unknown>;
  assert.deepEqual(body['replyTo'], { email: 'founder@example.com' });
  assert.deepEqual(body['sender'], { name: 'DalaTech', email: 'hello@dalatech.online' });
  assert.match(String(body['htmlContent']), /a &lt;b&gt;<br><a href="https:\/\/x\.example\/pay\/1">/);
  delete process.env['BREVO_API_KEY'];
  delete process.env['BILLING_FOUNDER_EMAIL'];
  assert.equal(textToHtml('<script>').includes('<script>'), false);
});

test('Telegram carries the pause button as a URL button, never a callback', async () => {
  process.env['TELEGRAM_BOT_TOKEN'] = '1:x';
  process.env['TELEGRAM_ALERT_CHAT_ID'] = '-1';
  const seen: Array<{ url: string; body: unknown }> = [];
  const r = await sendFounderTelegram({ text: 'hi', button: { label: 'Pause', url: 'https://d.example/billing/action?t=1' } },
    fakeFetch([new Response(JSON.stringify({ result: { message_id: 9 } }), { status: 200 })], seen));
  assert.deepEqual(r, { outcome: 'sent', providerMessageId: '9' });
  assert.deepEqual((seen[0]?.body as Record<string, unknown>)['reply_markup'], { inline_keyboard: [[{ text: 'Pause', url: 'https://d.example/billing/action?t=1' }]] });
  delete process.env['TELEGRAM_BOT_TOKEN'];
  delete process.env['TELEGRAM_ALERT_CHAT_ID'];
});

// --- engine pieces --------------------------------------------------------------------

function invoice(over: Partial<Invoice>): Invoice {
  return {
    id: INV, accountId: ACC, periodKey: 'monthly_fee:2026-10', invoiceNo: 'DT-202610-0001', kind: 'monthly_fee',
    lines: [{ label: 'Дали', amount_mnt: 250000 }], amountMnt: 250000, periodStart: '2026-10-01', periodEnd: '2026-10-31',
    issuedOn: '2026-10-01', dueOn: '2026-10-05', isTest: false, status: 'open', paidSumMnt: 0, paidAt: null,
    qpayInvoiceId: 'Q1', qpayCheckedAt: null, createdAt: NOW, ...over,
  };
}
const account: Account = { id: ACC, tenantId: 'tenant', displayName: 'Матрикс ХХК', email: 'm@example.mn', isTest: false, contractRef: null };

test("the founder's summary: who paid, who has not, and what is outstanding", () => {
  const text = summaryText({
    month: '2026-10', today: '2026-10-06', mode: 'live', accounts: new Map([[ACC, account]]),
    invoices: [
      invoice({ status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-03T02:00:00Z'), invoiceNo: 'DT-1' }),
      invoice({ invoiceNo: 'DT-2' }),
      invoice({ status: 'mismatch', paidSumMnt: 200000, invoiceNo: 'DT-3' }),
      invoice({ status: 'paid', issuedOn: '2026-09-01', invoiceNo: 'DT-OLD' }),
    ],
  });
  assert.match(text, /Paid \(1\):\n• Матрикс ХХК — DT-1 — 250,000₮ — 2026\.10\.03/);
  assert.match(text, /Not paid \(1\):\n• Матрикс ХХК — DT-2 — 250,000₮ — 1 day\(s\) late/);
  assert.match(text, /paid 200,000₮ of 250,000₮/);
  assert.match(text, /Outstanding: 300,000₮ across 2 invoice\(s\)\./);
  assert.doesNotMatch(text, /DT-OLD/);
});

test('the ledger CSV quotes every field', () => {
  const csv = ledgerCsv([{ paidAtUb: '2026-10-03 10:00', invoiceNo: 'DT-1', client: 'A, "B" ХХК', source: 'qpay', paymentKey: 'qpay:P1', amountMnt: 100, invoiceAmountMnt: 100, invoiceStatus: 'paid' }]);
  assert.equal(csv.split('\r\n')[1], '"2026-10-03 10:00","DT-1","A, ""B"" ХХК","qpay","qpay:P1","100","100","paid"');
});

test('a definite failure is retried with a growing delay, then given up', () => {
  assert.equal(retryAt(NOW, 1)?.getTime(), NOW.getTime() + 5 * 60_000);
  assert.equal(retryAt(NOW, 7)?.getTime(), NOW.getTime() + 1440 * 60_000);
  assert.equal(retryAt(NOW, 8), null);
});

// --- the pay page ---------------------------------------------------------------------

test('the pay page: a live invoice with unsigned wording is a 503, a test one is English under a banner', () => {
  const view = { kind: 'code' as const, invoice: invoice({}), account, qrImage: 'iVBORw0KGgo=', secondsLeft: 299,
    urls: [{ name: 'Khan', logo: 'https://qpay.mn/k.png', link: 'khanbank://q?x=1' }, { name: 'evil', logo: '', link: 'javascript:alert(1)' }] };
  assert.equal(renderPayPage(view, w({})).status, 503);
  const test = renderPayPage({ ...view, invoice: invoice({ isTest: true }) }, w({}));
  assert.equal(test.status, 200);
  assert.match(test.html, /TEST — some of this page's Mongolian is not signed/);
  assert.match(test.html, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(test.html, /khanbank:\/\/q\?x=1/);
  assert.doesNotMatch(test.html, /javascript:/);
});

test('the pay page escapes the client name and hides the QR once paid', () => {
  const blocks = wordingOnDisk();
  const evil = { ...account, displayName: '<img src=x onerror=alert(1)>' };
  const paid = renderPayPage({ kind: 'settled', invoice: invoice({ status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-03T20:00:00Z') }), account: evil }, { source: 'signed', blocks });
  assert.equal(paid.status, 200);
  assert.doesNotMatch(paid.html, /<img src=x/);
  assert.doesNotMatch(paid.html, /data:image/);
  assert.doesNotMatch(paid.html, /Шинэ QR код авах/);
  // 20:00 UTC on the 3rd is the 4th in Ulaanbaatar.
  assert.match(paid.html, /2026\.10\.04/);
});

test('the pay page (0068): a live code counts down in Tara\'s words; at zero, the new-code button', () => {
  const blocks = wordingOnDisk();
  const signed: Wording = { source: 'signed', blocks };
  const live = renderPayPage({ kind: 'code', invoice: invoice({}), account, qrImage: 'iVBORw0KGgo=', urls: [], secondsLeft: 299.6 }, signed);
  assert.equal(live.status, 200);
  // The three lines approved for Tara, word for word.
  assert.match(live.html, /<p class="countdown" id="qr-countdown">QR код 4:59 хүчинтэй<\/p>/);
  assert.match(live.html, /QR кодын хугацаа дууслаа\. Шинэ QR код авах бол доорх товчийг дарна уу\./);
  assert.match(live.html, /<form method="post"><button class="renew" type="submit">Шинэ QR код авах<\/button><\/form>/);
  // The expired part is there, hidden until the countdown ends; the script counts from the
  // server's seconds, not the phone's clock, and polls the invoice's state.
  assert.match(live.html, /id="qr-expired" style="display:none"/);
  assert.match(live.html, /"QR код \{time\} хүчинтэй",end=Date\.now\(\)\+299\*1000/);
  assert.match(live.html, /\?state=1/);
  // No code (the hourly cap): its own line (a draft), the button, no QR, no countdown.
  const none = renderPayPage({ kind: 'no_code', invoice: invoice({}), account }, signed);
  assert.doesNotMatch(none.html, /data:image/);
  assert.doesNotMatch(none.html, /qr-countdown/);
  assert.match(none.html, /Уучлаарай, та олон удаа QR код авсан байна\. Хэдэн минут хүлээгээд доорх товчийг дахин дарна уу\./);
  assert.doesNotMatch(none.html, /QR кодын хугацаа дууслаа/);
  assert.match(none.html, /Шинэ QR код авах/);
  // A code already at zero is never drawn.
  const zero = renderPayPage({ kind: 'code', invoice: invoice({}), account, qrImage: 'iVBORw0KGgo=', urls: [], secondsLeft: 0 }, signed);
  assert.doesNotMatch(zero.html, /data:image/);
  // A mismatch (with the founder) offers no code at all.
  const other = renderPayPage({ kind: 'settled', invoice: invoice({ status: 'mismatch' }), account }, signed);
  assert.doesNotMatch(other.html, /Шинэ QR код авах|data:image/);
  // Nothing from the wording can close the script.
  const hostile: Wording = { source: 'signed', blocks: new Map([...blocks, ['billing_page_qr_valid', '</script><script>alert(1)</script> {time}']]) };
  assert.doesNotMatch(renderPayPage({ kind: 'code', invoice: invoice({}), account, qrImage: 'AA==', urls: [], secondsLeft: 60 }, hostile).html, /<\/script><script>alert/);
});

// --- the worker ------------------------------------------------------------------------

test('the worker: unsigned is 401, off does nothing, a mistyped switch refuses', async () => {
  const base = { db: () => { throw new Error('no db in this test'); }, now: NOW, rawBody: '', signature: 's' };
  assert.equal((await runBillingWorkerJob({ ...base, verifySignature: async () => false })).status, 401);
  delete process.env['BILLING_MODE'];
  assert.deepEqual(await runBillingWorkerJob({ ...base, verifySignature: async () => true }), { status: 200, body: { disabled: true } });
  process.env['BILLING_MODE'] = 'LIVE';
  assert.equal((await runBillingWorkerJob({ ...base, verifySignature: async () => true })).status, 503);
  process.env['BILLING_MODE'] = 'test';
  // Configured on, but the QPay variables are absent: 503, never a half-run.
  assert.equal((await runBillingWorkerJob({ ...base, db: () => ({ from: () => { throw new Error('x'); } }) as never, verifySignature: async () => true })).status, 503);
  delete process.env['BILLING_MODE'];
});

test('outlineOf: the shape of a QPay answer, with no payer data in it', () => {
  const body = {
    count: 1, paid_amount: 100,
    rows: [{ payment_status: 'PAID', payment_amount: '100.00', payment_currency: 'MNT',
      payer_name: 'Бат-Эрдэнэ', account_number: '5016271526', phone: '+976 99112233', note: null, ok: true }],
  };
  const o = outlineOf(body);
  assert.equal(o, '{count: number 1, paid_amount: number 100, rows: [{account_number: string(10 digits), '
    + 'note: null, ok: boolean true, payer_name: string(10 other), payment_amount: string "100.00", '
    + 'payment_currency: "MNT", payment_status: "PAID", phone: string(13 digits+other)}]}');
  for (const secret of ['Бат', '5016271526', '99112233']) assert.ok(!o.includes(secret), secret);
  // "count" inside "account" is not a count: account numbers never pass as amounts.
  const accounts = outlineOf({ bank_account: 5016271526, payer_account: '5016271526', discount: '99112233',
    payer_accounts: ['5016271526'], customer_phone_count: 99112233 });
  for (const secret of ['5016271526']) assert.ok(!accounts.includes(secret), accounts);
  assert.match(accounts, /customer_phone_count: number 99112233/); // a real *_count field: shown
  // Only QPay's own words are shown as they are; a Latin name under a status/method key is not.
  assert.equal(outlineOf({ payer_type: 'Bold_Bat', payment_method: 'BATERDENE', status: 'Paid by Bat 99112233' }),
    '{payer_type: string(8 latin+other), payment_method: string(9 latin), status: string(20 digits+latin+other)}');
  // A map keyed by data shows its keys by length only, and is cut at forty keys.
  assert.equal(outlineOf({ '99112233': { 'Бат-Эрдэнэ': 1 } }), '{<key 8>: {<key 10>: number}}');
  assert.equal(outlineOf({ MN120005005016271526: 1, acct_5016271526: 2 }), '{<key 20>: number, <key 15>: number}');
  const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, i]));
  assert.match(outlineOf(many), /…5 more\}$/);
  // Arrays are cut at five items; depth at four.
  assert.match(outlineOf({ rows: [1, 2, 3, 4, 5, 6, 7] }), /…2 more/);
  assert.equal(outlineOf({ a: { b: { c: { d: { e: 1 } } } } }), '{a: {b: {c: {d: object}}}}');
});

test('readPaymentCheck: an unknown status reaches the reason as QPay word or outline, never as free text', () => {
  const r = readPaymentCheck({ rows: [{ payment_status: 'Paid by Bat 99112233', payment_id: 'x', payment_amount: 100 }] }, 'inv', new Date());
  assert.ok(r.ok && !r.determined);
  assert.ok(!r.reason.includes('99112233') && !r.reason.includes('BAT'), r.reason);
  const closed = readPaymentCheck({ rows: [{ payment_status: 'CLOSED', payment_id: 'x', payment_amount: 100 }] }, 'inv', new Date());
  assert.ok(closed.ok && !closed.determined && closed.reason === 'a payment row has status "CLOSED"');
});

test('checkPayment: an unreadable answer carries its outline for the log', async () => {
  const port = quickQr({ username: 'u', password: 'p', terminalId: 't', merchantId: 'm', bankCode: 'b', bankAccount: 'a', accountName: 'n' },
    (async () => new Response(JSON.stringify({ count: 1, rows: [{ payment_status: 'PAID', payment_amount: 100 }] }), { status: 200 })) as typeof fetch);
  const check = await port.checkPayment('tok', 'inv');
  assert.ok(check.ok && !check.determined);
  assert.equal(check.outline, '{count: number 1, rows: [{payment_amount: number 100, payment_status: "PAID"}]}');
});

// --- 0070: the short pay address ------------------------------------------------------

test('the short pay address: the invoice number and six unguessable characters, readable aloud', () => {
  const code = payRefCode(SECRET, INV);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{6}$/u, 'Crockford: no I, L, O or U');
  assert.equal(payRefCode(SECRET, INV), code, 'recomputed, never stored');
  assert.notEqual(payRefCode(SECRET, '22222222-2222-4222-8222-222222222222'), code);
  assert.notEqual(payRefCode('y'.repeat(40), INV), code, 'rotating the secret changes every address');
  const ref = payRef(SECRET, INV, 'DT-202610-0001');
  assert.deepEqual(parsePayRef(ref), { invoiceNo: 'DT-202610-0001', code });
  assert.deepEqual(parsePayRef(ref.toLowerCase()), { invoiceNo: 'DT-202610-0001', code }, 'typed in lower case');
  assert.equal(payRefMatches(SECRET, INV, code.toLowerCase()), true);
  assert.equal(payRefMatches(SECRET, INV, 'ZZZZZZ'), false);
  assert.equal(payRefMatches(SECRET, '22222222-2222-4222-8222-222222222222', code), false, 'another invoice with this code');
  for (const bad of ['DT-202610-0001', 'DT-202610-0001-ABCDE', 'XX-202610-0001-ABCDEF', 'DT-202610-0001-ABCDEFG', `${ref}/x`, 'eyJrIjoicGF5In0.abc']) {
    assert.equal(parsePayRef(bad), null, bad);
  }
  assert.equal(linksFor('https://dala.example.com', SECRET, 'https://pay.example.com').pay(INV, 'DT-202610-0001'), `https://pay.example.com/${ref}`);
});

// --- 0070: the issuer's settings -------------------------------------------------------

test('the issuer comes from the environment, checked, never defaulted', () => {
  const ok = { BILLING_ISSUER_NAME: 'Б. Билгүүн', BILLING_ISSUER_PHONE: '+976 9911 2233', BILLING_FOUNDER_EMAIL: 'f@example.com', BILLING_BANK_ACCOUNT: '5000123456', BILLING_BANK_HOLDER: 'Б. Билгүүн' };
  const r = issuerFromEnv(ok);
  assert.ok(r.ok && r.issuer.phone === '+976 9911 2233');
  assert.deepEqual(issuerFromEnv({}), { ok: false, missing: ['BILLING_ISSUER_NAME', 'BILLING_ISSUER_PHONE', 'BILLING_FOUNDER_EMAIL', 'BILLING_BANK_ACCOUNT', 'BILLING_BANK_HOLDER'] });
  assert.deepEqual(issuerFromEnv({ ...ok, BILLING_ISSUER_PHONE: 'call me' }), { ok: false, missing: ['BILLING_ISSUER_PHONE'] });
  assert.deepEqual(issuerFromEnv({ ...ok, BILLING_BANK_ACCOUNT: '12' }), { ok: false, missing: ['BILLING_BANK_ACCOUNT'] });
  assert.equal(telHref('+976 9911-2233'), 'tel:+97699112233');
});

// --- 0070: the branded e-mail and the PDF ---------------------------------------------

const ISSUER = { name: 'Б. Билгүүн', phone: '9911 2233', email: 'f@example.com', bankAccount: '5000123456', bankHolder: 'Б. Билгүүн' };
const PAY_URL = 'https://pay.dalatech.online/DT-202610-0001-K7QM2X';

test('the branded e-mail is sent only once every block is signed and the issuer is set', () => {
  const all: Wording = { source: 'signed', blocks: wordingOnDisk() };
  assert.deepEqual(mailReady(all, { ok: true }), { ok: true });
  const missing = new Map(all.blocks);
  missing.delete('billing_pay_button');
  const r = mailReady({ source: 'signed', blocks: missing }, { ok: true });
  assert.ok(!r.ok && r.why.includes('billing_pay_button'));
  const s = mailReady(all, { ok: false, missing: ['BILLING_BANK_ACCOUNT'] });
  assert.ok(!s.ok && s.why.includes('BILLING_BANK_ACCOUNT'));
  for (const k of MAIL_KEYS) assert.ok(k in BILLING_BLOCKS, `${k} is a billing block`);
});

test('the branded invoice: button to the short address, the table, the bank transfer, a footer — and no unsubscribe', () => {
  const blocks: Wording = { source: 'signed', blocks: wordingOnDisk() };
  const evil = { displayName: '<script>alert(1)</script> ХХК', contractRef: 'DT-2026/014' };
  const r = renderMail({ kind: 'invoice', wording: blocks, invoice: invoice({}), account: evil, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: 'https://dala.example.com/brand/dalatech-wordmark.png' });
  assert.ok(r.ok);
  assert.match(r.html, /<a href="https:\/\/pay\.dalatech\.online\/DT-202610-0001-K7QM2X"[^>]*>Төлбөр төлөх<\/a>/u);
  assert.equal((r.html.match(/>Төлбөр төлөх<\/a>/gu) ?? []).length, 1, 'exactly one pay button');
  assert.ok(r.html.includes(`>${PAY_URL}</a>`), 'the raw address is shown once, as the small fallback line under the button');
  assert.ok(r.html.includes('src="https://dala.example.com/brand/dalatech-wordmark.png"') && r.html.includes('alt="DalaTech"'), 'the wordmark heads the e-mail');
  assert.match(r.html, /<div style="display:none;[^"]*">Нэхэмжлэх[^<]*250,000₮/u, 'a hidden preheader is the inbox line');
  assert.ok(r.html.includes('dalatech.online') && r.html.includes('mailto:hello@dalatech.online'), 'the footer says who sent it');
  assert.ok(r.text.includes('DalaTech · dalatech.online') && r.text.includes('hello@dalatech.online'));
  assert.ok(r.html.includes('5000123456') && r.html.includes('DT-2026/014') && r.html.includes('250,000₮') && r.html.includes('2026.10.05'));
  assert.ok(!r.html.includes('<script>alert') && r.html.includes('&lt;script&gt;'), 'the client name is escaped');
  assert.doesNotMatch(`${r.html}\n${r.text}`, /unsubscribe|эрүүл|<img[^>]+(?:track|pixel)/iu);
  assert.ok(r.text.includes(`Төлбөр төлөх: ${PAY_URL}`) && r.text.includes('Гүйлгээний утга: DT-202610-0001') && r.text.includes('Б. Билгүүн'));
  assert.ok(!r.text.includes('[TEST'), 'signed wording carries no draft mark');
  const receipt = renderMail({ kind: 'receipt', wording: blocks, invoice: invoice({ status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-03T04:00:00Z') }), account: evil, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: '' });
  assert.ok(receipt.ok && !receipt.html.includes('Төлбөр төлөх</a>') && !receipt.html.includes('Банкаар шилжүүлэх'), 'a receipt has no button and no bank box');
  assert.ok(receipt.ok && !receipt.text.includes(PAY_URL) && receipt.text.includes('2026.10.03') && receipt.text.includes('НӨАТ'));
  const draft = renderMail({ kind: 'reminder_after', wording: { ...blocks, source: 'draft' }, invoice: invoice({}), account: evil, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: '' });
  assert.ok(draft.ok && draft.text.startsWith('[TEST — unsigned draft wording]') && draft.html.includes('TEST — unsigned draft wording'));
  const broken = new Map(blocks.blocks);
  broken.set('billing_mail_closing', 'Асуух зүйл: {nope}');
  const refused = renderMail({ kind: 'invoice', wording: { source: 'signed', blocks: broken }, invoice: invoice({}), account: evil, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: '' });
  assert.ok(!refused.ok && refused.why.includes('{nope}'));
});

test('Ора\'s layout: the unsigned footer and fallback lines are left out, never refused; signed, they show', () => {
  const all = wordingOnDisk();
  const without = new Map(all);
  for (const k of MAIL_OPTIONAL_KEYS) without.delete(k);
  const args = { kind: 'invoice' as const, invoice: invoice({}), account: { displayName: 'Матрикс ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: 'https://dala.example.com/brand/dalatech-wordmark.png' };
  const bare = renderMail({ ...args, wording: { source: 'signed', blocks: without } });
  assert.ok(bare.ok, bare.ok ? '' : bare.why);
  for (const k of MAIL_OPTIONAL_KEYS) {
    const line = all.get(k) as string;
    assert.ok(!bare.html.includes(esc(line)) && !bare.text.includes(line), `${k} is left out while unsigned`);
  }
  assert.ok(bare.html.includes(`>${PAY_URL}</a>`) && bare.text.includes('DalaTech · dalatech.online · hello@dalatech.online'), 'the raw link and the sender still show');
  assert.deepEqual(mailReady({ source: 'signed', blocks: without }, { ok: true }), { ok: true }, 'the optional lines never hold the branded e-mail back');
  const full = renderMail({ ...args, wording: { source: 'signed', blocks: all } });
  assert.ok(full.ok);
  for (const k of MAIL_OPTIONAL_KEYS) assert.ok(full.html.includes(esc(all.get(k) as string)), `${k} shows once signed`);
  const broken = new Map(all);
  broken.set('billing_mail_footer_why', 'DalaTech {nope}');
  const refused = renderMail({ ...args, wording: { source: 'signed', blocks: broken } });
  assert.ok(!refused.ok && refused.why.includes('{nope}'), 'a signed optional line that breaks its placeholders refuses like any block');
  // Built like Ора's: one layout table, inline styles, a dark-mode stylesheet, no remote font or script.
  assert.ok(full.html.includes('prefers-color-scheme: dark') && full.html.includes('max-width:560px'));
  assert.doesNotMatch(full.html, /fonts\.googleapis|<script|<link /u);
  // Without an https mark the name is written instead of a broken image.
  const noLogo = renderMail({ ...args, logoUrl: '', wording: { source: 'signed', blocks: all } });
  assert.ok(noLogo.ok && !noLogo.html.includes('<img') && noLogo.html.includes('>DalaTech</span>'));
  const receipt = renderMail({ ...args, kind: 'receipt', invoice: invoice({ status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-03T04:00:00Z') }), wording: { source: 'signed', blocks: all } });
  assert.ok(receipt.ok && !receipt.html.includes(PAY_URL) && !receipt.html.includes(esc(all.get('billing_mail_fallback_link') as string)), 'a receipt has no button and no fallback line');
  assert.ok(receipt.ok && receipt.html.includes('5000123456') && receipt.text.includes('5000123456') && receipt.text.includes('Б. Билгүүн'), 'a receipt still names the account the money went to');
  assert.ok(full.html.includes('<!--[if mso]><table role="presentation" width="560"'), 'Outlook gets a fixed width');
});

test('the pause notice: branded like a reminder; its own unsigned lines never hold back the invoice', () => {
  const all = wordingOnDisk();
  const args = { invoice: invoice({}), account: { displayName: 'Матрикс ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: 'https://dala.example.com/brand/dalatech-wordmark.png' };
  const r = renderMail({ ...args, kind: 'pause', wording: { source: 'signed', blocks: all } });
  assert.ok(r.ok, r.ok ? '' : r.why);
  assert.ok(r.html.includes(esc(all.get('billing_mail_pause_title') as string)) && r.html.includes('>Төлбөр төлөх</a>') && r.html.includes('5000123456'),
    'title, the pay button and the bank box');
  assert.ok(r.text.includes('Матрикс ХХК') && r.text.includes(PAY_URL) && r.text.includes('250,000₮'));
  // «Төлбөр баталгаажмагц үйлчилгээ сэргэнэ» (founder, 2026-10-02) is true because a confirmed
  // payment resumes the client (engine.ts autoResume, proven in billing-e2e), QPay or a recorded
  // bank transfer. No past due date is repeated as a deadline.
  assert.match(`${all.get('billing_mail_pause_intro')}`, /Төлбөр баталгаажмагц үйлчилгээ сэргэнэ/u);
  assert.doesNotMatch(`${all.get('billing_pause_body')}`, /\{due_date\}/u);
  const withoutPause = new Map(all);
  withoutPause.delete('billing_mail_pause_title');
  withoutPause.delete('billing_mail_pause_intro');
  assert.deepEqual(mailReady({ source: 'signed', blocks: withoutPause }, { ok: true }), { ok: true }, 'the invoice is unaffected');
  const p = mailReady({ source: 'signed', blocks: withoutPause }, { ok: true }, 'pause');
  assert.ok(!p.ok && p.why.includes('billing_mail_pause'), 'the pause notice itself waits for its lines');
});

test('the PDF invoice: one A4 page in the brand fonts, with the short address as a link; too many lines refuse', async () => {
  const blocks: Wording = { source: 'signed', blocks: wordingOnDisk() };
  const r = await renderInvoicePdf({ wording: blocks, invoice: invoice({}), account: { displayName: 'Матрикс ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL });
  assert.ok(r.ok);
  const bytes = Buffer.from(r.base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(r.name, 'DalaTech-DT-202610-0001.pdf');
  assert.ok(bytes.includes(Buffer.from('/URI (https://pay.dalatech.online/DT-202610-0001-K7QM2X)', 'latin1')), 'the address is a live link');
  assert.ok(bytes.length < 120_000, `small enough to attach (${bytes.length} bytes)`);
  const lines = Array.from({ length: 40 }, (_, i) => ({ label: `Мөр ${i}`, amount_mnt: 1000 }));
  const long = await renderInvoicePdf({ wording: blocks, invoice: invoice({ lines, amountMnt: 40000 }), account: { displayName: 'Матрикс ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL });
  assert.ok(!long.ok && long.why.includes('too many lines'));
});

test('Resend: the same message, no unsubscribe header added, the PDF passed as base64', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ id: 're_1' }), { status: 200 });
  }) as unknown as typeof fetch;
  process.env['RESEND_API_KEY'] = 're_test';
  process.env['BILLING_FOUNDER_EMAIL'] = 'founder@example.com';
  const out = await sendResendEmail({ to: 'c@example.mn', subject: 'S', text: 'T', html: '<p>H</p>', attachment: { name: 'a.pdf', content: 'JVBERi0=', encoding: 'base64' } }, f);
  assert.deepEqual(out, { outcome: 'sent', providerMessageId: 're_1' });
  const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
  assert.equal(seen[0]?.url, 'https://api.resend.com/emails');
  assert.equal((seen[0]?.init.headers as Record<string, string>)['authorization'], 'Bearer re_test');
  assert.equal(body['from'], 'DalaTech <hello@dalatech.online>');
  assert.equal(body['reply_to'], 'founder@example.com');
  assert.equal(body['html'], '<p>H</p>');
  assert.deepEqual(body['attachments'], [{ filename: 'a.pdf', content: 'JVBERi0=' }]);
  assert.equal(body['headers'], undefined, 'no List-Unsubscribe or any other header is added');
  delete process.env['RESEND_API_KEY'];
  delete process.env['BILLING_FOUNDER_EMAIL'];
});

test('the pay page (0070): the bank transfer and the phone for an unpaid invoice, only once signed; none once paid', () => {
  const all = wordingOnDisk();
  const code = { kind: 'code' as const, invoice: invoice({}), account, qrImage: 'iVBORw0KGgo=', urls: [], secondsLeft: 200, issuer: ISSUER, logoUrl: 'https://dala.example.com/brand/dalatech-mark.png' };
  const page = renderPayPage(code, { source: 'signed', blocks: all });
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('Банкаар шилжүүлэх') && page.html.includes('5000123456') && page.html.includes('href="tel:99112233"'));
  const coreOnly = new Map([...all].filter(([k]) => !k.startsWith('billing_bank_') && !k.startsWith('billing_label_') && k !== 'billing_page_questions'));
  const live = renderPayPage(code, { source: 'signed', blocks: coreOnly });
  assert.ok(live.status === 200 && !live.html.includes('5000123456') && !live.html.includes('TEST —'), 'a live client sees no unsigned section, and no banner');
  const test = renderPayPage({ ...code, invoice: invoice({ isTest: true }) }, { source: 'signed', blocks: coreOnly });
  assert.ok(test.html.includes('5000123456') && test.html.includes('Pay by bank transfer') && test.html.includes('TEST —'), 'the founder sees it in English');
  const paid = renderPayPage({ kind: 'settled', invoice: invoice({ status: 'paid', paidSumMnt: 250000, paidAt: NOW }), account, issuer: ISSUER }, { source: 'signed', blocks: all });
  assert.ok(!paid.html.includes('5000123456') && !paid.html.includes('tel:'));
});

test('a branch name with an em dash renders in the PDF and the e-mail (the Tara Salon branches, 2026-09-29)', async () => {
  const blocks: Wording = { source: 'signed', blocks: wordingOnDisk() };
  for (const displayName of ['Tara Salon — Яармаг', 'Tara Salon — Парк Од']) {
    const pdf = await renderInvoicePdf({ wording: blocks, invoice: invoice({}), account: { displayName, contractRef: null }, issuer: ISSUER, payUrl: PAY_URL });
    assert.ok(pdf.ok, pdf.ok ? '' : pdf.why);
    const mail = renderMail({ kind: 'invoice', wording: blocks, invoice: invoice({}), account: { displayName, contractRef: null }, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: '' });
    assert.ok(mail.ok && mail.html.includes(displayName) && mail.text.includes(displayName));
  }
});

test('the PDF refuses a character its fonts lack rather than printing an empty box', async () => {
  const blocks: Wording = { source: 'signed', blocks: wordingOnDisk() };
  const r = await renderInvoicePdf({ wording: blocks, invoice: invoice({}), account: { displayName: 'Şahin 李 ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL });
  assert.ok(!r.ok && r.why.includes('U+015E'), r.ok ? 'rendered' : r.why);
});

test('a refused send records the provider\'s reason, one line, cut short', async () => {
  process.env['RESEND_API_KEY'] = 're_test';
  process.env['BILLING_FOUNDER_EMAIL'] = 'founder@example.com';
  const f = (async () => new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The dalatech.online domain is not verified.\nAdd it.' }), { status: 403 })) as unknown as typeof fetch;
  assert.deepEqual(await sendResendEmail({ to: 'c@example.mn', subject: 'S', text: 'T' }, f),
    { outcome: 'terminal', detail: 'resend HTTP 403 — validation_error: The dalatech.online domain is not verified. Add it.' });
  const g = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  assert.deepEqual(await sendResendEmail({ to: 'c@example.mn', subject: 'S', text: 'T' }, g), { outcome: 'retry', detail: 'resend HTTP 500' });
  delete process.env['RESEND_API_KEY'];
  delete process.env['BILLING_FOUNDER_EMAIL'];
});

test('every date a client reads is the Ulaanbaatar date, including just after midnight there', () => {
  const blocks: Wording = { source: 'signed', blocks: wordingOnDisk() };
  // 17:30 UTC on the 2nd is 01:30 on the 3rd in Ulaanbaatar: the receipt says the 3rd.
  const paid = invoice({ status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-02T17:30:00Z') });
  const r = renderMail({ kind: 'receipt', wording: blocks, invoice: paid, account: { displayName: 'Матрикс ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: '' });
  assert.ok(r.ok && r.text.includes('Төлсөн огноо: 2026.10.03') && !r.text.includes('2026.10.02'), r.ok ? r.text : r.why);
  const page = renderPayPage({ kind: 'settled', invoice: paid, account }, { source: 'signed', blocks: blocks.blocks });
  assert.ok(page.html.includes('2026.10.03') && !page.html.includes('2026.10.02'));
  // The issue and due days are stored as Ulaanbaatar calendar days and printed as stored.
  const inv = renderMail({ kind: 'invoice', wording: blocks, invoice: invoice({ issuedOn: '2026-10-01', dueOn: '2026-10-05' }), account: { displayName: 'Матрикс ХХК', contractRef: null }, issuer: ISSUER, payUrl: PAY_URL, period: '2026 оны 10-р сарын', logoUrl: '' });
  assert.ok(inv.ok && inv.text.includes('Нэхэмжилсэн огноо: 2026.10.01') && inv.text.includes('2026.10.05'));
  assert.equal(billingToday(new Date('2026-09-27T16:30:00Z')), '2026-09-28', 'the day an invoice is issued on is the Ulaanbaatar day');
});
