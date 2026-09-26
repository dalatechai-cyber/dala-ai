import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentLink, privateReplyDedupKey, runCommentJob, type CommentEffects, type CommentJobInput, type PrivateReplyOutcome } from './comments.ts';
import type { CommentLookup } from '../comments/lookup.ts';
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
  /** Rows the per-person reader returns: prior replies carrying `comment_from_id` (D-122). */
  persons?: Reply;
  /** The resume path's read of this comment's own row (`id, state`). */
  pending?: Reply;
  /** `draftOnce`'s duplicate path: the row somebody else already wrote. */
  reread?: Reply;
  /** `claim`'s why-did-the-CAS-miss read. */
  state?: Reply;
  /** The draft insert. */
  insert?: Reply;
  /** The claim CAS. */
  claim?: Reply;
};

function stubDb(over: Record<string, Reply | Reply[]> = {}, outbound: OutboundStub = {}) {
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
      if ((rec.cols ?? '').includes('comment_from_id')) return outbound.persons ?? { data: [], error: null };
      if ((rec.cols ?? '').includes('comment_post_id')) return outbound.posts ?? { data: [], error: null };
      if ((rec.cols ?? '').includes('attempts')) return outbound.reread ?? { data: null, error: null };
      if (rec.cols === 'state') return outbound.state ?? { data: null, error: null };
      if (rec.cols === 'id, state' || rec.cols === 'id, state, body') return outbound.pending ?? { data: null, error: null };
      return outbound.existing ?? { data: [], error: null };
    }
    // A LIST answers successive reads in order, the last one sticking — how a test says
    // "the Page had not replied at decision time, and had by the time of the send".
    const o = over[table];
    if (Array.isArray(o)) return (o.length > 1 ? o.shift() : o[0]) ?? { data: null, error: null };
    return o ?? DEFAULTS[table] ?? { data: null, error: null };
  };

  const from = (table: string) => {
    const rec = { table, op: 'select', filters: {} } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    chain['select'] = (cols: string) => {
      rec.cols = cols;
      return chain;
    };
    for (const m of ['eq', 'in', 'is', 'not', 'gte', 'lt', 'contains']) {
      chain[m] = (col: string, val: unknown) => {
        rec.filters[`${m}:${col}`] = val;
        return chain;
      };
    }
    for (const m of ['or', 'limit', 'order']) chain[m] = () => chain;
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
  commentMode: 'live',
  tokenStatus: 'active',
  graphVersion: 'v21.0',
  locale: 'mn-MN',
  config: { policy: 'public_only', maxPostAgeDays: 30, ignoreCommenterIds: [], repliesPerPostPerDay: 1 },
  rawPayload: entry([comment()]),
};

