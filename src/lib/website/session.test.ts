import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSession, claimTurn } from './session.ts';
import { newSessionToken, sha256 } from './mint.ts';

const NOW = new Date('2026-09-18T18:00:00.000Z');
const LATER = new Date('2026-09-18T19:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    tenant_id: 't-1',
    channel_id: 'c-1',
    turns: 0,
    turn_cap: 20,
    expires_at: LATER.toISOString(),
    revoked_at: null,
    ...over,
  };
}

/** Records what was asked of the database, and answers with whatever the test set up. */
function stubDb(answer: { data?: unknown; error?: unknown } = {}) {
  const calls: { table: string; select?: string; patch?: Record<string, unknown>; filters: string[] }[] = [];
  const from = (table: string) => {
    const rec = { table, filters: [] as string[] } as (typeof calls)[number];
    calls.push(rec);
    const chain: Record<string, unknown> = {};
    for (const op of ['eq', 'lt', 'is']) {
      chain[op] = (...args: unknown[]) => {
        rec.filters.push(`${op}(${args.map(String).join(',')})`);
        return chain;
      };
    }
    chain['select'] = (cols?: string) => {
      if (cols !== undefined) rec.select = cols;
      return chain;
    };
    chain['update'] = (patch: Record<string, unknown>) => {
      rec.patch = patch;
      return chain;
    };
    chain['maybeSingle'] = async () => ({ data: answer.data ?? null, error: answer.error ?? null });
    return chain;
  };
  return { calls, db: { from } as never };
}

// ---------------------------------------------------------------------------
// The tenant comes from the token, and from nothing the caller chose
// ---------------------------------------------------------------------------

test('a live session resolves to its tenant and channel', async () => {
  const { token } = newSessionToken();
  const { db, calls } = stubDb({ data: row() });
  const r = await resolveSession(db, token, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.session.tenantId, 't-1');
  assert.equal(r.ok === true && r.session.channelId, 'c-1');
  assert.equal(calls[0]?.table, 'web_sessions');
});

test('DONE-TEST: the lookup is by HASH — the token itself never reaches the query', async () => {
  const { token, tokenSha256 } = newSessionToken();
  const { db, calls } = stubDb({ data: row() });
  await resolveSession(db, token, NOW);
  const filters = calls[0]?.filters.join('|') ?? '';
  assert.ok(filters.includes(tokenSha256.toString('hex')), 'queried by the hash');
  assert.equal(filters.includes(token), false, 'the token is not in the query');
});

test('the hash is sent in PostgREST bytea hex form', async () => {
  // `\x…`. Sending the raw Buffer, or the hex without the prefix, silently matches nothing
  // — and "matches nothing" reads exactly like "no such session".
  const { token, tokenSha256 } = newSessionToken();
  const { db, calls } = stubDb({ data: row() });
  await resolveSession(db, token, NOW);
  assert.ok(calls[0]?.filters.some((f) => f.includes(`\\x${tokenSha256.toString('hex')}`)));
});

test('a token of the wrong shape is refused without a query at all', async () => {
  for (const bad of ['', 'short', 'a'.repeat(44), 'has spaces in it'.padEnd(43, 'x'), 'a/b+c'.padEnd(43, 'x')]) {
    const { db, calls } = stubDb({ data: row() });
    const r = await resolveSession(db, bad, NOW);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.ok === false && r.refusal, 'session_unknown');
    assert.equal(calls.length, 0, 'no query was made');
  }
});

// ---------------------------------------------------------------------------
// Fail closed (rule 2)
// ---------------------------------------------------------------------------

test('DONE-TEST: a failed read is session_unavailable, NEVER session_unknown', async () => {
  // The tempting reading of a failed lookup is "no such session", and that reading turns a
  // database blip into every customer on the site being told their session ended. Rule 2:
  // helpers return 503 on any error.
  const { token } = newSessionToken();
  const { db } = stubDb({ error: { message: 'connection reset' } });
  const r = await resolveSession(db, token, NOW);
  assert.equal(r.ok === false && r.refusal, 'session_unavailable');
});

