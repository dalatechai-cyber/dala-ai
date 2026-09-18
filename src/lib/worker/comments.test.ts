import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommentJob, type CommentEffects, type CommentJobInput } from './comments.ts';
import type { CommentSendOutcome } from '../comments/send.ts';

const TENANT = 't-1';
const CHANNEL = 'c-1';
const PAGE = '100000000000001';
const NOW = new Date('2026-09-04T12:00:00Z');
const LINE = 'Сайн байна уу! Дэлгэрэнгүйг хувийн мессежээр хүргэе.';

function comment(over: Record<string, unknown> = {}) {
  return {
    field: 'feed',
    value: {
      item: 'comment',
      verb: 'add',
      comment_id: `${PAGE}_c1`,
      post_id: `${PAGE}_p1`,
      from: { id: 'customer_1', name: 'Болормаа' },
      message: 'Үнэ хэд вэ?',
      created_time: Math.floor(NOW.getTime() / 1000) - 600,
      ...over,
    },
  };
}

const entry = (changes: unknown[]) => ({ id: PAGE, changes });

type Reply = { data?: unknown; error?: unknown };

/**
 * A `reply` rule that fires on the fixture comment «Үнэ хэд вэ?», and an `escalate` rule.
 *
 * Every pre-classifier case in this file describes a customer worth answering, so the
 * default rule set has to say so or the whole suite refuses with `no_rules` — which is
 * itself the correct behaviour and is asserted below.
 */
const RULE_ROWS = [
  { rule_key: 'price', verdict: 'reply', matcher: { mode: 'contains_stem', stems: ['хэдэ', 'үнэ '] } },
  { rule_key: 'complaint', verdict: 'escalate', matcher: { mode: 'contains_stem', stems: ['утсаа', 'залга'] } },
  { rule_key: 'praise', verdict: 'ignore', matcher: { mode: 'contains_stem', stems: ['гоён', 'баярла'] } },
];

const DEFAULTS: Record<string, Reply> = {
  canned_responses: { data: { body: LINE, reviewed_at: '2026-09-01T00:00:00Z' }, error: null },
  comment_rules: { data: RULE_ROWS, error: null },
  quality_flags: { data: null, error: null },
};

/**
 * `outbound_messages` is answered by OPERATION, not by a positional queue.
 *
 * A queue looked simpler and modelled the call sequence wrongly: `parentsWeWrote` returns
 * early without touching the database when every comment is top-level, so the entry meant
 * for it was silently consumed by the next reader. One test then passed for the wrong
 * reason and another failed for one. Keying on the operation cannot drift like that.
 */
type OutboundStub = {
  /** Rows the two id lookups return: prior replies of ours (parents, answered threads). */
  existing?: Reply;
  /** Rows the per-post counter returns: one per prior reply, carrying `comment_post_id`. */
  posts?: Reply;
  /** `draftOnce`'s duplicate path: the row somebody else already wrote. */
  reread?: Reply;
  /** `claim`'s why-did-the-CAS-miss read. */
  state?: Reply;
  /** The draft insert. */
  insert?: Reply;
  /** The claim CAS. */
  claim?: Reply;
};

function stubDb(over: Record<string, Reply> = {}, outbound: OutboundStub = {}) {
  const ops: {
    table: string; op: string; cols?: string;
    patch?: Record<string, unknown>;
    filters: Record<string, unknown>;
  }[] = [];

  const answer = (table: string, rec: (typeof ops)[number]): Reply => {
    if (table === 'outbound_messages') {
      if (rec.op === 'insert') return outbound.insert ?? { data: { id: 'om-1', body: LINE, state: 'draft', attempts: 0 }, error: null };
      if (rec.op === 'update') return outbound.claim ?? { data: { id: 'om-1', body: LINE, attempts: 0 }, error: null };
      // Three different readers now, distinguished by what they SELECT rather than by
      // call order — the same reason the stub stopped being a positional queue.
      if ((rec.cols ?? '').includes('comment_post_id')) return outbound.posts ?? { data: [], error: null };
      if ((rec.cols ?? '').includes('attempts')) return outbound.reread ?? { data: null, error: null };
      if (rec.cols === 'state') return outbound.state ?? { data: null, error: null };
      return outbound.existing ?? { data: [], error: null };
    }
    return over[table] ?? DEFAULTS[table] ?? { data: null, error: null };
  };

  const from = (table: string) => {
    const rec = { table, op: 'select', filters: {} } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    chain['select'] = (cols: string) => {
      rec.cols = cols;
      return chain;
    };
    for (const m of ['eq', 'in', 'is', 'not', 'gte', 'lt']) {
      chain[m] = (col: string, val: unknown) => {
        rec.filters[`${m}:${col}`] = val;
        return chain;
      };
    }
    for (const m of ['or', 'limit']) chain[m] = () => chain;
    for (const m of ['insert', 'update', 'upsert'] as const) {
      chain[m] = (patch: Record<string, unknown>) => {
        rec.op = m;
        rec.patch = patch;
        return chain;
      };
    }
    chain['maybeSingle'] = async () => answer(table, rec);
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(table, rec));
    return chain;
  };
  return { ops, db: { from } as never };
}

