import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  aadFor,
  channelKeyOf,
  EnvelopeError,
  KEY_BYTES,
  NIL_UUID,
  newDek,
  open,
  openForRow,
  seal,
  sealForRow,
} from './envelope.ts';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CHANNEL_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHANNEL_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TOKEN = Buffer.from('EAAG1234567890abcdefghijklmnopqrstuvwxyz', 'utf8');

const aadA = aadFor({ tenantId: TENANT_A, channelId: CHANNEL_A, kind: 'page_token' });
const aadB = aadFor({ tenantId: TENANT_B, channelId: CHANNEL_B, kind: 'page_token' });

test('a sealed secret round-trips byte for byte', () => {
  const key = newDek();
  const out = open(seal(TOKEN, key, aadA), key, aadA);
  assert.deepEqual(out, TOKEN);
});

test('the ciphertext is longer than the plaintext by exactly the IV and tag', () => {
  // Pinned because the layout is what `open` slices by. A change here that is not a
  // deliberate format change makes every existing row unreadable.
  const sealed = seal(TOKEN, newDek(), aadA);
  assert.equal(sealed.length, TOKEN.length + 12 + 16);
});

test('two seals of the same secret under the same key differ — the IV is random', () => {
  const key = newDek();
  const one = seal(TOKEN, key, aadA);
  const two = seal(TOKEN, key, aadA);
  assert.notDeepEqual(one, two);
  // Both still open. Determinism is what we are refusing, not correctness.
  assert.deepEqual(open(one, key, aadA), TOKEN);
  assert.deepEqual(open(two, key, aadA), TOKEN);
});

test("tenant A's ciphertext copied onto tenant B's row does not decrypt", () => {
  // THE reason the AAD exists. A leaked service key holds BYPASSRLS and can UPDATE this
  // table; without the binding, one column copy is a complete credential transfer and the
  // reply goes out as the wrong salon with a 200 OK.
  const key = newDek();
  const sealed = seal(TOKEN, key, aadA);
  assert.throws(() => open(sealed, key, aadB), (e: unknown) => e instanceof EnvelopeError && e.code === 'auth_failed');
});

test('the same tenant and channel with a different KIND is also a different row', () => {
  const key = newDek();
  const page = aadFor({ tenantId: TENANT_A, channelId: CHANNEL_A, kind: 'page_token' });
  const appSecret = aadFor({ tenantId: TENANT_A, channelId: CHANNEL_A, kind: 'app_secret' });
  assert.throws(() => open(seal(TOKEN, key, page), key, appSecret), /did not authenticate/);
});

test('a single flipped bit anywhere is refused, not decrypted', () => {
  const key = newDek();
  const sealed = seal(TOKEN, key, aadA);
  for (const at of [0, 5, 12, 20, 28, sealed.length - 1]) {
    const tampered = Buffer.from(sealed);
    tampered.writeUInt8(tampered.readUInt8(at) ^ 0x01, at);
    assert.throws(
      () => open(tampered, key, aadA),
      (e: unknown) => e instanceof EnvelopeError && e.code === 'auth_failed',
      `byte ${at} should not have survived tampering`,
    );
  }
});

test('the wrong key fails with the same code as the wrong binding', () => {
  // Deliberately indistinguishable. Telling them apart is a decryption oracle for anyone
  // who can write rows, and no operator action differs between the two.
  const sealed = seal(TOKEN, newDek(), aadA);
  const wrongKey = (() => {
    try {
      open(sealed, newDek(), aadA);
      return null;
    } catch (e) {
      return e as EnvelopeError;
    }
  })();
  const wrongAad = (() => {
    try {
      open(sealed, newDek(), aadB);
      return null;
    } catch (e) {
      return e as EnvelopeError;
    }
  })();
  assert.equal(wrongKey?.code, 'auth_failed');
  assert.equal(wrongAad?.code, 'auth_failed');
  assert.equal(wrongKey?.message, wrongAad?.message);
});

test('a truncated value is refused by shape rather than attempted', () => {
  const sealed = seal(TOKEN, newDek(), aadA);
  const short = sealed.subarray(0, 20);
  assert.throws(
    () => open(short, newDek(), aadA),
    (e: unknown) => e instanceof EnvelopeError && e.code === 'bad_ciphertext_shape',
  );
  // Exactly the overhead with no ciphertext is still nothing to decrypt.
  assert.throws(() => open(sealed.subarray(0, 28), newDek(), aadA), /must exceed/);
});

