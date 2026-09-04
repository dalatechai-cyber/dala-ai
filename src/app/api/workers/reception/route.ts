/**
 * The reception worker. QStash calls this; customers never do.
 *
 * ## What it does now
 *
 * Reads the stored Meta entry, extracts the answerable customer messages, and for each
 * one: persists the contact, conversation and message, takes a reservation through the
 * chokepoint, and runs the reception flow to a drafted reply.
 *
 * **The send is not here.** It needs a decrypted per-tenant Meta token and no KEK exists,
 * so a reply ends as an `outbound_messages` row in `draft`. That is deliberate rather than
 * unfinished: the row is the durable hand-off point, and the send path claims from it.
 *
 * ## One reservation per reply, not per delivery
 *
 * A Meta entry may carry several messages. Each gets its own trip through the chokepoint,
 * because the chokepoint is what makes one reply affordable — reserving once and answering
 * three times would be a ceiling that counts wrong in the tenant's favour.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { markEventState } from '@/lib/webhook/events';
import { withTenantRole } from '@/lib/guard/withTenantRole';
import { usdToNano } from '@/lib/money';
import { extractInboundMessages } from '@/lib/meta/extract';
import { ensureContact, ensurePerson, openConversation, readHistory, recordInbound } from '@/lib/inbound/persist';
import { loadReceptionContext } from '@/lib/reception/load';
import { handleReception } from '@/lib/reception/handle';
import { buildDeps } from '@/lib/reception/deps';
import { RECEPTION_HISTORY_TURNS } from '@/lib/model/reception';
import { renderVolatile, tenantClock } from '@/lib/reception/volatile';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '@/config/platform';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * What one Reception reply is expected to cost, reserved before the call and settled
 * against the real `usage` afterwards. From D-016's measured $0.0090/reply, rounded up:
 * an under-estimate lets a burst slip past the ceiling between reserve and settle.
 */