function stubFx(over: {
  tables?: Record<string, Reply | Reply[]>; outbound?: OutboundStub; send?: CommentSendOutcome;
  privateSend?: PrivateReplyOutcome; lookup?: CommentLookup;
} = {}) {
  const { db, ops } = stubDb(over.tables ?? {}, over.outbound ?? {});
  const posted: { commentId: string; body: string; tenantId: string }[] = [];
  const privates: { commentId: string; body: string; pageId: string }[] = [];
  const lookups: string[] = [];
  const complaints: { commentId: string; text: string; link: string }[] = [];
  const logs: string[] = [];
  const fx: CommentEffects = {
    db,
    now: NOW,
    replyToComment: async (a) => {
      posted.push({ commentId: a.commentId, body: a.body, tenantId: a.tenantId });
      return over.send ?? { outcome: 'sent', providerCommentId: `${a.commentId}_r1` };
    },
    sendPrivateReply: async (a) => {
      privates.push({ commentId: a.commentId, body: a.body, pageId: a.pageId });
      return over.privateSend ?? { outcome: 'sent', providerMessageId: `m_${a.commentId}` };
    },
    lookupComment: async (a) => {
      lookups.push(a.commentId);
      return over.lookup ?? { tagsPerson: false, postCreatedAt: new Date(NOW.getTime() - 86_400_000), problems: [] };
    },
    alertComplaint: async (a) => { complaints.push({ commentId: a.commentId, text: a.text, link: a.link }); },
    log: (_l, e) => logs.push(e),
  };
  return { fx, ops, posted, privates, lookups, complaints, logs };
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
      // A DIFFERENT person, or the per-person rule (D-122) would catch it first.
      comment({ comment_id: `${PAGE}_c2`, parent_id: `${PAGE}_c1`, from: { id: 'customer_2', name: 'Сараа' } }),
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
  const { posted, ops, result } = run({}, { commentMode: 'shadow' });
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
    const { posted, ops, result } = run({}, { commentMode: mode });
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
    { commentMode: 'shadow' },
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
  const counter = ops.find((o) => o.table === 'outbound_messages' && o.cols === 'comment_post_id');
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
  assert.ok(logs.includes('comment_flag_unrecorded'));
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

test('DONE-TEST: an ESCALATED comment writes its own durable row', async () => {
  // docs/comments.md promised escalate "writes a flag for the operator" and nothing did —
  // a public complaint refused a reply, incremented a counter, and left no trace anybody
  // could find tomorrow. `meta/extract.ts`'s "everything skipped is reported", one surface
  // over.
  const { fx, posted, ops } = stubFx();
  const r = await runCommentJob(fx, {
    ...baseInput,
    rawPayload: entry([comment({ message: 'Утсаа авахгүй байна' })]),
  });
  assert.equal(r.refused['comment_escalated'], 1);
  assert.deepEqual(posted, []);
  const flag = ops.find((o) => o.table === 'quality_flags' && o.op === 'insert');
  assert.ok(flag, 'the escalation is recorded');
  assert.equal((flag?.patch ?? {})['flag'], 'comment_escalated');
  assert.equal(
    JSON.stringify(flag?.patch ?? {}).includes('Утсаа'), false,
    'ids and shape, never the words — quality_flags is not reached by the purge',
  );
});

test('DONE-TEST: a refusal BEFORE the verdict writes no row at all', async () => {
  // The ordering that makes the to-do list readable. `decideCommentReply` refuses on
  // policy, self-reply, the ignore list and age before it looks at the verdict, so writing
  // beside the classifier put a staff member's own comment — and spam under a four-year-old
  // post — onto the operator's list as work.
  const { fx, ops } = stubFx();
  const r = await runCommentJob(fx, {
    ...baseInput,
    config: { ...baseInput.config, ignoreCommenterIds: ['customer_1'] },
    rawPayload: entry([comment({ message: 'Ямар нэгэн шинэ зүйл' })]),
  });
  assert.equal(r.refused['commenter_ignored'], 1);
  assert.equal(ops.filter((o) => o.table === 'quality_flags').length, 0);
});

test('DONE-TEST: the per-post cap counts only rows that are or may be public', async () => {
  // A `failed` row proves a reply was NOT posted. With a cap of one it silenced the post
  // for 24 hours, so a single transient Graph error cost the salon every public answer on
  // that post for a day — and the counter that hid it read as the cap working.
  const { fx, ops } = stubFx();
  await runCommentJob(fx, baseInput);
  const counter = ops.find((o) => o.table === 'outbound_messages' && (o.cols ?? '').includes('comment_post_id'));
  assert.ok(counter, 'the per-post counter runs');
  assert.deepEqual(
    counter?.filters['in:state'],
    ['draft', 'claiming', 'sending', 'sent', 'indeterminate'],
    'failed and refused prove nothing was posted and must not consume the allowance',
  );
});

// The cap's own reasoning says the operator answers "is a cap of 1 costing me customers?"
// by counting `post_cap_reached` — and until now there was nothing to count. Matrix's
// rehearsal on 2026-09-20 spent one post's daily allowance on our own test comment and then
// capped the only real answerable customer comment of the night, «Яармаг хаяг хаана вэ»,
// leaving no trace anywhere in the database.
test('a capped comment writes a durable row carrying the count and the cap', async () => {
  const { ops, result } = run(
    { outbound: { posts: { data: [{ comment_post_id: `${PAGE}_p1` }], error: null } } },
  );
  const r = await result;
  assert.equal(r.refused['post_cap_reached'], 1);
  const flag = ops.find((o) => o.table === 'quality_flags' && o.op === 'insert');
  assert.ok(flag, 'the cap must leave a row, not only a counter and a log line');
  const patch = flag?.patch ?? {};
  const detail = patch['detail'] as Record<string, unknown>;
  assert.equal(patch['flag'], 'comment_post_cap_reached');
  assert.equal(detail['replies_in_window'], 1);
  assert.equal(detail['cap'], 1);
  // Ids and shape, never the words — quality_flags is not reached by ops.purge_expired.
  assert.deepEqual(
    Object.keys(detail).sort(),
    ['cap', 'chars', 'comment_id', 'has_cyrillic', 'post_id', 'replies_in_window'],
  );
});

// The line is drawn at "a reply was wanted and lost". A second comment in a thread that
// already has its reply loses nothing, so it stays a counter.
test('thread_already_answered stays a counter and writes no row', async () => {
  const { ops, result } = run(
    { outbound: { existing: { data: [{ dedup_key: `${PAGE}_c1`, provider_message_id: 'r_old' }], error: null } } },
  );
  const r = await result;
  assert.equal(r.refused['thread_already_answered'], 1, 'the case under test actually fired');
  assert.equal(ops.filter((o) => o.table === 'quality_flags').length, 0);
});

// ---------------------------------------------------------------------------
// D-122: the comment switch, both lines, one per person, tags, post age, complaints
// ---------------------------------------------------------------------------

const BOTH = { ...baseInput.config, policy: 'both' };
const PRIVATE_LINE = 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.';
const withPrivateLine: Record<string, Reply> = {
  // The stub answers every canned read with one row; a real read is per kind. Good enough
  // to prove both are required; the kinds themselves are asserted from the ops.
  canned_responses: { data: { body: LINE, reviewed_at: '2026-09-25T00:00:00Z' }, error: null },
};

test('D-122: policy both, live — the public line AND the private message go, each once', async () => {
  const { posted, privates, ops, result } = run({ tables: withPrivateLine }, { config: BOTH });
  const r = await result;
  assert.equal(r.replied, 1);
  assert.equal(r.privateSent, 1);
  assert.equal(posted.length, 1);
  assert.equal(privates.length, 1);
  assert.equal(privates[0]?.commentId, `${PAGE}_c1`, 'the private reply is addressed by COMMENT');
  assert.equal(privates[0]?.pageId, PAGE, 'on the explicit Page, never /me');
  const inserts = ops.filter((o) => o.table === 'outbound_messages' && o.op === 'insert');
  assert.deepEqual(inserts.map((i) => i.patch?.['kind']), ['comment_reply', 'private_reply']);
  assert.equal(inserts[1]?.patch?.['dedup_key'], privateReplyDedupKey(`${PAGE}_p1`, 'customer_1'));
  for (const i of inserts) {
    assert.equal(i.patch?.['comment_from_id'], 'customer_1', 'who it answers, so the person rule can count it');
    assert.equal(i.patch?.['comment_post_id'], `${PAGE}_p1`);
  }
  // Both canned kinds were read.
  const kinds = ops.filter((o) => o.table === 'canned_responses').map((o) => o.filters['eq:kind']);
  assert.deepEqual(kinds.sort(), ['comment_private_reply', 'comment_public_reply']);
});

test('D-122: comments in SHADOW draft both rows and send nothing, while the lookup still runs', async () => {
  const { posted, privates, lookups, ops, result } = run({ tables: withPrivateLine }, { config: BOTH, commentMode: 'shadow' });
  const r = await result;
  assert.equal(posted.length + privates.length, 0, 'nothing leaves');
  assert.equal(r.drafted, 1);
  assert.equal(r.privateDrafted, 1);
  assert.equal(lookups.length, 1, 'shadow exercises the tag and post-age read, so it is measured before live');
  assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'update'), false, 'never claimed');
});

