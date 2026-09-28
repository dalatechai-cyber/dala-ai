/**
 * A one-off charge (D-156): a setup fee, a website half (4.2), a first month at 50%, a
 * missed period. Running this is the founder's confirmation — it prints first and writes
 * only with `--apply` — and `--key` makes the same command a no-op the second time.
 *
 *     node scripts/billing/charge.ts --tenant matrix-eco-salon --key setup-2026-10 \
 *       --line "Дали — суурилуулалт=50000" --due 2026-10-06 --by Bilguun            # prints
 *     … --apply                                                                     # writes
 *
 *     # the late-payment test: a 100₮ test invoice that was due a week ago
 *     node scripts/billing/charge.ts --account <test account id> --key late-test --line "Туршилт=100" \
 *       --issued 2026-09-18 --due 2026-09-21 --by Bilguun --apply
 *
 * The invoice's QPay code, e-mail and reminders follow on the next billing run, like any other.
 */
import { billingToday } from '../../src/lib/billing/calendar.ts';
import { parseStaff } from '../../src/lib/billing/amounts.ts';
import { formatMnt } from '../../src/lib/billing/templates.ts';
import { die, flag, flags, has, operatorDb, out, refuseCredentialArgs } from './_common.ts';

const CMD = 'billing/charge';
refuseCredentialArgs(CMD);
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

async function main(): Promise<void> {
  const db = operatorDb();
  let accountId = flag(CMD, 'account');
  const tenant = flag(CMD, 'tenant');
  if ((accountId === undefined) === (tenant === undefined)) die(CMD, 'give exactly one of --account <id> or --tenant <slug>');
  if (tenant !== undefined) {
    const { data: t } = await db.from('tenants').select('id').eq('slug', tenant).maybeSingle();
    if (t === null) die(CMD, `no tenant ${tenant}`);
    const { data: a } = await db.from('billing_accounts').select('id').eq('tenant_id', String((t as Record<string, unknown>)['id'])).maybeSingle();
    if (a === null) die(CMD, `${tenant} has no billing account (account.ts propose … --apply)`);
    accountId = String((a as Record<string, unknown>)['id']);
  }
  const key = flag(CMD, 'key') ?? die(CMD, '--key <lower-case-id> is required, e.g. setup-2026-10');
  const lines = flags(CMD, 'line').map((l) => {
    try {
      const p = parseStaff(l);
      return { label: p.label, amount_mnt: p.monthlyMnt };
    } catch (e) {
      return die(CMD, (e as Error).message);
    }
  });
  if (lines.length === 0) die(CMD, 'at least one --line "<label>=<amount>" is required');
  const issued = flag(CMD, 'issued') ?? billingToday(new Date());
  const due = flag(CMD, 'due') ?? die(CMD, '--due YYYY-MM-DD is required');
  if (!DAY.test(issued) || !DAY.test(due)) die(CMD, 'dates are YYYY-MM-DD');
  const by = flag(CMD, 'by') ?? die(CMD, '--by <your name> is required');
  const amount = lines.reduce((s, l) => s + l.amount_mnt, 0);
  const { data: acc } = await db.from('billing_accounts').select('display_name, is_test').eq('id', accountId as string).maybeSingle();
  if (acc === null) die(CMD, `no billing account ${String(accountId)}`);
  const a = acc as Record<string, unknown>;
  out(`${String(a['display_name'])}${a['is_test'] === true ? ' [TEST]' : ''}: one-off "${key}", issued ${issued}, due ${due}`);
  for (const l of lines) out(`  ${l.label.padEnd(48)} ${formatMnt(l.amount_mnt).padStart(14)}`);
  out(`  total ${formatMnt(amount)}`);
  if (!has('apply')) { out('\nNothing written. Add --apply to issue it.'); return; }
  const { data, error } = await db.rpc('billing_issue_one_off', {
    p_account: accountId, p_key: key, p_lines: lines, p_amount: amount, p_issued_on: issued, p_due_on: due, p_by: by,
  });
  if (error) die(CMD, error.message, 1);
  const r = data as Record<string, unknown>;
  out(r['created'] === true
    ? `Issued ${String(r['invoice_no'])}. Its QPay code and e-mail follow on the next billing run.`
    : `${String(r['invoice_no'])} already exists with exactly this content; nothing changed.`);
}

main().catch((e) => die(CMD, e instanceof Error ? e.message : String(e), 1));
