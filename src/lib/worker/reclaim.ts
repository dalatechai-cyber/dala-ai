/**
 * The reception worker's reclaim job: serve the tenant's reviewed `handover_reclaim` line for
 * one held message and hand the thread back to the bot (founder, 2026-09-30).
 *
 * The hourly sweep (`handover/reclaim.ts`) decides WHICH conversations; this runs the send,
 * inside the reception worker, so it goes out through the same machinery as every reply:
 * the channel's Page and token (Instagram through its Page, D-141), `draftOnce` under the
 * key `reclaim:<mid>`, `claim`'s CAS, the person-replied re-check, and `deliver`. No model,
 * no spend. It is the same shape as the cap-refusal hand-off line (D-160): a reviewed row's
 * bytes, stored under a dedup key, claimed and sent.
 *
 * ## Everything the sweep decided is re-checked here, against fresh reads
 *
 * The job may arrive a minute or half an hour after the sweep (QStash redelivers). So before
 * anything is written: the channel still delivers; the message is inside the send window by
 * Meta's own timestamp; the thread is still `human` from an `echo`; no staff activity after
 * the message; no person reply in the stored echoes since (`personRepliedSince`); a reviewed
 * line exists.
 *
 * ## Every refusal is a 200
 *
 * Unlike an ordinary reply, nothing here is lost by waiting an hour: the next sweep re-enqueues
 * whatever is still owed. A 503 would buy a faster retry at the cost of the exhaustion page
 * (`RECEPTION_MAX_DELIVERIES`), which would tell the founder a customer "was not answered"
 * about a line that is optional by design. So an unreadable check refuses with a 200 and a
 * logged reason, and SENDS NOTHING: fail closed, retried by the schedule. A retryable send
 * failure leaves the row `failed`, which the next sweep's job claims and re-sends.
 *
 * ## Send, then flip
 *
 * The flip is conditional in SQL: `human`, and no staff activity since the customer's
 * message. A staff echo landing between the send and the flip wins, and the thread stays
 * theirs. A crash between the two leaves the row `sent`; the next job's claim answers
 * `already_sent` and only the flip runs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { conversationForPsid } from '../handover/record.ts';
import { personRepliedSince } from '../handover/presend.ts';
import { readCannedLine } from '../handover/media.ts';
import { RECLAIM_KIND, RECLAIM_MAX_AGE_MINUTES, reclaimDedupKey } from '../handover/reclaim.ts';
import { claim, draftOnce, findReplyFor } from '../outbound/claim.ts';
import { isFresh } from './freshness.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import type { DeliverArgs, JobResult, WorkerEffects } from './reception.ts';

export type ReclaimServeInput = {
  tenantId: string;
  channelId: string;
  eventId: number;
  provider: string;
  locale: string;
  /** The held message, from the stored entry. Null when the entry does not carry it. */
  message: { senderId: string; externalId: string; sentAt: Date } | null;
  /** `delivery.deliver`: a live channel. Shadow testers are NOT included: a reclaim is live-only. */
  deliverable: boolean;
  ourAppId: string | null;
  automationTexts: readonly string[];
  /** Everything `deliver` needs except the row. */
  send: Omit<DeliverArgs, 'outboundId' | 'body' | 'attempts' | 'recipientId'>;
};

const done = (body: Record<string, unknown>): JobResult => ({ status: 200, body: { ok: true, reclaim: true, ...body } });