test('D-122: the comment switch is independent of the DM switch, and live needs an active token', async () => {
  // The job no longer reads the DM mode at all; a DM-live channel with comments off is off.
  const off = await run({}, { commentMode: 'off' }).result;
  assert.equal(off.refused['not_generating'], 1);
  for (const tokenStatus of ['revoked', 'error', '']) {
    const { posted, result } = run({}, { commentMode: 'live', tokenStatus });
    const r = await result;
    assert.equal(posted.length, 0, tokenStatus);
    assert.equal(r.refused['not_generating'], 1, tokenStatus);
  }
});

test('D-122: a comment that tags a PERSON gets nothing, even when it asks a price', async () => {
  const { posted, privates, ops, result } = run(
    { tables: withPrivateLine, lookup: { tagsPerson: true, postCreatedAt: NOW, problems: [] } },
    { config: BOTH },
  );
  const r = await result;
  assert.equal(posted.length + privates.length, 0);
  assert.equal(r.refused['comment_tags_person'], 1);
  assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'insert'), false, 'not even a draft');
});

test('D-122: an unreadable lookup refuses; a post older than the window refuses', async () => {
  const unknown = await run({ lookup: { tagsPerson: null, postCreatedAt: null, problems: ['graph 500'] } }).result;
  assert.equal(unknown.refused['comment_lookup_unknown'], 1);
  assert.equal(unknown.replied, 0);
  const old = await run({ lookup: { tagsPerson: false, postCreatedAt: new Date('2022-01-01T00:00:00Z'), problems: [] } }).result;
  assert.equal(old.refused['post_too_old'], 1);
  assert.equal(old.replied, 0);
});

test('D-122: praise costs no Graph read — the lookup is only for a comment worth answering', async () => {
  const { lookups, result } = run({}, { rawPayload: entry([comment({ message: 'Ямар гоёнуу баярлалаа' })]) });
  const r = await result;
  assert.equal(lookups.length, 0);
  assert.equal(r.refused['comment_not_worth_reply'], 1);
});

test('D-122: one reply per person per post — a second comment by the same person, same entry', async () => {
  const { posted, result } = run({}, {
    rawPayload: entry([
      comment({ comment_id: `${PAGE}_c1` }),
      comment({ comment_id: `${PAGE}_c7`, message: 'Хэдэн төгрөг вэ?' }),
    ]),
    config: { ...baseInput.config, repliesPerPostPerDay: 10 },
  });
  const r = await result;
  assert.equal(posted.length, 1);
  assert.equal(r.refused['person_already_answered'], 1);
});

test('D-122: one reply per person per post — answered on an earlier delivery', async () => {
  const { posted, result } = run({
    outbound: { persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null } },
  });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.equal(r.refused['person_already_answered'], 1);
});