const baseInput: CommentJobInput = {
  tenantId: TENANT,
  channelId: CHANNEL,
  pageExternalId: PAGE,
  deliveryMode: 'live',
  graphVersion: 'v21.0',
  locale: 'mn-MN',
  config: { policy: 'public_only', maxPostAgeDays: 30, ignoreCommenterIds: [], repliesPerPostPerDay: 1 },
  rawPayload: entry([comment()]),
};

function stubFx(over: { tables?: Record<string, Reply>; outbound?: OutboundStub; send?: CommentSendOutcome } = {}) {
  const { db, ops } = stubDb(over.tables ?? {}, over.outbound ?? {});
  const posted: { commentId: string; body: string; tenantId: string }[] = [];
  const logs: string[] = [];
  const fx: CommentEffects = {
    db,
    now: NOW,
    replyToComment: async (a) => {
      posted.push({ commentId: a.commentId, body: a.body, tenantId: a.tenantId });
      return over.send ?? { outcome: 'sent', providerCommentId: `${a.commentId}_r1` };
    },
    log: (_l, e) => logs.push(e),
  };
  return { fx, ops, posted, logs };
}

const run = (over: Parameters<typeof stubFx>[0] = {}, input: Partial<CommentJobInput> = {}) => {
  const s = stubFx(over);
  return { ...s, result: runCommentJob(s.fx, { ...baseInput, ...input }) };
};

// ---------------------------------------------------------------------------

test('a customer comment gets exactly one public reply, and it is the tenant line', async () => {
  const { posted, result } = run();
  const r = await result;
  assert.equal(r.replied, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.commentId, `${PAGE}_c1`);
  assert.equal(posted[0]?.body, LINE, 'the STORED tenant line');
  assert.equal(posted[0]?.tenantId, TENANT, 'the credential is resolved per call, per tenant');
});

test('the draft is keyed by THREAD, which is what makes three comments one reply', async () => {
  // A REPLY, so threadId and commentId differ. Asserted on a top-level comment this test
  // was vacuous — the two ids are equal there, so keying by either passed. A mutation
  // swapping `decision.threadId` for `comment.commentId` survived it.
  const { ops, result } = run({}, {
    rawPayload: entry([comment({ comment_id: `${PAGE}_c9`, parent_id: `${PAGE}_c1` })]),
  });
  await result;
  const insert = ops.find((o) => o.table === 'outbound_messages' && o.op === 'insert');
  assert.equal(insert?.patch?.['kind'], 'comment_reply');
  assert.equal(insert?.patch?.['dedup_key'], `${PAGE}_c1`, 'the thread ROOT');
  assert.notEqual(insert?.patch?.['dedup_key'], `${PAGE}_c9`, 'not the comment itself');
  assert.equal(insert?.patch?.['body'], LINE);
});

test('DONE-TEST: a reply to OUR OWN comment is not answered', async () => {
  // The loop the thread rule alone does not close. A customer comments (thread C1); we
  // reply R1; somebody replies to R1. That comment's thread root is R1, which has no
  // outbound row of its own — so without this the bot answers, then answers its answer.
  const { posted, result } = run(
    { outbound: { existing: { data: [{ provider_message_id: `${PAGE}_r1`, dedup_key: 'other' }], error: null } } },
    { rawPayload: entry([comment({ comment_id: `${PAGE}_c2`, parent_id: `${PAGE}_r1` })]) },
  );
  const r = await result;
  assert.equal(r.replied, 0);
  assert.equal(posted.length, 0);
  assert.equal(r.refused['reply_to_self'], 1);
});

