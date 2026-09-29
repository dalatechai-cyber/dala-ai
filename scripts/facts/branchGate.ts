/**
 * The branch gate (founder, 2026-09-29; `docs/standards/dali.md` §7): a branch tenant's rows
 * never carry another branch's phone, map link, address or staff name, and every branch of
 * one brand carries the same prices and booking link. The checker is
 * `src/lib/facts/branches.ts`; this reads which tenants are branches of one brand from
 * `config/branch-groups.json` and gathers each branch's side from its rows.
 *
 * Fails closed: a group config that does not parse, or a branch that is provisioned and
 * cannot be read, is UNCHECKED, and unchecked stops a publish exactly as a finding does. A
 * branch with no tenant yet is named and skipped: there is nothing of it to leak or differ.
 * No model, no spend, no writes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { branchLabel, foreignDetails, renderBranchFindings, sharedDrift, type BranchFinding, type BranchSide } from '../../src/lib/facts/branches.ts';
import { loadBranchSide } from '../../src/lib/facts/branchRows.ts';
import type { OnboardPlan } from '../../src/lib/provision/plan.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type BranchGroup = { name: string; tenants: string[]; allowNames: string[] };

/** Every group in the config. Throws on a malformed file or a slug in two groups: never a guess. */
export function branchGroups(text = readFileSync(join(ROOT, 'config/branch-groups.json'), 'utf8')): BranchGroup[] {
  const cfg = JSON.parse(text) as Record<string, unknown>;
  const groups: BranchGroup[] = [];
  const seen = new Map<string, string>();
  for (const [name, v] of Object.entries(cfg)) {
    if (name.startsWith('_')) continue;
    const g = (v ?? {}) as Record<string, unknown>;
    const tenants = g['tenants'];
    const allow = g['allow_names'] ?? [];
    if (!Array.isArray(tenants) || tenants.length < 2 || !tenants.every((s) => typeof s === 'string' && s !== '')) {
      throw new Error(`config/branch-groups.json: group ${name} needs "tenants", two slugs or more`);
    }
    if (!Array.isArray(allow) || !allow.every((s) => typeof s === 'string')) {
      throw new Error(`config/branch-groups.json: group ${name}: "allow_names" must be a list of names`);
    }
    for (const s of tenants as string[]) {
      const other = seen.get(s);
      if (other !== undefined) throw new Error(`config/branch-groups.json: ${s} is in both ${other} and ${name}`);
      seen.set(s, name);
    }
    groups.push({ name, tenants: [...new Set(tenants as string[])], allowNames: (allow as string[]).map((n) => n.normalize('NFC')) });
  }
  return groups;
}

export function branchGroupOf(slug: string, groups = branchGroups()): BranchGroup | null {
  return groups.find((g) => g.tenants.includes(slug)) ?? null;
}

/**
 * An onboarding plan as a branch side, so the check runs on what WOULD be written, before
 * anything is: the same rows the tenant would carry.
 */
export function branchSideFromPlan(slug: string, plan: OnboardPlan): BranchSide {
  const i = plan.intake;
  const num = (v: string | null) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    slug,
    contacts: i.contacts,
    staff: plan.staff.filter((s) => s.active).flatMap((s) => [s.name, s.shortName ?? '']).filter((n) => n !== ''),
    branchName: branchLabel(i.business.displayName),
    texts: [
      ...Object.entries(i.sentences).map(([kind, body]) => ({ source: `canned ${kind}`, text: body })),
      ...i.faqs.map((f) => ({ source: `faq «${f.question}»`, text: `${f.question}\n${f.answer}` })),
      ...plan.documents.map((d) => ({ source: `KB «${d.title}»`, text: `${d.title}\n${d.body}` })),
      ...plan.deposits.map((d) => ({ source: `deposit rule ${d.appliesTo}`, text: d.ruleText })),
      ...plan.modelVisible.map((m) => ({ source: m.where, text: m.text })),
    ],
    prices: i.services.flatMap((s) => s.variants.map((v) => ({
      service: s.name, variant: v.variantKey, kind: v.priceKind, min: num(v.priceMin), max: num(v.priceMax),
    }))),
    bookingUrl: i.booking.url,
  };
}

export type BranchGateResult = {
  /** Null when the tenant is in no branch group: the gate has nothing to check. */
  group: string | null;
  /** The group's other branches, provisioned or not. */
  others: string[];
  /** Another branch's details in this tenant's rows, or held by both. Refuses onboarding and publish. */
  leaks: string[];
  /** A price or the booking link differs from another branch. Refuses publish; holds onboarding. */
  drift: string[];
  /** Could not be checked. Refuses publish; holds onboarding. */
  unchecked: string[];
  text: string;
};

/**
 * `own`: the tenant's side when it is not yet in the database (an onboarding dry run);
 * otherwise it is read from the rows.
 */
export async function branchGate(
  db: SupabaseClient,
  input: { slug: string; tenantId: string | null; own?: BranchSide; groups?: BranchGroup[] },
): Promise<BranchGateResult> {
  const { slug } = input;
  let group: BranchGroup | null;
  try {
    group = branchGroupOf(slug, input.groups ?? branchGroups());
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { group: null, others: [], leaks: [], drift: [], unchecked: [`${slug} branches: ${why}`], text: `branches: ${slug}: UNCHECKED (${why})` };
  }
  if (group === null) return { group: null, others: [], leaks: [], drift: [], unchecked: [], text: `branches: ${slug} is in no branch group; nothing to compare.` };

  const unchecked: string[] = [];
  const notes: string[] = [];
  let own = input.own ?? null;
  if (own === null) {
    if (input.tenantId === null) {
      unchecked.push(`${slug} branches: no rows and no plan to check`);
    } else {
      const got = await loadBranchSide(db, { tenantId: input.tenantId, slug });
      if (got.ok) own = got.side;
      else unchecked.push(`${slug} branches: ${got.detail}`);
    }
  }

  const findings: BranchFinding[] = [];
  const others = group.tenants.filter((s) => s !== slug);
  for (const other of others) {
    const { data, error } = await db.from('tenants').select('id').eq('slug', other).maybeSingle();
    if (error) { unchecked.push(`${slug} branches: tenant ${other} unreadable: ${error.message}`); continue; }
    if (data === null) { notes.push(`branches: ${other} is not provisioned yet; nothing of it to compare.`); continue; }
    const sib = await loadBranchSide(db, { tenantId: String((data as Record<string, unknown>)['id']), slug: other });
    if (!sib.ok) { unchecked.push(`${slug} branches: ${other}: ${sib.detail}`); continue; }
    if (own !== null) findings.push(...foreignDetails(own, sib.side, group.allowNames), ...sharedDrift(own, sib.side));
  }

  const line = (f: BranchFinding) => `${slug} branches: ${f.source}: ${f.detail}`;
  const text = [
    ...(own === null ? [] : [renderBranchFindings(slug, group.name, findings)]),
    ...notes,
    ...unchecked.map((u) => `branches: UNCHECKED ${u}`),
  ].join('\n');
  return {
    group: group.name,
    others,
    leaks: findings.filter((f) => f.kind === 'leak').map(line),
    drift: findings.filter((f) => f.kind === 'drift').map(line),
    unchecked,
    text,
  };
}
