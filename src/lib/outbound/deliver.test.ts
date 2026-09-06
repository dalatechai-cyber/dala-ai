import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverOutbound, type DeliverDeps, type DeliverInput } from './deliver.ts';
import type { SendOutcome } from '../meta/send.ts';
import type { SecretOutcome } from '../secrets/tenantSecret.ts';

const TOKEN = 'EAAtenantOwnPageToken';

const input: DeliverInput = {
  tenantId: 't-1',
  channelId: 'c-1',
  pageId: '100000000000001',
  recipientId: '7654321098765432',
  outboundId: 'om-1',
  body: 'Сайн байна уу. Маргааш 15:00 цагт болно.',
  attempts: 0,
  graphVersion: 'v21.0',
};

const okSecret: SecretOutcome = { ok: true, secret: TOKEN, kekVersion: 1, status: 'active' };

/** Records every effect in order, so "what did this outcome cost" is checkable as a list. */
function stubDeps(over: { secret?: SecretOutcome; send?: SendOutcome } = {}) {
  const calls: string[] = [];
  const alerts: { severity: string; kind: string; dedupKey: string; body: string }[] = [];
  const sends: unknown[] = [];
  const breakerCodes: string[] = [];
  const deps: DeliverDeps = {
    onCredentialFailure: async (code) => {
      calls.push(`breaker(${code})`);
      breakerCodes.push(code);
    },
    loadSecret: async () => {
      calls.push('loadSecret');
      return over.secret ?? okSecret;
    },
    send: async (i) => {
      calls.push('send');
      sends.push(i);
      return over.send ?? { outcome: 'sent', providerMessageId: 'mid.1', recipientId: input.recipientId };
    },
    markSent: async (id) => {
      calls.push(`markSent(${id})`);
      return { ok: true };
    },
    markFailed: async (r) => {
      calls.push(`markFailed(${r})`);
      return { ok: true };
    },
    markIndeterminate: async (r) => {
      calls.push(`markIndeterminate(${r})`);
      return { ok: true };
    },
    recordSecretOk: async () => {
      calls.push('recordSecretOk');
      return { ok: true };
    },
    recordSecretError: async (c) => {
      calls.push(`recordSecretError(${c})`);
      return { ok: true };
    },
    revokeCredential: async (c) => {
      calls.push(`revokeCredential(${c})`);
      return { ok: true };
    },
    alert: async (a) => {
      calls.push(`alert(${a.kind})`);
      alerts.push(a);
      return null;
    },
  };
  return { deps, calls, alerts, sends, breakerCodes };
}

const failed = (over: Partial<Extract<SendOutcome, { outcome: 'failed' }>>): SendOutcome => ({
  outcome: 'failed',
  failure: 'unknown',
  retryable: false,
  code: null,
  subcode: null,
  status: 400,
  detail: 'graph 400',
  ...over,
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a delivered reply is marked sent and the credential is marked healthy', async () => {
  const { deps, calls, sends } = stubDeps();
  const out = await deliverOutbound(deps, input);
  assert.equal(out.outcome, 'sent');
  assert.deepEqual(calls, ['loadSecret', 'send', 'markSent(mid.1)', 'recordSecretOk']);
  // The STORED body, on the tenant's own token, to an explicit page id.
  assert.deepEqual(sends[0], {
    pageId: input.pageId,
    recipientId: input.recipientId,
    text: input.body,
    token: TOKEN,
    graphVersion: 'v21.0',
  });
});

test('markSent runs BEFORE the bookkeeping, and a bookkeeping failure does not unsend', async () => {
  // The customer receiving the message is the one irreversible thing here. Reporting a
  // failed `recordSecretOk` as a failed delivery would make the next redelivery send the
  // same reply again.
  const { deps, calls } = stubDeps();
  deps.recordSecretOk = async () => {
    calls.push('recordSecretOk');
    return { ok: false, detail: 'tenant_secrets unwritable' };
  };
  const out = await deliverOutbound(deps, input);
  assert.equal(out.outcome, 'sent');
  assert.match(out.outcome === 'sent' ? (out.bookkeeping ?? '') : '', /recordSecretOk: tenant_secrets unwritable/);
  assert.ok(calls.indexOf('markSent(mid.1)') < calls.indexOf('recordSecretOk'));
});

// ---------------------------------------------------------------------------
// The credential half
// ---------------------------------------------------------------------------

