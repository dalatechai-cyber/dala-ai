/**
 * The outbound claim and lease (V1.md 3.5).
 *
 * ## The property this exists to produce
 *
 * > **A redelivery re-sends the STORED text, never re-generates.**
 *
 * QStash guarantees at-least-once delivery of the job. Messenger needs at-most-once
 * delivery of the reply. Those two contradict each other unless something in the middle
 * turns "run this job again" into "finish sending the message we already wrote" — and
 * that is what the draft row does.
 *
 * Without it, a redelivery re-enters generation: a second Anthropic call (paid), a second
 * pass through the boundary gate (which may answer differently), and two different
 * replies to one customer question. With it, a redelivery finds the stored body and sends
 * exactly that, or discovers it was already sent and stops.
 *
 * ## Ambiguous failure is not failure
 *
 * The state machine has `indeterminate` as well as `failed`, and the distinction is the
 * whole reason the enum is seven states rather than five. A send that timed out **after
 * the request left** may have been delivered. Retrying it double-replies the customer;
 * marking it failed loses it. So it is neither: it is parked for a human, and automatic
 * retry refuses to touch it.
 *
 * The ancestor already learned this shape one level up — `messenger.js:118-133`
 * deliberately does not retry a *timed-out* enqueue while it does retry a *hard-failed*
 * one, because a timed-out publish may have landed. That distinction is exactly what a
 * rewrite loses, so it is carried here explicitly rather than by memory.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { toDb, type NanoUsd } from '../money.ts';

export type OutboundKind = 'reply' | 'private_reply' | 'comment_reply' | 'sms_reminder' | 'sms_winback' | 'sms_review';

export type OutboundState = 'draft' | 'claiming' | 'sending' | 'sent' | 'failed' | 'indeterminate' | 'refused';

/** States a claim may legitimately pick up. Everything else is somebody else's business. */
const CLAIMABLE: readonly OutboundState[] = ['draft', 'failed'];

/**
 * The dedup key for a reply to ONE inbound customer message.
 *
 * Exported so the two places that need it cannot drift: `reception/deps.ts` writes the
 * draft under this key, and `worker/reception.ts` asks under the same key whether a
 * redelivery has already been answered. Spelling it twice is how "already stored" and
 * "already answered" become two different strings that look like one fact.
 */
export function replyDedupKey(inboundExternalId: string): string {
  return `in:${inboundExternalId}`;
}

export type ReplyLookup =
  /** A reply to this inbound message exists — drafted, sending or sent. */
  | { outcome: 'answered'; outboundId: string; state: OutboundState }
  /** No reply exists. Whatever ran before did not get as far as drafting one. */
  | { outcome: 'absent' }
  /** The read failed. Neither answer may be assumed. */
  | { outcome: 'unavailable'; detail: string };

/**
 * Has this customer message already been answered?
 *
 * ## Why this exists, and what it replaces
 *
 * `worker/reception.ts` used to skip a redelivery whose inbound row already existed:
 *
 * ```ts
 * // "already stored, so it has already been answered or is being answered"
 * if (stored.value.duplicate) continue;
 * ```
 *
 * That premise is false, and on 2026-09-06 it cost a real message. The first attempt
 * persisted the customer's message and then died at the spend guard; QStash retried; the
 * retry saw the inbound row, skipped silently, and marked the event `processed` — a state
 * no redelivery re-drives. The message became permanently unanswerable, and every status
 * code along the way was the one the code intended.
 *
 * It is the same false inference `webhook/events.ts` documents one layer up: **a row
 * existing says a row exists.** The evidence that a reply happened is a reply.
 *
 * ## Why proceeding on `absent` cannot double-answer
 *
 * `outbound_messages` is unique on `(tenant_id, kind, dedup_key)`, so two workers racing
 * the same redelivery both attempt the insert and one loses at the database —
 * `draftOnce` then returns the winner's row rather than writing a second reply. The
 * check-then-act window is closed by the index, not by this read.
 */
export async function findReplyFor(
  db: SupabaseClient,
  input: { tenantId: string; kind: OutboundKind; dedupKey: string },
): Promise<ReplyLookup> {
  if (input.dedupKey === '') {
    // The unique index is partial on a non-empty key, so an empty one proves nothing
    // either way. Refusing is the only answer that is not a guess.
    return { outcome: 'unavailable', detail: 'empty dedup key: cannot tell whether a reply exists' };
  }

  const { data, error } = await db
    .from('outbound_messages')
    .select('id, state')
    .eq('tenant_id', input.tenantId)
    .eq('kind', input.kind)
    .eq('dedup_key', input.dedupKey)
    .maybeSingle();

  if (error) return { outcome: 'unavailable', detail: `outbound_messages unreadable: ${error.message}` };
  if (data === null) return { outcome: 'absent' };

  const row = data as Record<string, unknown>;
  return {
    outcome: 'answered',
    outboundId: String(row['id']),
    state: String(row['state']) as OutboundState,
  };
}

