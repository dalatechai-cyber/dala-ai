/**
 * The operator's report for one onboarding run: what was written, what is missing, which
 * names collide, which cases were generated, and what is still done by hand, in order.
 *
 * Rendered from what the run KNOWS — the plan, the validator's findings, the gates as read
 * back from the database — and never from what it hoped: a step not done is listed as not
 * done.
 */
import type { OnboardPlan } from './plan.ts';
import type { GeneratedCase } from './cases.ts';
import type { Finding, Readiness } from './validate.ts';
import type { GateStatus } from './onboardGates.ts';

export function onboardingReport(r: {
  slug: string; plan: OnboardPlan; findings: readonly Finding[]; cases: readonly GeneratedCase[];
  readiness: Readiness; gates: GateStatus; log: readonly string[]; formPath: string; at: string;
}): string {
  const { plan, gates } = r;
  const L: string[] = [];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  L.push(`# Onboarding report — ${plan.intake.business.displayName} (\`${r.slug}\`)`, '');
  L.push(`Run ${r.at} (Ulaanbaatar) from \`${r.formPath}\`, filled by ${plan.signer.name || '—'}${plan.signer.title ? `, ${plan.signer.title}` : ''} (${plan.signer.date || 'no date'}).`, '');

  L.push('## Where it stands', '');
  L.push(`- Readiness: **${r.readiness.stage}**${r.readiness.stage === 'ready' ? '' : ' — in the daily report until ready'}`);
  L.push(`- Gate 1, founder signs the wording: ${gates.wording.signed ? '**signed**' : `**open** — ${gates.wording.pending > 0 ? `${gates.wording.pending} lines` : 'changed since signed'}, sheet \`${gates.wording.id}\` (wording-sheet.md)`}`);
  L.push(`- Gate 2, client confirms the facts: ${gates.facts.confirmed ? '**confirmed**' : `**open** — ${gates.facts.unconfirmed > 0 ? `${gates.facts.unconfirmed} rows` : 'changed since confirmed'}, summary \`${gates.facts.id}\` (client-summary.md)`}`);
  L.push(`- Channels: ${plan.channels.map((c) => `${c.provider} ${c.externalId ?? '(not created: no id)'}`).join(', ') || 'none'} — **shadow**, no token. Nothing is sent to a customer.`);
  L.push(`- Reply cases: ${r.cases.length}, ${gates.wording.signed && gates.facts.confirmed ? 'switched on' : 'off until both gates pass'}.`, '');

  L.push('## Written', '');
  for (const l of r.log) L.push(`- ${l}`);
  L.push('');

  const clientAsks = plan.missing.filter((m) => m.audience === 'client');
  const operatorAsks = plan.missing.filter((m) => m.audience === 'operator');
  L.push('## Missing — recorded, never guessed', '');
  if (plan.missing.length === 0) L.push('Nothing.');
  if (clientAsks.length > 0) {
    L.push('For the client (also listed at the end of their summary):', '');
    for (const m of clientAsks) L.push(`- form ${m.question}: ${m.what}${m.holdsReady ? ' — **holds readiness**' : ''}`);
    L.push('');
  }
  if (operatorAsks.length > 0) {
    L.push('For the operator:', '');
    for (const m of operatorAsks) L.push(`- form ${m.question}: ${m.what}${m.holdsReady ? ' — **holds readiness**' : ''}`);
    L.push('');
  }

  const collisions = r.findings.filter((f) => f.code === 'service_name_collision' || f.code === 'service_name_unmatchable');
  L.push('## Service names a customer could confuse', '');
  if (collisions.length === 0) L.push('None found by `subsetCollisions`.');
  for (const f of collisions) L.push(`- ${f.detail}${f.holdsReady === true ? ' — **holds readiness**' : ''}`);
  L.push('');

  const rest = r.findings.filter((f) => !collisions.includes(f));
  if (rest.length > 0) {
    L.push('## Other findings', '');
    for (const f of rest) L.push(`- [${f.severity}] \`${f.code}\`: ${f.detail}`);
    L.push('');
  }

  L.push('## Reply cases generated from the client\'s facts', '');
  L.push('Exact cases never reach the model and are checked by every publish for free. The others are checked by the one paid pre-publish run (`--with-model`, D-151).', '');
  L.push('| id | customer writes | must include | must not include | exact |', '|---|---|---|---|---|');
  for (const c of r.cases) {
    L.push(`| ${c.id} | «${cell(c.message)}» | ${cell(c.mustInclude.join(', '))} | ${c.mustNotInclude.length} value(s) | ${c.expectedBody === null ? '' : 'yes'} |`);
  }
  L.push('');

  if (plan.notes.length > 0) {
    L.push('## Answers recorded, not applied', '');
    for (const n of plan.notes) L.push(`- ${n}`);
    L.push('');
  }

  L.push('## Still done by hand, in order', '');
  const steps = [
    'Send client-summary.md to the client. When they reply that it is right, re-run with `--apply --client-confirmed "<name>" --confirmed-on <YYYY-MM-DD> --summary <id printed at its foot>`. If they correct something, fix the form, re-run `--apply`, and send the new summary (its id changes).',
    'Read wording-sheet.md and sign: re-run with `--apply --sign-wording <sheet id> --signed-by <name>`.',
    'Seal the Page token (founder, by hand): `printf %s "$TOKEN" | node scripts/kek/seal.ts --tenant <uuid> --channel <uuid> --kind page_token`, run the SQL it prints, then set the channel\'s `app_slug`, `token_status` and name confirmation as for the live tenants. This command never handles a token.',
    'Grant the Reception entitlement (`tenant_roles`, state `trial` or `active`). A money decision, so the founder\'s: without it the reply path answers 403 and nothing is spent.',
    `Publish, after both gates: \`node scripts/publish/tenant.ts --slug ${r.slug}\` (dry run, runs the reply cases), then once \`--with-model\` (paid; report its cost, D-151), then \`--publish\`.`,
    'Go live: move the channel from shadow to live by the same procedure as the live tenants, only after the above.',
    ...plan.manual,
  ];
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  return L.join('\n');
}
