import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { branchGate, branchGroupOf, branchGroups, type BranchGroup } from './branchGate.ts';

test('the shipped config parses, and every group has two branches or more', () => {
  const groups = branchGroups();
  assert.ok(groups.length > 0);
  for (const g of groups) assert.ok(g.tenants.length >= 2, g.name);
});

test('a malformed config or a slug in two groups is refused, never guessed', () => {
  assert.throws(() => branchGroups('{"a": {"tenants": ["x"]}}'), /two slugs or more/u);
  assert.throws(() => branchGroups('{"a": {"tenants": ["x", "y"]}, "b": {"tenants": ["y", "z"]}}'), /y is in both a and b/u);
  assert.throws(() => branchGroups('{"a": {"tenants": ["x", "y"], "allow_names": "Сарнай"}}'), /allow_names/u);
  assert.equal(branchGroupOf('q', branchGroups('{"_doc": "", "a": {"tenants": ["x", "y"]}}')), null);
});

// A fake PostgREST over fictional rows: `from(table).select(...).eq(col, v)...` resolves to the
// rows whose columns equal every `eq`; `maybeSingle()` to the first or null. `fail` names tables
// whose read errors.
type Rows = Record<string, Record<string, unknown>[]>;
function fakeDb(rows: Rows, fail: string[] = []): SupabaseClient {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const result = () => (fail.includes(table)
        ? { data: null, error: { message: `${table} is down` } }
        : { data: (rows[table] ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v)), error: null });
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
        maybeSingle: async () => { const r = result(); return r.error ? r : { data: r.data?.[0] ?? null, error: null }; },
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const groups: BranchGroup[] = [{ name: 'demo', tenants: ['demo-east', 'demo-west'], allowNames: [] }];
const east = {
  tenants: [{ id: 'e', slug: 'demo-east' }],
  contact_points: [{ tenant_id: 'e', kind: 'phone', value: '99112233' }],
  staff_members: [{ tenant_id: 'e', name: 'Сарнай', active: true }],
  canned_responses: [{ tenant_id: 'e', kind: 'handoff', body: 'Та 99112233 дугаараар холбогдоно уу.' }],
  services: [{ tenant_id: 'e', id: 's1', name: 'Үс засалт', active: true }],
  service_variants: [{ tenant_id: 'e', service_id: 's1', variant_key: '', price_kind: 'exact', price_min: 25000, price_max: null }],
  tenant_booking: [{ tenant_id: 'e', booking_url: 'https://demo-brand.mn/' }],
};
const westRows = (handoff: string, price: number) => ({
  contact_points: [...east.contact_points, { tenant_id: 'w', kind: 'phone', value: '7711-2233' }],
  staff_members: east.staff_members,
  canned_responses: [...east.canned_responses, { tenant_id: 'w', kind: 'handoff', body: handoff }],
  services: [...east.services, { tenant_id: 'w', id: 's2', name: 'Үс засалт', active: true }],
  service_variants: [...east.service_variants,
    { tenant_id: 'w', service_id: 's2', variant_key: '', price_kind: 'exact', price_min: price, price_max: null }],
  tenant_booking: [...east.tenant_booking, { tenant_id: 'w', booking_url: 'https://demo-brand.mn' }],
});

test('a branch whose sibling is not provisioned passes, and says so', async () => {
  const r = await branchGate(fakeDb(east), { slug: 'demo-east', tenantId: 'e', groups });
  assert.deepEqual([r.group, r.others, r.leaks, r.drift, r.unchecked], ['demo', ['demo-west'], [], [], []]);
  assert.match(r.text, /demo-west is not provisioned yet/u);
});

test('a branch carrying its sibling\'s phone is a leak naming the row; a different price is drift', async () => {
  const db = fakeDb({ ...east, tenants: [...east.tenants, { id: 'w', slug: 'demo-west' }], ...westRows('Та 99112233 дугаараар холбогдоно уу.', 30000) });
  const r = await branchGate(db, { slug: 'demo-west', tenantId: 'w', groups });
  assert.deepEqual(r.leaks, ["demo-west branches: canned handoff: carries demo-east's phone 99112233"]);
  assert.deepEqual(r.drift, ['demo-west branches: price «Үс засалт»: demo-west 30,000₮, demo-east 25,000₮']);
  assert.deepEqual(r.unchecked, []);
});

test('a clean branch passes against a provisioned sibling', async () => {
  const db = fakeDb({ ...east, tenants: [...east.tenants, { id: 'w', slug: 'demo-west' }], ...westRows('Та 7711-2233 дугаараар холбогдоно уу.', 25000) });
  const r = await branchGate(db, { slug: 'demo-west', tenantId: 'w', groups });
  assert.deepEqual([r.leaks, r.drift, r.unchecked], [[], [], []]);
});

test('a sibling that cannot be read is UNCHECKED, never clean', async () => {
  const db = fakeDb({ ...east, tenants: [...east.tenants, { id: 'w', slug: 'demo-west' }] }, ['tenant_closures']);
  const r = await branchGate(db, { slug: 'demo-west', tenantId: 'w', groups });
  // Both reads fail here: this branch's own rows and the sibling's. Each is named.
  assert.deepEqual(r.unchecked.map((u) => u.startsWith('demo-west branches: demo-east: ')), [false, true]);
  assert.ok(r.unchecked.every((u) => u.includes('tenant_closures unreadable')));
  assert.deepEqual([r.leaks, r.drift], [[], []]);
});

test('a tenant in no group has nothing to compare', async () => {
  const r = await branchGate(fakeDb(east), { slug: 'solo', tenantId: 'x', groups });
  assert.deepEqual([r.group, r.unchecked], [null, []]);
});
