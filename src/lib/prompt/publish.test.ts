import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLiveSnapshot, publishRevision, rollbackTo } from './publish.ts';
import type { Rendered } from './render.ts';

const RENDERED: Rendered = {
  promptStable: 'compiled prefix',
  contentHash: 'abc123',
  promptChars: 15,
  allowedNumbers: ['33,000'],
  order: ['gate_scaffold'],
};

/** Records the order of writes, because for publish the ORDER is the correctness property. */
function stubDb(opts: {
  revisionRow?: unknown; revisionError?: unknown;
  snapshotError?: unknown; updateError?: unknown; pointerError?: unknown;
  snapshotRow?: unknown; tenantRow?: unknown; tenantError?: unknown;
} = {}) {
  const ops: string[] = [];
  const from = (name: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'order', 'limit']) chain[m] = () => chain;
    chain['insert'] = () => { ops.push(`insert:${name}`); return chain; };
    chain['update'] = () => { ops.push(`update:${name}`); return chain; };
    // `??` would swallow an EXPLICIT null, which is precisely the case several of these
    // tests set up — "the row is absent" is a different fact from "the caller said
    // nothing". Presence of the key is the test, not truthiness of the value.
    const given = <T,>(key: string, fallback: T): T => (key in opts ? (opts as Record<string, T>)[key] as T : fallback);
    chain['maybeSingle'] = async () => {
      if (name === 'config_revisions') return { data: given('revisionRow', { status: 'draft' } as unknown), error: opts.revisionError ?? null };
      if (name === 'config_snapshots') return { data: given('snapshotRow', { content_hash: 'abc123', prompt_stable: 'p', allowed_numbers: ['33,000'] } as unknown), error: null };
      if (name === 'tenants') return { data: given('tenantRow', { live_revision_id: 'rev-1' } as unknown), error: opts.tenantError ?? null };
      return { data: null, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => {
      const last = ops[ops.length - 1] ?? '';
      if (last === 'insert:config_snapshots') return res({ error: opts.snapshotError ?? null });
      if (last === 'update:config_revisions') return res({ error: opts.updateError ?? null });
      if (last === 'update:tenants') return res({ error: opts.pointerError ?? null });
      return res({ error: null });
    };
    return chain;
  };
  return { ops, db: { from } as never };
}

const base = {
  tenantId: 't-1', revisionId: 'rev-2',
  snapshots: [{ channel: 'facebook_page', rendered: RENDERED }],
  now: new Date('2026-09-04T00:00:00Z'),
};

test('DONE-TEST: publishing is one insert and a pointer move', () => {
  return publishRevision(stubDb().db, base).then(async (r) => {
    assert.equal(r.ok, true);
  });
});

test('THE ORDER: the snapshot is inserted BEFORE the pointer moves', async () => {
  // If the pointer moved first there would be a window in which live_revision_id names a
  // revision with no snapshot. Reception would find nothing to render and 503 — for every
  // customer of that tenant, for as long as the window lasted.
  const { db, ops } = stubDb();
  await publishRevision(db, base);
  assert.deepEqual(ops, [
    'insert:config_snapshots',
    'update:config_revisions',   // mark published
    'update:config_revisions',   // supersede the outgoing one
    'update:tenants',            // the pointer move, last
  ]);
});

test('a failed snapshot insert never moves the pointer', async () => {
  const { db, ops } = stubDb({ snapshotError: { message: 'duplicate key' } });
  const r = await publishRevision(db, base);
  assert.equal(r.ok, false);
  assert.equal(ops.includes('update:tenants'), false, 'a partially published config looks live');
});

test('a revision that is not a draft is refused', async () => {
  const { db } = stubDb({ revisionRow: { status: 'published' } });
  const r = await publishRevision(db, base);
  assert.equal(!r.ok && r.code, 'not_draft');
});

test('a revision belonging to nobody is refused', async () => {
  const { db } = stubDb({ revisionRow: null });
  const r = await publishRevision(db, base);
  assert.equal(!r.ok && r.code, 'not_draft');
});

test('publishing with no snapshots is refused before anything is read', async () => {
  const { db, ops } = stubDb();
  const r = await publishRevision(db, { ...base, snapshots: [] });
  assert.equal(!r.ok && r.code, 'no_snapshot');
  assert.deepEqual(ops, []);
});

test('an unreadable config_revisions refuses — it never assumes draft', async () => {
  const { db } = stubDb({ revisionError: { message: 'connection reset' } });
  const r = await publishRevision(db, base);
  assert.equal(!r.ok && r.code, 'publish_failed');
});

// ---------------------------------------------------------------------------
// Rollback.
// ---------------------------------------------------------------------------

test('DONE-TEST: rollback is one UPDATE, and re-renders nothing', async () => {
  const { db, ops } = stubDb();
  const r = await rollbackTo(db, { tenantId: 't-1', revisionId: 'rev-1', channels: ['facebook_page'] });
  assert.equal(r.ok, true);
  assert.deepEqual(ops, ['update:tenants'], 'exactly one write, and no compile');
});

test('rolling back to a revision with no snapshot is REFUSED', async () => {
  // A rollback is by definition something done in a hurry, when something is already
  // wrong. It must not be able to make it worse by pointing at a revision that cannot
  // render — which would 503 every conversation for that tenant.
  const { db, ops } = stubDb({ snapshotRow: null });
  const r = await rollbackTo(db, { tenantId: 't-1', revisionId: 'rev-0', channels: ['facebook_page'] });
  assert.equal(!r.ok && r.code, 'no_snapshot');
  assert.deepEqual(ops, [], 'the pointer never moved');
});

test('every channel is checked, not just the first', async () => {
  const { db } = stubDb({ snapshotRow: null });
  const r = await rollbackTo(db, { tenantId: 't-1', revisionId: 'rev-0', channels: ['facebook_page', 'instagram'] });
  assert.equal(!r.ok && r.detail.includes('facebook_page'), true);
});

// ---------------------------------------------------------------------------
// Reading the live snapshot.
// ---------------------------------------------------------------------------

test('the live snapshot is read through the pointer', async () => {
  const r = await loadLiveSnapshot(stubDb().db, { tenantId: 't-1', channel: 'facebook_page' });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.snapshot.revisionId, 'rev-1');
  assert.deepEqual(r.ok && r.snapshot.allowedNumbers, ['33,000']);
});

test('a tenant with no live revision REFUSES — there are no defaults to fall back to', async () => {
  // Inventing one would be a bot answering with a prompt nobody approved.
  const r = await loadLiveSnapshot(stubDb({ tenantRow: { live_revision_id: null } }).db, {
    tenantId: 't-1', channel: 'facebook_page',
  });
  assert.equal(!r.ok && r.code, 'no_live_revision');
});

test('an unreadable tenants row refuses rather than guessing', async () => {
  const r = await loadLiveSnapshot(stubDb({ tenantError: { message: 'timeout' } }).db, {
    tenantId: 't-1', channel: 'facebook_page',
  });
  assert.equal(!r.ok && r.code, 'unavailable');
});

test('a missing snapshot for the channel refuses', async () => {
  const r = await loadLiveSnapshot(stubDb({ snapshotRow: null }).db, { tenantId: 't-1', channel: 'instagram' });
  assert.equal(!r.ok && r.code, 'no_snapshot');
});
