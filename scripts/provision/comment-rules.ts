/**
 * Print the SQL that gives one tenant a vertical's comment rules (D-122).
 *
 *     node scripts/provision/comment-rules.ts <tenant-slug> [--template salon]
 *
 * Writes NOTHING. It validates every matcher with the runtime's own `parseMatcher` and
 * prints one transaction for the SQL editor. The tenant is an ARGUMENT, never a literal
 * (CLAUDE.md: "a script that names a tenant takes it as an ARGUMENT").
 *
 * The transaction is non-destructive: the template's rules are upserted and switched on,
 * and every OTHER rule the tenant has is switched OFF, not deleted — a person can read what
 * was there and switch it back. Switching comments on or off is a different statement
 * (`tenant_channels.comment_delivery_mode`); rules alone post nothing.
 *
 * `provenance = 'seeded'`: these are the platform's words for a vertical, not the tenant's.
 */
import { readFileSync } from 'node:fs';
import { parseMatcher } from '../../src/lib/gate/match.ts';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const ti = args.indexOf('--template');
const template = ti >= 0 ? args[ti + 1] : 'salon';
if (slug === undefined || !/^[a-z0-9-]+$/.test(slug) || template === undefined || !/^[a-z0-9_-]+$/.test(template)) { // ascii-safe: slugs and template names are ASCII identifiers
  console.error('usage: node scripts/provision/comment-rules.ts <tenant-slug> [--template salon]');
  process.exit(2);
}

type Row = { rule_key: string; verdict: string; matcher: unknown };
const doc = JSON.parse(readFileSync(new URL(`./templates/comment_rules.${template}.json`, import.meta.url), 'utf8')) as { rules: Row[] };

const bad: string[] = [];
for (const r of doc.rules) {
  const p = parseMatcher(r.matcher);
  if (!p.ok) bad.push(`${r.rule_key}: ${p.detail}`);
  if (!['escalate', 'reply', 'ignore'].includes(r.verdict)) bad.push(`${r.rule_key}: verdict ${r.verdict}`);
}
if (bad.length > 0) {
  console.error(`refusing: the template has rules the runtime would refuse:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

// Dollar-quoting with a tag that cannot occur in the JSON, so no escaping is needed.
const q = (s: string): string => {
  if (s.includes('$r$')) throw new Error('template contains the quoting tag');
  return `$r$${s}$r$`;
};
const values = doc.rules.map((r) => `  (${q(r.rule_key)}, ${q(r.verdict)}, ${q(JSON.stringify(r.matcher))}::jsonb)`).join(',\n');
const keys = doc.rules.map((r) => q(r.rule_key)).join(', ');

console.log(`-- ${doc.rules.length} comment rules from templates/comment_rules.${template}.json for tenant ${slug}
begin;
update comment_rules set enabled = false
 where tenant_id = (select id from tenants where slug = ${q(slug)})
   and rule_key not in (${keys});
insert into comment_rules (tenant_id, rule_key, verdict, matcher, enabled, provenance)
select t.id, v.rule_key, v.verdict, v.matcher, true, 'seeded'
  from tenants t, (values
${values}
  ) as v(rule_key, verdict, matcher)
 where t.slug = ${q(slug)}
on conflict (tenant_id, rule_key) do update
   set verdict = excluded.verdict, matcher = excluded.matcher, enabled = true;
commit;`);
