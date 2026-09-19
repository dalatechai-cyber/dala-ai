import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMessageJob, MAX_MESSAGE_CHARS, type MessageEffects } from './messageJob.ts';
import { newSessionToken } from './mint.ts';

const NOW = new Date('2026-09-19T04:00:00.000Z');
const LATER = new Date('2026-09-19T06:00:00.000Z');
const IP = '203.0.113.7';
const ORIGIN = 'https://www.dalatech.online';

const { token } = newSessionToken();

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1', tenant_id: 't-1', channel_id: 'c-1',
    turns: 0, turn_cap: 20, expires_at: LATER.toISOString(), revoked_at: null,
    ...over,
  };
}

/**
 * Answers per table and records the ORDER. The orderings around money are the findings
 * this file holds, and an ordering can only be asserted by something that watched.
 */
function stubDb(over: {
  session?: Record<string, unknown> | null;
  claim?: Record<string, unknown> | null;
  domains?: { data?: unknown; error?: unknown };
  tenant?: Record<string, unknown> | null;
  rate?: number;
  draft?: { id: string; body: string };
  claimOutcome?: 'claimed' | 'already_sent';
} = {}) {
  const trace: string[] = [];
  let sessionReads = 0;
  let outboundReads = 0;

  const from = (table: string) => {
    const rec: { table: string; patch?: Record<string, unknown> } = { table };
    // A Proxy rather than a list of builder methods: PostgREST's builder is large and a
    // missing name fails as "x is not a function", which reads as a bug in the code under
    // test rather than a gap in the fake. Anything not named below returns the chain.
    const base: Record<string, unknown> = {};
    const chain: Record<string, unknown> = new Proxy(base, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        return () => chain;
      },
    });
    base['update'] = (patch: Record<string, unknown>) => {
      rec.patch = patch;
      if (table === 'web_sessions') trace.push('claimTurn');
      if (table === 'outbound_messages') trace.push(patch['state'] === 'sending' ? 'claimDraft' : 'markSent');
      if (table === 'messages') trace.push('traceAnswer');
      return chain;
    };
    base['insert'] = () => { trace.push(`insert:${table}`); return chain; };
    base['upsert'] = () => { trace.push(`upsert:${table}`); return chain; };
    base['maybeSingle'] = async () => {
      switch (table) {
        case 'web_sessions': {
          sessionReads += 1;
          if (sessionReads === 1) {
            trace.push('resolveSession');
            return { data: over.session === undefined ? sessionRow() : over.session, error: null };
          }
          return { data: over.claim === undefined ? { turns: 1 } : over.claim, error: null };
        }
        case 'tenants':
          trace.push('tenants');
          return {
            data: over.tenant === undefined
              ? { default_locale: 'mn', prompt_cache_mode: '1h', timezone: 'Asia/Ulaanbaatar' }
              : over.tenant,
            error: null,
          };
        case 'contacts': return { data: { id: 'contact-1', person_id: null }, error: null };
        case 'conversations': return { data: { id: 'conv-1' }, error: null };
        case 'messages': return { data: { id: 'msg-1' }, error: null };
        case 'outbound_messages': {
          const d = over.draft ?? { id: 'out-1', body: 'Сайн байна уу' };
          if (over.claimOutcome !== 'already_sent') {
            return { data: { id: d.id, body: d.body, attempts: 0 }, error: null };
          }
          // `claim` answers a missed CAS with a second read of `state`, because "already
          // sent" and "somebody else is sending" are very different answers. The fake has
          // to model BOTH reads or it exercises the unavailable branch by accident —
          // which is how this test first passed for the wrong reason.
          outboundReads += 1;
          return outboundReads === 1
            ? { data: null, error: null }
            : { data: { state: 'sent' }, error: null };
        }
        default: return { data: null, error: null };
      }
    };
    // `tenant_domains` and `readHistory` await the builder itself (no maybeSingle), so it
    // has to be thenable — but ONLY for those, or every intermediate await would resolve.
    base['then'] = (resolve: (v: unknown) => unknown) => {
      if (table === 'tenant_domains') {
        trace.push('tenant_domains');
        const d = over.domains ?? { data: [{ host: 'www.dalatech.online', verified_at: NOW.toISOString() }] };
        return Promise.resolve({ data: d.data ?? null, error: d.error ?? null }).then(resolve);
      }
      if (table === 'messages') {
        trace.push('readHistory');
        return Promise.resolve({ data: [{ direction: 'inbound', body: 'hi', at: NOW.toISOString() }], error: null }).then(resolve);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return chain;
  };

  const rpc = async () => {
    trace.push('rate');
    return { data: over.rate ?? 1, error: null };
  };

  return { trace, db: { from, rpc } as never };
}

const CTX = {
  promptStable: 'PREFIX', hours: [], closures: [], allowedNumbers: [], cannedHash: 'ch',
  promptGate: 'GATE', revisionId: 'rev-1', contentHash: 'hash-1', rules: [], deterministic: [],
  canned: [{ kind: 'handoff', body: 'Түр хүлээнэ үү', reviewedAt: NOW.toISOString() }],
  tenantGuard: {}, cacheMode: '1h' as const,
} as never;

