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
import type { RepeatPolicy } from '../alerts/alert.ts';

/**
 * What `deliverOutbound` asks the alert binding for. No route: this module reads no
 * environment, so it says what KIND of alert it is and the binding picks the route.
 *
 *  - `repeat` — the policy, when it is not the default.
 *  - `quiet`  — nobody has to act on it at once. The binding routes it with `quietRoute()`,
 *    which is `now` today and the daily report under DAILY_REPORT_V2 (D-128).
 */
export type DeliverAlert = {
  severity: 'warn' | 'critical';
  kind: string;
  dedupKey: string;
  body: string;
  repeat?: RepeatPolicy;
  quiet?: boolean;
};

/**
 * The credential episodes a delivery can open for one tenant and channel. A send that goes
 * out is evidence against every one of them, so the success path closes all four (D-128).
 * Built here, beside the raises, so the keys a resolve names are the keys a raise wrote.
 */
export function credentialEpisodeKeys(tenantId: string, channelId: string): string[] {
  return [
    `secret.kek_unavailable:${tenantId}`,
    `secret.undecryptable:${tenantId}:${channelId}`,
    `outbound.token_revoked:${tenantId}:${channelId}`,
    `outbound.channel_permission_error:${tenantId}:${channelId}`,
  ];
}

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
  /**
   * The channel's text limit in UTF-8 bytes, when it has one (Instagram: 1000, D-141). A
   * longer body goes out in parts. Absent: one message, as on Messenger.
   */
  maxTextBytes?: number;
};

export type DeliverDeps = {
  loadSecret: () => Promise<SecretOutcome>;
  send: (input: Omit<SendInput, 'fetchImpl'> & { maxBytes?: number }) => Promise<SendOutcome>;
  markSent: (providerMessageId: string) => Promise<{ ok: boolean; detail?: string }>;
  markFailed: (reason: string) => Promise<{ ok: boolean; detail?: string }>;
  markIndeterminate: (reason: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Clears `last_error_code` too: a working send is evidence the credential is healthy. */
  recordSecretOk: () => Promise<{ ok: boolean; detail?: string }>;
  /** Only ever called with a code that is ABOUT the credential. See question 2 above. */
  recordSecretError: (code: number | null) => Promise<{ ok: boolean; detail?: string }>;
  /** Graph 190 only: mark the secret revoked and stop delivery on the channel. */
  revokeCredential: (code: number) => Promise<{ ok: boolean; detail?: string }>;
  alert: (input: DeliverAlert) => Promise<unknown>;
  /**
   * Close any open credential episode under these exact keys. Called after a send that
   * went out; bookkeeping, so its failure is reported and never undoes the send.
   */
  resolveAlerts: (dedupKeys: readonly string[]) => Promise<{ ok: boolean; detail?: string }>;
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
  /**
   * Customers this channel's halt has left waiting (credential-failed replies in the last
   * 24h), for the halt page (founder, 2026-09-26). Null when it cannot be read — the page
   * still goes out, without the number.
   */
  countWaiting?: () => Promise<number | null>;
};

/** The halt page's promise, in one place so the page and the catch-up cannot disagree. */
export function waitingLine(waiting: number | null): string {
  const n = waiting === null ? 'An unknown number of' : String(waiting);
  return ` ${n} customer message(s) waiting. Each still unanswered and under 24h is answered `
    + 'automatically within an hour of the channel coming back, unless a person replies first.';
}

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
      //
      // An EPISODE (`on_change`), closed by the next send that goes out. It was a dateless
      // `daily` key until 2026-09-25, which is "once in the life of the project": a KEK
      // lost, restored and lost again was silent the second time (the inventory, B8).
      await deps.alert({
        severity: 'critical',
        kind: 'secret.kek_unavailable',
        dedupKey: `secret.kek_unavailable:${input.tenantId}`,
        body: `The KEK for tenant ${input.tenantId}'s credential is unavailable: ${secret.detail}`,
        repeat: 'on_change',
      });
    } else if (secret.code === 'secret_undecryptable') {
      await deps.alert({
        severity: 'critical',
        kind: 'secret.undecryptable',
        dedupKey: `secret.undecryptable:${input.tenantId}:${input.channelId}`,
        body: `Tenant ${input.tenantId} channel ${input.channelId}: the stored credential will not decrypt. ${secret.detail}`,
        repeat: 'on_change',
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
    ...(input.maxTextBytes === undefined ? {} : { maxBytes: input.maxTextBytes }),
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
      // Nothing to act on from the message alone — it names no conversation (inventory B10).
      quiet: true,
    });
    return { outcome: 'indeterminate', detail: sent.detail };
  }

  if (sent.outcome === 'sent') {
    // First, and its failure does not undo the send.
    const marked = await deps.markSent(sent.providerMessageId);
    const ok = await deps.recordSecretOk();
    // A send that went out is the evidence every credential episode for this channel is
    // waiting for, so they close here and the next failure pages again.
    const cleared = await deps.resolveAlerts(credentialEpisodeKeys(input.tenantId, input.channelId));
    const bookkeeping = [
      marked.ok ? null : `markSent: ${marked.detail ?? 'failed'}`,
      ok.ok ? null : `recordSecretOk: ${ok.detail ?? 'failed'}`,
      cleared.ok ? null : `resolveAlerts: ${cleared.detail ?? 'failed'}`,
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
    // After `markFailed`, so this message is one of the ones counted.
    const waiting = sent.failure === 'token_revoked' && deps.countWaiting !== undefined
      ? await deps.countWaiting().catch(() => null) : null;
    await deps.alert({
      severity: 'critical',
      kind: `outbound.${sent.failure}`,
      // No period in the key. This stays true until somebody re-provisions the channel,
      // and repeating it daily would add noise to an outage rather than information —
      // the same reasoning `model_not_found` uses in health.ts. An episode, so the first
      // send after the re-seal closes it and a second revocation pages again (B6).
      dedupKey: `outbound.${sent.failure}:${input.tenantId}:${input.channelId}`,
      repeat: 'on_change',
      body:
        sent.failure === 'token_revoked'
          ? `Tenant ${input.tenantId}: Meta rejected the page token (${sent.detail}). Outbound on channel ${input.channelId} is halted; inbound is still being persisted.`
            + (deps.countWaiting === undefined ? '' : waitingLine(waiting))
          : `Tenant ${input.tenantId}: Meta refused the send on a permission (${sent.detail}). Usually a scope lost at App Review or a task role removed.`,
    });
  }

  return { outcome: 'failed', failure: sent.failure, retryable: sent.retryable, detail: sent.detail };
}
