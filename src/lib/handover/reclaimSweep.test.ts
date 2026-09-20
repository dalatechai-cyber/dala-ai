import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepReclaimable, type ReclaimDeps } from './reclaim.ts';

const NOW = new Date('2026-09-20T12:00:00Z');
const TENANT = 't1';

/** The narrowest fake that answers the two shapes this module uses. */
function fakeDb(rows: Record<string, unknown>[], updates: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, lte: () => chain, order: () => chain,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    limit: () => Promise.resolve({ data: rows, error: null }),
    update: (patch: Record<string, unknown>) => { updates.push(patch); return chainUpd; },
  };
  const chainUpd: Record<string, unknown> = {
    eq: () => chainUpd,
    then: (res: (v: unknown) => unknown) => res({ error: null }),
  };
  void q;
  return { from: () => chain } as never;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', thread_control: 'human', thread_control_source: 'passed',
  thread_control_at: '2026-09-20T11:00:00Z', ...over,
});

function deps(over: Partial<ReclaimDeps> = {}, rows = [row()], updates: Record<string, unknown>[] = []): ReclaimDeps {
  return {
    db: fakeDb(rows, updates), now: NOW,
    reclaimLine: async () => 'Уучлаарай, хүлээлгэсэнд.',
    takeControl: async () => 'accepted',
    draft: async () => ({ ok: true }),
    ...over,
  };
}

test('a passed thread past the window is taken, drafted and flipped back to the bot', async () => {
  const drafts: string[] = []; const updates: Record<string, unknown>[] = [];
  const r = await sweepReclaimable(
    deps({ draft: async (i) => { drafts.push(i.dedupKey); return { ok: true }; } }, [row()], updates),
    { tenantId: TENANT },
  );
  assert.equal(r.reclaimed, 1);
  assert.deepEqual(drafts, ['reclaim:c1:2026-09-20T11:00:00.000Z']);
  assert.equal(updates.at(-1)?.['thread_control'], 'bot');
  assert.equal(updates.at(-1)?.['thread_control_source'], 'reclaim');
});

// THE FILTER IS NOT THE DECISION (D-064). If the query ever returns a row the rule would
// refuse — a changed filter, a stale index, a hand-written call — the verdict still bites.
test('a handover-sourced row that slips past the query is still refused', async () => {
  const updates: Record<string, unknown>[] = [];
  const r = await sweepReclaimable(deps({}, [row({ thread_control_source: 'handover' })], updates), { tenantId: TENANT });
  assert.equal(r.reclaimed, 0);
  assert.equal(r.skipped['not_ours_to_reclaim'], 1);
  assert.equal(updates.length, 0);
});

test('no reviewed line: nothing is reclaimed and the skip is NAMED, not silent', async () => {
  const updates: Record<string, unknown>[] = [];
  const r = await sweepReclaimable(deps({ reclaimLine: async () => null }, [row()], updates), { tenantId: TENANT });
  assert.equal(r.reclaimed, 0);
  assert.equal(r.failed['no_reviewed_line'], 1);
  assert.equal(updates.length, 0);
});

// `graph.ts`: an indeterminate TAKE is read as "assume it did not happen, stay quiet",
// the opposite of an indeterminate send. Nothing may be drafted and control must not move.
test('an indeterminate take neither drafts nor flips', async () => {
  const drafts: string[] = []; const updates: Record<string, unknown>[] = [];
  const r = await sweepReclaimable(
    deps({
      takeControl: async () => 'indeterminate',
      draft: async (i) => { drafts.push(i.dedupKey); return { ok: true }; },
    }, [row()], updates),
    { tenantId: TENANT },
  );
  assert.equal(r.reclaimed, 0);
  assert.equal(r.failed['take_indeterminate'], 1);
  assert.equal(r.retry, true);
  assert.deepEqual(drafts, []);
  assert.equal(updates.length, 0);
});

test('an unreadable conversations table retries rather than reporting nothing to do', async () => {
  const bad = { from: () => ({ select: () => bad2, }) } as never;
  const bad2: Record<string, unknown> = {
    eq: () => bad2, lte: () => bad2, order: () => bad2,
    limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
  };
  const r = await sweepReclaimable(deps({ db: bad }), { tenantId: TENANT });
  assert.equal(r.retry, true);
  assert.equal(r.failed['conversations_unreadable'], 1);
});
