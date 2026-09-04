import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConfirmationCode,
  newConfirmationCode,
  readErasureStatus,
  recordErasureRequest,
} from './erasure.ts';

type Reply = { data?: unknown; error?: unknown };

/** Answers by OPERATION, never by a positional queue — see worker/comments.test.ts. */
function stubDb(answers: { insert?: Reply; select?: Reply } = {}) {
  const ops: { op: string; patch?: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  const from = () => {
    const rec = { op: 'select', filters: {} } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'limit'] as const) chain[m] = () => chain;
    chain['eq'] = (col: string, val: unknown) => {
      rec.filters[col] = val;
      return chain;
    };
    chain['is'] = (col: string, val: unknown) => {
      rec.filters[col] = val;
      return chain;
    };
    chain['insert'] = (patch: Record<string, unknown>) => {
      rec.op = 'insert';
      rec.patch = patch;
      return chain;
    };
    chain['maybeSingle'] = async () =>
      rec.op === 'insert'
        ? (answers.insert ?? { data: { confirmation_code: patchCode(rec) }, error: null })
        : (answers.select ?? { data: null, error: null });
    return chain;
  };
  const patchCode = (rec: (typeof ops)[number]) => String(rec.patch?.['confirmation_code'] ?? '');
  return { ops, db: { from } as never };
}

const INPUT = {
  provider: 'facebook',
  externalId: '1234567890123456',
  idKind: 'asid' as const,
  appSlug: 'dala',
  issuedAt: new Date('2026-09-04T12:00:00Z'),
};

// ---------------------------------------------------------------------------
// The code is a credential
// ---------------------------------------------------------------------------

test('a confirmation code is alphanumeric, unambiguous, and 120 bits', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const code = newConfirmationCode();
    assert.match(code, /^[A-Z2-9]{24}$/, code); // ascii-safe: the code alphabet is ASCII by construction
    // Meta requires alphanumeric. These four are absent because the code gets read off a
    // screen and typed into another one.
    assert.doesNotMatch(code, /[IO01]/, code); // ascii-safe: four ASCII characters, named individually
    codes.add(code);
  }
  assert.equal(codes.size, 500, 'no repeats in 500 draws');
});

test('DONE-TEST: the code does not derive from the id it is about', () => {
  // A code derived from the ASID would let anybody holding an ASID read that person's
  // status page. Two requests for the SAME person get different codes.
  const a = newConfirmationCode();
  const b = newConfirmationCode();
  assert.notEqual(a, b);
});

