/**
 * The two reads D-176's photo question needs on the Messenger path (`reception/photoPrice.ts`):
 * the bot's latest reply and when it was made, and whether the customer's text crossed the
 * question (written before it reached them).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isPhotoQuestion, PHOTO_PRICE_QUESTION_KIND, PHOTO_QUESTION_ANSWER_WINDOW_MS, PHOTO_QUESTION_CROSSING_MS, type PhotoQuestionState,
} from '../reception/photoPrice.ts';

/**
 * The bot's latest reply in a conversation and when it was made. The states the history shows
 * (`sent`, `draft`), plus one being sent or parked as indeterminate: each may be in front of the
 * customer. Null when there is none.
 */
export async function readLastReply(db: SupabaseClient, tenantId: string, conversationId: string):
  Promise<{ body: string; at: Date; dedupKey: string | null } | null | 'unreadable'> {
  const { data, error } = await db.from('outbound_messages').select('body, created_at, dedup_key')
    .eq('tenant_id', tenantId).eq('conversation_id', conversationId).eq('kind', 'reply')
    .in('state', ['sent', 'draft', 'sending', 'indeterminate'])
    .order('created_at', { ascending: false }).limit(1);
  if (error) return 'unreadable';
  if (!Array.isArray(data)) return 'unreadable';
  const row = data[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const at = new Date(String(row['created_at'] ?? ''));
  if (Number.isNaN(at.getTime())) return 'unreadable';
  return { body: String(row['body'] ?? ''), at, dedupKey: typeof row['dedup_key'] === 'string' ? row['dedup_key'] : null };
}

/**
 * Where the conversation stands with the photo question (`PhotoQuestionState`), or null when the
 * history does not end on the tenant's reviewed question (then nothing is read). `crossed`: Meta's
 * time for the message is earlier than the question's row plus `PHOTO_QUESTION_CROSSING_MS`.
 * `answering`: the question is under `PHOTO_QUESTION_ANSWER_WINDOW_MS` old. `stale`: older.
 * `'unreadable'` when the read failed: the caller treats it as `answering` (the text is then an
 * answer, which at worst hands off).
 */
export async function photoQuestionState(
  db: SupabaseClient,
  input: {
    tenantId: string; conversationId: string;
    canned: readonly { kind: string; body: string; reviewedAt: string | null }[];
    priorTurns: readonly { role: 'user' | 'assistant'; content: string }[];
    eventAt: Date;
    now: Date;
  },
): Promise<PhotoQuestionState | null | 'unreadable'> {
  const row = input.canned.find((c) => c.kind === PHOTO_PRICE_QUESTION_KIND && c.reviewedAt !== null);
  if (row === undefined) return null;
  const lastSaid = [...input.priorTurns].reverse().find((t) => t.role === 'assistant')?.content ?? null;
  if (!isPhotoQuestion(lastSaid, row.body)) return null;
  const last = await readLastReply(db, input.tenantId, input.conversationId);
  if (last === 'unreadable') return 'unreadable';
  if (last === null || !isPhotoQuestion(last.body, row.body)) return null;
  if (input.eventAt.getTime() < last.at.getTime() + PHOTO_QUESTION_CROSSING_MS) return 'crossed';
  return input.now.getTime() - last.at.getTime() < PHOTO_QUESTION_ANSWER_WINDOW_MS ? 'answering' : 'stale';
}
