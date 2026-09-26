/**
 * Run ONE model arm over a tenant's full test set, through the code production answers with.
 *
 *     EGUNE_API_KEY=…     node scripts/bakeoff/arms.ts --arm egune  --tag night1 [--egune-model egune1-14b]
 *     ANTHROPIC_API_KEY=… node scripts/bakeoff/arms.ts --arm sonnet --tag night1
 *     node scripts/bakeoff/compare.mjs --a sonnet-night1 --b egune-night1 > report.md
 *
 * ## What is real
 *
 * Every message goes through `gateTenant` (`src/lib/replycases/run.ts`), which is the D-120
 * gate the production build runs: the REAL `loadReceptionContext`, the REAL `handleReception`
 * — gate, deterministic rows, pinned lines, facts guard, outbound guard — over the tenant's
 * LIVE rows. The rows come from a dump (`--dump`, default `tara-live.json`) served by
 * `fixtureDb.ts`, which is read-only by construction. Before anything is called, the dumped
 * `prompt_stable` must hash to the snapshot's own `content_hash`: the prompt under test is the
 * one live customers are answered with, byte for byte, or nothing runs.
 *
 * The ONLY thing an arm changes is the model seat. `sonnet` is `callReception` with the
 * registry's model and the tenant's cache mode; `egune` is `egune.ts`. Same prompt, same data,
 * same guards, same production timeout.
 *
 * ## The test set
 *
 *  - every active `reply_cases` row in the dump — the permanent cases the founder marked,
 *    judged by the gate's own `judge()` against his expected answer;
 *  - `testset.json`'s cases and its two conversations, played turn by turn with the arm's own
 *    replies fed back as history (D-111);
 *  - `tara-set.json`'s rebrand probes.
 *
 * `testset.json`'s three ATTACHMENT cases are left out and said so: the case runner takes text
 * only, two of them have no text at all and are answered without any model, and running the
 * third without its photo would test a message nobody sent.
 *
 * ## What is sent where
 *
 * To the model: the tenant's prompt and the test messages, nothing else — no customer name, no
 * customer phone number (the two personal names in the set are staff names already in the
 * prompt). Nothing is written anywhere but `runs/`. No Meta client is imported.
 *
 * ## Spend
 *
 * One call per message that reaches the model, plus at most ONE retry of a retryable failure,
 * as QStash would give production. `--max-calls` (default 120) stops the run before it
 * exceeds that, so a loop cannot spend.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gateTenant } from '../../src/lib/replycases/run.ts';
import { callReception, type CallOutcome, type ReceptionRequest } from '../../src/lib/model/reception.ts';
import { MODEL_REGISTRY } from '../../src/config/platform.ts';
import { callEgune, EGUNE_DEFAULT_MODEL, type EguneTrace } from './egune.ts';
import { fixtureDb, type Dump } from './fixtureDb.ts';

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
function die(msg: string, code = 2): never { process.stderr.write(`arms: ${msg}\n`); process.exit(code); }

const arm = arg('arm');
if (arm !== 'sonnet' && arm !== 'egune') die('--arm must be sonnet or egune');
const tag = arg('tag') ?? 'run';
const eguneModel = arg('egune-model') ?? EGUNE_DEFAULT_MODEL;
// For the harness's own tests against a local mock server; the default is Egune's real API.
const eguneBase = arg('egune-base');
const maxCalls = Number(arg('max-calls') ?? 120);
const only = arg('only')?.split(',') ?? null;
// One fixed instant for every message and both arms, so an answer about opening hours is
// the same question for each. Afternoon in Ulaanbaatar by default: a night-time run was once
// read as a timezone bug (dala.ts, c05).
const NOW = new Date(arg('now') ?? `${new Date().toISOString().slice(0, 10)}T14:00:00+08:00`);
if (Number.isNaN(NOW.getTime())) die('--now is not a date');

const keyName = arm === 'sonnet' ? 'ANTHROPIC_API_KEY' : 'EGUNE_API_KEY';
const key = process.env[keyName] ?? '';
if (key === '') die(`${keyName} is not set. Nothing was called and nothing was spent.`);

// ---------------------------------------------------------------------------- the dump
const dumpPath = arg('dump') ?? 'scripts/bakeoff/tara-live.json';
const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump;
const tenant = (dump['tenants'] ?? [])[0];
const snap = (dump['config_snapshots'] ?? [])[0];
if (tenant === undefined || snap === undefined) die(`${dumpPath} has no tenant or no live snapshot`);
const slug = String(tenant['slug']);
const actualHash = createHash('sha256').update(String(snap['prompt_stable']), 'utf8').digest('hex');
if (actualHash !== snap['content_hash']) {
  die(`${dumpPath}: prompt_stable hashes to ${actualHash.slice(0, 12)}, the snapshot says ${String(snap['content_hash']).slice(0, 12)}. `
    + 'The dump is not the live prompt; refusing to measure something else.');
}

// ---------------------------------------------------------------------------- the model seat
// `text` is the MODEL's own reply, before any guard. The served reply is in the result; the
// two differ exactly when a guard discarded what the model wrote, which is the finding.
type Call = { ms: number; kind: string; reason?: string; usage?: unknown; text?: string; retried: boolean; egune?: EguneTrace | null };
let callsMade = 0;
let bucket: Call[] = [];

async function once(req: ReceptionRequest): Promise<{ outcome: CallOutcome; egune?: EguneTrace | null }> {
  if (arm === 'sonnet') return { outcome: await callReception(req, key) };
  const r = await callEgune(req, key, { model: eguneModel, ...(eguneBase === undefined ? {} : { baseUrl: eguneBase }) });
  return { outcome: r.outcome, egune: r.trace };
}

async function callModel(req: ReceptionRequest): Promise<CallOutcome> {
  let retried = false;
  for (;;) {
    if (callsMade >= maxCalls) throw new Error(`--max-calls ${maxCalls} reached; stopping before the next call`);
    callsMade += 1;
    const t0 = Date.now();
    const { outcome, egune } = await once(req);
    const call: Call = { ms: Date.now() - t0, kind: outcome.kind, retried, egune: egune ?? undefined };
    if (outcome.kind !== 'ok') call.reason = outcome.reason; else call.text = outcome.text;
    if ('usage' in outcome) call.usage = outcome.usage;
    bucket.push(call);
    if (outcome.kind === 'retryable' && !retried) { retried = true; await new Promise((r) => setTimeout(r, 2_000)); continue; }
    return outcome;
  }
}

// ---------------------------------------------------------------------------- one message
type Turn = { role: 'user' | 'assistant'; content: string };
async function ask(id: string, text: string, history: Turn[], expect: Record<string, unknown> | null) {
  const caseRow = {
    id: 1, tenant_id: tenant!['id'], active: true, customer_message: text, history,
    expected_body: expect?.['expected_body'] ?? null,
    must_include: expect?.['must_include'] ?? [], must_not_include: expect?.['must_not_include'] ?? [],
    note: null,
    // `reply_cases.channel` (`0056`, D-140): the bake-off asks as the Page does.
    channel: 'facebook_page',
  };
  bucket = [];
  const t0 = Date.now();
  const gate = await gateTenant(fixtureDb({ ...dump, reply_cases: [caseRow] }), { slug, now: NOW, callModel });
  const totalMs = Date.now() - t0;
  const calls = bucket;
  if (!gate.ok) return { id, text, ok: false, error: gate.detail, calls, totalMs };
  const r = gate.results[0];
  if (r === undefined) return { id, text, ok: false, error: 'no result', calls, totalMs };
  return {
    id, text, ok: true, reply: r.reply, answeredBy: r.answeredBy, flags: r.flags,
    judged: expect !== null, pass: r.pass, outcome: r.outcome, why: r.why, calls, totalMs,
  };
}

const want = (id: string) => only === null || only.includes(id);
const results: Record<string, unknown>[] = [];
function log(r: Record<string, unknown>) {
  const calls = r['calls'] as Call[];
  const model = calls.length === 0 ? 'no model' : calls.map((c) => `${c.kind}${c.reason ? `:${c.reason}` : ''} ${c.ms}ms`).join(', ');
  process.stdout.write(`  ${String(r['id']).padEnd(12)} ${r['ok'] ? `${r['answeredBy']}` : `ERROR ${r['error']}`}`
    + `${r['judged'] ? (r['pass'] ? '  PASS' : '  WRONG') : ''}  [${model}]\n`);
}

process.stdout.write(`arms: ${arm}${arm === 'egune' ? ` (${eguneModel})` : ` (${MODEL_REGISTRY.reception})`} · ${slug} `
  + `· prompt ${actualHash.slice(0, 12)} verified · now ${NOW.toISOString()}\n`);

// 1. The permanent cases, each with its own history and expected answer.
for (const c of dump['reply_cases'] ?? []) {
  const id = `case:${c['id']}`;
  if (!want(id)) continue;
  const r = await ask(id, String(c['customer_message']), (c['history'] as Turn[]) ?? [], c);
  results.push({ set: 'reply_case', ...r }); log(r);
}

// 2. The comparison set, and 3. the rebrand probes.
for (const [set, file] of [['comparison', 'scripts/bakeoff/testset.json'], ['tara', 'scripts/bakeoff/tara-set.json']] as const) {
  const t = JSON.parse(readFileSync(file, 'utf8')) as {
    cases: { id: string; text: string; expect?: string }[];
    conversations?: { id: string; turns: string[] }[];
  };
  for (const c of t.cases) {
    const id = `${set}:${c.id}`;
    if (!want(id)) continue;
    const r = await ask(id, c.text, [], null);
    results.push({ set, expect: c.expect ?? null, ...r }); log(r);
  }
  for (const conv of t.conversations ?? []) {
    const history: Turn[] = [];
    for (const [i, turn] of conv.turns.entries()) {
      const id = `${set}:${conv.id}.${i + 1}`;
      if (!want(id)) continue;
      const r = await ask(id, turn, [...history], null);
      results.push({ set: `${set}-conversation`, conversation: conv.id, turn: i + 1, ...r }); log(r);
      history.push({ role: 'user', content: turn });
      if (r.ok && typeof r.reply === 'string') history.push({ role: 'assistant', content: r.reply });
    }
  }
}

mkdirSync('scripts/bakeoff/runs', { recursive: true });
const out = `scripts/bakeoff/runs/${arm}-${tag}.json`;
writeFileSync(out, `${JSON.stringify({
  ranAt: new Date().toISOString(), arm, model: arm === 'egune' ? eguneModel : MODEL_REGISTRY.reception,
  tenant: slug, contentHash: snap['content_hash'], now: NOW.toISOString(), callsMade, results,
}, null, 2)}\n`);
process.stdout.write(`\n${callsMade} model call(s). wrote ${out}\n`);
