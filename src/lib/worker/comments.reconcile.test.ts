/**
 * D-166 through the REAL `runCommentJob`, over the in-memory store (`memoryDb`), with the real
 * claim, `markSent` and `markIndeterminate`: the public reply that timed out and was posted
 * anyway, in both orders of notice and park, and the run's time budget.
 *
 * The clock is a fake: `msLeft` reads a number the fake Graph moves forward, so a "25 s
 * reply" costs no wall time and the budget arithmetic is exact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_MARGIN_MS, COMMENT_JOB_BUDGET_MS, runCommentJob, type CommentEffects, type CommentJobInput } from './comments.ts';
import { memoryDb } from './commentReplay.fixtures.ts';
import { COMMENT_REPLY_TIMEOUT_MS, type CommentSendOutcome } from '../comments/send.ts';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const CHANNEL = 'channel-a';
const PAGE = '100000000000001';
const NOW = new Date('2026-09-30T04:00:00Z');
const LINE = 'Сайн байна уу! Дэлгэрэнгүйг хувийн мессежээр хүргэе.';

type Row = Record<string, unknown>;

function customer(n: number, over: Row = {}): Row {
  return {
    field: 'feed',
    value: {
      item: 'comment', verb: 'add',
      comment_id: `${PAGE}_c${n}`, post_id: `${PAGE}_p${n}`, parent_id: `${PAGE}_p${n}`,
      from: { id: `customer_${n}`, name: `Хэрэглэгч ${n}` },
      message: 'Үнэ хэд вэ?',
      created_time: Math.floor(NOW.getTime() / 1000) - 60,
      ...over,
    },
  };
}

/** The Page's own comment: Meta's notice of our reply. */
function notice(n: number, over: Row = {}): Row {
  return {
    field: 'feed',
    value: {
      item: 'comment', verb: 'add',
      comment_id: `${PAGE}_r${n}`, post_id: `${PAGE}_p${n}`, parent_id: `${PAGE}_c${n}`,
      from: { id: PAGE, name: 'Salon' },
      message: LINE,
      created_time: Math.floor(NOW.getTime() / 1000),
      ...over,
    },
  };
}

const entry = (changes: Row[], id = PAGE): Row => ({ id, changes });

function store(extra: Row[] = []) {
  return memoryDb({
    canned_responses: [
      { tenant_id: TENANT, kind: 'comment_public_reply', locale: 'mn-MN', body: LINE, reviewed_at: '2026-09-01T00:00:00Z' },
      { tenant_id: TENANT, kind: 'comment_private_reply', locale: 'mn-MN', body: 'Хувийн мессеж.', reviewed_at: '2026-09-01T00:00:00Z' },
    ],
    comment_rules: [
      { tenant_id: TENANT, enabled: true, rule_key: 'price', verdict: 'reply', matcher: { mode: 'contains_stem', stems: ['хэдэ', 'үнэ '] } },
    ],
    webhook_events: [],
    outbound_messages: extra,
    quality_flags: [],
  }, () => NOW);
}

type Harness = {
  s: ReturnType<typeof store>;
  posted: { commentId: string; msLeftAtStart: number }[];
  clock: { left: number };
  fx: (send: (commentId: string) => Promise<CommentSendOutcome>) => CommentEffects;
};

function harness(s = store()): Harness {
  const posted: Harness['posted'] = [];
  const clock = { left: COMMENT_JOB_BUDGET_MS };
  return {
    s, posted, clock,
    fx: (send) => ({
      db: s.db,
      now: NOW,
      replyToComment: async (a) => {
        posted.push({ commentId: a.commentId, msLeftAtStart: clock.left });
        return send(a.commentId);
      },
      sendPrivateReply: async () => ({ outcome: 'sent', providerMessageId: 'm1' }),
      lookupComment: async () => ({ tagsPerson: false, postCreatedAt: new Date(NOW.getTime() - 86_400_000), problems: [] }),
      alertComplaint: async () => {},
      msLeft: () => clock.left,
      log: () => {},
    }),
  };
}

