/**
 * Messages that arrived while a channel was halted are answered when it comes back
 * (founder, 2026-09-26).
 *
 * ## What happened
 *
 * Tara's Page token was cancelled at 2026-09-26 01:09 UTC (Graph 190/460). The reply to the
 * message that found out — «Сайн уу танай хаяг хаана бэ», 01:09:56 — was marked `failed`,
 * the channel was halted, and a new token brought it back. Nothing then answered that
 * customer: a `failed` reply is never re-driven, and every message that arrives during a
 * halt is stored and deliberately not generated (`canDeliver`). The founder answered it by
 * hand. The rule now: *"When a channel comes back after a halt, answer the messages that
 * failed on the token error if under 24h old and no person or later reply has answered
 * since."*
 *
 * ## Which messages are "held"
 *
 * Two kinds of evidence, both written at the time, never inferred afterwards:
 *
 *  - **The reply failed on the credential.** `outbound_messages.state = 'failed'` with a
 *    Graph `code=190` reason, or the breaker's `no credential:` prefix. That is the message
 *    whose send discovered the fault.
 *  - **It arrived during the halt.** The worker writes a `held_channel_halted` quality flag,
 *    carrying the message id, when it stores a message it will not generate for BECAUSE the
 *    channel is halted (`status = 'authorization_error'`). A channel an operator switched
 *    off for another reason writes no such flag, so it is never caught up.
 *
 * ## One reply per conversation, to the LATEST message
 *
 * A customer who wrote three times during the halt gets one answer, generated with the
 * whole conversation in view, not three answers in a row. So the sweep looks at each
 * conversation's latest customer message and acts only when THAT message is held. If the
 * customer wrote again after the channel returned, the normal path answered (or deliberately
 * did not answer) the newer message, and there is nothing left to catch up.
 *
 * ## Skipped, and why each is safe
 *
 *  - **Older than 24 hours** — Meta's messaging window. Past it a send is refused anyway.
 *  - **We already replied later** — any `sent` outbound in the conversation after it.
 *  - **A person replied** — `personRepliedSince`, the same check a live send makes: a stored
 *    echo to this customer, after their message, not from our app. It reads the echoes from
 *    `webhook_events`, so it sees a hand reply typed during the halt, when `delivery_mode`
 *    was `off` and no echo could move `thread_control`. The founder's hand answer on
 *    2026-09-26 is exactly this case.
 *  - **Already attempted** — a `catch_up_enqueued` flag on the message. At most one attempt
 *    per message: whatever the worker decides, it is not re-asked every hour.
 *  - **Unreadable** — anything this sweep cannot read is skipped this run and tried next
 *    hour, never guessed. A double reply to a customer who waited is worse than an hour.
 *
 * ## How it answers
 *
 * It does not generate anything itself. It enqueues the message's own stored webhook event
 * to the reception worker with `catchUpMid`, which runs the ordinary path for that one
 * message with a 24-hour age limit instead of the tenant's, and lets a `failed` reply be
 * claimed and sent again (its stored body answers exactly that message, because it is the
 * latest). Every gate a live reply passes — the person-replied re-check before the send
 * included — still applies.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EnqueueResult } from '../queue/qstash.ts';
import { personRepliedSince, type PersonReplied } from '../handover/presend.ts';
import { CREDENTIAL_REFUSAL_PREFIX } from './breaker.ts';

/** Meta's messaging window. A held message older than this is never caught up. */
export const CATCH_UP_WINDOW_MINUTES = 24 * 60;

/** Written by the worker when a message is stored while its channel is halted. */
export const HELD_FLAG = 'held_channel_halted';

/** Written by this sweep when it hands a message to the worker. One per message, ever. */
export const CATCH_UP_FLAG = 'catch_up_enqueued';

/** Bound on each read. Sized for fifty tenants and one bad day. */
const LIMIT = 500;