test('D-122: the same person on a DIFFERENT post is answered', async () => {
  const { posted, result } = run({
    outbound: { persons: { data: [{ comment_post_id: `${PAGE}_p9`, comment_from_id: 'customer_1' }], error: null } },
  });
  await result;
  assert.equal(posted.length, 1);
});

test('D-122: a complaint posts nothing and alerts the founder with the link — in shadow too', async () => {
  for (const commentMode of ['live', 'shadow']) {
    const { posted, complaints, lookups, result } = run({}, {
      commentMode,
      rawPayload: entry([comment({
        message: 'Утсаа авахгүй юм аа',
        post: { permalink_url: 'https://www.facebook.com/reel/111/' },
      })]),
    });
    const r = await result;
    assert.equal(posted.length, 0, commentMode);
    assert.equal(r.refused['comment_escalated'], 1, commentMode);
    assert.equal(complaints.length, 1, commentMode);
    assert.equal(complaints[0]?.link, 'https://www.facebook.com/reel/111/?comment_id=c1', commentMode);
    assert.equal(complaints[0]?.text, 'Утсаа авахгүй юм аа');
    assert.equal(lookups.length, 0, 'no Graph read for a comment nobody will answer');
  }
});

test('D-122: a failing complaint alert never fails the job', async () => {
  const s = stubFx();
  s.fx.alertComplaint = async () => { throw new Error('telegram down'); };
  const r = await runCommentJob(s.fx, { ...baseInput, rawPayload: entry([comment({ message: 'Утсаа авахгүй' })]) });
  assert.equal(r.retry, false);
  assert.ok(s.logs.includes('comment_complaint_alert_failed'));
});

test('D-122: the complaint link — permalink when Meta sent one, the post id otherwise', () => {
  assert.equal(
    commentLink({ commentId: '139_174', postId: '152_139', postPermalink: null }),
    'https://www.facebook.com/152_139?comment_id=174',
  );
  assert.equal(
    commentLink({ commentId: '139_174', postId: '152_139', postPermalink: 'https://www.facebook.com/x?y=1' }),
    'https://www.facebook.com/x?y=1&comment_id=174',
  );
});

test('D-122: a retryable private-reply failure retries the job; a public success is not re-sent', async () => {
  const { posted, result } = run(
    { tables: withPrivateLine, privateSend: { outcome: 'failed', retryable: true, failure: 'rate_limited', detail: '613' } },
    { config: BOTH },
  );
  const r = await result;
  assert.equal(r.retry, true);
  assert.equal(r.replied, 1, 'the public line went out and is marked sent');
  assert.equal(posted.length, 1);
});

test('D-122: an indeterminate private reply is parked, never retried', async () => {
  const { result } = run(
    { tables: withPrivateLine, privateSend: { outcome: 'indeterminate', detail: 'timeout' } },
    { config: BOTH },
  );
  const r = await result;
  assert.equal(r.retry, false);
  assert.equal(r.refused['private_indeterminate'], 1);
});

test('D-122: a retried job FINISHES what it started — a pending private message is sent, a sent line is not', async () => {
  // The case "a row exists" hid: the public line went out, the private message failed and
  // the job 503'd. On the redelivery the person reads as answered. Without the resume step
  // the private message was never sent.
  const { posted, privates, result } = run({
    tables: withPrivateLine,
    outbound: {
      persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null },
      pending: { data: { id: 'om-9', state: 'failed' }, error: null },
    },
  }, { config: BOTH });
  const r = await result;
  assert.equal(r.refused['person_already_answered'], 1);
  assert.equal(privates.length, 1, 'the private message waiting in `failed` goes out');
  assert.equal(r.privateSent, 1);
  // The stub answers both kinds with the same pending row, so the public one is resumed too;
  // a `sent` row would read as not pending — asserted next.
  assert.equal(posted.length, 1);
});

test('D-122: nothing is resumed when the rows were sent, or when comments are in shadow', async () => {
  const sent = await run({
    tables: withPrivateLine,
    outbound: {
      persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null },
      pending: { data: { id: 'om-9', state: 'sent' }, error: null },
    },
  }, { config: BOTH });
  const r1 = await sent.result;
  assert.equal(sent.posted.length + sent.privates.length, 0);
  assert.equal(r1.replied + r1.privateSent, 0);
  const shadow = run({
    tables: withPrivateLine,
    outbound: {
      persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null },
      pending: { data: { id: 'om-9', state: 'failed' }, error: null },
    },
  }, { config: BOTH, commentMode: 'shadow' });
  await shadow.result;
  assert.equal(shadow.posted.length + shadow.privates.length, 0, 'shadow never sends, resumed or not');
});

test('D-122: a resumed reply still passes the tag check for the comment in hand', async () => {
  const { posted, privates, result } = run({
    tables: withPrivateLine,
    lookup: { tagsPerson: true, postCreatedAt: NOW, problems: [] },
    outbound: {
      persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null },
      pending: { data: { id: 'om-9', state: 'draft' }, error: null },
    },
  }, { config: BOTH });
  const r = await result;
  assert.equal(posted.length + privates.length, 0);
  assert.equal(r.refused['comment_tags_person'], 1);
});

