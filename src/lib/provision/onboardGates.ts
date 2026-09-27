/**
 * The two gates a new tenant passes before any customer reads it, and where it stands.
 *
 *  1. **The founder's, on the words** — every Mongolian line Дали will say that is not the
 *     client's own data. Shown on the WORDING SHEET; signed by passing the sheet's id back
 *     (`--sign-wording <id>`). The id is a hash of exactly the lines shown, so a signature
 *     covers the bytes that were read and nothing written after: if any pending line changed
 *     since the sheet was printed, the id no longer matches and nothing is signed.
 *  2. **The client's, on the facts** — prices, hours, address, booking, deposits, staff,
 *     FAQs, as the DATABASE now holds them. Shown on the one-page CLIENT SUMMARY; recorded by
 *     passing the summary's id back with who confirmed (`--client-confirmed`). Same binding:
 *     a fact changed after the summary was sent is not confirmed by it.
 *
 * Both summaries are rendered from rows, never from the form, so what is signed is what is
 * served. Until both pass the tenant's readiness holds, its reply cases stay off, and its
 * channels stay in shadow (nothing here can move a channel to live).
 *
 * These are the only two places onboarding writes a signature, and each needs a person to
 * type an id they were shown. `SUPABASE_SECRET_PUBLISH` is not set in cloud sessions, so no
 * session can sign for anyone (CLAUDE.md).
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { byCodePoint } from '../mn/text.ts';
import { raiseAlert } from '../alerts/alert.ts';
import { assessReadiness, type Readiness } from './validate.ts';
import type { OnboardPlan, Templates } from './plan.ts';
import { FORM_FIELDS } from './questionnaire.ts';
import { renderAmount } from './cases.ts';
import { WriteError } from './write.ts';

const rows = (data: unknown): Record<string, unknown>[] =>
  (Array.isArray(data) ? data : []).map((r) => r as Record<string, unknown>);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** What a person types back: 12 hex characters, enough to never collide by accident. */
export const shortId = (hash: string): string => hash.slice(0, 12);

async function read(db: SupabaseClient, what: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const { data, error } = await q;
  if (error) throw new WriteError(`${what} unreadable: ${error.message}`);
  return rows(data);
}

// ---- the facts ---------------------------------------------------------------------------

export type Facts = {
  services: { name: string; durationMinutes: number | null; variants: { key: string; kind: string; min: string; max: string; confirmed: boolean }[] }[];
  hours: { weekday: number; opens: string; closes: string; closed: boolean }[];
  contacts: { kind: string; value: string }[];
  bookingUrl: string | null;
  deposits: { appliesTo: string; ruleText: string }[];
  staff: { name: string; shortName: string; tier: string; active: boolean }[];
  faqs: { question: string; answer: string; confirmed: boolean }[];
  documents: { title: string; body: string }[];
};

