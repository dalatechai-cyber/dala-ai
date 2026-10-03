/**
 * The two reads D-176's photo and reel questions need on the Messenger path
 * (`reception/photoPrice.ts`): the bot's latest reply and when it was made, and whether the
 * customer's text crossed the question (written before it reached them).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isMediaQuestion, PHOTO_PRICE_QUESTION_KIND, PHOTO_QUESTION_ANSWER_WINDOW_MS, PHOTO_QUESTION_CROSSING_MS, REEL_PRICE_QUESTION_KIND,
  type PhotoQuestionState,
} from '../reception/photoPrice.ts';
import { BURST_WINDOW_MS } from './imageReply.ts';

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
 * Where the conversation stands with the photo or reel question (`PhotoQuestionState`), or null
 * when the history does not end on one of the tenant's reviewed questions (then nothing is read). `crossed`: Meta's
 * time for the message is earlier than the question's row plus `PHOTO_QUESTION_CROSSING_MS`.
 * `burst`: under the image burst window (10 minutes) old, as `photoAloneStep` measures it.
 * `answering`: under `PHOTO_QUESTION_ANSWER_WINDOW_MS` old. `stale`: older.
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
  const rows = input.canned
    .filter((c) => (c.kind === PHOTO_PRICE_QUESTION_KIND || c.kind === REEL_PRICE_QUESTION_KIND) && c.reviewedAt !== null)
    .map((c) => c.body);
  if (rows.length === 0) return null;
  const lastSaid = [...input.priorTurns].reverse().find((t) => t.role === 'assistant')?.content ?? null;
  if (!isMediaQuestion(lastSaid, rows)) return null;
  const last = await readLastReply(db, input.tenantId, input.conversationId);
  if (last === 'unreadable') return 'unreadable';
  if (last === null || !isMediaQuestion(last.body, rows)) return null;
  if (input.eventAt.getTime() < last.at.getTime() + PHOTO_QUESTION_CROSSING_MS) return 'crossed';
  const age = input.now.getTime() - last.at.getTime();
  if (age < BURST_WINDOW_MS) return 'burst';
  return age < PHOTO_QUESTION_ANSWER_WINDOW_MS ? 'answering' : 'stale';
}
