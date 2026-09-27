/**
 * The rows an intake document becomes, written in foreign-key order.
 *
 * Moved here from `scripts/provision/apply.ts` (2026-09-27) so the onboarding command
 * (`scripts/onboard/tenant.ts`) writes the same rows the same way — one writer, not two
 * that drift. Behaviour is unchanged; a failure THROWS `WriteError` where the script used
 * to exit, and each caller decides how to report it.
 *
 * Why each step looks the way it does is in the comments below, kept from the script.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntakeDocument } from './intake.ts';
import { topicMatcher } from './matchers.ts';

/** A write that failed, naming the table. Nothing after it was attempted. */
export class WriteError extends Error {}
function die(message: string): never {
  throw new WriteError(message);
}

/**
 * What each existing row already CLAIMS about where it came from, keyed by its own key.
 *
 * Read before writing, so an upsert can carry a row's existing `provenance` forward rather
 * than stamping `seeded` over it. D-020's rule is that only a person who has read a rule may
 * call it `tenant_confirmed`; the corollary nobody had written down is that a script which
 * cannot make that claim must not be able to WITHDRAW it either. Measured cost: re-running
 * this on Matrix turned `photo_consultation` from `tenant_confirmed` back to `seeded`, and
 * the only reason anybody noticed is that the next publish printed an UNCONFIRMED line.
 *
 * An unreadable table fails the run. Guessing `seeded` on a read error would downgrade every
 * row at exactly the moment the evidence is missing.
 */
function provenanceMap(data: unknown, keyColumn: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of Array.isArray(data) ? data : []) {
    const row = r as Record<string, unknown>;
    out.set(String(row[keyColumn]), String(row['provenance']));
  }
  return out;
}

/** `out_of_scope_topics.provenance`, keyed by `topic_key`. Literal select: see the type. */
async function topicProvenance(db: SupabaseClient, tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await db.from('out_of_scope_topics')
    .select('topic_key, provenance').eq('tenant_id', tenantId);
  if (error !== null) die(`out_of_scope_topics unreadable (provenance): ${error.message}`);
  return provenanceMap(data, 'topic_key');
}

/** `service_aliases.provenance`, keyed by `alias`. */
async function aliasProvenance(db: SupabaseClient, tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await db.from('service_aliases')
    .select('alias, provenance').eq('tenant_id', tenantId);
  if (error !== null) die(`service_aliases unreadable (provenance): ${error.message}`);
  return provenanceMap(data, 'alias');
}

/**
 * A comment rule's existing `enabled` and `provenance`, keyed by `rule_key`.
 *
 * `enabled` is read for a sharper reason than `provenance`. This script writes `false` on a
 * new rule deliberately — a comment is public, permanent and screenshot-able, so switching
 * one on is an operator reading it. Written unconditionally, that same `false` silently
 * switches OFF every rule an operator HAS read and enabled, on the one surface where the
 * mistake is visible to everybody. A provisioner that may not enable a rule must not be able
 * to disable one.
 */
async function commentRuleState(
  db: SupabaseClient, tenantId: string,
): Promise<Map<string, { enabled: boolean; provenance: string }>> {
  const { data, error } = await db.from('comment_rules')
    .select('rule_key, enabled, provenance').eq('tenant_id', tenantId);
  if (error !== null) die(`comment_rules unreadable (enabled/provenance): ${error.message}`);
  const out = new Map<string, { enabled: boolean; provenance: string }>();
  for (const r of Array.isArray(data) ? data : []) {
    const row = r as Record<string, unknown>;
    out.set(String(row['rule_key']), {
      enabled: row['enabled'] === true, provenance: String(row['provenance']),
    });
  }
  return out;
}

