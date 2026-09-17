/**
 * The reception worker's decision logic, with nothing in it that a test cannot reach.
 *
 * ## Why this is not in the route file
 *
 * It was, and that made it the one file in the repository with real branching and no test
 * coverage — twenty-odd early returns, each of which is a decision about a customer's
 * reply or a tenant's money, and none of which anything checked. A Next.js route handler
 * is awkward to test for uninteresting reasons (module-scope clients, `next/server`, an
 * env read at import time), so the reasons win and the branches go unchecked.
 *
 * The fix is the shape `reception/handle.ts` and `reception/deps.ts` already use here:
 * the decision takes its effects as an argument and returns a value. The route becomes an
 * adapter thin enough that reading it is the same as verifying it.
 *
 * This module returns `{ status, body }` rather than a `NextResponse`, so it does not
 * import `next/server` either.
 *
 * ## The status codes are the contract with QStash, not decoration
 *
 * Three meanings, and confusing any two of them loses a customer's message or bills for it
 * twice:
 *
 *  - **503** — we could not determine something. QStash retries; nothing is lost.
 *  - **200 with a `dropped`/`refused` reason** — determinate and unanswerable. Retrying
 *    cannot change it, so a retry would be a loop against a state only a human can fix.
 *  - **401** — the signature failed. Not ours to process at all.
 *
 * A 200 for a transient failure drops the event forever. A 503 for a determinate one is a
 * redelivery loop. Every early return below is one of those three on purpose.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canDeliver } from '../channel/delivery.ts';
import { extractInboundMessages } from '../meta/extract.ts';
import { ensureContact, ensurePerson, openConversation, readHistory, recordInbound, traceAnswer } from '../inbound/persist.ts';
import { recordDroppedInbound, skipSummary } from '../inbound/dropped.ts';
import { draftImageReplies, planImageReplies, readImageLine } from '../inbound/imageReply.ts';
import { recordHandover, readThreadState } from '../handover/record.ts';
import { humanHoldsThread } from '../handover/control.ts';
import { loadReceptionContext } from '../reception/load.ts';
import { renderVolatile } from '../reception/volatile.ts';
import { tenantClock } from '../time/clock.ts';
import { RECEPTION_HISTORY_TURNS } from '../model/reception.ts';
import { withTenantRole } from '../guard/withTenantRole.ts';
import { claim, findReplyFor, replyDedupKey } from '../outbound/claim.ts';
import { markEventState } from '../webhook/events.ts';
import { usdToNano } from '../money.ts';
import { isFresh, replyAgeLimitMinutes } from './freshness.ts';
import { runCommentJob, type CommentEffects, type CommentJobResult } from './comments.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { Turn } from '../inbound/persist.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import type { Reservation } from '../spend/reserve.ts';
import type { ReceptionContext } from '../reception/load.ts';

/**
 * What one Reception reply is expected to cost, reserved before the call and settled
 * against the real `usage` afterwards. An under-estimate lets a burst slip past the
 * ceiling between reserve and settle, which is the whole reason a reservation exists.
 *
 * **$0.041, raised from $0.012 by the founder on 2026-09-15** (D-072). The old figure came
 * from D-016's blended $0.0090/reply, which has no cold-start term in it. Measured on the
 * live ledger: a cache-MISS reply costs **$0.040554** and a cache-HIT reply $0.003540, and
 * a miss is what a conversation's first turn always is, because conversations arrive hours
 * apart and the prefix cache is gone by the next one. So the reserve was 3.4× light on
 * exactly the turn that opens every conversation.
 *
 * It reserves the EXPENSIVE case on purpose. Reserving the average would be right if the
 * two cases interleaved randomly; they do not — the miss is structural and predictable, and
 * settle corrects the ledger a moment later either way. The cost of over-reserving is that
 * a tenant near its ceiling is refused slightly early; the cost of under-reserving is a
 * burst spending past a ceiling that was checked and passed.
 */
export const RECEPTION_REPLY_ESTIMATE = usdToNano(0.041);

