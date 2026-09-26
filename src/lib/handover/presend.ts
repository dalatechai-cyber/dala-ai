/**
 * Has a person replied to this customer since their message arrived? Asked immediately
 * before a live send (founder, 2026-09-25).
 *
 * H11 check 4 asks the same question BEFORE generation, and a model reply takes seconds. A
 * receptionist who answers inside those seconds is invisible to it: the bot's reply then
 * lands on top of theirs. The founder's rule: re-check before sending, and if a person has
 * replied, drop ours.
 *
 * Two sources, read together, because each covers the other's blind spot:
 *
 *  - **`conversations.thread_control`** — `human`, set or refreshed at or after the message's
 *    time. This is the settled answer, written by the echo's own job (`record.ts`), but that
 *    job runs about a second after the echo arrives.
 *  - **The echoes themselves, as stored.** The webhook route writes every delivery to
 *    `webhook_events` before anything processes it, so a staff reply that arrived a moment
 *    ago is already there even when its job has not run. Any echo to this customer on an
 *    event stored AFTER the customer's own, not sent by our app, is a person
 *    (`controlFromEcho`'s rule, the one `record.ts` applies). Read by primary key and a
 *    jsonb containment filter: measured 0.17 ms on the live table.
 *
 * What it cannot see: a reply Meta has not delivered to us yet. That gap is Meta's webhook
 * latency, usually under a second, and nothing on this side can close it.
 *
 * `unreadable` is its own answer. The caller SENDS on it and logs it, the same posture as
 * check 4: a database blip must not mute a tenant, and the cost of being wrong in that
 * direction is one reply overlapping a person — the behaviour this check exists to reduce,
 * not a new harm.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { controlFromEcho } from './control.ts';
import { isAutomationText } from './automation.ts';
import { isTemplate } from '../meta/extract.ts';
import { echoIsOursWithoutAppId, readThreadState } from './record.ts';

/** More echoes than this after one customer message is a conversation, not a race. */
const MAX_ROWS = 50;

export type PersonReplied =
  | { replied: true; via: 'thread_control' | 'echo'; detail: string }
  | { replied: false }
  | { replied: 'unreadable'; detail: string };

/** Echoes in one stored entry that a PERSON sent to this customer. */
export function personEchoesIn(
  payload: unknown, psid: string, ourAppId: string | null, automationTexts: readonly string[] = [],
): number {
  return personEchoCandidates(payload, psid, ourAppId, automationTexts).length;
}

/** An echo `personEchoesIn` counts as a person, with what is needed to double-check it. */
export type EchoCandidate = { mid: string; appId: string | null; text: string | null };

/**
 * The echoes in one stored entry that read as a person. One whose app id is absent is only a
 * CANDIDATE: `personRepliedSince` asks `echoIsOursWithoutAppId` before believing it (D-141).
 */
export function personEchoCandidates(
  payload: unknown, psid: string, ourAppId: string | null, automationTexts: readonly string[] = [],
): EchoCandidate[] {
  if (payload === null || typeof payload !== 'object') return [];
  const messaging = (payload as Record<string, unknown>)['messaging'];
  if (!Array.isArray(messaging)) return [];
  const out: EchoCandidate[] = [];
  for (const m of messaging) {
    if (m === null || typeof m !== 'object') continue;
    const ev = m as Record<string, unknown>;
    const message = ev['message'] as Record<string, unknown> | undefined;
    const recipient = ev['recipient'] as Record<string, unknown> | undefined;
    if (message?.['is_echo'] !== true || String(recipient?.['id'] ?? '') !== psid) continue;
    // A message with buttons is an app's send, never a person typing (D-143).
    if (isTemplate(message)) continue;
    const app = message['app_id'];
    const appId = typeof app === 'number' || typeof app === 'string' ? String(app) : null;
    const automated = isAutomationText(typeof message['text'] === 'string' ? message['text'] : null, automationTexts);
    if (controlFromEcho(false, appId, ourAppId, automated).control === 'human') {
      out.push({
        mid: typeof message['mid'] === 'string' ? message['mid'] : '',
        appId,
        text: typeof message['text'] === 'string' ? message['text'].normalize('NFC') : null,
      });
    }
  }
  return out;
}

export async function personRepliedSince(
  db: SupabaseClient,
  input: {
    tenantId: string; channelId: string; conversationId: string;
    /** The customer. An echo's RECIPIENT is who the Page wrote to. */
    psid: string;
    /** The customer message's own stored event: only deliveries stored after it count. */
    eventId: number;
    /** When the customer's message was sent. */
    since: Date;
    ourAppId: string | null;
    /** `tenant_channels.automation_texts`: an automated DM is not a person replying. */
    automationTexts?: readonly string[];
  },
): Promise<PersonReplied> {
  const [state, echoes] = await Promise.all([
    readThreadState(db, { tenantId: input.tenantId, conversationId: input.conversationId }),
    db.from('webhook_events')
      .select('id, raw_payload')
      .eq('tenant_id', input.tenantId)
      .eq('channel_id', input.channelId)
      .gt('id', input.eventId)
      .contains('raw_payload', { messaging: [{ recipient: { id: input.psid }, message: { is_echo: true } }] })
      .order('id', { ascending: true })
      .limit(MAX_ROWS),
  ]);

  if (state !== 'unreadable' && state.control === 'human'
      && (state.at === null || state.at.getTime() >= input.since.getTime())) {
    return {
      replied: true, via: 'thread_control',
      detail: `a person took the thread at ${state.at === null ? 'an unknown time' : state.at.toISOString()}`,
    };
  }
  if (!echoes.error) {
    for (const row of Array.isArray(echoes.data) ? echoes.data : []) {
      const r = row as Record<string, unknown>;
      for (const echo of personEchoCandidates(r['raw_payload'], input.psid, input.ourAppId, input.automationTexts ?? [])) {
        // No app id (Instagram, D-141): our own earlier reply to this customer looks exactly
        // like this until its text or mid is checked. Unreadable counts as a person, as the
        // app-id rule always has — a check that cannot run must not unmute the bot.
        if (echo.appId === null) {
          const ours = await echoIsOursWithoutAppId(db, {
            tenantId: input.tenantId, channelId: input.channelId, mid: echo.mid, text: echo.text, now: input.since,
          });
          if (ours === true) continue;
        }
        return { replied: true, via: 'echo', detail: `a person replied in webhook event ${String(r['id'])}` };
      }
    }
  }
  if (state === 'unreadable') return { replied: 'unreadable', detail: 'conversation unreadable' };
  if (echoes.error) return { replied: 'unreadable', detail: `webhook_events unreadable: ${echoes.error.message}` };
  return { replied: false };
}
