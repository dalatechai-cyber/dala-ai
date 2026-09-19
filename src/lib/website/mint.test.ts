import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifyMintSignature,
  newSessionToken,
  sha256,
  hashClientIp,
  MINT_CLOCK_SKEW_MS,
} from './mint.ts';

const SECRET = 'a-tenant-mint-secret';
const OTHER = 'another-tenants-mint-secret';
const NOW = new Date('2026-09-18T18:00:00.000Z');

const sign = (body: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** A mint request body, with the timestamp INSIDE it so the HMAC covers it. */
function body(at: Date = NOW, extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ issued_at: at.toISOString(), ...extra }), 'utf8');
}

// ---------------------------------------------------------------------------
// The signature is what derives the tenant
// ---------------------------------------------------------------------------

test('a correctly signed, current request verifies', () => {
  const b = body();
  assert.deepEqual(verifyMintSignature(b, sign(b), SECRET, NOW, NOW), { ok: true });
});

test("DONE-TEST: another tenant's secret does not verify", () => {
  // This is the whole construction. A caller may name any channel it likes in the header;
  // the secret that channel maps to is the one tried, and if the caller did not have it
  // the request is refused. The header selects a candidate; the HMAC decides.
  const b = body();
  const r = verifyMintSignature(b, sign(b, OTHER), SECRET, NOW, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, 'mint_unauthorised');
  assert.equal(r.ok === false && r.diagnosis, 'signature_mismatch');
});

test('one byte of the body changed invalidates the signature', () => {
  const b = body();
  const sig = sign(b);
  const tampered = Buffer.from(b);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;
  assert.equal(verifyMintSignature(tampered, sig, SECRET, NOW, NOW).ok, false);
});

test('an empty secret refuses — no fallback to no credential', () => {
  const b = body();
  const r = verifyMintSignature(b, sign(b), '', NOW, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.diagnosis, 'secret_missing');
});

test('a missing or malformed header is refused, never accepted', () => {
  const b = body();
  const cases: Array<[string | null, string]> = [
    [null, 'header_missing'],
    ['', 'header_missing'],
    [createHmac('sha256', SECRET).update(b).digest('hex'), 'header_malformed'], // no prefix
    ['sha256=', 'header_malformed'],
    ['sha256=not-hex', 'header_malformed'],
    ['sha1=00ff', 'header_malformed'],
  ];
  for (const [header, diagnosis] of cases) {
    const r = verifyMintSignature(b, header, SECRET, NOW, NOW);
    assert.equal(r.ok, false, String(header));
    assert.equal(r.ok === false && r.diagnosis, diagnosis, String(header));
  }
});

test('a digest of the right shape but the wrong value is refused', () => {
  // Same length, valid hex — so it reaches timingSafeEqual rather than being rejected by
  // the shape check, which is the path that has to be constant-time.
  const b = body();
  assert.equal(verifyMintSignature(b, `sha256=${'0'.repeat(64)}`, SECRET, NOW, NOW).ok, false);
});

test('the signature is case-insensitive in the hex, as a header may be normalised', () => {
  const b = body();
  const upper = sign(b).replace(/[0-9a-f]+$/, (h) => h.toUpperCase());
  assert.equal(verifyMintSignature(b, upper, SECRET, NOW, NOW).ok, true);
});

// ---------------------------------------------------------------------------
// Raw bytes, because the bodies here are Mongolian
// ---------------------------------------------------------------------------

