/**
 * Replay stored comment deliveries through the REAL `runCommentJob` (D-122 addendum).
 *
 * The same function the worker calls, over an in-memory table store instead of PostgREST,
 * with Graph answered from facts this platform stored (the post's creation time) or assumed
 * and stated (no person tagged). It is how "what would the shadow have done with the new
 * rules" is answered offline, and how the real threads stay tested.
 *
 * What it is NOT: PostgREST. It evaluates `eq`, `in`, `gte`, `is`, `not … is null`, jsonb
 * `contains` and one unique index the way the database does for the reads the comment path
 * makes, and nothing else — a green replay is not evidence about the transport
 * (`scripts/verify/postgrest.ts` is).
 */
import { runCommentJob, type CommentEffects, type CommentJobInput, type CommentJobResult } from './comments.ts';
import { entryOf, PAGE_ID, POST_CREATED, type StoredComment } from '../comments/realThreads.fixtures.ts';

type Row = Record<string, unknown>;

/** jsonb `@>`: every key of `b` in `a`, every element of an array `b` matched by one of `a`. */
export function jsonContains(a: unknown, b: unknown): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && b.every((x) => a.some((y) => jsonContains(y, x)));
  if (b !== null && typeof b === 'object') {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
    return Object.entries(b as Row).every(([k, v]) => jsonContains((a as Row)[k], v));
  }
  return a === b;
}

export function memoryDb(seed: Record<string, Row[]>, clock: () => Date = () => new Date(0)) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  let seq = 0;
  const rows = (t: string): Row[] => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t) as Row[];
  };
  const from = (table: string) => {
    const preds: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let pending: Row = {};
    const run = (): { data: unknown; error: unknown; list: Row[] } => {
      if (op === 'insert') {
        const row: Row = { id: `row-${++seq}`, attempts: 0, created_at: clock().toISOString(), ...pending };
        if (table === 'outbound_messages' && rows(table).some((r) =>
          r['tenant_id'] === row['tenant_id'] && r['kind'] === row['kind'] && r['dedup_key'] === row['dedup_key'])) {
          return { data: null, error: { code: '23505', message: 'duplicate key' }, list: [] };
        }
        rows(table).push(row);
        return { data: row, error: null, list: [row] };
      }
      const hit = rows(table).filter((r) => preds.every((p) => p(r)));
      if (op === 'update') for (const r of hit) Object.assign(r, pending);
      return { data: hit[0] ?? null, error: null, list: hit };
    };
    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    chain['eq'] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) === String(v)), chain);
    chain['in'] = (c: string, v: unknown[]) => (preds.push((r) => v.map(String).includes(String(r[c]))), chain);
    chain['gte'] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) >= String(v)), chain);
    chain['is'] = (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), chain);
    chain['not'] = (c: string, o: string, v: unknown) => {
      if (o !== 'is' || v !== null) throw new Error(`memoryDb: not.${o} is not modelled`);
      preds.push((r) => (r[c] ?? null) !== null);
      return chain;
    };
    chain['contains'] = (c: string, v: unknown) => (preds.push((r) => jsonContains(r[c], v)), chain);
    chain['order'] = () => chain;
    chain['limit'] = () => chain;
    chain['or'] = () => chain;
    chain['insert'] = (p: Row) => { op = 'insert'; pending = p; return chain; };
    chain['update'] = (p: Row) => { op = 'update'; pending = p; return chain; };
    chain['maybeSingle'] = async () => { const r = run(); return { data: r.data, error: r.error }; };
    chain['then'] = (res: (v: unknown) => unknown) => {
      const r = run();
      return res(op === 'select' ? { data: r.list, error: null } : { data: r.data, error: r.error });
    };
    return chain;
  };
  return { db: { from } as never, rows };
}

export type ReplayRule = { rule_key: string; verdict: string; matcher: unknown };

export type ReplayOutcome = {
  eventId: number;
  /** `drafted` (shadow wrote the rows) or the one refusal the job counted. */
  outcome: string;
  result: CommentJobResult;
};

const TENANT = 'tenant-replay';
const LINE = 'PUBLIC LINE';
const PRIVATE = 'PRIVATE LINE';

/**
 * Decide each customer comment in `decide`, in order, as the shadow worker would.
 *
 * `evidence: 'at_decision'` shows the store only the deliveries received up to that comment
 * — what the worker could have read at the time. `'all'` shows every stored delivery — what
 * the same decision reads now, with every staff reply that has since arrived.
 */
export async function replayComments(input: {
  stored: readonly StoredComment[];
  decide: readonly number[];
  rules: readonly ReplayRule[];
  evidence: 'at_decision' | 'all';
  /** `tenant_channels.automation_texts` for the replayed channel (D-126 addendum). */
  automationTexts?: readonly string[];
}): Promise<ReplayOutcome[]> {
  const events = input.stored.map((c) => ({
    id: c.eventId, tenant_id: TENANT, raw_payload: entryOf(c), received_at: c.receivedAt,
  }));
  const store = memoryDb({
    canned_responses: [
      { tenant_id: TENANT, kind: 'comment_public_reply', locale: 'mn-MN', body: LINE, reviewed_at: '2026-09-25T00:00:00Z' },
      { tenant_id: TENANT, kind: 'comment_private_reply', locale: 'mn-MN', body: PRIVATE, reviewed_at: '2026-09-25T00:00:00Z' },
    ],
    comment_rules: input.rules.map((r) => ({ tenant_id: TENANT, enabled: true, ...r })),
    webhook_events: [],
    outbound_messages: [],
    quality_flags: [],
  }, () => clock);
  let clock = new Date(0);
  const out: ReplayOutcome[] = [];
  for (const eventId of input.decide) {
    const c = input.stored.find((s) => s.eventId === eventId);
    if (c === undefined) throw new Error(`no stored comment ${eventId}`);
    const visible = input.evidence === 'all' ? events : events.filter((e) => e.id <= eventId);
    store.rows('webhook_events').splice(0, Infinity, ...visible);
    const now = new Date(new Date(c.receivedAt).getTime() + 1_000);
    clock = now;
    const fx: CommentEffects = {
      db: store.db,
      now,
      replyToComment: async () => { throw new Error('shadow must not post'); },
      sendPrivateReply: async () => { throw new Error('shadow must not send'); },
      // Graph is not reachable from where this runs: the post's age is our own stored fact,
      // and "no person tagged" is an assumption the caller states.
      lookupComment: async ({ postId }) => ({ tagsPerson: false, postCreatedAt: POST_CREATED[postId] ?? null, problems: [] }),
      alertComplaint: async () => {},
      log: () => {},
    };
    const job: CommentJobInput = {
      tenantId: TENANT,
      channelId: 'channel-replay',
      pageExternalId: PAGE_ID,
      automationTexts: input.automationTexts ?? [],
      commentMode: 'shadow',
      tokenStatus: 'active',
      graphVersion: 'v21.0',
      locale: 'mn-MN',
      // Matrix's channel row as read on 2026-09-25.
      config: { policy: 'both', maxPostAgeDays: 30, ignoreCommenterIds: [], repliesPerPostPerDay: 20 },
      rawPayload: entryOf(c),
    };
    const result = await runCommentJob(fx, job);
    const refusals = Object.entries(result.refused).filter(([k]) => k !== 'not_delivering');
    const outcome = result.retry ? 'retry'
      : result.drafted > 0 ? 'drafted'
      : refusals.map(([k]) => k).join('+') || (result.skipped.join('+') || 'nothing');
    out.push({ eventId, outcome, result });
  }
  return out;
}
