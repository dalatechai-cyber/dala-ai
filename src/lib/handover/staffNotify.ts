/**
 * The branch's own staff are told when Дали hands a chat to a person (2026-10-09, overnight
 * session; the founder's goal: «when Дали hands a chat to a person, someone AT THAT BRANCH
 * learns within minutes, with a link that opens that chat»).
 *
 * Until now every hand-off alert reached only the founder's Telegram (`alerts/alert.ts`,
 * `TELEGRAM_ALERT_CHAT_ID`), and he passed chats to the salon by hand. Tara Яармаг, 2026-09-25
 * to 2026-10-09: 60 chats got the hand-off notice and 49 of them never got a staff reply.
 *
 * ## OFF by default, switched on per branch with a ROW
 *
 * A branch is told only when it has a `handoff_targets` row (0001: `tenant_id`, `kind`,
 * `destination`, `verified_at`) with `kind = 'telegram'`, a chat id in `destination` and
 * `verified_at` set. No row, or a row not yet verified: nothing is sent and nothing changes.
 * The chat id is data, never an env var (CLAUDE.md rule 1: a client is rows), and one branch's
 * row can only ever name that branch's chat, so an alert never reaches the other owner.
 *
 * The bot is the platform's own (`TELEGRAM_BOT_TOKEN`), added to the branch's staff group.
 *
 * ## What is sent
 *
 * The branch name, what happened (an emoji), the Ulaanbaatar time and, on Messenger, a link
 * that opens the chat in Meta Business Suite's inbox. No sentence and never the customer's
 * words: Telegram keeps what it is sent, and the person opens the chat to read it anyway
 * («ids, never message text», `health/stranded.ts`). A Mongolian sentence for staff is a
 * draft for the founder to sign (`prompt/drafts/staff_handoff_alert.mn.txt`); nothing loads it.
 *
 * The link is `business.facebook.com/latest/inbox/all?asset_id=<Page id>&selected_item_id=<PSID>`.
 * Its form is the one Meta's own redirect produced for the founder (docs/proposals/
 * meta-support-page-contact-tos.md: `facebook.com/<page>/inbox/<x>/` → `…&selected_item_id=<x>`);
 * that the PSID is the id it takes could not be checked from a session (Meta is blocked here),
 * so the founder checks one link before the first branch is switched on (runbook).
 *
 * ## Never in the customer's way
 *
 * Called from the worker AFTER the response (`after()`), like the Page label: a slow database or
 * Telegram can never time out the job, get it redelivered or hold the next message. It never
 * throws. Bounded: the Telegram send has its own 5 s timeout (`sendTelegramTo`).
 *
 * ## One ping per chat per window, with a record
 *
 * Each ping opens a `handoffs` row (the conversation and the reason) and writes a
 * `staff_notifications` row saying whether Telegram accepted it. A second hand-off of the same
 * chat, for any reason, inside `STAFF_REPING_AFTER_MS` (the 30-minute takeover window) is not
 * pinged again: the staff were just told about that chat. When the record cannot be read the ping
 * is sent anyway: a duplicate in a staff chat costs nothing, a missed one leaves a customer alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, sendTelegramTo, type AlertInput, type AlertOutcome, type TelegramOutcome } from '../alerts/alert.ts';
import { tenantClock } from '../time/clock.ts';
import { ubDate } from '../time/ub.ts';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';

/** Why the chat went to a person: the media hand-off, or one of D-158's needs-person reasons. */
export type StaffHandoffReason = 'media' | 'complaint' | 'handoff' | 'voice' | 'reclaim_sent';

/** The same chat is not pinged twice inside this window (the takeover window). */
export const STAFF_REPING_AFTER_MS = 30 * 60 * 1000;

const MARK: Record<StaffHandoffReason, string> = {
  media: '📷',
  complaint: '⚠️',
  handoff: '🙋',
  voice: '🎤',
  reclaim_sent: '⏰',
};

export type StaffNotifyOutcome =
  | { outcome: 'sent'; handoffId: string | null }
  | { outcome: 'off' }
  | { outcome: 'recent'; handoffId: string }
  | { outcome: 'undelivered'; detail: string }
  | { outcome: 'failed'; detail: string };

/**
 * The Business Suite inbox link for one Messenger chat, or null when the ids are not usable.
 * Both ids are Meta's numeric ids; anything else is refused rather than put in a URL.
 */
