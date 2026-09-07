import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPurgeJob, type PurgeEffects } from './purge.ts';

process.env['ALERTS_ENABLED'] = 'false';

const NOW = new Date('2026-09-07T03:00:00Z');

type RpcAnswer = { data?: unknown; error?: unknown };

function effects(rpc: RpcAnswer, verified = true): {
  fx: PurgeEffects; calls: { name: string; args: unknown }[]; alerts: Record<string, unknown>[];
} {
  const calls: { name: string; args: unknown }[] = [];
  const alerts: Record<string, unknown>[] = [];

  // A FRESH chain per `.from()`, with a flag the insert sets.
  //
  // `raiseAlert` reads before it writes — `alreadyRaised` does select/eq/limit/maybeSingle,
  // and only then does `claim` insert. A shared stub whose `maybeSingle` always returns a
  // row therefore answers "this alert already exists" and the insert never happens, which
  // is a stub bug that reads exactly like the code declining to alert. So the flag is the
  // point: a select answers null (nothing raised yet), an insert answers a row (it won).
  const chainFor = (table: string) => {
    let inserted = false;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'limit', 'order', 'update']) chain[m] = () => chain;
    chain['insert'] = (row: Record<string, unknown>) => {
      inserted = true;
      if (table === 'alerts') alerts.push(row);
      return chain;
    };
    const answer = () => ({ data: inserted ? { id: 1 } : null, error: null });
    chain['maybeSingle'] = async () => answer();
    chain['then'] = (res: (v: unknown) => unknown) => res(answer());
    return chain;
  };

  const db = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { data: rpc.data ?? null, error: rpc.error ?? null };
    },
    from: (table: string) => chainFor(table),
  };
  return {
    fx: { db: db as never, now: NOW, verifySignature: async () => verified },
    calls, alerts,
  };
}

const ok = { payloads_purged: 4, rows_deleted: 2, bodies_redacted: 3, ceiling_hit: false, max_rows: 50000 };
const run = (fx: PurgeEffects) => runPurgeJob(fx, { rawBody: '{}', signature: 'sig' });

// ---------------------------------------------------------------------------
// The signature, and the name asked for
// ---------------------------------------------------------------------------

test('an unsigned call is 401 and calls nothing', async () => {
  const { fx, calls } = effects({ data: ok }, false);
  const res = await run(fx);
  assert.equal(res.status, 401);
  assert.deepEqual(calls, [], 'nothing runs before the signature verifies');
});

test('DONE-TEST: IT ASKS FOR THE `public` WRAPPER, NOT `ops.purge_expired`', async () => {
  // D-029's third bug, which cost a day of refused replies: every client in
  // `supabase/clients.ts` is built with no `db: { schema }`, so PostgREST is asked for
  // `public.<name>`. A function reachable only in another schema is unreachable from the
  // runtime no matter how correct the SQL is, and `0015` exists solely because of it.
  const { fx, calls } = effects({ data: ok });
  await run(fx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'purge_expired', 'the unqualified name PostgREST resolves in `public`');
  assert.deepEqual(calls[0]!.args, { p_max_rows: 50000 });
});

test('the row bound is passed through and is per-run', async () => {
  const { fx, calls } = effects({ data: { ...ok, max_rows: 10 } });
  await runPurgeJob({ ...fx, maxRows: 10 }, { rawBody: '{}', signature: 'sig' });
  assert.deepEqual(calls[0]!.args, { p_max_rows: 10 });
});

// ---------------------------------------------------------------------------
// A purge that could not run must never look like a purge of nothing
// ---------------------------------------------------------------------------

test('DONE-TEST: AN RPC ERROR IS 503, NOT A 200 WITH ZEROES', async () => {
  // The failure D-044 describes is a retention mechanism that looks present and does
  // nothing. `{purged: 0}` with a 200 is byte-identical to a database with nothing due,
  // so the only way the difference survives is for a broken run to refuse.
  const { fx, alerts } = effects({ error: { message: 'permission denied for function purge_expired' } });
  const res = await run(fx);
  assert.equal(res.status, 503);
  assert.match(String(res.body['detail']), /permission denied/);
  assert.deepEqual(alerts, [], 'a failed run is a retry, not a backlog alert');
});

test('DONE-TEST: A NULL ANSWER IS 503 — "no counts" IS NOT "zero"', async () => {
  // The subtler half of the same rule. A function that returns null has not reported;
  // coercing that to 0 is how a purge that silently stopped working stays green for ever.
  for (const bad of [{ data: null }, { data: undefined }, { data: 'nope' }, { data: 7 }]) {
    const { fx } = effects(bad);
    const res = await run(fx);
    assert.equal(res.status, 503, JSON.stringify(bad));
    assert.match(String(res.body['detail']), /no counts/);
  }
});

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

test('a normal run returns the counts and raises nothing', async () => {
  const { fx, alerts } = effects({ data: ok });
  const res = await run(fx);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ok);
  assert.deepEqual(alerts, []);
});

test('DONE-TEST: HITTING THE CEILING ALERTS, because a backlog is silent by nature', async () => {
  // A bounded job doing its maximum every run is a retention promise quietly becoming
  // false. Nothing else in the system can see it: the run succeeded, the rows it did
  // reach were purged, and every count looks like work being done.
  const { fx, alerts } = effects({ data: { ...ok, ceiling_hit: true, max_rows: 50000 } });
  const res = await run(fx);
  assert.equal(res.status, 200, 'the run SUCCEEDED — retrying it would just do another 50,000');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!['severity'], 'warn');
  assert.equal(alerts[0]!['kind'], 'retention.purge_backlog');
  assert.match(String(alerts[0]!['body']), /living past its retention/);
});

test('the backlog alert is keyed by DAY, not by run', async () => {
  // A backlog persists across runs by definition. An hourly repetition of the same true
  // statement is how a founder learns to ignore the channel — `alerts/alert.ts`'s reason
  // for putting the period in the key.
  const { fx, alerts } = effects({ data: { ...ok, ceiling_hit: true } });
  await run(fx);
  assert.equal(alerts[0]!['dedup_key'], 'purge_backlog:2026-09-07');
});

test('a non-boolean ceiling_hit is not truthy by accident', async () => {
  // `raw['ceiling_hit'] === true`, not a truthiness check: the string "false" is truthy in
  // JavaScript, and jsonb round-trips have produced stringy booleans in this codebase before.
  for (const v of ['false', 'true', 1, 0, null, undefined]) {
    const { fx, alerts } = effects({ data: { ...ok, ceiling_hit: v } });
    await run(fx);
    assert.deepEqual(alerts, [], `ceiling_hit=${JSON.stringify(v)} must not alert`);
  }
});

test('missing counts read as 0 rather than NaN', async () => {
  const { fx } = effects({ data: { ceiling_hit: false } });
  const res = await run(fx);
  assert.equal(res.status, 200);
  assert.equal(res.body['payloads_purged'], 0);
  assert.equal(res.body['rows_deleted'], 0);
  assert.equal(res.body['bodies_redacted'], 0);
});

test('DONE-TEST: THE THREE COUNTS ARE REPORTED SEPARATELY, never summed', async () => {
  // They measure three different things — a payload nulled, a whole row deleted, a message
  // body redacted — and `0021`'s statement order keeps them disjoint so no row lands in
  // two. A single total would hide which of the three stopped working.
  const { fx } = effects({ data: ok });
  const res = await run(fx);
  assert.equal(res.body['payloads_purged'], 4);
  assert.equal(res.body['rows_deleted'], 2);
  assert.equal(res.body['bodies_redacted'], 3);
});
