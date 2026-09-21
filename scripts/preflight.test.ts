import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Distinctive values, so "did the output leak this?" is a substring search rather than a
 * judgement. Every one is a placeholder; none is a credential.
 */
const SECRETS = {
  SUPABASE_SECRET_WEBHOOK: 'sb_secret_CANARYwebhookAAAAAAAA',
  SUPABASE_SECRET_WORKER: 'sb_secret_CANARYworkerBBBBBBBB',
  SUPABASE_SECRET_PRIVACY: 'sb_secret_CANARYprivacyKKKKKKKK',
  TENANT_KEK_V1: randomBytes(32).toString('base64'),
  TENANT_KEK_V2: randomBytes(32).toString('base64'),
  META_APP_SECRETS: '{"dala":"CANARYappsecretCCCC"}',
  META_VERIFY_TOKENS: '{"dala":"CANARYverifytokenDDDD"}',
  ANTHROPIC_API_KEY: 'sk-ant-CANARYanthropicEEEEEEEE',
  IDENTITY_PEPPER: 'CANARYpepperFFFFFFFFFFFFFFFFFFFFFF',
  QSTASH_TOKEN: 'qst_CANARYqstashGGGGGGGG',
  QSTASH_CURRENT_SIGNING_KEY: 'sig_CANARYcurrentHHHHHHHH',
  QSTASH_NEXT_SIGNING_KEY: 'sig_CANARYnextIIIIIIII',
  TELEGRAM_BOT_TOKEN: '123456:CANARYtelegramJJJJJJJJ',
};

const COMPLETE: Record<string, string> = {
  DALA_ENV: 'preview',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklm.supabase.co',
  TENANT_KEK_ACTIVE_VERSION: 'v2',
  META_GRAPH_VERSION: 'v21.0',
  WORKER_PUBLIC_URL: 'https://dala.example.com',
  TELEGRAM_ALERT_CHAT_ID: '-1001234567890',
  DALA_PUBLIC_URL: 'https://dala.example.com',
  ...SECRETS,
};

/** Run preflight in a clean environment — inherited vars would make this untrustworthy. */
function preflight(env: Record<string, string>): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['scripts/preflight.ts'], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a complete environment passes, and says what it does NOT prove', () => {
  const { status, out } = preflight(COMPLETE);
  assert.equal(status, 0, out);
  assert.match(out, /All required variables are present/);
  // The sentence that stops this from being read as "we are live".
  assert.match(out, /proves nothing about Meta, Supabase, Anthropic or QStash/);
});

test('DONE-TEST: no value ever reaches the output', () => {
  // A preflight that echoes a token to prove it read one cannot be run in CI, pasted into
  // a chat, or left in a scrollback. This asserts the property rather than trusting the
  // reviewer to notice — including on the FAILURE path, where the temptation to print
  // "got: …" is strongest.
  for (const env of [COMPLETE, { ...COMPLETE, TENANT_KEK_V1: 'CANARYbrokenKEKnotbase64!!!' }]) {
    const { out } = preflight(env);
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.ok(!out.includes(value), `${name}'s value appeared in the output`);
    }
    // Not even a prefix. Four characters of a token is still four characters of a token.
    assert.ok(!out.includes('CANARY'), 'no fragment of any secret may appear');
  }
});

test('every missing variable is named, and the exit code is non-zero', () => {
  const { status, out } = preflight({});
  assert.equal(status, 1);
  for (const name of Object.keys(COMPLETE)) {
    assert.match(out, new RegExp(`MISSING\\s+${name}\\b`), name);
  }
});

test('an empty string is missing, not set', () => {
  // `SUPABASE_SECRET_WORKER=` in a deploy config is the likeliest way to have a variable
  // that exists and holds nothing. Treating it as present would push the failure to the
  // first write.
  const { status, out } = preflight({ ...COMPLETE, SUPABASE_SECRET_WORKER: '   ' });
  assert.equal(status, 1);
  assert.match(out, /MISSING\s+SUPABASE_SECRET_WORKER/);
});

