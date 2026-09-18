import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePlatformBlocks, type LiveBlock } from './blockset.ts';
import type { SeedBlock } from './generate-seed.ts';

const signed = (o: Partial<SeedBlock> = {}): SeedBlock => ({
  blockKey: '02_style', ordinal: 2, layer: 'L0', body: 'text\n',
  reviewedBy: 'Bilguun', reviewedAt: '2026-09-17', vertical: null, ...o,
});
const live = (o: Partial<LiveBlock> = {}): LiveBlock => ({
  block_key: '02_style', ordinal: 2, layer: 'L0', body: 'text\n',
  reviewed_by: 'Bilguun', reviewed_at: '2026-09-17T00:00:00+00:00', vertical: null, ...o,
});

test('DONE-TEST: A SIGNED BLOCK MISSING FROM THE DATABASE IS THE WHOLE POINT', () => {
  // The case that motivated this: the migration was written and never pushed. CI cannot see
  // it — CI builds its database out of the repo (D-058) — so the publisher is the only
  // place it can be caught, and it must be caught BEFORE the prefix is frozen.
  const gaps = comparePlatformBlocks([], [signed()]);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0] as string, /02_style: signed, and NOT in the database/);
});

test('matching rows produce no gaps, and a timestamptz matches a date sign-off', () => {
  // The file carries `2026-09-17`; the column carries an instant. Comparing instants would
  // report every row as different for ever, which is a check that cries wolf until it is
  // switched off.
  assert.deepEqual(comparePlatformBlocks([live()], [signed()]), []);
});

test('DONE-TEST: A LIVE BODY THAT IS NOT THE SIGNED TEXT IS CAUGHT', () => {
  // Covers a hand-written UPDATE against production, and a migration marked applied whose
  // rows were later edited — neither of which any repo-side check can observe.
  const gaps = comparePlatformBlocks([live({ body: 'tampered\n' })], [signed()]);
  assert.deepEqual(gaps, ['02_style: the live body is not the signed text']);
});

test('DONE-TEST: A ROW LIVE AND NO LONGER SIGNED STAYS RED', () => {
  // The direction nobody looks for. Running the generator cannot clear it: deleting a row
  // is a destructive migration and founder-gated, so it must stay red until a human writes
  // one. Undetermined is a result; so is "this needs a person".
  const gaps = comparePlatformBlocks([live({ block_key: 'sh9_removed' })], [signed()]);
  assert.ok(gaps.some((g) => g.includes('sh9_removed') && g.includes('NOT signed')));
});

test('a per-vertical row is distinct from its generic twin, never conflated', () => {
  // 0018 exists so `sh8_not_in_kb` and `sh8_not_in_kb.salon` can coexist. Keying on
  // block_key alone would report the salon row as unsigned and the generic one as matching.
  const generic = signed({ blockKey: 'sh8', vertical: null, body: 'g\n' });
  const salon = signed({ blockKey: 'sh8', vertical: 'salon', body: 's\n' });
  const rows = [live({ block_key: 'sh8', vertical: null, body: 'g\n' }),
                live({ block_key: 'sh8', vertical: 'salon', body: 's\n' })];
  assert.deepEqual(comparePlatformBlocks(rows, [generic, salon]), []);
  assert.deepEqual(
    comparePlatformBlocks([rows[0] as LiveBlock], [generic, salon]),
    ['sh8.salon: signed, and NOT in the database'],
  );
});

test('ordinal and layer drift are reported separately from body drift', () => {
  const gaps = comparePlatformBlocks([live({ ordinal: 9, layer: 'L1' })], [signed()]);
  assert.equal(gaps.length, 2);
  assert.ok(gaps.some((g) => g.includes('ordinal 9 live, 2 signed')));
  assert.ok(gaps.some((g) => g.includes('layer L1 live, L0 signed')));
});
