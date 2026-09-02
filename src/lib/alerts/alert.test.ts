import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiseAlert, spendDedupKey } from './alert.ts';

/** In-memory alerts table with the dedup semantics the real one has. */
function stubDb() {
  const rows: Array<{ id: number; dedup_key: string; delivered: boolean }> = [];
  let nextId = 1;
  const db = {
    from: () => {
      const chain: Record<string, unknown> = {};
      let pendingKey: string | null = null;
      let inserted: { id: number } | null = null;
      chain['select'] = () => chain;
      chain['eq'] = (_col: string, val: string) => { pendingKey = val; return chain; };
      chain['limit'] = () => chain;
      chain['update'] = () => chain;
      chain['insert'] = (row: { dedup_key: string }) => {
        if (rows.some((r) => r.dedup_key === row.dedup_key)) { inserted = null; return chain; }
        const created = { id: nextId++, dedup_key: row.dedup_key, delivered: false };
        rows.push(created);
        inserted = { id: created.id };
        return chain;
      };
      chain['maybeSingle'] = async () => {
        if (inserted !== null) return { data: inserted, error: null };
        if (pendingKey !== null) {
          const found = rows.find((r) => r.dedup_key === pendingKey);
          return { data: found ? { id: found.id } : null, error: null };
        }
        return { data: null, error: null };
      };
      chain['then'] = (res: (v: unknown) => unknown) => res({ error: null });
      return chain;
    },
  } as never;
  return { db, rows };
}

test('THE DONE-TEST: a tripped ceiling fires exactly ONE alert, not five hundred', async () => {
  // V1.md item 2.3. A tripped ceiling is hit by every subsequent inbound message, so a
  // naive alert produces one notification per message — which trains the founder to
  // ignore the channel precisely when it matters most.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  const key = spendDedupKey('t-1', 'reception', '2026-09-02', '100pct');

  const outcomes: string[] = [];
  for (let i = 0; i < 500; i += 1) {
    const res = await raiseAlert(db, {
      tenantId: 't-1', severity: 'critical', kind: 'spend.ceiling_reached',
      dedupKey: key, body: 'Reception daily ceiling reached',
    });
    outcomes.push(res.outcome);
  }

  assert.equal(rows.length, 1, 'exactly one alert row for 500 occurrences');
  assert.equal(outcomes.filter((o) => o !== 'suppressed_duplicate').length, 1);
  assert.equal(outcomes[0], 'recorded_undelivered');
  assert.ok(outcomes.slice(1).every((o) => o === 'suppressed_duplicate'));
});

test('the same ceiling TOMORROW is a new alert, not a suppressed one', async () => {
  // The period is in the dedup key on purpose. Without it, a ceiling hit once would be
  // silent forever after.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  for (const day of ['2026-09-02', '2026-09-03']) {
    await raiseAlert(db, {
      tenantId: 't-1', severity: 'critical', kind: 'spend.ceiling_reached',
      dedupKey: spendDedupKey('t-1', 'reception', day, '100pct'), body: 'ceiling',
    });
  }
  assert.equal(rows.length, 2);
});

test('different tenants hitting the same threshold are separate alerts', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  for (const tenant of ['t-1', 't-2']) {
    await raiseAlert(db, {
      tenantId: tenant, severity: 'warn', kind: 'spend.threshold',
      dedupKey: spendDedupKey(tenant, 'reception', '2026-09-02', '80pct'), body: '80%',
    });
  }
  assert.equal(rows.length, 2);
});

test('a suppressed send still records the row — detection is never lost', async () => {
  // ALERTS_ENABLED=false suppresses the SEND, never the row. A test can therefore still
  // prove the condition was detected, and a delivery failure stays visible as
  // delivered=false rather than vanishing.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  const res = await raiseAlert(db, {
    tenantId: 't-1', severity: 'info', kind: 'x', dedupKey: 'k', body: 'b',
  });
  assert.equal(res.outcome, 'recorded_undelivered');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.delivered, false);
});
