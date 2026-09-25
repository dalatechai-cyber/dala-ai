/**
 * Answer a tenant's test set through the production reply path and write the native-read
 * report — one command.
 *
 *     ANTHROPIC_API_KEY=… NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_WORKER=… \
 *       node scripts/bakeoff/testset.ts [--set scripts/bakeoff/dalatech-set.json] [--tag first-read]
 *
 * (`SUPABASE_SECRET_PUBLISH` works in place of the worker key, as for `replycases/gate.ts`.)
 * Writes `scripts/bakeoff/runs/testset-<slug>-<tag>.json` and the set's report
 * (`docs/reports/dalatech-testset.md` for tenant #0).
 *
 * ## What is real
 *
 * Every case goes through `gateTenant` (`src/lib/replycases/run.ts`) — the D-120 gate the
 * production build runs: the REAL `loadReceptionContext` over the tenant's LIVE rows, the REAL
 * `handleReception` with its deterministic rows, pinned lines, facts guard and outbound guard,
 * and `callReception` with the registry's model. The case is judged by the gate's own
 * `judge()`, with the same message, history and assertions it will carry as a `reply_cases`
 * row. So a PASS here is the gate's PASS, which is what makes this run the proof a case needs
 * before it may be switched on.
 *
 * ## What is not
 *
 * `reply_cases` is served from memory (`replycases/overlay.ts`), so nothing is written: every
 * write and `rpc` on the database throws, and the reply path's own writes are stubbed by the
 * runner as they are in the production gate. Nothing is sent to anyone; no Meta client is
 * imported. `--dump <file>` reads a `fixtureDb` dump instead of the live project, for a run
 * without a database key; it is checked the way `arms.ts` checks one — the dumped
 * `prompt_stable` must hash to its snapshot's `content_hash`.
 *
 * ## Spend
 *
 * One model call per case that reaches the model, plus at most ONE retry of a retryable
 * failure, as QStash would give production. `--max-calls` (default 80) stops the run before
 * it exceeds that. Without `ANTHROPIC_API_KEY` the run refuses, unless `--no-model` is given:
 * then cases answered by a row are judged and every case that needs the model is UNCHECKED —
 * never skipped, never passed (D-120's rule).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { gateTenant } from '../../src/lib/replycases/run.ts';
import { loadLiveSnapshot } from '../../src/lib/prompt/publish.ts';
import { callReception, type CallOutcome, type ReceptionRequest } from '../../src/lib/model/reception.ts';
import { MODEL_REGISTRY } from '../../src/config/platform.ts';
import MODELS from '../../config/models.json' with { type: 'json' };
import { asReplyCase, renderReport, type Call, type CaseRun, type Run } from '../replycases/set.ts';
import { loadSet } from '../replycases/sql.ts';
import { withCases } from '../replycases/overlay.ts';
import { fixtureDb, type Dump } from './fixtureDb.ts';

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
function die(msg: string): never { process.stderr.write(`testset: ${msg}\n`); process.exit(2); }

const setPath = arg('set') ?? 'scripts/bakeoff/dalatech-set.json';
const set = loadSet(setPath);
const tag = arg('tag') ?? 'run';
const only = arg('only')?.split(',') ?? null;
const maxCalls = Number(arg('max-calls') ?? 80);
const noModel = process.argv.includes('--no-model');
// One fixed instant for every case: afternoon in Ulaanbaatar, so an hours answer is not read
// as a timezone bug (dala.ts, c05).
const NOW = new Date(arg('now') ?? `${new Date().toISOString().slice(0, 10)}T14:00:00+08:00`);
if (Number.isNaN(NOW.getTime())) die('--now is not a date');
const runFile = arg('out') ?? `scripts/bakeoff/runs/testset-${set.tenantSlug}-${tag}.json`;
const reportFile = arg('report') ?? set.report;

const key = process.env['ANTHROPIC_API_KEY'] ?? '';
if (key === '' && !noModel) {
  die('ANTHROPIC_API_KEY is not set. Nothing was called and nothing was spent. '
    + '(--no-model runs the cases a row answers and marks the rest UNCHECKED.)');
}

// ------------------------------------------------------------------------ the database
let db: SupabaseClient;
let source: string;
const dumpPath = arg('dump');
if (dumpPath !== undefined) {
  db = fixtureDb(JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump);
  source = `the dump \`${dumpPath}\``;
} else {
  const hasWorker = (process.env['SUPABASE_SECRET_WORKER'] ?? '') !== '';
  const hasPublish = (process.env['SUPABASE_SECRET_PUBLISH'] ?? '') !== '';
  if ((process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '') === '' || (!hasWorker && !hasPublish)) {
    die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_WORKER (or SUPABASE_SECRET_PUBLISH) are required, or --dump <file>');
  }
  // The shared clients (CLAUDE.md rule 8), imported only here so a dump run needs no key.
  const clients = await import('../../src/lib/supabase/clients.ts');
  db = hasWorker ? clients.supabaseWorker() : clients.supabasePublish();
  source = 'the live project';
}

const { data: tenantRow, error: tErr } = await db.from('tenants').select('id').eq('slug', set.tenantSlug).maybeSingle();
if (tErr !== null || tenantRow === null) die(`tenant «${set.tenantSlug}» not readable: ${tErr?.message ?? 'no such tenant'}`);
const tenantId = String((tenantRow as Record<string, unknown>)['id']);

/** The live snapshot the gate will load, and proof its prompt is what its hash says. */
async function snapshot(): Promise<{ revisionId: string | null; contentHash: string; allowedNumbers: string[] }> {
  const s = await loadLiveSnapshot(db, { tenantId, channel: 'facebook_page' });
  if (!s.ok) die(`no live configuration for «${set.tenantSlug}»: ${s.detail}`);
  const actual = createHash('sha256').update(s.snapshot.promptStable, 'utf8').digest('hex');
  if (actual !== s.snapshot.contentHash) {
    die(`the live prompt hashes to ${actual.slice(0, 12)}, its snapshot says ${s.snapshot.contentHash.slice(0, 12)}; refusing to measure something else`);
  }
  return { revisionId: s.snapshot.revisionId, contentHash: s.snapshot.contentHash, allowedNumbers: [...s.snapshot.allowedNumbers] };
}
const before = await snapshot();

