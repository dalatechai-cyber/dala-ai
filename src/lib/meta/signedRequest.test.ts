import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignedRequest } from './signedRequest.ts';

const MAIN = 'main-app-secret';
const LEGACY = 'legacy-cutover-secret';
const ASID = '1234567890123456';

function withEnv<T>(fn: () => T): T {
  process.env['META_APP_SECRETS'] = JSON.stringify({ dala: MAIN, 'dala-legacy': LEGACY });
  return fn();
}

const b64 = (s: string | Buffer) => Buffer.from(s as never).toString('base64url');

/** Build a signed_request the way Meta does: sign the ENCODED payload string. */
function sign(payload: Record<string, unknown>, secret = MAIN): string {
  const encoded = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(encoded, 'ascii').digest().toString('base64url');
  return `${sig}.${encoded}`;
}

const GOOD = { algorithm: 'HMAC-SHA256', issued_at: 1_756_900_000, user_id: ASID };

test('a genuine signed_request verifies and yields the app-scoped id', () => {
  withEnv(() => {
    const res = verifySignedRequest(sign(GOOD));
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.payload.userId, ASID);
    assert.equal(res.payload.matchedAppSlug, 'dala');
    assert.equal(res.payload.issuedAt?.getTime(), 1_756_900_000 * 1000, 'issued_at is SECONDS');
  });
});

test('the HMAC is over the ENCODED payload, not the decoded JSON', () => {
  // The single most common way this is implemented wrongly. Signing the decoded JSON
  // produces a signature that never matches Meta's, and the endpoint then rejects every
  // real deletion request while passing its own tests.
  withEnv(() => {
    const encoded = b64(JSON.stringify(GOOD));
    const overDecoded = createHmac('sha256', MAIN)
      .update(JSON.stringify(GOOD), 'utf8')
      .digest()
      .toString('base64url');
    const res = verifySignedRequest(`${overDecoded}.${encoded}`);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.refusal, 'signature_invalid');
  });
});

test('the secret is a SET: the legacy cutover app also verifies', () => {
  withEnv(() => {
    const res = verifySignedRequest(sign(GOOD, LEGACY));
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.payload.matchedAppSlug, 'dala-legacy');
  });
});

test('DONE-TEST: a payload declaring another algorithm is refused, not dispatched on', () => {
  // `algorithm` is attacker-supplied data describing how the attacker signed their own
  // message. Branching on it is `alg: none` with a different spelling. We verify with
  // HMAC-SHA256 unconditionally, THEN refuse anything claiming otherwise — so this
  // request has a VALID signature and is still refused.
  withEnv(() => {
    const res = verifySignedRequest(sign({ ...GOOD, algorithm: 'none' }));
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.refusal, 'algorithm_unexpected');
  });
});

test('a tampered payload is refused', () => {
  withEnv(() => {
    const genuine = sign(GOOD);
    const forged = `${genuine.split('.')[0]}.${b64(JSON.stringify({ ...GOOD, user_id: 'someone_else' }))}`;
    const res = verifySignedRequest(forged);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.refusal, 'signature_invalid');
  });
});

test('DONE-TEST: junk that base64 would silently repair is refused as not_base64url', () => {
  // Buffer.from(x, 'base64url') never throws — it drops characters outside the alphabet
  // and returns something shorter. Without the re-encode check, "not a signature" is
  // reported as "wrong signature", which is a different incident.
  withEnv(() => {
    const encoded = b64(JSON.stringify(GOOD));
    for (const bad of ['!!!!not base64!!!!', 'abc$def', 'ab cd']) {
      const res = verifySignedRequest(`${bad}.${encoded}`);
      assert.equal(res.ok, false, bad);
      assert.equal(res.ok === false && res.refusal, 'not_base64url', bad);
    }
  });
});

test('padding on the SIGNATURE half is tolerated; on the payload half it cannot be', () => {
  // The signature half is only ever decoded, so padding is cosmetic and accepted.
  // The payload half is the HMAC's literal input, so a proxy that pads it has changed
  // the signed string and nothing can repair that. `signature_invalid` is then the true
  // statement — we cannot verify a signature over a string that is not the one signed —
  // and pretending otherwise would mean accepting a payload nobody signed.
  withEnv(() => {
    const [sig, payload] = sign(GOOD).split('.') as [string, string];
    assert.equal(verifySignedRequest(`${sig}==.${payload}`).ok, true, 'signature padded');

    const padded = verifySignedRequest(`${sig}.${payload}=`);
    assert.equal(padded.ok, false, 'payload padded');
    assert.equal(padded.ok === false && padded.refusal, 'signature_invalid');
  });
});

test('a malformed envelope is refused before any hashing', () => {
  withEnv(() => {
    for (const bad of ['', 'nodot', 'a.b.c', '.payload', 'sig.']) {
      const res = verifySignedRequest(bad);
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.ok(
        ['malformed', 'not_base64url'].includes(res.ok === false ? res.refusal : ''),
        JSON.stringify(bad),
      );
    }
  });
});

test('a verified payload with no user id is refused — there is nobody to erase', () => {
  withEnv(() => {
    for (const over of [{ user_id: '' }, { user_id: '   ' }, { user_id: 12345 }, { user_id: undefined }]) {
      const res = verifySignedRequest(sign({ ...GOOD, ...over }));
      assert.equal(res.ok, false, JSON.stringify(over));
      assert.equal(res.ok === false && res.refusal, 'user_id_missing', JSON.stringify(over));
    }
  });
});

test('a verified payload that is not a JSON object is refused', () => {
  withEnv(() => {
    for (const body of ['[]', '"a string"', '42', 'not json at all']) {
      const encoded = b64(body);
      const sig = createHmac('sha256', MAIN).update(encoded, 'ascii').digest().toString('base64url');
      const res = verifySignedRequest(`${sig}.${encoded}`);
      assert.equal(res.ok, false, body);
      assert.equal(res.ok === false && res.refusal, 'payload_not_json', body);
    }
  });
});

test('an unusable issued_at is null, never a refusal', () => {
  // A privacy request is not dropped over a timestamp we only record.
  withEnv(() => {
    for (const issued of [undefined, 'yesterday', 0, -1, Number.NaN]) {
      const res = verifySignedRequest(sign({ ...GOOD, issued_at: issued }));
      assert.equal(res.ok, true, String(issued));
      assert.equal(res.ok && res.payload.issuedAt, null, String(issued));
    }
  });
});

test('an unconfigured app secret THROWS rather than refusing', () => {
  // "We could not check" must not be recorded as "they failed". The route turns this into
  // a 500 and an alert, not a quiet 400 that loses a real deletion request.
  const saved = process.env['META_APP_SECRETS'];
  delete process.env['META_APP_SECRETS'];
  try {
    assert.throws(() => verifySignedRequest(sign(GOOD)));
  } finally {
    process.env['META_APP_SECRETS'] = saved;
  }
});