/** Graph 190 (the token), or the breaker's credential prefix. Nothing else is a halt. */
export function isCredentialFailure(refusedReason: string | null | undefined): boolean {
  const r = refusedReason ?? '';
  if (r.startsWith(CREDENTIAL_REFUSAL_PREFIX)) return true;
  return /(^|\s)code=190(\s|$)/u.test(r);
}

/** How many customers a halt has left waiting on this channel: its credential-failed replies in the window. */
export async function countWaiting(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; now: Date },
): Promise<number | null> {
  const since = new Date(input.now.getTime() - CATCH_UP_WINDOW_MINUTES * 60_000).toISOString();
  const { data, error } = await db
    .from('outbound_messages')
    .select('conversation_id, refused_reason')
    .eq('tenant_id', input.tenantId)
    .eq('channel_id', input.channelId)
    .eq('kind', 'reply')
    .eq('state', 'failed')
    .gte('created_at', since)
    .limit(LIMIT);
  if (error) return null;
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return new Set(rows.filter((r) => isCredentialFailure(str(r['refused_reason'])))
    .map((r) => str(r['conversation_id']))).size;
}

export type CatchUpSkip =
  | 'newer_message' | 'too_old' | 'already_attempted' | 'answered_since' | 'person_replied'
  | 'event_missing' | 'unreadable' | 'enqueue_failed';

export type CatchUpResult = {
  conversationId: string;
  externalId: string;
  action: 'enqueued' | CatchUpSkip;
  detail?: string;
};

export type CatchUpOutcome =
  | { ok: true; channels: number; results: CatchUpResult[] }
  | { ok: false; detail: string };

export type CatchUpInput = {
  now: Date;
  enqueue: (job: {
    provider: string; dedupKey: string; eventId: number; tenantId: string; channelId: string; catchUpMid: string;
  }) => Promise<EnqueueResult>;
  /** Injected so a test decides the answer; production uses the live-send check itself. */
  personReplied?: typeof personRepliedSince;
};

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

type Held = { messageId: string; conversationId: string; externalId: string; at: Date };

/**
 * Find every held message on a channel that has come back, and hand the latest one per
 * conversation to the worker. Reads refuse the whole run (`ok: false`) only when the
 * candidate lists themselves are unreadable; a per-conversation read failure skips that
 * conversation until the next run.
 */