// ---------------------------------------------------------------------------
// The salon's staff already answered (D-122 addendum)
// ---------------------------------------------------------------------------

/** A stored webhook row carrying one comment by the PAGE itself. */
const pageRow = (over: Record<string, unknown>) => ({
  raw_payload: entry([comment({ from: { id: PAGE, name: 'Salon' }, comment_id: `${PAGE}_s1`, ...over })]),
});
const staffReplied = { data: [pageRow({ parent_id: `${PAGE}_c1`, message: 'Мэдээлэл 📍 Яармаг' })], error: null };
const staffTagged = { data: [pageRow({ comment_id: `${PAGE}_s2`, parent_id: `${PAGE}_c7`, message: 'Сараа Бат Болормаа 📍 Яармаг' })], error: null };
const nobody = { data: [], error: null };

test('DONE-TEST: the Page replied under the comment — no draft, its own counter, a flag with the proof', async () => {
  const { ops, lookups, result } = run({ tables: { ...withPrivateLine, webhook_events: staffReplied } }, { config: BOTH, commentMode: 'shadow' });
  const r = await result;
  assert.equal(r.refused['staff_replied'], 1);
  assert.equal(r.drafted + r.privateDrafted, 0);
  assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'insert'), false, 'nothing drafted');
  assert.equal(lookups.length, 0, 'no Graph read for a comment staff already answered');
  const flag = ops.find((o) => o.table === 'quality_flags' && o.op === 'insert');
  assert.equal(flag?.patch?.['flag'], 'comment_staff_answered');
  const detail = flag?.patch?.['detail'] as Record<string, unknown>;
  assert.equal(detail['how'], 'replied');
  assert.equal(detail['staff_comment_id'], `${PAGE}_s1`);
  assert.equal(detail['at'], 'decision');
  assert.equal(JSON.stringify(detail).includes('Болормаа'), false, 'ids only — never the name');
  // The read: this tenant, stored payloads only, the Page's comments on THIS post.
  const read = ops.find((o) => o.table === 'webhook_events');
  assert.equal(read?.filters['eq:tenant_id'], TENANT);
  assert.deepEqual(read?.filters['contains:raw_payload'], {
    changes: [{ value: { item: 'comment', post_id: `${PAGE}_p1`, from: { id: PAGE } } }],
  });
});

test('DONE-TEST: the Page tagged this commenter under another comment on the post — refused', async () => {
  const { result } = run({ tables: { webhook_events: staffTagged } }, { commentMode: 'shadow' });
  const r = await result;
  assert.equal(r.refused['staff_tagged_commenter'], 1);
  assert.equal(r.drafted, 0);
});

test('the Page naming SOMEONE ELSE on the post does not silence this commenter', async () => {
  const other = { data: [pageRow({ parent_id: `${PAGE}_c7`, message: 'Сараа Бат баярлалаа💕' })], error: null };
  const { result } = run({ tables: { webhook_events: other } }, { commentMode: 'shadow' });
  const r = await result;
  assert.equal(r.drafted, 1);
});

test('our OWN posted reply is a Page comment too, and is not counted as staff', async () => {
  const { result } = run({
    tables: { webhook_events: staffReplied },
    outbound: { existing: { data: [{ provider_message_id: `${PAGE}_s1` }], error: null } },
  }, { commentMode: 'shadow' });
  const r = await result;
  assert.equal(r.refused['staff_replied'], undefined);
});

test('an unreadable staff read is retryable, and drafts nothing', async () => {
  const { ops, result } = run({ tables: { webhook_events: { data: null, error: { message: 'boom' } } } }, { commentMode: 'shadow' });
  const r = await result;
  assert.equal(r.retry, true);
  assert.equal(ops.some((o) => o.table === 'outbound_messages' && o.op === 'insert'), false);
});

test('DONE-TEST: LIVE — staff answered between the decision and the send: re-checked, nothing posted, rows refused', async () => {
  // First read (decision): nobody. Second read (after the claim, before the Graph call):
  // the Page's reply has arrived.
  const { posted, privates, ops, result } = run({
    tables: { ...withPrivateLine, webhook_events: [nobody, staffReplied] },
  }, { config: BOTH });
  const r = await result;
  assert.equal(posted.length + privates.length, 0, 'neither line leaves');
  assert.equal(r.replied + r.privateSent, 0);
  assert.equal(r.refused['staff_replied'], 1, 'counted once for the comment, not once per line');
  const refusedRows = ops.filter((o) => o.table === 'outbound_messages' && o.op === 'update' && o.patch?.['state'] === 'refused');
  assert.equal(refusedRows.length, 2, 'both claimed rows parked as refused, so no later resume can send them');
  const reads = ops.filter((o) => o.table === 'webhook_events');
  assert.equal(reads.length, 2, 'one read at decision, ONE before the sends — memoised across the two lines');
  const flags = ops.filter((o) => o.table === 'quality_flags' && o.op === 'insert');
  assert.equal(flags.length, 1);
  assert.equal((flags[0]?.patch?.['detail'] as Record<string, unknown>)['at'], 'before_send');
});

