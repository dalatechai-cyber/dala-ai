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
import { branchLabel, foreignDetails, renderBranchFindings, sharedDrift, type BranchFinding, type BranchSide, type NotOffered } from '../../src/lib/facts/branches.ts';
import { loadBranchSide } from '../../src/lib/facts/branchRows.ts';
import type { OnboardPlan } from '../../src/lib/provision/plan.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type BranchGroup = {
  name: string; tenants: string[]; allowNames: string[]; allowPhones?: string[]; allowAddresses?: string[];
  /** Per slug: price variants that branch does not offer (no row), e.g. a level it has no staff for. */
  notOffered?: NotOffered;
  /** Where the other branch's name and allowed address may appear (text sources); null = anywhere. */
  otherBranchIn?: string[] | null;
  /** Per slug: other names that branch's staff are called by (the KB «Үсчдийн нэр»), searched like short names. */
  staffAliases?: Record<string, string[]>;
};

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
    const phones = g['allow_phones'] ?? [];
    // One 8-digit number per entry (976 allowed in front): an entry that is not a phone, or is
    // two, would exempt something nobody meant to share.
    if (!Array.isArray(phones) || !phones.every((s) => typeof s === 'string' && /^(?:\+?976)?[0-9]{8}$/u.test(s.replace(/[\p{Zs}\p{Pd}]/gu, '')))) {
      throw new Error(`config/branch-groups.json: group ${name}: "allow_phones" must be a list of single phone numbers`);
    }
    const addresses = g['allow_addresses'] ?? [];
    if (!Array.isArray(addresses) || !addresses.every((s) => typeof s === 'string' && s.trim() !== '')) {
      throw new Error(`config/branch-groups.json: group ${name}: "allow_addresses" must be a list of addresses`);
    }
    // Per branch, the price variants it does not offer: that branch carries no row for them and
    // the drift check does not ask it to. An entry is a variant name (every service) or
    // {"service", "variant"} (that service only). Every slug must be one of this group's tenants,
    // and an empty variant would be every unvariated price, so both refuse.
    const perSlug = (key: string, item: (v: unknown) => boolean, what: string): Record<string, unknown[]> => {
      const raw = g[key] ?? {};
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`config/branch-groups.json: group ${name}: "${key}" must map a slug to a list of ${what}`);
      }
      for (const [slug, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!(tenants as string[]).includes(slug)) {
          throw new Error(`config/branch-groups.json: group ${name}: "${key}" names ${slug}, which is not one of its tenants`);
        }
        if (!Array.isArray(list) || list.length === 0 || !list.every(item)) {
          throw new Error(`config/branch-groups.json: group ${name}: "${key}" for ${slug} must be a list of ${what}`);
        }
      }
      return raw as Record<string, unknown[]>;
    };
    const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    const omitRaw = perSlug('not_offered', (v) => text(v) || (v !== null && typeof v === 'object' && !Array.isArray(v)
      && text((v as Record<string, unknown>)['service']) && text((v as Record<string, unknown>)['variant'])
      && Object.keys(v as object).every((k) => k === 'service' || k === 'variant')), 'variants (a name, or {"service", "variant"})');
    const notOffered: Record<string, { service: string | null; variant: string }[]> = {};
    for (const [slug, list] of Object.entries(omitRaw)) {
      notOffered[slug] = list.map((v) => (typeof v === 'string'
        ? { service: null, variant: v.normalize('NFC').trim() }
        : { service: String((v as Record<string, unknown>)['service']).normalize('NFC').trim(), variant: String((v as Record<string, unknown>)['variant']).normalize('NFC').trim() }));
    }
    const aliasRaw = perSlug('staff_aliases', text, 'names');
    const staffAliases: Record<string, string[]> = {};
    for (const [slug, list] of Object.entries(aliasRaw)) staffAliases[slug] = (list as string[]).map((n) => n.normalize('NFC').trim());
    const inRaw = g['other_branch_in'];
    if (inRaw !== undefined && (!Array.isArray(inRaw) || inRaw.length === 0 || !inRaw.every(text))) {
      throw new Error(`config/branch-groups.json: group ${name}: "other_branch_in" must be a list of row sources`);
    }
    for (const s of tenants as string[]) {
      const other = seen.get(s);
      if (other !== undefined) throw new Error(`config/branch-groups.json: ${s} is in both ${other} and ${name}`);
      seen.set(s, name);
    }
    groups.push({
      name, tenants: [...new Set(tenants as string[])], allowNames: (allow as string[]).map((n) => n.normalize('NFC')),
      allowPhones: phones as string[],
      allowAddresses: (addresses as string[]).map((a) => a.normalize('NFC')),
      notOffered,
      otherBranchIn: inRaw === undefined ? null : (inRaw as string[]).map((x) => x.normalize('NFC')),
      staffAliases,
    });
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
    staff: plan.staff.filter((s) => s.active).map((s) => ({ name: s.name, shortName: s.shortName })),
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
  /** The same, against a branch that has never been published: shown, never refusing. A branch
   *  still being onboarded cannot block a live branch's publish; its own first publish is checked. */
  pendingDrift: string[];
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
    return { group: null, others: [], leaks: [], drift: [], pendingDrift: [], unchecked: [`${slug} branches: ${why}`], text: `branches: ${slug}: UNCHECKED (${why})` };
  }
  if (group === null) return { group: null, others: [], leaks: [], drift: [], pendingDrift: [], unchecked: [], text: `branches: ${slug} is in no branch group; nothing to compare.` };

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
  const pending: BranchFinding[] = [];
  const others = group.tenants.filter((s) => s !== slug);
  for (const other of others) {
    const { data, error } = await db.from('tenants').select('id, live_revision_id').eq('slug', other).maybeSingle();
    if (error) { unchecked.push(`${slug} branches: tenant ${other} unreadable: ${error.message}`); continue; }
    if (data === null) { notes.push(`branches: ${other} is not provisioned yet; nothing of it to compare.`); continue; }
    const sib = await loadBranchSide(db, { tenantId: String((data as Record<string, unknown>)['id']), slug: other });
    if (!sib.ok) { unchecked.push(`${slug} branches: ${other}: ${sib.detail}`); continue; }
    if (own === null) continue;
    // Each branch's staff aliases (the Cyrillic names in its «Үсчдийн нэр») count as its staff's
    // names, so the other branch's rows are searched for them as for a short name.
    const aliased = (side: BranchSide): BranchSide => ({
      ...side, staff: [...side.staff, ...(group.staffAliases?.[side.slug] ?? []).map((n) => ({ name: n, shortName: null }))],
    });
    // The alias list is a copy of what that branch's own rows say. One its rows no longer carry
    // (a spelling corrected in the document, not in the config) is named, never refused: a live
    // branch's publish must not stop on a list the founder is still settling.
    for (const side of [own, sib.side]) {
      const said = side.texts.map((t) => t.text.normalize('NFC').toLowerCase()).join('\n');
      for (const a of group.staffAliases?.[side.slug] ?? []) {
        // Whole word, so «Болор» is not found inside «Болороо» (rule 6: no unanchored matching).
        const word = new RegExp(`(?<![\\p{L}\\p{N}])${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
        if (!word.test(said)) {
          notes.push(`branches: staff_aliases: «${a}» is in none of ${side.slug}'s rows; bring config/branch-groups.json in line with its «Үсчдийн нэр».`);
        }
      }
    }
    findings.push(...foreignDetails(aliased(own), aliased(sib.side), group.allowNames, group.allowPhones ?? [], group.allowAddresses ?? [], group.otherBranchIn ?? null));
    const drift = sharedDrift(own, sib.side, group.notOffered ?? {});
    if ((data as Record<string, unknown>)['live_revision_id'] == null) {
      pending.push(...drift);
      if (drift.length > 0) notes.push(`branches: ${other} has never been published, so its ${drift.length} difference(s) do not refuse this run; its own first publish will.`);
    } else {
      findings.push(...drift);
    }
  }

  const line = (f: BranchFinding) => `${slug} branches: ${f.source}: ${f.detail}`;
  const text = [
    ...(own === null ? [] : [renderBranchFindings(slug, group.name, findings)]),
    ...pending.map((f) => `  drift (not refusing)  ${f.source}: ${f.detail}`),
    ...notes,
    ...unchecked.map((u) => `branches: UNCHECKED ${u}`),
  ].join('\n');
  return {
    group: group.name,
    others,
    leaks: findings.filter((f) => f.kind === 'leak').map(line),
    drift: findings.filter((f) => f.kind === 'drift').map(line),
    pendingDrift: pending.map(line),
    unchecked,
    text,
  };
}