/** Write the rows, in foreign-key order, reporting each step. Throws nothing silently. */
export async function applyIntake(
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
    // A NEW row is `seeded`: the client answered a questionnaire, they did not review a
    // matcher, and only a person who has read the rule may write `tenant_confirmed`
    // (D-020). An EXISTING row keeps whatever it already claims.
    //
    // That second half was missing and it cost a real downgrade. `provenance` was written
    // unconditionally, so re-provisioning Matrix on 2026-09-21 turned `photo_consultation`
    // from `tenant_confirmed` back to `seeded` — a claim about what a human had read,
    // silently withdrawn by a script that reads nothing. The file already states the
    // principle twenty lines up, about `reviewed_by`: it is half of a signature, so it is
    // left alone. `provenance` is the same kind of fact and was not given the same care.
    const prior = await topicProvenance(db, id);
    const { error } = await db.from('out_of_scope_topics').upsert(
      d.neverSay.map((n) => ({
        tenant_id: id, topic_key: n.key, matcher: topicMatcher(n.stems),
        decision_question: n.question, response_kind: n.responseKind,
        provenance: prior.get(n.key) ?? 'seeded',
      })), { onConflict: 'tenant_id,topic_key' });
    if (error) fail('out_of_scope_topics', error.message);
    const kept = d.neverSay.filter((n) => prior.has(n.key)).length;
    log.push(`${d.neverSay.length} out_of_scope_topics (${kept} kept their provenance)`);
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
  // `provenance` is `seeded` on a NEW row, never `tenant_confirmed` (D-020): the client
  // filled in a questionnaire, they did not review a matcher. Only a person who has read
  // the rule can upgrade that, and this script is not one — which is exactly why it must
  // not write the field over an existing row either, in EITHER direction.
  //
  // `enabled` is the sharper half of the same mistake. Written unconditionally, a second
  // run of this script silently switches OFF every comment rule an operator had switched
  // on — on the surface where the business speaks under its own post. A provisioner that
  // cannot enable a rule must not be able to disable one.
  if (d.commentRules.length > 0) {
    const prior = await commentRuleState(db, id);
    const { error } = await db.from('comment_rules').upsert(
      d.commentRules.map((c) => ({
        tenant_id: id, rule_key: c.key, verdict: c.verdict, matcher: c.matcher,
        enabled: prior.get(c.key)?.enabled ?? false,
        provenance: prior.get(c.key)?.provenance ?? 'seeded',
      })), { onConflict: 'tenant_id,rule_key' });
    if (error) fail('comment_rules', error.message);
    const on = d.commentRules.filter((c) => prior.get(c.key)?.enabled === true).length;
    log.push(`${d.commentRules.length} comment_rules (${on} left enabled, the rest disabled)`);
  }

  // 5. Services, then their variants and aliases. `unique (tenant_id, name)` is what makes
  //    this idempotent: the same document re-run updates in place rather than duplicating.
  const aliasProv = await aliasProvenance(db, id);
  for (const s of d.services) {
    const { data: row, error } = await db.from('services').upsert(
      { tenant_id: id, name: s.name, category: s.category, duration_minutes: s.durationMinutes },
      { onConflict: 'tenant_id,name' }).select('id').maybeSingle();
    if (error) fail(`services «${s.name}»`, error.message);
    const serviceId = String((row as Record<string, unknown>)['id']);

    // A document with no client signature must not WITHDRAW one the client already gave
    // (2026-09-27, onboarding): re-running a corrected form would otherwise clear
    // `confirmed_at` on every price, including the ones that did not change — the
    // `reviewed_at` defect in the other direction. An unchanged price keeps its signature;
    // a changed one loses it, because the client confirmed a different number.
    const { data: prior, error: pErr } = await db.from('service_variants')
      .select('variant_key, price_kind, price_min, price_max, confirmed_at')
      .eq('tenant_id', id).eq('service_id', serviceId);
    if (pErr) fail(`service_variants «${s.name}» (prior signatures)`, pErr.message);
    const kept = (v: (typeof s.variants)[number]): string | null => {
      const p = (Array.isArray(prior) ? prior : []).map((r) => r as Record<string, unknown>)
        .find((r) => String(r['variant_key']) === v.variantKey);
      if (p === undefined || typeof p['confirmed_at'] !== 'string') return null;
      const same = (a: unknown, b: string | null) => (a === null || a === undefined ? b === null : b !== null && Number(a) === Number(b));
      return String(p['price_kind']) === v.priceKind && same(p['price_min'], v.priceMin) && same(p['price_max'], v.priceMax)
        ? p['confirmed_at'] : null;
    };

    const { error: vErr } = await db.from('service_variants').upsert(
      s.variants.map((v) => ({
        tenant_id: id, service_id: serviceId, variant_key: v.variantKey,
        price_kind: v.priceKind, price_min: v.priceMin, price_max: v.priceMax,
        refusal_topic: v.refusalTopic,
        // The client's signature on the facts, carried onto the row that holds the number.
        confirmed_at: d.confirmedBy === null ? kept(v) : new Date(d.confirmedBy.at).toISOString(),
      })), { onConflict: 'tenant_id,service_id,variant_key' });
    if (vErr) fail(`service_variants «${s.name}»`, vErr.message);

    if (s.aliases.length > 0) {
      const { error: aErr } = await db.from('service_aliases').upsert(
        // `provenance` again, and this row is the reason to state the rule rather than fix
        // the one error a run reports: `out_of_scope_topics` is written at step 4 and this
        // at step 5, so the first refusal aborted the transaction before the second could
        // be reached. Fixing only what the log named would have failed on the next run.
        //
        // An existing alias keeps its own claim, for the reason above `out_of_scope_topics`.
        s.aliases.map((alias) => ({
          tenant_id: id, service_id: serviceId, alias, provenance: aliasProv.get(alias) ?? 'seeded',
        })),
        { onConflict: 'tenant_id,alias' });
      if (aErr) fail(`service_aliases «${s.name}»`, aErr.message);
    }
  }
  const aliases = d.services.reduce((n, s) => n + s.aliases.length, 0);
  log.push(`${d.services.length} services, ${d.services.reduce((n, s) => n + s.variants.length, 0)} variants, ${aliases} aliases`);
  return log;
}
