/**
 * Onboard a client from their filled questionnaire. One command, re-run as the client and
 * the founder answer.
 *
 *     # 1. read the form, print everything it would write — writes NOTHING
 *     node scripts/onboard/tenant.ts --form tara-park-od.docx --slug tara-park-od \
 *       --facebook-page-id 1234567890
 *
 *     # 2. write the tenant (shadow), and the three documents under onboarding/<slug>/
 *     … --apply
 *
 *     # 3. the founder signs the wording sheet; the client confirms the summary
 *     … --apply --sign-wording <sheet id> --signed-by Bilguun
 *     … --apply --client-confirmed "Болор" --confirmed-on 2026-10-01 --summary <summary id>
 *
 *     # the name Bilguun reads (daily report, Telegram, billing alerts, these documents), when it
 *     # is not the form's 1.1 — e.g. one brand with several branches:
 *     … --display-name "Tara Salon — Парк Од"
 *     #   1.1 stays the name the bot says to customers; this changes only the label. Given
 *     #   once, it is kept on every later run (a re-run without it never reverts it), and
 *     #   a name another tenant already carries is refused.
 *
 *     # billing (D-156), optional, on any run: the client's billing record, UNCONFIRMED
 *     … --billing-name "Тара Парк ОД ХХК" --billing-staff "Дали — AI хүлээн авагч=250000" \
 *       --billing-start 2026-11 [--billing-email owner@example.mn] [--billing-annual]
 *     #   printed on a dry run, written with --apply; `scripts/billing/account.ts confirm` then
 *     #   confirms the amounts. Nothing is invoiced before that confirmation.
 *
 * Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_PUBLISH` (the operator's; never set in
 * cloud sessions), and `npm install`. Calls no model and spends nothing.
 *
 * ## What it will not do
 *
 * - **Touch a tenant that has been live.** Refused before anything is read further
 *   (`refuseForeignTenant`), nor one onboarding did not create. The live tenants change
 *   through reviewed scripts only.
 * - **Put anything live.** Channels are written in `shadow` with no token; an existing
 *   channel row is left exactly as it is. Going live stays a manual step after both gates.
 * - **Grant spend.** No `tenant_roles` entitlement, no budget row (money waits for the founder).
 * - **Invent a fact.** A blank or unreadable answer is recorded as missing, listed in the
 *   report and the client summary, and held in the daily report until answered.
 * - **Sign anything by itself.** A signature needs the id of the sheet or summary a person
 *   read; a line or fact changed after that is not covered and the id is refused.
 * - **Seal a token.** That is `scripts/kek/seal.ts`, by hand (see the report's last section).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formBlocks } from '../../src/lib/provision/formFile.ts';
import { readQuestionnaire } from '../../src/lib/provision/questionnaire.ts';
import { planFromForm, type Templates } from '../../src/lib/provision/plan.ts';
import { generateCases } from '../../src/lib/provision/cases.ts';
import { projectedAllowedNumbers, validateIntake } from '../../src/lib/provision/validate.ts';
import { applyIntake, WriteError } from '../../src/lib/provision/write.ts';
import {
  activateCases, deactivateCases, readSteps, recordStep, refuseForeignChannels, refuseForeignTenant, rowsNotInForm, STEP,
  writeOnboarding,
} from '../../src/lib/provision/onboardWrite.ts';
import {
  clientSummary, confirmFacts, gateStatus, loadFacts, loadWording, onboardReadiness, signWording, wordingSheet,
} from '../../src/lib/provision/onboardGates.ts';
import { recordReadiness } from '../../src/lib/provision/record.ts';
import { onboardingReport } from '../../src/lib/provision/onboardReport.ts';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { ubStamp } from '../../src/lib/time/ub.ts';
import { factGate } from '../facts/gate.ts';
import { parseStaff, type StaffPrice } from '../../src/lib/billing/amounts.ts';
import { billingToday, monthOf } from '../../src/lib/billing/calendar.ts';
import { phrasesFrom, planSchedules, writeBillingRecord, type PlannedSchedule } from '../../src/lib/billing/setup.ts';
import { formatMnt } from '../../src/lib/billing/templates.ts';
import { labelWording } from '../billing/_common.ts';

const out = (s = '') => process.stdout.write(`${s}\n`);
function die(message: string, code = 2): never {
  process.stderr.write(`onboard: ${message}\n`);
  process.exit(code);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`--${name} needs a value`);
  return v;
}
if (process.argv.some((a) => a.startsWith('--key') || a.startsWith('--secret') || a.startsWith('--token'))) {
  die('credentials are read from the environment, never from an argument; tokens are sealed by hand (scripts/kek/seal.ts)');
}

const formPath = arg('form') ?? die('--form <file> is required (.docx, or a .md/.txt export)');
const slug = arg('slug') ?? die('--slug <slug> is required, e.g. --slug tara-park-od');
// ascii-safe: a slug is an identifier this platform assigns, never customer text.
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) die('--slug must be lower-case words joined by hyphens');
const vertical = arg('vertical');
// ascii-safe: a vertical is a platform identifier.
if (vertical !== undefined && !/^[a-z_]+$/.test(vertical)) die('--vertical must be a lower-case identifier, e.g. salon');
const facebookPageId = arg('facebook-page-id');
const instagramId = arg('instagram-id');
// ascii-safe: Meta ids are digits.
for (const [k, v] of [['facebook-page-id', facebookPageId], ['instagram-id', instagramId]] as const) {
  if (v !== undefined && !/^\d{6,20}$/.test(v)) die(`--${k} must be the numeric id`);
}
const doApply = process.argv.includes('--apply');
const signId = arg('sign-wording');
const signedBy = arg('signed-by');
const confirmedBy = arg('client-confirmed');
const confirmedOn = arg('confirmed-on');
const summaryId = arg('summary');
if (signId !== undefined && signedBy === undefined) die('--sign-wording needs --signed-by <name>');
if (confirmedBy !== undefined && (confirmedOn === undefined || summaryId === undefined)) {
  die('--client-confirmed needs --confirmed-on <YYYY-MM-DD> and --summary <id from the summary the client read>');
}
// ascii-safe: an ISO date typed by the operator.
if (confirmedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(confirmedOn)) die('--confirmed-on is YYYY-MM-DD');
if ((signId !== undefined || confirmedBy !== undefined) && !doApply) die('a signature is a write: add --apply');
const outDir = arg('out') ?? join('onboarding', slug);
// Rule 6: operator-typed Mongolian is NFC-normalised at the boundary, like every other input.
const displayNameArg = arg('display-name')?.normalize('NFC').replace(/\s+/gu, ' ').trim();
if (displayNameArg === '') die('--display-name needs a name');

// ---- billing (D-156): parsed now, so a mistyped amount refuses before anything is written
const billingStaffArgs = process.argv.flatMap((a, i) => (a === '--billing-staff' ? [process.argv[i + 1] ?? ''] : []));
let billingStaff: StaffPrice[] = [];
try {
  billingStaff = billingStaffArgs.map((v) => parseStaff(v));
} catch (e) {
  die(`--billing-staff: ${e instanceof Error ? e.message : String(e)}`);
}
const billingName = arg('billing-name');
const billingStart = arg('billing-start');
const billingEmail = arg('billing-email');
if (billingStaff.length > 0 && (billingName === undefined || billingStart === undefined)) {
  die('--billing-staff needs --billing-name "<legal name as in the contract>" and --billing-start YYYY-MM');
}

// ---- 1. read the form -------------------------------------------------------------------
let blocks;
try {
  blocks = formBlocks(formPath, readFileSync(formPath));
} catch (e) {
  die(`${formPath}: ${e instanceof Error ? e.message : String(e)}`);
}
const read = readQuestionnaire(blocks);
if (!read.ok) {
  out(`REFUSED — «${formPath}» is not the questionnaire this command reads (${read.problems.length} problem${read.problems.length === 1 ? '' : 's'}):`);
  for (const p of read.problems) out(`  ${p.where}: ${p.detail}`);
  process.exit(2);
}

const root = new URL('../provision/templates/', import.meta.url);
const templates = JSON.parse(readFileSync(new URL('onboarding.mn.json', root), 'utf8')) as Templates;
const plan = planFromForm(read.answers, {
  slug, templates,
  ...(vertical === undefined ? {} : { vertical }),
  ...(facebookPageId === undefined ? {} : { facebookPageId }),
  ...(instagramId === undefined ? {} : { instagramId }),
});
// Comment rules: the vertical's template, only when the client asked for comment replies.
// Every rule lands DISABLED (`applyIntake`), and the channel's comment mode stays `off`.
const commentTemplate = new URL(`comment_rules.${plan.vertical.value}.json`, root);
if (plan.commentsRequested) {
  if (existsSync(commentTemplate)) {
    const t = JSON.parse(readFileSync(commentTemplate, 'utf8')) as { rules: { rule_key: string; verdict: string; matcher: unknown }[] };
    plan.intake.commentRules = t.rules.map((r) => ({ key: r.rule_key, verdict: r.verdict, matcher: r.matcher }));
  } else {
    plan.manual.push(`2.2: comment replies were requested and there is no comment_rules.${plan.vertical.value}.json template; comments stay off until rules are written.`);
  }
}
const cases = generateCases(plan.intake, plan.deposits);
const now = new Date();
const findings = validateIntake(plan.intake, now).filter((f) => f.code !== 'facts_unconfirmed');
const blockers = findings.filter((f) => f.severity === 'blocker');

out(`\nTenant     ${slug} — form 1.1 «${plan.intake.business.displayName}»`);
out(`Vertical   ${plan.vertical.value} (${plan.vertical.reason})`);
out(`Form       ${formPath}, filled by ${plan.signer.name || '(not signed)'} ${plan.signer.date}`);
out(`Rows       ${plan.intake.services.length} services · ${plan.intake.hours.length} days of hours · ${plan.intake.contacts.length} contacts · ${plan.staff.length} staff · ${plan.intake.faqs.length} FAQs · ${plan.deposits.length} deposit rules · ${plan.documents.length} knowledge documents · ${plan.intake.neverSay.length} never-say rules · ${Object.keys(plan.intake.sentences).length} sentences to sign · ${cases.length} reply cases`);
out(`Channels   ${plan.channels.map((c) => `${c.provider} ${c.externalId ?? '(no id)'}`).join(', ') || '(none)'} — shadow`);
out(`\nMissing (${plan.missing.length}):`);
for (const m of plan.missing) out(`  [${m.holdsReady ? 'holds' : 'ask'}] ${m.audience} · form ${m.question}: ${m.what}`);
out(`\nFindings (${findings.length}):`);
for (const f of findings) out(`  [${f.severity}${f.holdsReady === true ? ', holds' : ''}] ${f.code}: ${f.detail}`);
out(`\nallowed_numbers from this form: ${projectedAllowedNumbers(plan.intake, now).join(', ') || '(none)'}`);

if (blockers.length > 0) die(`${blockers.length} blocker(s) above — nothing written. Fix the form or its answers and re-run.`);

// ---- 2. the database ------------------------------------------------------------------------
const db = supabasePublish();
let tenantId: string | null;
try {
  ({ tenantId } = await refuseForeignTenant(db, slug));
  await refuseForeignChannels(db, slug, plan);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

// ---- the name people read ------------------------------------------------------------------
// `tenants.display_name` is the label in the daily report, Telegram alerts, billing alerts and
// these documents. It is the form's 1.1 unless the operator names it, and once named it is not
// silently undone: a re-run without --display-name keeps what the tenant already carries. The
// customer-facing sentences keep 1.1 either way (`planFromForm` filled them before this).
let displayName: string;
let nameFrom: string;
try {
  const { data: t, error } = await db.from('tenants').select('display_name').eq('slug', slug).maybeSingle();
  if (error) throw new Error(`tenants unreadable: ${error.message}`);
  const stored = t === null ? '' : String((t as Record<string, unknown>)['display_name'] ?? '');
  if (displayNameArg !== undefined) [displayName, nameFrom] = [displayNameArg, '--display-name'];
  else if (stored !== '') [displayName, nameFrom] = [stored, 'kept from the tenant; --display-name changes it'];
  else [displayName, nameFrom] = [plan.intake.business.displayName, 'the form, 1.1'];
  // Two tenants with one label are one line in every report: refuse rather than guess which.
  // Compared case-folded, with every dash one dash and spaces collapsed, so «Tara Salon - Яармаг»
  // does not pass as a different name from «Tara Salon — Яармаг».
  const fold = (v: string) => v.normalize('NFC').toLocaleLowerCase('mn').replace(/\p{Pd}/gu, '-').replace(/\s+/gu, ' ').trim();
  const { data: others, error: othersErr } = await db.from('tenants').select('slug, display_name').neq('slug', slug);
  if (othersErr) throw new Error(`tenants unreadable: ${othersErr.message}`);
  const taken = (others ?? []).map((r) => r as Record<string, unknown>)
    .filter((r) => fold(String(r['display_name'] ?? '')) === fold(displayName)).map((r) => String(r['slug']));
  if (taken.length > 0) {
    throw new Error(`«${displayName}» is already the name of ${taken.join(', ')}; give this tenant its own with --display-name "<name>"`);
  }
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
plan.intake.business.displayName = displayName;
out(`Name       ${displayName} (${nameFrom})`);

let billingPlan: PlannedSchedule[] = [];
if (billingStaff.length > 0) {
  try {
    const { wording: lw, note } = await labelWording(db, false);
    billingPlan = planSchedules({ staff: billingStaff, annual: process.argv.includes('--billing-annual'), startMonth: billingStart!, dueDay: 5 },
      phrasesFrom(lw), monthOf(billingToday(now)));
    out(`\nBilling — ${billingName} (${note}); written UNCONFIRMED with --apply:`);
    for (const b of billingPlan) {
      out(`  ${b.kind} from ${b.nextMonth.slice(0, 7)}: ${formatMnt(b.amountMnt)} (${b.why})`);
      for (const l of b.lines) out(`      ${l.label} ${formatMnt(l.amount_mnt)}`);
    }
  } catch (e) {
    die(`billing: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (!doApply) {
  out(`\nDRY RUN — nothing written. ${tenantId === null ? 'The tenant would be CREATED.' : 'The tenant exists (created by onboarding, never live); its rows would be reconciled.'}`);
  out('Re-run with --apply to write it in shadow and produce the report, the wording sheet and the client summary.');
  process.exit(0);
}

const log: string[] = [];
let signed = 0;
let confirmed = 0;
let activated = 0;
try {
  log.push(...await applyIntake(db, plan.intake, tenantId));
  const { data: t, error } = await db.from('tenants').select('id').eq('slug', slug).maybeSingle();
  if (error || t === null) throw new WriteError(`tenant «${slug}» unreadable after writing: ${error?.message ?? 'no row'}`);
  const id = String((t as Record<string, unknown>)['id']);
  tenantId = id;
  // Recorded straight after the tenant exists: it is what lets the next run write it.
  await recordStep(db, id, STEP.created, { form: formPath, slug }, now);
  log.push(...await writeOnboarding(db, id, plan, cases));
  if (signId !== undefined) {
    signed = await signWording(db, id, slug, signId, signedBy!, now, (ev) => recordStep(db, id, STEP.wording, ev, now));
  }
  if (confirmedBy !== undefined) {
    confirmed = await confirmFacts(db, id, slug, summaryId!, { name: confirmedBy, on: confirmedOn! }, now,
      (ev) => recordStep(db, id, STEP.facts, ev, now));
  }
  for (const r of await rowsNotInForm(db, id, plan)) {
    plan.missing.push({ question: '—', what: `${r} is in the database and not in this form: remove it by hand or put it back in the form`, holdsReady: true, audience: 'operator' });
  }
} catch (e) {
  die(e instanceof WriteError ? e.message : `unexpected: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
}
for (const l of log) out(`  ${l}`);
if (signed > 0) out(`  signed ${signed} Mongolian lines (sheet ${signId}, by ${signedBy})`);
if (confirmed > 0) out(`  client confirmation recorded on ${confirmed} rows (summary ${summaryId}, ${confirmedBy}, ${confirmedOn})`);

// ---- 3. where it stands ------------------------------------------------------------------------
let wording: Awaited<ReturnType<typeof loadWording>>;
let facts: Awaited<ReturnType<typeof loadFacts>>;
let steps: Map<string, Record<string, unknown>>;
try {
  [wording, facts, steps] = await Promise.all([loadWording(db, tenantId!), loadFacts(db, tenantId!), readSteps(db, tenantId!)]);
} catch (e) {
  die(`the rows were written but could not be read back: ${e instanceof Error ? e.message : String(e)}. Re-run the same command.`);
}
const signedId = (k: string, f: string) => { const v = steps.get(k)?.[f]; return typeof v === 'string' ? v : null; };
const gates = gateStatus(wording, facts, { wording: signedId(STEP.wording, 'sheet'), facts: signedId(STEP.facts, 'summary') });
try {
  // The fact check the first publish will run, run now: a copy of a fact that disagrees
  // with the price rows (a ₮ amount in an FAQ no service carries) is found here, not at the
  // publish, and holds the tenant.
  const fg = await factGate(db, { slug, tenantId: tenantId!, external: 'require' });
  for (const w of [...fg.wrong, ...fg.unchecked]) {
    plan.missing.push({ question: '—', what: `fact check: ${w}`, holdsReady: true, audience: 'operator' });
  }
  if (gates.wording.signed && gates.facts.confirmed && fg.wrong.length === 0 && fg.unchecked.length === 0) {
    activated = await activateCases(db, tenantId!);
    if (activated > 0) out(`  both gates passed: ${activated} reply cases switched on`);
  } else {
    // A gate that re-opened (a corrected form un-signed a line or a fact) switches them off.
    const off = await deactivateCases(db, tenantId!);
    if (off > 0) out(`  a gate is open again: ${off} reply cases switched off`);
  }
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
const readiness = onboardReadiness(plan, gates, now);
const recorded = await recordReadiness(db, slug, readiness, now);
out(`\nReadiness  ${readiness.stage} — recorded for the daily report: ${recorded.recorded}${recorded.recorded === 'failed' ? ` (${recorded.detail})` : ''}`);
out(`Wording    ${gates.wording.signed ? 'SIGNED'
  : gates.wording.pending === 0 ? `CHANGED since it was signed — re-read sheet ${gates.wording.id}`
    : `${gates.wording.pending} lines await the founder — sheet ${gates.wording.id}`}`);
out(`Facts      ${gates.facts.confirmed ? 'CONFIRMED by the client'
  : gates.facts.unconfirmed === 0 ? `CHANGED since the client confirmed — send them summary ${gates.facts.id}`
    : `${gates.facts.unconfirmed} rows await the client — summary ${gates.facts.id}`}`);

// ---- 4. the documents ----------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const files: [string, string][] = [
  ['report.md', onboardingReport({ slug, plan, findings, cases, readiness, gates, log, formPath, at: ubStamp(now) })],
  ['wording-sheet.md', wordingSheet(wording, plan, gates.wording.id, slug)],
  ['client-summary.md', clientSummary(facts, plan, templates, gates.facts.id)],
  ['intake.json', `${JSON.stringify(plan.intake, null, 2)}\n`],
];
for (const [name, body] of files) writeFileSync(join(outDir, name), body);
out(`\nWrote ${files.map(([n]) => join(outDir, n)).join(', ')}`);
if (billingPlan.length > 0) {
  try {
    const r = await writeBillingRecord(db, {
      tenantSlug: slug, isTest: false, displayName: billingName!, email: billingEmail ?? null, contractRef: null,
    }, billingPlan);
    out(`\nBilling account ${r.accountId} ${r.createdAccount ? 'created' : 'found'}; schedules written UNCONFIRMED. Confirm the amounts:`);
    for (const b of r.schedules) out(`  node scripts/billing/account.ts confirm --schedule ${b.id} --fingerprint ${b.fingerprint} --by <you>`);
  } catch (e) {
    // The tenant is written either way; billing is re-run with scripts/billing/account.ts.
    out(`\nBilling NOT written: ${e instanceof Error ? e.message : String(e)}. Run scripts/billing/account.ts propose … --apply.`);
  }
}
// The daily report is where a missing answer is seen. If it was not recorded, say so loudly.
if (recorded.recorded === 'failed') die(`readiness was NOT recorded for the daily report: ${recorded.detail}. Re-run the same command.`, 1);