export type DraftRow = { id: string; body: string; state: OutboundState; attempts: number };

export type DraftOutcome =
  /** We wrote it. This is the first time this reply has existed. */
  | { ok: true; created: true; row: DraftRow }
  /** It already existed — a redelivery. The STORED body is what gets sent. */
  | { ok: true; created: false; row: DraftRow }
  | { ok: false; detail: string };

/**
 * Store the generated reply, exactly once per `(tenant, kind, dedup_key)`.
 *
 * The uniqueness is a database index, not a read-then-write: two workers racing on the
 * same redelivery both attempt the insert, one wins, and the loser reads the winner's row
 * rather than writing a second reply. A check-then-insert would let both through.
 */
export async function draftOnce(
  db: SupabaseClient,
  input: {
    tenantId: string; kind: OutboundKind; dedupKey: string; body: string;
    channelId?: string | null; conversationId?: string | null;
    /**
     * `comment_reply` only: the post the replied-to comment sits under, so the per-post
     * daily cap can be counted from the rows that already exist rather than from a second
     * table that would drift from them. A CHECK refuses it on any other kind.
     */
    commentPostId?: string | null;
  },
): Promise<DraftOutcome> {
  if (input.dedupKey === '') {
    // Without a key the unique index does not apply (it is partial), so every redelivery
    // would insert a fresh row and the customer would be answered twice.
    return { ok: false, detail: 'refusing to draft an outbound message with no dedup key' };
  }
  if (input.body.trim() === '') {
    return { ok: false, detail: 'refusing to draft an empty reply' };
  }

  const { data, error } = await db
    .from('outbound_messages')
    .insert({
      tenant_id: input.tenantId,
      channel_id: input.channelId ?? null,
      conversation_id: input.conversationId ?? null,
      kind: input.kind,
      body: input.body,
      dedup_key: input.dedupKey,
      comment_post_id: input.commentPostId ?? null,
      state: 'draft',
    })
    .select('id, body, state, attempts')
    .maybeSingle();

  if (error === null && data !== null) return { ok: true, created: true, row: data as DraftRow };

  // 23505 is unique_violation: somebody already drafted this reply. That is the
  // redelivery case and it is a SUCCESS, not an error.
  const code = (error as { code?: string } | null)?.code;
  if (code !== '23505') {
    return { ok: false, detail: `outbound draft failed: ${error?.message ?? 'insert returned no row'}` };
  }

  const { data: existing, error: readErr } = await db
    .from('outbound_messages')
    .select('id, body, state, attempts')
    .eq('tenant_id', input.tenantId)
    .eq('kind', input.kind)
    .eq('dedup_key', input.dedupKey)
    .maybeSingle();

  if (readErr) return { ok: false, detail: `existing draft unreadable: ${readErr.message}` };
  if (existing === null) {
    // The index said it exists and the read says it does not. Something is wrong with our
    // assumptions, so refuse rather than inserting a second reply on a guess.
    return { ok: false, detail: 'unique violation but no row found: refusing to write a second reply' };
  }
  return { ok: true, created: false, row: existing as DraftRow };
}

export type ClaimOutcome =
  /** It is ours to send, and the body is the one already stored. */
  | { outcome: 'claimed'; id: string; body: string; attempts: number }
  /** Somebody already sent it. Do nothing — the customer has their reply. */
  | { outcome: 'already_sent' }
  /** Another worker holds a live lease, or it is parked. Not ours; not an error. */
  | { outcome: 'not_ours'; state: OutboundState }
  | { outcome: 'unavailable'; detail: string };

/**
 * Take the message if nobody else holds it.
 *
 * The CAS is in the WHERE clause — `state in ('draft','failed')` plus an expired-or-null
 * lease — so the check and the claim cannot interleave. Doing it as a read, then a
 * decision, then a write, would let two workers both read `draft` and both send.
 */