export async function loadFacts(db: SupabaseClient, tenantId: string): Promise<Facts> {
  const t = tenantId;
  const [svc, vars, hrs, cps, bk, deps, stf, fq, docs] = await Promise.all([
    read(db, 'services', db.from('services').select('id, name, duration_minutes').eq('tenant_id', t)),
    read(db, 'service_variants', db.from('service_variants')
      .select('service_id, variant_key, price_kind, price_min, price_max, confirmed_at').eq('tenant_id', t)),
    read(db, 'business_hours', db.from('business_hours').select('weekday, opens, closes, closed').eq('tenant_id', t)),
    read(db, 'contact_points', db.from('contact_points').select('kind, value').eq('tenant_id', t)),
    read(db, 'tenant_booking', db.from('tenant_booking').select('booking_url').eq('tenant_id', t)),
    read(db, 'deposit_rules', db.from('deposit_rules').select('applies_to, rule_text, ordinal').eq('tenant_id', t)),
    read(db, 'staff_members', db.from('staff_members').select('name, short_name, tier, active').eq('tenant_id', t)),
    read(db, 'faqs', db.from('faqs').select('question, answer, ordinal, provenance').eq('tenant_id', t)),
    read(db, 'knowledge_documents', db.from('knowledge_documents').select('title, body, source').eq('tenant_id', t)),
  ]);
  const digits = (v: unknown) => (v === null || v === undefined ? '' : String(Math.trunc(Number(v))));
  const hhmm = (v: unknown) => str(v).slice(0, 5);
  // Ordered by code point, never by the database's collation (D-026): this reaches a hash.
  return {
    services: svc.map((s) => ({
      name: str(s['name']),
      durationMinutes: s['duration_minutes'] === null ? null : Number(s['duration_minutes']),
      variants: vars.filter((v) => str(v['service_id']) === str(s['id'])).map((v) => ({
        key: str(v['variant_key']), kind: str(v['price_kind']), min: digits(v['price_min']), max: digits(v['price_max']),
        confirmed: v['confirmed_at'] !== null && v['confirmed_at'] !== undefined,
      })).sort((a, b) => byCodePoint(a.key, b.key)),
    })).sort((a, b) => byCodePoint(a.name, b.name)),
    hours: hrs.map((h) => ({ weekday: Number(h['weekday']), opens: hhmm(h['opens']), closes: hhmm(h['closes']), closed: h['closed'] === true }))
      .sort((a, b) => a.weekday - b.weekday),
    contacts: cps.map((c) => ({ kind: str(c['kind']), value: str(c['value']) })).sort((a, b) => byCodePoint(a.kind, b.kind)),
    bookingUrl: bk[0] === undefined || bk[0]['booking_url'] === null ? null : str(bk[0]['booking_url']),
    deposits: deps.sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']))
      .map((d) => ({ appliesTo: str(d['applies_to']), ruleText: str(d['rule_text']) })),
    staff: stf.map((s) => ({ name: str(s['name']), shortName: str(s['short_name']), tier: str(s['tier']), active: s['active'] === true }))
      .sort((a, b) => byCodePoint(a.name, b.name)),
    faqs: fq.sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']) || byCodePoint(str(a['question']), str(b['question'])))
      .map((f) => ({ question: str(f['question']), answer: str(f['answer']), confirmed: f['provenance'] === 'tenant_confirmed' })),
    documents: docs.filter((d) => str(d['source']).startsWith('onboarding:'))
      .map((d) => ({ title: str(d['title']), body: str(d['body']) })).sort((a, b) => byCodePoint(a.title, b.title)),
  };
}

/** The facts' identity: what the client confirms. Confirmation state is not part of it. */
export function factsHash(f: Facts): string {
  return sha({
    ...f,
    services: f.services.map((s) => ({ ...s, variants: s.variants.map(({ confirmed: _c, ...v }) => v) })),
    faqs: f.faqs.map(({ confirmed: _c, ...q }) => q),
  });
}

// ---- the words -----------------------------------------------------------------------------

export type Wording = {
  pending: { kind: string; body: string }[];
  signedCount: number;
  /** Rule questions and document titles: model-visible, shown and hashed, not a row signature. */
  modelVisible: { where: string; text: string }[];
};

export async function loadWording(db: SupabaseClient, tenantId: string): Promise<Wording> {
  const [canned, topics, docs] = await Promise.all([
    read(db, 'canned_responses', db.from('canned_responses').select('kind, body, reviewed_at').eq('tenant_id', tenantId)),
    read(db, 'out_of_scope_topics', db.from('out_of_scope_topics').select('topic_key, decision_question').eq('tenant_id', tenantId)),
    read(db, 'knowledge_documents', db.from('knowledge_documents').select('title, source').eq('tenant_id', tenantId)),
  ]);
  const pending = canned.filter((c) => c['reviewed_at'] === null)
    .map((c) => ({ kind: str(c['kind']), body: str(c['body']) })).sort((a, b) => byCodePoint(a.kind, b.kind));
  return {
    pending,
    signedCount: canned.length - pending.length,
    modelVisible: [
      ...topics.map((t) => ({ where: `rule ${str(t['topic_key'])}`, text: str(t['decision_question']) })),
      ...docs.filter((d) => str(d['source']).startsWith('onboarding:'))
        .map((d) => ({ where: `document ${str(d['source'])}`, text: str(d['title']) })),
    ].sort((a, b) => byCodePoint(a.where, b.where)),
  };
}