test('LIVE — the re-check itself unreadable: nothing posted, the row handed back as failed, and a retry', async () => {
  const { posted, ops, result } = run({
    tables: { webhook_events: [nobody, { data: null, error: { message: 'boom' } }] },
  });
  const r = await result;
  assert.equal(posted.length, 0);
  assert.equal(r.retry, true);
  const failed = ops.find((o) => o.table === 'outbound_messages' && o.op === 'update' && o.patch?.['state'] === 'failed');
  assert.ok(failed, 'released as failed, claimable by the retry');
});

test('LIVE — a clear re-check sends as before', async () => {
  const { posted, result } = run({ tables: { webhook_events: [nobody, nobody] } });
  const r = await result;
  assert.equal(r.replied, 1);
  assert.equal(posted.length, 1);
});

test('DONE-TEST: a RESUMED draft is re-checked — a staff tag since the draft stops it', async () => {
  // The case the re-check exists for: a row drafted before the staff answered, found
  // pending when the same person comments again. At decision time the new comment's staff
  // check is clear (the tag is not on the post yet when first read); before the send it is.
  const { posted, privates, result } = run({
    tables: { ...withPrivateLine, webhook_events: [nobody, staffTagged] },
    outbound: {
      persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null },
      pending: { data: { id: 'om-9', state: 'draft' }, error: null },
    },
  }, { config: BOTH });
  const r = await result;
  assert.equal(r.refused['person_already_answered'], 1);
  assert.equal(posted.length + privates.length, 0, 'the stale draft is not posted under the staff answer');
  assert.equal(r.refused['staff_tagged_commenter'], 1);
});

// ---------------------------------------------------------------------------
// D-144: the «comment 1» call to action — a rule with its own pair of lines
// ---------------------------------------------------------------------------

const CTA_PUBLIC = 'Сайн байна уу! Дэлгэрэнгүй мэдээллийг чатаар илгээлээ 😊';
const CTA_PRIVATE = 'Сайн байна уу! Би DalaTech-ийн AI туслах Дали байна. Энэ чатаар надаас хүссэн зүйлээ асуугаарай — үнэ, үйлчилгээ, үнэгүй демо, бүгдийг тайлбарлая.';
const GENERAL_PUBLIC = 'Сайн байна уу! Мессеж бичээрэй, манай AI туслах шууд хариулна.';
const GENERAL_PRIVATE = 'Сайн байна уу! Би DalaTech-ийн AI туслах Дали байна. Хүссэн зүйлээ асуугаарай.';
const REVIEWED = '2026-09-26T00:00:00Z';
/** Fresh per test: the stub consumes a list as it answers. */
const ctaTables = (): Record<string, Reply | Reply[]> => ({
  comment_rules: {
    data: [...RULE_ROWS, {
      rule_key: 'cta_one', verdict: 'reply', matcher: { mode: 'whole_message', phrases: ['1', '1️⃣'] },
      public_kind: 'comment_cta_public_reply', private_kind: 'comment_cta_private_reply',
    }],
    error: null,
  },
  // Read in this order: the general public and private lines, then the rule's pair.
  canned_responses: [
    { data: { body: GENERAL_PUBLIC, reviewed_at: REVIEWED }, error: null },
    { data: { body: GENERAL_PRIVATE, reviewed_at: REVIEWED }, error: null },
    { data: { body: CTA_PUBLIC, reviewed_at: REVIEWED }, error: null },
    { data: { body: CTA_PRIVATE, reviewed_at: REVIEWED }, error: null },
  ],
});
const ONE = entry([comment({ message: '1 👍' })]);
const drafts = (ops: { table: string; op: string; patch?: Record<string, unknown> }[]) =>
  ops.filter((o) => o.table === 'outbound_messages' && o.op === 'insert').map((o) => [o.patch?.['kind'], o.patch?.['body']]);

/** Which send happened first: the harness records each effect into one shared sequence. */
function ordered(over: Parameters<typeof stubFx>[0], input: Partial<CommentJobInput>) {
  const s = stubFx(over);
  const seq: string[] = [];
  const pub = s.fx.replyToComment;
  const priv = s.fx.sendPrivateReply;
  s.fx.replyToComment = async (a) => { seq.push('public'); return pub(a); };
  s.fx.sendPrivateReply = async (a) => { seq.push('private'); return priv(a); };
  return { ...s, seq, result: runCommentJob(s.fx, { ...baseInput, ...input }) };
}

