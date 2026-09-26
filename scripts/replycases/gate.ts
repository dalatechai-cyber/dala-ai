/**
 * Every reply case must pass, or nothing goes out (D-120).
 *
 *     NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_WORKER=… ANTHROPIC_API_KEY=… \
 *       node scripts/replycases/gate.ts [--slug matrix-eco-salon]
 *
 * Runs in the Vercel PRODUCTION build (`vercel.json`), after preflight and before
 * `next build`, so a deployment whose code answers a marked case wrongly never replaces the
 * one that is live. `scripts/publish/tenant.ts` runs the same cases against the prefix it is
 * about to publish, so a configuration change is held to the same list.
 *
 * With no `--slug`, every tenant that has an active case is checked. Exit 0 only when every
 * case of every tenant passes; exit 1 when one is answered wrongly; exit 2 when the check
 * could not run — no database key, an unreadable table, the model unavailable, a timeout.
 * A gate that cannot look must not wave anything through.
 *
 * The one exception is the founder's emergency override (D-121, `replycases/override.ts`):
 * `REPLY_GATE_OVERRIDE` holding a token signed by a registered founder key, for THIS commit,
 * within its window. It lets through cases that could not be checked, never one answered
 * wrongly, and only after a Telegram alert has been delivered. Tokens are minted with
 * `scripts/replycases/override.ts` on the founder's machine.
 *
 * `REPLY_GATE_PRINT=1` additionally prints each case's customer message and reply verbatim,
 * before the summary — so a run through the production path can be the source for a native
 * read. It never changes the exit code. Off by default: a marked case carries a real
 * customer's words, and a build log has more readers than the founder.
 *
 * `ANTHROPIC_API_KEY` is optional: a case answered before the model (most of them — they are
 * deterministic rows) needs no key, and a case that does reach the model FAILS without one
 * rather than being skipped. Keys are read from the environment, never from an argument,
 * and nothing here prints one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { caseModelSeat, findingsOf, gateTenant, renderGate, renderReplies, type TenantGate } from '../../src/lib/replycases/run.ts';
import { decide } from '../../src/lib/replycases/override.ts';
import { FOUNDER_OVERRIDE_KEYS } from '../../src/lib/replycases/overrideKeys.ts';
import { sendTelegram } from '../../src/lib/alerts/alert.ts';
import { callReception } from '../../src/lib/model/reception.ts';
import { supabasePublish, supabaseWorker } from '../../src/lib/supabase/clients.ts';

function die(message: string): never {
  process.stderr.write(`reply-cases: ${message}\n`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// The worker's key in the production build, where it already exists; the publish key on the
// founder's machine, where that is the one the founder holds. Both through the shared clients, so
// `cache: 'no-store'` is set (CLAUDE.md rule 8) and no bare client is constructed.
const hasWorker = (process.env['SUPABASE_SECRET_WORKER'] ?? '') !== '';
const hasPublish = (process.env['SUPABASE_SECRET_PUBLISH'] ?? '') !== '';
if ((process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '') === '' || (!hasWorker && !hasPublish)) {
  die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_WORKER (or SUPABASE_SECRET_PUBLISH) are required');
}
const db: SupabaseClient = hasWorker ? supabaseWorker() : supabasePublish();

// NO SPEND BY DEFAULT (D-137, founder 2026-09-26: *"Live customers are the only thing allowed to
// spend."*). The build has ANTHROPIC_API_KEY because the reply worker needs it; the gate does not
// use it. Only the cases that never reach the model block a deploy; a case that needs the model
// is listed as not run. REPLY_GATE_MODEL=1 runs them too, by hand, before a big change.
const withModel = process.env['REPLY_GATE_MODEL'] === '1';
const key = withModel ? (process.env['ANTHROPIC_API_KEY'] ?? '') : '';
const callModel = key === '' ? null : caseModelSeat((req: Parameters<typeof callReception>[0]) => callReception(req, key));
const modelCases = withModel ? 'fail' as const : 'skip' as const;

/** Past this, the database or the model is not answering, and that is a finding, not a hang. */
const GATE_TIMEOUT_MS = 180_000;
/** The best-effort log write gets its own, shorter bound: it must not hold the build hostage. */
const LOG_TIMEOUT_MS = 10_000;

