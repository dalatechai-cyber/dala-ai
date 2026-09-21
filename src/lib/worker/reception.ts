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
import type { Surface } from '../reception/volatile.ts';
import { tenantClock } from '../time/clock.ts';
import { RECEPTION_HISTORY_TURNS } from '../model/reception.ts';
import { withTenantRole } from '../guard/withTenantRole.ts';
import { claim, findReplyFor, replyDedupKey } from '../outbound/claim.ts';
import { markEventState, recordDeliveryAttempt } from '../webhook/events.ts';
import { usdToNano } from '../money.ts';
import { isFresh, replyAgeLimitMinutes } from './freshness.ts';
import { runCommentJob, type CommentEffects, type CommentJobResult } from './comments.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { Turn } from '../inbound/persist.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import type { Reservation } from '../spend/reserve.ts';
import type { ReceptionContext } from '../reception/load.ts';

/**
 * The surface this worker answers on.
 *
 * Reception is the DIRECT MESSAGE path and only that: every draft it writes is
 * `kind: 'reply'` — one literal, below — and the comment surface is `worker/comments.ts`,
 * which posts a reviewed row's bytes and never builds a prompt at all. Verified against the
 * live project on 2026-09-17: all sixty-one outbound rows this platform has ever written are
 * `kind = 'reply'` with a null `comment_post_id`. No comment conversation has ever existed.
 *
 * It was `channel: 'facebook_page'` here, and that is the provider, not the surface. Ш0 asks
 * whether the reply is publicly visible; Facebook carries both a public wall and a private
 * inbox, so the provider's name cannot answer it, and the model resolved the ambiguity the
 * wrong way — see `Surface` in `reception/volatile.ts` for the measured cost.
 *
 * A constant rather than an inline literal so there is one place to change when a comment
 * path grows a prompt, and so the reasoning sits with the value instead of at the call site.
 */
const RECEPTION_SURFACE: Surface = 'direct_message';

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
  /** Attachment kinds on the customer's message, for the gate (D-083). */
  customerAttachments: readonly string[];
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
  /**
   * QStash has just made its last delivery of this event and the worker refused it again,
   * so nothing else is coming. Raised from the worker rather than waiting for the hourly
   * sweep, which is what made D-110's customer wait 57 minutes to be noticed.
   */
  alertDeliveryExhausted: (input: {
    tenantId: string; eventId: number; attempts: number;
    /** NaN when `received_at` could not be read. Never reported as a number. */
    ageMinutes: number;
    /**
     * NULL when the job refused BEFORE it read the tenant row — an unreadable `tenants`
     * row is one of the 503s that can exhaust a delivery, and on that path the platform
     * default is not this tenant's limit. Matrix's is 15 and the default is 30, so
     * substituting one would print a deadline twice as generous as the real one into a
     * critical alert.
     */
    limitMinutes: number | null;
    code: string;
  }) => Promise<void>;
  /** `META_GRAPH_VERSION`, read lazily so an unconfigured deployment fails at use. */
  graphVersionDefault: () => string;
  generateReply: (args: GenerateArgs) => Promise<ReceptionOutcome>;
  deliver: (args: DeliverArgs) => Promise<DeliverOutcome>;
  /**
   * Show the customer the typing bubble. Cosmetic, fire-and-forget, never awaited.
   *
   * The incumbent has done this for months and this platform did not, which is part of why
   * the founder measured Dala AI as "noticeably slower": a wait you can see is a different
   * experience from a silence you cannot. It is an OUTBOUND Graph call, so it is gated on
   * the same `canDeliver` verdict as a real send — a bubble in `shadow` would appear in
   * front of a customer the incumbent is answering and never produce a message.
   */
  showTyping: (args: { tenantId: string; channelId: string; recipientId: string }) => Promise<void>;
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

/**
 * Where a reply's wall-clock actually goes, measured rather than reasoned about.
 *
 * The bake-off measured the MODEL PATH at 3.7s p50 — prompt assembly, the Anthropic call,
 * the gate and the guard — while production measured **25.8s p50** from the inbound row to
 * the draft. That gap is roughly twenty seconds of something, and the honest answer is that
 * nobody knows which something: the harness stubs the database, so it cannot see it.
 *
 * `loadReceptionContext` already issues its ten reads in one `Promise.all`, so the obvious
 * candidate is already done — which is exactly why guessing at the next one would be
 * guessing. This records the real split on every reply instead, so the next production turn
 * answers the question that a week of reasoning would not.
 *
 * It is a LOG LINE and nothing else: no branch reads it, no alert fires on it, and it
 * cannot change what a customer is told. `Date.now()` rather than a high-resolution timer
 * because the quantity of interest is seconds, and a monotonic clock would be precision
 * about the wrong thing.
 */
