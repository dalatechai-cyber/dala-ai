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
 * case of every tenant passes; exit 1 when one fails; exit 2 when the check could not run —
 * no database key, an unreadable table. A gate that cannot look must not wave anything
 * through.
 *
 * `ANTHROPIC_API_KEY` is optional: a case answered before the model (most of them — they are
 * deterministic rows) needs no key, and a case that does reach the model FAILS without one
 * rather than being skipped. Keys are read from the environment, never from an argument,
 * and nothing here prints one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { gateTenant, renderGate, type TenantGate } from '../../src/lib/replycases/run.ts';
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
// founder's machine, where that is the one he holds. Both through the shared clients, so
// `cache: 'no-store'` is set (CLAUDE.md rule 8) and no bare client is constructed.
const hasWorker = (process.env['SUPABASE_SECRET_WORKER'] ?? '') !== '';
const hasPublish = (process.env['SUPABASE_SECRET_PUBLISH'] ?? '') !== '';
if ((process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '') === '' || (!hasWorker && !hasPublish)) {
  die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_WORKER (or SUPABASE_SECRET_PUBLISH) are required');
}
const db: SupabaseClient = hasWorker ? supabaseWorker() : supabasePublish();

const key = process.env['ANTHROPIC_API_KEY'] ?? '';
const callModel = key === '' ? null : (req: Parameters<typeof callReception>[0]) => callReception(req, key);

let slugs: string[];
const only = arg('slug');
if (only !== undefined) {
  slugs = [only];
} else {
  const { data, error } = await db.from('reply_cases').select('tenant_id').eq('active', true);
  if (error) die(`reply_cases unreadable: ${error.message}`);
  const ids = [...new Set((data ?? []).map((r) => String((r as Record<string, unknown>)['tenant_id'])))];
  if (ids.length === 0) {
    process.stdout.write('reply-cases: no active cases.\n');
    process.exit(0);
  }
  const { data: tenants, error: tErr } = await db.from('tenants').select('id, slug').in('id', ids);
  if (tErr) die(`tenants unreadable: ${tErr.message}`);
  slugs = (tenants ?? []).map((t) => String((t as Record<string, unknown>)['slug'])).sort();
  if (slugs.length !== ids.length) die('a tenant with active cases could not be read');
}

const gates: TenantGate[] = [];
for (const slug of slugs) gates.push(await gateTenant(db, { slug, now: new Date(), callModel }));
const { text, pass } = renderGate(gates);
process.stdout.write(`${text}\n`);
if (gates.some((g) => !g.ok)) process.exit(2);
if (!pass) {
  process.stderr.write('reply-cases: a marked reply is answered wrongly. Nothing goes out until it passes.\n');
  process.exit(1);
}
process.stdout.write('reply-cases: every case passes.\n');