export async function catchUpHeldMessages(db: SupabaseClient, input: CatchUpInput): Promise<CatchUpOutcome> {
  const since = new Date(input.now.getTime() - CATCH_UP_WINDOW_MINUTES * 60_000);
  const personReplied = input.personReplied ?? personRepliedSince;

  // Only channels that are back: delivering, on a token Meta has not refused.
  const channels = await db
    .from('tenant_channels')
    .select('id, tenant_id, meta_app_id, automation_texts')
    // Instagram too (D-141): its worker job is the same job, sent through its Page.
    .in('provider', ['facebook_page', 'instagram'])
    .eq('delivery_mode', 'live')
    .eq('token_status', 'active');
  if (channels.error) return { ok: false, detail: `tenant_channels unreadable: ${channels.error.message}` };
  const live = new Map(rows(channels.data).map((c) => [str(c['id']), c]));
  if (live.size === 0) return { ok: true, channels: 0, results: [] };
  const channelIds = [...live.keys()];
  const tenantIds = [...new Set(rows(channels.data).map((c) => str(c['tenant_id'])))];

  const [failedRes, flaggedRes] = await Promise.all([
    db.from('outbound_messages')
      .select('conversation_id, dedup_key, refused_reason')
      .in('channel_id', channelIds)
      .eq('kind', 'reply')
      .eq('state', 'failed')
      .gte('created_at', since.toISOString())
      .limit(LIMIT),
    db.from('quality_flags')
      .select('message_id')
      .in('tenant_id', tenantIds)
      .eq('flag', HELD_FLAG)
      .gte('at', since.toISOString())
      .limit(LIMIT),
  ]);
  if (failedRes.error) return { ok: false, detail: `outbound_messages unreadable: ${failedRes.error.message}` };
  if (flaggedRes.error) return { ok: false, detail: `quality_flags unreadable: ${flaggedRes.error.message}` };

  const failedMids = rows(failedRes.data)
    .filter((r) => isCredentialFailure(str(r['refused_reason'])))
    .map((r) => str(r['dedup_key']))
    .filter((k) => k.startsWith('in:'))
    .map((k) => k.slice(3));
  const flaggedIds = rows(flaggedRes.data).map((r) => str(r['message_id'])).filter((id) => id !== '');
  if (failedMids.length === 0 && flaggedIds.length === 0) return { ok: true, channels: live.size, results: [] };

  const [byMid, byId] = await Promise.all([
    failedMids.length === 0 ? Promise.resolve({ data: [], error: null })
      : db.from('messages').select('id, conversation_id, external_id, at')
        .eq('direction', 'inbound').in('external_id', failedMids).limit(LIMIT),
    flaggedIds.length === 0 ? Promise.resolve({ data: [], error: null })
      : db.from('messages').select('id, conversation_id, external_id, at')
        .eq('direction', 'inbound').in('id', flaggedIds).limit(LIMIT),
  ]);
  if (byMid.error || byId.error) {
    return { ok: false, detail: `messages unreadable: ${(byMid.error ?? byId.error)?.message ?? ''}` };
  }
  const held = new Map<string, Held>();
  for (const r of [...rows(byMid.data), ...rows(byId.data)]) {
    held.set(str(r['id']), {
      messageId: str(r['id']), conversationId: str(r['conversation_id']),
      externalId: str(r['external_id']), at: new Date(str(r['at'])),
    });
  }
  const heldMids = new Set([...held.values()].map((h) => h.externalId));
  const conversationIds = [...new Set([...held.values()].map((h) => h.conversationId))];

  const convRes = await db.from('conversations').select('id, tenant_id, channel_id').in('id', conversationIds);
  if (convRes.error) return { ok: false, detail: `conversations unreadable: ${convRes.error.message}` };

  const results: CatchUpResult[] = [];
  for (const conv of rows(convRes.data)) {
    const conversationId = str(conv['id']);
    const tenantId = str(conv['tenant_id']);
    const channelId = str(conv['channel_id']);
    const channel = live.get(channelId);
    if (channel === undefined) continue;   // not back yet: the next run sees it
    results.push(await catchUpConversation(db, input, personReplied, {
      conversationId, tenantId, channelId, channel, heldMids, since,
    }));
  }
  return { ok: true, channels: live.size, results };
}