test('a 190 revokes the credential, halts the channel, and pages — once, with no period', async () => {
  const { deps, calls, alerts } = stubDeps({
    send: failed({ failure: 'token_revoked', code: 190, subcode: 463, detail: 'graph 400 code=190 subcode=463' }),
  });
  const out = await deliverOutbound(deps, input);

  assert.equal(out.outcome, 'failed');
  assert.equal(out.outcome === 'failed' && out.retryable, false, 'a 190 is NEVER retried');
  assert.ok(calls.includes('revokeCredential(190)'));
  assert.ok(!calls.some((c) => c.startsWith('recordSecretError')), 'revoke covers it; two writers would race');
  assert.equal(alerts[0]?.severity, 'critical');
  // No day in the key: this stays true until somebody re-provisions, and repeating it
  // daily would add noise to an outage rather than information.
  assert.equal(alerts[0]?.dedupKey, 'outbound.token_revoked:t-1:c-1');
  assert.match(alerts[0]?.body ?? '', /inbound is still being persisted/);
});

test('a permission error records the code against the credential and pages', async () => {
  for (const code of [200, 10]) {
    const { deps, calls, alerts } = stubDeps({
      send: failed({ failure: 'channel_permission_error', code, status: 403 }),
    });
    const out = await deliverOutbound(deps, input);
    assert.equal(out.outcome === 'failed' && out.retryable, false);
    assert.ok(calls.includes(`recordSecretError(${code})`));
    assert.ok(!calls.some((c) => c.startsWith('revokeCredential')), 'a lost scope is not a dead token');
    assert.equal(alerts[0]?.kind, 'outbound.channel_permission_error');
  }
});

test('a recipient failure NEVER touches the credential', async () => {
  // §3.4.4 on Graph 100: "do not touch token status". Writing it to
  // tenant_secrets.last_error_code would make a healthy token look sick and send an
  // operator to re-provision a credential that was never the problem.
  for (const failure of ['recipient_unreachable', 'consent_withheld', 'bot_validation'] as const) {
    const { deps, calls, alerts } = stubDeps({ send: failed({ failure, code: 100 }) });
    const out = await deliverOutbound(deps, input);
    assert.equal(out.outcome, 'failed');
    assert.ok(!calls.some((c) => c.startsWith('recordSecretError')), `${failure} must not write last_error_code`);
    assert.ok(!calls.some((c) => c.startsWith('revokeCredential')));
    assert.equal(alerts.length, 0, `${failure} is terminal and quiet`);
  }
});

// ---------------------------------------------------------------------------
// Retryability
// ---------------------------------------------------------------------------

test('rate limiting and transient failures stay claimable; everything else does not', async () => {
  const cases: [Parameters<typeof failed>[0], boolean][] = [
    [{ failure: 'rate_limited', code: 613, retryable: true }, true],
    [{ failure: 'transient', status: 503, retryable: true }, true],
    [{ failure: 'token_revoked', code: 190 }, false],
    [{ failure: 'channel_permission_error', code: 200 }, false],
    [{ failure: 'recipient_unreachable', code: 100 }, false],
    [{ failure: 'consent_withheld', code: 230 }, false],
    [{ failure: 'bot_validation', code: 9010 }, false],
    [{ failure: 'unknown' }, false],
  ];
  for (const [over, retryable] of cases) {
    const { deps, calls } = stubDeps({ send: failed(over) });
    const out = await deliverOutbound(deps, input);
    assert.equal(out.outcome === 'failed' && out.retryable, retryable, `${over.failure}`);
    // Every characterised failure releases the lease, so a legitimate retry can claim it.
    assert.ok(calls.some((c) => c.startsWith('markFailed')), `${over.failure} must release the lease`);
  }
});

// ---------------------------------------------------------------------------
// The third outcome
// ---------------------------------------------------------------------------

test('an indeterminate send is parked, never marked failed, and warns', async () => {
  const { deps, calls, alerts } = stubDeps({ send: { outcome: 'indeterminate', detail: 'send did not complete (timeout)' } });
  const out = await deliverOutbound(deps, input);
  assert.equal(out.outcome, 'indeterminate');
  assert.ok(calls.some((c) => c.startsWith('markIndeterminate')));
  assert.ok(!calls.some((c) => c.startsWith('markFailed')), 'failed is CLAIMABLE — this must not be');
  assert.ok(!calls.some((c) => c.startsWith('markSent')));
  assert.equal(alerts[0]?.kind, 'outbound.reply_indeterminate');
  assert.equal(alerts[0]?.severity, 'warn');
  // Keyed by the message, so one ambiguous send is one alert rather than one per channel.
  assert.equal(alerts[0]?.dedupKey, 'outbound.reply_indeterminate:om-1');
});

