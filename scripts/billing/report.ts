/**
 * Read-only billing reports (D-156). Writes nothing, calls nothing but the database.
 *
 *     node scripts/billing/report.ts preview [--month 2026-11]   # exactly what the live run on the 1st will invoice
 *     node scripts/billing/report.ts ledger --month 2026-10 [--test] > ledger-2026-10.csv
 *     node scripts/billing/report.ts status [--test]             # unsettled invoices, messages not delivered
 *
 * `preview` is the check before `BILLING_MODE=live`: every confirmed live schedule due that
 * month with its amount, and every schedule still waiting for your confirmation.
 */
import { billingToday, monthOf } from '../../src/lib/billing/calendar.ts';
import { INVOICE_COLUMNS, ledgerCsv, ledgerRows, toInvoice } from '../../src/lib/billing/engine.ts';
import { formatMnt } from '../../src/lib/billing/templates.ts';
import { die, flag, has, operatorDb, out } from './_common.ts';

const CMD = 'billing/report';

async function main(): Promise<void> {
  const db = operatorDb();
  const sub = process.argv[2];
  if (sub === 'preview') {
    const current = monthOf(billingToday(new Date()));
    const [y, m] = [Number(current.slice(0, 4)), Number(current.slice(5, 7))];
    const month = flag(CMD, 'month') ?? (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`);
    const { data: accounts, error } = await db.from('billing_accounts').select('id, display_name, email, is_test, status').eq('status', 'active');
    if (error) die(CMD, error.message, 1);
    const byId = new Map((accounts ?? []).map((a) => [String((a as Record<string, unknown>)['id']), a as Record<string, unknown>]));
    const { data: schedules, error: sErr } = await db.from('billing_schedules')
      .select('id, account_id, kind, amount_mnt, next_month, due_day, confirmed_at').eq('active', true);
    if (sErr) die(CMD, sErr.message, 1);
    let total = 0;
    out(`On ${month}-01 (Ulaanbaatar), BILLING_MODE=live would invoice:`);
    const waiting: string[] = [];
    for (const s of (schedules ?? []) as Array<Record<string, unknown>>) {
      const a = byId.get(String(s['account_id']));
      if (a === undefined) continue;
      const label = `${String(a['display_name'])}${a['is_test'] === true ? ' [TEST]' : ''} — ${String(s['kind'])} ${formatMnt(Number(s['amount_mnt']))}, due day ${String(s['due_day'])}, to ${String(a['email'] ?? 'you (forward)')}`;
      if (s['confirmed_at'] === null) { waiting.push(label); continue; }
      const next = String(s['next_month']).slice(0, 7);
      if (next === month) { out(`  • ${label}`); if (a['is_test'] !== true) total += Number(s['amount_mnt']); }
      else if (next < month) out(`  ! ${label} — BEHIND (next period ${next}); it will be reported, not invoiced`);
    }
    out(`  live total: ${formatMnt(total)}`);
    if (waiting.length > 0) {
      out('\nNot confirmed, so NOT invoiced (account.ts show prints the confirm command):');
      for (const w of waiting) out(`  • ${w}`);
    }
    return;
  }
  if (sub === 'ledger') {
    const month = flag(CMD, 'month') ?? die(CMD, '--month YYYY-MM is required');
    if (!/^\d{4}-\d{2}$/u.test(month)) die(CMD, '--month is YYYY-MM');
    process.stdout.write(ledgerCsv(await ledgerRows(db, month, has('test') ? 'test' : 'live')));
    return;
  }
  if (sub === 'status') {
    let q = db.from('billing_invoices').select(INVOICE_COLUMNS).in('status', ['open', 'mismatch']).order('due_on');
    if (has('test')) q = q.eq('is_test', true);
    const { data, error } = await q;
    if (error) die(CMD, error.message, 1);
    out('Unsettled invoices:');
    for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const i = toInvoice(r);
      out(`  ${i.invoiceNo} ${i.status} ${formatMnt(i.amountMnt)} paid ${formatMnt(i.paidSumMnt)}, due ${i.dueOn}${i.qpayInvoiceId === null ? ' — NO QPay code yet' : ''}`);
    }
    const { data: d, error: dErr } = await db.from('billing_deliveries').select('id, kind, channel, recipient, status, attempts, last_error')
      .in('status', ['failed', 'unknown', 'sending']).order('created_at');
    if (dErr) die(CMD, dErr.message, 1);
    out('Messages not delivered:');
    for (const r of (d ?? []) as Array<Record<string, unknown>>) {
      out(`  ${String(r['id'])} ${String(r['kind'])} → ${String(r['recipient'])} ${String(r['status'])} after ${String(r['attempts'])} attempt(s): ${String(r['last_error'] ?? '')}`);
    }
    return;
  }
  die(CMD, 'usage: report.ts preview|ledger|status (see the top of this file)');
}

main().catch((e) => die(CMD, e instanceof Error ? e.message : String(e), 1));