export function wordingHash(w: Wording): string {
  return sha({ pending: w.pending, modelVisible: w.modelVisible });
}

export type GateStatus = {
  wording: { signed: boolean; pending: number; id: string };
  facts: { confirmed: boolean; unconfirmed: number; id: string };
};

export function gateStatus(w: Wording, f: Facts): GateStatus {
  const unconfirmed = f.services.flatMap((s) => s.variants).filter((v) => !v.confirmed).length
    + f.faqs.filter((q) => !q.confirmed).length;
  return {
    wording: { signed: w.pending.length === 0 && w.signedCount > 0, pending: w.pending.length, id: shortId(wordingHash(w)) },
    facts: { confirmed: unconfirmed === 0 && f.services.length > 0, unconfirmed, id: shortId(factsHash(f)) },
  };
}

/**
 * The founder's signature on the lines the sheet showed. Refuses unless `id` is the id of
 * the lines pending NOW; then signs exactly those rows, each matched on its bytes.
 */
export async function signWording(
  db: SupabaseClient, tenantId: string, slug: string, id: string, by: string, now: Date,
): Promise<number> {
  const w = await loadWording(db, tenantId);
  const current = shortId(wordingHash(w));
  if (w.pending.length === 0) throw new WriteError('nothing is waiting for a signature');
  if (id !== current) {
    throw new WriteError(`wording sheet ${id} is not the lines pending now (${current}). Something changed since it was printed: read the new sheet.`);
  }
  for (const line of w.pending) {
    const { error } = await db.from('canned_responses')
      .update({ reviewed_at: now.toISOString(), reviewed_by: by })
      .eq('tenant_id', tenantId).eq('kind', line.kind).eq('body', line.body).is('reviewed_at', null);
    if (error) throw new WriteError(`canned_responses «${line.kind}»: ${error.message}`);
  }
  await audit(db, tenantId, slug, `wording ${id}`, `${slug}: ${w.pending.length} Mongolian lines signed by ${by} (wording sheet ${id})`);
  return w.pending.length;
}

/**
 * The client's confirmation of the facts the summary showed. Refuses unless `id` is the id
 * of the facts as they are NOW. Stamps `confirmed_at` on every price and upgrades every FAQ
 * to `tenant_confirmed` (D-020: the client read it). Who and when are recorded in `alerts`
 * — the schema has no column for the confirmer's name, and the digest is where a person
 * will see it.
 */
export async function confirmFacts(
  db: SupabaseClient, tenantId: string, slug: string, id: string,
  who: { name: string; on: string }, now: Date,
): Promise<number> {
  const f = await loadFacts(db, tenantId);
  const current = shortId(factsHash(f));
  if (id !== current) {
    throw new WriteError(`client summary ${id} is not the facts held now (${current}). A fact changed after the summary was sent: send the new one.`);
  }
  const { data, error } = await db.from('service_variants').update({ confirmed_at: now.toISOString() })
    .eq('tenant_id', tenantId).is('confirmed_at', null).select('id');
  if (error) throw new WriteError(`service_variants: ${error.message}`);
  const { data: fq, error: fErr } = await db.from('faqs').update({ provenance: 'tenant_confirmed' })
    .eq('tenant_id', tenantId).neq('provenance', 'tenant_confirmed').select('id');
  if (fErr) throw new WriteError(`faqs: ${fErr.message}`);
  const n = rows(data).length + rows(fq).length;
  await audit(db, tenantId, slug, `facts ${id}`, `${slug}: facts confirmed by the client, ${who.name}, on ${who.on} (summary ${id}; ${n} rows)`);
  return n;
}

async function audit(db: SupabaseClient, tenantId: string, slug: string, key: string, body: string): Promise<void> {
  const out = await raiseAlert(db, {
    tenantId, severity: 'info', kind: `provisioning.signature:${slug}`, dedupKey: `provisioning-signature:${slug}:${key}`,
    body, route: 'digest', repeat: 'once',
  });
  if (out.outcome === 'failed') throw new WriteError(`the signature was written but its record was not: ${out.detail}`);
}