function effects(db: ReturnType<typeof stubDb>, over: Partial<MessageEffects> = {}): MessageEffects {
  return {
    db: db.db,
    now: NOW,
    ipSalt: 'platform-salt',
    loadContext: async () => { db.trace.push('loadContext'); return { ok: true, context: CTX }; },
    checkGuard: async () => {
      db.trace.push('guard');
      return { ok: true, reservation: { id: 'res-1', tenantId: 't-1', surface: 'reception' } as never };
    },
    generateReply: async () => {
      db.trace.push('MODEL');
      return { kind: 'drafted', outboundId: 'out-1', answeredBy: 'model' };
    },
    log: () => {},
    ...over,
  };
}

const req = (over: Partial<Parameters<typeof runMessageJob>[1]> = {}) => ({
  token, text: 'Хэдэн цагт вэ?', origin: ORIGIN, clientIp: IP, ...over,
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a live session gets a reply, and the reply is the STORED draft body', async () => {
  const db = stubDb();
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 200);
  assert.equal(r.body['reply'], 'Сайн байна уу');
  assert.equal(r.body['answered_by'], 'model');
  assert.equal(r.allowOrigin, ORIGIN);
});

// ---------------------------------------------------------------------------
// The two orderings that bound money
// ---------------------------------------------------------------------------

test('DONE-TEST: the turn is claimed BEFORE the model is called', async () => {
  // Rule 3: a ceiling checked after the call is not a ceiling.
  const db = stubDb();
  await runMessageJob(effects(db), req());
  const claimAt = db.trace.indexOf('claimTurn');
  const modelAt = db.trace.indexOf('MODEL');
  assert.notEqual(claimAt, -1, 'no turn was claimed at all');
  assert.notEqual(modelAt, -1);
  assert.ok(claimAt < modelAt, `claim must precede the model: ${db.trace.join(' → ')}`);
});

test('DONE-TEST: the spend guard runs BEFORE the turn is claimed', async () => {
  // A visitor refused for the tenant's ceiling has not had a turn. Burning one would
  // charge them for an answer they never received — and the guard costs no model tokens,
  // so putting it first does not weaken the rule above.
  const db = stubDb();
  await runMessageJob(effects(db), req());
  assert.ok(db.trace.indexOf('guard') < db.trace.indexOf('claimTurn'), db.trace.join(' → '));
});

test('DONE-TEST: a ceiling refusal burns no turn and calls no model', async () => {
  const db = stubDb();
  const r = await runMessageJob(
    effects(db, { checkGuard: async () => ({ ok: false, refusal: { status: 429, code: 'ceiling_reached' } }) }),
    req(),
  );
  assert.equal(db.trace.includes('claimTurn'), false, 'a refused visitor was charged a turn');
  assert.equal(db.trace.includes('MODEL'), false);
  // §5.7: never silence. The tenant's own reviewed handoff line, not a bare error code.
  assert.equal(r.status, 200);
  assert.equal(r.body['reply'], 'Түр хүлээнэ үү');
  assert.equal(r.body['refusal'], 'ceiling_reached');
});

test('an unavailable guard is 503 and never reaches the model', async () => {
  const db = stubDb();
  const r = await runMessageJob(
    effects(db, {
      checkGuard: async () => ({ ok: false, refusal: { status: 503, code: 'guard_unavailable', detail: 'rpc gone' } }),
    }),
    req(),
  );
  assert.equal(r.status, 503);
  assert.equal(db.trace.includes('MODEL'), false);
});

test('a session whose cap is spent is refused before any of the work', async () => {
  const db = stubDb({ session: sessionRow({ turns: 20, turn_cap: 20 }) });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 429);
  assert.equal(r.body['error'], 'session_exhausted');
  assert.deepEqual(db.trace, ['resolveSession']);
});

test('losing the claim race is refused rather than answered a second time', async () => {
  // `claimTurn` returning no row means another request took this turn.
  const db = stubDb({ claim: null });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 429);
  assert.equal(db.trace.includes('MODEL'), false, 'the model ran on a turn we did not hold');
});

// ---------------------------------------------------------------------------
// Identity: the token, and nothing the caller chose
// ---------------------------------------------------------------------------

test('DONE-TEST: an unknown token does no work at all', async () => {
  const db = stubDb({ session: null });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 401);
  assert.deepEqual(db.trace, ['resolveSession']);
});

test('an unreadable session is 503, never "your session ended"', async () => {
  // Reading a failed lookup as "no such session" turns a database blip into every visitor
  // being told their conversation is over.
  const db = stubDb({ session: sessionRow({ turns: null }) });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'session_unavailable');
});

test('nothing in the request names a tenant, so a forged one cannot exist', async () => {
  // The request type carries token, text, origin and address. There is no tenant field,
  // no channel field and no conversation field to forge — asserted structurally.
  const keys = Object.keys(req()).sort();
  assert.deepEqual(keys, ['clientIp', 'origin', 'text', 'token']);
});

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

