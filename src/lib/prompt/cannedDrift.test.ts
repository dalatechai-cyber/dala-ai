import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cannedHashOf } from './sections.ts';
import { cannedStaleBody, cannedStaleKey, checkCannedDrift, publishedLine } from './cannedDrift.ts';

test('publishedLine: only the exact published line, whole, counts', () => {
  const prefix = 'A\n=== БЭЛЭН ХАРИУЛТ ===\n"handoff": Утсаар холбогдоно уу.\n"refusal_x": Б.';
  assert.equal(publishedLine(prefix, 'handoff', 'Утсаар холбогдоно уу.'), true);
  assert.equal(publishedLine(prefix, 'handoff', '  Утсаар холбогдоно уу.  '), true, 'trimmed as the renderer trims');
  assert.equal(publishedLine(prefix, 'handoff', 'Утсаар холбогдоно'), false, 'a prefix of the line is not the line');
  assert.equal(publishedLine(prefix, 'handoff', 'Шинэ мөр.'), false);
  assert.equal(publishedLine(prefix, 'refusal_x', 'Б.'), true, 'the last line, with no trailing newline');
  assert.equal(publishedLine(prefix, 'handoff', '   '), false);
  assert.equal(publishedLine(prefix, 'other', 'Утсаар холбогдоно уу.'), false, 'the kind is part of the line');
});

test('the page names the tenant and says republish; the key has no period (on_change)', () => {
  const body = cannedStaleBody({ name: 'Tara Salon — Яармаг', source: 'hourly check', channels: ['facebook_page'] });
  assert.match(body, /Tara Salon — Яармаг \(facebook_page\)/);
  assert.match(body, /Republish now/);
  assert.equal(cannedStaleKey('t-1'), 'config.canned_stale:t-1');
});

type Row = Record<string, unknown>;
function stub(tables: Record<string, { data: unknown; error: unknown }>) {
  const inserted: Row[] = [];
  const updated: Row[] = [];
  const from = (table: string) => {
    const c: Record<string, unknown> = {};
    let op = 'select';
    for (const m of ['select', 'eq', 'not', 'is', 'in', 'limit', 'order']) c[m] = () => c;
    c['insert'] = (r: Row) => { op = 'insert'; inserted.push(r); return c; };
    c['update'] = (r: Row) => { op = 'update'; updated.push(r); return c; };
    c['maybeSingle'] = async () => (table === 'alerts' && op === 'insert' ? { data: { id: 1 }, error: null } : table === 'alerts' ? { data: null, error: null } : tables[table] ?? { data: null, error: null });
    c['then'] = (res: (v: unknown) => unknown) => res(table === 'alerts' ? { data: [], error: null } : tables[table] ?? { data: [], error: null });
    return c;
  };
  return { db: { from } as never, inserted, updated };
}

const ROWS = [{ kind: 'handoff', body: 'А' }, { kind: 'refusal_x', body: 'Б' }];

test('checkCannedDrift: a live snapshot whose canned_hash differs from the rows pages once, critical, now', async () => {
  const prev = process.env['ALERTS_ENABLED'];
  process.env['ALERTS_ENABLED'] = 'false';
  try {
    const s = stub({
      tenants: { data: [{ id: 't-1', display_name: 'Tara', live_revision_id: 'r-1', default_locale: 'mn-MN' }], error: null },
      config_snapshots: { data: [{ channel: 'facebook_page', canned_hash: 'old' }], error: null },
      canned_responses: { data: ROWS, error: null },
    });
    const r = await checkCannedDrift(s.db, new Date('2026-09-30T05:00:00Z'));
    assert.deepEqual(r, { ok: true, checked: 1, drifted: 1, raised: 1, closed: 0, failures: 0 });
    assert.equal(s.inserted[0]?.['dedup_key'], 'config.canned_stale:t-1');
    assert.equal(s.inserted[0]?.['severity'], 'critical');
    assert.equal(s.inserted[0]?.['route'], 'now');
    assert.equal(s.inserted[0]?.['repeat_policy'], 'on_change');
  } finally {
    if (prev === undefined) delete process.env['ALERTS_ENABLED']; else process.env['ALERTS_ENABLED'] = prev;
  }
});

