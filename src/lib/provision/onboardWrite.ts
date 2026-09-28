/**
 * The rows onboarding adds beyond the intake document: staff with their grades, FAQs,
 * deposits, knowledge documents, the reply look, channels in shadow, and reply cases.
 *
 * `write.ts` (`applyIntake`) writes the intake document first; this runs after it, for the
 * same tenant, with the same rules:
 *
 *  - **Idempotent by natural key.** Re-running with the same form changes nothing.
 *  - **A signature is never withdrawn by a re-run that did not change the thing signed.**
 *    An FAQ whose answer is unchanged keeps its `provenance`; a changed answer goes back to
 *    `seeded`, because the client confirmed different words (D-020).
 *  - **Nothing here goes live.** Channels are written `delivery_mode = 'shadow'` with no
 *    token; an existing channel row is never touched, so a re-run cannot move one.
 *  - **Nothing here spends.** No `tenant_roles` entitlement and no budget row: whether a
 *    tenant may spend is the founder's (CLAUDE.md, «Money movement»).
 *
 * Payloads are written inline in each call, never behind a variable, so
 * `scripts/verify/query-columns.ts` can check every column against the schema.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OnboardPlan } from './plan.ts';
import type { GeneratedCase } from './cases.ts';
import { WriteError } from './write.ts';

const rows = (data: unknown): Record<string, unknown>[] =>
  (Array.isArray(data) ? data : []).map((r) => r as Record<string, unknown>);

/** Where onboarding cases are recognised: the note starts with this, then the case id. */
export const CASE_NOTE_PREFIX = 'onboard:';

/** The `onboarding_steps` rows this command owns (the table's designed use, 0001 §7). */
export const STEP = {
  created: 'onboard_command',
  wording: 'wording_signed',
  facts: 'facts_confirmed',
} as const;

/**
 * Refuse any tenant onboarding may not write (2026-09-27: «nothing about the live tenants
 * may change»). Two independent tests, either one refuses:
 *
 *  1. **It has been live** — a channel `live` or with `went_live_at`.
 *  2. **Onboarding did not create it** — no `onboarding_steps` row `onboard_command`, and
 *     any sign of a life of its own: a revision (published, even in shadow), a reviewed
 *     sentence, or an active routing identity. DalaTech and Tara have all three. The last
 *     clause exists for one case: a first run that died between creating the tenant and
 *     recording that it did, which has none of them and would otherwise be stuck.
 *
 * A read that fails refuses: never "no rows, so it must be ours".
 */
export async function refuseForeignTenant(db: SupabaseClient, slug: string): Promise<{ tenantId: string | null }> {
  const { data: t, error } = await db.from('tenants').select('id, slug, live_revision_id').eq('slug', slug).maybeSingle();
  if (error) throw new WriteError(`tenants unreadable: ${error.message}`);
  if (t === null) return { tenantId: null };
  const row = t as Record<string, unknown>;
  const tenantId = String(row['id']);
  const { data: ch, error: chErr } = await db.from('tenant_channels')
    .select('provider, external_id, delivery_mode, went_live_at').eq('tenant_id', tenantId);
  if (chErr) throw new WriteError(`tenant_channels unreadable: ${chErr.message}`);
  const live = rows(ch).filter((c) => c['delivery_mode'] === 'live' || (c['went_live_at'] !== null && c['went_live_at'] !== undefined));
  if (live.length > 0) {
    throw new WriteError(`«${slug}» has been live (${live.map((c) => `${String(c['provider'])} ${String(c['external_id'])}`).join(', ')}). `
      + 'Onboarding never writes a tenant that has served customers; change it with a reviewed script.');
  }
  const { data: mark, error: mErr } = await db.from('onboarding_steps')
    .select('step_key').eq('tenant_id', tenantId).eq('step_key', STEP.created);
  if (mErr) throw new WriteError(`onboarding_steps unreadable: ${mErr.message}`);
  if (rows(mark).length > 0) return { tenantId };
  const [rev, canned, ids] = await Promise.all([
    db.from('config_revisions').select('id').eq('tenant_id', tenantId).limit(1),
    db.from('canned_responses').select('kind').eq('tenant_id', tenantId).not('reviewed_at', 'is', null).limit(1),
    db.from('channel_identity').select('id').eq('tenant_id', tenantId).eq('active', true).limit(1),
  ]);
  for (const [what, r] of [['config_revisions', rev], ['canned_responses', canned], ['channel_identity', ids]] as const) {
    if (r.error) throw new WriteError(`${what} unreadable: ${r.error.message}`);
  }
  const life = row['live_revision_id'] !== null && row['live_revision_id'] !== undefined
    || rows(rev.data).length > 0 || rows(canned.data).length > 0 || rows(ids.data).length > 0;
  if (life) {
    throw new WriteError(`«${slug}» was not created by onboarding (it has a revision, a signed sentence or a routing identity). `
      + 'Onboarding writes only the tenants it created; change this one with a reviewed script.');
  }
  return { tenantId };
}