// ------------------------------------------------------------------------ the model seat
const PRICES = (MODELS.prices as Record<string, { in: number; out: number; cacheRead: number; cacheWrite1h: number }>)[MODEL_REGISTRY.reception];
function usdOf(u: Record<string, number> | undefined): number | null {
  if (u === undefined || PRICES === undefined) return null;
  return ((u['input_tokens'] ?? 0) * PRICES.in + (u['output_tokens'] ?? 0) * PRICES.out
    + (u['cache_read_input_tokens'] ?? 0) * PRICES.cacheRead
    + (u['cache_creation_input_tokens'] ?? 0) * PRICES.cacheWrite1h) / 1e9;
}

let callsMade = 0;
let bucket: Call[] = [];
async function callModel(req: ReceptionRequest): Promise<CallOutcome> {
  let retried = false;
  for (;;) {
    if (callsMade >= maxCalls) throw new Error(`--max-calls ${maxCalls} reached; stopping before the next call`);
    callsMade += 1;
    const t0 = Date.now();
    const outcome = await callReception(req, key);
    const call: Call = { ms: Date.now() - t0, kind: outcome.kind };
    if (outcome.kind === 'ok') call.text = outcome.text; else call.reason = outcome.reason;
    if ('usage' in outcome && outcome.usage !== undefined) {
      call.usage = { ...outcome.usage } as Record<string, number>;
      call.usd = usdOf(call.usage);
    }
    bucket.push(call);
    if (outcome.kind === 'retryable' && !retried) { retried = true; await new Promise((r) => setTimeout(r, 2_000)); continue; }
    return outcome;
  }
}

// ------------------------------------------------------------------------ the cases
process.stdout.write(`testset: ${set.title} · ${set.tenantSlug} · ${source} · prompt ${before.contentHash.slice(0, 12)} verified`
  + ` · ${noModel ? 'NO MODEL' : MODEL_REGISTRY.reception} · now ${NOW.toISOString()}\n`);

const results: CaseRun[] = [];
for (const [i, c] of set.cases.entries()) {
  if (only !== null && !only.includes(c.id)) continue;
  const rc = asReplyCase(c, set.alwaysNot, i + 1);
  const row = {
    id: rc.id, tenant_id: tenantId, active: true, customer_message: rc.customerMessage, history: rc.history,
    expected_body: rc.expectedBody, must_include: rc.mustInclude, must_not_include: rc.mustNotInclude, note: null,
  };
  bucket = [];
  const t0 = Date.now();
  // A throw (a stale dump, a transport error) is this case UNCHECKED, never the end of the run
  // and never a pass — the same rule the gate applies.
  const gate = await gateTenant(withCases(db, [row]), { slug: set.tenantSlug, now: NOW, callModel: noModel ? null : callModel })
    .catch((err: unknown) => ({ ok: false as const, slug: set.tenantSlug, detail: `threw: ${err instanceof Error ? err.message : String(err)}` }));
  const totalMs = Date.now() - t0;
  const r = gate.ok ? gate.results[0] : undefined;
  const run: CaseRun = r === undefined
    ? { id: c.id, ok: false, error: gate.ok ? 'no result' : gate.detail, reply: null, answeredBy: null, flags: [],
        pass: false, outcome: 'unchecked', why: [gate.ok ? 'no result' : gate.detail], calls: bucket, totalMs }
    : { id: c.id, ok: true, reply: r.reply, answeredBy: r.answeredBy, flags: r.flags, pass: r.pass, outcome: r.outcome, why: r.why, calls: bucket, totalMs };
  results.push(run);
  const model = run.calls.length === 0 ? 'no model' : run.calls.map((x) => `${x.kind}${x.reason ? `:${x.reason}` : ''} ${x.ms}ms`).join(', ');
  process.stdout.write(`  ${c.id.padEnd(5)} ${run.outcome.toUpperCase().padEnd(9)} ${String(run.answeredBy ?? '—').padEnd(13)} [${model}]`
    + `${run.why.length > 0 ? `  ${run.why.join('; ')}` : ''}\n`);
}

const after = await snapshot();
const out: Run = {
  ranAt: new Date().toISOString(), tenant: set.tenantSlug, model: noModel ? 'none (--no-model)' : MODEL_REGISTRY.reception,
  now: NOW.toISOString(), source, revisionId: before.revisionId, contentHash: before.contentHash,
  contentHashAfter: after.contentHash, allowedNumbers: before.allowedNumbers, callsMade, results,
};
mkdirSync(dirname(runFile), { recursive: true });
writeFileSync(runFile, `${JSON.stringify(out, null, 2)}\n`);
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(reportFile, renderReport(set, out, { runFile, generator: 'scripts/bakeoff/testset.ts' }));
const count = (o: string) => results.filter((r) => r.outcome === o).length;
process.stdout.write(`\n${count('pass')} pass · ${count('wrong')} wrong · ${count('unchecked')} unchecked · ${callsMade} model call(s)\n`
  + `wrote ${runFile} and ${reportFile}\n`);
