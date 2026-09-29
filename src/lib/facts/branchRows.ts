/**
 * One branch tenant's side of the branch checks (`branches.ts`), read from its rows. A read
 * that fails is `ok: false`, never an empty side: a check that could not read a branch has
 * not shown that branch is clean (rule 9).
 *
 * The texts are every copy `loadFactCopies` reads (FAQ, fixed replies, canned lines, KB),
 * plus the other rows a customer or the model reads that can name a phone, a place or a
 * person: deposit rules, the questions that tell two services apart, and closure notices.
 * Staff are the active ones, by name and by the short name customers call them by.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { branchLabel, type BranchPrice, type BranchSide } from './branches.ts';
import { loadFactCopies } from './copies.ts';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export async function loadBranchSide(
  db: SupabaseClient,
  input: { tenantId: string; slug: string },
): Promise<{ ok: true; side: BranchSide } | { ok: false; detail: string }> {
  const t = input.tenantId;
  const [tenant, copies, contacts, staff, booking, services, variants, deposits, disambig, closures, inner] = await Promise.all([
    db.from('tenants').select('display_name').eq('id', t).maybeSingle(),
    loadFactCopies(db, t),
    db.from('contact_points').select('kind, value').eq('tenant_id', t),
    db.from('staff_members').select('name, short_name').eq('tenant_id', t).eq('active', true),
    db.from('tenant_booking').select('booking_url').eq('tenant_id', t).maybeSingle(),
    db.from('services').select('id, name').eq('tenant_id', t).eq('active', true),
    db.from('service_variants').select('service_id, variant_key, price_kind, price_min, price_max').eq('tenant_id', t),
    db.from('deposit_rules').select('applies_to, rule_text').eq('tenant_id', t),
    db.from('disambiguation_pairs').select('trigger_term, question').eq('tenant_id', t),
    db.from('tenant_closures').select('title, message').eq('tenant_id', t),
    db.from('tenant_branches').select('id').eq('tenant_id', t),
  ]);
  if (!copies.ok) return { ok: false, detail: copies.detail };
  for (const [name, r] of [['tenants', tenant], ['contact_points', contacts], ['staff_members', staff], ['tenant_booking', booking], ['services', services],
    ['service_variants', variants], ['deposit_rules', deposits], ['disambiguation_pairs', disambig], ['tenant_closures', closures], ['tenant_branches', inner]] as const) {
    if (r.error) return { ok: false, detail: `${name} unreadable: ${r.error.message}` };
  }
  // A branch tenant that also carries D-125 branches of its own has contacts and prices this does
  // not read (branch_contact_points, branch_variant_prices): refused, never half-checked.
  const innerCount = (inner.data ?? []).length;
  if (innerCount > 0) {
    return { ok: false, detail: `${input.slug} has ${innerCount} tenant_branches row(s) (D-125); a branch tenant is checked only without them` };
  }

  const nameOf = new Map(((services.data ?? []) as Row[]).map((s) => [str(s['id']), str(s['name'])]));
  const prices: BranchPrice[] = [];
  for (const v of (variants.data ?? []) as Row[]) {
    const service = nameOf.get(str(v['service_id']));
    if (service === undefined) continue; // an inactive service is not offered, so it has no price to agree on
    prices.push({ service, variant: str(v['variant_key']), kind: str(v['price_kind']), min: num(v['price_min']), max: num(v['price_max']) });
  }
  const url = (booking.data as Row | null)?.['booking_url'];

  return {
    ok: true,
    side: {
      slug: input.slug,
      contacts: ((contacts.data ?? []) as Row[]).map((c) => ({ kind: str(c['kind']), value: str(c['value']) })),
      staff: ((staff.data ?? []) as Row[]).map((s) => ({ name: str(s['name']), shortName: str(s['short_name']) || null })),
      branchName: branchLabel(str((tenant.data as Row | null)?.['display_name'])),
      texts: [
        ...copies.copies.map((c) => ({ source: c.source, text: c.text })),
        ...((deposits.data ?? []) as Row[]).map((d) => ({ source: `deposit rule ${str(d['applies_to'])}`, text: str(d['rule_text']) })),
        ...((disambig.data ?? []) as Row[]).map((d) => ({ source: `disambiguation «${str(d['trigger_term'])}»`, text: str(d['question']) })),
        ...((closures.data ?? []) as Row[]).map((c) => ({ source: `closure «${str(c['title'])}»`, text: `${str(c['title'])}\n${str(c['message'])}` })),
      ],
      prices,
      bookingUrl: typeof url === 'string' && url.trim() !== '' ? url : null,
    },
  };
}