test('DONE-TEST: two comments in ONE thread, arriving together, get one reply', async () => {
  // The database would catch the second a moment later. Catching it here means it never
  // becomes a draft row at all.
  const { posted, result } = run({}, {
    rawPayload: entry([
      comment({ comment_id: `${PAGE}_c1` }),
      comment({ comment_id: `${PAGE}_c2`, parent_id: `${PAGE}_c1` }),
    ]),
  });
  const r = await result;
  assert.equal(posted.length, 1);
  assert.equal(r.replied, 1);
  assert.equal(r.refused['thread_already_answered'], 1);
});

test('a thread already answered on a previous delivery is not answered again', async () => {
  const { posted, result } = run({
    outbound: { existing: { data: [{ dedup_key: `${PAGE}_c1`, provider_message_id: 'r_old' }], error: null } },
  });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.equal(r.refused['thread_already_answered'], 1);
});

test('DONE-TEST: A SHADOW CHANNEL DRAFTS AND POSTS NOTHING', async () => {
  // The split this test exists for. `canDeliver('shadow')` answers
  // `{ generate: true, deliver: false }`, and this function used to read only the second
  // half and return before drafting — so a mirroring channel produced counters and no rows.
  // The fourteen days of withheld DM drafts that found D-066's gate-label leak, D-068's
  // discarded booking reply and D-069's «Хаяг» label had no equivalent on the one surface
  // where a mistake is public, permanent and screenshot-able.
  const { posted, ops, result } = run({}, { deliveryMode: 'shadow' });
  const r = await result;

  assert.equal(posted.length, 0, 'nothing reaches the wall');
  assert.equal(r.replied, 0);
  assert.equal(r.drafted, 1, 'and a row exists to read');
  assert.equal(r.refused['not_delivering'], 1);

  const insert = ops.find((o) => o.table === 'outbound_messages' && o.op === 'insert');
  assert.equal(insert?.patch?.['kind'], 'comment_reply');
  assert.equal(insert?.patch?.['body'], LINE, 'the tenant line, decided exactly as it would be live');
  // Never claimed: a claim is the step that puts bytes on the wire, and the row has to
  // stay CLAIMABLE so the day the channel goes live it is sendable rather than lost.
  assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'update'), false);
});

test('DONE-TEST: AN OFF CHANNEL DRAFTS NOTHING EITHER — generate is the other half', async () => {
  // The distinction the split turns on. `shadow` withholds a decision that was made;
  // `off`, `halted` and an unrecognised mode make no decision at all, because generating
  // for a channel that cannot receive it is what `delivery.generate` is false about.
  for (const mode of ['off', 'halted', 'nonsense_mode']) {
    const { posted, ops, result } = run({}, { deliveryMode: mode });
    const r = await result;
    assert.equal(posted.length, 0, mode);
    assert.equal(r.drafted, 0, mode);
    assert.equal(r.refused['not_generating'], 1, mode);
    assert.equal(r.refused['not_delivering'], undefined, mode);
    assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'insert'), false, mode);
  }
});

test('a shadow run still exercises the per-post cap rather than stubbing it', async () => {
  // What the corpus shows has to be what going live would actually have done, or reading it
  // teaches the wrong thing. The cap is counted from our own rows, drafts included, so a
  // post already at its allowance drafts nothing further even while mirroring.
  const { ops, result } = run(
    { outbound: { posts: { data: [{ comment_post_id: `${PAGE}_p1` }], error: null } } },
    { deliveryMode: 'shadow' },
  );
  const r = await result;
  assert.equal(r.drafted, 0);
  assert.equal(r.refused['post_cap_reached'], 1);
  assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'insert'), false);
});

test('no reviewed line means nothing is posted', async () => {
  for (const line of [{ data: null }, { data: { body: LINE, reviewed_at: null } }]) {
    const { posted, result } = run({ tables: { canned_responses: line as Reply } });
    const r = await result;
    assert.equal(posted.length, 0);
    assert.equal(r.refused['no_reviewed_line'], 1);
  }
});

test('an unreadable read is retryable, and posts nothing', async () => {
  for (const over of [
    { tables: { canned_responses: { error: { message: 'reset' } } } },
    { outbound: { existing: { error: { message: 'reset' } } } },
  ]) {
    const { posted, result } = run(over as Parameters<typeof stubFx>[0]);
    const r = await result;
    assert.equal(r.retry, true);
    assert.equal(posted.length, 0);
  }
});

