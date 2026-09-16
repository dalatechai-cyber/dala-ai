/**
 * Answer a customer who sent a photograph.
 *
 * ## The measurement this exists for
 *
 * D-070 built the instrument and argued the case in the abstract: `meta/extract.ts` skips
 * an attachment with no text, and *"a photograph of the colour a customer wants — the most
 * valuable message a salon receives — would have been dropped identically"* to a thumbs-up.
 * Between 2026-09-15 and 2026-09-16 that happened **four times**, recorded as
 * `inbound_dropped` rows carrying `attachments: ["image"]` and NO `sticker_ids`. Four real
 * customers sent a picture to a hair salon and got nothing back.
 *
 * The ancestor answers them. `Matrix-Chatbot`'s PR #27 sends one fixed line saying it
 * cannot see pictures and asking for the request in words, and it has done so in production
 * for weeks. So the silence here is not a gap in a new product — it is a **measured
 * regression against the bot this one replaces**, on the surface a salon cares about most.
 *
 * ## Why a row and never the model
 *
 * The reply is one reviewed `canned_responses` row served whole, exactly as
 * `worker/comments.ts` serves its line: the model is never consulted, so nothing can be
 * inferred from an image the model cannot see. That is the ancestor's own reasoning and it
 * is also D-065's — the model keeps the job it is good at and loses the one it is not. A
 * price guessed from a photograph would be the worst kind of invented price, because the
 * customer would have every reason to believe it was read off their picture.
 *
 * ## `sticker_ids`, never `type`
 *
 * A thumbs-up must NOT be answered, and this is the whole safety of the feature. Meta sends
 * one sticker as TWO attachments and declares the first `image` (D-070), so reading `type`
 * says a photograph arrived when none did — and a bot that replies «I cannot see pictures»
 * to every thumbs-up is worse than one that says nothing. The discriminator is the
 * `sticker_id` in the PAYLOAD, which `attachmentKinds` already extracts, so a skip with any
 * `stickerIds` is never answered here no matter what its `type` claimed.
 *
 * ## One reply to a burst, and it fails OPEN
 *
 * Someone sending three reference photos sends three messages. The ancestor learned this
 * the expensive way and suppresses repeats within ten minutes; our own corpus has the same
 * shape — two images 82 seconds apart on 2026-09-15, at 16:47:10 and 16:48:32. Answering
 * each with the same paragraph reads as a broken bot, which is a poor version of the fix
 * rather than a different problem.
 *
 * Two mechanisms, deliberately: `draftOnce`'s dedup key `img:{event}:{idx}` makes a QStash
 * REDELIVERY idempotent, and the look-back below suppresses a burst spread across SEPARATE
 * events. When the look-back cannot be read the reply is drafted anyway — repeating
 * ourselves is much better than returning to the silence this file exists to end, and that
 * is the ancestor's stated posture too.
 *
 * ## What this deliberately does NOT cover
 *
 * **A photograph WITH a caption.** It carries text, so `extract` does not skip it and the
 * model answers the words alone. The ancestor treats a captioned photo as a photo,
 * precisely because *"the caption is almost always about the picture, and answering the
 * words alone is exactly how an unseen image gets quoted."* Ours does not, and that is a
 * live divergence rather than a decision — it is recorded in D-076 for the founder, because
 * changing it means routing text-bearing messages away from the model.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SkippedEvent } from '../meta/extract.ts';
import { draftOnce } from '../outbound/claim.ts';
import { ensureContact, openConversation } from './persist.ts';

/** The `canned_response_kinds` row this path serves. Added by `0026`. */
export const IMAGE_REPLY_KIND = 'image_received';

/**
 * How long one answered photograph suppresses the next.
 *
 * Ten minutes is the ancestor's measured figure, kept rather than re-derived: the failure
 * it prevents (three identical paragraphs to one person) is the same failure here, and a
 * number that already survived production is better evidence than one chosen now.
 */
export const BURST_WINDOW_MS = 10 * 60 * 1000;

export type PlannedImageReply = {
  /** Position within `entry.messaging`, half of the idempotent identity. */
  idx: number;
  /** The PSID to answer. */
  senderId: string;
};

/**
 * Which skipped events deserve a reply.
 *
 * Pure, so the rule can be read and tested without a database. Four conditions, and every
 * one of them is load-bearing:
 *
 *  - `reason === 'no_text'` — a postback or a malformed event is a different problem.
 *  - an `image` among the attachment kinds.
 *  - **no `stickerIds` at all** — see the note above; this is what keeps thumbs-ups quiet.
 *  - a `senderId`, because there is nobody to answer without one.
 *
 * At most one per sender per entry: Meta can batch several messages from one person into a
 * single `entry.messaging`, and that is a burst like any other.
 */
