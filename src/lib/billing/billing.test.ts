import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { addDays, daysBetween, dottedDay, previousMonth, stageFor, billingToday } from './calendar.ts';
import { actionKindOf, linksFor, signLink, verifyLink } from './links.ts';
import { parseAmount, paymentTime, quickQr, readPaymentCheck } from './qpay.ts';
import { BILLING_BLOCKS, BILLING_BLOCK_KEYS, formatMnt, render, renderLines, type Wording } from './templates.ts';
import { parseStaff, propose, teamDiscountPercent, type Phrases } from './amounts.ts';
import { sendBrevoEmail, sendFounderTelegram, textToHtml } from './send.ts';
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
  assert.deepEqual([at('05').reminderAfter, at('06').reminderAfter, at('07').reminderAfter, at('08').reminderAfter], [false, true, true, false]);
  assert.deepEqual([at('07').pauseAsk, at('08').pauseAsk, at('20').pauseAsk], [false, true, true]);
  assert.equal(at('08').daysLate, 3);
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
  assert.ok(links.pay(INV).startsWith('https://dala.example.com/pay/'));
  assert.ok(links.callback(INV).startsWith('https://dala.example.com/api/billing/qpay?t='));
});

// --- QPay -----------------------------------------------------------------------------

test('a QPay payment is recorded only when every settled row names its id and amount', () => {
  const ok = readPaymentCheck({ rows: [
    { payment_id: 'P1', payment_status: 'PAID', payment_amount: '100.00', payment_date: '2026-10-03T05:00:00Z' },
    { payment_id: 'P0', payment_status: 'NEW', payment_amount: '100' },
  ] }, 'Q1', NOW);
  assert.deepEqual(ok, { ok: true, determined: true, invoiceStatus: null, payments: [{ key: 'qpay:P1', amountMnt: 100, paidAt: new Date('2026-10-03T05:00:00Z') }] });

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
    start: '2026.11.01', end: '2027.10.31', label: 'Дали', months: '12', count: '2', percent: '10',
  };
  for (const key of BILLING_BLOCK_KEYS) {
    const body = blocks.get(key) as string;
    assert.equal(body, body.normalize('NFC'), key);
    const r = render({ source: 'draft', blocks }, key, values);
    assert.ok(r.ok, `${key}: ${r.ok ? '' : r.why}`);
    assert.doesNotMatch(r.ok ? r.text : '', /\{[^{}\s]+\}/u, `${key} left a placeholder`);
  }
  assert.equal(Object.keys(BILLING_BLOCKS).length, 22);
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
const account: Account = { id: ACC, tenantId: 'tenant', displayName: 'Матрикс ХХК', email: 'm@example.mn', isTest: false };

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
  const view = { invoice: invoice({}), account, qrImage: 'iVBORw0KGgo=', urls: [{ name: 'Khan', logo: 'https://qpay.mn/k.png', link: 'khanbank://q?x=1' }, { name: 'evil', logo: '', link: 'javascript:alert(1)' }] };
  assert.equal(renderPayPage(view, w({})).status, 503);
  const test = renderPayPage({ ...view, invoice: invoice({ isTest: true }) }, w({}));
  assert.equal(test.status, 200);
  assert.match(test.html, /TEST — the Mongolian wording is not signed/);
  assert.match(test.html, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(test.html, /khanbank:\/\/q\?x=1/);
  assert.doesNotMatch(test.html, /javascript:/);
});

test('the pay page escapes the client name and hides the QR once paid', () => {
  const blocks = wordingOnDisk();
  const evil = { ...account, displayName: '<img src=x onerror=alert(1)>' };
  const paid = renderPayPage({ invoice: invoice({ status: 'paid', paidSumMnt: 250000, paidAt: new Date('2026-10-03T20:00:00Z') }), account: evil, qrImage: 'AAAA', urls: [] }, { source: 'signed', blocks });
  assert.equal(paid.status, 200);
  assert.doesNotMatch(paid.html, /<img src=x/);
  assert.doesNotMatch(paid.html, /data:image/);
  // 20:00 UTC on the 3rd is the 4th in Ulaanbaatar.
  assert.match(paid.html, /2026\.10\.04/);
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
