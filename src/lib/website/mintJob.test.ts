import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runMintJob, WEB_SESSION_MAX_TURN_CAP, type MintEffects } from './mintJob.ts';

const NOW = new Date('2026-09-19T04:00:00.000Z');
const CHANNEL = '9f2b1c44-0000-4000-8000-00000000000a';
const SECRET = 'a-tenant-mint-secret';
const IP = '203.0.113.7';

function body(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({ issued_at: NOW.toISOString(), turn_cap: 20, turnstile_token: 'cf-ok', ...over }),
    'utf8',
  );
}
const sign = (b: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;

/**
 * A database that answers per table and RECORDS THE ORDER, because the orderings are the
 * findings this file exists to hold — that the limiter runs before the decryption, and
 * that Turnstile runs behind the HMAC.
 */
function stubDb(over: {
  channel?: { data?: unknown; error?: unknown };
  rate?: number | { error: string };
  insert?: { data?: unknown; error?: unknown };
} = {}) {
  const trace: string[] = [];
  const inserted: Record<string, unknown>[] = [];

  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const op of ['eq', 'select']) chain[op] = () => chain;
    chain['insert'] = (payload: Record<string, unknown>) => {
      trace.push(`insert:${table}`);
      inserted.push(payload);
      return chain;
    };
    chain['maybeSingle'] = async () => {
      if (table === 'tenant_channels') {
        trace.push('read:tenant_channels');
        const a = over.channel ?? { data: { id: CHANNEL, tenant_id: 't-1', provider: 'web', status: 'active', delivery_mode: 'live' } };
        return { data: a.data ?? null, error: a.error ?? null };
      }
      const a = over.insert ?? { data: { id: 'sess-1' } };
      return { data: a.data ?? null, error: a.error ?? null };
    };
    return chain;
  };

  const rpc = async (name: string) => {
    trace.push(`rpc:${name}`);
    const r = over.rate ?? 1;
    return typeof r === 'number' ? { data: r, error: null } : { data: null, error: { message: r.error } };
  };

  return { trace, inserted, db: { from, rpc } as never };
}