export type GenerateArgs = {
  tenantId: string;
  channelId: string;
  conversationId: string;
  inboundExternalId: string;
  reservation: Reservation;
  customerMessage: string;
  history: readonly Turn[];
  eventAt: Date;
  promptVolatile: string;
  ctx: ReceptionContext;
  historyEmpty: boolean;
};

export type DeliverArgs = {
  tenantId: string;
  channelId: string;
  pageId: string;
  recipientId: string;
  outboundId: string;
  body: string;
  attempts: number;
  graphVersion: string;
};

/**
 * Everything the job does that is not a database read.
 *
 * `db` is here rather than injected per call because every query already goes through the
 * same stub shape the rest of this codebase's tests use — the point of the seam is the
 * effects a stub cannot express: a signature, a model call, an HTTP send, and the clock.
 */
export type WorkerEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (raw: string, signature: string | null) => Promise<boolean>;
  /**
   * The channel is a secondary receiver and cannot answer anyone (§3.7). An effect rather
   * than a direct `raiseAlert` so this module keeps its property of doing no I/O it did
   * not declare.
   */
  alertStandby: (input: { tenantId: string; channelId: string; dayKey: string; events: number }) => Promise<void>;
  /** `META_GRAPH_VERSION`, read lazily so an unconfigured deployment fails at use. */
  graphVersionDefault: () => string;
  generateReply: (args: GenerateArgs) => Promise<ReceptionOutcome>;
  deliver: (args: DeliverArgs) => Promise<DeliverOutcome>;
  /**
   * §3.9's "Quality flag" on a refusal. Best-effort by construction: it is evidence for a
   * person to read later, never a control, and a flag that cannot be written must not
   * change what the customer gets.
   */
  flagQuality: (args: { tenantId: string; conversationId: string; code: string; detail: string }) => Promise<void>;
  /** Structured, and injected so a test can assert the REASON rather than the status. */
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
  /** The public-comment surface. Its own effects, because it is its own surface. */
  replyToComment: CommentEffects['replyToComment'];
};

export type JobResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): JobResult => ({ status: 200, body: { ok: true, ...body } });
const unavailable = (code: string): JobResult => ({ status: 503, body: { error: code } });