// ---- readiness -------------------------------------------------------------------------------

/**
 * Where the tenant stands, for the daily report: the validator's verdict on the document,
 * the form's missing answers, and the two gates. `ready` only when nothing holds.
 *
 * The validator's `facts_unconfirmed` blocker is replaced by the client gate: in onboarding
 * the facts are written first and confirmed after, from the summary, so an unconfirmed
 * document is the expected state and not a reason to write nothing.
 */
export function onboardReadiness(plan: OnboardPlan, gates: GateStatus | null, now: Date): Readiness {
  const base = assessReadiness(plan.intake, now);
  const dropped = base.findings.filter((f) => f.code === 'facts_unconfirmed').map((f) => f.detail);
  const findings = base.findings.filter((f) => f.code !== 'facts_unconfirmed');
  // What HOLDS the tenant comes first: the daily report shows three items per tenant, and a
  // missing price must not be pushed off the line by a list of spelling questions.
  const first: string[] = [];
  const later: string[] = [];
  const line = (m: OnboardPlan['missing'][number]) => `${m.audience === 'client' ? 'client' : 'operator'} (form ${m.question}): ${m.what}`;
  for (const m of plan.missing.filter((x) => x.holdsReady)) first.push(line(m));
  if (gates === null) {
    first.push('founder: sign the wording sheet', 'client: confirm the facts summary');
  } else {
    if (!gates.wording.signed) first.push(`founder: sign ${gates.wording.pending} Mongolian lines (wording sheet ${gates.wording.id})`);
    if (!gates.facts.confirmed) first.push(`client: confirm the facts summary (${gates.facts.id})`);
  }
  const holdingFindings = new Set(findings.filter((f) => f.severity === 'blocker' || f.holdsReady === true).map((f) => f.detail));
  for (const w of base.waitingOn.filter((x) => !dropped.includes(x))) {
    (holdingFindings.has(w) || holdingFindings.has(w.replace(/^client: /u, '')) ? first : later).push(w);
  }
  for (const m of plan.missing.filter((x) => !x.holdsReady)) later.push(line(m));
  const waitingOn = [...first, ...later];
  const blocking = findings.some((f) => f.severity === 'blocker' || f.holdsReady === true);
  const holding = plan.missing.some((m) => m.holdsReady)
    || gates === null || !gates.wording.signed || !gates.facts.confirmed;
  const early = base.stage === 'nothing' || base.stage === 'routing' || base.stage === 'sentences';
  const stage = early ? base.stage : (blocking || holding ? 'knowledge' : 'ready');
  return { stage, waitingOn, findings };
}

// ---- the two documents ---------------------------------------------------------------------------