function effects(
  db: ReturnType<typeof stubDb>,
  over: Partial<MintEffects> = {},
): MintEffects {
  return {
    db: db.db,
    now: NOW,
    ipSalt: 'platform-salt',
    loadMintSecret: async () => {
      db.trace.push('secret');
      return { ok: true, secret: SECRET };
    },
    verifyTurnstile: async () => {
      db.trace.push('turnstile');
      return { ok: true };
    },
    log: () => {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The happy path, and what it wrote
// ---------------------------------------------------------------------------

test('a correctly signed mint returns a token and stores only its hash', async () => {
  const b = body();
  const db = stubDb();
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });

  assert.equal(r.status, 200);
  assert.match(String(r.body['token']), /^[A-Za-z0-9_-]{43}$/); // ascii-safe: a base64url token this platform minted, never customer text
  assert.equal(r.body['turn_cap'], 20);

  const row = db.inserted[0]!;
  assert.equal(row['tenant_id'], 't-1');
  assert.equal(row['turns'], 0);
  // The token itself must never reach the table.
  assert.equal(JSON.stringify(row).includes(String(r.body['token'])), false, 'the token was stored');
  assert.match(String(row['token_sha256']), /^\\x[0-9a-f]{64}$/);
  assert.match(String(row['client_ip_hash']), /^\\x[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// Orderings — the reason this is a job and not three lines in a route
// ---------------------------------------------------------------------------

test('DONE-TEST: the limiter runs BEFORE the secret is decrypted', async () => {
  // Decryption is a KEK unwrap plus an AES open, per request. Putting the limiter after it
  // means an unauthenticated flood pays for that work on every attempt.
  const b = body();
  const db = stubDb();
  await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.deepEqual(db.trace, ['read:tenant_channels', 'rpc:bump_web_rate', 'secret', 'turnstile', 'insert:web_sessions']);
});

test('DONE-TEST: Turnstile runs BEHIND the HMAC, and not at all when it fails', async () => {
  // turnstile.ts says at length that inverting this makes a cost multiplier into the
  // authorization. Asserted as an ABSENCE: a bad signature must not reach Cloudflare.
  const b = body();
  const db = stubDb();
  const r = await runMintJob(effects(db), {
    rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b, 'another-tenants-secret'), clientIp: IP,
  });
  assert.equal(r.status, 401);
  assert.equal(db.trace.includes('turnstile'), false, 'an unauthenticated caller reached Cloudflare');
  assert.equal(db.trace.includes('insert:web_sessions'), false);
});

test('a rate-limited caller never reaches the secret', async () => {
  const b = body();
  const db = stubDb({ rate: 31 });
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 429);
  assert.equal(db.trace.includes('secret'), false);
});

test('an unreadable limiter FAILS CLOSED', async () => {
  const b = body();
  const db = stubDb({ rate: { error: 'connection reset' } });
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 503);
  assert.equal(db.trace.includes('insert:web_sessions'), false);
});

// ---------------------------------------------------------------------------
// One answer over the wire, several in the log
// ---------------------------------------------------------------------------

test('DONE-TEST: unknown channel, wrong provider, inactive channel and absent secret are ONE answer', async () => {
  // Otherwise this endpoint enumerates which channel ids exist, unauthenticated.
  const b = body();
  const cases = [
    stubDb({ channel: { data: null } }),
    stubDb({ channel: { data: { id: CHANNEL, tenant_id: 't-1', provider: 'facebook_page', status: 'active' } } }),
    stubDb({ channel: { data: { id: CHANNEL, tenant_id: 't-1', provider: 'web', status: 'suspended' } } }),
  ];
  const answers: unknown[] = [];
  for (const db of cases) {
    const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
    answers.push({ status: r.status, body: r.body });
  }
  const missingSecret = stubDb();
  answers.push(
    await runMintJob(
      effects(missingSecret, { loadMintSecret: async () => ({ ok: false, retryable: false, code: 'token_missing' }) }),
      { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP },
    ).then((r) => ({ status: r.status, body: r.body })),
  );
  const wrongSig = stubDb();
  answers.push(
    await runMintJob(effects(wrongSig), {
      rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b, 'nope'), clientIp: IP,
    }).then((r) => ({ status: r.status, body: r.body })),
  );

  for (const a of answers) assert.deepEqual(a, { status: 401, body: { error: 'mint_unauthorised' } });
});

test('a malformed channel header is refused without touching the database', async () => {
  const b = body();
  for (const header of [null, '', 'not-a-uuid', "' or 1=1--"]) {
    const db = stubDb();
    const r = await runMintJob(effects(db), { rawBody: b, channelHeader: header, signatureHeader: sign(b), clientIp: IP });
    assert.equal(r.status, 401, String(header));
    assert.deepEqual(db.trace, [], String(header));
  }
});

test('an unreadable channel read is 503, never "no such channel"', async () => {
  // A database blip reported as a credential problem sends a tenant to rotate a working
  // secret. Rule 2: 503 on any error.
  const b = body();
  const db = stubDb({ channel: { error: { message: 'timeout' } } });
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'mint_unavailable');
});

// ---------------------------------------------------------------------------
// Turnstile is actually wired — the gate must be able to PASS and to FAIL
// ---------------------------------------------------------------------------

test('DONE-TEST: the widget token reaches Turnstile, so the gate can pass', async () => {
  // The first version of this job passed a hardcoded `null`, which made every mint answer
  // `turnstile_missing`: a gate that cannot pass rather than one that cannot fail. The
  // token has to come out of the SIGNED body, so a relay cannot strip or swap it.
  const seen: (string | null)[] = [];
  const db = stubDb();
  const b = body({ turnstile_token: 'cf-response-xyz' });
  await runMintJob(
    effects(db, { verifyTurnstile: async (t) => { seen.push(t); return { ok: true }; } }),
    { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP },
  );
  assert.deepEqual(seen, ['cf-response-xyz']);
});

test('a failed challenge is 403 and writes no session', async () => {
  const db = stubDb();
  const b = body();
  const r = await runMintJob(
    effects(db, { verifyTurnstile: async () => ({ ok: false, reason: 'turnstile_failed' }) }),
    { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP },
  );
  assert.equal(r.status, 403);
  assert.equal(db.inserted.length, 0);
});

test('an unreachable Cloudflare is 503, not 403 — our problem reads as ours', async () => {
  const db = stubDb();
  const b = body();
  const r = await runMintJob(
    effects(db, { verifyTurnstile: async () => ({ ok: false, reason: 'turnstile_unavailable', detail: 'timeout' }) }),
    { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP },
  );
  assert.equal(r.status, 503);
  assert.equal(db.inserted.length, 0);
});

// ---------------------------------------------------------------------------
// turn_cap: the caller must say, and cannot say anything
// ---------------------------------------------------------------------------