test('isConfirmationCode refuses anything that is not exactly the shape', () => {
  assert.equal(isConfirmationCode(newConfirmationCode()), true);
  for (const bad of ['', 'short', 'A'.repeat(23), 'A'.repeat(25), 'a'.repeat(24), `${'A'.repeat(23)}0`, null, 42]) {
    assert.equal(isConfirmationCode(bad), false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test('a request is recorded as an ASID, never as a contact id, and never completed', async () => {
  const { db, ops } = stubDb();
  const out = await recordErasureRequest(db, INPUT);
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.created, true);

  const insert = ops.find((o) => o.op === 'insert')?.patch;
  assert.equal(insert?.['id_kind'], 'asid', 'the namespace is recorded, so nothing later joins it to a PSID');
  assert.equal(insert?.['source'], 'meta_callback');
  assert.equal(insert?.['app_slug'], 'dala');
  assert.equal(insert?.['status'], 'received', 'recording is not deleting');
  assert.equal(insert?.['tenant_id'], null, 'an app-scoped id does not name a tenant');
  assert.equal(insert?.['external_id'], INPUT.externalId);
  assert.equal(insert?.['issued_at'], '2026-09-04T12:00:00.000Z');
});

test('DONE-TEST: a redelivery returns the code already issued, never a second one', async () => {
  // Meta re-sending is not two requests, and a person holding two codes for one request
  // cannot tell which page is theirs.
  const { db } = stubDb({
    insert: { error: { code: '23505', message: 'duplicate key' } },
    select: { data: { confirmation_code: 'EXISTINGCODEEXISTINGCODE' }, error: null },
  });
  const out = await recordErasureRequest(db, INPUT);
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.created, false);
  assert.equal(out.ok && out.code, 'EXISTINGCODEEXISTINGCODE');
});

test('the redelivery read is scoped to the OPEN request for this app and id', async () => {
  const { db, ops } = stubDb({
    insert: { error: { code: '23505', message: 'duplicate key' } },
    select: { data: { confirmation_code: 'EXISTINGCODEEXISTINGCODE' }, error: null },
  });
  await recordErasureRequest(db, INPUT);
  const read = ops.find((o) => o.op === 'select');
  assert.equal(read?.filters['app_slug'], 'dala');
  assert.equal(read?.filters['external_id'], INPUT.externalId);
  assert.equal(read?.filters['source'], 'meta_callback');
  assert.equal(read?.filters['completed_at'], null, 'a COMPLETED request must not be re-used');
});

test('a unique violation with no row behind it refuses rather than inventing a code', async () => {
  const { db } = stubDb({
    insert: { error: { code: '23505', message: 'duplicate key' } },
    select: { data: null, error: null },
  });
  const out = await recordErasureRequest(db, INPUT);
  assert.equal(out.ok, false);
});

test('an insert failure is reported, never swallowed into a cheerful code', async () => {
  const { db } = stubDb({ insert: { error: { code: '08006', message: 'connection reset' } } });
  const out = await recordErasureRequest(db, INPUT);
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.detail : '', /connection reset/);
});

test('an empty id or app is refused before any write', async () => {
  for (const over of [{ externalId: '' }, { externalId: '  ' }, { appSlug: '' }]) {
    const { db, ops } = stubDb();
    const out = await recordErasureRequest(db, { ...INPUT, ...over });
    assert.equal(out.ok, false, JSON.stringify(over));
    assert.equal(ops.length, 0, 'nothing may reach the database');
  }
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test('the status read returns dates and a state, and nothing identifying', async () => {
  const { db, ops } = stubDb({
    select: {
      data: { status: 'received', requested_at: '2026-09-04T12:00:00Z', completed_at: null },
      error: null,
    },
  });
  const code = newConfirmationCode();
  const out = await readErasureStatus(db, code);
  assert.equal(out.outcome, 'found');
  assert.equal(out.outcome === 'found' && out.status, 'received');
  assert.equal(out.outcome === 'found' && out.completedAt, null);
  assert.equal(ops[0]?.filters['confirmation_code'], code);
});

test('a code that is not code-shaped is not_found, and never reaches the database', async () => {
  // The code arrives in a public query string. A malformed one is a typo or a probe, and
  // either way there is nothing to look up.
  for (const bad of ['', 'x', "' or 1=1--", 'A'.repeat(200)]) {
    const { db, ops } = stubDb();
    const out = await readErasureStatus(db, bad);
    assert.equal(out.outcome, 'not_found', JSON.stringify(bad));
    assert.equal(ops.length, 0, JSON.stringify(bad));
  }
});

test('an unreadable table is unavailable, never not_found', async () => {
  // "We could not look" and "there is no such request" are different answers, and telling
  // a person their deletion request does not exist because the database blipped is the
  // wrong one.
  const { db } = stubDb({ select: { error: { message: 'reset' } } });
  const out = await readErasureStatus(db, newConfirmationCode());
  assert.equal(out.outcome, 'unavailable');
});

test('an unusable timestamp is null rather than an Invalid Date', async () => {
  const { db } = stubDb({
    select: { data: { status: 'completed', requested_at: 'not a date', completed_at: null }, error: null },
  });
  const out = await readErasureStatus(db, newConfirmationCode());
  assert.equal(out.outcome === 'found' && out.requestedAt, null);
});
