import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { activeKek, activeKekVersion, decodeKeyMaterial, kekForVersion, KekError, parseKekVersion } from './kek.ts';
import { MissingEnvError } from '../env.ts';

/**
 * Set env for one test and put it back, whatever happens.
 *
 * Synchronous on purpose, and every `fn` below is synchronous. Handing this an async
 * function would restore the environment before the code under test reached its first
 * `process.env` read — see `secrets/tenantSecret.test.ts`, whose version has to await.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prior.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

test('a well-formed 32-byte base64 key decodes', () => {
  assert.equal(decodeKeyMaterial(KEY_A, 'TENANT_KEK_V1').length, 32);
  assert.deepEqual(decodeKeyMaterial(KEY_A, 'X'), Buffer.from(KEY_A, 'base64'));
});

test('surrounding whitespace is tolerated — a here-doc adds a newline', () => {
  assert.equal(decodeKeyMaterial(`  ${KEY_A}\n`, 'X').length, 32);
});

test('the URL-safe alphabet decodes to the same bytes', () => {
  const urlSafe = KEY_A.replace(/\+/g, '-').replace(/\//g, '_');
  assert.deepEqual(decodeKeyMaterial(urlSafe, 'X'), decodeKeyMaterial(KEY_A, 'X'));
});

test('a 32-CHARACTER key is refused — it is 24 bytes, not 32', () => {
  // The likeliest operator error, and the one a length check exists for: `openssl rand
  // -hex 16` looks like a key and is the wrong size once base64 has had it.
  const thirtyTwoChars = 'abcdefghijklmnopqrstuvwxyz012345';
  assert.equal(Buffer.from(thirtyTwoChars, 'base64').length, 24);
  assert.throws(
    () => decodeKeyMaterial(thirtyTwoChars, 'TENANT_KEK_V1'),
    (e: unknown) => e instanceof KekError && /decoded to 24/.test((e as Error).message),
  );
});

test('junk characters are refused rather than silently dropped', () => {
  // Buffer.from(s, 'base64') NEVER throws. It discards everything outside the alphabet
  // and returns whatever survives — so without this check a mistyped key is accepted as a
  // DIFFERENT, working key, every row sealed under it becomes unrecoverable, and nothing
  // says so until the first send.
  const withJunk = `${KEY_A.slice(0, 10)}!!${KEY_A.slice(10)}`;
  assert.equal(Buffer.from(withJunk, 'base64').length, 32, 'Node really does accept this');
  assert.throws(() => decodeKeyMaterial(withJunk, 'TENANT_KEK_V1'), /not base64/);
});

test('a quoted value — the classic .env paste — is refused', () => {
  assert.throws(() => decodeKeyMaterial(`"${KEY_A}"`, 'TENANT_KEK_V1'), /not base64/);
});

test('the version format is v<positive integer>, and nothing else', () => {
  assert.equal(parseKekVersion('v1', 'X'), 1);
  assert.equal(parseKekVersion(' v12 ', 'X'), 12);
  for (const bad of ['1', 'v0', 'v-1', 'V1', 'v1.0', 'v01', '', 'latest']) {
    assert.throws(() => parseKekVersion(bad, 'TENANT_KEK_ACTIVE_VERSION'), /must look like v1/, `${bad} should be refused`);
  }
});

test('a row names its own KEK version, and an absent one throws rather than falling back', () => {
  withEnv({ TENANT_KEK_V1: KEY_A, TENANT_KEK_V2: undefined, TENANT_KEK_ACTIVE_VERSION: 'v1' }, () => {
    assert.deepEqual(kekForVersion(1), Buffer.from(KEY_A, 'base64'));
    // The rule this pins: NO fallback to the active version, and no loop over the
    // versions that do exist. A row pointing at a key we do not hold is unreadable, and
    // saying so is the correct outcome — trying V1 for a V2 row would turn a tamper
    // signal into a success and make the unauthenticated kek_version column a lever.
    assert.throws(() => kekForVersion(2), (e: unknown) => e instanceof MissingEnvError);
  });
});

test('a non-positive or non-integer version is refused before the environment is touched', () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    assert.throws(() => kekForVersion(bad), /positive integer/);
  }
});

test('during rotation both versions are live and each opens its own rows', () => {
  withEnv({ TENANT_KEK_V1: KEY_A, TENANT_KEK_V2: KEY_B, TENANT_KEK_ACTIVE_VERSION: 'v2' }, () => {
    assert.deepEqual(kekForVersion(1), Buffer.from(KEY_A, 'base64'));
    assert.deepEqual(kekForVersion(2), Buffer.from(KEY_B, 'base64'));
    // New rows seal under the active version; old rows are still read under theirs.
    assert.equal(activeKekVersion(), 2);
    assert.deepEqual(activeKek(), { version: 2, key: Buffer.from(KEY_B, 'base64') });
  });
});

test('the active version and its key are returned together, never read separately', () => {
  // Reading the two independently is how a row gets sealed under V1 and stamped
  // kek_version = 2 — undecryptable, and only ever discovered on a read.
  withEnv({ TENANT_KEK_V1: KEY_A, TENANT_KEK_ACTIVE_VERSION: 'v1' }, () => {
    const { version, key } = activeKek();
    assert.deepEqual(kekForVersion(version), key);
  });
});

test('an active version with no key present refuses rather than sealing under nothing', () => {
  withEnv({ TENANT_KEK_V3: undefined, TENANT_KEK_ACTIVE_VERSION: 'v3' }, () => {
    assert.throws(() => activeKek(), (e: unknown) => e instanceof MissingEnvError);
  });
});

test('an empty environment variable is absent, not an empty key', () => {
  withEnv({ TENANT_KEK_V1: '', TENANT_KEK_ACTIVE_VERSION: 'v1' }, () => {
    assert.throws(() => kekForVersion(1), (e: unknown) => e instanceof MissingEnvError);
  });
});