test('the Page commenting on its own post never reaches the decision', async () => {
  const { posted, result } = run({}, {
    rawPayload: entry([comment({ from: { id: PAGE, name: 'Matrix' } })]),
  });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.deepEqual(r.skipped, ['comment_self']);
  assert.deepEqual(r.refused, {}, 'skipped by the extractor, not refused by policy');
});

test('a messaging entry produces no comment work at all', async () => {
  const { posted, ops, result } = run({}, { rawPayload: { id: PAGE, messaging: [{ sender: { id: 'x' } }] } });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.equal(r.replied, 0);
  assert.equal(ops.length, 0, 'not even a read: there is nothing to decide about');
});

// ---------------------------------------------------------------------------
// What each send outcome does
// ---------------------------------------------------------------------------

test('an indeterminate post is parked, never retried — it may already be public', async () => {
  const { ops, result } = run({ send: { outcome: 'indeterminate', detail: 'reply did not complete (timeout)' } });
  const r = await result;
  assert.equal(r.replied, 0);
  assert.equal(r.retry, false, 'a 503 here would post a second identical public reply');
  assert.equal(r.refused['indeterminate'], 1);
  const update = ops.filter((o) => o.op === 'update').map((o) => o.patch?.['state']);
  assert.ok(update.includes('indeterminate'));
});

test('a retryable failure asks for a retry; a terminal one does not', async () => {
  const retryable = run({
    send: { outcome: 'failed', failure: 'rate_limited', retryable: true, code: 613, subcode: null, status: 429, detail: 'graph 429' },
  });
  assert.equal((await retryable.result).retry, true);

  const terminal = run({
    send: { outcome: 'failed', failure: 'token_revoked', retryable: false, code: 190, subcode: null, status: 400, detail: 'graph 400' },
  });
  const t = await terminal.result;
  assert.equal(t.retry, false, 'retrying a 190 bans the app every tenant shares');
  assert.equal(t.refused['send_failed'], 1);
});

test('a sent reply records the provider comment id', async () => {
  const { ops, result } = run();
  await result;
  const sent = ops.find((o) => o.op === 'update' && o.patch?.['state'] === 'sent');
  assert.equal(sent?.patch?.['provider_message_id'], `${PAGE}_c1_r1`);
});

// ---------------------------------------------------------------------------
// The firehose
// ---------------------------------------------------------------------------

test('feed noise is counted, not answered', async () => {
  const { posted, result } = run({}, {
    rawPayload: entry([
      comment({ item: 'post' }),
      comment({ item: 'reaction' }),
      comment({ verb: 'edited' }),
      comment({ is_hidden: true }),
    ]),
  });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.deepEqual(r.skipped, ['not_a_comment', 'not_a_comment', 'not_an_add', 'hidden']);
});

// ---------------------------------------------------------------------------
// The per-post daily cap. The founder's number is 1; the per-thread rule stays inside it.
// ---------------------------------------------------------------------------

test('DONE-TEST: two people, two threads, ONE post, one delivery — one reply', () => {
  // The exact case the per-thread rule cannot catch. Five separate commenters on one post
  // are five threads, so without this they get five identical replies under it. Caught
  // here rather than by the database, so the second never becomes a draft row at all.
  return (async () => {
    const { posted, result } = run({}, {
      rawPayload: entry([
        comment({ comment_id: `${PAGE}_c1`, from: { id: 'customer_1', name: 'А' } }),
        comment({ comment_id: `${PAGE}_c2`, from: { id: 'customer_2', name: 'Б' } }),
        comment({ comment_id: `${PAGE}_c3`, from: { id: 'customer_3', name: 'В' } }),
      ]),
    });
    const r = await result;
    assert.equal(posted.length, 1);
    assert.equal(r.replied, 1);
    assert.equal(r.refused['post_cap_reached'], 2, 'not thread_already_answered — three DIFFERENT threads');
  })();
});

test('a post that already had its reply in the window gets none', async () => {
  const { posted, result } = run({ outbound: { posts: { data: [{ comment_post_id: `${PAGE}_p1` }], error: null } } });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.equal(r.refused['post_cap_reached'], 1);
});

