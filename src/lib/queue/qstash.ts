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
import { Client, Receiver } from '@upstash/qstash';
import { required } from '../env.ts';

export type EnqueueResult = { ok: true; messageId: string } | { ok: false; detail: string };

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
      deduplicationId: `${payload.provider}:${payload.dedupKey}`,
      retries: 3,
    });
    return { ok: true, messageId: res.messageId };
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
