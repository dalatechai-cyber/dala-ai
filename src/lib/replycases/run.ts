/**
 * Replay every reply the founder marked wrong, and say whether each one is right now (D-120).
 *
 * Founder, 2026-09-24: *"When I mark a reply as wrong, it becomes a permanent test case with
 * the correct expected answer. No publish or merge that touches replies can go out unless
 * every test passes, including all past failures."*
 *
 * ## What is real here
 *
 * The tenant's live configuration, read by `loadReceptionContext` — the same loader the
 * worker uses — and `handleReception` itself, so a case is answered by the code a customer
 * would be answered by. The model is the real one when a case reaches it. What is replaced
 * is persistence: `ReceptionDeps.draft` records instead of inserting, the spend calls are
 * no-ops, and nothing is sent. A test that wrote drafts into a live tenant's corpus would be
 * a customer conversation that never happened.
 *
 * For a PUBLISH, the context's compiled prefix is swapped for the one about to be published
 * (`withCompiled`), so the cases judge the configuration that will go live, not the one that
 * is live now.
 *
 * ## Fails closed
 *
 * A case the runner could not answer — the configuration did not load, the reply path asked
 * for a retry, or the model was needed and no key was given — is a FAILED case, never a
 * skipped one. "Could not check" letting a publish through is the whole failure this gate
 * exists to end.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleReception, type ReceptionDeps } from '../reception/handle.ts';
import { loadReceptionContext, type ReceptionContext } from '../reception/load.ts';
import { renderVolatile } from '../reception/volatile.ts';
import { servicesFromPrefix, sectionRows, faqAnswersFromPrefix } from '../quality/serviceNames.ts';
import { SECTION_LABELS } from '../prompt/tenant.ts';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '../../config/platform.ts';
import type { CallOutcome, ReceptionRequest } from '../model/reception.ts';
import { fold, nfc } from '../mn/text.ts';
import { tenantClock } from '../time/clock.ts';

export type Turn = { role: 'user' | 'assistant'; content: string };

export type ReplyCase = {
  id: number;
  customerMessage: string;
  history: Turn[];
  expectedBody: string | null;
  mustInclude: string[];
  mustNotInclude: string[];
  note: string | null;
};

export type CaseResult = {
  id: number;
  pass: boolean;
  reply: string | null;
  answeredBy: string | null;
  /** Empty when it passed. */
  why: string[];
  flags: string[];
};

/** Whitespace-insensitive, NFC: a reply passes when it is the expected text as written. */
function same(a: string, b: string): boolean {
  const n = (s: string) => nfc(s).replace(/\s+/gu, ' ').trim();
  return n(a) === n(b);
}

function clip(s: string, max = 80): string {
  const cps = [...s.replace(/\s+/gu, ' ').trim()];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max - 1).join('')}…`;
}

/** Why this reply fails this case. Empty means it passes. Pure. */
export function judge(c: ReplyCase, reply: string | null): string[] {
  if (reply === null) return ['no reply was drafted'];
  const why: string[] = [];
  if (c.expectedBody !== null && !same(reply, c.expectedBody)) {
    why.push(`expected «${clip(c.expectedBody)}», got «${clip(reply)}»`);
  }
  const r = fold(reply);
  for (const inc of c.mustInclude) if (!r.includes(fold(inc))) why.push(`missing «${clip(inc, 40)}»`);
  for (const exc of c.mustNotInclude) if (r.includes(fold(exc))) why.push(`contains «${clip(exc, 40)}»`);
  return why;
}

function asTurns(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => {
    const o = t as Record<string, unknown>;
    const role = o['role'];
    const content = o['content'];
    return (role === 'user' || role === 'assistant') && typeof content === 'string' ? [{ role, content }] : [];
  });
}

export async function loadCases(
  db: SupabaseClient, tenantId: string,
): Promise<{ ok: true; cases: ReplyCase[] } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('reply_cases')
    .select('id, customer_message, history, expected_body, must_include, must_not_include, note')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .order('id', { ascending: true });
  if (error) return { ok: false, detail: `reply_cases unreadable: ${error.message}` };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    ok: true,
    cases: (Array.isArray(data) ? data : []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: Number(r['id']),
        customerMessage: String(r['customer_message'] ?? ''),
        history: asTurns(r['history']),
        expectedBody: typeof r['expected_body'] === 'string' ? r['expected_body'] : null,
        mustInclude: strings(r['must_include']),
        mustNotInclude: strings(r['must_not_include']),
        note: typeof r['note'] === 'string' ? r['note'] : null,
      };
    }),
  };
}

/** The live context with the prefix about to be published in place of the live one. */
export function withCompiled(
  ctx: ReceptionContext,
  compiled: { promptStable: string; allowedNumbers: string[]; cannedHash: string | null; promptGate: string | null },
): ReceptionContext {
  return {
    ...ctx,
    promptStable: compiled.promptStable,
    allowedNumbers: compiled.allowedNumbers,
    cannedHash: compiled.cannedHash,
    promptGate: compiled.promptGate,
    tenantGuard: {
      ...ctx.tenantGuard,
      allowedNumbers: compiled.allowedNumbers,
      promptCorpus: compiled.promptGate ?? compiled.promptStable,
    },
  };
}

/** Thrown by the stub model when no key was given; caught per case and reported. */
class NeedsModel extends Error {}

/**
 * Answer every case through `handleReception`. `callModel` null means no key: a case that
 * reaches the model then FAILS, it is not skipped.
 */
export async function runCases(input: {
  cases: readonly ReplyCase[];
  ctx: ReceptionContext;
  timezone: string;
  now: Date;
  callModel: ((req: ReceptionRequest) => Promise<CallOutcome>) | null;
}): Promise<CaseResult[]> {
  const { ctx, now } = input;
  const results: CaseResult[] = [];
  for (const c of input.cases) {
    const record: { body: string | null; answeredBy: string | null; flags: string[] } = { body: null, answeredBy: null, flags: [] };
    const deps: ReceptionDeps = {
      callModel: async (req) => {
        if (input.callModel === null) throw new NeedsModel('this case reaches the model and no ANTHROPIC_API_KEY was given');
        return input.callModel(req);
      },
      draft: async ({ body, answeredBy }) => { record.body = body; record.answeredBy = answeredBy; return { ok: true, id: `case-${c.id}` }; },
      markCalled: async () => true,
      settle: async () => ({ ok: true }),
      release: async () => {},
      flag: async (f) => { record.flags.push(f.code); },
      observe: async () => {},
    };
    try {
      const out = await handleReception(deps, {
        customerMessage: nfc(c.customerMessage),
        customerAttachments: [],
        customerSentPhoto: false,
        history: c.history,
        eventAt: now,
        now,
        promptStable: ctx.promptStable,
        promptVolatile: renderVolatile({ now, timezone: input.timezone, surface: 'direct_message', hours: ctx.hours, closures: ctx.closures }),
        modelId: MODEL_REGISTRY.reception,
        cacheMode: ctx.cacheMode,
        timeoutMs: RECEPTION_UPSTREAM_TIMEOUT_MS,
        rules: ctx.rules,
        deterministic: ctx.deterministic,
        historyState: { known: true, empty: c.history.length === 0 },
        canned: ctx.canned,
        tenantGuard: ctx.tenantGuard,
        cannedLabel: SECTION_LABELS.canned,
        serviceNames: servicesFromPrefix(ctx.promptStable, SECTION_LABELS.priceList),
        serviceAliases: ctx.serviceAliases,
        depositRows: sectionRows(ctx.promptStable, SECTION_LABELS.deposits),
        faqAnswers: faqAnswersFromPrefix(ctx.promptStable, SECTION_LABELS.faqs),
        cannedHash: ctx.cannedHash,
        spellings: ctx.spellings,
      });
      const why = out.kind === 'drafted' ? judge(c, record.body) : [`the reply path answered ${out.kind}: ${out.kind === 'retry' ? out.detail : out.reason}`];
      results.push({ id: c.id, pass: why.length === 0, reply: record.body, answeredBy: record.answeredBy, why, flags: record.flags });
    } catch (err) {
      results.push({
        id: c.id, pass: false, reply: null, answeredBy: null, flags: record.flags,
        why: [err instanceof NeedsModel ? err.message : `threw: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }
  return results;
}