test('DONE-TEST: a mint with no turn_cap is refused rather than given a generous default', async () => {
  // 0031's own words: "a caller that cannot say what bound it wants must be made to answer
  // rather than be quietly given a generous one." The column has no default; nor does this.
  const db = stubDb();
  const b = Buffer.from(JSON.stringify({ issued_at: NOW.toISOString(), turnstile_token: 'cf-ok' }), 'utf8');
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 400);
  assert.equal(r.body['error'], 'mint_bad_request');
  assert.equal(db.inserted.length, 0);
});

test('turn_cap is clamped, and the clamp is silent so a typo is not an outage', async () => {
  const db = stubDb();
  const b = body({ turn_cap: 40_000 });
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 200);
  assert.equal(r.body['turn_cap'], WEB_SESSION_MAX_TURN_CAP);
  assert.equal(db.inserted[0]!['turn_cap'], WEB_SESSION_MAX_TURN_CAP);
});

test('a zero, negative or fractional turn_cap is absent, not a bound', async () => {
  // `Number(null)` is 0 and 0 fails the column's CHECK, so a coercing read would turn a
  // missing field into a constraint violation three layers down instead of a 400 here.
  for (const cap of [0, -5, 2.5, '20', null]) {
    const db = stubDb();
    const b = body({ turn_cap: cap });
    const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
    assert.equal(r.status, 400, JSON.stringify(cap));
  }
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('a stale signed body is refused even though its signature is valid', async () => {
  const old = new Date(NOW.getTime() - 60 * 60 * 1000);
  const b = body({ issued_at: old.toISOString() });
  const db = stubDb();
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 401);
  assert.equal(r.body['error'], 'mint_stale');
  assert.equal(db.inserted.length, 0);
});

test('a body that is not JSON cannot pass, whatever else is right', async () => {
  const b = Buffer.from('not json at all', 'utf8');
  const db = stubDb();
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  // The signature is over these exact bytes and verifies; the missing timestamp is what
  // refuses it — which is the ordering, demonstrated from the other side.
  assert.equal(r.status, 401);
  assert.equal(r.body['error'], 'mint_stale');
});

test('a Cyrillic body verifies over its BYTES', async () => {
  const b = Buffer.from(
    JSON.stringify({ issued_at: NOW.toISOString(), turn_cap: 5, turnstile_token: 'cf-ok', note: 'Сайн байна уу' }),
    'utf8',
  );
  const db = stubDb();
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 200);
});

test('a retryable secret failure is 503 so the tenant retries rather than re-provisions', async () => {
  const db = stubDb();
  const b = body();
  const r = await runMintJob(
    effects(db, { loadMintSecret: async () => ({ ok: false, retryable: true, code: 'secret_unreadable' }) }),
    { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP },
  );
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'mint_unavailable');
});

test('a failed session insert is 503 and returns no token', async () => {
  const db = stubDb({ insert: { error: { message: 'constraint violation' } } });
  const b = body();
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 503);
  assert.equal(r.body['token'], undefined, 'a token was handed out for a session that does not exist');
});

// ---------------------------------------------------------------------------
// delivery_mode is a switch, not a note
// ---------------------------------------------------------------------------

test('DONE-TEST: a channel that is not `live` cannot mint, whatever its status says', async () => {
  // The first version selected delivery_mode and only LOGGED it, so `off` read like a
  // control and was not one — D-064's shape, in code written days after D-064 was
  // written down. `status` and `delivery_mode` are orthogonal (health vs. cutover
  // position), so an `active` channel that is not delivering must still refuse.
  const b = body();
  for (const mode of ['off', 'shadow', 'shadow_routing']) {
    const db = stubDb({
      channel: { data: { id: CHANNEL, tenant_id: 't-1', provider: 'web', status: 'active', delivery_mode: mode } },
    });
    const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
    assert.equal(r.status, 401, mode);
    assert.deepEqual(r.body, { error: 'mint_unauthorised' }, mode);
    assert.equal(db.trace.includes('secret'), false, `${mode} reached the secret`);
    assert.equal(db.trace.includes('insert:web_sessions'), false, `${mode} minted a session`);
  }
});

test('a `live` channel still mints — the gate can pass as well as fail', async () => {
  // The companion to the test above, and the one that matters: a refusal that refuses
  // everything is not a gate. `mintJob`'s own Turnstile bug was exactly this shape.
  const b = body();
  const db = stubDb({
    channel: { data: { id: CHANNEL, tenant_id: 't-1', provider: 'web', status: 'active', delivery_mode: 'live' } },
  });
  const r = await runMintJob(effects(db), { rawBody: b, channelHeader: CHANNEL, signatureHeader: sign(b), clientIp: IP });
  assert.equal(r.status, 200);
});
