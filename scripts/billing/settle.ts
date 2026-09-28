/**
 * The founder's hand on billing (D-156): the things only a person decides.
 *
 *     # a bank transfer (contract 4.5 allows one) — recorded once per bank reference
 *     node scripts/billing/settle.ts bank --invoice DT-202610-0001 --amount 250000 --ref <bank ref> --paid-on 2026-10-04 --by Bilguun
 *
 *     # a QPay payment the platform could not read (the 🟠 message says so), under QPay's own payment id
 *     node scripts/billing/settle.ts qpay --invoice DT-202610-0001 --payment-id <id from the QPay merchant app> --amount 250000 --paid-on 2026-10-04 --by Bilguun
 *
 *     # a wrong amount you accept as paid, or an invoice you withdraw (also withdrawn at QPay)
 *     node scripts/billing/settle.ts resolve --invoice DT-202610-0001 --outcome paid --note "agreed by phone" --by Bilguun
 *     node scripts/billing/settle.ts resolve --invoice DT-202610-0001 --outcome void --note "issued in error" --by Bilguun
 *
 *     # send a message again: one that failed for good, or one whose send never finished and did not arrive
 *     node scripts/billing/settle.ts requeue --delivery <id> --by Bilguun
 *
 *     # the same as the Telegram buttons
 *     node scripts/billing/settle.ts pause  --account <id> --by Bilguun
 *     node scripts/billing/settle.ts resume --account <id> --by Bilguun
 *
 * Receipts and the founder's messages for anything settled here follow on the next run.
 */
import { PLATFORM_TIMEZONE } from '../../src/config/platform.ts';
import { localDayStart } from '../../src/lib/time/clock.ts';
import { qpayConfigFromEnv } from '../../src/lib/billing/config.ts';
import { quickQr } from '../../src/lib/billing/qpay.ts';
import { formatMnt } from '../../src/lib/billing/templates.ts';
import { die, flag, invoiceByNo, operatorDb, out, refuseCredentialArgs } from './_common.ts';

const CMD = 'billing/settle';
refuseCredentialArgs(CMD);

