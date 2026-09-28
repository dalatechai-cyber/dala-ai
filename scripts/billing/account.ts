/**
 * A client's billing record (D-156): propose it, read it, confirm it.
 *
 *     # 1. propose from the contract — prints the lines and amounts, writes NOTHING
 *     node scripts/billing/account.ts propose --tenant matrix-eco-salon --name "Матрикс Эко Салон ХХК" \
 *       --email owner@example.mn --staff "Дали — AI хүлээн авагч=250000" --start 2026-11
 *     #    two staff: --staff "…=250000" --staff "…=150000"   annual prepay: --annual
 *     #    yearly hosting: --hosting 150000 --hosting-label "Хостинг, домэйн…" --hosting-start 2027-03
 *
 *     # 2. write it (unconfirmed: nothing is invoiced yet)
 *     … --apply
 *
 *     # 3. confirm each schedule exactly as printed — only this lets it be invoiced
 *     node scripts/billing/account.ts confirm --schedule <id> --fingerprint <fp> --by Bilguun
 *
 *     node scripts/billing/account.ts show [--tenant <slug> | --account <id>]    # read, with fingerprints
 *     node scripts/billing/account.ts email --account <id> --email new@example.mn
 *     node scripts/billing/account.ts end-schedule --schedule <id> --by Bilguun     # stop invoicing it
 *     node scripts/billing/account.ts advance --schedule <id> --to 2026-12 --by Bilguun  # a schedule reported behind
 *     node scripts/billing/account.ts end-account --account <id> --by Bilguun      # the client left
 *
 * A test account for the end-to-end test: `propose --test --name "Туршилт" --email <yours> …`.
 * It has no tenant, only ever reaches you, and is the only kind `BILLING_MODE=test` touches.
 */
import { billingToday, monthOf } from '../../src/lib/billing/calendar.ts';
import { parseStaff } from '../../src/lib/billing/amounts.ts';
import { phrasesFrom, planSchedules, writeBillingRecord, type PlannedSchedule } from '../../src/lib/billing/setup.ts';
import { formatMnt } from '../../src/lib/billing/templates.ts';
import { die, flag, flags, has, labelWording, operatorDb, out, refuseCredentialArgs } from './_common.ts';

const CMD = 'billing/account';
refuseCredentialArgs(CMD);
const sub = process.argv[2];
const db = operatorDb();

function printPlan(plan: PlannedSchedule[]): void {
  for (const s of plan) {
    out(`  ${s.kind} — every ${s.everyMonths} month(s) from ${s.nextMonth.slice(0, 7)}, due on day ${s.dueDay}: ${formatMnt(s.amountMnt)}`);
    for (const l of s.lines) out(`      ${l.label.padEnd(48)} ${formatMnt(l.amount_mnt).padStart(14)}`);
    out(`      (${s.why})`);
  }
}

async function show(filter: { tenant?: string; account?: string }): Promise<void> {
  let q = db.from('billing_accounts').select('id, tenant_id, display_name, email, is_test, status, contract_ref');
  if (filter.account !== undefined) q = q.eq('id', filter.account);
  if (filter.tenant !== undefined) {
    const { data: t } = await db.from('tenants').select('id').eq('slug', filter.tenant).maybeSingle();
    if (t === null) die(CMD, `no tenant ${filter.tenant}`);
    q = q.eq('tenant_id', String((t as Record<string, unknown>)['id']));
  }
  const { data: accounts, error } = await q.order('created_at');
  if (error) die(CMD, error.message, 1);
  for (const a of (accounts ?? []) as Array<Record<string, unknown>>) {
    out(`${String(a['display_name'])}${a['is_test'] === true ? ' [TEST]' : ''} — account ${String(a['id'])} (${String(a['status'])})`);
    out(`  e-mail: ${String(a['email'] ?? '(none: invoices come to you on Telegram to forward)')}`);
    const { data: ss } = await db.from('billing_schedules')
      .select('id, kind, lines, amount_mnt, every_months, next_month, due_day, active, confirmed_at, confirmed_by')
      .eq('account_id', String(a['id'])).order('created_at');
    for (const s of (ss ?? []) as Array<Record<string, unknown>>) {
      const { data: fp } = await db.rpc('billing_schedule_fingerprint', { p_schedule: s['id'] });
      out(`  schedule ${String(s['id'])} ${String(s['kind'])} ${s['active'] === true ? '' : '(ended) '}— ${formatMnt(Number(s['amount_mnt']))} every ${String(s['every_months'])} month(s), next ${String(s['next_month']).slice(0, 7)}, due day ${String(s['due_day'])}`);
      for (const l of (s['lines'] as Array<Record<string, unknown>>)) out(`      ${String(l['label']).padEnd(48)} ${formatMnt(Number(l['amount_mnt'])).padStart(14)}`);
      out(s['confirmed_at'] === null
        ? `      NOT CONFIRMED — never invoiced until: node scripts/billing/account.ts confirm --schedule ${String(s['id'])} --fingerprint ${String(fp)} --by <you>`
        : `      confirmed by ${String(s['confirmed_by'])} at ${String(s['confirmed_at'])} (fingerprint ${String(fp)})`);
    }
  }
}