function stopwatch(): { lap: (phase: string) => void; phases: Record<string, number> } {
  const phases: Record<string, number> = {};
  let last = Date.now();
  return {
    lap: (phase) => {
      const nowMs = Date.now();
      // Accumulated, not assigned: the message loop runs these phases once per message in
      // an entry, and an entry can carry several. Overwriting would report the last
      // message's timings as if they were the whole job's.
      phases[phase] = (phases[phase] ?? 0) + (nowMs - last);
      last = nowMs;
    },
    phases,
  };
}

/**
 * How many times QStash delivers one reception job before abandoning it.
 *
 * MEASURED, not read from a document: event 266 on 2026-09-21 was delivered at 02:02:24,
 * 02:02:47 and 02:05:27 and never again, under the `retries: 3` this platform publishes
 * with. So the whole retry horizon is about three MINUTES, and the third delivery is the
 * last chance to notice that a customer is not going to be answered.
 *
 * If this is ever wrong in the safe direction — QStash delivers a fourth time — the
 * exhaustion alert has already fired on the third and is deduplicated by event id, so the
 * fourth changes nothing. Wrong in the other direction (QStash stops at two) the alert
 * never fires from here and `sweepStrandedEvents` still catches it, late, as it did before.
 * Both failure modes degrade to the previous behaviour rather than to silence.
 *
 * ## `webhook_events.max_attempts` exists, says 2, and is deliberately NOT read
 *
 * It has been in the schema since `0001` with `default 2` and no reader — the same dead
 * state `attempts` was in until this change. Wiring it in is the obvious next tidy-up and
 * it would be WRONG: it disagrees with the measurement by one, so the alert would fire on
 * QStash's second delivery and announce that nothing else is coming while a third was
 * already scheduled. Telling a founder a customer is unanswered, immediately before the
 * platform answers them, is worse than the silence it replaces.
 *
 * The number that belongs here is QStash's retry count, which this repository sets in
 * `queue/qstash.ts` (`retries: 3`) — not a column nobody has ever written to match it. If
 * that publish option changes, change this, and re-measure rather than assuming the
 * arithmetic: `retries: 3` produced three deliveries, not four.
 */
export const RECEPTION_MAX_DELIVERIES = 3;

const ok = (body: Record<string, unknown>): JobResult => ({ status: 200, body: { ok: true, ...body } });
const unavailable = (code: string): JobResult => ({ status: 503, body: { error: code } });

/**
 * What this delivery turned out to be, filled in as the job learns it.
 *
 * A plain record rather than a return value because every `return unavailable(...)` site
 * below is a different refusal and none of them should have to remember to carry it. The
 * wrapper reads whatever was established before the refusal happened.
 */
type DeliveryTrace = {
  eventId: number | null;
  tenantId: string | null;
  attempts: number;
  /** NaN until `received_at` is read, and left NaN if it cannot be parsed. */
  ageMinutes: number;
  /** NULL until the TENANT's own limit is read. Never pre-filled with the default. */
  limitMinutes: number | null;
};

