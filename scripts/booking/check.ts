/**
 * Do a brand's branches book alike? Reads each branch tenant's `booking_config` (the group is
 * `config/branch-groups.json`) and prints every difference (`src/lib/booking/branches.ts`).
 * Read-only; the operator's environment (`SUPABASE_SECRET_PUBLISH`). Exit 1 on any finding.
 *
 *     node scripts/booking/check.ts --group tara-salon
 */
import { readFileSync } from 'node:fs';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { compareBranches } from '../../src/lib/booking/branches.ts';
import { readConfig } from '../../src/lib/booking/store.ts';

const i = process.argv.indexOf('--group');
const group = i === -1 ? undefined : process.argv[i + 1];
if (group === undefined) { process.stderr.write('--group <name> is required\n'); process.exit(2); }
const groups = JSON.parse(readFileSync('config/branch-groups.json', 'utf8')) as Record<string, { tenants?: string[] }>;
const slugs = groups[group]?.tenants ?? [];
if (slugs.length === 0) { process.stderr.write(`no group ${group}\n`); process.exit(2); }
const db = supabasePublish();
const branches = [];
for (const slug of slugs) {
  const t = await db.from('tenants').select('id').eq('slug', slug).maybeSingle();
  if (t.error) { process.stderr.write(`${slug}: unreadable\n`); process.exit(2); }
  if (t.data === null) { process.stdout.write(`${slug}: not provisioned, skipped\n`); continue; }
  const c = await readConfig(db, String((t.data as Record<string, unknown>)['id']));
  if (!c.ok) { process.stderr.write(`${slug}: ${c.detail}\n`); process.exit(2); }
  if (!c.present) { process.stdout.write(`${slug}: no booking_config, skipped\n`); continue; }
  if (!c.valid) { process.stdout.write(`${slug}: INVALID ${c.detail}\n`); process.exitCode = 1; continue; }
  process.stdout.write(`${slug}: mode ${c.mode}, ${c.config.stylists.length} stylists\n`);
  branches.push({ slug, config: c.config });
}
const findings = compareBranches(branches);
for (const f of findings) process.stdout.write(`  ${f.kind.toUpperCase()}  ${f.detail}\n`);
if (findings.length > 0) process.exitCode = 1;
else process.stdout.write('the branches book alike\n');