export type TenantGate =
  | { ok: true; slug: string; results: CaseResult[] }
  | { ok: false; slug: string; detail: string };

/**
 * Load one tenant's configuration and cases and run them. `compiled`, when given, is the
 * prefix about to be published (see `withCompiled`).
 */
export async function gateTenant(
  db: SupabaseClient,
  input: {
    slug: string;
    now: Date;
    callModel: ((req: ReceptionRequest) => Promise<CallOutcome>) | null;
    compiled?: { promptStable: string; allowedNumbers: string[]; cannedHash: string | null; promptGate: string | null };
  },
): Promise<TenantGate> {
  const { data: t, error } = await db
    .from('tenants').select('id, default_locale, prompt_cache_mode, timezone').eq('slug', input.slug).maybeSingle();
  if (error) return { ok: false, slug: input.slug, detail: `tenants unreadable: ${error.message}` };
  if (t === null) return { ok: false, slug: input.slug, detail: 'no such tenant' };
  const row = t as Record<string, unknown>;
  const tenantId = String(row['id']);
  const timezone = String(row['timezone'] ?? '');
  if (timezone === '') return { ok: false, slug: input.slug, detail: 'tenant has no timezone' };

  const cases = await loadCases(db, tenantId);
  if (!cases.ok) return { ok: false, slug: input.slug, detail: cases.detail };
  if (cases.cases.length === 0) return { ok: true, slug: input.slug, results: [] };

  const loaded = await loadReceptionContext(db, {
    tenantId,
    channel: 'facebook_page',
    settings: {
      defaultLocale: String(row['default_locale'] ?? 'mn-MN'),
      promptCacheMode: String(row['prompt_cache_mode'] ?? 'off') as 'off' | '5m' | '1h',
    },
    localDate: tenantClock(input.now, timezone).date,
  });
  if (!loaded.ok) return { ok: false, slug: input.slug, detail: `configuration did not load (${loaded.code}): ${loaded.detail}` };
  const ctx = input.compiled === undefined ? loaded.context : withCompiled(loaded.context, input.compiled);
  return {
    ok: true,
    slug: input.slug,
    results: await runCases({ cases: cases.cases, ctx, timezone, now: input.now, callModel: input.callModel }),
  };
}

/** A readable summary. Pure. */
export function renderGate(gates: readonly TenantGate[]): { text: string; pass: boolean } {
  const lines: string[] = [];
  let pass = true;
  for (const g of gates) {
    if (!g.ok) {
      pass = false;
      lines.push(`${g.slug}: FAILED — ${g.detail}`);
      continue;
    }
    const failed = g.results.filter((r) => !r.pass);
    if (failed.length > 0) pass = false;
    lines.push(`${g.slug}: ${g.results.length - failed.length}/${g.results.length} reply cases pass`);
    for (const f of failed) lines.push(`  case ${f.id} FAILS: ${f.why.join('; ')}`);
  }
  return { text: lines.join('\n'), pass };
}
