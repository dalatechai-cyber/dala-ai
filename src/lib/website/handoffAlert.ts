/**
 * A website visitor handed to a person, told to the founder (D-139).
 *
 * Founder, 2026-09-26: *"On the website, when Дали hands off, use the approved callback line
 * (ask for name and number) and send me a Telegram alert with the visitor's question."* On
 * the Page a person reads the inbox; a widget conversation is read by nobody, so without this
 * a visitor who is not answered is not seen either — unless they leave a number, which the
 * sales record already routes (`sales/shadow.ts`).
 *
 * ## Only where the tenant's leads already go to that chat
 *
 * The platform's Telegram chat is DalaTech's own, and it is shared with the demo-request form
 * (CLAUDE.md, "Telegram is shared with the customers"). So the alert follows the playbook's
 * `lead_route`, exactly as `leadNotice` does: `founder_telegram` sends, anything else — no
 * playbook, another route — sends nothing. Another tenant's visitor never lands there.
 *
 * ## Bounded per conversation
 *
 * At most `MAX_ALERTS_PER_CONVERSATION`, counted from `quality_flags` — the same table the
 * sales record counts its own rows in. A visitor who asks five unanswerable questions is one
 * person to call, not five notifications burying the demo requests. The row carries ids and a
 * count, never the visitor's words: `quality_flags` outlives the retention purge.
 *
 * ## Never costs the visitor the reply
 *
 * The reply is already drafted. This reads, writes one flag and sends one message; every
 * failure is returned as a value and logged by the caller, and nothing here can throw into it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Playbook } from '../sales/nextStep.ts';
import { sendTelegram } from '../alerts/alert.ts';

export const WEB_HANDOFF_FLAG = 'web_handoff_alert';
export const MAX_ALERTS_PER_CONVERSATION = 3;
/** The visitor's words in the alert, in code points; longer is cut with «…». */
const QUESTION_CHARS = 300;

export type WebHandoffInput = {
  tenantId: string;
  conversationId: string;
  messageId: string;
  question: string;
  playbook: Playbook | null;
  now: Date;
};

export type WebHandoffOutcome =
  | { outcome: 'off' }
  | { outcome: 'capped' }
  | { outcome: 'sent' }
  | { outcome: 'unusable'; detail: string };

/** The Telegram text. The question is the point: somebody has to read it and act. */
export function handoffNotice(question: string, conversationId: string): string {
  const said = [...question.replace(/\s+/gu, ' ').trim()];
  const text = said.length <= QUESTION_CHARS ? said.join('') : `${said.slice(0, QUESTION_CHARS - 1).join('')}…`;
  return `🙋 Website visitor needs a person\nThey asked: «${text}»\nThey were asked for their name and number.\nConversation ${conversationId}`;
}

export async function alertWebHandoff(
  db: SupabaseClient,
  input: WebHandoffInput,
  notify: (text: string) => Promise<unknown> = sendTelegram,
): Promise<WebHandoffOutcome> {
  if (input.playbook === null || input.playbook.leadRoute !== 'founder_telegram') return { outcome: 'off' };

  const prior = await db.from('quality_flags').select('flag')
    .eq('tenant_id', input.tenantId).eq('conversation_id', input.conversationId).eq('flag', WEB_HANDOFF_FLAG)
    .limit(MAX_ALERTS_PER_CONVERSATION);
  if (prior.error) return { outcome: 'unusable', detail: `quality_flags unreadable: ${prior.error.message}` };
  const count = Array.isArray(prior.data) ? prior.data.length : 0;
  if (count >= MAX_ALERTS_PER_CONVERSATION) return { outcome: 'capped' };

  // The row first, so an alert that could not be sent is still on record.
  const row = await db.from('quality_flags').insert({
    tenant_id: input.tenantId,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    flag: WEB_HANDOFF_FLAG,
    detail: { alert: count + 1, of: MAX_ALERTS_PER_CONVERSATION },
    at: input.now.toISOString(),
  });
  if (row.error) return { outcome: 'unusable', detail: `quality_flags insert failed: ${row.error.message}` };

  const sent = await notify(handoffNotice(input.question, input.conversationId))
    .catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
  if ((sent as { ok?: boolean } | undefined)?.ok === false) {
    return { outcome: 'unusable', detail: `telegram: ${(sent as { detail?: string }).detail ?? 'not sent'}` };
  }
  return { outcome: 'sent' };
}