export function inboxLink(provider: string, pageId: string, psid: string): string | null {
  if (provider !== 'facebook_page') return null;
  if (!/^\d{5,25}$/.test(pageId) || !/^\d{5,25}$/.test(psid)) return null; // ascii-safe: Meta ids are digits
  return `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}&selected_item_id=${psid}&thread_type=FB_MESSAGE`;
}

/** Where staff open the chat when there is no link: the channel's inbox, by name. */
function inboxName(provider: string | null): string {
  return provider === 'instagram' ? 'Instagram inbox' : provider === 'web' ? 'website chat' : 'Messenger / Page inbox';
}

/** The Telegram text: branch, what, when (Ulaanbaatar), and the link. No customer words. */
export function staffAlertText(input: {
  branch: string; reason: StaffHandoffReason; at: Date; link: string | null; provider?: string | null;
}): string {
  const c = tenantClock(input.at, PLATFORM_TIMEZONE);
  return `🔔 ${input.branch}\n${MARK[input.reason]} ${c.date} ${c.time}\n${input.link ?? inboxName(input.provider ?? null)}`;
}

/** A verified Telegram chat id for this branch, null when it has none (off), or 'error'. */
async function telegramTarget(db: SupabaseClient, tenantId: string): Promise<string | null | 'error'> {
  const { data, error } = await db.from('handoff_targets')
    .select('destination, verified_at').eq('tenant_id', tenantId).eq('kind', 'telegram').maybeSingle();
  if (error) return 'error';
  const row = data as Record<string, unknown> | null;
  if (row === null || row['verified_at'] === null || row['verified_at'] === undefined) return null;
  const dest = typeof row['destination'] === 'string' ? row['destination'].trim() : '';
  // A Telegram chat id is an integer (groups are negative). Anything else is not a target.
  return /^-?\d{3,20}$/.test(dest) ? dest : null; // ascii-safe: Telegram chat ids are digits
}

export type StaffNotifyDeps = {
  send?: (chatId: string, text: string) => Promise<TelegramOutcome>;
};

/**
 * Pings in flight in this instance, by conversation. One message can raise the media alert and a
 * needs-person alert at once (two `after()` tasks); the second waits for the first and then finds
 * its `handoffs` row instead of racing it to Telegram. Holds promises only, never credentials.
 */
const inFlight = new Map<string, Promise<StaffNotifyOutcome>>();