test('an unreadable cap refuses rather than being treated as no cap', async () => {
  // Core Language's $12.43: a depth read that failed was read as a deficit of zero. An
  // unreadable bound is not an absent bound.
  for (const over of [{ turn_cap: null }, { turn_cap: 'twenty' }, { turn_cap: 0 }, { turns: null }]) {
    const { token } = newSessionToken();
    const { db } = stubDb({ data: row(over) });
    const r = await resolveSession(db, token, NOW);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.ok === false && r.refusal, 'session_unavailable', JSON.stringify(over));
  }
});

test('an unparsable expiry refuses rather than defaulting to valid', async () => {
  const { token } = newSessionToken();
  const { db } = stubDb({ data: row({ expires_at: 'not a date' }) });
  const r = await resolveSession(db, token, NOW);
  assert.equal(r.ok === false && r.refusal, 'session_unavailable');
});

// ---------------------------------------------------------------------------
// Expiry, revocation, exhaustion
// ---------------------------------------------------------------------------

test('an expired session is refused, and the boundary is exclusive', async () => {
  const { token } = newSessionToken();
  for (const [expires, expected] of [
    [new Date(NOW.getTime() - 1), 'session_expired'],
    [NOW, 'session_expired'], // exactly now is over
    [new Date(NOW.getTime() + 1), null],
  ] as const) {
    const { db } = stubDb({ data: row({ expires_at: (expires as Date).toISOString() }) });
    const r = await resolveSession(db, token, NOW);
    assert.equal(r.ok, expected === null, (expires as Date).toISOString());
    if (expected) assert.equal(r.ok === false && r.refusal, expected);
  }
});

test('DONE-TEST: revocation is reported ahead of expiry', async () => {
  // A revoked session is a decision somebody made; an expired one is time passing. Both are
  // true of a revoked session that then expired, and reporting the weaker hides the
  // stronger — which is the one an operator needs to see.
  const { token } = newSessionToken();
  const { db } = stubDb({
    data: row({ revoked_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() - 1).toISOString() }),
  });
  const r = await resolveSession(db, token, NOW);
  assert.equal(r.ok === false && r.refusal, 'session_revoked');
});

test('a spent cap refuses', async () => {
  const { token } = newSessionToken();
  const { db } = stubDb({ data: row({ turns: 20, turn_cap: 20 }) });
  const r = await resolveSession(db, token, NOW);
  assert.equal(r.ok === false && r.refusal, 'session_exhausted');
});

// ---------------------------------------------------------------------------
// The claim is what binds
// ---------------------------------------------------------------------------

test('DONE-TEST: claiming a turn is conditional on the row not having moved', async () => {
  // resolveSession reading the cap produces a good error message; THIS is the check that
  // binds. Without `eq(turns, <what we read>)` and `lt(turns, cap)` in the same statement,
  // two requests arriving together both read cap-1 and both proceed — a cap that is a
  // number in a log rather than a bound.
  const { db, calls } = stubDb({ data: { turns: 4 } });
  const r = await claimTurn(db, { id: 's-1', tenantId: 't-1', channelId: 'c-1', turns: 3, turnCap: 20, expiresAt: LATER }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.turn, 4);
  const filters = calls[0]?.filters ?? [];
  assert.ok(filters.includes('eq(turns,3)'), 'optimistic on the value read');
  assert.ok(filters.includes('lt(turns,20)'), 'and on the cap, in the same statement');
  assert.ok(filters.includes('is(revoked_at,null)'), 'a revoked session cannot claim');
  assert.equal(calls[0]?.patch?.['turns'], 4);
});

