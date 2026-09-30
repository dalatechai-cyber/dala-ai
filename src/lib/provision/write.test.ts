import test from 'node:test';
import assert from 'node:assert/strict';
import { refuseLiveSentenceChange } from './write.ts';
import type { IntakeDocument } from './intake.ts';

/** Answers `tenants` with `.maybeSingle()` and `canned_responses` as an awaited list. */
function fakeDb(tenant: Record<string, unknown> | null, canned: Record<string, unknown>[], cannedError: string | null = null) {
  const reads: string[] = [];
  const db = {
    from: (table: string) => {
      reads.push(table);
      const result = table === 'tenants'
        ? { data: tenant, error: null }
        : { data: cannedError === null ? canned : null, error: cannedError === null ? null : { message: cannedError } };
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (res: (v: unknown) => unknown) => res(result),
      };
      return chain;
    },
  };
  return { db: db as never, reads };
}

const doc = (sentences: Record<string, string>) =>
  ({ business: { locale: 'mn-MN' }, sentences } as unknown as IntakeDocument);
const LIVE = { live_revision_id: 'r1', default_locale: 'mn-MN' };

test('D-163: a live tenant whose intake changes a published line is refused before any write', async () => {
  const { db } = fakeDb(LIVE, [{ kind: 'handoff', body: 'Хуучин.' }]);
  await assert.rejects(refuseLiveSentenceChange(db, doc({ handoff: 'Шинэ.' }), 't1'), /changes its published lines \(handoff\)/u);
});

test('D-163: an unchanged or model-invisible change on a live tenant is allowed', async () => {
  const { db } = fakeDb(LIVE, [{ kind: 'handoff', body: 'Хуучин.' }, { kind: 'image_received', body: 'А.' }]);
  await refuseLiveSentenceChange(db, doc({ handoff: 'Хуучин.', image_received: 'Б.', voice_received: 'В.' }), 't1');
});

test('D-163: a whitespace-only change on a live tenant is refused (the upsert would be refused and unsign the row)', async () => {
  const { db } = fakeDb(LIVE, [{ kind: 'handoff', body: 'Хуучин.' }]);
  await assert.rejects(refuseLiveSentenceChange(db, doc({ handoff: 'Хуучин. ' }), 't1'), /published lines/u);
});

test('D-163: a live tenant whose intake changes the default locale is refused before any write', async () => {
  const { db } = fakeDb({ live_revision_id: 'r1', default_locale: 'en-US' }, []);
  await assert.rejects(refuseLiveSentenceChange(db, doc({}), 't1'), /default locale/u);
});

test('D-163: a tenant with no live revision is never refused, and canned rows are not even read', async () => {
  const { db, reads } = fakeDb({ live_revision_id: null, default_locale: 'mn-MN' }, []);
  await refuseLiveSentenceChange(db, doc({ handoff: 'Шинэ.' }), 't1');
  assert.deepEqual(reads, ['tenants']);
});

test('D-163: an unreadable canned read on a live tenant refuses', async () => {
  const { db } = fakeDb(LIVE, [], 'boom');
  await assert.rejects(refuseLiveSentenceChange(db, doc({ handoff: 'Шинэ.' }), 't1'), /unreadable/u);
});