export async function serveReclaim(
  fx: Pick<WorkerEffects, 'db' | 'now' | 'deliver' | 'log' | 'flagQuality' | 'alertNeedsPerson'>,
  input: ReclaimServeInput,
): Promise<JobResult> {
  const { db, now } = fx;
  const { tenantId, channelId } = input;
  const refuse = (reason: string, fields: Record<string, unknown> = {}, level: 'info' | 'error' = 'info'): JobResult => {
    fx.log(level, `reclaim_${reason}`, { tenantId, channelId, eventId: input.eventId, ...fields });
    return done({ refused: reason });
  };

  if (!input.deliverable) return refuse('not_delivering');
  const message = input.message;
  if (message === null) return refuse('message_missing', {}, 'error');
  const mid = message.externalId;
  // Meta's own timestamp: the window is Meta's. An unparseable time is not inside it.
  if (!isFresh(message.sentAt, now, RECLAIM_MAX_AGE_MINUTES)) return refuse('outside_window', { mid });

  const conversationId = await conversationForPsid(db, { tenantId, channelId, psid: message.senderId });
  if (conversationId === 'unreadable') return refuse('unreadable', { what: 'conversation' }, 'error');
  if (conversationId === null) return refuse('conversation_missing', { mid }, 'error');

  const [convRes, msgRes] = await Promise.all([
    db.from('conversations').select('thread_control, thread_control_source, thread_control_at')
      .eq('tenant_id', tenantId).eq('id', conversationId).maybeSingle(),
    db.from('messages').select('at')
      .eq('tenant_id', tenantId).eq('conversation_id', conversationId).eq('external_id', mid).eq('direction', 'inbound')
      .maybeSingle(),
  ]);
  if (convRes.error || convRes.data === null || msgRes.error) return refuse('unreadable', { what: 'thread or message' }, 'error');
  if (msgRes.data === null) return refuse('message_missing', { mid }, 'error');
  const conv = convRes.data as Record<string, unknown>;
  const msgAt = new Date(String((msgRes.data as Record<string, unknown>)['at'] ?? ''));
  const controlAt = typeof conv['thread_control_at'] === 'string' ? new Date(conv['thread_control_at']) : null;
  if (Number.isNaN(msgAt.getTime()) || (controlAt !== null && Number.isNaN(controlAt.getTime()))) {
    return refuse('unreadable', { what: 'times' }, 'error');
  }
  // Already the bot's: a flip that already happened, or a thread nobody held.
  if (conv['thread_control'] !== 'human') return refuse('not_human', { conversationId });
  // Staff acted after the customer wrote (or when is unknown): the thread is theirs.
  if (controlAt === null || controlAt.getTime() >= msgAt.getTime()) return refuse('staff_active', { conversationId });
  // Only an echo-held thread is sent to; see `handover/reclaim.ts` for why not `handover`.
  if (conv['thread_control_source'] !== 'echo') return refuse('not_echo', { conversationId });

  const dedupKey = reclaimDedupKey(mid);
  const existing = await findReplyFor(db, { tenantId, kind: 'reply', dedupKey });
  if (existing.outcome === 'unavailable') return refuse('unreadable', { what: 'reclaim row', detail: existing.detail }, 'error');

  let sent = existing.outcome === 'answered' && existing.state === 'sent';
  if (!sent) {
    if (existing.outcome === 'answered' && existing.state !== 'draft' && existing.state !== 'failed') {
      // `sending`, `claiming`, `refused` or a parked `indeterminate`: not ours to touch.
      return refuse('row_not_claimable', { conversationId, state: existing.state });
    }
    const spoke = await personRepliedSince(db, {
      tenantId, channelId, conversationId, psid: message.senderId, eventId: input.eventId, since: msgAt,
      ourAppId: input.ourAppId, automationTexts: input.automationTexts,
    }).catch((e: unknown) => ({ replied: 'unreadable' as const, detail: e instanceof Error ? e.message : String(e) }));
    // Unlike the ordinary send, unreadable REFUSES: this line is optional, and talking over a
    // person on the strength of a failed read is the failure this whole path must not add.
    if (spoke.replied === 'unreadable') return refuse('unreadable', { what: 'person check', detail: spoke.detail }, 'error');
    if (spoke.replied === true) {
      await fx.flagQuality({ tenantId, conversationId, code: 'reclaim_person_replied', detail: `reclaim not sent: ${spoke.detail}` });
      return refuse('person_replied', { conversationId, via: spoke.via });
    }

    const line = await readCannedLine(db, { tenantId, locale: input.locale, kind: RECLAIM_KIND });
    if (!line.ok) return refuse('unreadable', { what: 'reclaim line', detail: line.detail }, 'error');
    if (line.line === null || !line.line.reviewed || line.line.body.trim() === '') return refuse('no_reviewed_line', { conversationId });

    const drafted = await draftOnce(db, {
      tenantId, kind: 'reply', dedupKey, body: line.line.body, channelId, conversationId,
    });
    if (!drafted.ok) return refuse('draft_failed', { conversationId, detail: drafted.detail }, 'error');
    const held = await claim(db, { id: drafted.row.id, tenantId, now });
    if (held.outcome === 'unavailable') return refuse('unreadable', { what: 'claim', detail: held.detail }, 'error');
    if (held.outcome === 'not_ours') return refuse('row_not_claimable', { conversationId, state: held.state });
    if (held.outcome === 'claimed') {
      // The STORED bytes: a row drafted by an earlier attempt is sent as it was written.
      const delivered: DeliverOutcome = await fx.deliver({
        ...input.send, recipientId: message.senderId, outboundId: held.id, body: held.body, attempts: held.attempts,
      });
      if (delivered.outcome !== 'sent') {
        // `failed` is re-claimed by the next sweep's job; `indeterminate` is parked and
        // alerted by `deliver`. Neither flips the thread.
        return refuse('not_sent', {
          conversationId, outcome: delivered.outcome,
          ...(delivered.outcome === 'failed' ? { failure: delivered.failure, retryable: delivered.retryable } : {}),
        }, 'error');
      }
    }
    sent = true; // claimed and sent now, or `already_sent` by an earlier attempt
  }

  // --- Hand the thread back. Conditional, so a staff echo that landed meanwhile wins. ------
  const flip = await db.from('conversations')
    .update({ thread_control: 'bot', thread_control_source: 'reclaim', thread_control_at: now.toISOString() })
    .eq('tenant_id', tenantId).eq('id', conversationId)
    .eq('thread_control', 'human').lt('thread_control_at', msgAt.toISOString())
    .select('id');
  if (flip.error) {
    // Sent and not flipped: the next sweep sees the `sent` row and finishes it.
    return refuse('flip_failed', { conversationId, detail: flip.error.message }, 'error');
  }
  const flipped = Array.isArray(flip.data) && flip.data.length > 0;
  if (!flipped) return refuse('flip_lost_race', { conversationId });

  fx.log('info', 'reclaim_sent', { tenantId, conversationId, mid, resumed: existing.outcome === 'answered' });
  await fx.flagQuality({
    tenantId, conversationId, code: 'handover_reclaim',
    detail: 'staff held the chat two opening hours without replying: the reviewed line was sent and the bot resumed',
  });
  await fx.alertNeedsPerson({ tenantId, conversationId, reason: 'reclaim_sent', provider: input.provider, sent: 'yes' });
  return done({ sent, flipped, conversationId });
}