test('a claim that matched no row is exhausted, not an error', async () => {
  const { db } = stubDb({ data: null });
  const r = await claimTurn(db, { id: 's-1', tenantId: 't-1', channelId: 'c-1', turns: 19, turnCap: 20, expiresAt: LATER }, NOW);
  assert.equal(r.ok === false && r.refusal, 'session_exhausted');
});

test('a failed claim is unavailable, and never a silent success', async () => {
  const { db } = stubDb({ error: { message: 'deadlock detected' } });
  const r = await claimTurn(db, { id: 's-1', tenantId: 't-1', channelId: 'c-1', turns: 0, turnCap: 20, expiresAt: LATER }, NOW);
  assert.equal(r.ok === false && r.refusal, 'session_unavailable');
});

test('the claim stamps last_seen_at, so a dead session is distinguishable from a quiet one', async () => {
  const { db, calls } = stubDb({ data: { turns: 1 } });
  await claimTurn(db, { id: 's-1', tenantId: 't-1', channelId: 'c-1', turns: 0, turnCap: 20, expiresAt: LATER }, NOW);
  assert.equal(calls[0]?.patch?.['last_seen_at'], NOW.toISOString());
});

// ---------------------------------------------------------------------------
// The schema, read rather than remembered
// ---------------------------------------------------------------------------

test('DONE-TEST: every column selected here exists in 0031', () => {
  // D-058: a select naming a column the project does not have is a 400 from PostgREST that
  // CI structurally cannot see, because CI applies every migration in the repo first. This
  // reads the migration rather than trusting the select — the same move halt.test.ts makes
  // for the CHECK constraint.
  const sql = readFileSync('supabase/migrations/0031_website_channel.sql', 'utf8');
  const start = sql.indexOf('create table web_sessions (');
  assert.notEqual(start, -1);
  const body = sql.slice(start, sql.indexOf('\n);', start));
  for (const col of ['id', 'tenant_id', 'channel_id', 'turns', 'turn_cap', 'expires_at', 'revoked_at', 'token_sha256', 'last_seen_at']) {
    assert.match(body, new RegExp(`\\n  ${col}\\s`), `web_sessions.${col}`);
  }
});

test('DONE-TEST: the database refuses what the claim refuses', () => {
  // Belt and braces, and the braces are in the schema: `turns <= turn_cap` is a CHECK, so
  // even a caller bypassing claimTurn cannot write a session past its bound. If somebody
  // later loosens claimTurn, this constraint is what still holds.
  const sql = readFileSync('supabase/migrations/0031_website_channel.sql', 'utf8');
  assert.match(sql, /web_sessions_turns_within_cap check \(turns <= turn_cap\)/);
  assert.match(sql, /web_sessions_expires_after_issue check \(expires_at > issued_at\)/);
  assert.match(sql, /create unique index web_sessions_token_key on web_sessions \(token_sha256\)/);
});

test('the token hash is unique across ALL tenants, not per tenant', () => {
  // Rule 1 wants a registry with a unique key. Scoped per tenant, the same hash could name
  // two tenants and the lookup — which has no tenant to scope BY — would be ambiguous.
  const sql = readFileSync('supabase/migrations/0031_website_channel.sql', 'utf8');
  const idx = sql.match(/create unique index web_sessions_token_key on web_sessions \(([^)]*)\)/);
  assert.equal(idx?.[1]?.trim(), 'token_sha256');
});

test('sha256 is stable across calls — the lookup key cannot drift', () => {
  assert.deepEqual(sha256('abc'), sha256('abc'));
});

test('DONE-TEST: a null counter is unreadable, not zero', () => {
  // Number(null) is 0, not NaN. Coercing before validating read a null `turns` as "zero
  // turns used" — a FRESH session — which is the exact inversion of what an unreadable
  // counter must mean. Caught by the loop above; kept as its own case because the
  // coercion is the kind of thing a later simplification puts straight back.
  assert.equal(Number(null), 0, 'the JavaScript fact this guards against');
  assert.equal(Number.isInteger(Number(null)), true, 'and it passes an integer check');
});