test('DONE-TEST: a Cyrillic body verifies over its BYTES', () => {
  // meta/signature.ts explains at length why this takes a Buffer and not a string. The
  // property is worth asserting on this path too: the signed bytes are the UTF-8 the
  // tenant's server sent, and a decode/re-encode round trip through UTF-16 must not be
  // what the HMAC is computed over.
  const b = Buffer.from(JSON.stringify({ issued_at: NOW.toISOString(), note: 'Сайн байна уу' }), 'utf8');
  assert.ok(b.length > JSON.stringify({ issued_at: NOW.toISOString(), note: 'Сайн байна уу' }).length,
    'multibyte, so bytes and characters differ — which is the case that matters');
  assert.equal(verifyMintSignature(b, sign(b), SECRET, NOW, NOW).ok, true);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('a signature with no timestamp is refused, not accepted for ever', () => {
  const b = body();
  const r = verifyMintSignature(b, sign(b), SECRET, null, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, 'mint_stale');
});

test('the replay window is symmetric — a fast tenant clock still mints', () => {
  const b = body();
  for (const offset of [-MINT_CLOCK_SKEW_MS + 1000, 0, MINT_CLOCK_SKEW_MS - 1000]) {
    const at = new Date(NOW.getTime() + offset);
    assert.equal(verifyMintSignature(b, sign(b), SECRET, at, NOW).ok, true, String(offset));
  }
});

test('outside the window, in either direction, is refused', () => {
  const b = body();
  for (const offset of [-MINT_CLOCK_SKEW_MS - 1000, MINT_CLOCK_SKEW_MS + 1000]) {
    const at = new Date(NOW.getTime() + offset);
    const r = verifyMintSignature(b, sign(b), SECRET, at, NOW);
    assert.equal(r.ok, false, String(offset));
    assert.equal(r.ok === false && r.diagnosis, 'timestamp_outside_window');
  }
});

test('an unparsable timestamp is refused rather than treated as now', () => {
  const b = body();
  const r = verifyMintSignature(b, sign(b), SECRET, new Date('not a date'), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.diagnosis, 'timestamp_malformed');
});

test('DONE-TEST: the timestamp is checked AFTER the signature', () => {
  // Order is the finding, not an accident. If freshness were checked first, this endpoint
  // would answer "that timestamp is stale" to a caller holding no secret at all — a
  // distinction offered to someone entitled to none. An unauthenticated caller gets the
  // unauthenticated answer whatever else is wrong with the request.
  const b = body();
  const ancient = new Date(NOW.getTime() - 10 * MINT_CLOCK_SKEW_MS);
  const r = verifyMintSignature(b, sign(b, OTHER), SECRET, ancient, NOW);
  assert.equal(r.ok === false && r.refusal, 'mint_unauthorised', 'not mint_stale');
});

// ---------------------------------------------------------------------------
// The refusal a caller sees is coarser than the one that is logged
// ---------------------------------------------------------------------------

test('DONE-TEST: a wrong secret and a missing secret are ONE answer over the wire', () => {
  // The route maps an unknown channel to `secret_missing` as well. If the three were
  // distinguishable, this endpoint would enumerate which channel ids exist, unauthenticated
  // and at whatever rate the limiter allows.
  const b = body();
  const wrong = verifyMintSignature(b, sign(b, OTHER), SECRET, NOW, NOW);
  const absent = verifyMintSignature(b, sign(b), '', NOW, NOW);
  assert.equal(wrong.ok === false && wrong.refusal, absent.ok === false && absent.refusal);
  assert.notEqual(wrong.ok === false && wrong.diagnosis, absent.ok === false && absent.diagnosis);
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('a token is 256 bits of CSPRNG, url-safe, and never repeats', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const { token } = newSessionToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, token);
    assert.equal(seen.has(token), false, 'collision');
    seen.add(token);
  }
});

test('DONE-TEST: only the hash is storable, and it round-trips for lookup', () => {
  const { token, tokenSha256 } = newSessionToken();
  assert.equal(tokenSha256.length, 32);
  assert.deepEqual(sha256(token), tokenSha256, 'a presented token finds its own row');
  assert.equal(tokenSha256.includes(Buffer.from(token, 'utf8')), false, 'the hash is not the token');
});

test('a different token hashes differently', () => {
  assert.notDeepEqual(sha256('a'), sha256('b'));
});

// ---------------------------------------------------------------------------
// Client addresses
// ---------------------------------------------------------------------------

test('DONE-TEST: an IP hash is salted, so the v4 space cannot simply be enumerated', () => {
  // Unsalted, 2^32 addresses is a rainbow table somebody builds in an afternoon, and the
  // column would be an IP log wearing a hash's clothes.
  const ip = '203.0.113.7';
  assert.notDeepEqual(hashClientIp(ip, 'salt-a'), hashClientIp(ip, 'salt-b'));
  assert.deepEqual(hashClientIp(ip, 'salt-a'), hashClientIp(ip, 'salt-a'), 'stable for bucketing');
  assert.equal(hashClientIp(ip, 'salt-a').length, 16);
});

test('the salt and the address cannot be confused for one another', () => {
  // Concatenating without a separator makes ('ab','c') and ('a','bc') the same input, so a
  // salt ending in a digit could collide with an address beginning with one.
  assert.notDeepEqual(hashClientIp('1.2.3.4', 'sa'), hashClientIp('.2.3.4', 'sa1'));
});

test('IPv6 and IPv4 are both just strings here', () => {
  assert.notDeepEqual(hashClientIp('::1', 'salt'), hashClientIp('127.0.0.1', 'salt'));
});