function within<T>(ms: number, work: Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Run every case. A read that fails is a finding (`unchecked`), never an exit of its own. */
async function check(): Promise<{ gates: TenantGate[]; setup: string[] }> {
  const only = arg('slug');
  if (only !== undefined) return { gates: [await gateTenant(db, { slug: only, now: new Date(), callModel, modelCases })], setup: [] };
  const { data, error } = await db.from('reply_cases').select('tenant_id').eq('active', true);
  if (error) return { gates: [], setup: [`reply_cases unreadable: ${error.message}`] };
  const ids = [...new Set((data ?? []).map((r) => String((r as Record<string, unknown>)['tenant_id'])))];
  if (ids.length === 0) return { gates: [], setup: [] };
  const { data: tenants, error: tErr } = await db.from('tenants').select('id, slug').in('id', ids);
  if (tErr) return { gates: [], setup: [`tenants unreadable: ${tErr.message}`] };
  const slugs = (tenants ?? []).map((t) => String((t as Record<string, unknown>)['slug'])).sort();
  const setup = slugs.length === ids.length ? [] : ['a tenant with active cases could not be read'];
  const gates: TenantGate[] = [];
  for (const slug of slugs) gates.push(await gateTenant(db, { slug, now: new Date(), callModel, modelCases }));
  return { gates, setup };
}

const ran = await within(GATE_TIMEOUT_MS, check().catch((err: unknown) => ({
  gates: [] as TenantGate[], setup: [`the check threw: ${err instanceof Error ? err.message : String(err)}`],
})), () => ({ gates: [] as TenantGate[], setup: [`timed out after ${GATE_TIMEOUT_MS / 1000}s: the database or the model did not answer`] }));

// `REPLY_GATE_PRINT=1` also prints every case's reply verbatim, for a native read. It is
// output only: the verdict below is computed from `ran` exactly as without it.
if (process.env['REPLY_GATE_PRINT'] === '1') process.stdout.write(renderReplies(ran.gates));
if (ran.gates.length > 0) process.stdout.write(`${renderGate(ran.gates).text}\n`);
if (ran.gates.length === 0 && ran.setup.length === 0) process.stdout.write('reply-cases: no active cases.\n');
const found = findingsOf(ran.gates);
const decision = await decide(
  { wrong: found.wrong, unchecked: [...ran.setup, ...found.unchecked] },
  {
    token: process.env['REPLY_GATE_OVERRIDE'],
    sha: process.env['VERCEL_GIT_COMMIT_SHA'],
    now: new Date(),
    publicKeys: FOUNDER_OVERRIDE_KEYS,
    alert: async (text) => sendTelegram(text),
    // Best effort, bounded: the database being down is one of the two reasons this exists.
    record: async ({ body, dedupKey }) => within(LOG_TIMEOUT_MS, (async () => {
      const { error } = await db.from('alerts').insert({
        tenant_id: null, severity: 'critical', kind: 'deploy.gate_override', dedup_key: dedupKey, body,
        delivered: true, route: 'now', repeat_policy: 'once', notified_at: new Date().toISOString(),
      });
      return error === null ? 'alerts row written' : `not written (${error.message})`;
    })().catch((err: unknown) => `not written (${err instanceof Error ? err.message : String(err)})`),
    () => `not written (no answer in ${LOG_TIMEOUT_MS / 1000}s)`),
  },
);
for (const line of decision.lines) (decision.exit === 0 ? process.stdout : process.stderr).write(`${line}\n`);
process.exit(decision.exit);