/** Record a step. Written once per step key; `evidence` is what the step was bound to. */
export async function recordStep(
  db: SupabaseClient, tenantId: string, step: string, evidence: Record<string, unknown>, now: Date,
): Promise<void> {
  const { error } = await db.from('onboarding_steps').upsert({
    tenant_id: tenantId, step_key: step, state: 'done', evidence, done_at: now.toISOString(),
  }, { onConflict: 'tenant_id,step_key' });
  if (error) throw new WriteError(`onboarding_steps «${step}»: ${error.message}`);
}

/** The evidence of each recorded step, by key. */
export async function readSteps(db: SupabaseClient, tenantId: string): Promise<Map<string, Record<string, unknown>>> {
  const { data, error } = await db.from('onboarding_steps').select('step_key, evidence').eq('tenant_id', tenantId);
  if (error) throw new WriteError(`onboarding_steps unreadable: ${error.message}`);
  return new Map(rows(data).map((r) => [String(r['step_key']), (r['evidence'] ?? {}) as Record<string, unknown>]));
}

/** Before anything is written: a Page that already routes to ANOTHER tenant is refused. */
export async function refuseForeignChannels(db: SupabaseClient, slug: string, plan: OnboardPlan): Promise<void> {
  for (const c of plan.channels) {
    if (c.externalId === null) continue;
    const { data, error } = await db.from('channel_identity')
      .select('tenant_id, provider, external_id').eq('provider', c.provider).eq('external_id', c.externalId).eq('active', true);
    if (error) throw new WriteError(`channel_identity unreadable: ${error.message}`);
    for (const r of rows(data)) {
      const { data: owner, error: oErr } = await db.from('tenants').select('slug').eq('id', String(r['tenant_id'])).maybeSingle();
      if (oErr) throw new WriteError(`tenants unreadable: ${oErr.message}`);
      const ownerSlug = String((owner as Record<string, unknown> | null)?.['slug'] ?? '?');
      if (ownerSlug !== slug) {
        throw new WriteError(`${c.provider} ${c.externalId} already routes to «${ownerSlug}». One Page belongs to one tenant; check the id.`);
      }
    }
  }
}