const RECEPTION_REPLY_ESTIMATE = usdToNano(0.012);

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();

  if (!(await verifyQStashSignature(raw, request.headers.get('upstash-signature')))) {
    return NextResponse.json({ error: 'worker.signature_invalid' }, { status: 401 });
  }

  let job: { eventId?: unknown; tenantId?: unknown; channelId?: unknown };
  try {
    job = JSON.parse(raw) as typeof job;
  } catch {
    // Malformed after a VALID signature means we published it wrong. Retrying cannot fix
    // that, so 200 to stop the redelivery loop and let the alert carry it.
    console.error('[worker] job_not_json');
    return NextResponse.json({ ok: true, dropped: 'job_not_json' }, { status: 200 });
  }

  const eventId = typeof job.eventId === 'number' ? job.eventId : null;
  const tenantId = typeof job.tenantId === 'string' ? job.tenantId : null;
  const channelId = typeof job.channelId === 'string' ? job.channelId : null;
  if (eventId === null || tenantId === null || channelId === null) {
    console.error('[worker] job_missing_fields');
    return NextResponse.json({ ok: true, dropped: 'job_missing_fields' }, { status: 200 });
  }

  const db = supabaseWorker();
  const now = new Date();

  // --- The stored entry. One source, parsed once, at the point of use. -------
  const { data: event, error: eventErr } = await db
    .from('webhook_events')
    .select('raw_payload')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) {
    console.error('[worker] event_unreadable', { eventId, detail: eventErr.message });
    return NextResponse.json({ error: 'worker.event_unreadable' }, { status: 503 });
  }
  if (event === null) {
    console.error('[worker] event_missing', { eventId });
    return NextResponse.json({ ok: true, dropped: 'event_missing' }, { status: 200 });
  }

  const { messages, skipped } = extractInboundMessages((event as Record<string, unknown>)['raw_payload']);
  if (messages.length === 0) {
    // Nothing answerable — echoes, receipts, a sticker. Seen and declined, which is a
    // different fact from vanished, so the reason is logged and the event is processed.
    console.info('[worker] nothing_to_answer', { eventId, skipped });
    await markEventState(db, eventId, 'processed');
    return NextResponse.json({ ok: true, eventId, skipped }, { status: 200 });
  }

  // --- Tenant settings and the compiled context, read once for the whole entry.
  const { data: tenantRow, error: tenantErr } = await db
    .from('tenants')
    .select('default_locale, prompt_cache_mode, timezone')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantErr || tenantRow === null) {
    console.error('[worker] tenant_unreadable', { tenantId, detail: tenantErr?.message });
    return NextResponse.json({ error: 'worker.tenant_unreadable' }, { status: 503 });
  }
  const t = tenantRow as Record<string, unknown>;
  const settings = {
    defaultLocale: String(t['default_locale'] ?? 'mn-MN'),
    promptCacheMode: String(t['prompt_cache_mode'] ?? 'off') as 'off' | '5m' | '1h',
  };
  const timezone = String(t['timezone'] ?? 'Asia/Ulaanbaatar');
  // "Today" is a question about the tenant's clock, so the date the closure query filters
  // on is computed here rather than in SQL's `current_date`, which is the server's.
  const localDate = tenantClock(now, timezone).date;

  const loaded = await loadReceptionContext(db, { tenantId, channel: 'facebook_page', settings, localDate });
  if (!loaded.ok) {
    console.error('[worker] context_unavailable', { tenantId, code: loaded.code, detail: loaded.detail });
    if (loaded.code === 'not_provisioned') {
      // Determinate: retrying cannot provision a tenant. ACK and let the operator alert
      // carry it, rather than looping QStash against a state only a human can change.
      await markEventState(db, eventId, 'blocked_no_token');
      return NextResponse.json({ ok: true, refused: loaded.code }, { status: 200 });
    }
    return NextResponse.json({ error: loaded.code }, { status: 503 });
  }
  const ctx = loaded.context;

  /**
   * L4, the volatile tail. Its own `system` block with no `cache_control`, which is what
   * makes the ancestor's trap structurally unavailable: it concatenates its closure
   * section onto the cached base prompt, so anything date-shaped added there invalidates
   * every entry, silently, and the bill roughly triples.
   */
  const promptVolatile = renderVolatile({
    now, timezone, channel: 'facebook_page', hours: ctx.hours, closures: ctx.closures,
  });

  // --- One message, one reservation, one reply. -----------------------------
  const drafted: string[] = [];
  for (const message of messages) {
    const contact = await ensureContact(db, {
      tenantId, channelId, externalId: message.senderId, now,
    });
    if (!contact.ok) {
      console.error('[worker] contact_failed', { detail: contact.detail });
      return NextResponse.json({ error: 'worker.contact_failed' }, { status: 503 });
    }
    if (contact.value.personId === null) {
      // Best-effort: the person layer exists for consent, and a first message should not
      // fail because it had a bad day. A missing person is visible in the row.
      const person = await ensurePerson(db, {
        tenantId, contactId: contact.value.contactId, kind: 'psid', externalId: message.senderId,
      });
      if (!person.ok) console.error('[worker] person_failed', { detail: person.detail });
    }

    const conversation = await openConversation(db, {
      tenantId, contactId: contact.value.contactId, channelId, now,
    });
    if (!conversation.ok) {
      console.error('[worker] conversation_failed', { detail: conversation.detail });
      return NextResponse.json({ error: 'worker.conversation_failed' }, { status: 503 });
    }
    const conversationId = conversation.value.conversationId;

    const stored = await recordInbound(db, {
      tenantId, conversationId, externalId: message.externalId, body: message.text, now,
    });
    if (!stored.ok) {
      console.error('[worker] message_failed', { detail: stored.detail });
      return NextResponse.json({ error: 'worker.message_failed' }, { status: 503 });
    }
    // A redelivery: this exact customer message is already stored, so it has already been
    // answered or is being answered. Generating again would double-reply and double-bill.
    if (stored.value.duplicate) continue;

    // History is read AFTER storing, so the turn just received is not also passed as
    // history — the model would otherwise see the question twice.
    const history = await readHistory(db, { tenantId, conversationId, limit: RECEPTION_HISTORY_TURNS + 1 });
    if (!history.ok) {
      // An unreadable history is never an empty one: without the distinction a hiccup
      // makes the bot greet an existing customer from scratch.
      console.error('[worker] history_failed', { detail: history.detail });
      return NextResponse.json({ error: 'worker.history_failed' }, { status: 503 });
    }
    const priorTurns = history.value.slice(0, -1);

    // The chokepoint. Nothing downstream may re-implement any part of this.
    const guard = await withTenantRole(db, {
      tenantId, role: 'reception', surface: 'reception', channel: 'facebook_page',
      estimate: RECEPTION_REPLY_ESTIMATE, conversationId, webhookEventId: eventId, now,
    });

    if (!guard.ok) {
      const { refusal } = guard;
      console.warn('[worker] refused', { code: refusal.code, tenantId, eventId });
      // 503 means "we could not determine" — QStash must retry, so nothing is lost.
      if (refusal.status === 503) return NextResponse.json({ error: refusal.code }, { status: 503 });
      // 403/429 are determinate. Retrying cannot change them, so ACK and let the §5.7
      // degradation ladder answer the customer. Never silence.
      await markEventState(db, eventId, refusal.status === 429 ? 'shed' : 'blocked_no_token');
      return NextResponse.json({ ok: true, refused: refusal.code }, { status: 200 });
    }

    const outcome = await handleReception(
      buildDeps({
        db, tenantId, channelId, conversationId,
        cacheMode: ctx.cacheMode,
        inboundExternalId: message.externalId,
        reservation: guard.reservation, now,
      }),
      {
        customerMessage: message.text,
        history: priorTurns,
        // A missing Meta timestamp arrives as an invalid date; treating it as `now`
        // stops it reading as 1970 and being dropped as stale.
        eventAt: Number.isNaN(message.sentAt.getTime()) ? now : message.sentAt,
        now,
        promptStable: ctx.promptStable,
        promptVolatile,
        modelId: MODEL_REGISTRY.reception,
        cacheMode: ctx.cacheMode,
        timeoutMs: RECEPTION_UPSTREAM_TIMEOUT_MS,
        rules: ctx.rules,
        deterministic: ctx.deterministic,
        // The history was read successfully or we would have 503'd above, so `known` is
        // true here. `empty` is about the turns BEFORE this one — the inbound row was
        // stored a moment ago, so a first message leaves priorTurns empty.
        historyState: { known: true, empty: priorTurns.length === 0 },
        canned: ctx.canned,
        tenantGuard: ctx.tenantGuard,
        cannedLabel: 'БЭЛЭН ХАРИУЛТ',
      },
    );

    if (outcome.kind === 'retry') {
      console.error('[worker] reception_retry', { detail: outcome.detail });
      return NextResponse.json({ error: 'worker.reception_retry' }, { status: 503 });
    }
    if (outcome.kind === 'dropped') {
      console.warn('[worker] reception_dropped', { reason: outcome.reason });
      continue;
    }
    drafted.push(outcome.outboundId);
    if (outcome.refusal !== undefined) {
      console.warn('[worker] answered_with_handoff', { code: outcome.refusal, conversationId });
    }
  }

  // Every message in the entry is accounted for. The send path claims from
  // `outbound_messages` and is not built.
  await markEventState(db, eventId, 'processed');
  return NextResponse.json({ ok: true, eventId, drafted: drafted.length, skipped }, { status: 200 });
}