export async function notifyBranchStaff(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; reason: StaffHandoffReason; now: Date },
  deps: StaffNotifyDeps = {},
): Promise<StaffNotifyOutcome> {
  const key = `${input.tenantId}:${input.conversationId}`;
  const ahead = inFlight.get(key);
  const run = (ahead ?? Promise.resolve(null)).catch(() => null).then(() => notifyOnce(db, input, deps));
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

async function notifyOnce(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; reason: StaffHandoffReason; now: Date },
  deps: StaffNotifyDeps,
): Promise<StaffNotifyOutcome> {
  try {
    const target = await telegramTarget(db, input.tenantId);
    if (target === 'error') return { outcome: 'failed', detail: 'handoff_targets unreadable' };
    if (target === null) return { outcome: 'off' };

    // A recent DELIVERED ping about this chat, for any reason: the staff were just pointed at it.
    // (A photo hand-off can raise the media alert and a needs-person alert for the same message.)
    // A ping Telegram refused, or one cut off before its send, does not count: the next hand-off
    // of the chat tries again.
    const recent = await recentDelivered(db, input);
    if (recent !== null) return { outcome: 'recent', handoffId: recent };

    // Who and where, for the link. Unreadable is no reason to stay silent: the ping goes without it.
    const [tenant, conv] = await Promise.all([
      db.from('tenants').select('display_name').eq('id', input.tenantId).maybeSingle(),
      db.from('conversations').select('contact_id, channel_id').eq('tenant_id', input.tenantId).eq('id', input.conversationId).maybeSingle(),
    ]);
    const branch = typeof (tenant.data as Record<string, unknown> | null)?.['display_name'] === 'string'
      ? String((tenant.data as Record<string, unknown>)['display_name']) : input.tenantId;
    let link: string | null = null;
    let provider: string | null = null;
    const c = conv.data as Record<string, unknown> | null;
    if (c !== null && typeof c['contact_id'] === 'string' && typeof c['channel_id'] === 'string') {
      const [contact, channel] = await Promise.all([
        db.from('contacts').select('external_id').eq('tenant_id', input.tenantId).eq('id', c['contact_id']).maybeSingle(),
        db.from('tenant_channels').select('provider, external_id').eq('tenant_id', input.tenantId).eq('id', c['channel_id']).maybeSingle(),
      ]);
      const psid = (contact.data as Record<string, unknown> | null)?.['external_id'];
      const ch = channel.data as Record<string, unknown> | null;
      if (ch !== null && typeof ch['provider'] === 'string') provider = ch['provider'];
      if (typeof psid === 'string' && ch !== null && typeof ch['external_id'] === 'string' && provider !== null) {
        link = inboxLink(provider, ch['external_id'], psid);
      }
    }

    // The record first. `state` stays `open`: these rows record pings, and nothing yet marks a
    // chat answered (D-183). A failed insert does not stop the ping.
    const opened = await db.from('handoffs')
      .insert({ tenant_id: input.tenantId, conversation_id: input.conversationId, reason: input.reason, opened_at: input.now.toISOString() })
      .select('id').maybeSingle();
    const handoffId = opened.error ? null : String((opened.data as Record<string, unknown> | null)?.['id'] ?? '') || null;
    if (opened.error) console.error('[staff-notify] handoffs insert failed', { conversationId: input.conversationId, detail: opened.error.message });

    const send = deps.send ?? sendTelegramTo;
    const sent = await send(target, staffAlertText({ branch, reason: input.reason, at: input.now, link, provider }));

    if (handoffId !== null) {
      const { error } = await db.from('staff_notifications').insert({
        tenant_id: input.tenantId, handoff_id: handoffId, target_kind: 'telegram',
        delivered: sent.ok, provider_message_id: sent.ok ? sent.messageId : null,
      });
      if (error) console.error('[staff-notify] staff_notifications insert failed', { conversationId: input.conversationId, detail: error.message });
    }
    return sent.ok ? { outcome: 'sent', handoffId } : { outcome: 'undelivered', detail: sent.detail };
  } catch (e) {
    return { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** The id of a delivered ping about this chat inside the window, or null (none, or unreadable). */
async function recentDelivered(
  db: SupabaseClient, input: { tenantId: string; conversationId: string; now: Date },
): Promise<string | null> {
  const since = new Date(input.now.getTime() - STAFF_REPING_AFTER_MS).toISOString();
  const opened = await db.from('handoffs').select('id')
    .eq('tenant_id', input.tenantId).eq('conversation_id', input.conversationId).gte('opened_at', since);
  if (opened.error) return null;
  const ids = (opened.data ?? []).map((r) => String((r as Record<string, unknown>)['id']));
  if (ids.length === 0) return null;
  const told = await db.from('staff_notifications').select('handoff_id')
    .eq('tenant_id', input.tenantId).eq('delivered', true).in('handoff_id', ids).limit(1);
  if (told.error) return null;
  const row = (told.data ?? [])[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : String(row['handoff_id']);
}

/** One founder alert per branch and Ulaanbaatar day when its staff ping could not be delivered. */
export const STAFF_PING_UNDELIVERED_KIND = 'staff.ping_undelivered';

/**
 * The worker's call (inside `after()`): ping the branch, log what happened, and tell the founder
 * once a day per branch when a ping failed. A broken staff route (bot removed from the group, a
 * group upgraded to a supergroup, which changes its id) must not look like a quiet one. Off
 * (`off`) is logged as info and never alerts. Never throws.
 */
export async function tellBranchStaff(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; reason: StaffHandoffReason; now: Date },
  deps: StaffNotifyDeps & { alert?: (a: AlertInput) => Promise<AlertOutcome> } = {},
): Promise<StaffNotifyOutcome> {
  const told = await notifyBranchStaff(db, input, deps);
  if (told.outcome !== 'failed' && told.outcome !== 'undelivered') {
    console.info('[worker] staff_notify', { conversationId: input.conversationId, reason: input.reason, ...told });
    return told;
  }
  console.error('[worker] staff_notify_undelivered', { conversationId: input.conversationId, reason: input.reason, ...told });
  try {
    const raise = deps.alert ?? ((a: AlertInput) => raiseAlert(db, a));
    await raise({
      tenantId: input.tenantId,
      severity: 'warn',
      kind: STAFF_PING_UNDELIVERED_KIND,
      dedupKey: `staff_ping:${input.tenantId}:${ubDate(input.now)}`,
      body: `A branch's staff hand-off ping was NOT delivered (${told.detail}). Check the bot is still in the branch's Telegram group and the chat id in handoff_targets. Conversation ${input.conversationId}`,
      route: 'now',
      repeat: 'daily',
    });
  } catch (e) {
    console.error('[worker] staff_notify_alert_failed', { conversationId: input.conversationId, detail: e instanceof Error ? e.message : String(e) });
  }
  return told;
}
