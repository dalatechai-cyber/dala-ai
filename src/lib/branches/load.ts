/**
 * The per-request half of branches (D-122): the rows the reply path needs that the compiled
 * prefix does not carry — how customers spell each branch, each branch's links for the URL
 * guard, and each branch's week for L4's «open now».
 *
 * ## Called ONLY for a prefix that lists two or more branches
 *
 * `reception/load.ts` calls this only when `branchNamesFromPrefix` is non-empty. That is what
 * makes the reply path safe to deploy before `0047` is pushed: a tenant whose live snapshot
 * lists no branches — every tenant today — never issues these reads, so a missing table
 * cannot 503 its replies. A snapshot can only list branches if it was published after the
 * push, because publishing reads these tables.
 *
 * ## Every read that fails refuses
 *
 * `reception/load.ts`'s discipline. A branch whose stems could not be read would leave a
 * customer who named it unrecognised, and the bot would ask a question they already answered.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BusinessHours } from '../reception/volatile.ts';

export type BranchContext = {
  name: string;
  stems: string[];
  /** The branch's week: its own `branch_hours` row for a weekday, else the tenant's. */
  hours: BusinessHours[];
  /** Its own contact points (`branch_contact_points`), for the URL allow-list. */
  contacts: { kind: string; value: string }[];
};

export type BranchLoad = { ok: true; branches: BranchContext[] } | { ok: false; detail: string };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export async function loadBranchContext(
  db: SupabaseClient,
  input: { tenantId: string; names: readonly string[]; tenantHours: readonly BusinessHours[] },
): Promise<BranchLoad> {
  const t = input.tenantId;
  const [branches, contacts, hours] = await Promise.all([
    db.from('tenant_branches').select('id, name, stems').eq('tenant_id', t).eq('active', true),
    db.from('branch_contact_points').select('branch_id, kind, value').eq('tenant_id', t),
    db.from('branch_hours').select('branch_id, weekday, opens, closes, closed').eq('tenant_id', t),
  ]);
  for (const [name, res] of [['tenant_branches', branches], ['branch_contact_points', contacts], ['branch_hours', hours]] as const) {
    if (res.error) return { ok: false, detail: `${name} unreadable: ${res.error.message}` };
  }
  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const live = rows(branches.data);

  return {
    ok: true,
    // The PREFIX's branches, in its order. A live row the prefix does not list was added
    // since the publish and is not something the model was told about.
    branches: input.names.map((name) => {
      const row = live.find((r) => String(r['name'] ?? '') === name);
      const id = row === undefined ? null : String(row['id'] ?? '');
      const own = rows(hours.data).filter((h) => id !== null && String(h['branch_id'] ?? '') === id);
      const week: BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].flatMap((wd) => {
        const b = own.find((h) => Number(h['weekday']) === wd);
        if (b !== undefined) {
          return [{
            weekday: wd,
            opens: b['opens'] === null || b['opens'] === undefined ? null : String(b['opens']),
            closes: b['closes'] === null || b['closes'] === undefined ? null : String(b['closes']),
            closed: b['closed'] === true,
          }];
        }
        const tenant = input.tenantHours.find((h) => h.weekday === wd);
        return tenant === undefined ? [] : [tenant];
      });
      return {
        name,
        stems: row === undefined ? [] : strings(row['stems']),
        hours: week,
        contacts: rows(contacts.data)
          .filter((c) => id !== null && String(c['branch_id'] ?? '') === id)
          .map((c) => ({ kind: String(c['kind'] ?? ''), value: String(c['value'] ?? '') })),
      };
    }),
  };
}