export async function writeOnboarding(
  db: SupabaseClient, tenantId: string, plan: OnboardPlan, cases: readonly GeneratedCase[],
): Promise<string[]> {
  const log: string[] = [];
  const fail = (what: string, detail: string): never => { throw new WriteError(`${what}: ${detail}`); };

  // ---- the reply look (D-133): only `max_emoji`, and only when the client said no emoji ----
  if (plan.replyStyle !== null) {
    const { error } = await db.from('tenants').update({ reply_style: plan.replyStyle }).eq('id', tenantId);
    if (error) fail('tenants.reply_style', error.message);
    log.push(`reply_style ${JSON.stringify(plan.replyStyle)}`);
  }

  // ---- staff, by name ----------------------------------------------------------------------
  {
    const { data, error } = await db.from('staff_members').select('id, name').eq('tenant_id', tenantId);
    if (error) fail('staff_members', error.message);
    const have = new Map(rows(data).map((r) => [String(r['name']), String(r['id'])]));
    let added = 0; let updated = 0;
    for (const s of plan.staff) {
      const id = have.get(s.name);
      if (id === undefined) {
        const { error: e } = await db.from('staff_members').insert({
          tenant_id: tenantId, name: s.name, short_name: s.shortName, tier: s.tier,
          active: s.active, customer_selectable: s.customerSelectable, affects_price: s.affectsPrice,
        });
        if (e) fail(`staff_members «${s.name}»`, e.message);
        added += 1;
      } else {
        const { error: e } = await db.from('staff_members').update({
          short_name: s.shortName, tier: s.tier, active: s.active,
          customer_selectable: s.customerSelectable, affects_price: s.affectsPrice,
        }).eq('id', id).eq('tenant_id', tenantId);
        if (e) fail(`staff_members «${s.name}»`, e.message);
        updated += 1;
      }
    }
    log.push(`${plan.staff.length} staff_members (${added} added, ${updated} reconciled)`);
  }

  // ---- FAQs, by question: the client's words, `seeded` until the client confirms them ----------
  {
    const { data, error } = await db.from('faqs').select('id, question, answer').eq('tenant_id', tenantId);
    if (error) fail('faqs', error.message);
    const have = new Map(rows(data).map((r) => [String(r['question']), r]));
    let added = 0; let changed = 0;
    for (const [i, f] of plan.intake.faqs.entries()) {
      const prior = have.get(f.question);
      if (prior === undefined) {
        const { error: e } = await db.from('faqs').insert({
          tenant_id: tenantId, question: f.question, answer: f.answer, ordinal: i, provenance: 'seeded',
        });
        if (e) fail(`faqs «${f.question}»`, e.message);
        added += 1;
      } else if (String(prior['answer']) !== f.answer) {
        // A changed answer is not the answer the client confirmed.
        const { error: e } = await db.from('faqs').update({ answer: f.answer, ordinal: i, provenance: 'seeded' })
          .eq('id', String(prior['id'])).eq('tenant_id', tenantId);
        if (e) fail(`faqs «${f.question}»`, e.message);
        changed += 1;
      }
    }
    log.push(`${plan.intake.faqs.length} faqs (${added} added, ${changed} changed and unconfirmed again)`);
  }

  // ---- deposits, by their text: the client's words are the key -------------------------------
  //
  // Not by position: a rule inserted earlier in a corrected form would shift every ordinal
  // and write the others twice. A rule the form no longer has is reported, not deleted.
  {
    const { data, error } = await db.from('deposit_rules').select('id, applies_to, rule_text, ordinal').eq('tenant_id', tenantId);
    if (error) fail('deposit_rules', error.message);
    const have = rows(data);
    let added = 0;
    for (const [i, dep] of plan.deposits.entries()) {
      const prior = have.find((r) => String(r['rule_text']) === dep.ruleText);
      if (prior === undefined) {
        const { error: e } = await db.from('deposit_rules').insert({
          tenant_id: tenantId, applies_to: dep.appliesTo, rule_text: dep.ruleText, ordinal: i,
        });
        if (e) fail('deposit_rules', e.message);
        added += 1;
      } else if (Number(prior['ordinal']) !== i || String(prior['applies_to']) !== dep.appliesTo) {
        const { error: e } = await db.from('deposit_rules').update({ applies_to: dep.appliesTo, ordinal: i })
          .eq('id', String(prior['id'])).eq('tenant_id', tenantId);
        if (e) fail('deposit_rules', e.message);
      }
    }
    log.push(`${plan.deposits.length} deposit_rules (${added} added)`);
  }

  // ---- knowledge documents, by source key ----------------------------------------------------------
  {
    const { data, error } = await db.from('knowledge_documents').select('id, source, title, body').eq('tenant_id', tenantId);
    if (error) fail('knowledge_documents', error.message);
    const have = new Map(rows(data).map((r) => [String(r['source']), r]));
    let written = 0;
    for (const d of plan.documents) {
      const source = `onboarding:${d.key}`;
      const prior = have.get(source);
      if (prior === undefined) {
        const { error: e } = await db.from('knowledge_documents').insert({
          tenant_id: tenantId, title: d.title, body: d.body, source,
        });
        if (e) fail(`knowledge_documents «${d.title}»`, e.message);
        written += 1;
      } else if (String(prior['body']) !== d.body || String(prior['title']) !== d.title) {
        const { error: e } = await db.from('knowledge_documents').update({
          title: d.title, body: d.body, updated_at: new Date().toISOString(),
        }).eq('id', String(prior['id'])).eq('tenant_id', tenantId);
        if (e) fail(`knowledge_documents «${d.title}»`, e.message);
        written += 1;
      }
    }
    log.push(`${plan.documents.length} knowledge_documents (${written} written)`);
  }

  // ---- channels: shadow, no token, never touched once they exist ------------------------------------
  for (const c of plan.channels) {
    if (c.externalId === null) { log.push(`${c.provider} «${c.label}»: NOT created — no id (see missing)`); continue; }
    const { data: ex, error } = await db.from('tenant_channels').select('id, delivery_mode')
      .eq('tenant_id', tenantId).eq('provider', c.provider).eq('external_id', c.externalId).maybeSingle();
    if (error) fail('tenant_channels', error.message);
    if (ex !== null) {
      // Left as it is — except a missing routing identity, which only a run that died
      // between the two inserts below can leave, and which would route nothing forever.
      const exId = String((ex as Record<string, unknown>)['id']);
      const { data: has, error: hErr } = await db.from('channel_identity')
        .select('id').eq('tenant_id', tenantId).eq('channel_id', exId).eq('active', true);
      if (hErr) fail('channel_identity', hErr.message);
      if (rows(has).length === 0) {
        const repairNote = `onboarding: «${c.label}», identity restored after an interrupted run`;
        const { error: rErr } = await db.from('channel_identity').insert({
          tenant_id: tenantId, channel_id: exId, provider: c.provider, external_id: c.externalId, active: true,
          note: repairNote,
        });
        if (rErr) fail(`channel_identity ${c.externalId}`, rErr.message);
        log.push(`${c.provider} ${c.externalId}: exists; its missing routing identity was restored`);
      } else {
        log.push(`${c.provider} ${c.externalId}: exists (${String((ex as Record<string, unknown>)['delivery_mode'])}), left as it is`);
      }
      continue;
    }
    const { data: made, error: mErr } = await db.from('tenant_channels').insert({
      tenant_id: tenantId, provider: c.provider, external_id: c.externalId,
      auth_flavour: 'facebook_login', status: 'pending', delivery_mode: 'shadow', token_status: 'unprovisioned',
    }).select('id').maybeSingle();
    if (mErr) fail(`tenant_channels ${c.externalId}`, mErr.message);
    const channelId = String((made as Record<string, unknown>)['id']);
    // Routing resolves against `channel_identity`, not the channel row (matrix-stage1.sql).
    // The note is built first: a template literal inside the payload defeats the static
    // column check (`scripts/verify/query-columns.ts`), which reads keys, not values.
    const identityNote = `onboarding: «${c.label}», shadow until both gates pass and the founder seals a token`;
    const { error: iErr } = await db.from('channel_identity').insert({
      tenant_id: tenantId, channel_id: channelId, provider: c.provider, external_id: c.externalId, active: true,
      note: identityNote,
    });
    if (iErr) fail(`channel_identity ${c.externalId}`, iErr.message);
    log.push(`${c.provider} ${c.externalId}: created, delivery_mode=shadow, no token`);
  }

  // ---- reply cases: INACTIVE until both gates pass ----------------------------------------------------
  //
  // The production build runs every tenant's ACTIVE cases (D-120). An exact case for a line
  // nobody has signed yet would fail there and stop every tenant's deploy, so these land
  // inactive and `activateCases` switches them on when the founder and the client have both
  // signed. A case whose content changed is switched OFF again, for the same reason.
  {
    const { data, error } = await db.from('reply_cases')
      .select('id, note, customer_message, expected_body, must_include, must_not_include, active').eq('tenant_id', tenantId);
    if (error) fail('reply_cases', error.message);
    const ours = new Map(rows(data)
      .filter((r) => String(r['note'] ?? '').startsWith(CASE_NOTE_PREFIX))
      .map((r) => [String(r['note']).slice(CASE_NOTE_PREFIX.length).split(' ')[0] ?? '', r]));
    let added = 0; let changed = 0;
    for (const c of cases) {
      const note = `${CASE_NOTE_PREFIX}${c.id} ${c.why}`;
      const prior = ours.get(c.id);
      if (prior === undefined) {
        const { error: e } = await db.from('reply_cases').insert({
          tenant_id: tenantId, customer_message: c.message, expected_body: c.expectedBody,
          must_include: c.mustInclude, must_not_include: c.mustNotInclude, note, active: false,
        });
        if (e) fail(`reply_cases ${c.id}`, e.message);
        added += 1;
        continue;
      }
      const same = String(prior['customer_message']) === c.message
        && (prior['expected_body'] ?? null) === c.expectedBody
        && JSON.stringify(prior['must_include'] ?? []) === JSON.stringify(c.mustInclude)
        && JSON.stringify(prior['must_not_include'] ?? []) === JSON.stringify(c.mustNotInclude);
      if (!same) {
        const { error: e } = await db.from('reply_cases').update({
          customer_message: c.message, expected_body: c.expectedBody,
          must_include: c.mustInclude, must_not_include: c.mustNotInclude, note, active: false,
        }).eq('id', Number(prior['id'])).eq('tenant_id', tenantId);
        if (e) fail(`reply_cases ${c.id}`, e.message);
        changed += 1;
      }
    }
    // A case the form no longer produces (a service removed) is switched off, never deleted:
    // a row proves itself, and its history stays readable.
    const gone = [...ours.entries()].filter(([id]) => !cases.some((c) => c.id === id));
    for (const [, r] of gone) {
      // Renamed out of the prefix too, so `activateCases` can never switch it back on.
      const { error: e } = await db.from('reply_cases').update({ active: false, note: `retired-${String(r['note'])}` })
        .eq('id', Number(r['id'])).eq('tenant_id', tenantId);
      if (e) fail('reply_cases (retire)', e.message);
    }
    log.push(`${cases.length} reply_cases, inactive (${added} added, ${changed} changed, ${gone.length} retired)`);
  }

  return log;
}