export async function claim(
  db: SupabaseClient,
  input: { id: string; tenantId: string; now: Date; leaseMs?: number },
): Promise<ClaimOutcome> {
  const leaseMs = input.leaseMs ?? 60_000;

  const { data, error } = await db
    .from('outbound_messages')
    .update({
      state: 'sending',
      lease_until: new Date(input.now.getTime() + leaseMs).toISOString(),
    })
    .eq('id', input.id)
    .eq('tenant_id', input.tenantId)
    .in('state', CLAIMABLE as unknown as string[])
    .or(`lease_until.is.null,lease_until.lt.${input.now.toISOString()}`)
    .select('id, body, attempts')
    .maybeSingle();

  if (error) return { outcome: 'unavailable', detail: `claim failed: ${error.message}` };

  if (data !== null) {
    const row = data as { id: string; body: string; attempts: number };
    return { outcome: 'claimed', id: row.id, body: row.body, attempts: row.attempts };
  }

  // The CAS matched nothing. WHY it matched nothing decides what the caller does, and
  // "already sent" versus "someone else is sending" are very different answers.
  const { data: current, error: readErr } = await db
    .from('outbound_messages')
    .select('state')
    .eq('id', input.id)
    .eq('tenant_id', input.tenantId)
    .maybeSingle();

  if (readErr) return { outcome: 'unavailable', detail: `state unreadable: ${readErr.message}` };
  if (current === null) return { outcome: 'unavailable', detail: 'no such outbound message for this tenant' };

  const state = String((current as Record<string, unknown>)['state']) as OutboundState;
  if (state === 'sent') return { outcome: 'already_sent' };
  return { outcome: 'not_ours', state };
}

/**
 * The send succeeded. `unit_cost_nanousd` is REQUIRED — the schema's `sent_has_a_cost`
 * CHECK enforces it, and the reason is that a send whose cost we cannot state is a send
 * we did not meter. Refusing here names the problem; letting the CHECK fire names a
 * constraint.
 */
export async function markSent(
  db: SupabaseClient,
  input: { id: string; tenantId: string; providerMessageId: string; unitCost: NanoUsd; now: Date },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { error } = await db
    .from('outbound_messages')
    .update({
      state: 'sent',
      provider_message_id: input.providerMessageId,
      unit_cost_nanousd: toDb(input.unitCost),
      sent_at: input.now.toISOString(),
      lease_until: null,
    })
    .eq('id', input.id)
    .eq('tenant_id', input.tenantId)
    .eq('state', 'sending');   // CAS: only a message we hold may be marked sent.

  return error ? { ok: false, detail: `markSent failed: ${error.message}` } : { ok: true };
}

/**
 * The send failed in a way we can characterise — a 4xx with a body, a refusal, a
 * connection that never opened. Safe to retry, so the lease is released.
 */
export async function markFailed(
  db: SupabaseClient,
  input: { id: string; tenantId: string; attempts: number; reason: string },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { error } = await db
    .from('outbound_messages')
    .update({ state: 'failed', attempts: input.attempts + 1, refused_reason: input.reason, lease_until: null })
    .eq('id', input.id)
    .eq('tenant_id', input.tenantId)
    .eq('state', 'sending');
  return error ? { ok: false, detail: `markFailed failed: ${error.message}` } : { ok: true };
}

/**
 * The request left and we never learned what happened — a timeout after the bytes went
 * out, a connection reset mid-response.
 *
 * **This is NOT `failed`, and the difference is a customer's experience.** Retrying a
 * message that may have been delivered replies twice; marking it failed and moving on
 * loses a reply that may never have arrived. So it is parked: `indeterminate` is not in
 * `CLAIMABLE`, so no automatic retry can pick it up, and a human decides.
 */
export async function markIndeterminate(
  db: SupabaseClient,
  input: { id: string; tenantId: string; reason: string },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { error } = await db
    .from('outbound_messages')
    .update({ state: 'indeterminate', refused_reason: input.reason, lease_until: null })
    .eq('id', input.id)
    .eq('tenant_id', input.tenantId)
    .eq('state', 'sending');
  return error ? { ok: false, detail: `markIndeterminate failed: ${error.message}` } : { ok: true };
}

/**
 * The outbound guard refused the generated text. Recorded rather than deleted, because
 * the Quality layer reads these and a refusal that leaves no trace cannot be measured.
 * The customer still gets an answer — the tenant's pinned handoff line, drafted as its
 * own message.
 */
export async function markRefused(
  db: SupabaseClient,
  input: { id: string; tenantId: string; reason: string },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { error } = await db
    .from('outbound_messages')
    .update({ state: 'refused', refused_reason: input.reason, lease_until: null })
    .eq('id', input.id)
    .eq('tenant_id', input.tenantId)
    .in('state', ['draft', 'sending']);
  return error ? { ok: false, detail: `markRefused failed: ${error.message}` } : { ok: true };
}