async function main(): Promise<void> {
  if (sub === 'propose') {
    const isTest = has('test');
    const tenant = flag(CMD, 'tenant');
    if (isTest === (tenant !== undefined)) die(CMD, 'give exactly one of --tenant <slug> or --test');
    const name = flag(CMD, 'name') ?? die(CMD, '--name "<legal name as in the contract>" is required');
    const email = flag(CMD, 'email') ?? null;
    if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) die(CMD, `${email} is not an e-mail address`);
    const start = flag(CMD, 'start') ?? die(CMD, '--start YYYY-MM (the first month to invoice) is required');
    const staff = flags(CMD, 'staff').map((s) => { try { return parseStaff(s); } catch (e) { return die(CMD, (e as Error).message); } });
    const hostingAmount = flag(CMD, 'hosting');
    const { wording, note } = await labelWording(db, isTest);
    let plan: PlannedSchedule[];
    try {
      plan = planSchedules({
        staff, annual: has('annual'), startMonth: start, dueDay: Number(flag(CMD, 'due-day') ?? '5'),
        ...(hostingAmount === undefined ? {} : {
          hosting: {
            amountMnt: Number(hostingAmount.replace(/[,\s]/gu, '')),
            startMonth: flag(CMD, 'hosting-start') ?? die(CMD, '--hosting needs --hosting-start YYYY-MM (the handover month)'),
            label: (flag(CMD, 'hosting-label') ?? die(CMD, '--hosting needs --hosting-label "<what the client reads>"')).normalize('NFC'),
          },
        }),
      }, phrasesFrom(wording), monthOf(billingToday(new Date())));
    } catch (e) {
      die(CMD, (e as Error).message);
    }
    out(`${name}${isTest ? ' [TEST]' : ''}${tenant === undefined ? '' : ` (tenant ${tenant})`} — e-mail: ${email ?? '(none: you forward each invoice)'}`);
    out(note);
    printPlan(plan);
    if (!has('apply')) { out('\nNothing written. Add --apply to write it (unconfirmed).'); return; }
    const r = await writeBillingRecord(db, { tenantSlug: tenant ?? null, isTest, displayName: name, email, contractRef: flag(CMD, 'contract') ?? null }, plan);
    out(`\n${r.createdAccount ? 'Created' : 'Found'} account ${r.accountId}. Schedules written UNCONFIRMED. To confirm each exactly as printed above:`);
    for (const s of r.schedules) out(`  node scripts/billing/account.ts confirm --schedule ${s.id} --fingerprint ${s.fingerprint} --by <you>`);
    return;
  }
  if (sub === 'show') {
    const tenant = flag(CMD, 'tenant');
    const account = flag(CMD, 'account');
    await show({ ...(tenant === undefined ? {} : { tenant }), ...(account === undefined ? {} : { account }) });
    return;
  }
  if (sub === 'confirm') {
    const schedule = flag(CMD, 'schedule') ?? die(CMD, '--schedule <id> is required');
    const fp = flag(CMD, 'fingerprint') ?? die(CMD, '--fingerprint <fp> (printed by propose --apply or show) is required');
    const by = flag(CMD, 'by') ?? die(CMD, '--by <your name> is required');
    const { data, error } = await db.rpc('billing_confirm_schedule', { p_schedule: schedule, p_expected: fp, p_by: by });
    if (error) die(CMD, error.message, 1);
    out(data === true ? `Confirmed ${schedule}. It is invoiced from its first month, once BILLING_MODE allows its account.` : `${schedule} was already confirmed; nothing changed.`);
    return;
  }
  if (sub === 'email') {
    const account = flag(CMD, 'account') ?? die(CMD, '--account <id> is required');
    const email = flag(CMD, 'email') ?? die(CMD, '--email is required');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) die(CMD, `${email} is not an e-mail address`);
    const { error } = await db.from('billing_accounts').update({ email }).eq('id', account);
    if (error) die(CMD, error.message, 1);
    out(`E-mail set. Messages already queued keep the address they were queued with.`);
    return;
  }
  if (sub === 'end-schedule' || sub === 'advance') {
    const schedule = flag(CMD, 'schedule') ?? die(CMD, '--schedule <id> is required');
    const by = flag(CMD, 'by') ?? die(CMD, '--by <your name> is required');
    const patch = sub === 'end-schedule'
      ? { active: false }
      : { next_month: `${flag(CMD, 'to') ?? die(CMD, '--to YYYY-MM is required')}-01` };
    const { data, error } = await db.from('billing_schedules').update(patch).eq('id', schedule).select('account_id').maybeSingle();
    if (error) die(CMD, error.message, 1);
    if (data === null) die(CMD, `no schedule ${schedule}`);
    const { error: evErr } = await db.from('billing_events').insert({ account_id: (data as Record<string, unknown>)['account_id'], kind: `schedule.${sub}`, detail: { schedule_id: schedule, by, ...patch } });
    out(`${sub === 'end-schedule' ? 'Ended' : 'Moved'} ${schedule}.${evErr ? ` The audit event was NOT written: ${evErr.message}` : ''}`);
    return;
  }
  if (sub === 'end-account') {
    const account = flag(CMD, 'account') ?? die(CMD, '--account <id> is required');
    const by = flag(CMD, 'by') ?? die(CMD, '--by <your name> is required');
    const { error } = await db.from('billing_accounts').update({ status: 'ended' }).eq('id', account);
    if (error) die(CMD, error.message, 1);
    const { error: evErr } = await db.from('billing_events').insert({ account_id: account, kind: 'account.ended', detail: { by } });
    if (evErr) out(`The audit event was NOT written: ${evErr.message}`);
    out('Ended: no new invoices. Open invoices stay open until paid or withdrawn (settle.ts resolve --outcome void).');
    return;
  }
  die(CMD, 'usage: account.ts propose|show|confirm|email|end-schedule|advance|end-account … (see the top of this file)');
}

main().catch((e) => die(CMD, e instanceof Error ? e.message : String(e), 1));