test('checkCannedDrift: matching hashes page nothing and close the episode; a pre-D-058 snapshot (null) is not drift', async () => {
  for (const hash of [cannedHashOf(ROWS), null]) {
    const s = stub({
      tenants: { data: [{ id: 't-1', live_revision_id: 'r-1', default_locale: 'mn-MN' }], error: null },
      config_snapshots: { data: [{ channel: 'facebook_page', canned_hash: hash }], error: null },
      canned_responses: { data: ROWS, error: null },
    });
    const r = await checkCannedDrift(s.db, new Date());
    assert.equal(r.ok && r.drifted, 0);
    assert.equal(s.inserted.length, 0);
    assert.ok(s.updated.some((u) => typeof u['resolved_at'] === 'string'), 'the episode is closed');
  }
});

test('checkCannedDrift: an unreadable tenant list is a failure, never "no drift"', async () => {
  const s = stub({ tenants: { data: null, error: { message: 'reset' } } });
  const r = await checkCannedDrift(s.db, new Date());
  assert.equal(r.ok, false);
});

test('checkCannedDrift: an UNSIGNED row or a REQUIRED line with no row pages even when the hash matches, and never closes', async () => {
  const prev = process.env['ALERTS_ENABLED'];
  process.env['ALERTS_ENABLED'] = 'false';
  try {
    const cases: [Record<string, { data: unknown; error: unknown }>, RegExp][] = [
      [{ canned_responses: { data: [{ ...ROWS[0], reviewed_at: null }, ROWS[1]], error: null } }, /Unsigned: handoff/],
      [{ out_of_scope_topics: { data: [{ response_kind: 'refusal_kids' }], error: null } }, /No row for: refusal_kids/],
      [{ config_snapshots: { data: [{ channel: 'facebook_page', canned_hash: cannedHashOf(ROWS), prompt_stable: 'x "image_received" y' }], error: null } }, /No row for: image_received/],
    ];
    for (const [over, says] of cases) {
      const s = stub({
        tenants: { data: [{ id: 't-1', display_name: 'Tara', live_revision_id: 'r-1', default_locale: 'mn-MN' }], error: null },
        config_snapshots: { data: [{ channel: 'facebook_page', canned_hash: cannedHashOf(ROWS) }], error: null },
        canned_responses: { data: ROWS, error: null },
        ...over,
      });
      const r = await checkCannedDrift(s.db, new Date());
      assert.equal(r.ok && r.drifted, 1, String(says));
      assert.match(String(s.inserted[0]?.['body']), says);
      assert.ok(!s.updated.some((u) => typeof u['resolved_at'] === 'string'), 'not closed');
    }
    // An unreadable rule table is a failure, and the episode is left alone.
    const down = stub({
      tenants: { data: [{ id: 't-1', live_revision_id: 'r-1', default_locale: 'mn-MN' }], error: null },
      config_snapshots: { data: [{ channel: 'facebook_page', canned_hash: cannedHashOf(ROWS) }], error: null },
      canned_responses: { data: ROWS, error: null },
      disclosure_rules: { data: null, error: { message: 'timeout' } },
    });
    const d = await checkCannedDrift(down.db, new Date());
    assert.equal(d.ok && d.failures, 1);
    assert.equal(down.updated.length + down.inserted.length, 0);
  } finally {
    if (prev === undefined) delete process.env['ALERTS_ENABLED']; else process.env['ALERTS_ENABLED'] = prev;
  }
});

test('checkCannedDrift: an unsigned row on a revision published BEFORE the canned section still pages (the reply path refuses it too)', async () => {
  const prev = process.env['ALERTS_ENABLED'];
  process.env['ALERTS_ENABLED'] = 'false';
  try {
    const s = stub({
      tenants: { data: [{ id: 't-1', live_revision_id: 'r-1', default_locale: 'mn-MN' }], error: null },
      config_snapshots: { data: [{ channel: 'facebook_page', canned_hash: null }], error: null },
      canned_responses: { data: [{ ...ROWS[0], reviewed_at: null }, ROWS[1]], error: null },
    });
    const r = await checkCannedDrift(s.db, new Date());
    assert.equal(r.ok && r.drifted, 1);
    assert.ok(!s.updated.some((u) => typeof u['resolved_at'] === 'string'), 'never closed while the reply path refuses');
  } finally {
    if (prev === undefined) delete process.env['ALERTS_ENABLED']; else process.env['ALERTS_ENABLED'] = prev;
  }
});