/** Switch on this tenant's onboarding cases. Only ever called with both gates passed. */
export async function activateCases(db: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await db.from('reply_cases').select('id, note, active').eq('tenant_id', tenantId);
  if (error) throw new WriteError(`reply_cases unreadable: ${error.message}`);
  const ids = rows(data).filter((r) => String(r['note'] ?? '').startsWith(CASE_NOTE_PREFIX) && r['active'] !== true)
    .map((r) => Number(r['id']));
  if (ids.length === 0) return 0;
  const { error: e } = await db.from('reply_cases').update({ active: true }).eq('tenant_id', tenantId).in('id', ids);
  if (e) throw new WriteError(`reply_cases activation: ${e.message}`);
  return ids.length;
}

/**
 * Switch this tenant's onboarding cases off again: a gate re-opened (a corrected form
 * changed a signed line or a confirmed fact). Cases follow the gates both ways.
 */
export async function deactivateCases(db: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await db.from('reply_cases').select('id, note, active').eq('tenant_id', tenantId);
  if (error) throw new WriteError(`reply_cases unreadable: ${error.message}`);
  const ids = rows(data).filter((r) => String(r['note'] ?? '').startsWith(CASE_NOTE_PREFIX) && r['active'] === true)
    .map((r) => Number(r['id']));
  if (ids.length === 0) return 0;
  const { error: e } = await db.from('reply_cases').update({ active: false }).eq('tenant_id', tenantId).in('id', ids);
  if (e) throw new WriteError(`reply_cases deactivation: ${e.message}`);
  return ids.length;
}

