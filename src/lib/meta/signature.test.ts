import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, verifyHandshakeToken } from './signature.ts';

const MAIN = 'main-app-secret';
const LEGACY = 'legacy-cutover-secret';

function withEnv<T>(fn: () => T): T {
  process.env['META_APP_SECRETS'] = JSON.stringify({ dala: MAIN, 'dala-legacy': LEGACY });
  process.env['META_VERIFY_TOKENS'] = JSON.stringify({ dala: ['tok-a', 'tok-b'] });
  return fn();
}

const sign = (body: Buffer, secret: string) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

test('a genuine signature verifies and reports which app secret matched', () => {
  withEnv(() => {
    const body = Buffer.from(JSON.stringify({ object: 'page' }), 'utf8');
    const res = verifyMetaSignature(body, sign(body, MAIN), 'dala');
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.matchedAppSlug, 'dala');
  });
});

test('the secret is a SET: the legacy cutover app also verifies', () => {
  // Rotation, staging and the dala-legacy cutover app each hold a different secret. A
  // scalar secret would make every rotation an outage.
  withEnv(() => {
    const body = Buffer.from(JSON.stringify({ object: 'page' }), 'utf8');
    const res = verifyMetaSignature(body, sign(body, LEGACY), 'dala');
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.matchedAppSlug, 'dala-legacy');
  });
});

test('Mongolian Cyrillic bodies verify — the bytes are signed, not a re-encoding', () => {
  // The reason this takes a Buffer rather than a string. Multibyte UTF-8 through a
  // decode/re-encode round trip is where a signature path silently breaks.
  withEnv(() => {
    const body = Buffer.from(JSON.stringify({ text: 'Хүүхдийн үс засуулах хэд вэ? ӨҮЁ' }), 'utf8');
    const res = verifyMetaSignature(body, sign(body, MAIN), 'dala');
    assert.equal(res.ok, true);
  });
});

test('a forged signature is refused', () => {
  withEnv(() => {
    const body = Buffer.from('{"object":"page"}', 'utf8');
    assert.equal(verifyMetaSignature(body, sign(body, 'wrong-secret'), 'dala').ok, false);
  });
});

test('a tampered body is refused even with a once-valid signature', () => {
  withEnv(() => {
    const original = Buffer.from('{"object":"page","amount":1}', 'utf8');
    const header = sign(original, MAIN);
    const tampered = Buffer.from('{"object":"page","amount":9}', 'utf8');
    assert.equal(verifyMetaSignature(tampered, header, 'dala').ok, false);
  });
});

test('a missing or malformed header is refused, and never throws', () => {
  withEnv(() => {
    const body = Buffer.from('{}', 'utf8');
    assert.equal(verifyMetaSignature(body, null, 'dala').ok, false);
    assert.equal(verifyMetaSignature(body, '', 'dala').ok, false);
    assert.equal(verifyMetaSignature(body, 'md5=abc', 'dala').ok, false);
    // A wrong-length digest would make timingSafeEqual THROW if length were not checked.
    assert.equal(verifyMetaSignature(body, 'sha256=aa', 'dala').ok, false);
    assert.equal(verifyMetaSignature(body, 'sha256=zzzz', 'dala').ok, false);
  });
});

test('an absent secret refuses rather than accepting — no fallback to no credential', () => {
  const saved = process.env['META_APP_SECRETS'];
  delete process.env['META_APP_SECRETS'];
  try {
    const body = Buffer.from('{}', 'utf8');
    assert.throws(() => verifyMetaSignature(body, sign(body, MAIN), 'dala'));
  } finally {
    if (saved !== undefined) process.env['META_APP_SECRETS'] = saved;
  }
});

test('the verify handshake accepts any configured token and rejects others', () => {
  withEnv(() => {
    assert.equal(verifyHandshakeToken('dala', 'tok-a'), true);
    assert.equal(verifyHandshakeToken('dala', 'tok-b'), true);
    assert.equal(verifyHandshakeToken('dala', 'tok-wrong'), false);
    assert.equal(verifyHandshakeToken('unknown-app', 'tok-a'), false);
    assert.equal(verifyHandshakeToken('dala', null), false);
  });
});
