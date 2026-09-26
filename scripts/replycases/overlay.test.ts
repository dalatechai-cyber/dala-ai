import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCases } from './overlay.ts';
import { fixtureDb } from '../bakeoff/fixtureDb.ts';
import { gateTenant } from '../../src/lib/replycases/run.ts';
import { taraDump } from './fixtures.ts';

const WHO = 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.';

function row(tenantId: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, tenant_id: tenantId, active: true, customer_message: 'chi henbe', history: [],
    expected_body: WHO, must_include: [], must_not_include: [], note: null, channel: 'facebook_page', ...over,
  };
}

test('a case served from memory is answered by the real gate over the dumped rows, with no model', async () => {
  const dump = taraDump();
  const tenantId = dump['tenants']?.[0]?.['id'];
  const g = await gateTenant(withCases(fixtureDb(dump), [row(tenantId)]), { slug: 'matrix-eco-salon', now: new Date('2026-09-25T06:00:00Z'), callModel: null });
  assert.ok(g.ok, JSON.stringify(g));
  assert.equal(g.results.length, 1, 'only the case given, never the dump\'s own reply_cases');
  assert.equal(g.results[0]?.pass, true, JSON.stringify(g.results[0]));
  assert.equal(g.results[0]?.answeredBy, 'deterministic');
  assert.equal(g.results[0]?.reply, WHO);
});

test('an inactive case is not loaded — the overlay answers the gate\'s own query, filters included', async () => {
  const dump = taraDump();
  const tenantId = dump['tenants']?.[0]?.['id'];
  const g = await gateTenant(withCases(fixtureDb(dump), [row(tenantId, { active: false })]), { slug: 'matrix-eco-salon', now: new Date(), callModel: null });
  assert.ok(g.ok);
  assert.equal(g.results.length, 0);
});

test('DONE-TEST: EVERY WRITE AND EVERY RPC THROWS — A TEST-SET RUN CANNOT WRITE TO A TENANT', () => {
  const db = withCases(fixtureDb(taraDump()), []);
  for (const t of ['reply_cases', 'tenants', 'outbound_messages']) {
    const from = (): unknown => db.from(t);
    if (t === 'outbound_messages') { assert.throws(from, /not in the dump/u); continue; }
    for (const m of ['insert', 'update', 'upsert', 'delete'] as const) {
      assert.throws(() => (db.from(t) as unknown as Record<string, () => unknown>)[m]?.(), /read-only/u, `${t}.${m}`);
    }
  }
  assert.throws(() => db.rpc('reserve_spend'), /read-only/u);
});

test('the overlay refuses writes on a real-shaped client too, and passes reads through bound', async () => {
  const calls: string[] = [];
  const builder = {
    marker: 'b',
    select(this: { marker: string }) { calls.push(`select:${this.marker}`); return Promise.resolve({ data: [], error: null }); },
    insert() { calls.push('insert'); },
  };
  const fake = { from: (t: string) => { calls.push(`from:${t}`); return builder; } };
  const db = withCases(fake as never, []);
  await (db.from('tenants') as unknown as { select: () => Promise<unknown> }).select();
  assert.deepEqual(calls, ['from:tenants', 'select:b']);
  assert.throws(() => (db.from('tenants') as unknown as { insert: () => void }).insert(), /read-only/u);
  assert.ok(!calls.includes('insert'));
});