/**
 * Rows the tenant holds that this form no longer produces: a service dropped, an FAQ
 * reworded, a deposit rule removed, a staff member gone. Never deleted by this command —
 * a row proves itself, and some carry the client's signature — but NAMED, in the report and
 * in the daily report, so a corrected form cannot leave an old fact serving unseen.
 */
export async function rowsNotInForm(db: SupabaseClient, tenantId: string, plan: OnboardPlan): Promise<string[]> {
  const [svc, fq, dep, stf, docs] = await Promise.all([
    db.from('services').select('name').eq('tenant_id', tenantId),
    db.from('faqs').select('question').eq('tenant_id', tenantId),
    db.from('deposit_rules').select('rule_text').eq('tenant_id', tenantId),
    db.from('staff_members').select('name, active').eq('tenant_id', tenantId),
    db.from('knowledge_documents').select('title, source').eq('tenant_id', tenantId),
  ]);
  for (const [what, r] of [['services', svc], ['faqs', fq], ['deposit_rules', dep], ['staff_members', stf], ['knowledge_documents', docs]] as const) {
    if (r.error) throw new WriteError(`${what} unreadable: ${r.error.message}`);
  }
  const out: string[] = [];
  const names = new Set(plan.intake.services.map((s) => s.name));
  for (const r of rows(svc.data)) if (!names.has(String(r['name']))) out.push(`service «${String(r['name'])}»`);
  const qs = new Set(plan.intake.faqs.map((f) => f.question));
  for (const r of rows(fq.data)) if (!qs.has(String(r['question']))) out.push(`FAQ «${String(r['question'])}»`);
  const deps = new Set(plan.deposits.map((d) => d.ruleText));
  for (const r of rows(dep.data)) if (!deps.has(String(r['rule_text']))) out.push(`deposit rule «${String(r['rule_text'])}»`);
  const people = new Set(plan.staff.map((s) => s.name));
  for (const r of rows(stf.data)) if (!people.has(String(r['name'])) && r['active'] === true) out.push(`staff «${String(r['name'])}»`);
  const keys = new Set(plan.documents.map((d) => `onboarding:${d.key}`));
  for (const r of rows(docs.data)) {
    const src = String(r['source'] ?? '');
    if (src.startsWith('onboarding:') && !keys.has(src)) out.push(`knowledge document «${String(r['title'])}»`);
  }
  return out;
}