test('a malformed value fails with a reason, not just a flag', () => {
  const cases: [string, string, RegExp][] = [
    ['TENANT_KEK_V1', 'abcdefghijklmnopqrstuvwxyz012345', /decoded to 24/],
    ['TENANT_KEK_ACTIVE_VERSION', 'v3', /TENANT_KEK_V3 is not set/],
    // By PATTERN, not by name: V2 had no format rule until D-107, so a mistyped active
    // key passed the deploy and failed at the first send, on a row nobody could open.
    ['TENANT_KEK_V2', 'abcdefghijklmnopqrstuvwxyz012345', /decoded to 24/],
    ['META_APP_SECRETS', '{}', /empty map/],
    ['DALA_ENV', 'prod', /production \| staging \| preview/],
    ['SUPABASE_SECRET_WORKER', 'sb_publishable_oops', /publishable key here would fail every write/],
    ['IDENTITY_PEPPER', 'short', /at least 32 random ones/],
    // The value that USED to be the fixture: a path here is appended to, not used as-is.
    ['WORKER_PUBLIC_URL', 'https://dala.example.com/api/workers/reception', /origin only, with no path/],
    ['WORKER_PUBLIC_URL', 'http://dala.example.com', /must be https/],
    ['WORKER_PUBLIC_URL', 'dala.example.com', /not a URL/],
  ];
  for (const [name, bad, expected] of cases) {
    const { status, out } = preflight({ ...COMPLETE, [name]: bad });
    assert.equal(status, 1, name);
    assert.match(out, new RegExp(`BAD\\s+${name}`), name);
    assert.match(out, expected, name);
  }
});

test('the KEK rule comes from the application, not from a second copy here', () => {
  // §6.2.6: one registry. `scripts/bakeoff/run.mjs` once carried its own copies of both
  // model ids and both price tables, free to drift — and the copy that drifts is always
  // the one that says "fine". This asserts preflight imports the real validator by
  // checking it reproduces its exact message.
  // Junk INSIDE an otherwise valid 44-character key, so it still decodes to 32 bytes and
  // the length check cannot catch it. Only the re-encode comparison in `decodeKeyMaterial`
  // does — which is the point: a mistyped key accepted as a different, working key makes
  // every row sealed under it unrecoverable, silently, until the first send.
  const valid = SECRETS.TENANT_KEK_V1;
  const withJunk = `${valid.slice(0, 10)}!!${valid.slice(10)}`;
  assert.equal(Buffer.from(withJunk, 'base64').length, 32, 'Node really does accept this');
  const { out } = preflight({ ...COMPLETE, TENANT_KEK_V1: withJunk });
  assert.match(out, /contains characters that are not base64/);
});

test('DONE-TEST: retiring the ACTIVE version does not retire the keys under it', () => {
  // The whole of what protects tenant #0's Meta token. Its `tenant_secrets` row is sealed
  // under v1 and carries `kek_version = 1`; `kekForVersion` reads the ROW's version, so
  // v1 is still opened on every request although v2 has been active since 2026-09-21. The
  // V1 value cannot be read back out of Vercel — the dashboard will not reveal it and
  // `vercel env pull` redacts it — so dropping it from the environment is not a config
  // error that can be undone, it is the permanent loss of a live client's credential.
  //
  // Nothing in `src/` can defend that: by the time the loader asks for V1 the deploy has
  // shipped. Preflight is the only thing standing in front of it, and it only stands there
  // because BOTH names are uncommented in `.env.example` — which is a property of a text
  // file, and is exactly the kind of protection that is removed by tidying.
  for (const retired of ['TENANT_KEK_V1', 'TENANT_KEK_V2']) {
    const { status, out } = preflight({ ...COMPLETE, [retired]: '' });
    assert.equal(status, 1, `${retired} was dropped and the deploy still passed:\n${out}`);
    assert.match(out, new RegExp(`MISSING\\s+${retired}`), retired);
  }
});