async function catchUpConversation(
  db: SupabaseClient,
  input: CatchUpInput,
  personReplied: typeof personRepliedSince,
  c: {
    conversationId: string; tenantId: string; channelId: string; channel: Record<string, unknown>;
    heldMids: ReadonlySet<string>; since: Date;
  },
): Promise<CatchUpResult> {
  const skip = (externalId: string, action: CatchUpSkip, detail?: string): CatchUpResult =>
    ({ conversationId: c.conversationId, externalId, action, ...(detail === undefined ? {} : { detail }) });

  const latestRes = await db.from('messages').select('id, external_id, at')
    .eq('conversation_id', c.conversationId).eq('direction', 'inbound')
    .order('at', { ascending: false }).limit(1);
  if (latestRes.error) return skip('', 'unreadable', `messages: ${latestRes.error.message}`);
  const latest = rows(latestRes.data)[0];
  if (latest === undefined) return skip('', 'unreadable', 'no inbound message');
  const messageId = str(latest['id']);
  const mid = str(latest['external_id']);
  const at = new Date(str(latest['at']));

  // The customer wrote again after the channel came back: the normal path owns that.
  if (!c.heldMids.has(mid)) return skip(mid, 'newer_message');
  if (Number.isNaN(at.getTime()) || at.getTime() < c.since.getTime()) return skip(mid, 'too_old');

  const [attempted, laterSent, eventRes] = await Promise.all([
    db.from('quality_flags').select('id').eq('message_id', messageId).eq('flag', CATCH_UP_FLAG).limit(1),
    db.from('outbound_messages').select('id').eq('conversation_id', c.conversationId)
      .eq('state', 'sent').gt('created_at', at.toISOString()).limit(1),
    db.from('webhook_events').select('id, provider, dedup_key, raw_payload')
      .eq('tenant_id', c.tenantId).eq('channel_id', c.channelId)
      .contains('raw_payload', { messaging: [{ message: { mid } }] })
      .order('id', { ascending: true }).limit(1),
  ]);
  if (attempted.error) return skip(mid, 'unreadable', `quality_flags: ${attempted.error.message}`);
  if (rows(attempted.data).length > 0) return skip(mid, 'already_attempted');
  if (laterSent.error) return skip(mid, 'unreadable', `outbound_messages: ${laterSent.error.message}`);
  if (rows(laterSent.data).length > 0) return skip(mid, 'answered_since');
  if (eventRes.error) return skip(mid, 'unreadable', `webhook_events: ${eventRes.error.message}`);
  const event = rows(eventRes.data)[0];
  if (event === undefined) return skip(mid, 'event_missing');
  const eventId = Number(event['id']);
  const psid = senderOf(event['raw_payload'], mid);
  if (psid === null) return skip(mid, 'event_missing', 'the stored event does not name the sender');

  const automation = c.channel['automation_texts'];
  let spoke: PersonReplied;
  try {
    spoke = await personReplied(db, {
      tenantId: c.tenantId, channelId: c.channelId, conversationId: c.conversationId, psid, eventId, since: at,
      ourAppId: typeof c.channel['meta_app_id'] === 'string' && c.channel['meta_app_id'] !== ''
        ? String(c.channel['meta_app_id']) : null,
      automationTexts: Array.isArray(automation) ? automation.filter((t): t is string => typeof t === 'string') : [],
    });
  } catch (e) {
    spoke = { replied: 'unreadable', detail: e instanceof Error ? e.message : String(e) };
  }
  if (spoke.replied === true) return skip(mid, 'person_replied', spoke.detail);
  if (spoke.replied === 'unreadable') return skip(mid, 'unreadable', spoke.detail);

  const queued = await input.enqueue({
    provider: str(event['provider']) || 'meta',
    // Its own identity: the original event's QStash dedup window must not swallow it.
    dedupKey: `catchup:${str(event['dedup_key'])}`,
    eventId, tenantId: c.tenantId, channelId: c.channelId, catchUpMid: mid,
  });
  if (!queued.ok) return skip(mid, 'enqueue_failed', queued.detail);

  // One attempt per message. A flag that cannot be written means the next run may enqueue
  // again; the worker still refuses a message whose reply is already sent or drafted.
  await db.from('quality_flags').insert({
    tenant_id: c.tenantId, conversation_id: c.conversationId, message_id: messageId,
    flag: CATCH_UP_FLAG, detail: { detail: `event ${eventId}; the channel is back and nobody has answered` },
  });
  return { conversationId: c.conversationId, externalId: mid, action: 'enqueued' };
}

/** The customer who sent `mid`, read from the stored entry. */
export function senderOf(payload: unknown, mid: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const messaging = (payload as Record<string, unknown>)['messaging'];
  if (!Array.isArray(messaging)) return null;
  for (const m of messaging) {
    if (m === null || typeof m !== 'object') continue;
    const ev = m as Record<string, unknown>;
    const message = ev['message'] as Record<string, unknown> | undefined;
    if (message === undefined || message['mid'] !== mid || message['is_echo'] === true) continue;
    const sender = ev['sender'] as Record<string, unknown> | undefined;
    const id = sender?.['id'];
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  }
  return null;
}
