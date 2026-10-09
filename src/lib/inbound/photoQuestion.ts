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
 * time for the message is earlier than the question's row plus `PHOTO_QUESTION_CROSSING_MS`,
 * and the customer has written nothing since the question: ONE text can cross it, never two.
 * `answering`: under `PHOTO_QUESTION_ANSWER_WINDOW_MS` old. `stale`: older.
 * `'unreadable'` when the read failed: the caller treats it as `answering` (the text is then an
 * answer, which at worst hands off).
 *
 * Founder, 2026-10-09, Парк Од's Page: a photo, the question at 02:18:34, then «hedve» at 02:18:36
 * and «hedve» again at 02:18:54. Both were inside the 30-second crossing window, both were read
 * as the photo's caption, and neither got a reply or told a person. The first did cross (2.4 s
 * is typing, not reading); the second is the customer asking again after reading the question,
 * which is the question's «then a person». And `burst` (any second picture or caption inside 10
 * minutes got nothing) is gone: a picture sent together with the first arrives inside the
 * crossing window; one minutes later was sent after reading the question.
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
  // The turns after the question: a customer turn there already crossed it (or answered it).
  const lastAssistant = input.priorTurns.map((t) => t.role).lastIndexOf('assistant');
  const wroteSince = input.priorTurns.slice(lastAssistant + 1).some((t) => t.role === 'user');
  if (!wroteSince && input.eventAt.getTime() < last.at.getTime() + PHOTO_QUESTION_CROSSING_MS) return 'crossed';
  const age = input.now.getTime() - last.at.getTime();
  return age < PHOTO_QUESTION_ANSWER_WINDOW_MS ? 'answering' : 'stale';
}

/**
 * The latest photo or reel question in this conversation within `PHOTO_QUESTION_ANSWER_WINDOW_MS`,
 * whether it is still the bot's last reply, and whether the customer has written since it; null
 * when there is none in the hour. For a picture: one after a question already asked in the hour
 * (with a price answered in between, or text the customer typed) is not asked again but handed
 * to a person (founder, 2026-10-09: a second photo got the question a second time).
 */
export async function readRecentMediaQuestion(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; questions: readonly string[]; now: Date },
): Promise<{ at: Date; isLastReply: boolean; customerWroteSince: boolean; dedupKey: string | null } | null | 'unreadable'> {
  if (input.questions.length === 0) return null;
  const since = new Date(input.now.getTime() - PHOTO_QUESTION_ANSWER_WINDOW_MS).toISOString();
  const { data, error } = await db.from('outbound_messages').select('body, created_at, dedup_key')
    .eq('tenant_id', input.tenantId).eq('conversation_id', input.conversationId).eq('kind', 'reply')
    .in('state', ['sent', 'draft', 'sending', 'indeterminate']).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(20);
  if (error || !Array.isArray(data)) return 'unreadable';
  const rows = data as Record<string, unknown>[];
  const i = rows.findIndex((r) => isMediaQuestion(String(r['body'] ?? ''), input.questions));
  if (i === -1) return null;
  const at = new Date(String(rows[i]?.['created_at'] ?? ''));
  if (Number.isNaN(at.getTime()) || input.now.getTime() - at.getTime() >= PHOTO_QUESTION_ANSWER_WINDOW_MS) return null;
  // Written since: a message row after the question (a picture alone has none; it is this one).
  const wrote = await db.from('messages').select('id')
    .eq('tenant_id', input.tenantId).eq('conversation_id', input.conversationId).eq('direction', 'inbound')
    .gt('at', at.toISOString()).limit(1);
  // Unreadable reads as written: the picture then goes to a person, never to silence.
  const customerWroteSince = wrote.error ? true : Array.isArray(wrote.data) && wrote.data.length > 0;
  const key = rows[i]?.['dedup_key'];
  return { at, isLastReply: i === 0, customerWroteSince, dedupKey: typeof key === 'string' ? key : null };
}
