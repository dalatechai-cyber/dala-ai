/**
 * Record the inbound events this platform saw and did not answer.
 *
 * ## Why this file exists
 *
 * `meta/extract.ts` skips echoes, receipts, postbacks, malformed events and attachments
 * with no text. Its docstring said everything skipped was "reported", and the report was a
 * single `console.info` in the reception worker. Nothing else. No `quality_flags` row, no
 * `messages` row, nothing in the daily digest.
 *
 * On 2026-09-14 — the mirror's first full trading day for Matrix — that cost the corpus
 * three of fourteen deliveries, 21%. The only way to find out what they had been was to
 * read `webhook_events.raw_payload` by hand in SQL. They turned out to be thumbs-up
 * stickers, which is the one case where dropping them is right; **that is exactly the
 * point.** Nothing in the corpus distinguished three thumbs-ups from three photographs of
 * the colour a customer wanted, and the second is the most valuable message a salon can
 * receive. A mechanism whose correct behaviour and worst behaviour are indistinguishable
 * from the outside is not yet a mechanism.
 *
 * ## What is recorded and what is not
 *
 * Only skips where a CUSTOMER acted. An echo is our own message coming back and a delivery
 * receipt is Meta's bookkeeping — recording those would bury the ones that matter under
 * traffic nobody sent. `postback` and `malformed` are in, because both are a customer
 * touching the product and getting nothing, and leaving them out would rebuild this same
 * blind spot one branch over.
 *
 * ## Idempotence without a unique constraint
 *
 * `quality_flags` has no unique key and adding one is a migration, which the founder
 * pushes. A QStash retry re-parses the same payload, so the same loss would be recorded
 * twice and the digest count — the number a person actually reads — would drift up on its
 * own. The identity is `(event_id, idx)`: the stored entry and the position within it,
 * both stable across retries, and available even when Meta's `mid` is not.
 *
 * When the dedupe read itself fails, the row is written anyway and says so
 * (`detail.dedupe = 'unverified'`). Dropping it would rebuild the bug this file exists to
 * fix; writing it silently would let a duplicate pass as a distinct loss. Undetermined is
 * a result, and it belongs in the row rather than in a log nobody greps.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SkippedEvent, SkipReason } from '../meta/extract.ts';

/** The `quality_flags.flag` value. One code, with the reason inside `detail`. */
export const DROPPED_FLAG = 'inbound_dropped';

/**
 * Skips that mean a customer acted and got nothing.
 *
 * `echo` and `status_event` are deliberately absent: neither is a customer doing anything.
 */
export const UNANSWERED_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'no_text', 'postback', 'malformed',
]);

export type DroppedFlag = {
  idx: number;
  reason: SkipReason;
  externalId: string | null;
  senderId: string | null;
  attachments: string[];
  stickerIds: string[];
};

/**
 * Which skips deserve a row. Pure, so the filter is testable without a database.
 *
 * Order is `skipped`'s own, which is `entry.messaging` order — stable, and therefore safe
 * to compare between runs.
 */
export function planDroppedFlags(skipped: readonly SkippedEvent[]): DroppedFlag[] {
  return skipped
    .filter((s) => UNANSWERED_REASONS.has(s.reason))
    .map((s) => ({
      idx: s.idx,
      reason: s.reason,
      externalId: s.externalId,
      senderId: s.senderId,
      attachments: s.attachments,
      stickerIds: s.stickerIds,
    }));
}

export type DroppedRecordResult = {
  written: number;
  /** Already recorded by an earlier attempt at the same event. */
  duplicate: number;
  /** Rows whose write failed. Evidence lost, and the caller logs it. */
  failed: number;
  detail?: string;
};

/**
 * Find the conversation a dropped event belongs to, WITHOUT creating one.
 *
 * A thumbs-up must not open a conversation: `conversations` is the unit the digest, the
 * spend band and D-016's volume model all count, and a sticker that starts one would
 * inflate every number built on it. So this reads, and answers null when there is nothing
 * to attach to — which is the honest answer for a photo that arrives before any text.
 */