test('DONE-TEST: «1» GETS THE CALL-TO-ACTION PAIR — THE CHAT FIRST, THEN THE PUBLIC LINE THAT SAYS SO', async () => {
  const { ops, seq, result } = ordered({ tables: ctaTables() }, { config: BOTH, rawPayload: ONE });
  const r = await result;
  assert.deepEqual(drafts(ops), [['comment_reply', CTA_PUBLIC], ['private_reply', CTA_PRIVATE]]);
  assert.deepEqual(seq, ['private', 'public'], 'the public line claims the chat was sent, so the chat goes first');
  assert.equal(r.privateSent, 1);
  assert.equal(r.replied, 1);
});

test('DONE-TEST: IF META REFUSES THE CHAT, THE PUBLIC LINE DOES NOT CLAIM IT WAS SENT', async () => {
  const { ops, seq, result } = ordered({
    tables: ctaTables(),
    privateSend: { outcome: 'failed', failure: 'unknown', retryable: false, detail: 'graph 400 code=10900' },
    outbound: { state: { data: { state: 'failed' }, error: null } },
  }, { config: BOTH, rawPayload: ONE });
  const r = await result;
  const rewrite = ops.find((o) => o.table === 'outbound_messages' && o.op === 'update' && o.patch?.['body'] !== undefined);
  assert.equal(rewrite?.patch?.['body'], GENERAL_PUBLIC, 'rewritten to the line that invites a message');
  assert.deepEqual(seq, ['private', 'public']);
  assert.equal(r.refused['private_not_delivered'], 1);
});

test('the same person commenting «1» again on the same post gets nothing new', async () => {
  const { posted, privates, result } = run({
    tables: ctaTables(),
    outbound: { persons: { data: [{ comment_post_id: `${PAGE}_p1`, comment_from_id: 'customer_1' }], error: null } },
  }, { config: BOTH, rawPayload: ONE });
  const r = await result;
  assert.equal(posted.length + privates.length, 0);
  assert.equal(r.refused['person_already_answered'], 1);
});

test('a post at its daily public cap still sends the chat to a «1», and posts nothing public', async () => {
  const { ops, posted, privates, result } = run({
    tables: ctaTables(),
    outbound: { posts: { data: [{ comment_post_id: `${PAGE}_p1` }], error: null } },
  }, { config: { ...BOTH, repliesPerPostPerDay: 1 }, rawPayload: ONE });
  await result;
  assert.deepEqual(drafts(ops), [['private_reply', CTA_PRIVATE]]);
  assert.equal(privates.length, 1);
  assert.equal(posted.length, 0);
});

test('a question gets today\'s handling — the general lines, public first — even on the same post', async () => {
  const { ops, seq, result } = ordered({ tables: ctaTables() }, {
    config: BOTH, rawPayload: entry([comment({ message: 'Үнэ хэд вэ?' })]),
  });
  await result;
  assert.deepEqual(drafts(ops), [['comment_reply', GENERAL_PUBLIC], ['private_reply', GENERAL_PRIVATE]]);
  assert.deepEqual(seq, ['public', 'private']);
});

test('a channel that sends no private message never posts the line claiming one was sent', async () => {
  const { ops, result } = run({ tables: ctaTables() }, { config: baseInput.config, rawPayload: ONE });
  await result;
  assert.deepEqual(drafts(ops), [['comment_reply', GENERAL_PUBLIC]]);
});

test('our own «1» (the Page commenting) never triggers it', async () => {
  const { posted, privates, result } = run({ tables: ctaTables() }, {
    config: BOTH, rawPayload: entry([comment({ message: '1', from: { id: PAGE, name: 'DalaTech' } })]),
  });
  const r = await result;
  assert.equal(posted.length + privates.length, 0);
  assert.deepEqual(r.skipped, ['comment_self']);
});

test('a retried «1» still sends the chat before the public line that claims it', async () => {
  // The chat failed retryably and the job 503'd; on the redelivery both rows are pending.
  const { seq, result } = ordered({
    tables: ctaTables(),
    outbound: {
      existing: { data: [{ provider_message_id: null, dedup_key: `${PAGE}_c1` }], error: null },
      pending: { data: { id: 'om-9', state: 'failed', body: CTA_PUBLIC }, error: null },
      state: { data: { state: 'sent' }, error: null },
    },
  }, { config: BOTH, rawPayload: ONE });
  const r = await result;
  assert.equal(r.refused['thread_already_answered'], 1);
  assert.deepEqual(seq, ['private', 'public']);
});

// ---------------------------------------------------------------------------
// D-145: «comment 1» on Instagram
// ---------------------------------------------------------------------------

const IG_ACCOUNT = '17841417491117031';
const igComment = (text: string, from = 'igsid_1', id = 'igc_1') =>
  ({ id: IG_ACCOUNT, time: Math.floor(NOW.getTime() / 1000) - 60, changes: [{ field: 'comments', value: { id, text, from: { id: from, username: 'bold' }, media: { id: 'igm_1' } } }] });
const IG_INPUT: Partial<CommentJobInput> = {
  config: BOTH, provider: 'instagram', selfId: IG_ACCOUNT, pageExternalId: PAGE, tokenChannelId: 'c-page', ruleKeys: ['cta_one'],
};