test('DONE-TEST: the cap is per POST, not per delivery — two posts get two replies', async () => {
  const { posted, result } = run({}, {
    rawPayload: entry([
      comment({ comment_id: `${PAGE}_c1`, post_id: `${PAGE}_p1` }),
      comment({ comment_id: `${PAGE}_c2`, post_id: `${PAGE}_p2`, from: { id: 'customer_2', name: 'Б' } }),
    ]),
  });
  const r = await result;
  assert.equal(posted.length, 2);
  assert.equal(r.replied, 2);
  assert.deepEqual(r.refused, {});
});

test('the draft records which post it is under, which is what the count reads', async () => {
  const { ops, result } = run();
  await result;
  const insert = ops.find((o) => o.table === 'outbound_messages' && o.op === 'insert');
  assert.equal(insert?.patch?.['comment_post_id'], `${PAGE}_p1`);
  assert.equal(insert?.patch?.['dedup_key'], `${PAGE}_c1`, 'and the thread is still the dedup key');
});

test('DONE-TEST: the count is a rolling 24-HOUR window, not everything ever posted', async () => {
  // Without the lower bound this reads every reply the tenant has ever made and the cap
  // becomes "one reply per post, forever" — which is a different product decision nobody
  // took, and it silently switches the feature off after the first busy week.
  const { ops, result } = run();
  await result;
  const counter = ops.find((o) => o.table === 'outbound_messages' && (o.cols ?? '').includes('comment_post_id'));
  assert.equal(
    counter?.filters['gte:created_at'],
    new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  );
  assert.deepEqual(counter?.filters['in:comment_post_id'], [`${PAGE}_p1`]);
  assert.equal(counter?.filters['eq:tenant_id'], TENANT, 'never across tenants');
  assert.equal(counter?.filters['eq:kind'], 'comment_reply');
});

test('an unreadable post count is retryable, and posts nothing', async () => {
  const { posted, result } = run({ outbound: { posts: { error: { message: 'reset' } } } });
  const r = await result;
  assert.equal(r.retry, true);
  assert.equal(posted.length, 0);
});

// ---------------------------------------------------------------------------
// A redelivery of a FAILED reply is retried, not silently dropped
// ---------------------------------------------------------------------------

test('DONE-TEST: a redelivery of a row left in `failed` re-claims and sends it', async () => {
  // `markFailed` releases the lease and `CLAIMABLE` includes `failed`, so a retryable
  // send failure is meant to be retried — but the path used to refuse before reaching the
  // claim whenever it had not written the row itself, which turned every `retry: true`
  // on this path into a redelivery that did nothing. The CAS in `claim` already tells the
  // four cases apart, so it decides.
  const { posted, result } = run({
    outbound: {
      insert: { error: { code: '23505', message: 'duplicate key' } },
      reread: { data: { id: 'om-1', body: LINE, state: 'failed', attempts: 1 }, error: null },
      claim: { data: { id: 'om-1', body: LINE, attempts: 1 }, error: null },
    },
  });
  const r = await result;
  assert.equal(r.replied, 1);
  assert.equal(posted[0]?.body, LINE, 'the STORED body, not a regenerated one');
});

test('a redelivery of a row already SENT posts nothing', async () => {
  const { posted, result } = run({
    outbound: {
      insert: { error: { code: '23505', message: 'duplicate key' } },
      reread: { data: { id: 'om-1', body: LINE, state: 'sent', attempts: 1 }, error: null },
      // The CAS matches nothing, and `claim` then reads the state to say why.
      claim: { data: null, error: null },
      state: { data: { state: 'sent' }, error: null },
    },
  });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.equal(r.refused['thread_already_answered'], 1);
});

// ---------------------------------------------------------------------------
// The classifier (D-085)
// ---------------------------------------------------------------------------

test('DONE-TEST: no comment rules REFUSES the job; it does not treat every comment as noise', async () => {
  // Fails CLOSED, and the direction matters. Classifying everything as `ignore` would make
  // "nobody finished configuring this tenant" and "today was quiet" produce identical
  // counters — D-070's rule, applied before the mechanism ships rather than after it fails.
  const { fx, posted } = stubFx({ tables: { comment_rules: { data: [], error: null } } });
  const r = await runCommentJob(fx, baseInput);
  assert.equal(r.retry, true);
  assert.deepEqual(posted, [], 'nothing reaches the wall');
  assert.equal(r.replied, 0);
});

test('an unreadable comment_rules asks for a retry rather than answering unclassified', async () => {
  const { fx, posted } = stubFx({ tables: { comment_rules: { data: null, error: { message: 'boom' } } } });
  const r = await runCommentJob(fx, baseInput);
  assert.equal(r.retry, true);
  assert.deepEqual(posted, []);
});