async function findConversation(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; senderId: string },
): Promise<string | null> {
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('channel_id', input.channelId)
    .eq('external_id', input.senderId)
    .maybeSingle();
  if (contactErr || contact === null) return null;

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('contact_id', String((contact as Record<string, unknown>)['id']))
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (convErr || conv === null) return null;
  return String((conv as Record<string, unknown>)['id']);
}

/**
 * Write one `quality_flags` row per unanswered inbound event.
 *
 * Best-effort in the same sense as every other flag in this repository: it is evidence for
 * a person to read later, never a control, and a failure here must not change what a
 * customer gets. It differs from the others in one way — a failure is COUNTED and returned,
 * because "the recorder is broken" and "nothing was dropped" reaching a reader as the same
 * silence is the failure this whole file is a repair for.
 */
export async function recordDroppedInbound(
  db: SupabaseClient,
  input: {
    tenantId: string;
    channelId: string;
    eventId: number;
    skipped: readonly SkippedEvent[];
    now: Date;
  },
): Promise<DroppedRecordResult> {
  const planned = planDroppedFlags(input.skipped);
  if (planned.length === 0) return { written: 0, duplicate: 0, failed: 0 };

  // One read for the whole entry rather than one per skip.
  const { data: seenRows, error: seenErr } = await db
    .from('quality_flags')
    .select('detail')
    .eq('tenant_id', input.tenantId)
    .eq('flag', DROPPED_FLAG)
    .contains('detail', { event_id: input.eventId });

  const dedupeOk = !seenErr;
  const seen = new Set<number>();
  if (dedupeOk && Array.isArray(seenRows)) {
    for (const row of seenRows) {
      const detail = (row as Record<string, unknown>)['detail'];
      if (detail !== null && typeof detail === 'object') {
        const idx = (detail as Record<string, unknown>)['idx'];
        if (typeof idx === 'number') seen.add(idx);
      }
    }
  }

  const result: DroppedRecordResult = { written: 0, duplicate: 0, failed: 0 };
  if (!dedupeOk) result.detail = `dedupe read failed: ${seenErr.message}`;

  for (const flag of planned) {
    if (seen.has(flag.idx)) { result.duplicate += 1; continue; }

    const conversationId = flag.senderId === null
      ? null
      : await findConversation(db, {
        tenantId: input.tenantId, channelId: input.channelId, senderId: flag.senderId,
      });

    // The PSID is NOT stored in `detail`. `conversation_id` is the link, and it is already
    // governed by the retention and deletion paths that own customer identity; a PSID
    // copied into a jsonb blob is one the data-deletion callback would never find.
    const { error } = await db.from('quality_flags').insert({
      tenant_id: input.tenantId,
      conversation_id: conversationId,
      flag: DROPPED_FLAG,
      detail: {
        reason: flag.reason,
        event_id: input.eventId,
        idx: flag.idx,
        ...(flag.externalId === null ? {} : { mid: flag.externalId }),
        ...(flag.attachments.length === 0 ? {} : { attachments: flag.attachments }),
        ...(flag.stickerIds.length === 0 ? {} : { sticker_ids: flag.stickerIds }),
        ...(dedupeOk ? {} : { dedupe: 'unverified' }),
      },
      at: input.now.toISOString(),
    });
    if (error) {
      result.failed += 1;
      result.detail = `${result.detail === undefined ? '' : `${result.detail}; `}insert failed: ${error.message}`;
    } else {
      result.written += 1;
    }
  }
  return result;
}

/**
 * A PII-free summary of what was skipped, for logs and for the worker's response body.
 *
 * `SkippedEvent` carries the PSID so a row can be tied to a conversation. The PSID must
 * never reach a log line — `contacts.external_id` is the one place it is governed — so
 * everything that leaves this process goes through here. Counts by reason, plus the
 * attachment kinds, which is what makes a thumbs-up legible as a thumbs-up.
 */
export function skipSummary(skipped: readonly SkippedEvent[]): Record<string, unknown> {
  const byReason: Record<string, number> = {};
  const kinds: string[] = [];
  for (const s of skipped) {
    byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    for (const k of s.attachments) if (!kinds.includes(k)) kinds.push(k);
  }
  return { count: skipped.length, byReason, ...(kinds.length === 0 ? {} : { kinds }) };
}
