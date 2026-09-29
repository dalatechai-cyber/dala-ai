/**
 * Where a brand's branches stand against each other, read-only (founder, 2026-09-29;
 * `docs/standards/dali.md` §7). For every branch tenant in the group:
 *
 *  - the branch gate, as publish runs it: another branch's phone, map link, address or staff
 *    name in its rows (LEAK), and prices or a booking link that differ (DRIFT);
 *  - whether its live snapshot is what its rows compile to now. Rows that agree across
 *    branches still reach a customer only when each branch is published, so a branch whose
 *    rows changed since its last publish is named STALE with the command that publishes it.
 *
 *     node scripts/facts/branches.ts --group tara-salon
 *     node scripts/facts/branches.ts --slug matrix-eco-salon     # that tenant's group
 *
 * Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_PUBLISH` (the operator's), and
 * `npm install`. Writes nothing, calls no model, spends nothing. Exits 1 when anything is
 * found, stale or unreadable, so it can stand in a checklist.
 */
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { compileStablePrefix } from '../../src/lib/prompt/sections.ts';
import { loadLiveSnapshot, publishNeeded, type LoadOutcome } from '../../src/lib/prompt/publish.ts';
import { branchGate, branchGroups } from './branchGate.ts';

const out = (s = '') => process.stdout.write(`${s}\n`);
function die(message: string): never {
  process.stderr.write(`branches: ${message}\n`);
  process.exit(2);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

let groups;
try {
  groups = branchGroups();
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
const want = arg('group');
const slugArg = arg('slug');
const group = want !== undefined ? groups.find((g) => g.name === want)
  : slugArg !== undefined ? groups.find((g) => g.tenants.includes(slugArg)) : undefined;
if (group === undefined) {
  die(`name a group with --group (${groups.map((g) => g.name).join(', ') || 'none configured'}) or a member with --slug`);
}

const db = supabasePublish();
const now = new Date();
let bad = 0;
out(`branch group ${group.name}: ${group.tenants.join(', ')}`);
for (const slug of group.tenants) {
  out(`\n== ${slug}`);
  const { data, error } = await db.from('tenants').select('id').eq('slug', slug).maybeSingle();
  if (error) { out(`UNREADABLE tenants: ${error.message}`); bad++; continue; }
  if (data === null) { out('not provisioned yet.'); continue; }
  const tenantId = String((data as Record<string, unknown>)['id']);

  const gate = await branchGate(db, { slug, tenantId, groups });
  out(gate.text);
  bad += gate.leaks.length + gate.drift.length + gate.pendingDrift.length + gate.unchecked.length;

  // Is what customers are answered from the same as what the rows say now?
  const compiled = await compileStablePrefix(db, { tenantId, approvedAt: now.toISOString() });
  if (!compiled.ok) {
    out(`live snapshot: UNCHECKED, the rows do not compile (${compiled.code === 'refused' ? compiled.refusal.code : compiled.detail})`);
    bad++;
    continue;
  }
  const { data: ch, error: chErr } = await db.from('tenant_channels').select('provider').eq('tenant_id', tenantId);
  if (chErr) { out(`live snapshot: UNCHECKED, tenant_channels unreadable: ${chErr.message}`); bad++; continue; }
  const channels = [...new Set((ch ?? []).map((r) => String((r as Record<string, unknown>)['provider'])))];
  const live = new Map<string, LoadOutcome>();
  for (const c of channels) live.set(c, await loadLiveSnapshot(db, { tenantId, channel: c }));
  const unreadable = [...live].filter(([, o]) => !o.ok && o.code === 'unavailable').map(([c]) => c);
  if (unreadable.length > 0) { out(`live snapshot: UNCHECKED on ${unreadable.join(', ')}`); bad++; continue; }
  const need = publishNeeded(channels, live, {
    contentHash: compiled.rendered.contentHash, cannedHash: compiled.cannedHash, launchStates: compiled.launch,
  });
  if (need.needed) {
    out(`live snapshot: STALE on ${[...need.missing, ...need.changed].join(', ')} — customers are answered from rows that are no longer these.`
      + `\n  publish it: node scripts/publish/tenant.ts --slug ${slug}   (dry run first; --publish writes)`);
    bad++;
  } else {
    out(`live snapshot: current on ${channels.join(', ') || '(no channels)'}.`);
  }
}
out(bad === 0 ? '\nEvery branch gives only its own details, the shared facts agree, and every snapshot is current.' : `\n${bad} finding(s) above.`);
process.exit(bad === 0 ? 0 : 1);
