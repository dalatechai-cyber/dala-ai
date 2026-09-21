/**
 * Durable hand-off to QStash, and verification of its callbacks.
 *
 * This is the one structural thing the ancestor got right: acknowledge Meta fast, then do
 * the slow work from a durable queue. Meta disables a subscription that is repeatedly slow,
 * and the model call is far slower than its patience.
 *
 * `deduplicationId` is set to `${provider}:${dedupKey}` so QStash itself refuses a duplicate
 * publish. That is a SECOND floor under `webhook_events`' unique constraint, not a
 * replacement for it: the database bounds generation, and this bounds delivery.
 */
import { createHash } from 'node:crypto';
import { Client, Receiver } from '@upstash/qstash';
import { required } from '../env.ts';

/**
 * `deduplicated` is QStash's own answer to "was this actually published?".
 *
 * A publish carrying a `deduplicationId` QStash already holds returns 200 with the ORIGINAL
 * message's id and this flag set — nothing new is queued and nothing new will be delivered.
 * It was invisible here until 2026-09-21 because the only re-publisher waited 45 minutes,
 * far outside any dedup window. `QUEUED_GRACE_MINUTES` is 10 now (D-110), which puts a
 * re-publish inside it, and `ok: true` alone would have the sweep alert say an event was
 * "re-published successfully" when QStash had refused it — a second alert misstating what
 * happened, which is the defect that lowered the grace in the first place.
 */
export type EnqueueResult =
  | { ok: true; messageId: string; deduplicated: boolean }
  | { ok: false; detail: string };

/**
 * The QStash deduplication id: a hash of the identity, not the identity itself.
 *
 * **QStash rejects `:` in a deduplicationId** — `{"error":"DeduplicationId cannot contain
 * ':'"}` — and every part of ours was colon-joined, so the very first real webhook 500'd
 * here. Found in production 2026-09-06.
 *
 * Hashing rather than re-spelling is deliberate. The obvious fix, swapping `:` for `-` or
 * `_`, silently weakens the guarantee: the components are joined without escaping, so a
 * separator that can also occur *inside* a component (an `app_slug` may contain either)
 * makes two different events capable of producing one id. sha256 over the exact string
 * this code already built is injective in practice, so the set of things QStash treats as
 * the same message is unchanged — the identity is identical, only its spelling is safe.
 *
 * The readable key is not lost: `webhook_events.dedup_key` still stores it verbatim, and
 * the job body carries `dedupKey`, so a QStash message can still be traced back to a row.
 */
export function deduplicationIdFor(provider: string, dedupKey: string): string {
  return createHash('sha256').update(`${provider}:${dedupKey}`, 'utf8').digest('hex');
}

export async function enqueueReception(payload: {
  provider: string;
  dedupKey: string;
  eventId: number;
  tenantId: string;
  channelId: string;
}): Promise<EnqueueResult> {
  try {
    const client = new Client({ token: required('QSTASH_TOKEN') });
    const res = await client.publishJSON({
      url: `${required('WORKER_PUBLIC_URL')}/api/workers/reception`,
      body: payload,
      deduplicationId: deduplicationIdFor(payload.provider, payload.dedupKey),
      retries: 3,
    });
    // `deduplicated` is optional in the SDK's type and absent on an ordinary publish, so
    // an absent flag is read as "not deduplicated" — the state every publish before this
    // change was silently assumed to be in.
    return { ok: true, messageId: res.messageId, deduplicated: res.deduplicated === true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verify a QStash callback signature.
 *
 * Both the current and next signing keys are accepted, because Upstash rotates them and a
 * callback signed with either is genuine — the same set-not-scalar reasoning as
 * META_APP_SECRETS. A worker that trusts its caller without this is an open endpoint that
 * spends money.
 */
export async function verifyQStashSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  try {
    const receiver = new Receiver({
      currentSigningKey: required('QSTASH_CURRENT_SIGNING_KEY'),
      nextSigningKey: required('QSTASH_NEXT_SIGNING_KEY'),
    });
    return await receiver.verify({ signature, body: rawBody });
  } catch {
    return false;
  }
}