test('DONE-TEST: a complaint is ESCALATED — nothing is posted and the allowance survives', async () => {
  // «Утсаа авахгүй байна» — *you are not answering the phone* — under the salon's own post.
  // The pinned line says "come to DM", which is a brush-off to a public complaint. And the
  // post's one daily reply must still be there for the question that arrives later, so the
  // refusal must not draft a row.
  const { fx, posted, ops } = stubFx();
  const r = await runCommentJob(fx, {
    ...baseInput,
    rawPayload: entry([comment({ message: 'Утсаа авахгүй байна' })]),
  });
  assert.equal(r.refused['comment_escalated'], 1);
  assert.deepEqual(posted, [], 'a public complaint is never answered with the canned line');
  assert.equal(r.drafted, 0);
  assert.equal(
    ops.filter((o) => o.table === 'outbound_messages' && o.op === 'insert').length, 0,
    'no draft row, so the per-post cap is untouched — an escalation does not spend the allowance',
  );
});

test('recognised noise is silent and writes NO unclassified row', async () => {
  const { fx, posted, ops } = stubFx();
  const r = await runCommentJob(fx, { ...baseInput, rawPayload: entry([comment({ message: 'гоён юм аа' })]) });
  assert.equal(r.refused['comment_not_worth_reply'], 1);
  assert.deepEqual(posted, []);
  assert.equal(ops.filter((o) => o.table === 'quality_flags').length, 0,
    'a rule recognised it, so it is not on the operator’s to-do list');
});

test('DONE-TEST: an unclassified comment is recorded WITHOUT its text', async () => {
  // The shadow phase's only product is this list. It carries the ids and the shape, and
  // not the words: `quality_flags` is not reached by `ops.purge_expired`, so a copy of the
  // customer's text here would outlive the `webhook_events` row it was copied from.
  const { fx, ops } = stubFx();
  const r = await runCommentJob(fx, {
    ...baseInput,
    rawPayload: entry([comment({ message: 'Ямар нэгэн шинэ зүйл' })]),
  });
  assert.equal(r.refused['comment_unclassified'], 1);
  const flag = ops.find((o) => o.table === 'quality_flags' && o.op === 'insert');
  assert.ok(flag, 'the row is written');
  const patch = flag?.patch ?? {};
  assert.equal(patch['flag'], 'comment_unclassified');
  const detail = patch['detail'] as Record<string, unknown>;
  assert.equal(detail['comment_id'], `${PAGE}_c1`);
  assert.equal(detail['chars'], 20);
  assert.equal(detail['has_cyrillic'], true);
  assert.equal(
    JSON.stringify(patch).includes('Ямар нэгэн'), false,
    'the customer’s words are NOT copied into an unpurged table',
  );
});

test('a failure to record an unclassified comment does not fail the job', async () => {
  // The inverse trade from every refusal in eligibility.ts, and deliberate: nothing reads
  // this row, so losing one line of the operator's to-do list must not stop the tenant
  // answering customers. It is logged rather than swallowed.
  const { fx, logs } = stubFx({ tables: { quality_flags: { data: null, error: { message: 'nope' } } } });
  const r = await runCommentJob(fx, { ...baseInput, rawPayload: entry([comment({ message: 'Ямар нэгэн' })]) });
  assert.equal(r.retry, false);
  assert.ok(logs.includes('comment_unclassified_unrecorded'));
});

test('a malformed rule refuses the job rather than silently dropping that rule', async () => {
  // A skipped `escalate` rule is a complaint quietly reclassified as a sales enquiry.
  const { fx, posted } = stubFx({
    tables: { comment_rules: { data: [{ rule_key: 'broken', verdict: 'escalate', matcher: { mode: 'nope' } }], error: null } },
  });
  const r = await runCommentJob(fx, baseInput);
  assert.equal(r.retry, true);
  assert.deepEqual(posted, []);
});

test('only ENABLED rules are loaded', async () => {
  const { fx, ops } = stubFx();
  await runCommentJob(fx, baseInput);
  const read = ops.find((o) => o.table === 'comment_rules');
  assert.ok(read, 'the rules are read');
  assert.equal(read?.filters['eq:enabled'], true, 'a rule nobody switched on must not decide anything');
  assert.equal(read?.filters['eq:tenant_id'], TENANT);
});
