/**
 * Take one drafted reply and put it on the wire (V1.md 3.5).
 *
 * The last link. `claim.ts` decides whether this attempt owns the message, `send.ts`
 * decides what the wire looks like and what the answer meant, and this decides what each
 * answer costs the tenant — which row to write, which credential to distrust, and whether
 * QStash should ever try again.
 *
 * Like `reception/handle.ts` it is a pure decision over injected effects: no database
 * client, no `fetch`, no environment. Every branch below is reachable in a test without
 * standing up anything.
 *
 * ## The three questions each outcome has to answer
 *
 * 1. **What happened to the message?** `sent`, `failed` (claimable again) or
 *    `indeterminate` (parked; automatic retry may never touch it).
 * 2. **What happened to the credential?** Only three Graph codes say anything about the
 *    token — `190`, `200` and `10`. A `100` names the *recipient*, and writing it to
 *    `tenant_secrets.last_error_code` would make a perfectly healthy token look sick and
 *    send an operator to the wrong place.
 * 3. **Should the worker return retryable?** Exactly the failures that can plausibly
 *    succeed later. Everything else is terminal, because a queue retrying a permanent 4xx
 *    against the app that every tenant shares is how one tenant's dead token throttles
 *    all of them.
 *
 * ## `sent` is written before anything else is attempted
 *
 * The one irreversible thing here is the customer receiving the message. Everything after
 * it — clearing `last_error_code`, an alert — is bookkeeping, and a bookkeeping failure
 * must never turn a delivered reply into a message the next redelivery sends again. So
 * `markSent` runs first and its failure is reported without undoing the send, which is the
 * same posture `handle.ts` takes when the ledger write fails after a paid model call.
 */
import type { SendFailure, SendInput, SendOutcome } from '../meta/send.ts';
import type { SecretOutcome } from '../secrets/tenantSecret.ts';

export type DeliverInput = {
  tenantId: string;
  channelId: string;
  /** The channel's `external_id`. Never `me` — `sendMessage` refuses that itself. */
  pageId: string;
  recipientId: string;
  /** The outbound row we hold a lease on. */
  outboundId: string;
  /** The STORED body. Never regenerated here — that is the whole point of the draft row. */
  body: string;
  attempts: number;
  graphVersion: string;
};

