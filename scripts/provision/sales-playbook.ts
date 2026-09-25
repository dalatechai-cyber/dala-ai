/**
 * Print the SQL that switches one tenant's sales next-step SHADOW on (D-127).
 *
 *     node scripts/provision/sales-playbook.ts <tenant-slug> --template salon
 *     node scripts/provision/sales-playbook.ts <tenant-slug> --template software --link demo=https://…
 *
 * Writes NOTHING, and needs `0051` pushed before its output can run. The tenant, and any
 * link that is the tenant's own, are ARGUMENTS (CLAUDE.md: a script that names a tenant
 * takes it as an argument). Every intent matcher is validated with the runtime's own
 * `parsePlaybook` before anything is printed.
 *
 * What the SQL does, and what it never does:
 *  - sets `sales_playbooks.mode = 'shadow'` and the template's lead route. `shadow` is the
 *    only mode besides `off` that the table admits: there is no live mode to switch on.
 *  - upserts the template's step rows — kind, priority, default, intent words, link — and
 *    NEVER writes `body` or `reviewed_at`. The words are the founder's; this cannot set them,
 *    and re-running it cannot overwrite a sentence he has approved.
 *  - inserts the template's service pairings as `seeded`, skipping any that exist.
 *
 * A pairing whose names are not on the tenant's compiled price list is inert: the shadow
 * matches names against the list at use.
 */
import { readFileSync } from 'node:fs';
import { parsePlaybook } from '../../src/lib/sales/nextStep.ts';

const args = process.argv.slice(2);
const slug = args.find((a, i) => !a.startsWith('--') && !['--template', '--link'].includes(args[i - 1] ?? ''));
const ti = args.indexOf('--template');
const template = ti >= 0 ? args[ti + 1] : undefined;
const links = new Map<string, string>();
args.forEach((a, i) => {
  if (a === '--link') {
    const [k, ...v] = (args[i + 1] ?? '').split('=');
    if (k !== undefined && v.length > 0) links.set(k, v.join('='));
  }
});
if (slug === undefined || !/^[a-z0-9-]+$/.test(slug) || template === undefined || !/^[a-z0-9_-]+$/.test(template)) { // ascii-safe: slugs and template names are ASCII identifiers
  console.error('usage: node scripts/provision/sales-playbook.ts <tenant-slug> --template <salon|software> [--link demo=https://…]');
  process.exit(2);
}

type Step = { kind: string; priority: number; is_default: boolean; intent_matcher: unknown; link_from?: 'tenant_booking' | 'argument' };
type Doc = { lead_route: string; steps: Step[]; pairings: { service_name: string; related_name: string }[] };
const doc = JSON.parse(readFileSync(new URL(`./templates/sales_playbook.${template}.json`, import.meta.url), 'utf8')) as Doc;

for (const s of doc.steps) {
  if (s.link_from === 'argument') {
    const l = links.get(s.kind);
    if (l === undefined || !/^https:\/\/\S+$/.test(l)) { // ascii-safe: a URL shape check
      console.error(`refusing: step ${s.kind} needs --link ${s.kind}=https://… (the tenant's own link)`);
      process.exit(2);
    }
  }
}

const parsed = parsePlaybook({
  mode: 'shadow',
  lead_route: doc.lead_route,
  steps: doc.steps.map((s) => ({ ...s, body: null, reviewed_at: null, enabled: true })),
  pairings: doc.pairings.map((p) => ({ ...p, enabled: true, provenance: 'seeded' })),
});
if (!parsed.ok) {
  console.error(`refusing: the template has rows the runtime would refuse: ${parsed.detail}`);
  process.exit(1);
}

const q = (s: string): string => {
  if (s.includes('$r$')) throw new Error('template contains the quoting tag');
  return `$r$${s}$r$`;
};
const linkSql = (s: Step): string => s.link_from === 'tenant_booking'
  ? '(select b.booking_url from tenant_booking b where b.tenant_id = t.id)'
  : s.link_from === 'argument' ? q(links.get(s.kind) ?? '') : 'null';
const stepValues = doc.steps.map((s) =>
  `  select t.id, ${q(s.kind)}, ${s.priority}::smallint, ${s.is_default}, `
  + `${s.intent_matcher === null ? 'null' : `${q(JSON.stringify(s.intent_matcher))}::jsonb`}, ${linkSql(s)}, true\n`
  + `    from tenants t where t.slug = ${q(slug)}`).join('\n  union all\n');
const pairValues = doc.pairings.map((p) => `  (${q(p.service_name)}, ${q(p.related_name)})`).join(',\n');

console.log(`-- D-127 sales shadow for tenant ${slug}, from templates/sales_playbook.${template}.json.
-- Shadow only: records a quality_flags row per reply; sends nothing. Needs 0051 pushed.
begin;
insert into sales_playbooks (tenant_id, mode, lead_route)
select t.id, 'shadow', ${q(doc.lead_route)} from tenants t where t.slug = ${q(slug)}
on conflict (tenant_id) do update set mode = excluded.mode, lead_route = excluded.lead_route, updated_at = now();
insert into sales_next_steps (tenant_id, kind, priority, is_default, intent_matcher, link, enabled)
${stepValues}
on conflict (tenant_id, kind) do update
   set priority = excluded.priority, is_default = excluded.is_default,
       intent_matcher = excluded.intent_matcher, link = excluded.link, enabled = true;
${doc.pairings.length === 0 ? '' : `insert into service_pairings (tenant_id, service_name, related_name, enabled, provenance)
select t.id, v.service_name, v.related_name, true, 'seeded'
  from tenants t, (values
${pairValues}
  ) as v(service_name, related_name)
 where t.slug = ${q(slug)}
on conflict do nothing;
`}commit;`);