export async function runReceptionJob(
  fx: WorkerEffects,
  request: { rawBody: string; signature: string | null },
): Promise<JobResult> {
  const trace: DeliveryTrace = {
    eventId: null, tenantId: null, attempts: 0,
    ageMinutes: Number.NaN, limitMinutes: null,
  };
  const result = await runReceptionDelivery(fx, request, trace);

  // The only place that knows BOTH that this delivery failed retryably and that it was the
  // last one. A 503 is the worker asking for a redelivery; on the final attempt there is no
  // redelivery coming, so the same status code means the opposite thing — the customer is
  // about to go unanswered. Nothing downstream can tell those apart, which is why the alert
  // belongs here and not in the hourly sweep (D-110).
  if (result.status === 503 && trace.eventId !== null && trace.tenantId !== null
      && trace.attempts >= RECEPTION_MAX_DELIVERIES) {
    const code = typeof result.body['error'] === 'string' ? result.body['error'] : 'unknown';
    try {
      await fx.alertDeliveryExhausted({
        tenantId: trace.tenantId, eventId: trace.eventId, attempts: trace.attempts,
        ageMinutes: trace.ageMinutes, limitMinutes: trace.limitMinutes, code,
      });
    } catch (e) {
      // An alert that throws must not turn a 503 into a 500: the status QStash sees decides
      // whether it retries, and this path is reached when we most want that behaviour left
      // exactly as the job chose it.
      fx.log('error', 'delivery_exhausted_alert_failed', {
        eventId: trace.eventId, detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

async function runReceptionDelivery(
  fx: WorkerEffects,
  request: { rawBody: string; signature: string | null },
  trace: DeliveryTrace,
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
  const clock = stopwatch();

  // --- The stored entry. One source, parsed once, at the point of use. -------
  const { data: event, error: eventErr } = await db
    .from('webhook_events')
    .select('raw_payload, attempts, received_at')
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

  // --- This delivery happened. Counted here, before anything can refuse. ----------------
  //
  // The earliest point at which the row is known to exist, and deliberately above every
  // refusal below: a run that dies inside its own error handling must still leave evidence
  // that QStash delivered it, because "delivered and failed" and "never delivered" send an
  // operator to completely different systems (D-110). The counter is diagnostic, so a write
  // that fails is logged and the job carries on — a customer's reply never depends on it.
  const eventRow = event as Record<string, unknown>;
  trace.eventId = eventId;
  trace.tenantId = tenantId;
  const priorAttempts = typeof eventRow['attempts'] === 'number' ? eventRow['attempts'] : 0;
  clock.lap('event_read');
  const counted = await recordDeliveryAttempt(db, eventId, priorAttempts);
  clock.lap('attempt_write');
  trace.attempts = counted.attempts;
  if (!counted.ok) fx.log('error', 'attempt_count_failed', { eventId, detail: counted.detail });

  const receivedRaw = eventRow['received_at'];
  const receivedMs = typeof receivedRaw === 'string' ? new Date(receivedRaw).getTime() : Number.NaN;
  trace.ageMinutes = Number.isNaN(receivedMs) ? Number.NaN : (now.getTime() - receivedMs) / 60_000;

  const rawPayload = eventRow['raw_payload'];
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
  // Bound here, at the first line where the row is in hand, and NOT thirty lines down with
  // the rest of the settings: `worker.tenant_timezone_missing` refuses in between, and an
  // exhaustion alert on that path would have to say the limit was unknown when the value
  // was sitting in a variable. The trace carries what has actually been read, so it is
  // filled the moment each thing is readable (D-110).
  const replyAgeLimit = replyAgeLimitMinutes(t['max_reply_age_minutes']);
  trace.limitMinutes = replyAgeLimit;
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
  clock.lap('tenant_read');
  const timezone = rawTimezone;
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
      .map((sk) => ({
        mid: sk.externalId as string,
        psid: sk.recipientId as string,
        // Which APP Meta says sent it. Without this "not one of our sends" reads as "a
        // person typed this", and on Matrix's Page every ancestor reply is exactly that
        // false positive — harmless only while the channel is `shadow`.
        appId: sk.appId,
      }));
    const handover = await recordHandover(db, {
      tenantId, channelId, ourAppId: metaAppId, entry: rawPayload, echoes,
      deliveryMode, now,
    });
    // `echoes > 0` is in this condition and the other three are not enough without it.
    // In `shadow` an echo moves nothing, so `events`, `changed` and `echoTakeovers` are
    // all zero for every echo this platform will see before cutover — the counter added
    // beside them would have been unreachable for the entire mirror phase, which is the
    // one window it exists to inform. A guard whose trigger cannot fire is this
    // repository's most repeated defect; it is not worth committing a fresh one.
    if (handover.events > 0 || handover.changed > 0
        || handover.echoTakeovers > 0 || handover.echoes > 0) {
      fx.log('info', 'thread_control', {
        eventId, events: handover.events, changed: handover.changed,
        echoes: handover.echoes, echoTakeovers: handover.echoTakeovers,
        echoesFromApp: handover.echoesFromApp, echoAppIds: handover.echoAppIds,
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
  clock.lap('context_load');
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
    now, timezone, surface: RECEPTION_SURFACE, hours: ctx.hours, closures: ctx.closures,
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
    clock.lap('persist_inbound');
    const threadState = await readThreadState(db, { tenantId, conversationId });
    clock.lap('thread_state');
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

    // --- The captioned attachment, counted (D-083). ------------------------------------
    //
    // A photograph with no caption is answered by `inbound/imageReply.ts` and never reaches
    // here. A photograph WITH a caption carries text, so it comes down this path and goes to
    // the model — which cannot see it, and until now was not even told it existed, because
    // `extract.ts` computed the attachment kinds and dropped them for any message that had
    // text. This row is the instrument: before deciding what such a message should be
    // answered WITH, the corpus has to be able to say how often one arrives.
    //
    // Stickers are excluded rather than counted, and that is D-070's lesson applied on the
    // other side: Meta sends one sticker as TWO attachments and declares the first `image`,
    // so `type` alone would turn every thumbs-up with a word next to it into a photograph.
    // Any `stickerIds` at all means filler, whatever the kinds claim.
    //
    // Before `delivery.generate`, so a captioned photograph arriving at a channel that is
    // `off` or in `shadow` is still counted — the mirror phase is precisely when this
    // number is wanted.
    if (message.attachments.length > 0 && message.stickerIds.length === 0) {
      fx.log('info', 'inbound_captioned_attachment', {
        tenantId, externalId: message.externalId, attachments: message.attachments,
      });
      await fx.flagQuality({
        tenantId,
        conversationId,
        code: 'inbound_captioned_attachment',
        detail: `${message.attachments.join(', ')} arrived with text; the model cannot see it`,
      });
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
    clock.lap('history_read');
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

    clock.lap('guard');

    // The bubble. Placed HERE, and the placement is the whole of its correctness.
    //
    // Two independent conditions, and it took both to get this right:
    //
    // `delivery.deliver` and not `delivery.generate` — the mirror generates and withholds,
    // so a `shadow` channel must stay invisible on the Page. An indicator there would be
    // shown to a customer the incumbent is answering, promising a message that never comes.
    // Gating it on `generate` would have been the natural mistake and is the one that
    // reaches a real person.
    //
    // And AFTER every exit that ends in no message at all. Its first form sat above the
    // freshness check, the history read and the spend guard, so a replayed event past
    // Matrix's 15-minute limit, a tenant with no token (403) and a shed message (429) each
    // showed a customer «typing…» and then nothing. A bubble is a PROMISE of a reply; the
    // only thing left below this line is the model call it exists to cover. It costs ~300ms
    // of bubble latency to buy that, which is the right side of the trade: the wait being
    // decorated is the 3-5 second generate, not the reads above it.
    //
    // Not awaited, and its own failures are swallowed inside the effect: a customer's reply
    // must never wait on, or be lost to, a decoration.
    if (delivery.deliver) {
      void fx.showTyping({ tenantId, channelId, recipientId: message.senderId })
        .catch((e: unknown) => {
          fx.log('info', 'typing_indicator_failed', {
            externalId: message.externalId, detail: e instanceof Error ? e.message : String(e),
          });
        });
    }

    const outcome = await fx.generateReply({
      tenantId, channelId, conversationId,
      inboundExternalId: message.externalId,
      reservation: guard.reservation,
      customerMessage: message.text,
      customerAttachments: message.attachments,
      history: priorTurns,
      eventAt,
      promptVolatile,
      ctx,
      // The history was read successfully or we would have 503'd above. `empty` is about
      // the turns BEFORE this one — the inbound row was stored a moment ago, so a first
      // message leaves priorTurns empty.
      historyEmpty: priorTurns.length === 0,
    });
    // Lapped the instant the call returns, and deliberately BEFORE the outcome is
    // branched on. Its first form lapped below the `!delivery.deliver` early-continue, so
    // a `shadow` tenant recorded every phase EXCEPT the model call — and shadow is Matrix,
    // the only tenant whose latency anybody is asking about. An instrument that omits the
    // dominant phase for the tenant being measured is worse than no instrument.
    clock.lap('generate');

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
    clock.lap('trace');

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
    clock.lap('claim');
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
  clock.lap('deliver_and_mark');
  // One line per job. It answers "where did the twenty seconds go" from the next real
  // customer turn rather than from a week of reasoning — the bake-off harness stubs the
  // database and structurally cannot see this split.
  fx.log('info', 'reply_timing_ms', { eventId, tenantId, ...clock.phases });
  await markEventState(db, eventId, 'processed', drafted.length > 0 ? now : undefined);
  return ok({
    eventId, drafted: drafted.length, sent: sent.length, stale: stale.length, skipped: skipSummary(skipped),
    notGenerated: notGenerated.length,
    ...(commentResult === null ? {} : { comments: commentResult }),
  });
}
