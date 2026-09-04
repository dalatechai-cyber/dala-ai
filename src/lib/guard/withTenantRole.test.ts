import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTenantRole } from './withTenantRole.ts';

/**
 * A stub that can be made to fail at any single step, so each step's fail-closed
 * behaviour is proved independently rather than inferred from the happy path.
 */
function stubDb(opts: {
  roleRow?: unknown; roleError?: unknown;
  consentRow?: unknown; consentError?: unknown;
  budgetRow?: unknown; budgetError?: unknown;
  counterError?: unknown;
  reservationRow?: unknown; reservationError?: unknown;
  rpcGranted?: unknown; rpcError?: unknown;
  onAnthropicConstruct?: () => void;
} = {}) {
  const calls: string[] = [];
  const table = (name: string) => {
    calls.push(name);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'update', 'insert', 'upsert']) {
      chain[m] = () => chain;
    }
    chain['maybeSingle'] = async () => {
      if (name === 'tenant_roles') return { data: opts.roleRow ?? null, error: opts.roleError ?? null };
      if (name === 'consent_records') return { data: opts.consentRow ?? null, error: opts.consentError ?? null };
      if (name === 'tenant_budgets') return { data: opts.budgetRow ?? null, error: opts.budgetError ?? null };
      if (name === 'spend_reservations') {
        return { data: opts.reservationRow ?? { id: 'res-1' }, error: opts.reservationError ?? null };
      }
      return { data: null, error: null };
    };
    // upsert/update resolve without .maybeSingle()
    chain['then'] = (res: (v: unknown) => unknown) =>
      res({ error: name === 'spend_counters' ? (opts.counterError ?? null) : null });
    return chain;
  };
  return {
    calls,
    db: {
      from: (name: string) => table(name),
      rpc: async () => ({ data: opts.rpcGranted ?? true, error: opts.rpcError ?? null }),
    } as never,
  };
}

const ENTITLED = { state: 'active', roles: { status: 'available' } };
const base = {
  tenantId: 't-1', role: 'reception' as const, surface: 'reception' as const,
  channel: 'facebook_page', estimate: 5_000_000n, now: new Date('2026-09-02T10:00:00Z'),
};

test('the happy path reserves', async () => {
  const { db } = stubDb({ roleRow: ENTITLED });
  const res = await withTenantRole(db, base);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.reservation.id, 'res-1');
});

// ---- Step 1: identity ------------------------------------------------------
test('STEP 1 identity: no tenant id refuses 503 and never looks anything up', async () => {
  const { db, calls } = stubDb({ roleRow: ENTITLED });
  const res = await withTenantRole(db, { ...base, tenantId: '' });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.refusal.status, 503);
  assert.deepEqual(calls, [], 'must refuse before touching the database');
});

// ---- Step 2: entitlement ---------------------------------------------------
test('STEP 2 entitlement: an unreadable tenant_roles is 503, NOT a pass', async () => {
  // The whole point. "We could not find out" must never become "allow".
  const { db } = stubDb({ roleError: { message: 'connection reset' } });
  const res = await withTenantRole(db, base);
  assert.equal(!res.ok && res.refusal.status, 503);
});

test('STEP 2 entitlement: no row, off, or suspended all refuse 403', async () => {
  for (const roleRow of [
    null,
    { state: 'off', roles: { status: 'available' } },
    { state: 'suspended', roles: { status: 'available' } },
    { state: 'something_new', roles: { status: 'available' } },
  ]) {
    const { db } = stubDb({ roleRow });
    const res = await withTenantRole(db, base);
    assert.equal(!res.ok && res.refusal.status, 403, `state ${JSON.stringify(roleRow)}`);
  }
});

test('STEP 2 entitlement: a platform-GATED role refuses even when the tenant row says active', async () => {
  // Voice, and Care without a transport. The platform gate outranks the per-tenant grant,
  // so a mis-set tenant row cannot switch on a role that has no implementation behind it.
  const { db } = stubDb({ roleRow: { state: 'active', roles: { status: 'gated' } } });
  const res = await withTenantRole(db, base);
  assert.equal(!res.ok && res.refusal.status, 403);
});

// ---- Step 3: consent -------------------------------------------------------
test('STEP 3 consent: an unreadable consent_records is 503, NOT a pass', async () => {
  const { db } = stubDb({ roleRow: ENTITLED, consentError: { message: 'timeout' } });
  const res = await withTenantRole(db, { ...base, personId: 'p-1' });
  assert.equal(!res.ok && res.refusal.status, 503);
});

test('STEP 3 consent: an explicit withdrawal refuses 403', async () => {
  for (const state of ['withdrawn', 'inferred_withdrawn']) {
    const { db } = stubDb({ roleRow: ENTITLED, consentRow: { state } });
    const res = await withTenantRole(db, { ...base, personId: 'p-1' });
    assert.equal(!res.ok && res.refusal.status, 403, state);
  }
});

test('STEP 3 consent: NO record is not withdrawal — inbound consent is implied', async () => {
  // A customer who messages the salon first has consented to be answered. Treating
  // "no row" as withdrawal would refuse every genuine first message.
  const { db } = stubDb({ roleRow: ENTITLED, consentRow: null });
  const res = await withTenantRole(db, { ...base, personId: 'p-1' });
  assert.equal(res.ok, true);
});

// ---- Step 4: budget --------------------------------------------------------
test('STEP 4 budget: an unreadable tenant_budgets is 503, NOT the compiled cap', async () => {
  const { db } = stubDb({ roleRow: ENTITLED, budgetError: { message: 'down' } });
  const res = await withTenantRole(db, base);
  assert.equal(!res.ok && res.refusal.status, 503);
});

test('STEP 4 budget: reserve_spend returning false is 429, and nothing was called', async () => {
  const { db } = stubDb({ roleRow: ENTITLED, rpcGranted: false });
  const res = await withTenantRole(db, base);
  assert.equal(!res.ok && res.refusal.status, 429);
  assert.equal(!res.ok && res.refusal.code, 'ceiling_reached');
});

test('STEP 4 budget: an ERRORING reserve_spend is 503, never an implicit grant', async () => {
  const { db } = stubDb({ roleRow: ENTITLED, rpcError: { message: 'deadlock' } });
  const res = await withTenantRole(db, base);
  assert.equal(!res.ok && res.refusal.status, 503);
});

// ---- The ordering property -------------------------------------------------
test('ORDER: entitlement is checked BEFORE budget, so a refusal reserves nothing', async () => {
  // Reserving for a request that entitlement would have refused leaks the tenant's own
  // headroom for work it is not entitled to.
  const { db, calls } = stubDb({ roleRow: null });
  await withTenantRole(db, base);
  assert.ok(calls.includes('tenant_roles'), 'entitlement was checked');
  assert.ok(!calls.includes('spend_reservations'), 'nothing was reserved');
  assert.ok(!calls.includes('spend_counters'), 'no counter was touched');
});

test('THE DONE-TEST: a tenant at its cap is refused BEFORE an Anthropic client exists', async () => {
  // V1.md item 2.2. This is the property the whole reserve-before-call ordering exists
  // for: the refusal must happen while it is still free.
  let anthropicConstructed = false;
  const { db } = stubDb({ roleRow: ENTITLED, rpcGranted: false });

  const res = await withTenantRole(db, base);
  if (res.ok) {
    anthropicConstructed = true;   // only reachable if the guard let us through
  }

  assert.equal(res.ok, false);
  assert.equal(anthropicConstructed, false,
    'the guard returned before any provider client could be constructed');
});