async function main(): Promise<void> {
  const db = operatorDb();
  const sub = process.argv[2];
  const by = flag(CMD, 'by') ?? die(CMD, '--by <your name> is required');
  if (sub === 'bank') {
    const inv = await invoiceByNo(db, CMD, flag(CMD, 'invoice') ?? die(CMD, '--invoice <DT-…> is required'));
    const amount = Number((flag(CMD, 'amount') ?? die(CMD, '--amount is required')).replace(/[,\s]/gu, ''));
    if (!Number.isInteger(amount) || amount <= 0) die(CMD, '--amount is a positive whole tugrik amount');
    const ref = (flag(CMD, 'ref') ?? die(CMD, '--ref <the bank reference> is required: it is what stops the same transfer being counted twice')).trim();
    const paidOn = flag(CMD, 'paid-on') ?? die(CMD, '--paid-on YYYY-MM-DD is required');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(paidOn)) die(CMD, '--paid-on is YYYY-MM-DD');
    const paidAt = new Date(localDayStart(paidOn, PLATFORM_TIMEZONE).getTime() + 12 * 3_600_000);
    const { data, error } = await db.rpc('billing_record_payment', {
      p_invoice: inv['id'], p_payment_key: `bank:${ref}`, p_source: 'bank', p_amount: amount, p_paid_at: paidAt.toISOString(),
      p_qpay_invoice_id: null, p_recorded_by: `operator:${by}`, p_note: flag(CMD, 'note') ?? null,
    });
    if (error) die(CMD, error.message, 1);
    const r = data as Record<string, unknown>;
    out(`${String(inv['invoice_no'])}: ${r['inserted'] === true ? 'recorded' : 'ALREADY recorded (same bank reference) — not counted again'}. `
      + `Payments now ${formatMnt(Number(r['paid_sum_mnt']))} of ${formatMnt(Number(r['amount_mnt']))}: ${String(r['status'])}.`);
    return;
  }
  if (sub === 'qpay') {
    // Keyed exactly as the automatic check keys it (`qpay:<payment id>`), so when QPay's
    // answer becomes readable the same payment is recognised, never counted a second time.
    const inv = await invoiceByNo(db, CMD, flag(CMD, 'invoice') ?? die(CMD, '--invoice <DT-…> is required'));
    if (typeof inv['qpay_invoice_id'] !== 'string') die(CMD, `${String(inv['invoice_no'])} has no QPay invoice; a transfer is settle.ts bank`);
    const pid = (flag(CMD, 'payment-id') ?? die(CMD, "--payment-id <QPay's payment id> is required")).trim();
    const amount = Number((flag(CMD, 'amount') ?? die(CMD, '--amount is required')).replace(/[,\s]/gu, ''));
    if (!Number.isInteger(amount) || amount <= 0) die(CMD, '--amount is a positive whole tugrik amount');
    const paidOn = flag(CMD, 'paid-on') ?? die(CMD, '--paid-on YYYY-MM-DD is required');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(paidOn)) die(CMD, '--paid-on is YYYY-MM-DD');
    const paidAt = new Date(localDayStart(paidOn, PLATFORM_TIMEZONE).getTime() + 12 * 3_600_000);
    // The automatic check records under QPay's own payment id. A hand entry under any other
    // id on an invoice it already recorded would count the same money twice.
    const { data: auto, error: autoErr } = await db.from('billing_payments')
      .select('payment_key, recorded_by').eq('invoice_id', inv['id']).eq('source', 'qpay');
    if (autoErr) die(CMD, autoErr.message, 1);
    const recorded = ((auto ?? []) as { payment_key: string; recorded_by: string }[])
      .filter((r) => !r.recorded_by.startsWith('operator:') && r.payment_key !== `qpay:${pid}`);
    if (recorded.length > 0 && flag(CMD, 'second-payment') === undefined) {
      die(CMD, `${String(inv['invoice_no'])} already has ${recorded.map((r) => r.payment_key).join(', ')}, recorded automatically from QPay. `
        + 'If this is the same payment, nothing more is needed. Only if QPay took a SECOND payment, run again with --second-payment yes.');
    }
    const { data, error } = await db.rpc('billing_record_payment', {
      p_invoice: inv['id'], p_payment_key: `qpay:${pid}`, p_source: 'qpay', p_amount: amount, p_paid_at: paidAt.toISOString(),
      p_qpay_invoice_id: inv['qpay_invoice_id'], p_recorded_by: `operator:${by}`, p_note: flag(CMD, 'note') ?? null,
    });
    if (error) die(CMD, error.message, 1);
    const r = data as Record<string, unknown>;
    out(`${String(inv['invoice_no'])}: ${r['inserted'] === true ? 'recorded' : 'ALREADY recorded (same QPay payment id) — not counted again'}. `
      + `Payments now ${formatMnt(Number(r['paid_sum_mnt']))} of ${formatMnt(Number(r['amount_mnt']))}: ${String(r['status'])}.`);
    return;
  }
  if (sub === 'resolve') {
    const inv = await invoiceByNo(db, CMD, flag(CMD, 'invoice') ?? die(CMD, '--invoice <DT-…> is required'));
    const outcome = flag(CMD, 'outcome');
    if (outcome !== 'paid' && outcome !== 'void') die(CMD, '--outcome paid|void is required');
    const note = flag(CMD, 'note') ?? die(CMD, '--note "<why>" is required');
    const { error } = await db.rpc('billing_resolve', { p_invoice: inv['id'], p_outcome: outcome, p_by: by, p_note: note });
    if (error) die(CMD, error.message, 1);
    out(`${String(inv['invoice_no'])} is now ${outcome}.`);
    if (outcome === 'void' && typeof inv['qpay_invoice_id'] === 'string') {
      // Withdraw it at QPay too, so its QR stops accepting money. Best effort, and said so.
      try {
        const q = quickQr(qpayConfigFromEnv());
        const t = await q.token();
        const c = t.ok ? await q.cancelInvoice(t.token, inv['qpay_invoice_id']) : t;
        out(c.ok ? 'Withdrawn at QPay as well.' : `NOT withdrawn at QPay (${c.detail}): withdraw it in the QPay merchant app. For ${35} days a payment to it is still detected and sent to you as a ⚠️.`);
      } catch (e) {
        out(`NOT withdrawn at QPay (${(e as Error).message}): withdraw it in the QPay merchant app. For 35 days a payment to it is still detected and sent to you as a ⚠️.`);
      }
    }
    return;
  }
  if (sub === 'requeue') {
    const id = flag(CMD, 'delivery') ?? die(CMD, '--delivery <id> is required');
    const { data, error } = await db.rpc('billing_requeue_delivery', { p_id: id, p_by: by });
    if (error) die(CMD, error.message, 1);
    out(data === true ? 'Queued again; it goes out on the next run.' : 'Not requeued: it is not failed or unknown (already pending, sent, or cancelled).');
    return;
  }
  if (sub === 'pause' || sub === 'resume') {
    const account = flag(CMD, 'account') ?? die(CMD, '--account <id> is required');
    const { data, error } = sub === 'pause'
      ? await db.rpc('billing_pause', { p_account: account, p_invoice: null, p_by: `operator:${by}` })
      : await db.rpc('billing_resume', { p_account: account, p_by: `operator:${by}` });
    if (error) die(CMD, error.message, 1);
    out(JSON.stringify(data));
    return;
  }
  die(CMD, 'usage: settle.ts bank|qpay|resolve|requeue|pause|resume … (see the top of this file)');
}

main().catch((e) => die(CMD, e instanceof Error ? e.message : String(e), 1));