const job = (rawPayload: unknown, over: Partial<CommentJobInput> = {}): CommentJobInput => ({
  tenantId: TENANT, channelId: CHANNEL, pageExternalId: PAGE,
  commentMode: 'live', tokenStatus: 'active', graphVersion: 'v21.0', locale: 'mn-MN',
  config: { policy: 'public_only', maxPostAgeDays: 30, ignoreCommenterIds: [], repliesPerPostPerDay: 5 },
  rawPayload,
  ...over,
});

const publicRows = (s: ReturnType<typeof store>) => s.rows('outbound_messages').filter((r) => r['kind'] === 'comment_reply');

test('D-166 notice AFTER park: the parked reply becomes sent with the notice id, and nothing is posted again', async () => {
  const h = harness();
  const timeout = h.fx(async () => ({ outcome: 'indeterminate', detail: 'reply did not complete (AbortError)' }));
  const first = await runCommentJob(timeout, job(entry([customer(1)])));
  assert.equal(first.refused['indeterminate'], 1);
  assert.equal(publicRows(h.s)[0]?.['state'], 'indeterminate');

  // Meta's notice of the Page's own comment arrives: a separate job, the same worker.
  const noticeJob = await runCommentJob(timeout, job(entry([notice(1)])));
  assert.equal(noticeJob.reconciled, 1);
  const row = publicRows(h.s)[0];
  assert.equal(row?.['state'], 'sent');
  assert.equal(row?.['provider_message_id'], `${PAGE}_r1`);
  assert.equal(Number(row?.['unit_cost_nanousd']), 0, 'sent_has_a_cost holds');
  assert.equal(row?.['sent_at'], NOW.toISOString(), "Meta's created_time");
  assert.match(String(row?.['refused_reason']), /^reconciled from Meta's feed notice .* \(was indeterminate: reply did not complete/);

  // A redelivery of the customer's entry, and the notice again: nothing is posted twice.
  await runCommentJob(timeout, job(entry([customer(1)])));
  const again = await runCommentJob(timeout, job(entry([notice(1)])));
  assert.equal(again.reconciled, 0, 'already sent: untouched');
  assert.equal(h.posted.length, 1, 'posted exactly once, ever');
});

test('D-166 notice BEFORE park: it arrives while the 25 s POST is open, and the late timeout cannot overwrite sent', async () => {
  const h = harness();
  const fxNotice = h.fx(async () => { throw new Error('the notice job never posts'); });
  let stateDuringPost: unknown = null;
  const slow = h.fx(async () => {
    stateDuringPost = publicRows(h.s)[0]?.['state'];
    // While our POST hangs, Meta's notice is processed by another run of the worker.
    const r = await runCommentJob(fxNotice, job(entry([notice(1)])));
    assert.equal(r.reconciled, 1);
    return { outcome: 'indeterminate', detail: 'reply did not complete (AbortError)' };
  });
  await runCommentJob(slow, job(entry([customer(1)])));
  assert.equal(stateDuringPost, 'sending');
  const row = publicRows(h.s)[0];
  assert.equal(row?.['state'], 'sent', 'markIndeterminate CASes on sending and matched nothing');
  assert.equal(row?.['provider_message_id'], `${PAGE}_r1`);
  assert.equal(h.posted.length, 1);
});

test('D-166 notice before park, and the POST then answers: one sent row, one id, one post', async () => {
  const h = harness();
  const fxNotice = h.fx(async () => { throw new Error('never'); });
  const late = h.fx(async () => {
    await runCommentJob(fxNotice, job(entry([notice(1)])));
    return { outcome: 'sent', providerCommentId: `${PAGE}_r1` };
  });
  const r = await runCommentJob(late, job(entry([customer(1)])));
  assert.equal(r.replied, 1);
  const rows = publicRows(h.s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['state'], 'sent');
  assert.equal(rows[0]?.['provider_message_id'], `${PAGE}_r1`);
});

test('D-166 a notice with other text, another parent, another Page or another tenant never reconciles', async () => {
  const cases: { label: string; payload: Row; over?: Partial<CommentJobInput> }[] = [
    { label: 'text', payload: entry([notice(1, { message: `${LINE} Өөр.` })]) },
    { label: 'parent', payload: entry([notice(1, { parent_id: `${PAGE}_c9` })]) },
    { label: 'author', payload: entry([notice(1, { from: { id: 'staff_personal' } })]) },
    { label: 'edited', payload: entry([notice(1, { verb: 'edited' })]) },
    // An entry for another Page, even one whose change names our Page as the author.
    { label: 'page', payload: entry([notice(1)], '999') },
    { label: 'tenant', payload: entry([notice(1)]), over: { tenantId: OTHER_TENANT } },
    { label: 'channel', payload: entry([notice(1)]), over: { channelId: 'channel-b' } },
    { label: 'stale', payload: entry([notice(1, { created_time: Math.floor(NOW.getTime() / 1000) - 3600 })]) },
  ];
  for (const c of cases) {
    const h = harness();
    const timeout = h.fx(async () => ({ outcome: 'indeterminate', detail: 'timeout' }));
    await runCommentJob(timeout, job(entry([customer(1)])));
    const r = await runCommentJob(timeout, job(c.payload, c.over ?? {}));
    assert.equal(r.reconciled, 0, c.label);
    assert.equal(publicRows(h.s)[0]?.['state'], 'indeterminate', c.label);
    assert.equal(publicRows(h.s)[0]?.['provider_message_id'] ?? null, null, c.label);
  }
});

test('D-166 the same text NFC-normalised and trimmed IS a match', async () => {
  const h = harness();
  const timeout = h.fx(async () => ({ outcome: 'indeterminate', detail: 'timeout' }));
  await runCommentJob(timeout, job(entry([customer(1)])));
  // «й» decomposed (и + U+0306) and a trailing newline: the same reply to a reader.
  const decomposed = `${LINE.normalize('NFD')}\n`;
  assert.notEqual(decomposed, LINE);
  const r = await runCommentJob(timeout, job(entry([notice(1, { message: decomposed })])));
  assert.equal(r.reconciled, 1);
});

test('D-166 an already-sent reply keeps its own id when a notice arrives', async () => {
  const h = harness();
  const ok = h.fx(async () => ({ outcome: 'sent', providerCommentId: `${PAGE}_mine` }));
  await runCommentJob(ok, job(entry([customer(1)])));
  const r = await runCommentJob(ok, job(entry([notice(1)])));
  assert.equal(r.reconciled, 0);
  assert.equal(publicRows(h.s)[0]?.['provider_message_id'], `${PAGE}_mine`);
});

test('D-166 time budget: a slow reply defers the next comment to the redelivery, which posts it once', async () => {
  const h = harness();
  // Every reply is slow: it uses its whole 25 s and then answers.
  const slow = h.fx(async (commentId) => {
    h.clock.left -= COMMENT_REPLY_TIMEOUT_MS;
    return { outcome: 'sent', providerCommentId: `${commentId}_reply` };
  });
  const both = job(entry([customer(1), customer(2)]));

  h.clock.left = COMMENT_JOB_BUDGET_MS - 1_000; // a second went on the event read
  const run1 = await runCommentJob(slow, both);
  assert.equal(run1.replied, 1);
  assert.equal(run1.deferred, 1);
  assert.equal(run1.retry, true, 'the job asks for a redelivery');
  const [r1, r2] = publicRows(h.s);
  assert.equal(r1?.['state'], 'sent');
  assert.equal(r2?.['state'], 'draft', 'deferred BEFORE the claim: nothing is in sending');

  h.clock.left = COMMENT_JOB_BUDGET_MS - 1_000; // QStash redelivers: a fresh run
  const run2 = await runCommentJob(slow, both);
  assert.equal(run2.retry, false);
  assert.equal(run2.replied, 1, 'only the deferred one');
  assert.deepEqual(h.posted.map((p) => p.commentId), [`${PAGE}_c1`, `${PAGE}_c2`], 'each posted once');
  assert.ok(publicRows(h.s).every((r) => r['state'] === 'sent'));
  for (const p of h.posted) {
    assert.ok(p.msLeftAtStart >= COMMENT_REPLY_TIMEOUT_MS + BUDGET_MARGIN_MS, 'no send starts unless it can finish inside the budget');
  }

  // A third delivery changes nothing.
  h.clock.left = COMMENT_JOB_BUDGET_MS;
  await runCommentJob(slow, both);
  assert.equal(h.posted.length, 2);
});

test('D-166 time budget: an indeterminate reply is never re-posted by the redelivery a deferral asks for', async () => {
  const h = harness();
  const hang = h.fx(async () => {
    h.clock.left -= COMMENT_REPLY_TIMEOUT_MS;
    return { outcome: 'indeterminate', detail: 'reply did not complete (AbortError)' };
  });
  const both = job(entry([customer(1), customer(2)]));
  h.clock.left = COMMENT_JOB_BUDGET_MS - 1_000;
  const run1 = await runCommentJob(hang, both);
  assert.equal(run1.deferred, 1);
  h.clock.left = COMMENT_JOB_BUDGET_MS - 1_000;
  await runCommentJob(hang, both);
  h.clock.left = COMMENT_JOB_BUDGET_MS - 1_000;
  await runCommentJob(hang, both);
  assert.deepEqual(h.posted.map((p) => p.commentId), [`${PAGE}_c1`, `${PAGE}_c2`], 'one attempt per reply, ever');
  assert.ok(publicRows(h.s).every((r) => r['state'] === 'indeterminate'));
});

test('D-166 time budget: too little left for even the lookup defers before anything is written', async () => {
  const h = harness();
  h.clock.left = 9_000; // under the lookup's 5 s + 5 s margin
  const r = await runCommentJob(h.fx(async () => ({ outcome: 'sent', providerCommentId: 'x' })), job(entry([customer(1)])));
  assert.equal(r.deferred, 1);
  assert.equal(r.retry, true);
  assert.equal(publicRows(h.s).length, 0, 'no row: the redelivery decides it afresh');
  assert.equal(h.posted.length, 0);
});

test('D-166 a redelivery does not write the same flag twice', async () => {
  const s = store();
  const h = harness(s);
  // A comment no rule claims: unclassified, flagged, silent.
  const praise = entry([customer(1, { message: 'Гоё байна' })]);
  const fx = h.fx(async () => ({ outcome: 'sent', providerCommentId: 'x' }));
  await runCommentJob(fx, job(praise));
  await runCommentJob(fx, job(praise));
  const flags = s.rows('quality_flags').filter((f) => f['flag'] === 'comment_unclassified');
  assert.equal(flags.length, 1);
});

test('D-166 review: a retryable 5xx after Meta created the comment is never posted again', async () => {
  const h = harness();
  const fx5xx = h.fx(async () => ({
    outcome: 'failed', failure: 'transient', retryable: true, code: 2, subcode: null, status: 500, detail: 'graph 500',
  }));
  const r1 = await runCommentJob(fx5xx, job(entry([customer(1)])));
  assert.equal(r1.retry, true);
  assert.equal(publicRows(h.s)[0]?.['state'], 'failed');

  // Meta's notice arrives: its own job matches the `failed` row and marks it sent.
  const stored = entry([notice(1)]);
  h.s.rows('webhook_events').push({ id: 1, tenant_id: TENANT, received_at: NOW.toISOString(), raw_payload: stored });
  const n = await runCommentJob(fx5xx, job(stored));
  assert.equal(n.reconciled, 1);

  // QStash redelivers the customer's entry: nothing is posted, and our own reply is not
  // mistaken for staff.
  const r2 = await runCommentJob(h.fx(async () => { throw new Error('must not post twice'); }), job(entry([customer(1)])));
  assert.equal(r2.retry, false);
  assert.equal(r2.refused['staff_replied'], undefined, 'our reply is ours, not a person\'s');
  assert.equal(h.posted.length, 1, 'the one 5xx attempt, never a second post');
  assert.equal(publicRows(h.s)[0]?.['state'], 'sent');
  assert.equal(publicRows(h.s)[0]?.['provider_message_id'], `${PAGE}_r1`);
});

test('D-166 review: a failed row with NO matching notice is re-sent as before', async () => {
  const h = harness();
  let n = 0;
  const flaky = h.fx(async (commentId) => (++n === 1
    ? { outcome: 'failed', failure: 'transient', retryable: true, code: 2, subcode: null, status: 500, detail: 'graph 500' }
    : { outcome: 'sent', providerCommentId: `${commentId}_ok` }));
  await runCommentJob(flaky, job(entry([customer(1)])));
  await runCommentJob(flaky, job(entry([customer(1)])));
  assert.equal(h.posted.length, 2);
  assert.equal(publicRows(h.s)[0]?.['provider_message_id'], `${PAGE}_c1_ok`);
});

test('D-166 review: an unreadable notice check before a re-send posts nothing and leaves the row for the next delivery', async () => {
  const h = harness();
  const fx5xx = h.fx(async () => ({
    outcome: 'failed', failure: 'transient', retryable: true, code: 2, subcode: null, status: 500, detail: 'graph 500',
  }));
  await runCommentJob(fx5xx, job(entry([customer(1)])));
  const base = h.fx(async () => { throw new Error('must not post'); });
  // Every read works except the re-send check's notice read (the only one with a `limit`).
  const real = h.s.db as unknown as { from: (x: string) => Record<string, unknown> };
  const broken = { ...base, db: { from: (t: string) => {
    const chain = real.from(t);
    if (t === 'webhook_events') {
      chain['limit'] = () => ({ then: (res: (v: unknown) => unknown) => res({ data: null, error: { message: 'timeout' } }) });
    }
    return chain;
  } } as never };
  const r = await runCommentJob(broken, job(entry([customer(1)])));
  assert.equal(r.retry, true);
  assert.equal(h.posted.length, 1, 'only the first attempt');
  assert.equal(publicRows(h.s)[0]?.['state'], 'failed', 'claimable again on the next delivery');
  assert.equal(publicRows(h.s)[0]?.['refused_reason'], 'notice check unreadable before a re-send', 'stopped by the re-send check itself');
});

test('D-166 review: a notice STORED but never processed is found by the re-send check, which posts nothing', async () => {
  const h = harness();
  const fx5xx = h.fx(async () => ({
    outcome: 'failed', failure: 'transient', retryable: true, code: 2, subcode: null, status: 500, detail: 'graph 500',
  }));
  await runCommentJob(fx5xx, job(entry([customer(1)])));
  // Stored, but its own job never ran (it failed, or comments were switched off then).
  h.s.rows('webhook_events').push({ id: 1, tenant_id: TENANT, received_at: NOW.toISOString(), raw_payload: entry([notice(1)]) });
  const r = await runCommentJob(h.fx(async () => { throw new Error('must not post twice'); }), job(entry([customer(1)])));
  assert.equal(r.refused['staff_replied'], undefined, 'not read as staff');
  assert.equal(r.reconciled, 1, 'reconciled by the check before the re-send');
  assert.equal(h.posted.length, 1);
  assert.equal(publicRows(h.s)[0]?.['state'], 'sent');
  assert.equal(publicRows(h.s)[0]?.['provider_message_id'], `${PAGE}_r1`);
  assert.equal(h.s.rows('quality_flags').filter((f) => f['flag'] === 'comment_staff_answered').length, 0);
});
