/**
 * Reading and writing who holds a thread. The decisions live in `control.ts`; this file
 * only talks to the database.
 *
 * ## Echo detection is DISABLED unless this channel is the one that sends
 *
 * This is the trap that would have made the feature actively harmful, and it is specific
 * to how Matrix is being run right now.
 *
 * An echo is "an outbound message on this thread whose `mid` is not one of ours", and the
 * inference is "therefore a person typed it". On Matrix's Page that inference is false in
 * the ordinary case: the ANCESTOR is live on that Page and answering customers all day,
 * while Dala AI is in `shadow` and has never sent anything — so `provider_message_id` is
 * null on every draft we have ever written. Every single ancestor reply is an echo that is
 * not ours. Wired naively, the first day of this feature would have marked every active
 * conversation `human`, and H11 check 4 would then have silenced the mirror on exactly the
 * conversations worth measuring. The fourteen days would have produced nothing, and the
 * cause would have looked like a quiet afternoon.
 *
 * So: an echo only moves thread control on a channel whose `delivery_mode` is `live` —
 * that is, one where OUR sends are the sends, and "not ours" therefore means "not the
 * bot". In every other mode the echo is COUNTED and nothing moves, because the count is
 * still worth having and the inference is not.
 *
 * Handover events are unaffected: Meta naming a new owner is evidence in any delivery
 * mode, and it does not depend on us being the one who sends.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  controlAfter, controlFromEcho, parseHandoverEvents,
  type HandoverEvent, type ThreadControl, type ThreadState,
} from './control.ts';

/**
 * How control came to be where it is.
 *
 * `passed` is not a synonym for `handover` and the reclaim sweeper's safety rests on the
 * difference: `handover` is written whenever META names a new owner, which happens both
 * when this platform passes a thread and when a receptionist takes one through Business
 * Suite. Only `passed` means WE gave it away, and only a thread we gave away may be taken
 * back — see `reclaim.ts` and `0033`.
 */
export type ControlSource = 'handover' | 'echo' | 'reclaim' | 'passed';

/** Read the thread state. `unreadable` is distinct from `unknown` — see `control.ts`. */
export async function readThreadState(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string },
): Promise<ThreadState | 'unreadable'> {
  const { data, error } = await db
    .from('conversations')
    .select('thread_control, thread_control_at')
    .eq('tenant_id', input.tenantId)
    .eq('id', input.conversationId)
    .maybeSingle();
  if (error || data === null) return 'unreadable';
  const r = data as Record<string, unknown>;
  const at = r['thread_control_at'];
  return {
    control: String(r['thread_control'] ?? 'unknown') as ThreadControl,
    at: typeof at === 'string' ? new Date(at) : null,
  };
}

/**
 * Is this `mid` one of our own sends?
 *
 * Tristate on purpose. An unreadable table is not a table that said no, and `control.ts`
 * refuses to draw a conclusion from it.
 */
export async function echoIsOurs(
  db: SupabaseClient,
  input: { tenantId: string; mid: string },
): Promise<boolean | 'unreadable'> {
  const { data, error } = await db
    .from('outbound_messages')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('provider_message_id', input.mid)
    .limit(1)
    .maybeSingle();
  if (error) return 'unreadable';
  return data !== null;
}

/** Write the new owner. Idempotent: re-applying the same control is not a change. */
export async function applyThreadControl(
  db: SupabaseClient,
  input: {
    tenantId: string; conversationId: string;
    control: ThreadControl; at: Date; source: ControlSource;
  },
): Promise<{ ok: true; changed: boolean; refreshed?: true } | { ok: false; detail: string }> {
  const before = await readThreadState(db, input);
  if (before === 'unreadable') return { ok: false, detail: 'conversation unreadable' };

  if (before.control === input.control) {
    // A STAFF REPLY RESETS THE CLOCK (founder's call, 2026-09-19). `thread_control_at` is
    // what the cooldown measures from, and until now it moved only when control changed
    // hands — so a receptionist typing for twenty minutes had the bot come back over the
    // top of them halfway through.
    //
    // This file used to argue the other way, and the argument was not wrong so much as
    // incomplete: refreshing on every human turn does extend the silence for as long as a
    // person keeps typing, which on its own is how a bot stays switched off for an
    // afternoon. What makes it safe is the RECLAIM — the bot takes the thread back once
    // the human has been quiet for the reclaim window, so the extension is bounded by
    // somebody actually still being there. **The refresh and the reclaim are one design,
    // not two decisions**, in the same way `thread_control` defaulting to `unknown` is
    // only safe because check 4 refuses on `human` alone. Ship the refresh without the
    // reclaim and the old comment's warning comes true.
    //
    // Narrow on purpose: only an ECHO, and only `human`. An echo is a person typing. A
    // `handover` event re-asserting `human` is Meta repeating itself, not a new turn, and
    // treating it as one would let a redelivered webhook hold a thread open for ever.
    if (input.control !== 'human' || input.source !== 'echo') return { ok: true, changed: false };

    const { error: refreshErr } = await db
      .from('conversations')
      .update({ thread_control_at: input.at.toISOString() })
      .eq('tenant_id', input.tenantId)
      .eq('id', input.conversationId);
    if (refreshErr) return { ok: false, detail: refreshErr.message };
    // `changed` stays FALSE: control did not move, and `recordHandover` counts `changed`
    // as takeovers. Reporting a refresh as a change would make the mirror's numbers read
    // as control churning when nothing moved at all.
    return { ok: true, changed: false, refreshed: true };
  }

  const { error } = await db
    .from('conversations')
    .update({
      thread_control: input.control,
      thread_control_at: input.at.toISOString(),
      thread_control_source: input.source,
    })
    .eq('tenant_id', input.tenantId)
    .eq('id', input.conversationId);
  return error ? { ok: false, detail: error.message } : { ok: true, changed: true };
}

