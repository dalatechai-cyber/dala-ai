/**
 * Turn a filled questionnaire into a provisioned tenant's rows.
 *
 *     # dry run — validates, prints the plan and the projected allow-list, writes NOTHING
 *     NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_PUBLISH=… \
 *       node scripts/provision/apply.ts --file intake/gs-auto.json
 *
 *     # and then, having read that
 *     … node scripts/provision/apply.ts --file intake/gs-auto.json --apply
 *
 * ## What this is NOT allowed to do
 *
 * It does not set `reviewed_at`, ever, on any row. That column is the founder's signature on
 * a sentence a customer will read, and a provisioning script that could write it would be a
 * machine approving machine-written Mongolian — the review gate defeated by the tool built
 * to serve it. Every canned row this writes lands unreviewed, the reply path refuses an
 * unreviewed row, and the tenant cannot answer until a human has read the sheet.
 *
 * It does not publish. `compileAndPublish` is a separate command, run after the review, and
 * that ordering is the second gate.
 *
 * ## The two gates, stated as the two signatures this script cannot forge
 *
 *  1. **The client's**, on the FACTS. `confirmedBy` in the document: a name and a date
 *     saying these prices and these hours are right. `validateIntake` makes its absence a
 *     blocker, because the price guarantee reduces to "the tenant said this number" — there
 *     is no mechanism underneath that, only the claim.
 *  2. **The founder's**, on the WORDS. `canned_responses.reviewed_at`, set by hand after
 *     reading the sheet this script prints. Nothing here touches it.
 *
 * ## Idempotent, and one exception that looks like a bug and is not
 *
 * Re-running with the same document changes nothing. Re-running with a CHANGED canned body
 * rewrites the row and clears `reviewed_at`, which un-approves the sentence and stops the
 * tenant replying until it is read again. That is correct: an edited sentence is an
 * unreviewed sentence, and D-065's whole finding is that a near-copy of an approved line is
 * not the approved line. An unchanged body is left completely alone — writing it back would
 * clear a signature for no reason, which is the same defect in the other direction.
 */
import { readFileSync } from 'node:fs';
import { readIntake, type IntakeDocument } from '../../src/lib/provision/intake.ts';
import {
  assessReadiness, projectedAllowedNumbers, validateIntake,
} from '../../src/lib/provision/validate.ts';
import { recordReadiness } from '../../src/lib/provision/record.ts';
import { reviewSheet } from '../../src/lib/provision/reviewSheet.ts';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { applyIntake, WriteError } from '../../src/lib/provision/write.ts';

function die(message: string): never {
  process.stderr.write(`provision: ${message}\n`);
  process.exit(2);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const out = (s: string) => process.stdout.write(`${s}\n`);

if (process.argv.some((a) => a.startsWith('--key') || a.startsWith('--secret'))) {
  die('the key is read from SUPABASE_SECRET_PUBLISH in the environment, never from an argument');
}
const file = arg('file') ?? die('--file is required, e.g. --file intake/gs-auto.json');
const doApply = process.argv.includes('--apply');

// ---- read the document ---------------------------------------------------
let parsed: unknown;
try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
  die(`${file} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
}
const read = readIntake(parsed);
if (!read.ok) {
  out(`REFUSED — ${read.problems.length} shape problem${read.problems.length === 1 ? '' : 's'}:`);
  // Every one at once. A validator that stops at the first sends the operator back to the
  // client as many times as there are mistakes; Matrix took days of exactly that.
  for (const p of read.problems) out(`  ${p.path}: ${p.detail}`);
  process.exit(2);
}
const doc: IntakeDocument = read.doc;

// ---- validate ------------------------------------------------------------
const now = new Date();
const findings = validateIntake(doc, now);
const readiness = assessReadiness(doc, now);
const blockers = findings.filter((f) => f.severity === 'blocker');

out(`\nTenant     ${doc.slug} — ${doc.business.displayName} (${doc.business.vertical})`);
out(`Confirmed  ${doc.confirmedBy === null ? 'NOT CONFIRMED BY THE CLIENT' : `${doc.confirmedBy.name}, ${doc.confirmedBy.at}`}`);
out(`Readiness  ${readiness.stage}`);
for (const w of readiness.waitingOn) out(`  waiting on: ${w}`);

if (findings.length > 0) out('');
for (const f of findings) out(`  [${f.severity}] ${f.code}: ${f.detail}`);

// The projected allow-list is PRINTED, always, and blocks nothing. D-055 and D-074 were both
// a numeral nobody meant to approve; neither was a wrong rule, both were a list nobody read.
const numbers = projectedAllowedNumbers(doc, now);
out(`\nallowed_numbers FROM THIS DOCUMENT (${numbers.length}): ${numbers.join(', ') || '(none)'}`);
out('Every numeral this document would permit. Read it as a list of permissions.');
out('NOT a prediction of the live list: knowledge-base, clarify and deposit rows are not in');
out('an intake document, and they license numerals too. Matrix 2026-09-21 — 7 here, 13 live.');

if (blockers.length > 0) die(`${blockers.length} blocker(s) above — nothing written`);

// ---- plan, then write ----------------------------------------------------
const db = supabasePublish();
const { data: existing, error: exErr } = await db
  .from('tenants').select('id, slug').eq('slug', doc.slug).maybeSingle();
if (exErr) die(`tenants unreadable: ${exErr.message}`);

if (!doApply) {
  out(`\nDRY RUN — nothing written. ${existing === null ? 'Tenant would be CREATED.' : 'Tenant exists; rows would be reconciled.'}`);
  out('Re-run with --apply to write. Sentences land UNREVIEWED and the tenant cannot reply');
  out('until the founder signs the sheet below and a publish follows.\n');
  out(reviewSheet(doc, { numbers, findings, readiness }));
  process.exit(0);
}

let applied: string[];
try {
  applied = await applyIntake(db, doc, existing === null ? null : String((existing as Record<string, unknown>)['id']));
} catch (e) {
  die(e instanceof WriteError ? e.message : `unexpected: ${e instanceof Error ? e.message : String(e)}`);
}
for (const line of applied) out(`  ${line}`);

// ---- record where this tenant stands -------------------------------------
const recorded = await recordReadiness(db, doc.slug, readiness, now);
out(`\nreadiness recorded: ${recorded.recorded}${recorded.recorded === 'failed' ? ` — ${recorded.detail}` : ''}`);
out(readiness.stage === 'ready'
  ? '\nRows are in. The sentences are UNREVIEWED: sign them, then publish.'
  : `\nRows are in, and this tenant is at ${readiness.stage}. It will appear in the daily digest until it is ready.`);
out('\n' + reviewSheet(doc, { numbers, findings, readiness }));
