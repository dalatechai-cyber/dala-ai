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
out(`\nallowed_numbers would become (${numbers.length}): ${numbers.join(', ') || '(none)'}`);
out('Every numeral the bot would be permitted to type. Read it as a list of permissions.');

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

const applied = await applyIntake(db, doc, existing === null ? null : String((existing as Record<string, unknown>)['id']));
for (const line of applied) out(`  ${line}`);

// ---- record where this tenant stands -------------------------------------
const recorded = await recordReadiness(db, doc.slug, readiness, now);
out(`\nreadiness recorded: ${recorded.recorded}${recorded.recorded === 'failed' ? ` — ${recorded.detail}` : ''}`);
out(readiness.stage === 'ready'
  ? '\nRows are in. The sentences are UNREVIEWED: sign them, then publish.'
  : `\nRows are in, and this tenant is at ${readiness.stage}. It will appear in the daily digest until it is ready.`);
out('\n' + reviewSheet(doc, { numbers, findings, readiness }));

// --------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';

/** Write the rows, in foreign-key order, reporting each step. Throws nothing silently. */
async function applyIntake(
  db: SupabaseClient, d: IntakeDocument, tenantId: string | null,
): Promise<string[]> {
  const log: string[] = [];
  const fail = (what: string, detail: string): never => die(`${what}: ${detail}`);

  // 1. The tenant. `status` is left at its default `provisioning` and never advanced here —
  //    `active` needs a probe run, and a script that wrote it would be asserting a test it
  //    did not run.
  // Written inline rather than through a named const, and the reason is a check rather
  // than a style: `scripts/verify/postgrest.ts` reads payloads statically, so a payload
  // behind a variable is UNCHECKED — it cannot see that every column the database requires
  // is present. A `tenants` upsert carries four of them.
  const { data: t, error: tErr } = await db
    .from('tenants').upsert({
      slug: d.slug,
      display_name: d.business.displayName,
      vertical: d.business.vertical,
      timezone: d.business.timezone,
      default_locale: d.business.locale,
      currency_symbol: d.business.currencySymbol,
      currency_symbol_before: d.business.currencySymbolBefore,
    }, { onConflict: 'slug' }).select('id').maybeSingle();
  if (tErr) fail('tenants', tErr.message);
  const id = String((t as Record<string, unknown>)['id']);
  log.push(`${tenantId === null ? 'created' : 'updated'} tenant ${d.slug} (${id})`);

  // 2. Hours, contacts, booking — plain facts, keyed by their own primary keys.
  if (d.hours.length > 0) {
    const { error } = await db.from('business_hours').upsert(
      d.hours.map((h) => ({
        tenant_id: id, weekday: h.weekday, opens: h.opens, closes: h.closes, closed: h.closed,
      })), { onConflict: 'tenant_id,weekday' });
    if (error) fail('business_hours', error.message);
    log.push(`${d.hours.length} business_hours`);
  }
  if (d.contacts.length > 0) {
    const { error } = await db.from('contact_points').upsert(
      d.contacts.map((c) => ({ tenant_id: id, kind: c.kind, value: c.value })),
      { onConflict: 'tenant_id,kind' });
    if (error) fail('contact_points', error.message);
    log.push(`${d.contacts.length} contact_points`);
  }
  {
    const mode = d.booking.url === null ? 'phone' : 'link';
    const { error } = await db.from('tenant_booking').upsert(
      { tenant_id: id, mode, booking_url: d.booking.url }, { onConflict: 'tenant_id' });
    if (error) fail('tenant_booking', error.message);
    log.push(`tenant_booking mode=${mode}`);
  }

  // 3. Sentences. NEVER `reviewed_at`, and an unchanged body is not rewritten — see the
  //    header. `reviewed_by` is left alone for the same reason: it is half of a signature.
  const { data: haveRows, error: haveErr } = await db
    .from('canned_responses').select('kind, body').eq('tenant_id', id);
  if (haveErr) fail('canned_responses', haveErr.message);
  const have = new Map(
    (Array.isArray(haveRows) ? haveRows : [])
      .map((r) => [String((r as Record<string, unknown>)['kind']), String((r as Record<string, unknown>)['body'])]),
  );
  const changed = Object.entries(d.sentences).filter(([kind, body]) => have.get(kind) !== body);
  if (changed.length > 0) {
    const { error } = await db.from('canned_responses').upsert(
      changed.map(([kind, body]) => ({
        tenant_id: id, kind, locale: d.business.locale, body,
        // Written explicitly rather than omitted: on an UPDATE an omitted column keeps its
        // old value, so a changed sentence would silently inherit the previous signature.
        reviewed_at: null, reviewed_by: null,
      })), { onConflict: 'tenant_id,kind,locale' });
    if (error) fail('canned_responses', error.message);
    const untouched = Object.keys(d.sentences).length - changed.length;
    log.push(`${changed.length} canned_responses written UNREVIEWED (${untouched} unchanged, signatures untouched)`);
  } else {
    log.push('canned_responses unchanged — no signature disturbed');
  }

  // 4. Rules BEFORE variants: `service_variants.refusal_topic` is a foreign key into this
  //    table, so a `price_kind='none'` service inserted first is refused by the database.
  if (d.neverSay.length > 0) {
    const { error } = await db.from('out_of_scope_topics').upsert(
      d.neverSay.map((n) => ({
        tenant_id: id, topic_key: n.key, matcher: { stems: n.stems },
        decision_question: n.question, response_kind: n.responseKind,
        // `seeded`, for the reason spelled out above `comment_rules` below: the client
        // answered a questionnaire, they did not review a matcher, and only a person who
        // has read the rule may write `tenant_confirmed` (D-020).
        provenance: 'seeded',
      })), { onConflict: 'tenant_id,topic_key' });
    if (error) fail('out_of_scope_topics', error.message);
    log.push(`${d.neverSay.length} out_of_scope_topics`);
  }

  // 4b. Comment rules (D-085). Which PUBLIC comments deserve a reply.
  //
  // `enabled: false` on every row, always, and this script has no flag to change that —
  // the same shape as `reviewed_at`, one surface over. A comment rule decides whether the
  // business speaks under its own post, where a mistake is public, permanent and
  // screenshot-able; switching one on is an operator reading it, not a provisioner
  // guessing. `classifyComment` refuses `no_rules` until somebody does, so the tenant
  // stays silent rather than answering wrongly.
  //
  // `provenance` is `seeded`, never `tenant_confirmed` (D-020): the client filled in a
  // questionnaire, they did not review a matcher. Only a person who has read the rule can
  // upgrade that, and this script is not one.
  if (d.commentRules.length > 0) {
    const { error } = await db.from('comment_rules').upsert(
      d.commentRules.map((c) => ({
        tenant_id: id, rule_key: c.key, verdict: c.verdict, matcher: c.matcher,
        enabled: false, provenance: 'seeded',
      })), { onConflict: 'tenant_id,rule_key' });
    if (error) fail('comment_rules', error.message);
    log.push(`${d.commentRules.length} comment_rules (all disabled)`);
  }

  // 5. Services, then their variants and aliases. `unique (tenant_id, name)` is what makes
  //    this idempotent: the same document re-run updates in place rather than duplicating.
  for (const s of d.services) {
    const { data: row, error } = await db.from('services').upsert(
      { tenant_id: id, name: s.name, category: s.category, duration_minutes: s.durationMinutes },
      { onConflict: 'tenant_id,name' }).select('id').maybeSingle();
    if (error) fail(`services «${s.name}»`, error.message);
    const serviceId = String((row as Record<string, unknown>)['id']);

    const { error: vErr } = await db.from('service_variants').upsert(
      s.variants.map((v) => ({
        tenant_id: id, service_id: serviceId, variant_key: v.variantKey,
        price_kind: v.priceKind, price_min: v.priceMin, price_max: v.priceMax,
        refusal_topic: v.refusalTopic,
        // The client's signature on the facts, carried onto the row that holds the number.
        confirmed_at: d.confirmedBy === null ? null : new Date(d.confirmedBy.at).toISOString(),
      })), { onConflict: 'tenant_id,service_id,variant_key' });
    if (vErr) fail(`service_variants «${s.name}»`, vErr.message);

    if (s.aliases.length > 0) {
      const { error: aErr } = await db.from('service_aliases').upsert(
        // `provenance` again, and this row is the reason to state the rule rather than fix
        // the one error a run reports: `out_of_scope_topics` is written at step 4 and this
        // at step 5, so the first refusal aborted the transaction before the second could
        // be reached. Fixing only what the log named would have failed on the next run.
        s.aliases.map((alias) => ({ tenant_id: id, service_id: serviceId, alias, provenance: 'seeded' })),
        { onConflict: 'tenant_id,alias' });
      if (aErr) fail(`service_aliases «${s.name}»`, aErr.message);
    }
  }
  const aliases = d.services.reduce((n, s) => n + s.aliases.length, 0);
  log.push(`${d.services.length} services, ${d.services.reduce((n, s) => n + s.variants.length, 0)} variants, ${aliases} aliases`);
  return log;
}