test('an origin outside tenant_domains is refused', async () => {
  const db = stubDb();
  const r = await runMessageJob(effects(db), req({ origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
  assert.equal(r.allowOrigin, undefined, 'a refused origin was echoed back');
  assert.equal(db.trace.includes('MODEL'), false);
});

test('DONE-TEST: an UNVERIFIED tenant_domains row is not an allow-list entry', async () => {
  const db = stubDb({ domains: { data: [{ host: 'www.dalatech.online', verified_at: null }] } });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 403);
});

test('an unreadable allow-list FAILS CLOSED, and is not read as empty or permissive', async () => {
  const db = stubDb({ domains: { error: { message: 'timeout' } } });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'origin_unavailable');
});

test('a caller with no Origin proceeds, and is echoed nothing', async () => {
  // A non-browser caller sends no Origin. CORS is not the authorization — the token is —
  // so there is nothing to refuse here, and nothing to grant either.
  const db = stubDb();
  const r = await runMessageJob(effects(db), req({ origin: null }));
  assert.equal(r.status, 200);
  assert.equal(r.allowOrigin, undefined);
});

test('a malformed Origin is refused rather than parsed generously', async () => {
  const db = stubDb();
  const r = await runMessageJob(effects(db), req({ origin: 'not a url' }));
  assert.equal(r.status, 403);
});

test('the host comparison is case-insensitive, as hosts are', async () => {
  const db = stubDb();
  const r = await runMessageJob(effects(db), req({ origin: 'https://WWW.Dalatech.Online' }));
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

test('an empty or whitespace message is refused before anything is spent', async () => {
  for (const text of ['', '   ', '\n\t']) {
    const db = stubDb();
    const r = await runMessageJob(effects(db), req({ text }));
    assert.equal(r.status, 400, JSON.stringify(text));
    assert.equal(db.trace.includes('MODEL'), false);
  }
});

test('DONE-TEST: the length bound counts CODE POINTS, not bytes or UTF-16 units', async () => {
  // Rule 6 forbids byte length as character length. Mongolian Cyrillic is two bytes a
  // letter, so a byte bound would cut a Mongolian visitor off at half an English one's
  // length — and `String.length` counts an emoji twice.
  const cyrillic = 'ө'.repeat(MAX_MESSAGE_CHARS);
  assert.ok(Buffer.byteLength(cyrillic, 'utf8') > MAX_MESSAGE_CHARS, 'the byte length exceeds the bound');
  const db = stubDb();
  assert.equal((await runMessageJob(effects(db), req({ text: cyrillic }))).status, 200);

  const emoji = '💇'.repeat(MAX_MESSAGE_CHARS);
  assert.ok(emoji.length > MAX_MESSAGE_CHARS, 'UTF-16 units exceed the bound');
  assert.equal((await runMessageJob(effects(stubDb()), req({ text: emoji }))).status, 200);

  const tooLong = 'ө'.repeat(MAX_MESSAGE_CHARS + 1);
  assert.equal((await runMessageJob(effects(stubDb()), req({ text: tooLong }))).status, 413);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('a rate-limited session never reaches the model', async () => {
  const db = stubDb({ rate: 999 });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 429);
  assert.equal(db.trace.includes('MODEL'), false);
});

test('DONE-TEST: BOTH the session and the address are counted', async () => {
  // One bucket is not enough: at the mint's 30 sessions a minute from one address, a
  // session-only limit permits 30 × the per-session number from that address.
  const db = stubDb();
  await runMessageJob(effects(db), req());
  assert.equal(db.trace.filter((t) => t === 'rate').length, 2, db.trace.join(' → '));
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('a tenant with no published WEB snapshot is refused, not answered from a default', async () => {
  const db = stubDb();
  const r = await runMessageJob(
    effects(db, { loadContext: async () => ({ ok: false, code: 'not_provisioned', detail: 'no snapshot for channel web' }) }),
    req(),
  );
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'context_not_provisioned');
  assert.equal(db.trace.includes('MODEL'), false);
});

test('a tenant row with no timezone refuses rather than defaulting on the money path', async () => {
  const db = stubDb({ tenant: { default_locale: 'mn', prompt_cache_mode: '1h', timezone: null } });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'tenant_timezone_missing');
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test('a draft somebody else already delivered is not handed over twice', async () => {
  const db = stubDb({ claimOutcome: 'already_sent' });
  const r = await runMessageJob(effects(db), req());
  assert.equal(r.status, 409);
});

test('the reply is marked sent, with a non-null id naming this transport', async () => {
  // D-080 reads a null `provider_message_id` as "not ours". A web reply is ours, and the
  // HTTP response is what carried it.
  const db = stubDb();
  await runMessageJob(effects(db), req());
  assert.ok(db.trace.includes('markSent'), db.trace.join(' → '));
});

test('a retry outcome is 503 rather than a silent non-answer', async () => {
  const db = stubDb();
  const r = await runMessageJob(
    effects(db, { generateReply: async () => ({ kind: 'retry', detail: 'no reviewed handoff line' }) }),
    req(),
  );
  assert.equal(r.status, 503);
});