export async function runReceptionJob(
  fx: WorkerEffects,
  request: { rawBody: string; signature: string | null },
): Promise<JobResult> {
  if (!(await fx.verifySignature(request.rawBody, request.signature))) {
    return { status: 401, body: { error: 'worker.signature_invalid' } };
  }

  let job: { eventId?: unknown; tenantId?: unknown; channelId?: unknown };
  try {
    job = JSON.parse(request.rawBody) as typeof job;
  } catch {
    // Malformed after a VALID signature means WE published it wrong. Retrying cannot fix
    // that, so 200 to stop the redelivery loop and let the log carry it.
    fx.log('error', 'job_not_json');
    return ok({ dropped: 'job_not_json' });
  }

  const eventId = typeof job.eventId === 'number' ? job.eventId : null;
  const tenantId = typeof job.tenantId === 'string' ? job.tenantId : null;
  const channelId = typeof job.channelId === 'string' ? job.channelId : null;
  if (eventId === null || tenantId === null || channelId === null) {
    fx.log('error', 'job_missing_fields');
    return ok({ dropped: 'job_missing_fields' });
  }

  const { db, now } = fx;

  // --- The stored entry. One source, parsed once, at the point of use. -------
  const { data: event, error: eventErr } = await db
    .from('webhook_events')
    .select('raw_payload')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) {
    fx.log('error', 'event_unreadable', { eventId, detail: eventErr.message });
    return unavailable('worker.event_unreadable');
  }
  if (event === null) {
    fx.log('error', 'event_missing', { eventId });
    return ok({ dropped: 'event_missing' });
  }

  const rawPayload = (event as Record<string, unknown>)['raw_payload'];
  const { messages, skipped, standby } = extractInboundMessages(rawPayload);

  // --- Tenant settings, read once for the whole entry. ----------------------
  //
  // Above the standby branch, not below it, because the standby alert's dedup key is a
  // date on the TENANT'S calendar and there is nowhere else to get one. That makes an
  // unreadable `tenants` row a 503 for a standby entry too, which is the right way round:
  // every other refusal in this function treats a read it cannot complete as undetermined,
  // and a redelivery costs nothing while a mis-keyed alert either fires twice a day or
  // goes quiet for one.
  const { data: tenantRow, error: tenantErr } = await db
    .from('tenants')
    .select('default_locale, prompt_cache_mode, timezone, max_reply_age_minutes, human_takeover_cooldown_minutes')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantErr || tenantRow === null) {
    fx.log('error', 'tenant_unreadable', { tenantId, detail: tenantErr?.message });
    return unavailable('worker.tenant_unreadable');
  }
  const t = tenantRow as Record<string, unknown>;
  const settings = {
    defaultLocale: String(t['default_locale'] ?? 'mn-MN'),
    promptCacheMode: String(t['prompt_cache_mode'] ?? 'off') as 'off' | '5m' | '1h',
  };
  // No `?? 'Asia/Ulaanbaatar'`. The column is NOT NULL, so a default here is unreachable
  // today and a silent wrong calendar the day it is not — and this value now decides which
  // day a reply is charged to. A missing zone is undetermined, and undetermined refuses.
  const rawTimezone = t['timezone'];
  if (typeof rawTimezone !== 'string' || rawTimezone === '') {
    fx.log('error', 'tenant_timezone_missing', { tenantId });
    return unavailable('worker.tenant_timezone_missing');
  }
  const timezone = rawTimezone;
  const replyAgeLimit = replyAgeLimitMinutes(t['max_reply_age_minutes']);
  // Per tenant, as data (§3.7.3). A salon that answers in ninety seconds and one that
  // answers on Monday want different numbers, and neither is a constant in `src/`.
  const cooldownMinutes = typeof t['human_takeover_cooldown_minutes'] === 'number'
    ? Number(t['human_takeover_cooldown_minutes']) : 30;
  // "Today" is a question about the tenant's clock, so the date the closure query filters
  // on is computed here rather than in SQL's `current_date`, which is the server's.
  const localDate = tenantClock(now, timezone).date;

  // --- Secondary receiver (§3.7). Never a drop. -----------------------------
  //
  // Meta put these messages in `entry.standby` rather than `entry.messaging`, which means
  // another app — almost always the Page Inbox — is the PRIMARY receiver for this Page.
  // The webhook is well-formed, correctly signed and correctly routed; we simply may not
  // answer, and until this branch existed the entry produced an empty extraction that was
  // byte-identical to "no customer wrote in".
  //
  // 200 rather than 503: a redelivery cannot change a Page setting. The alert is the
  // output, and `standby_not_primary` — a state `0001` already anticipated — is what stops
  // the row reading as `processed`.
  if (standby > 0) {
    await markEventState(db, eventId, 'standby_not_primary');
    fx.log('warn', 'standby_not_primary', { tenantId, channelId, events: standby });
    // Per channel per day, not once per channel for ever. A misconfigured Page produces
    // standby on EVERY message, so a bare channel key would fire on all of them; a key with
    // no period at all would go quiet for good the first time somebody "fixed" it and it
    // came back.
    await fx.alertStandby({ tenantId, channelId, dayKey: localDate, events: standby });
    return ok({ refused: 'standby_not_primary' });
  }

  // --- The channel: where a reply would go, and whether it may go at all. ---
  const { data: channelRow, error: channelErr } = await db
    .from('tenant_channels')
    .select('external_id, delivery_mode, meta_app_id, graph_version_override, comment_policy, comment_max_post_age_days, ignore_commenter_ids, comment_replies_per_post_per_day')
    .eq('id', channelId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (channelErr) {
    fx.log('error', 'channel_unreadable', { tenantId, channelId, detail: channelErr.message });
    return unavailable('worker.channel_unreadable');
  }
  if (channelRow === null) {
    // Unreadable is transient and a missing channel is not: the job named a binding that
    // does not belong to this tenant, which retrying cannot fix.
    fx.log('error', 'channel_missing', { tenantId, channelId });
    return ok({ dropped: 'channel_missing' });
  }
  const c = channelRow as Record<string, unknown>;
  const pageId = String(c['external_id'] ?? '');
  const deliveryMode = String(c['delivery_mode'] ?? '');
  const delivery = canDeliver(deliveryMode);
  // Meta's own app id, never the callback slug (D-041). Null makes every handover verdict
  // `unknown`, which changes no thread state — correct, and visibly incomplete.
  const metaAppId = typeof c['meta_app_id'] === 'string' && c['meta_app_id'] !== ''
    ? String(c['meta_app_id']) : null;
  const override = c['graph_version_override'];
  const graphVersion = typeof override === 'string' && override !== '' ? override : fx.graphVersionDefault();

  // --- What we saw and will not answer. Recorded BEFORE anything that can return. -----
  //
  // Above the comment job and above the `messages.length === 0` branch on purpose: an
  // entry can carry an answerable message AND a dropped one, and hanging this off the
  // "nothing to answer" branch would record only the entries where nothing else happened.
  // That is the shape of the bug being fixed here, so it is not rebuilt one line down.
  //
  // Not fatal, ever: this is evidence, and a customer's reply must not wait on it. But a
  // failure is LOGGED as a failure rather than folded into silence, because silence is
  // what made three dropped events invisible for a day.
  if (skipped.length > 0) {
    const recorded = await recordDroppedInbound(db, {
      tenantId, channelId, eventId, skipped, now,
    });
    if (recorded.failed > 0 || recorded.detail !== undefined) {
      fx.log('error', 'dropped_inbound_unrecorded', {
        eventId, ...recorded, ...skipSummary(skipped),
      });
    }

    // --- Who holds this thread? (§3.7, §3.7.3) ----------------------------------------
    //
    // Observational only. Nothing here calls Graph, and `pass_thread_control` is not built
    // — passing control is a live mutation of a real salon's thread ownership and cannot
    // be rehearsed during a shadow mirror.
    //
    // The echoes come from the skip list because `extract.ts` now CARRIES an echo's `mid`
    // and its recipient. It used to carry neither, which is why "did we send this?" could
    // not be asked and a receptionist and the bot answered the same customer in parallel
    // with nothing recording it.
    const echoes = skipped
      .filter((sk) => sk.reason === 'echo' && sk.externalId !== null && sk.recipientId !== null)
      .map((sk) => ({ mid: sk.externalId as string, psid: sk.recipientId as string }));
    const handover = await recordHandover(db, {
      tenantId, channelId, ourAppId: metaAppId, entry: rawPayload, echoes,
      deliveryMode, now,
    });
    if (handover.events > 0 || handover.changed > 0 || handover.echoTakeovers > 0) {
      fx.log('info', 'thread_control', {
        eventId, events: handover.events, changed: handover.changed,
        echoes: handover.echoes, echoTakeovers: handover.echoTakeovers,
      });
    }
    // Never folded into zero. The delivery shape of a handover event is unverified here —
    // `developers.facebook.com` is refused by this environment's proxy — so an entry that
    // carried a handover key and could not be read is the single most informative thing
    // this path can emit, and it is the signal that settles the shape.
    if (handover.unrecognised > 0) {
      fx.log('warn', 'handover_unrecognised', { eventId, count: handover.unrecognised });
    }
    for (const problem of handover.problems) {
      fx.log('error', 'thread_control_failed', { eventId, detail: problem });
    }

    // --- A photograph is not a thumbs-up, and silence is the wrong answer to it. -------
    //
    // Four real photographs were dropped on 2026-09-15/16 while the ancestor answered
    // the same messages with a fixed line, so this is a regression against the bot being
    // replaced rather than a missing feature. `planImageReplies` keys on `stickerIds`
    // and never on `type`, which is what keeps a thumbs-up quiet (D-070).
    //
    // Draft only. The send is the claim step, so a `shadow` channel records what it
    // WOULD have said and delivers nothing — the mirror's whole point.
    const plannedImages = planImageReplies(skipped);
    if (plannedImages.length > 0) {
      const line = await readImageLine(db, { tenantId, locale: settings.defaultLocale });
      if (!line.ok) {
        fx.log('error', 'image_line_unreadable', { eventId, detail: line.detail });
      } else if (line.line === null) {
        // Not an error: a tenant without the row keeps today's behaviour, visibly.
        fx.log('info', 'image_line_missing', { tenantId, count: plannedImages.length });
      } else if (line.line.reviewedAt === null) {
        // An unreviewed row is not an approved sentence (D-065). Silence is the safer
        // half of this trade, and the log is what stops it being a silent one.
        fx.log('error', 'image_line_unreviewed', { tenantId, count: plannedImages.length });
      } else {
        const answered = await draftImageReplies(db, {
          tenantId, channelId, eventId, body: line.line.body, planned: plannedImages, now,
        });
        if (answered.failed > 0 || answered.detail !== undefined) {
          fx.log('error', 'image_reply_incomplete', { eventId, ...answered });
        }
      }
    }
  }

  // --- The public surface. A `feed` entry has no `messaging`, so this is where a
  // comments-only event is handled; a `messages` entry yields no comments and skips it.
  let commentResult: CommentJobResult | null = null;
  if (String(c['comment_policy'] ?? 'none') !== 'none') {
    commentResult = await runCommentJob(
      { db, now, replyToComment: fx.replyToComment, log: fx.log },
      {
        tenantId,
        channelId,
        pageExternalId: pageId,
        deliveryMode: String(c['delivery_mode'] ?? ''),
        graphVersion,
        locale: settings.defaultLocale,
        config: {
          policy: String(c['comment_policy'] ?? 'none'),
          maxPostAgeDays: Number(c['comment_max_post_age_days'] ?? 30),
          ignoreCommenterIds: Array.isArray(c['ignore_commenter_ids'])
            ? (c['ignore_commenter_ids'] as unknown[]).map(String)
            : [],
          // 1 is both the column default and the safe fallback, so a channel row from
          // before 0009 caps at one reply per post rather than at none or at unlimited.
          repliesPerPostPerDay: Number(c['comment_replies_per_post_per_day'] ?? 1),
        },
        rawPayload,
      },
    );
    if (commentResult.retry) return unavailable('worker.comment_retry');
  }

  if (messages.length === 0) {
    // Nothing answerable in the DM sense — an echo, a receipt, a sticker, or a `feed`
    // entry that carried only comments. Seen and declined is a different fact from
    // vanished, so the reason is recorded and the event is processed.
    fx.log('info', 'nothing_to_answer', { eventId, ...skipSummary(skipped) });
    await markEventState(db, eventId, 'processed');
    return ok({ eventId, skipped: skipSummary(skipped), ...(commentResult === null ? {} : { comments: commentResult }) });
  }

  const loaded = await loadReceptionContext(db, { tenantId, channel: 'facebook_page', settings, localDate });
  if (!loaded.ok) {
    fx.log('error', 'context_unavailable', { tenantId, code: loaded.code, detail: loaded.detail });
    if (loaded.code === 'not_provisioned') {
      // Determinate: retrying cannot provision a tenant. ACK and let the operator alert
      // carry it, rather than looping QStash against a state only a human can change.
      await markEventState(db, eventId, 'blocked_no_token');
      return ok({ refused: loaded.code });
    }
    return unavailable(loaded.code);
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
  const sent: string[] = [];
  const stale: string[] = [];
  /** Stored and deliberately not answered: the channel cannot send and is not mirroring. */
  const notGenerated: string[] = [];

  for (const message of messages) {
    // A missing Meta timestamp arrives as an invalid date; treating it as `now` stops it
    // reading as 1970 and being dropped as stale for the wrong reason.
    const eventAt = Number.isNaN(message.sentAt.getTime()) ? now : message.sentAt;

    const contact = await ensureContact(db, { tenantId, channelId, externalId: message.senderId, now });
    if (!contact.ok) {
      fx.log('error', 'contact_failed', { detail: contact.detail });
      return unavailable('worker.contact_failed');
    }
    if (contact.value.personId === null) {
      // Best-effort: the person layer exists for consent, and a first message should not
      // fail because it had a bad day. A missing person is visible in the row.
      const person = await ensurePerson(db, {
        tenantId, contactId: contact.value.contactId, kind: 'psid', externalId: message.senderId,
      });
      if (!person.ok) fx.log('error', 'person_failed', { detail: person.detail });
    }

    const conversation = await openConversation(db, {
      tenantId, contactId: contact.value.contactId, channelId, now,
    });
    if (!conversation.ok) {
      fx.log('error', 'conversation_failed', { detail: conversation.detail });
      return unavailable('worker.conversation_failed');
    }
    const conversationId = conversation.value.conversationId;

    const stored = await recordInbound(db, {
      tenantId, conversationId, externalId: message.externalId, body: message.text, now,
    });
    if (!stored.ok) {
      fx.log('error', 'message_failed', { detail: stored.detail });
      return unavailable('worker.message_failed');
    }
    // --- H11 check 4: is a person already handling this conversation? (§3.7.3) --------
    //
    // AFTER the message is stored — §3.4.5's "persist everything, generate nothing" — and
    // before any generation, so a thread a receptionist has taken costs three rows and no
    // model call.
    //
    // Refuses ONLY on a positively-established `human`. Every conversation predating
    // `0027` reads `unknown`, and `unknown` must never silence anybody: the honest default
    // and the narrow gate are one design, not two decisions (see the migration).
    //
    // Unreadable does NOT refuse. A database blip must not mute a tenant's bot, and the
    // cost of being wrong in this direction is one reply overlapping a person, which is
    // today's behaviour in every conversation anyway.
    const threadState = await readThreadState(db, { tenantId, conversationId });
    if (threadState === 'unreadable') {
      fx.log('error', 'thread_state_unreadable', { tenantId, conversationId });
    } else {
      const held = humanHoldsThread(threadState, cooldownMinutes, now);
      if (held.refuse) {
        fx.log('info', 'human_has_thread', {
          tenantId, conversationId, minutesLeft: held.minutesLeft,
        });
        // Visible to the Quality layer as a message the bot deliberately did not answer,
        // which is what it is. Without the row this is indistinguishable from a quiet
        // afternoon — D-070's whole lesson, one table over.
        await fx.flagQuality({
          tenantId, conversationId, code: 'human_has_thread',
          detail: `a person holds this thread; ${held.minutesLeft} minute(s) of cooldown left`,
        });
        notGenerated.push(message.externalId);
        continue;
      }
    }

    // A redelivery. The inbound row already existing does NOT mean the reply happened —
    // that inference cost a real message on 2026-09-06, when the first attempt persisted
    // and then died at the spend guard, and the retry skipped on the row it had just
    // written. Ask for the reply instead; `findReplyFor` carries the full account.
    if (stored.value.duplicate) {
      const answered = await findReplyFor(db, {
        tenantId, kind: 'reply', dedupKey: replyDedupKey(message.externalId),
      });
      if (answered.outcome === 'unavailable') {
        fx.log('error', 'reply_lookup_failed', { eventId, detail: answered.detail });
        return unavailable('worker.reply_lookup_failed');
      }
      if (answered.outcome === 'answered') {
        fx.log('info', 'already_answered', { eventId, outboundId: answered.outboundId, state: answered.state });
        continue;
      }
      // absent: whatever ran before never got as far as drafting. Answer it.
      fx.log('info', 'redelivery_unanswered', { eventId, externalId: message.externalId });
    }

    // The channel cannot send, and is not the mirror. Stop here — after the message is
    // stored, which is §3.4.5's "persist everything, generate nothing" taken literally for
    // the first time. `canDeliver` used to be consulted only after the reply existed, so
    // `off` and `shadow_routing` each paid for text nobody could receive; `shadow_routing`
    // did it while its own description read «nothing is generated or sent».
    //
    // The case that costs real money is a halted channel: `haltChannelOutbound` sets
    // `delivery_mode = 'off'` on a Graph 190, so before this every message after a token
    // died drafted a reply into a channel that could not send it.
    //
    // `shadow` deliberately does NOT stop here — the mirror phase generates and withholds,
    // and `delivery.deliver` below is what withholds it.
    if (!delivery.generate) {
      fx.log('info', 'not_generating', {
        tenantId, channelId, externalId: message.externalId, detail: delivery.detail,
      });
      notGenerated.push(message.externalId);
      continue;
    }

    // §3.9's check 7. AFTER the message is persisted — §3.4.5's "persist everything,
    // generate nothing" — and before the reservation, so a message nobody wants answered
    // costs three rows and not a reservation, a model call or a send.
    if (!isFresh(eventAt, now, replyAgeLimit)) {
      const ageMinutes = Math.round((now.getTime() - eventAt.getTime()) / 60_000);
      fx.log('warn', 'reply_too_late', { tenantId, externalId: message.externalId, ageMinutes, limitMinutes: replyAgeLimit });
      // The customer's question is stored and now visible to the Quality layer as one
      // nobody answered, which is exactly what it is.
      await fx.flagQuality({
        tenantId,
        conversationId,
        code: 'reply_too_late',
        detail: `${ageMinutes} minutes old; the tenant's limit is ${replyAgeLimit}`,
      });
      stale.push(message.externalId);
      continue;
    }

    // History is read AFTER storing, so the turn just received is not also passed as
    // history — the model would otherwise see the question twice.
    const history = await readHistory(db, { tenantId, conversationId, limit: RECEPTION_HISTORY_TURNS + 1 });
    if (!history.ok) {
      // An unreadable history is never an empty one: without the distinction a hiccup
      // makes the bot greet an existing customer from scratch.
      fx.log('error', 'history_failed', { detail: history.detail });
      return unavailable('worker.history_failed');
    }
    const priorTurns = history.value.slice(0, -1);

    // The chokepoint. Nothing downstream may re-implement any part of this.
    const guard = await withTenantRole(db, {
      tenantId, role: 'reception', surface: 'reception', channel: 'facebook_page',
      estimate: RECEPTION_REPLY_ESTIMATE, conversationId, webhookEventId: eventId, now, timezone,
    });

    if (!guard.ok) {
      const { refusal } = guard;
      // The detail is the whole diagnosis on a 503 — without it `guard_unavailable` names
      // a category and nothing more, which is what turned a one-line schema mismatch into
      // an evening of inference on 2026-09-06.
      fx.log('warn', 'refused', {
        code: refusal.code, tenantId, eventId,
        ...(refusal.code === 'guard_unavailable' ? { detail: refusal.detail } : {}),
      });
      // 503 means "we could not determine" — QStash must retry, so nothing is lost.
      if (refusal.status === 503) return unavailable(refusal.code);
      // 403/429 are determinate. Retrying cannot change them, so ACK and let the §5.7
      // degradation ladder answer the customer. Never silence.
      await markEventState(db, eventId, refusal.status === 429 ? 'shed' : 'blocked_no_token');
      return ok({ refused: refusal.code });
    }

    const outcome = await fx.generateReply({
      tenantId, channelId, conversationId,
      inboundExternalId: message.externalId,
      reservation: guard.reservation,
      customerMessage: message.text,
      history: priorTurns,
      eventAt,
      promptVolatile,
      ctx,
      // The history was read successfully or we would have 503'd above. `empty` is about
      // the turns BEFORE this one — the inbound row was stored a moment ago, so a first
      // message leaves priorTurns empty.
      historyEmpty: priorTurns.length === 0,
    });

    if (outcome.kind === 'retry') {
      fx.log('error', 'reception_retry', { detail: outcome.detail });
      return unavailable('worker.reception_retry');
    }
    if (outcome.kind === 'dropped') {
      fx.log('warn', 'reception_dropped', { reason: outcome.reason });
      continue;
    }
    drafted.push(outcome.outboundId);

    // WHAT ANSWERED THIS CUSTOMER, on the customer's own row. Best-effort by construction:
    // the reply already exists, so a trace that cannot be written is evidence lost, and
    // refusing over it — or 503-ing into a retry that would re-drive an already-drafted
    // event — would be worse. Same posture as `flagQuality`, for the same reason.
    const traced = await traceAnswer(db, {
      tenantId,
      messageId: stored.value.messageId,
      answeredBy: outcome.answeredBy,
      revisionId: ctx.revisionId,
      promptHash: ctx.contentHash,
    });
    if (!traced.ok) {
      fx.log('error', 'trace_failed', {
        tenantId, conversationId, messageId: stored.value.messageId, detail: traced.detail ?? '',
      });
    }

    if (outcome.refusal !== undefined) {
      fx.log('warn', 'answered_with_handoff', { code: outcome.refusal, conversationId });
    }

    // --- H14: claim the draft and put it on the wire. ---------------------
    if (!delivery.deliver) {
      // Generated and deliberately not sent. The row stays `draft`, so the day the
      // channel goes live it is claimable rather than lost.
      fx.log('info', 'not_delivering', { tenantId, channelId, detail: delivery.detail });
      continue;
    }

    const held = await claim(db, { id: outcome.outboundId, tenantId, now });
    if (held.outcome === 'unavailable') {
      fx.log('error', 'claim_unavailable', { detail: held.detail });
      return unavailable('worker.claim_unavailable');
    }
    if (held.outcome !== 'claimed') {
      // Already sent, or another worker holds a live lease. Both mean this reply is
      // somebody else's business; neither is an error.
      fx.log('info', 'not_ours', { outboundId: outcome.outboundId, outcome: held.outcome });
      continue;
    }

    const delivered = await fx.deliver({
      tenantId, channelId, pageId,
      recipientId: message.senderId,
      outboundId: held.id,
      // The STORED body, never the one just generated: on a redelivery `claim` returns
      // what was written the first time, and re-reading it here is what makes a retry a
      // re-send rather than a second answer.
      body: held.body,
      attempts: held.attempts,
      graphVersion,
    });

    if (delivered.outcome === 'sent') {
      sent.push(held.id);
      if (delivered.bookkeeping !== undefined) {
        // The customer has the message. Everything after that is bookkeeping, and a
        // bookkeeping failure must never make the next redelivery send it again.
        fx.log('error', 'send_bookkeeping_failed', { outboundId: held.id, detail: delivered.bookkeeping });
      }
      continue;
    }
    if (delivered.outcome === 'indeterminate') {
      // Parked, alerted, and outside CLAIMABLE. 200 so QStash does not retry it — the
      // whole point is that no automatic retry may touch this row.
      fx.log('warn', 'send_indeterminate', { outboundId: held.id, detail: delivered.detail });
      continue;
    }
    if (delivered.retryable) {
      // 613 or a 5xx. The lease is released and the stored body is intact, so the
      // redelivery re-sends rather than re-generating.
      fx.log('warn', 'send_retryable', { outboundId: held.id, failure: delivered.failure });
      return unavailable(`worker.send_${delivered.failure}`);
    }
    fx.log('error', 'send_terminal', { outboundId: held.id, failure: delivered.failure, detail: delivered.detail });
  }

  // Every message in the entry is accounted for.
  //
  // `replied_at` only when something was actually drafted. An entry whose every message was
  // skipped, or whose channel cannot generate, is `processed` and has produced no answer —
  // and those two facts must not be spelled the same way, which is the whole reason this
  // column stopped being written-by-nothing.
  await markEventState(db, eventId, 'processed', drafted.length > 0 ? now : undefined);
  return ok({
    eventId, drafted: drafted.length, sent: sent.length, stale: stale.length, skipped: skipSummary(skipped),
    notGenerated: notGenerated.length,
    ...(commentResult === null ? {} : { comments: commentResult }),
  });
}
