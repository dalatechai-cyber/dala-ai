/**
 * One billing run from the founder's shell (D-156) — the same engine the hourly worker runs.
 *
 *     node scripts/billing/tick.ts --mode test                     # test accounts only
 *     node scripts/billing/tick.ts --mode test --drafts            # …with the unsigned wording, marked as a draft
 *     node scripts/billing/tick.ts --mode test --today 2026-10-08  # …as if it were that Ulaanbaatar day
 *     node scripts/billing/tick.ts --mode live                     # what the worker does under BILLING_MODE=live
 *
 * Needs, in the environment: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_PUBLISH, DALA_PUBLIC_URL
 * and BILLING_LINK_SECRET (the SAME values as the deployment, or its pay page cannot open the
 * links this sends), the QPay variables, BREVO_API_KEY, BILLING_FOUNDER_EMAIL,
 * TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID.
 *
 * `--drafts` and `--today` are refused with `--mode live`: a live client never receives a
 * draft, and a live invoice is never issued for a day that has not come.
 */
import { PLATFORM_TIMEZONE } from '../../src/config/platform.ts';
import { localDayStart } from '../../src/lib/time/clock.ts';
import { billingLinkSecret, billingOrigin, founderEmail, qpayConfigFromEnv } from '../../src/lib/billing/config.ts';
import { runBillingTick, type BillingDeps } from '../../src/lib/billing/engine.ts';
import { oraEventSender } from '../../src/lib/billing/ora.ts';
import { linksFor } from '../../src/lib/billing/links.ts';
import { quickQr } from '../../src/lib/billing/qpay.ts';
import { sendBrevoEmail, sendFounderTelegram } from '../../src/lib/billing/send.ts';
import { loadSignedWording } from '../../src/lib/billing/templates.ts';
import { die, draftWording, flag, has, operatorDb, out, refuseCredentialArgs } from './_common.ts';

const CMD = 'billing/tick';
refuseCredentialArgs(CMD);

async function main(): Promise<void> {
  const mode = flag(CMD, 'mode');
  if (mode !== 'test' && mode !== 'live') die(CMD, '--mode test|live is required');
  const today = flag(CMD, 'today');
  if (mode === 'live' && (today !== undefined || has('drafts'))) die(CMD, '--today and --drafts are for --mode test only');
  // The shell obeys the same switch as the deployment: live only once the founder set it.
  if (mode === 'live' && process.env['BILLING_MODE'] !== 'live') die(CMD, '--mode live needs BILLING_MODE=live in this shell (the switch Vercel carries)');
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(today)) die(CMD, '--today is YYYY-MM-DD');
  const now = today === undefined ? new Date() : new Date(localDayStart(today, PLATFORM_TIMEZONE).getTime() + 12 * 3_600_000);
  const db = operatorDb();
  const signed = await loadSignedWording(db);
  if (!signed.ok) die(CMD, signed.detail, 1);
  const deps: BillingDeps = {
    db, now, mode,
    qpay: quickQr(qpayConfigFromEnv()),
    links: linksFor(billingOrigin(), billingLinkSecret()),
    signed: signed.wording,
    ...(has('drafts') ? { draftsForTest: draftWording() } : {}),
    sendEmail: (m) => sendBrevoEmail(m),
    sendTelegram: (m) => sendFounderTelegram(m),
    sendOraEvent: oraEventSender(),
    founderEmail: founderEmail(),
    log: (level, event, detail) => { if (level !== 'info') process.stderr.write(`${level} ${event} ${JSON.stringify(detail)}\n`); },
  };
  const r = await runBillingTick(deps);
  const rep = r.report;
  out(`billing run (${mode}) for ${rep.today} Ulaanbaatar${today === undefined ? '' : ' [simulated day]'}`);
  out(`  issued ${rep.issued}, behind ${rep.behind}, QPay invoices made ${rep.qpayCreated}, checked ${rep.checked}, payments recorded ${rep.paymentsRecorded}`);
  out(`  messages planned ${rep.planned}, sent ${rep.sent}, retrying ${rep.retrying}, failed ${rep.failed}, unknown ${rep.unknown}`);
  for (const p of rep.problems) out(`  problem: ${p}`);
  if (!r.ok) die(CMD, r.detail, 1);
}

main().catch((e) => die(CMD, e instanceof Error ? e.message : String(e), 1));