/** The one page the client reads and confirms. Mongolian headings, their own data under them. */
export function clientSummary(f: Facts, plan: OnboardPlan, t: Templates, id: string): string {
  const cs = t.client_summary as Record<string, unknown>;
  const h = (k: string) => String(cs[k] ?? k);
  const day = (wd: number) => String((cs['weekdays'] as Record<string, unknown>)[String(wd)] ?? wd);
  const L: string[] = [];
  L.push(`# ${h('title')}`, '', `**${plan.intake.business.displayName}**`, '', h('intro'), '');
  L.push(`## ${h('services')}`, '');
  for (const s of f.services) {
    const prices = s.variants.map((v) => {
      const p = v.kind === 'exact' ? renderAmount(v.min) : v.kind === 'from' ? `${renderAmount(v.min)}+`
        : v.kind === 'range' ? `${renderAmount(v.min)}–${renderAmount(v.max)}` : '—';
      return v.key === '' ? p : `${v.key}: ${p}`;
    }).join('; ');
    const dur = s.durationMinutes === null ? '' : ` · ${s.durationMinutes} мин`;
    L.push(`- ${s.name} — ${prices}${dur}`);
  }
  L.push('', `## ${h('hours')}`, '');
  // Monday first, as the form lists them; `weekday` is Postgres `dow` (0 = Sunday).
  for (const x of [...f.hours].sort((a, b) => (a.weekday + 6) % 7 - (b.weekday + 6) % 7)) L.push(`- ${day(x.weekday)}: ${x.closed ? h('closed') : `${x.opens}–${x.closes}`}`);
  L.push('', `## ${h('contacts')}`, '');
  for (const c of f.contacts) L.push(`- ${c.value}`);
  if (f.bookingUrl !== null) L.push('', `## ${h('booking')}`, '', `- ${f.bookingUrl}`);
  if (f.deposits.length > 0) {
    L.push('', `## ${h('deposits')}`, '');
    for (const d of f.deposits) L.push(`- ${d.ruleText}`);
  }
  if (f.staff.length > 0) {
    L.push('', `## ${h('staff')}`, '');
    for (const s of f.staff) L.push(`- ${s.name}${s.shortName ? ` (${s.shortName})` : ''}${s.tier ? ` — ${s.tier}` : ''}`);
  }
  if (f.faqs.length > 0) {
    L.push('', `## ${h('faqs')}`, '');
    for (const q of f.faqs) L.push(`- **${q.question}** ${q.answer}`);
  }
  if (f.documents.length > 0) {
    L.push('', `## ${h('documents')}`, '');
    for (const d of f.documents) L.push(`**${d.title}**`, '', d.body, '');
  }
  const asks = plan.missing.filter((m) => m.audience === 'client');
  if (asks.length > 0) {
    L.push('', `## ${h('missing')}`, '');
    for (const m of asks) {
      const label = FORM_FIELDS[m.question] ?? (t.client_summary['sections'] as Record<string, string> | undefined)?.[m.question] ?? '';
      const ask = m.code === undefined ? undefined : (cs['asks'] as Record<string, string> | undefined)?.[m.code];
      L.push(`- ${m.question}${label === '' ? '' : ` ${label}`}${m.subject === undefined ? '' : `: «${m.subject}»`}${ask === undefined ? '' : ` — ${ask}`}`);
    }
  }
  L.push('', '---', '', h('footer'), '', `\`${id}\``, '');
  return L.join('\n');
}

/** The founder's sheet: every Mongolian line that is not the client's own data, with its origin. */
export function wordingSheet(w: Wording, plan: OnboardPlan, id: string, slug: string): string {
  const L: string[] = [];
  L.push(`# Wording sheet — ${plan.intake.business.displayName} (\`${slug}\`)`, '');
  L.push(`Sheet id: **\`${id}\`** · ${w.pending.length} lines awaiting your signature · ${w.signedCount} already signed.`, '');
  L.push('Every line below is sent to customers byte for byte once signed. None is the client\'s own data: each was filled from a template in `scripts/provision/templates/onboarding.mn.json`. «Same bytes as approved» means the founder already approved these exact words for a live tenant.', '');
  L.push('| Kind | Line | Made from | Same bytes as approved |', '|---|---|---|---|');
  for (const p of w.pending) {
    const origin = plan.wording.find((x) => x.kind === p.kind);
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    L.push(`| \`${p.kind}\` | «${cell(p.body)}» | ${cell(origin?.derivedFrom ?? 'not from this form')} | ${origin?.alreadyApprovedBytes === true ? 'yes' : 'no'} |`);
  }
  if (w.modelVisible.length > 0) {
    L.push('', '## Read by the model, never sent to a customer', '');
    L.push('Rule questions built from the client\'s 7.1–7.3 answers and titles of knowledge documents built from their own words. Covered by the same sheet id.', '');
    for (const m of w.modelVisible) L.push(`- ${m.where}: «${m.text}»`);
  }
  L.push('', '## To sign', '', 'Re-run the same onboarding command with:', '', `    --apply --sign-wording ${id} --signed-by <your name>`, '');
  L.push('Any line changed after this sheet was printed changes the id, and the signature is refused.', '');
  return L.join('\n');
}