export function planImageReplies(skipped: readonly SkippedEvent[]): PlannedImageReply[] {
  const seen = new Set<string>();
  const out: PlannedImageReply[] = [];
  for (const s of skipped) {
    if (s.reason !== 'no_text') continue;
    if (!s.attachments.includes('image')) continue;
    if (s.stickerIds.length > 0) continue;
    if (s.senderId === null || s.senderId === '') continue;
    if (seen.has(s.senderId)) continue;
    seen.add(s.senderId);
    out.push({ idx: s.idx, senderId: s.senderId });
  }
  return out;
}

/** `img:{event}:{idx}` — stable across a redelivery, distinct across events. */
export function imageReplyDedupKey(eventId: number | string, idx: number): string {
  return `img:${eventId}:${idx}`;
}

/**
 * The tenant's image line, with its review state.
 *
 * Returned rather than applied: the CALLER decides what an unreviewed or missing row means,
 * and both are operator-visible states rather than silent degradations — a tenant with no
 * row keeps today's behaviour (silence) and says so in the log, which is strictly better
 * than inventing a sentence for them.
 */
export async function readImageLine(
  db: SupabaseClient,
  input: { tenantId: string; locale: string },
): Promise<{ ok: true; line: { body: string; reviewedAt: string | null } | null } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('canned_responses')
    .select('body, reviewed_at')
    .eq('tenant_id', input.tenantId)
    .eq('kind', IMAGE_REPLY_KIND)
    .eq('locale', input.locale)
    .maybeSingle();
  if (error) return { ok: false, detail: `canned_responses unreadable: ${error.message}` };
  if (data === null) return { ok: true, line: null };
  const row = data as Record<string, unknown>;
  return {
    ok: true,
    line: { body: String(row['body'] ?? ''), reviewedAt: row['reviewed_at'] === null ? null : String(row['reviewed_at']) },
  };
}

export type ImageReplyOutcome = {
  drafted: number;
  /** Answered already inside the burst window, so deliberately not answered again. */
  suppressed: number;
  failed: number;
  /** Set when something could not be read or written; the caller logs it. */
  detail?: string;
};

/** Has this conversation been sent the image line within the window? */
async function answeredRecently(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; now: Date },
): Promise<{ recent: boolean; unreadable: boolean }> {
  const since = new Date(input.now.getTime() - BURST_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from('outbound_messages')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('conversation_id', input.conversationId)
    .eq('kind', 'reply')
    .like('dedup_key', 'img:%')
    .gte('created_at', since)
    .limit(1);
  // Fails OPEN: an unreadable look-back must not restore the silence.
  if (error) return { recent: false, unreadable: true };
  return { recent: Array.isArray(data) && data.length > 0, unreadable: false };
}

/**
 * Draft the image line for every planned reply.
 *
 * `body` is the caller's, already read from `canned_responses` and already checked for
 * `reviewed_at` — an unreviewed row is not an approved sentence, and this path must not
 * become a way to ship Mongolian nobody signed off (D-065).
 */
export async function draftImageReplies(
  db: SupabaseClient,
  input: {
    tenantId: string;
    channelId: string;
    eventId: number | string;
    body: string;
    planned: readonly PlannedImageReply[];
    now: Date;
  },
): Promise<ImageReplyOutcome> {
  const out: ImageReplyOutcome = { drafted: 0, suppressed: 0, failed: 0 };
  if (input.planned.length === 0 || input.body === '') return out;
  const details: string[] = [];

  for (const plan of input.planned) {
    const contact = await ensureContact(db, {
      tenantId: input.tenantId, channelId: input.channelId, externalId: plan.senderId, now: input.now,
    });
    if (!contact.ok) { out.failed += 1; details.push(contact.detail); continue; }

    const conversation = await openConversation(db, {
      tenantId: input.tenantId, contactId: contact.value.contactId, channelId: input.channelId, now: input.now,
    });
    if (!conversation.ok) { out.failed += 1; details.push(conversation.detail); continue; }
    const conversationId = conversation.value.conversationId;

    const recent = await answeredRecently(db, { tenantId: input.tenantId, conversationId, now: input.now });
    if (recent.unreadable) details.push('burst look-back unreadable; drafted anyway');
    if (recent.recent) { out.suppressed += 1; continue; }

    const drafted = await draftOnce(db, {
      tenantId: input.tenantId,
      kind: 'reply',
      dedupKey: imageReplyDedupKey(input.eventId, plan.idx),
      body: input.body,
      channelId: input.channelId,
      conversationId,
    });
    if (!drafted.ok) { out.failed += 1; details.push(drafted.detail ?? 'draft failed'); continue; }
    // A redelivery that hits the unique index is not a failure and not a new answer.
    if (drafted.created === false) { out.suppressed += 1; continue; }
    out.drafted += 1;
  }

  if (details.length > 0) out.detail = details.join('; ');
  return out;
}