// ---------------------------------------------------------------------------
// No credential
// ---------------------------------------------------------------------------

test('an unprovisioned binding fails terminally and never reaches the network', async () => {
  const { deps, calls } = stubDeps({
    secret: { ok: false, code: 'token_missing', retryable: false, detail: 'the binding is not provisioned' },
  });
  const out = await deliverOutbound(deps, input);
  assert.equal(out.outcome === 'failed' && out.failure, 'no_credential');
  assert.equal(out.outcome === 'failed' && out.retryable, false);
  assert.ok(!calls.includes('send'), 'nothing may go out without a credential');
});

test('an unreadable secrets table is retryable — a 503 costs a retry', async () => {
  const { deps, calls } = stubDeps({
    secret: { ok: false, code: 'secret_unreadable', retryable: true, detail: 'connection reset' },
  });
  const out = await deliverOutbound(deps, input);
  assert.equal(out.outcome === 'failed' && out.retryable, true);
  assert.ok(!calls.includes('send'));
});

test('a revoked credential does not reach the network either', async () => {
  // §3.4.5: generating and delivering are both refused, but persisting inbound is not —
  // that half is the caller's, and this function does not imply it.
  const { deps, calls } = stubDeps({
    secret: { ok: false, code: 'token_revoked', retryable: false, detail: 'revoked' },
  });
  const out = await deliverOutbound(deps, input);
  assert.equal(out.outcome === 'failed' && out.retryable, false);
  assert.ok(!calls.includes('send'));
});

test('a KEK failure is critical and named apart from one bad row', async () => {
  const { deps, alerts } = stubDeps({
    secret: { ok: false, code: 'kek_unavailable', retryable: false, detail: 'kek v2: TENANT_KEK_V2 is not set' },
  });
  await deliverOutbound(deps, input);
  assert.equal(alerts[0]?.kind, 'secret.kek_unavailable');
  assert.equal(alerts[0]?.severity, 'critical');
});

test('an undecryptable row is critical too, but keyed to the one channel', async () => {
  const { deps, alerts } = stubDeps({
    secret: { ok: false, code: 'secret_undecryptable', retryable: false, detail: 'the stored binding does not match' },
  });
  await deliverOutbound(deps, input);
  assert.equal(alerts[0]?.kind, 'secret.undecryptable');
  assert.equal(alerts[0]?.dedupKey, 'secret.undecryptable:t-1:c-1');
});

test('a missing credential is not silently quiet — it still marks the row failed', async () => {
  const { deps, calls } = stubDeps({
    secret: { ok: false, code: 'token_missing', retryable: false, detail: 'not provisioned' },
  });
  await deliverOutbound(deps, input);
  assert.ok(calls.some((c) => c.startsWith('markFailed(no credential: token_missing)')));
});

test('DONE-TEST: THE BREAKER IS TOLD, AFTER THE ROW IS MARKED', async () => {
  // The breaker counts consecutive failures out of `outbound_messages`, so this attempt
  // must already be in that table before the count means anything. Calling it first would
  // make every streak one short — off by one in the direction that costs money.
  const { deps, calls, breakerCodes } = stubDeps({
    secret: { ok: false, code: 'secret_undecryptable', retryable: false, detail: 'aead' },
  });
  await deliverOutbound(deps, input);
  assert.deepEqual(breakerCodes, ['secret_undecryptable']);
  const marked = calls.findIndex((c) => c.startsWith('markFailed('));
  const told = calls.indexOf('breaker(secret_undecryptable)');
  assert.ok(marked >= 0 && told > marked, `markFailed must precede the breaker: ${calls.join(' → ')}`);
});

test('a send that works never wakes the breaker', async () => {
  const { deps, breakerCodes } = stubDeps();
  await deliverOutbound(deps, input);
  assert.deepEqual(breakerCodes, []);
});

test('no outcome ever puts the token in a recorded reason', async () => {
  const outcomes: SendOutcome[] = [
    { outcome: 'sent', providerMessageId: 'mid.1', recipientId: null },
    { outcome: 'indeterminate', detail: 'send did not complete (UND_ERR_HEADERS_TIMEOUT)' },
    failed({ failure: 'token_revoked', code: 190, detail: 'graph 400 code=190 subcode=463' }),
  ];
  for (const send of outcomes) {
    const { deps, calls, alerts } = stubDeps({ send });
    await deliverOutbound(deps, input);
    for (const line of [...calls, ...alerts.map((a) => a.body)]) {
      assert.doesNotMatch(line, new RegExp(TOKEN), line);
    }
  }
});
