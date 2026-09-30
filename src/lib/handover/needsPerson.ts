/**
 * A customer in a DM who needs a person, told to a person (Дали standard F5, K4, G4).
 *
 * ## What was wrong
 *
 * Three ways a Messenger or Instagram customer was left waiting with nobody told:
 *
 * 1. **A complaint, or «хүнтэй холбогдмоор байна».** The reply path read the tenant's own
 *    complaint rows (`comment_rules` with verdict `escalate`, D-122) only to keep the apology
 *    and drop the emoji and the sales line. The customer was answered, often with a sentence
 *    that a person will help, and no person heard of it. Comments had an alert (D-122); DMs
 *    had none.
 * 2. **The handoff line.** Every guard refusal ends at the tenant's reviewed `handoff` row
 *    (or the callback line in its place), and DalaTech's says «Хамт олон маань хариулах
 *    болно». On the Page nothing told the team. Only the website alerted (D-139).
 * 3. **A voice message.** It has no text, so `meta/extract.ts` skips it as `no_text` and the
 *    worker only recorded it as dropped (DalaTech: 8 voice messages by 2026-09-19, none
 *    answered, none alerted).
 *
 * ## Where the alert goes, for every tenant
 *
 * The founder's Telegram (`raiseAlert`, `route: 'now'`), which is the one channel this
 * platform has to a person today. No tenant has its own bot: Tara's `sales_playbooks.lead_route`
 * is `none`, and `tenant_telegram` / `page_label` are names with no sender behind them. So
 * the founder is told for Tara as for DalaTech, and passes a Tara chat to the salon. The
 * per-tenant switch `tenants.media_handoff_alert` (D-153) is deliberately NOT read here: it
 * was the founder's call about photos and links, which the salon sees in its inbox; this
 * alert exists because nobody else would be told.
 *
 * ## What it must not do
 *
 * - **Carry the customer's words.** The chat is shared with `dalatech-online`'s demo form
 *   (CLAUDE.md) and alerts are never purged: ids and the reason only, as `media.ts` does.
 * - **Page twice for one situation.** `once` per conversation, reason and Ulaanbaatar day
 *   (D-151): a customer who complains three times in an afternoon is one alert, and one who
 *   comes back angry tomorrow is a new one.
 * - **Change what the customer receives or who holds the thread.** Passing the thread to a
 *   person (F4) is not built; this only tells one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, type AlertOutcome } from '../alerts/alert.ts';
import { classifyComment, type CommentRule } from '../comments/classify.ts';
import type { SkippedEvent } from '../meta/extract.ts';
import { ubDate } from '../time/ub.ts';

export const NEEDS_PERSON_ALERT_KIND = 'conversation.needs_person';

/**
 * Why a person is needed.
 * - `complaint`: the message fired one of the tenant's own complaint rows.
 * - `handoff`: the customer was served the handoff line (or the callback line in its place).
 * - `voice`: a voice message the bot cannot play.
 */
export type NeedsPersonReason = 'complaint' | 'handoff' | 'voice';

/**
 * Is this message a complaint by the tenant's own escalate rows?
 *
 * Unlike `sales/nextStep.ts`'s `isComplaint`, a rule that cannot be parsed is NOT a
 * complaint here: that one fails towards not selling, and this one would page the founder
 * for every conversation. A malformed rule already refuses the whole comment job, which is
 * where it shows.
 */
export function complaintFires(text: string, rules: readonly CommentRule[], respelled: string | null): boolean {
  const escalate = rules.filter((r) => r.verdict === 'escalate');
  if (escalate.length === 0) return false;
  const c = classifyComment({ text, attachments: [], respelled }, escalate);
  return c.ok && c.verdict === 'escalate';
}

const WHAT: Record<NeedsPersonReason, string> = {
  complaint: 'complained or asked for a person',
  handoff: 'was told a person will help (the bot could not answer)',
  voice: 'sent a voice message the bot cannot play',
};

/** Ids and the reason only, never the customer's words (see the module docstring). */
/**
 * Did the customer get the bot's reply? `unknown` when the send is being retried or Meta's
 * answer was indeterminate: the alert must not claim either way.
 */
export type ReplySent = 'yes' | 'no' | 'unknown';

const SENT: Record<ReplySent, string> = {
  yes: 'The bot replied, but nobody has taken the chat. Open the Page inbox and answer them.\n',
  no: 'The bot sent NOTHING. Open the Page inbox and answer them.\n',
  unknown: 'The bot\'s reply may not have reached them. Open the Page inbox and answer them.\n',
};

export function needsPersonAlertBody(input: {
  tenantName: string; reason: NeedsPersonReason; channel: string; conversationId: string; sent: ReplySent;
}): string {
  return `🙋 ${input.tenantName} (${input.channel}): a customer ${WHAT[input.reason]}.\n`
    + SENT[input.sent]
    + `Conversation ${input.conversationId}`;
}

/** One situation, one alert: per conversation, reason and Ulaanbaatar day. */
export function needsPersonDedupKey(conversationId: string, reason: NeedsPersonReason, now: Date): string {
  return `needs_person:${conversationId}:${reason}:${ubDate(now)}`;
}

/** The channel as the founder reads it. */
export function channelLabel(provider: string): string {
  return provider === 'instagram' ? 'Instagram' : provider === 'web' ? 'website' : 'Messenger';
}

export async function raiseNeedsPerson(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; reason: NeedsPersonReason; provider: string; sent: ReplySent; now: Date },
): Promise<AlertOutcome> {
  // The tenant's name, not its id: the founder reads this on a phone. Unreadable is not a
  // reason to stay silent, so it falls back to the id (as `comments/complaint.ts` does).
  const { data } = await db.from('tenants').select('display_name').eq('id', input.tenantId).maybeSingle();
  const name = typeof (data as Record<string, unknown> | null)?.['display_name'] === 'string'
    ? String((data as Record<string, unknown>)['display_name'])
    : input.tenantId;
  return raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'warn',
    kind: NEEDS_PERSON_ALERT_KIND,
    dedupKey: needsPersonDedupKey(input.conversationId, input.reason, input.now),
    body: needsPersonAlertBody({
      tenantName: name, reason: input.reason, channel: channelLabel(input.provider),
      conversationId: input.conversationId, sent: input.sent,
    }),
    route: 'now',
    repeat: 'once',
  });
}

/** The reviewed line a voice message is answered with, when the tenant has one. */
export const VOICE_REPLY_KIND = 'voice_received';

export type PlannedVoice = { idx: number; senderId: string; externalId: string | null };

/**
 * The skipped messages that are a voice message with no words: Meta's `audio` attachment,
 * never a sticker (D-070: the discriminator is `stickerIds`, never the declared type). At
 * most one per sender per entry: three voice notes in one batch are one person waiting.
 */
export function planVoiceAlone(skipped: readonly SkippedEvent[]): PlannedVoice[] {
  const seen = new Set<string>();
  const out: PlannedVoice[] = [];
  for (const s of skipped) {
    if (s.reason !== 'no_text') continue;
    if (!s.attachments.includes('audio')) continue;
    if (s.stickerIds.length > 0) continue;
    if (s.senderId === null || s.senderId === '' || seen.has(s.senderId)) continue;
    seen.add(s.senderId);
    out.push({ idx: s.idx, senderId: s.senderId, externalId: s.externalId });
  }
  return out;
}

/** `voice:{event}:{idx}`: stable across a redelivery, so a retry re-sends, never re-answers. */
export function voiceDedupKey(eventId: number | string, idx: number): string {
  return `voice:${eventId}:${idx}`;
}