/** The conversation a PSID belongs to on this channel, or null when there is not one yet. */
export async function conversationForPsid(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; psid: string },
): Promise<string | null | 'unreadable'> {
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('channel_id', input.channelId)
    .eq('external_id', input.psid)
    .maybeSingle();
  if (contactErr) return 'unreadable';
  if (contact === null) return null;

  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('channel_id', input.channelId)
    .eq('contact_id', String((contact as Record<string, unknown>)['id']))
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return 'unreadable';
  return data === null ? null : String((data as Record<string, unknown>)['id']);
}

export type HandoverOutcome = {
  /** Handover events Meta sent that we could read. */
  events: number;
  /** Events that carried a handover key and named nobody — see `control.ts`. */
  unrecognised: number;
  /** Conversations whose control actually moved. */
  changed: number;
  /** Echoes seen. Counted in every delivery mode; only acted on when `live`. */
  echoes: number;
  /** Echoes that moved control. Always 0 unless the channel is `live`. */
  echoTakeovers: number;
  problems: string[];
};

/**
 * Apply one entry's handover events and echoes.
 *
 * `ourAppId` is `tenant_channels.meta_app_id` — Meta's own id, never the callback slug
 * (D-041). Null makes every verdict `unknown`, which changes nothing.
 */
export async function recordHandover(
  db: SupabaseClient,
  input: {
    tenantId: string; channelId: string; ourAppId: string | null;
    entry: unknown;
    /** Echoes from `extractInboundMessages`: the `mid` and the CUSTOMER (the recipient). */
    echoes: readonly { mid: string; psid: string }[];
    /** Only `live` lets an echo move control. See this file's header. */
    deliveryMode: string;
    now: Date;
  },
): Promise<HandoverOutcome> {
  const parsed = parseHandoverEvents(input.entry);
  const out: HandoverOutcome = {
    events: parsed.events.length, unrecognised: parsed.unrecognised,
    changed: 0, echoes: input.echoes.length, echoTakeovers: 0, problems: [],
  };

  const move = async (psid: string, control: ThreadControl, at: Date, source: ControlSource) => {
    if (control === 'unknown') return false; // no evidence; write nothing
    const conversationId = await conversationForPsid(db, {
      tenantId: input.tenantId, channelId: input.channelId, psid,
    });
    if (conversationId === 'unreadable') { out.problems.push('conversation unreadable'); return false; }
    // A handover for somebody who has never written to us. Nothing to attach it to, and
    // inventing a conversation to hold it would create a row no customer produced.
    if (conversationId === null) return false;
    const applied = await applyThreadControl(db, {
      tenantId: input.tenantId, conversationId, control, at, source,
    });
    if (!applied.ok) { out.problems.push(applied.detail); return false; }
    return applied.changed;
  };

  for (const ev of parsed.events as HandoverEvent[]) {
    if (ev.psid === null) continue;
    const control = controlAfter(ev, input.ourAppId);
    if (await move(ev.psid, control, ev.at ?? input.now, 'handover')) out.changed += 1;
  }

  // The echo half, and the mode gate that makes it honest.
  if (input.deliveryMode === 'live') {
    for (const echo of input.echoes) {
      const ours = await echoIsOurs(db, { tenantId: input.tenantId, mid: echo.mid });
      const control = controlFromEcho(ours);
      if (control === null) continue; // ours, or unreadable — either way, no conclusion
      if (await move(echo.psid, control, input.now, 'echo')) {
        out.changed += 1;
        out.echoTakeovers += 1;
      }
    }
  }
  return out;
}