/** The effects' arguments, as sent: which edge, which Page, whose token. */
function captured(over: Parameters<typeof stubFx>[0], input: Partial<CommentJobInput>) {
  const s = stubFx(over);
  const calls: Record<string, unknown>[] = [];
  const seq: string[] = [];
  const pub = s.fx.replyToComment;
  const priv = s.fx.sendPrivateReply;
  const look = s.fx.lookupComment;
  s.fx.replyToComment = async (a) => { seq.push('public'); calls.push({ fn: 'public', ...a }); return pub(a); };
  s.fx.sendPrivateReply = async (a) => { seq.push('private'); calls.push({ fn: 'private', ...a }); return priv(a); };
  s.fx.lookupComment = async (a) => { calls.push({ fn: 'lookup', ...a }); return look(a); };
  return { ...s, calls, seq, result: runCommentJob(s.fx, { ...baseInput, ...input }) };
}

test('DONE-TEST: «1» UNDER AN INSTAGRAM POST GETS THE SAME PAIR, CHAT FIRST, THROUGH THE PAGE', async () => {
  const { ops, calls, seq, result } = captured({ tables: ctaTables() }, { ...IG_INPUT, rawPayload: igComment('1 👍') });
  const r = await result;
  assert.deepEqual(drafts(ops), [['comment_reply', CTA_PUBLIC], ['private_reply', CTA_PRIVATE]]);
  assert.deepEqual(seq, ['private', 'public']);
  assert.equal(r.privateSent, 1);
  assert.equal(r.replied, 1);
  const pub = calls.find((c) => c['fn'] === 'public');
  const priv = calls.find((c) => c['fn'] === 'private');
  const look = calls.find((c) => c['fn'] === 'lookup');
  assert.equal(pub?.['provider'], 'instagram', 'answered at /replies');
  assert.equal(pub?.['tokenChannelId'], 'c-page');
  assert.equal(priv?.['pageId'], PAGE, 'the private reply is a Page send');
  assert.equal(priv?.['commentId'], 'igc_1');
  assert.equal(priv?.['tokenChannelId'], 'c-page');
  assert.equal(look?.['provider'], 'instagram');
  assert.equal(look?.['text'], '1 👍');
});

test('a real question on Instagram gets nothing new: silent and recorded, no model, no send', async () => {
  const { posted, privates, ops, result } = run({ tables: ctaTables() }, { ...IG_INPUT, rawPayload: igComment('Үнэ хэд вэ?') });
  const r = await result;
  assert.equal(posted.length + privates.length, 0);
  assert.equal(r.refused['comment_unclassified'], 1);
  assert.ok(ops.some((o) => o.table === 'quality_flags' && o.op === 'insert'), 'on the to-do list');
});

test('our own Instagram comment never triggers it', async () => {
  const { posted, privates, result } = run({ tables: ctaTables() }, { ...IG_INPUT, rawPayload: igComment('1', IG_ACCOUNT) });
  const r = await result;
  assert.equal(posted.length + privates.length, 0);
  assert.deepEqual(r.skipped, ['comment_self']);
});

test('DONE-TEST: IN SHADOW ONLY THE LISTED TESTER IS ANSWERED ON INSTAGRAM', async () => {
  const tester = run({ tables: ctaTables() }, { ...IG_INPUT, commentMode: 'shadow', testSenderIds: ['igsid_1'], rawPayload: igComment('1') });
  const t = await tester.result;
  assert.equal(t.privateSent, 1);
  assert.equal(t.replied, 1);
  const stranger = run({ tables: ctaTables() }, { ...IG_INPUT, commentMode: 'shadow', testSenderIds: ['someone_else'], rawPayload: igComment('1') });
  const s = await stranger.result;
  assert.equal(stranger.posted.length + stranger.privates.length, 0);
  assert.equal(s.drafted, 1);
  assert.equal(s.privateDrafted, 1);
  // Off answers nobody, testers included.
  const off = run({ tables: ctaTables() }, { ...IG_INPUT, commentMode: 'off', testSenderIds: ['igsid_1'], rawPayload: igComment('1') });
  await off.result;
  assert.equal(off.posted.length + off.privates.length, 0);
});

test('an allow-list naming no live rule is reported once, never retried', async () => {
  const { posted, privates, logs, result } = run({ tables: ctaTables() }, { ...IG_INPUT, ruleKeys: ['no_such_rule'], rawPayload: igComment('1') });
  const r = await result;
  assert.equal(r.retry, false);
  assert.equal(posted.length + privates.length, 0);
  assert.ok(logs.includes('comment_rule_keys_match_nothing'));
});

test('Facebook is unchanged by the allow-list column being absent: every rule still reads', async () => {
  const { ops, result } = run({ tables: ctaTables() }, { config: BOTH, rawPayload: entry([comment({ message: 'Үнэ хэд вэ?' })]) });
  await result;
  assert.deepEqual(drafts(ops), [['comment_reply', GENERAL_PUBLIC], ['private_reply', GENERAL_PRIVATE]]);
});