test('a key of the wrong length is refused, and the error names no key material', () => {
  const short = randomBytes(16);
  try {
    seal(TOKEN, short, aadA);
    assert.fail('a 16-byte key should not have been accepted');
  } catch (e) {
    const err = e as EnvelopeError;
    assert.equal(err.code, 'bad_key_length');
    assert.match(err.message, /got 16/);
    assert.doesNotMatch(err.message, /[0-9a-f]{16}/, 'the error must not carry key bytes');
  }
  assert.throws(() => seal(TOKEN, randomBytes(KEY_BYTES + 1), aadA), /exactly 32 bytes/);
});

test('sealing nothing, or sealing unbound, is refused where the cause is still visible', () => {
  const key = newDek();
  assert.throws(
    () => seal(Buffer.alloc(0), key, aadA),
    (e: unknown) => e instanceof EnvelopeError && e.code === 'refused',
  );
  assert.throws(() => seal(TOKEN, key, ''), /without a binding/);
  assert.throws(() => aadFor({ tenantId: '', channelId: CHANNEL_A, kind: 'page_token' }), /bind to nothing/);
  assert.throws(() => aadFor({ tenantId: TENANT_A, channelId: CHANNEL_A, kind: '' }), /bind to nothing/);
});

test("a null channel_id becomes the nil UUID, matching Postgres's generated channel_key", () => {
  // The PK is (tenant_id, channel_key, kind) and channel_key coalesces null to the nil
  // UUID. If the AAD disagreed, "which row is this" would have two answers and a
  // platform-wide kind would be sealed under a binding its own primary key contradicts.
  assert.equal(channelKeyOf(null), NIL_UUID);
  assert.equal(channelKeyOf(undefined), NIL_UUID);
  assert.equal(channelKeyOf(''), NIL_UUID);
  assert.equal(channelKeyOf(CHANNEL_A), CHANNEL_A);
  assert.equal(
    aadFor({ tenantId: TENANT_A, channelId: null, kind: 'app_secret' }),
    `${TENANT_A}|${NIL_UUID}|app_secret`,
  );
});

test('the AAD format is pinned — changing it makes every existing row undecryptable', () => {
  assert.equal(aadFor({ tenantId: TENANT_A, channelId: CHANNEL_A, kind: 'page_token' }), `${TENANT_A}|${CHANNEL_A}|page_token`);
});

test('sealForRow / openForRow round-trip, and neither half is reusable elsewhere', () => {
  const kek = randomBytes(KEY_BYTES);
  const row = sealForRow(TOKEN, kek, aadA);
  assert.deepEqual(openForRow({ ...row, kek, aad: aadA }), TOKEN);

  // Both halves carry the same binding, so there is no combination that half-works: the
  // wrapped DEK is checked first and refuses before the ciphertext is even parsed.
  assert.throws(() => openForRow({ ...row, kek, aad: aadB }), /did not authenticate/);
  assert.throws(() => openForRow({ ...row, kek: randomBytes(KEY_BYTES), aad: aadA }), /did not authenticate/);
});

test("another row's wrapped_dek cannot be pasted onto this row's ciphertext", () => {
  const kek = randomBytes(KEY_BYTES);
  const a = sealForRow(TOKEN, kek, aadA);
  const b = sealForRow(TOKEN, kek, aadB);
  // Same KEK, same secret, different rows. The DEKs are different and the AADs are
  // different, so a mix-and-match fails on the binding before it can fail on the key.
  assert.throws(() => openForRow({ ciphertext: a.ciphertext, wrappedDek: b.wrappedDek, kek, aad: aadA }), /did not authenticate/);
  assert.throws(() => openForRow({ ciphertext: a.ciphertext, wrappedDek: b.wrappedDek, kek, aad: aadB }), /did not authenticate/);
});

test('every row gets a different DEK', () => {
  const kek = randomBytes(KEY_BYTES);
  const seen = new Set<string>();
  for (let i = 0; i < 50; i += 1) seen.add(sealForRow(TOKEN, kek, aadA).wrappedDek.toString('hex'));
  assert.equal(seen.size, 50);
});

test('a Mongolian Cyrillic secret survives the round trip', () => {
  // Not a token today, but `booking_webhook_secret` is operator-supplied and this
  // codebase's rule 6 is that nothing assumes ASCII anywhere.
  const secret = Buffer.from('Матрикс-нууц-үг-Өө-Үү', 'utf8');
  const kek = randomBytes(KEY_BYTES);
  const row = sealForRow(secret, kek, aadA);
  assert.equal(openForRow({ ...row, kek, aad: aadA }).toString('utf8'), 'Матрикс-нууц-үг-Өө-Үү');
});