export type DeliverDeps = {
  loadSecret: () => Promise<SecretOutcome>;
  send: (input: Omit<SendInput, 'fetchImpl'>) => Promise<SendOutcome>;
  markSent: (providerMessageId: string) => Promise<{ ok: boolean; detail?: string }>;
  markFailed: (reason: string) => Promise<{ ok: boolean; detail?: string }>;
  markIndeterminate: (reason: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Clears `last_error_code` too: a working send is evidence the credential is healthy. */
  recordSecretOk: () => Promise<{ ok: boolean; detail?: string }>;
  /** Only ever called with a code that is ABOUT the credential. See question 2 above. */
  recordSecretError: (code: number | null) => Promise<{ ok: boolean; detail?: string }>;
  /** Graph 190 only: mark the secret revoked and stop delivery on the channel. */
  revokeCredential: (code: number) => Promise<{ ok: boolean; detail?: string }>;
  alert: (input: { severity: 'warn' | 'critical'; kind: string; dedupKey: string; body: string }) => Promise<unknown>;
  /**
   * A credential failure happened. The breaker (D-036) decides whether this channel has
   * failed often enough to stop drafting, and whether the platform-wide cap is holding
   * that decision back.
   *
   * A dep rather than logic here for the reason the whole module exists: this file is a
   * pure decision over injected effects, and the breaker needs three reads and a write.
   * Its failure is deliberately not propagated — a breaker that cannot see its evidence
   * must not change what this send reports, which is already `no_credential`.
   */
  onCredentialFailure: (code: string) => Promise<void>;
};

export type DeliverOutcome =
  | { outcome: 'sent'; providerMessageId: string; bookkeeping?: string }
  | { outcome: 'indeterminate'; detail: string }
  | { outcome: 'failed'; failure: SendFailure | 'no_credential'; retryable: boolean; detail: string };

/**
 * Which failures say something about the CREDENTIAL rather than about this message.
 *
 * `100` (recipient unreachable), `230` (consent) and `9010` (bot validation) are all
 * absent on purpose: they are facts about the person being messaged, and §3.4.4 says of
 * `100` in particular "do **not** touch token status".
 */
const ABOUT_THE_CREDENTIAL: ReadonlySet<SendFailure> = new Set(['token_revoked', 'channel_permission_error']);

/** Failures worth waking someone for. The quiet ones are quiet on purpose. */
const PAGES_SOMEONE: ReadonlySet<SendFailure> = new Set(['token_revoked', 'channel_permission_error']);

export async function deliverOutbound(deps: DeliverDeps, input: DeliverInput): Promise<DeliverOutcome> {
  // 1. The credential, per request. Never cached, never an env fallback — a warm lambda is
  //    reused across tenants, and `|| process.env.PAGE_ACCESS_TOKEN` combined with `/me`
  //    is how the ancestor would post as the wrong salon.
  const secret = await deps.loadSecret();
  if (!secret.ok) {
    await deps.markFailed(`no credential: ${secret.code}`);
    if (secret.code === 'kek_unavailable') {
      // Not one tenant. Every row sealed under that KEK version, and the fix is a
      // deployment rather than a row, so it is critical and carries no tenant period.
      await deps.alert({
        severity: 'critical',
        kind: 'secret.kek_unavailable',
        dedupKey: `secret.kek_unavailable:${input.tenantId}`,
        body: `The KEK for tenant ${input.tenantId}'s credential is unavailable: ${secret.detail}`,
      });
    } else if (secret.code === 'secret_undecryptable') {
      await deps.alert({
        severity: 'critical',
        kind: 'secret.undecryptable',
        dedupKey: `secret.undecryptable:${input.tenantId}:${input.channelId}`,
        body: `Tenant ${input.tenantId} channel ${input.channelId}: the stored credential will not decrypt. ${secret.detail}`,
      });
    }
    // After the alert and after the row is marked, because the breaker reads that row: the
    // streak it counts is the sequence of failures in `outbound_messages`, so this attempt
    // has to be in it before the count means anything.
    await deps.onCredentialFailure(secret.code);
    return { outcome: 'failed', failure: 'no_credential', retryable: secret.retryable, detail: secret.detail };
  }

  // 2. The wire.
  const sent = await deps.send({
    pageId: input.pageId,
    recipientId: input.recipientId,
    text: input.body,
    token: secret.secret,
    graphVersion: input.graphVersion,
  });

  // 3. What it cost.
  if (sent.outcome === 'indeterminate') {
    // The request may have been delivered. Re-sending double-replies a customer;
    // marking it failed loses a reply that may never have arrived. Neither, therefore:
    // it is parked outside CLAIMABLE and a person decides.
    await deps.markIndeterminate(sent.detail);
    await deps.alert({
      severity: 'warn',
      kind: 'outbound.reply_indeterminate',
      dedupKey: `outbound.reply_indeterminate:${input.outboundId}`,
      body: `Tenant ${input.tenantId}: a reply may or may not have been delivered. ${sent.detail}`,
    });
    return { outcome: 'indeterminate', detail: sent.detail };
  }

  if (sent.outcome === 'sent') {
    // First, and its failure does not undo the send.
    const marked = await deps.markSent(sent.providerMessageId);
    const ok = await deps.recordSecretOk();
    const bookkeeping = [
      marked.ok ? null : `markSent: ${marked.detail ?? 'failed'}`,
      ok.ok ? null : `recordSecretOk: ${ok.detail ?? 'failed'}`,
    ]
      .filter((s): s is string => s !== null)
      .join('; ');
    return bookkeeping === ''
      ? { outcome: 'sent', providerMessageId: sent.providerMessageId }
      : { outcome: 'sent', providerMessageId: sent.providerMessageId, bookkeeping };
  }

  // A characterised failure. The message did not arrive.
  await deps.markFailed(sent.detail);

  if (sent.failure === 'token_revoked') {
    // Both writes, and they are one transition: `tenant_channels` carries
    // `check (delivery_mode <> 'live' or token_status = 'active')`, so a channel cannot
    // hold "revoked token, still delivering" at all.
    await deps.revokeCredential(sent.code ?? 190);
  } else if (ABOUT_THE_CREDENTIAL.has(sent.failure)) {
    await deps.recordSecretError(sent.code);
  }

  if (PAGES_SOMEONE.has(sent.failure)) {
    await deps.alert({
      severity: 'critical',
      kind: `outbound.${sent.failure}`,
      // No period in the key. This stays true until somebody re-provisions the channel,
      // and repeating it daily would add noise to an outage rather than information —
      // the same reasoning `model_not_found` uses in health.ts.
      dedupKey: `outbound.${sent.failure}:${input.tenantId}:${input.channelId}`,
      body:
        sent.failure === 'token_revoked'
          ? `Tenant ${input.tenantId}: Meta rejected the page token (${sent.detail}). Outbound on channel ${input.channelId} is halted; inbound is still being persisted.`
          : `Tenant ${input.tenantId}: Meta refused the send on a permission (${sent.detail}). Usually a scope lost at App Review or a task role removed.`,
    });
  }

  return { outcome: 'failed', failure: sent.failure, retryable: sent.retryable, detail: sent.detail };
}
