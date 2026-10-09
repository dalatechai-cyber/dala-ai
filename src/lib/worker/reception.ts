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
import type { NeedsPersonThread } from '../handover/pageLabel.ts';
import { canDeliver } from '../channel/delivery.ts';
import { extractInboundMessages } from '../meta/extract.ts';
import { INSTAGRAM_MAX_TEXT_BYTES } from '../meta/send.ts';
import { isLike, likeIsOwedReply, likeRowFor } from '../inbound/like.ts';
import { ensureContact, ensurePerson, openConversation, readHistory, recordInbound, traceAnswer } from '../inbound/persist.ts';
import { recordDroppedInbound, skipSummary } from '../inbound/dropped.ts';
import { draftImageReplies, planImageReplies, readImageLine } from '../inbound/imageReply.ts';
import { applyThreadControl, recordHandover, readThreadState } from '../handover/record.ts';
import { personRepliedSince } from '../handover/presend.ts';
import { humanHoldsThread } from '../handover/control.ts';
import { mediaAloneDedupKey, photoQuestionDedupKey, planMediaAlone, readCannedLine, readHandoverNotice, unseenMediaOf } from '../handover/media.ts';
import {
  PHOTO_BATCH_MS, PHOTO_PRICE_QUESTION_KIND, photoAloneStep, questionFor, REEL_PRICE_QUESTION_KIND, type PhotoQuestionState,
} from '../reception/photoPrice.ts';
import { photoQuestionState, readLastReply, readRecentMediaQuestion } from '../inbound/photoQuestion.ts';
import { isApprovedLinesRefusal, publishedLine } from '../prompt/cannedDrift.ts';
import { planVoiceAlone, voiceDedupKey, VOICE_REPLY_KIND, type NeedsPersonReason, type ReplySent } from '../handover/needsPerson.ts';
import { CREDENTIAL_FAILURE_STATUS, clearCredentialFailure } from '../channel/recover.ts';
import { CATCH_UP_WINDOW_MINUTES, HELD_FLAG } from '../channel/catchup.ts';
import { loadReceptionContext } from '../reception/load.ts';
import { renderVolatile } from '../reception/volatile.ts';
import type { Surface } from '../reception/volatile.ts';
import { localDayStart, tenantClock } from '../time/clock.ts';
import { RECEPTION_HISTORY_TURNS } from '../model/reception.ts';
import { withTenantRole } from '../guard/withTenantRole.ts';
import { claim, draftOnce, findReplyFor, markRefused, replyDedupKey } from '../outbound/claim.ts';
import { markEventState, recordDeliveryAttempt } from '../webhook/events.ts';
import { usdToNano } from '../money.ts';
import { isFresh, replyAgeLimitMinutes } from './freshness.ts';
import { COMMENT_JOB_BUDGET_MS, runCommentJob, type CommentEffects, type CommentJobResult } from './comments.ts';
import { serveReclaim } from './reclaim.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { Turn } from '../inbound/persist.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import type { Reservation } from '../spend/reserve.ts';
import type { LoadTimings, ReceptionContext } from '../reception/load.ts';
import type { ExhaustedInput } from './exhaustedAlert.ts';
import type { QuickReply } from '../meta/send.ts';
import type { TurnInput as BookingTurnInput, TurnResult as BookingTurnResult } from '../booking/turn.ts';
import { matchingText } from '../mn/chat.ts';

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
  /** A photograph and not a sticker (D-070) — the kinds alone cannot say which. */
  customerSentPhoto: boolean;
  history: readonly Turn[];
  eventAt: Date;
  promptVolatile: string;
  ctx: ReceptionContext;
  historyEmpty: boolean;
  /** D-176: where the conversation stands with the bot's photo question; null when it does not end on it. */
  photoQuestionState: PhotoQuestionState | null;
  /** A picture with words, after a photo or reel question asked earlier in the hour (`readRecentMediaQuestion`). */
  photoQuestionEarlier?: boolean;
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
  /** The channel whose `page_token` the send uses, when not `channelId` (Instagram, D-141). */
  tokenChannelId?: string;
  /** The channel's text limit in UTF-8 bytes, when it has one (Instagram: 1000, D-141). */
  maxTextBytes?: number;
  /** In-chat booking only: quick replies and the pay button's title. Never stored. */
  quickReplies?: readonly QuickReply[];
  linkButtonTitle?: string;
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
  alertDeliveryExhausted: (input: ExhaustedInput) => Promise<void>;
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
  showTyping: (args: {
    tenantId: string; channelId: string; recipientId: string;
    /** Who the bubble is shown as: the channel's Page, or the Page it sends through (D-141). */
    pageId: string;
    /** The channel whose `page_token` the call uses, when not `channelId` (D-141). */
    tokenChannelId?: string;
    /** Default `typing_on`. `typing_off` clears a bubble that landed after its reply (D-124). */
    action?: 'typing_on' | 'typing_off';
  }) => Promise<void>;
  /**
   * §3.9's "Quality flag" on a refusal. Best-effort by construction: it is evidence for a
   * person to read later, never a control, and a flag that cannot be written must not
   * change what the customer gets.
   */
  flagQuality: (args: { tenantId: string; conversationId: string; code: string; detail: string; messageId?: string }) => Promise<void>;
  /**
   * The sales shadow (D-127): after a reply is DRAFTED, record whether a next step would be
   * offered and whether the customer's message was a lead. It reads the stored reply and
   * writes only `quality_flags`; it cannot change the reply, send anything or alert anyone.
   * Must never reject — the binding swallows and logs its own failures — and the worker
   * waits for it at most `SALES_SHADOW_WAIT_MS`, beside the claim.
   */
  salesShadow: (args: SalesShadowArgs) => Promise<void>;
  /** Structured, and injected so a test can assert the REASON rather than the status. */
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
  /** The public-comment surface. Its own effects, because it is its own surface. */
  replyToComment: CommentEffects['replyToComment'];
  sendPrivateReply: CommentEffects['sendPrivateReply'];
  lookupComment: CommentEffects['lookupComment'];
  alertComplaint: CommentEffects['alertComplaint'];
  /**
   * A daily cap refused this reply (rulebook §3.1: the emergency brake "alerts the founder
   * immediately"). Required, so a binding cannot forget it. Must never reject and must return
   * within its own bound (`spend/ceilingAlert.ts`); the result is only logged.
   */
  alertCeilingReached: (args: { tenantId: string; timezone: string; channel: string }) => Promise<string>;
  /** A customer's photo, video or media link was handed to staff (`handover/media.ts`). Optional: absent sends nothing. */
  alertMediaHandoff?: (args: { tenantId: string; conversationId: string; externalId: string; text: string }) => Promise<void>;
  /**
   * A customer needs a person: a complaint, the handoff line, or a voice message
   * (`handover/needsPerson.ts`). Required, so no wiring can leave it silently unset. Must
   * never reject: the binding logs its own failures. Resolves false only when this exact
   * alert was already raised (a redelivery), so the caller can skip its own bookkeeping.
   */
  /**
   * A reply met `canned_stale`: approved lines changed without a republish (D-163). Pages at
   * once, one `on_change` episode per tenant. Returns what happened, for the log; must never
   * reject and is bounded (`prompt/cannedDrift.ts`).
   */
  alertCannedStale: (args: { tenantId: string; channel: string }) => Promise<string>;
  /**
   * `thread`: the chat, so the route can also label it in the tenant's Page inbox when the
   * tenant has a label set (0079, `handover/pageLabel.ts`). Absent: page only.
   */
  alertNeedsPerson: (args: {
    tenantId: string; conversationId: string; reason: NeedsPersonReason; provider: string; sent: ReplySent; thread?: NeedsPersonThread;
  }) => Promise<boolean>;
  /**
   * In-chat booking (`booking/turn.ts`, design `docs/proposals/tara-inchat-booking.md`). Absent:
   * the flow does not exist for this job, which is every deployment without `BOOKING_MODE`.
   * Asked only for a Messenger message the job would deliver; `handled: false` means the
   * ordinary path answers it exactly as before. Must never reject (the binding catches).
   */
  bookingTurn?: (input: BookingTurnInput) => Promise<BookingTurnResult>;
};

export type SalesShadowArgs = {
  tenantId: string;
  conversationId: string;
  messageId: string;
  outboundId: string;
  customerMessage: string;
  customerSentPhoto: boolean;
  history: readonly Turn[];
  refusal: boolean;
  threadControl: string;
  ctx: ReceptionContext;
  /** Named in a lead notice when the conversation is not on the Page (D-141). */
  channelLabel?: string;
};

/**
 * How long the reply waits for the sales shadow before going on without it (D-127). Its
 * reads run beside the claim and the person-replied check, so on a normal day it adds
 * nothing; this bounds the bad day. A shadow that has not finished by then keeps running and
 * is logged `sales_shadow_late` — a record that may be missing, said out loud.
 */
export const SALES_SHADOW_WAIT_MS = 250;

export type JobResult = { status: number; body: Record<string, unknown> };

/** How long, AFTER a reply is sent, the worker waits on a late bubble before clearing it (D-124). */
export const TYPING_WAIT_MS = 1_500;

/** Resolve when `p` settles or after `ms`, whichever is first; never rejects, never lingers. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

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
 * **It IS wrong in the safe direction, measured 2026-09-24**: events 731, 733, 735 and 737
 * each got a FOURTH delivery about 33 minutes after the first (`attempts = 4`, and the
 * fourth ran `reply_too_late`). So `retries: 3` is four deliveries. Why 266 got no fourth is
 * NOT established — the sweep that expired it ran at 57 minutes, after a fourth at ~33 would
 * have been due — so do not read either measurement as the rule. The third is still the right moment to
 * alert: for Matrix's 15-minute limit the fourth arrives too late to answer anyone. The
 * exhaustion alert fires on the third and is deduplicated by event id, so the fourth
 * changes nothing. Wrong in the other direction (QStash stops at two) the alert
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
  /**
   * NULL until the TENANT's own limit is read — an unreadable `tenants` row is one of the
   * 503s that can exhaust a delivery, and on that path the platform default is not this
   * tenant's limit. Matrix's is 15 and the default is 30, so substituting one would print a
   * deadline twice as generous as the real one into a critical alert.
   */
  limitMinutes: number | null;
  /** What the refusing code meant this time. Null when the refusal carried no detail. */
  detail: string | null;
  channelId: string | null;
  /**
   * NULL until the channel row is read. Whether a failure left a customer waiting depends
   * on it: in `shadow` our reply was never going to be sent (`health/answered.ts`).
   */
  deliveryMode: string | null;
  ourAppId: string | null;
  /** The customer messages in the entry, once extracted. */
  turns: { psid: string; sentAt: Date }[];
};

export async function runReceptionJob(
  fx: WorkerEffects,
  request: { rawBody: string; signature: string | null },
): Promise<JobResult> {
  const trace: DeliveryTrace = {
    eventId: null, tenantId: null, attempts: 0,
    ageMinutes: Number.NaN, limitMinutes: null,
    detail: null, channelId: null, deliveryMode: null, ourAppId: null, turns: [],
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
        detail: trace.detail, channelId: trace.channelId, deliveryMode: trace.deliveryMode,
        ourAppId: trace.ourAppId, turns: trace.turns,
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

  let job: { eventId?: unknown; tenantId?: unknown; channelId?: unknown; catchUpMid?: unknown; reclaimMid?: unknown };
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
  // A catch-up job (`channel/catchup.ts`): answer this ONE message, held while the channel
  // was halted, and nothing else in the entry. Null on every ordinary delivery.
  const catchUpMid = typeof job.catchUpMid === 'string' && job.catchUpMid !== '' ? job.catchUpMid : null;
  // A reclaim job (`handover/reclaim.ts`): serve the tenant's reviewed reclaim line for this
  // ONE held message and hand the thread back (`worker/reclaim.ts`). Nothing else runs.
  const reclaimMid = typeof job.reclaimMid === 'string' && job.reclaimMid !== '' ? job.reclaimMid : null;
  if (eventId === null || tenantId === null || channelId === null) {
    fx.log('error', 'job_missing_fields');
    return ok({ dropped: 'job_missing_fields' });
  }
  if (catchUpMid !== null && reclaimMid !== null) {
    // We published it wrong: the two modes answer the same message in different ways.
    fx.log('error', 'job_conflicting_modes');
    return ok({ dropped: 'job_conflicting_modes' });
  }
  // One message re-driven by a sweep: the catch-up or the reclaim.
  const onlyMid = catchUpMid ?? reclaimMid;

  const { db, now } = fx;
  const clock = stopwatch();
  // The comment job's time budget is measured from here, the start of this delivery (D-166).
  const startedMs = Date.now();

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
  trace.channelId = channelId;
  const priorAttempts = typeof eventRow['attempts'] === 'number' ? eventRow['attempts'] : 0;
  clock.lap('event_read');
  // A reclaim job is NOT a delivery of this event. It re-uses the held message's stored row
  // (the sweep has no other handle on it), so counting it would bump `attempts` on an event
  // that was answered, or held, long ago, and `trace.attempts >= RECEPTION_MAX_DELIVERIES`
  // would then page `webhook.delivery_exhausted` about a customer whose own delivery finished
  // hours earlier. So it is neither written nor carried in the trace: `trace.attempts` stays 0
  // and the exhaustion alert cannot fire for a reclaim job. Its own retries are the hourly
  // sweep's. (The catch-up job has the same shape but is left counting: it IS the customer's
  // reply, and an exhausted catch-up is a customer going unanswered.)
  // Three independent round trips, issued together (speed, D-124): the attempt counter,
  // the tenant's settings and the channel. None depends on another, and each result is
  // still EVALUATED in the order the code below always used, so every refusal fires exactly
  // where it did — only the waiting overlaps. Measured live: ~180ms sequential.
  const [counted, tenantRead, channelRead] = await Promise.all([
    reclaimMid === null ? recordDeliveryAttempt(db, eventId, priorAttempts) : Promise.resolve(null),
    db
      .from('tenants')
      .select('default_locale, prompt_cache_mode, timezone, max_reply_age_minutes, human_takeover_cooldown_minutes')
      .eq('id', tenantId)
      .maybeSingle(),
    db
      .from('tenant_channels')
      .select('provider, external_id, via_channel_id, test_sender_ids, comment_rule_keys, status, delivery_mode, token_status, meta_app_id, graph_version_override, comment_policy, comment_delivery_mode, comment_max_post_age_days, ignore_commenter_ids, comment_replies_per_post_per_day, automation_texts')
      .eq('id', channelId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ]);
  clock.lap('attempt_write');
  if (counted !== null) {
    trace.attempts = counted.attempts;
    if (!counted.ok) fx.log('error', 'attempt_count_failed', { eventId, detail: counted.detail });
  }

  const receivedRaw = eventRow['received_at'];
  const receivedMs = typeof receivedRaw === 'string' ? new Date(receivedRaw).getTime() : Number.NaN;
  trace.ageMinutes = Number.isNaN(receivedMs) ? Number.NaN : (now.getTime() - receivedMs) / 60_000;

  const rawPayload = eventRow['raw_payload'];
  const extracted = extractInboundMessages(rawPayload);
  // In catch-up mode only the held message is re-run. The entry's echoes, stickers,
  // photographs and standby count were all handled when it first arrived; repeating them
  // would re-count handovers and re-answer pictures.
  // A reclaim job is the same: only its held message, nothing else in the entry.
  const messages = onlyMid === null
    ? extracted.messages : extracted.messages.filter((m) => m.externalId === onlyMid);
  const skipped = onlyMid === null ? extracted.skipped : [];
  const standby = onlyMid === null ? extracted.standby : 0;
  trace.turns = messages.map((m) => ({ psid: m.senderId, sentAt: m.sentAt }));

  // --- Tenant settings, read once for the whole entry. ----------------------
  //
  // Above the standby branch, not below it, because the standby alert's dedup key is a
  // date on the TENANT'S calendar and there is nowhere else to get one. That makes an
  // unreadable `tenants` row a 503 for a standby entry too, which is the right way round:
  // every other refusal in this function treats a read it cannot complete as undetermined,
  // and a redelivery costs nothing while a mis-keyed alert either fires twice a day or
  // goes quiet for one.
  const { data: tenantRow, error: tenantErr } = tenantRead;
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

  // Started NOW, awaited in the message loop (D-124). Only when there is a message to
  // answer: an echo or a comment-only entry must not cost the ten context reads. Never
  // rejects — a throw becomes the same `unavailable` the loader returns for a failed read —
  // because a job that returns early never awaits it, and an unhandled rejection on a warm
  // lambda would outlive this request.
  //
  // The snapshot is the CHANNEL's (`config_snapshots.channel` is the provider), so an
  // Instagram message reads the `instagram` snapshot — compiled by the same publish, from the
  // same rows, as the Page's (D-141). The channel row is already in hand: it was read above,
  // beside the tenant. An unreadable or missing row starts nothing here; the job refuses on it
  // below, before any context is awaited.
  const provider = channelRead.error || channelRead.data === null
    ? '' : String((channelRead.data as Record<string, unknown>)['provider'] ?? '');
  const startContext = (): Promise<Awaited<ReturnType<typeof loadReceptionContext>>> =>
    loadReceptionContext(db, { tenantId, channel: provider, settings, localDate })
      .catch((e: unknown) => ({ ok: false as const, code: 'unavailable' as const, detail: `context load threw: ${e instanceof Error ? e.message : String(e)}` }));
  // Not for a reclaim job: it serves a stored row and never needs the context.
  const contextPromise = messages.length > 0 && provider !== '' && reclaimMid === null ? startContext() : null;
  /** The context, started once: the promise above, or a load begun on first need. */
  let contextLoad = contextPromise;
  const loadContext = () => (contextLoad ??= startContext());

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
  const { data: channelRow, error: channelErr } = channelRead;
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
  const deliveryMode = String(c['delivery_mode'] ?? '');
  // --- Who the reply is sent AS, and with whose credential (D-141). -----------------------
  //
  // A Page channel sends as itself. An Instagram account connected to a Page is messaged
  // THROUGH the Page, with the Page's token: `via_channel_id` names that Page channel, and
  // the composite foreign key keeps it inside this tenant. It is read only when set, so a
  // Page channel pays no extra round trip.
  const viaChannelId = typeof c['via_channel_id'] === 'string' && c['via_channel_id'] !== ''
    ? String(c['via_channel_id']) : null;
  let pageId = String(c['external_id'] ?? '');
  if (viaChannelId !== null) {
    const { data: via, error: viaErr } = await db
      .from('tenant_channels')
      .select('external_id')
      .eq('id', viaChannelId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (viaErr) {
      fx.log('error', 'via_channel_unreadable', { tenantId, channelId, viaChannelId, detail: viaErr.message });
      return unavailable('worker.via_channel_unreadable');
    }
    if (via === null) {
      // The foreign key makes this unreachable while it holds. Refused rather than sent as
      // the channel's own id, which on Instagram is not a Page and would fail every send.
      fx.log('error', 'via_channel_missing', { tenantId, channelId, viaChannelId });
      return ok({ dropped: 'via_channel_missing' });
    }
    pageId = String((via as Record<string, unknown>)['external_id'] ?? '');
  }
  const tokenChannelId = viaChannelId ?? undefined;
  const viaToken = tokenChannelId === undefined ? {} : { tokenChannelId };
  // Instagram's text limit is 1000 BYTES; Messenger's is far above any reply (D-141).
  const maxTextBytes = provider === 'instagram' ? INSTAGRAM_MAX_TEXT_BYTES : undefined;
  // In `shadow`, these senders are answered for real — the founder trying a channel from
  // their own account before anyone else is (D-141). Ignored in every other mode.
  const testSenders: ReadonlySet<string> = new Set(
    deliveryMode === 'shadow' && Array.isArray(c['test_sender_ids'])
      ? (c['test_sender_ids'] as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
      : [],
  );
  // Read here so the recovery write at the end costs nothing on a healthy channel: the
  // common case is `active`, and then no statement is issued at all. See `channel/recover`.
  const channelStatus = String(c['status'] ?? '');
  const delivery = canDeliver(deliveryMode);
  // Meta's own app id, never the callback slug (D-041). Null makes every handover verdict
  // `unknown`, which changes no thread state — correct, and visibly incomplete.
  const metaAppId = typeof c['meta_app_id'] === 'string' && c['meta_app_id'] !== ''
    ? String(c['meta_app_id']) : null;
  // The Page's own Meta automations: their messages are not a person (D-126 addendum).
  const automationTexts = Array.isArray(c['automation_texts'])
    ? (c['automation_texts'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  trace.deliveryMode = deliveryMode;
  trace.ourAppId = metaAppId;
  const override = c['graph_version_override'];
  const graphVersion = typeof override === 'string' && override !== '' ? override : fx.graphVersionDefault();

  // --- A reclaim job ends here. ------------------------------------------------------------
  // After the channel is resolved, so it sends as the ordinary reply would (Page, token,
  // Instagram's limit), and before anything that re-reads the entry: its echoes, media and
  // comments were all handled when it first arrived. The event's state is not rewritten.
  if (reclaimMid !== null) {
    const held = messages[0];
    return serveReclaim(fx, {
      tenantId, channelId, eventId, provider, locale: settings.defaultLocale, timezone,
      message: held === undefined ? null : { senderId: held.senderId, externalId: held.externalId, sentAt: held.sentAt },
      // Live only. A shadow tester is answered for real by the ordinary path, but a reclaim
      // flips thread ownership on the Page, which a mirror must never do.
      deliverable: delivery.deliver,
      ourAppId: metaAppId, automationTexts,
      send: {
        tenantId, channelId, pageId, graphVersion,
        ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
        ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
      },
    });
  }

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
        text: sk.echoText ?? null,
        // A template (buttons) is never typed by a person (D-143).
        template: sk.echoTemplate === true,
      }));
    const handover = await recordHandover(db, {
      tenantId, channelId, ourAppId: metaAppId, entry: rawPayload, echoes,
      automationTexts, deliveryMode, liveFor: testSenders, now,
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
    // --- A photo, a video or a shared reel or post with no words goes to a person. -------
    // (founder, 2026-09-27; reels and posts D-152 addendum)
    //
    // The tenant's reviewed notice, SENT here (nothing else claims a draft made outside
    // Reception), then the same hand-off as a captioned one: the thread becomes `human` for
    // the takeover cooldown and the founder is alerted. A thread a person already holds is
    // left to them. A tenant without a reviewed notice falls through to the image line.
    /**
     * Draft, claim and send one reviewed line to a sender whose message had no words (the photo
     * question, D-176; the media notice, D-152), under its own dedup key so a redelivery re-sends
     * the stored row and never answers twice. A retryable failure (613, 5xx) is a 503: the lease
     * is released and the row intact, so the redelivery re-claims and re-sends it. Never silence.
     * `not_delivering`: drafted on a channel that sends nothing (shadow), as the mirror is.
     */
    const sendLineAlone = async (a: { senderId: string; conversationId: string; dedupKey: string; body: string; what: string }):
      Promise<'sent' | 'not_sent' | 'not_delivering' | JobResult> => {
      const drafted = await draftOnce(db, {
        tenantId, kind: 'reply', dedupKey: a.dedupKey, body: a.body, channelId, conversationId: a.conversationId,
      });
      if (!drafted.ok) {
        fx.log('error', `${a.what}_draft_failed`, { tenantId, detail: drafted.detail });
        return unavailable(`worker.${a.what}_draft_failed`);
      }
      if (!(delivery.deliver || testSenders.has(a.senderId))) {
        fx.log('info', 'not_delivering', { tenantId, channelId, detail: a.what });
        return 'not_delivering';
      }
      const held = await claim(db, { id: drafted.row.id, tenantId, now });
      if (held.outcome === 'unavailable') return unavailable('worker.claim_unavailable');
      if (held.outcome !== 'claimed') return 'not_sent';
      const delivered = await fx.deliver({
        tenantId, channelId, pageId, recipientId: a.senderId, outboundId: held.id,
        body: held.body, attempts: held.attempts, graphVersion,
        ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
        ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
      });
      if (delivered.outcome === 'failed' && delivered.retryable) {
        fx.log('warn', `${a.what}_send_retryable`, { tenantId, failure: delivered.failure });
        return unavailable(`worker.send_${delivered.failure}`);
      }
      if (delivered.outcome !== 'sent') {
        fx.log('error', `${a.what}_not_sent`, { tenantId, conversationId: a.conversationId, outcome: delivered.outcome });
        return 'not_sent';
      }
      return 'sent';
    };

    let mediaHandled = false;
    let plannedMedia = planMediaAlone(skipped);

    // --- A photo or a reel with no words, for a tenant with its question (D-176). -----------
    // (founder, 2026-10-04; `reception/photoPrice.ts`)
    //
    // The tenant's reviewed `photo_price_question` row (a photo) or `reel_price_question` row (a
    // video or a reel) asks which service and the hair length, SENT here like the notice, and the
    // thread stays the bot's so the answer gets its price from the rows. A second picture inside
    // the burst window is not answered again; one after a question (either) that never got words
    // goes on to the notice below (the hand-off). A thread a person holds is left to them. A kind
    // the tenant has no reviewed row for, and a shared post, go on to the notice as before.
    // Unreadable row: the notice path for that kind, as before D-176. Unreadable last reply: the
    // question (a repeat is better than silence).
    if (plannedMedia.some((p) => p.media !== 'mixed')) {
      const readQuestion = async (kind: string, what: string): Promise<string | null> => {
        const question = await readCannedLine(db, { tenantId, locale: settings.defaultLocale, kind });
        if (!question.ok) {
          fx.log('error', `${what}_unreadable`, { eventId, detail: question.detail });
          return null;
        }
        if (question.line !== null && !question.line.reviewed) {
          fx.log('info', `${what}_unreviewed`, { tenantId });
          return null;
        }
        return question.line !== null && question.line.body.trim() !== '' ? question.line.body : null;
      };
      // Both rows, whatever was sent: either, as the last reply, is the question already asked.
      const [photoRow, reelRow] = await Promise.all([
        readQuestion(PHOTO_PRICE_QUESTION_KIND, 'photo_question'), readQuestion(REEL_PRICE_QUESTION_KIND, 'reel_question'),
      ]);
      const rows = { photo: photoRow, reel: reelRow };
      const questions = [rows.photo, rows.reel].filter((q): q is string => q !== null);
      const toNotice: typeof plannedMedia = [];
      for (const plan of plannedMedia) {
        const body = questionFor(plan.media, rows);
        if (body === null) { toNotice.push(plan); continue; }
        const contact = await ensureContact(db, { tenantId, channelId, externalId: plan.senderId, now });
        if (!contact.ok) return unavailable('worker.photo_contact_failed');
        const conv = await openConversation(db, { tenantId, contactId: contact.value.contactId, channelId, now });
        if (!conv.ok) return unavailable('worker.photo_conversation_failed');
        const conversationId = conv.value.conversationId;

        const state = await readThreadState(db, { tenantId, conversationId });
        if (state !== 'unreadable' && humanHoldsThread(state, cooldownMinutes, now).refuse) {
          fx.log('info', 'photo_alone_person_has_thread', { tenantId, conversationId });
          mediaHandled = true;
          continue;
        }
        const last = await readLastReply(db, tenantId, conversationId);
        if (last === 'unreadable') fx.log('error', 'photo_question_time_unreadable', { tenantId, conversationId });
        // The latest question in the hour, not only the last reply (founder, 2026-10-09).
        // Unreadable: the last reply alone decides, as before.
        const recent = last === 'unreadable' ? 'unreadable'
          : await readRecentMediaQuestion(db, { tenantId, conversationId, questions, now });
        if (recent === 'unreadable' && last !== 'unreadable') fx.log('error', 'photo_question_recent_unreadable', { tenantId, conversationId });
        const step = photoAloneStep({
          questions, lastReply: last === 'unreadable' ? null : last,
          ...(recent === 'unreadable' ? {} : { recent }),
          ownKey: photoQuestionDedupKey(eventId, plan.idx), now, togetherMs: PHOTO_BATCH_MS,
        });
        if (step === 'handoff') { toNotice.push(plan); continue; }
        mediaHandled = true;
        if (step === 'suppress') {
          fx.log('info', 'photo_alone_burst', { tenantId, conversationId });
          continue;
        }
        const video = plan.media === 'video';
        const sent = await sendLineAlone({
          senderId: plan.senderId, conversationId, dedupKey: photoQuestionDedupKey(eventId, plan.idx), body,
          what: video ? 'reel_question' : 'photo_question',
        });
        if (typeof sent !== 'string') return sent;
        if (sent !== 'sent') continue;
        await fx.flagQuality(video
          ? { tenantId, conversationId, code: REEL_PRICE_QUESTION_KIND, detail: 'video or reel with no text: asked which service and the hair length' }
          : { tenantId, conversationId, code: PHOTO_PRICE_QUESTION_KIND, detail: 'photo with no text: asked which service and the hair length' });
      }
      plannedMedia = toNotice;
    }

    if (plannedMedia.length > 0) {
      const notice = await readHandoverNotice(db, { tenantId, locale: settings.defaultLocale });
      if (!notice.ok) {
        fx.log('error', 'handover_notice_unreadable', { eventId, detail: notice.detail });
      } else if (notice.line !== null && !notice.line.reviewed) {
        fx.log('error', 'handover_notice_unreviewed', { tenantId, count: plannedMedia.length });
      } else if (notice.line !== null && notice.line.body.trim() !== '') {
        mediaHandled = true;
        for (const plan of plannedMedia) {
          const contact = await ensureContact(db, { tenantId, channelId, externalId: plan.senderId, now });
          if (!contact.ok) return unavailable('worker.media_contact_failed');
          const conv = await openConversation(db, { tenantId, contactId: contact.value.contactId, channelId, now });
          if (!conv.ok) return unavailable('worker.media_conversation_failed');
          const conversationId = conv.value.conversationId;

          const state = await readThreadState(db, { tenantId, conversationId });
          if (state !== 'unreadable' && humanHoldsThread(state, cooldownMinutes, now).refuse) {
            fx.log('info', 'media_alone_person_has_thread', { tenantId, conversationId });
            continue;
          }
          const sent = await sendLineAlone({
            senderId: plan.senderId, conversationId, dedupKey: mediaAloneDedupKey(eventId, plan.idx), body: notice.line.body, what: 'media_alone',
          });
          if (typeof sent !== 'string') return sent;
          if (sent !== 'sent') continue;
          const handed = await applyThreadControl(db, { tenantId, conversationId, control: 'human', at: now, source: 'handover', refresh: true });
          if (!handed.ok) fx.log('error', 'media_handoff_control_failed', { tenantId, conversationId, detail: handed.detail });
          await fx.flagQuality({ tenantId, conversationId, code: 'media_handoff', detail: 'photo, video or shared reel or post with no text handed to staff' });
          if (fx.alertMediaHandoff !== undefined) {
            await fx.alertMediaHandoff({ tenantId, conversationId, externalId: plan.externalId ?? `${eventId}:${plan.idx}`, text: '' })
              .catch((e: unknown) => fx.log('error', 'media_handoff_alert_failed', { detail: e instanceof Error ? e.message : String(e) }));
          }
        }
      }
    }

    // --- A voice message is a customer waiting, not a sticker (Дали G4). ------------------
    //
    // It has no text, so it never reaches Reception, and until this it was only recorded as
    // dropped (DalaTech: eight by 2026-09-19, none answered, nobody told). Now a person is
    // ALWAYS told (`handover/needsPerson.ts`), and the customer gets the tenant's reviewed
    // `voice_received` line when one exists. No tenant has one yet: the wording waits for the
    // founder (`prompt/drafts/voice_received.mn.txt`), and until then the alert says the bot
    // sent nothing. The thread is not handed over: the line asks the customer to type, and
    // the bot must be free to answer what they type. Only on a delivering channel: in
    // `shadow` the bot speaks to nobody and the Page is answered as it was before.
    const plannedVoice = planVoiceAlone(skipped);
    if (plannedVoice.length > 0) {
      const read = await readCannedLine(db, { tenantId, locale: settings.defaultLocale, kind: VOICE_REPLY_KIND });
      if (!read.ok) fx.log('error', 'voice_line_unreadable', { eventId, detail: read.detail });
      else if (read.line !== null && !read.line.reviewed) fx.log('error', 'voice_line_unreviewed', { tenantId, count: plannedVoice.length });
      // An unreadable, missing or unreviewed line sends nothing, and the alert says so.
      const voiceLine = read.ok && read.line !== null && read.line.reviewed && read.line.body.trim() !== '' ? read.line.body : null;
      for (const plan of plannedVoice) {
        if (!(delivery.deliver || testSenders.has(plan.senderId))) {
          fx.log('info', 'not_delivering', { tenantId, channelId, detail: 'voice alone' });
          continue;
        }
        const contact = await ensureContact(db, { tenantId, channelId, externalId: plan.senderId, now });
        if (!contact.ok) return unavailable('worker.voice_contact_failed');
        const conv = await openConversation(db, { tenantId, contactId: contact.value.contactId, channelId, now });
        if (!conv.ok) return unavailable('worker.voice_conversation_failed');
        const conversationId = conv.value.conversationId;

        const state = await readThreadState(db, { tenantId, conversationId });
        if (state !== 'unreadable' && humanHoldsThread(state, cooldownMinutes, now).refuse) {
          // A person is already in this chat and will hear the voice message themselves.
          fx.log('info', 'voice_alone_person_has_thread', { tenantId, conversationId });
          continue;
        }

        let sentLine: ReplySent = 'no';
        if (voiceLine !== null) {
          const drafted = await draftOnce(db, {
            tenantId, kind: 'reply', dedupKey: voiceDedupKey(eventId, plan.idx),
            body: voiceLine, channelId, conversationId,
          });
          if (!drafted.ok) {
            fx.log('error', 'voice_alone_draft_failed', { tenantId, detail: drafted.detail });
            return unavailable('worker.voice_draft_failed');
          }
          const held = await claim(db, { id: drafted.row.id, tenantId, now });
          if (held.outcome === 'unavailable') return unavailable('worker.claim_unavailable');
          if (held.outcome !== 'claimed') {
            // Sent by an earlier attempt; or another worker holds it, or it was refused or is
            // indeterminate, which this attempt cannot tell apart.
            sentLine = held.outcome === 'already_sent' ? 'yes' : 'unknown';
          } else {
            const delivered = await fx.deliver({
              tenantId, channelId, pageId, recipientId: plan.senderId, outboundId: held.id,
              body: held.body, attempts: held.attempts, graphVersion,
              ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
              ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
            });
            if (delivered.outcome === 'failed' && delivered.retryable) {
              // The redelivery re-sends the stored row, and tells a person then.
              fx.log('warn', 'voice_alone_send_retryable', { tenantId, failure: delivered.failure });
              return unavailable(`worker.send_${delivered.failure}`);
            }
            sentLine = delivered.outcome === 'sent' ? 'yes' : delivered.outcome === 'indeterminate' ? 'unknown' : 'no';
            if (sentLine !== 'yes') fx.log('error', 'voice_alone_not_sent', { tenantId, conversationId, outcome: delivered.outcome });
          }
        }
        // Flagged once, by the attempt that raised the alert: a redelivery of the same entry
        // re-runs this block and must not count the same voice message twice.
        const told = await fx.alertNeedsPerson({
          tenantId, conversationId, reason: 'voice', provider, sent: sentLine,
          thread: { channelId, pageId, psid: plan.senderId, ...viaToken },
        });
        if (told) {
          await fx.flagQuality({
            tenantId, conversationId, code: 'voice_received',
            detail: sentLine === 'yes' ? 'voice message: reviewed line sent, a person told' : 'voice message: no line sent, a person told',
          });
        }
      }
    }

    const plannedImages = mediaHandled ? [] : planImageReplies(skipped);
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
  //
  // Gated on the COMMENT switch (D-122), which is independent of the DM `delivery_mode`: a
  // channel can be live for DMs and shadow for comments. `off` (the default for every
  // channel) and `comment_policy = 'none'` both skip the job entirely, so a DM-only channel
  // pays nothing for the `feed` firehose.
  let commentResult: CommentJobResult | null = null;
  const commentMode = String(c['comment_delivery_mode'] ?? 'off');
  if (catchUpMid === null && String(c['comment_policy'] ?? 'none') !== 'none' && commentMode !== 'off') {
    commentResult = await runCommentJob(
      {
        db, now, log: fx.log,
        replyToComment: fx.replyToComment,
        sendPrivateReply: fx.sendPrivateReply,
        lookupComment: fx.lookupComment,
        alertComplaint: fx.alertComplaint,
        msLeft: () => COMMENT_JOB_BUDGET_MS - (Date.now() - startedMs),
      },
      {
        tenantId,
        channelId,
        pageExternalId: pageId,
        // Instagram (D-145): the account the posts belong to, and the Page's token.
        ...(provider === 'instagram' ? {
          provider: 'instagram' as const,
          selfId: String(c['external_id'] ?? ''),
          ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
        } : {}),
        ruleKeys: Array.isArray(c['comment_rule_keys'])
          ? (c['comment_rule_keys'] as unknown[]).filter((k): k is string => typeof k === 'string') : null,
        testSenderIds: Array.isArray(c['test_sender_ids'])
          ? (c['test_sender_ids'] as unknown[]).filter((k): k is string => typeof k === 'string') : [],
        automationTexts,
        commentMode,
        tokenStatus: String(c['token_status'] ?? ''),
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
    // A deferral (D-166) is its own code, so the QStash log tells "ran out of time, resumed on
    // the redelivery" apart from a failure.
    if (commentResult.retry) return unavailable(commentResult.deferred > 0 ? 'worker.comment_deferred' : 'worker.comment_retry');
  }

  if (messages.length === 0) {
    // Nothing answerable in the DM sense — an echo, a receipt, a sticker, or a `feed`
    // entry that carried only comments. Seen and declined is a different fact from
    // vanished, so the reason is recorded and the event is processed.
    fx.log('info', 'nothing_to_answer', { eventId, ...skipSummary(skipped) });
    await markEventState(db, eventId, 'processed');
    return ok({ eventId, skipped: skipSummary(skipped), ...(commentResult === null ? {} : { comments: commentResult }) });
  }

  // The reply's context was started before the comment surface ran (D-124) and is awaited
  // inside the loop, just before the first thing that needs it, so its ~450ms overlaps the
  // inbound persistence instead of preceding it. Every failure below is handled exactly as
  // before; the one difference is that the customer's message is now STORED before a
  // context failure refuses the job, which is §3.4.5's "persist everything" and is safe on
  // the retry, because persistence is idempotent and `findReplyFor` still decides.
  let ready: { ctx: ReceptionContext; promptVolatile: ReturnType<typeof renderVolatile> } | null = null;
  let contextTimings: LoadTimings | null = null;

  // --- One message, one reservation, one reply. -----------------------------
  const drafted: string[] = [];
  const sent: string[] = [];

  /**
   * The media hand-off that follows a SENT handover notice: the thread becomes the staff's
   * for the takeover cooldown, the flag is written and the founder is alerted. After the
   * send and not before: the pre-send check reads a `human` thread set after the customer's
   * message as "a person replied" and would have dropped the notice itself. One helper, so
   * the ordinary send and a resumed send cannot drift apart.
   */
  // The notice, read at most once per job: every resumed send compares its bytes (D-176).
  let noticeRead: ReturnType<typeof readHandoverNotice> | null = null;
  const noticeOnce = (): ReturnType<typeof readHandoverNotice> =>
    (noticeRead ??= readHandoverNotice(db, { tenantId, locale: settings.defaultLocale }));

  const handOffAfterNotice = async (a: { conversationId: string; externalId: string; text: string }): Promise<void> => {
    const handed = await applyThreadControl(db, { tenantId, conversationId: a.conversationId, control: 'human', at: now, source: 'handover', refresh: true });
    if (!handed.ok) fx.log('error', 'media_handoff_control_failed', { tenantId, conversationId: a.conversationId, detail: handed.detail });
    await fx.flagQuality({ tenantId, conversationId: a.conversationId, code: 'media_handoff', detail: 'photo, video or media link handed to staff' });
    if (fx.alertMediaHandoff !== undefined) {
      await fx.alertMediaHandoff({ tenantId, conversationId: a.conversationId, externalId: a.externalId, text: a.text })
        .catch((e: unknown) => fx.log('error', 'media_handoff_alert_failed', { detail: e instanceof Error ? e.message : String(e) }));
    }
  };

  /**
   * Re-send a reply an earlier attempt stored but did not deliver (founder, 2026-09-30).
   *
   * Only on a delivering channel, only while the message is still fresh, and only through
   * `claim`, whose CAS admits `draft` and `failed` rows alone, so a second copy cannot go
   * out. The STORED body is sent: nothing is generated and nothing is spent.
   *
   * Never out of order and never over a person, the catch-up sweep's rules
   * (`channel/catchup.ts`): a newer customer message in the conversation, or one of our
   * replies sent after this message, or a person who replied since, SUPERSEDES the stored
   * reply. It is then claimed and marked `refused` (terminal, so no later redelivery tries
   * again) and flagged. Every read happens BEFORE the claim, so an unreadable one asks for a
   * retry without leaving a row in `sending`, which nothing re-claims.
   */
  const resumeStoredReply = async (r: {
    outboundId: string; conversationId: string; messageId: string; eventAt: Date; deliverThis: boolean;
    message: { senderId: string; externalId: string; text: string; attachments: readonly string[]; stickerIds: readonly string[] };
    /** A too-late hand-off line (D-175): it is owed however late, inside Meta's 24 hours. */
    allowStale?: boolean;
  }): Promise<'sent' | 'skipped' | 'superseded' | 'failed' | 'retry' | 'unavailable' | 'stale'> => {
    if (!r.deliverThis) return 'skipped';
    if (r.allowStale !== true && !isFresh(r.eventAt, now, replyAgeLimit)) {
      // Too late for the stored reply: it is refused for good (terminal, so no later
      // redelivery tries it), and the caller serves the hand-off line instead, so the
      // customer is not left with silence (founder, 2026-10-03).
      const stale = await claim(db, { id: r.outboundId, tenantId, now });
      if (stale.outcome === 'unavailable') return 'unavailable';
      if (stale.outcome !== 'claimed') return 'skipped';
      const refused = await markRefused(db, { id: stale.id, tenantId, reason: 'reply_too_late' });
      if (!refused.ok) fx.log('error', 'resume_refuse_failed', { outboundId: stale.id, detail: refused.detail });
      return 'stale';
    }

    // Times from OUR rows, never Meta's timestamp: this reply row's `created_at` and this
    // message's stored `at`. Messages in one entry share one stored `at`, so only a strictly
    // later one is newer; and a sent reply drafted after THIS row can only answer a newer
    // message, because a retryable failure returns before the loop drafts a sibling.
    const [ownRow, ownMsg] = await Promise.all([
      db.from('outbound_messages').select('created_at').eq('tenant_id', tenantId).eq('id', r.outboundId).maybeSingle(),
      db.from('messages').select('at').eq('tenant_id', tenantId).eq('id', r.messageId).maybeSingle(),
    ]);
    const rowAt = typeof (ownRow.data as Record<string, unknown> | null)?.['created_at'] === 'string'
      ? String((ownRow.data as Record<string, unknown>)['created_at']) : null;
    const msgAt = typeof (ownMsg.data as Record<string, unknown> | null)?.['at'] === 'string'
      ? String((ownMsg.data as Record<string, unknown>)['at']) : null;
    if (ownRow.error || ownMsg.error || rowAt === null || msgAt === null) {
      fx.log('error', 'resume_check_unreadable', { tenantId, detail: (ownRow.error ?? ownMsg.error)?.message ?? 'own row or message time missing' });
      return 'unavailable';
    }

    const [newerRes, laterSent, spoke] = await Promise.all([
      db.from('messages').select('id').eq('tenant_id', tenantId).eq('conversation_id', r.conversationId)
        .eq('direction', 'inbound').gt('at', msgAt).limit(1),
      db.from('outbound_messages').select('id').eq('tenant_id', tenantId).eq('conversation_id', r.conversationId)
        .eq('kind', 'reply').eq('state', 'sent').neq('id', r.outboundId).gt('created_at', rowAt).limit(1),
      personRepliedSince(db, {
        tenantId, channelId, conversationId: r.conversationId, psid: r.message.senderId, eventId, since: r.eventAt,
        ourAppId: metaAppId, automationTexts,
      }).catch((e: unknown) => ({ replied: 'unreadable' as const, detail: e instanceof Error ? e.message : String(e) })),
    ]);
    if (newerRes.error || laterSent.error) {
      fx.log('error', 'resume_check_unreadable', { tenantId, detail: (newerRes.error ?? laterSent.error)?.message ?? '' });
      return 'unavailable';
    }
    const reason = Array.isArray(newerRes.data) && newerRes.data.length > 0 ? 'superseded_newer_message'
      : Array.isArray(laterSent.data) && laterSent.data.length > 0 ? 'superseded_later_reply'
      : spoke.replied === true ? 'human_replied_before_send'
      : null;
    // As the ordinary send path: an unreadable person check sends rather than mute a tenant.
    if (spoke.replied === 'unreadable') fx.log('error', 'human_reply_check_unreadable', { tenantId, conversationId: r.conversationId, detail: spoke.detail });

    const held = await claim(db, { id: r.outboundId, tenantId, now });
    if (held.outcome === 'unavailable') {
      fx.log('error', 'claim_unavailable', { detail: held.detail });
      return 'unavailable';
    }
    if (held.outcome !== 'claimed') return 'skipped';

    if (reason !== null) {
      const refused = await markRefused(db, { id: held.id, tenantId, reason });
      if (!refused.ok) fx.log('error', 'resume_refuse_failed', { outboundId: held.id, detail: refused.detail });
      await fx.flagQuality({
        tenantId, conversationId: r.conversationId, code: reason === 'human_replied_before_send' ? reason : 'resume_superseded',
        detail: `a stored reply was not re-sent: ${reason}`,
      });
      return 'superseded';
    }

    const delivered = await fx.deliver({
      tenantId, channelId, pageId, recipientId: r.message.senderId, outboundId: held.id,
      body: held.body, attempts: held.attempts, graphVersion,
      ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
      ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
    });
    if (delivered.outcome === 'sent') {
      // A resumed media notice still hands the thread over: the first attempt returned
      // before its hand-off, so this is the only place it can happen. Recognised by its bytes:
      // the reply path serves the tenant's reviewed notice only as a hand-off, to a media
      // message or, since D-176, to a text after the photo question that named nothing the
      // rows know (`reception/photoPrice.ts`).
      const notice = await noticeOnce();
      if (!notice.ok) fx.log('error', 'handover_notice_unreadable', { eventId, detail: notice.detail });
      else if (notice.line !== null && notice.line.body.trim() !== '' && notice.line.body.trim() === held.body.trim()) {
        await handOffAfterNotice({ conversationId: r.conversationId, externalId: r.message.externalId, text: r.message.text });
      }
      return 'sent';
    }
    if (delivered.outcome === 'failed' && delivered.retryable) {
      fx.log('warn', 'send_retryable', { outboundId: held.id, failure: delivered.failure, resumed: true });
      return 'retry';
    }
    fx.log('error', 'resend_not_sent', { outboundId: held.id, outcome: delivered.outcome });
    return 'failed';
  };
  /**
   * Is the customer still waiting on this message? Not when a newer message of theirs is in
   * the conversation (that one is answered, or gets the line itself), nor when one of our
   * replies was sent after it, nor when a person replied since. Unreadable reads `true`.
   */
  const stillWaiting = async (messageId: string, conversationId: string, eventAt: Date, psid: string, entryMids: readonly string[]):
    Promise<true | 'newer_message' | 'answered' | 'person_replied'> => {
    const own = await db.from('messages').select('at').eq('tenant_id', tenantId).eq('id', messageId).maybeSingle();
    const storedAt = typeof (own.data as Record<string, unknown> | null)?.['at'] === 'string' ? new Date(String((own.data as Record<string, unknown>)['at'])) : null;
    // Without the message's own time the two «since» reads cannot be asked; the person check can.
    if (own.error || storedAt === null || Number.isNaN(storedAt.getTime())) {
      fx.log('error', 'too_late_check_unreadable', { tenantId, detail: own.error?.message ?? 'message time missing' });
    }
    // `messages.at` is when WE stored it, which for a late message (a backlog, a stranded event
    // re-published by the sweep) is after everything that followed it. «Since» is therefore the
    // earlier of that and Meta's own time for the message, and this entry's messages are left
    // out of «newer» (the loop resolves those: only the latest of them is served).
    const since = storedAt === null || Number.isNaN(storedAt.getTime()) ? null
      : new Date(Math.min(storedAt.getTime(), eventAt.getTime())).toISOString();
    const none = Promise.resolve({ data: [] as unknown[], error: null });
    const [newer, laterSent, spoke] = await Promise.all([
      since === null ? none : db.from('messages').select('id').eq('tenant_id', tenantId).eq('conversation_id', conversationId)
        .eq('direction', 'inbound').neq('id', messageId).not('external_id', 'in', `(${entryMids.map((m) => JSON.stringify(m)).join(',')})`)
        .gt('at', since).limit(1),
      // A reply that may have reached the customer: sent, being sent, or parked as indeterminate.
      since === null ? none : db.from('outbound_messages').select('id').eq('tenant_id', tenantId).eq('conversation_id', conversationId)
        .eq('kind', 'reply').in('state', ['sending', 'sent', 'indeterminate']).gt('created_at', since).limit(1),
      personRepliedSince(db, {
        tenantId, channelId, conversationId, psid, eventId, since: eventAt, ourAppId: metaAppId, automationTexts,
      }).catch((e: unknown) => ({ replied: 'unreadable' as const, detail: e instanceof Error ? e.message : String(e) })),
    ]);
    if (newer.error || laterSent.error || spoke.replied === 'unreadable') {
      fx.log('error', 'too_late_check_unreadable', { tenantId, detail: (newer.error ?? laterSent.error)?.message ?? ('detail' in spoke ? spoke.detail : '') });
    }
    if (!newer.error && Array.isArray(newer.data) && newer.data.length > 0) return 'newer_message';
    if (!laterSent.error && Array.isArray(laterSent.data) && laterSent.data.length > 0) return 'answered';
    if (spoke.replied === true) return 'person_replied';
    return true;
  };

  const stale: string[] = [];
  /** Stored and deliberately not answered: the channel cannot send and is not mirroring. */
  const notGenerated: string[] = [];

  for (const message of messages) {
    // Delivered for real: a `live` channel, or a listed tester on a `shadow` one (D-141).
    const deliverThis = delivery.deliver || testSenders.has(message.senderId);
    // Too late to answer, but owed the hand-off line (founder, 2026-10-03): set below, served
    // once the context is loaded. `afterStaleResume`: an earlier attempt's stored reply was
    // refused as too late, so the line goes under its own key (the reply's key is that row).
    let tooLate = false;
    let afterStaleResume = false;
    // A missing Meta timestamp arrives as an invalid date; treating it as `now` stops it
    // reading as 1970 and being dropped as stale for the wrong reason.
    const eventAt = Number.isNaN(message.sentAt.getTime()) ? now : message.sentAt;

    // D-168: a like at a tenant with no fixed reply for it is what every other sticker is
    // (D-070): no contact, no conversation, no reservation, nothing sent.
    if (isLike(message.text)) {
      const early = await loadContext();
      if (early.ok && !likeRowFor(early.context.deterministic, null)) {
        fx.log('info', 'like_not_answered', { tenantId, externalId: message.externalId, reason: 'no_fixed_reply' });
        continue;
      }
    }

    const contact = await ensureContact(db, { tenantId, channelId, externalId: message.senderId, now });
    if (!contact.ok) {
      fx.log('error', 'contact_failed', { detail: contact.detail });
      return unavailable('worker.contact_failed');
    }
    if (contact.value.personId === null) {
      // Best-effort: the person layer exists for consent, and a first message should not
      // fail because it had a bad day. A missing person is visible in the row.
      const person = await ensurePerson(db, {
        tenantId, contactId: contact.value.contactId,
        kind: provider === 'instagram' ? 'igsid' : 'psid', externalId: message.senderId,
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
      // A reply drafted or failed by an earlier attempt of THIS delivery is re-sent, never
      // re-generated and never skipped (founder, 2026-09-30). Before this, a 613 or a 5xx on
      // the send 503'd, QStash redelivered, `findReplyFor` read the unsent row as
      // "answered", and the customer waited in silence for ever. The STORED body is sent,
      // under the claim's CAS, so a second copy cannot go out: `sent`, `sending`,
      // `refused` and a parked `indeterminate` are never claimable.
      if (answered.outcome === 'answered' && catchUpMid === null
          && (answered.state === 'draft' || answered.state === 'failed')) {
        const resumed = await resumeStoredReply({
          outboundId: answered.outboundId, conversationId, messageId: stored.value.messageId, eventAt, message,
          deliverThis: delivery.generate && deliverThis,
        });
        if (resumed === 'retry') return unavailable('worker.resume_send_retryable');
        if (resumed === 'unavailable') return unavailable('worker.resume_unavailable');
        if (resumed === 'sent') sent.push(answered.outboundId);
        fx.log('info', 'redelivery_resumed', { eventId, outboundId: answered.outboundId, from: answered.state, outcome: resumed });
        // Refused as too late: on to the freshness check below, which serves the hand-off.
        if (resumed !== 'stale') continue;
        afterStaleResume = true;
      }
      // The reply was refused as too late and its hand-off line (own key, D-175) was stored but
      // not delivered: re-send the line's stored bytes, however late, inside Meta's 24 hours.
      if (answered.outcome === 'answered' && answered.state === 'refused' && catchUpMid === null
          && isFresh(eventAt, now, CATCH_UP_WINDOW_MINUTES)) {
        const line = await findReplyFor(db, { tenantId, kind: 'reply', dedupKey: `${replyDedupKey(message.externalId)}:handoff` });
        if (line.outcome === 'unavailable') {
          fx.log('error', 'reply_lookup_failed', { eventId, detail: line.detail });
          return unavailable('worker.reply_lookup_failed');
        }
        if (line.outcome === 'answered' && (line.state === 'draft' || line.state === 'failed')) {
          const resumed = await resumeStoredReply({
            outboundId: line.outboundId, conversationId, messageId: stored.value.messageId, eventAt, message,
            deliverThis: delivery.generate && deliverThis, allowStale: true,
          });
          if (resumed === 'retry') return unavailable('worker.resume_send_retryable');
          if (resumed === 'unavailable') return unavailable('worker.resume_unavailable');
          if (resumed === 'sent') sent.push(line.outboundId);
          fx.log('info', 'redelivery_resumed', { eventId, outboundId: line.outboundId, from: line.state, outcome: resumed, handoff: true });
          continue;
        }
      }
      // A catch-up may claim a reply that FAILED on the credential: it is the latest message
      // in its conversation (the sweep checked), so its stored body answers exactly it.
      if (answered.outcome === 'answered' && !afterStaleResume && !(catchUpMid !== null && answered.state === 'failed')) {
        fx.log('info', 'already_answered', { eventId, outboundId: answered.outboundId, state: answered.state });
        continue;
      }
      // absent: whatever ran before never got as far as drafting. Answer it.
      if (!afterStaleResume) fx.log('info', 'redelivery_unanswered', { eventId, externalId: message.externalId });
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
    if (message.attachments.length > 0 && message.stickerIds.length === 0 && !afterStaleResume) {
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
      // Held because the channel is HALTED (a credential failure), not because somebody
      // switched it off: the evidence the catch-up sweep answers from when it comes back.
      if (channelStatus === CREDENTIAL_FAILURE_STATUS) {
        await fx.flagQuality({
          tenantId, conversationId, messageId: stored.value.messageId, code: HELD_FLAG,
          detail: 'stored while the channel was halted; answered when it returns if under 24h and nobody has',
        });
      }
      fx.log('info', 'not_generating', {
        tenantId, channelId, externalId: message.externalId, detail: delivery.detail,
      });
      notGenerated.push(message.externalId);
      continue;
    }

    // §3.9's check 7. AFTER the message is persisted — §3.4.5's "persist everything,
    // generate nothing" — and before the reservation, so a message nobody wants answered
    // costs three rows and not a reservation, a model call or a send.
    // A catch-up message waited out a halt, so it is measured against Meta's 24-hour window,
    // not the tenant's ordinary limit — the whole point is that it is late.
    const ageLimit = catchUpMid === null ? replyAgeLimit : CATCH_UP_WINDOW_MINUTES;
    if (!isFresh(eventAt, now, ageLimit)) {
      const ageMinutes = Math.round((now.getTime() - eventAt.getTime()) / 60_000);
      fx.log('warn', 'reply_too_late', { tenantId, externalId: message.externalId, ageMinutes, limitMinutes: ageLimit });
      // The customer's question is stored and now visible to the Quality layer as one
      // nobody answered, which is exactly what it is.
      await fx.flagQuality({
        tenantId,
        conversationId,
        code: 'reply_too_late',
        detail: `${ageMinutes} minutes old; the limit is ${ageLimit}`,
      });
      // Too late for an answer is never a reason for silence (founder, 2026-10-03): the
      // tenant's reviewed hand-off line goes instead, below, with no model and no spend. Only
      // on a delivering channel, never to a like, and only inside Meta's 24-hour window, past
      // which a reply cannot be sent at all. A catch-up message is past that window already.
      const mayHandOff = catchUpMid === null && deliverThis && !isLike(message.text)
        && isFresh(eventAt, now, CATCH_UP_WINDOW_MINUTES);
      if (!mayHandOff) {
        stale.push(message.externalId);
        continue;
      }
      // The line needs the published rows. Unloadable: logged, and the message stays the
      // stale one it was; a 503 here would only redeliver a message that is staler still.
      const probe = await loadContext();
      if (!probe.ok) {
        fx.log('error', 'too_late_handoff_skipped', { tenantId, conversationId, detail: `context: ${probe.code}` });
        // Nothing went to the customer: a person is told, so silence is never the only signal.
        await fx.alertNeedsPerson({
          tenantId, conversationId, reason: 'handoff', provider, sent: 'no',
          thread: { channelId, pageId, psid: message.senderId, ...viaToken },
        });
        stale.push(message.externalId);
        continue;
      }
      tooLate = true;
    }

    if (ready === null) {
      const loaded = await loadContext();
      clock.lap('context_load');
      // Null until the context loads, and it stays null on every refusal path — see the note
      // at the log site. `loaded.timings` only exists on the ok branch because the failure
      // branches return before the batch is issued, so there is no split to report.
      contextTimings = loaded.ok ? loaded.timings : null;
      if (!loaded.ok) {
        fx.log('error', 'context_unavailable', { tenantId, code: loaded.code, detail: loaded.detail });
        trace.detail = loaded.detail;
        if (loaded.code === 'not_provisioned') {
          // Determinate: retrying cannot provision a tenant. ACK and let the operator alert
          // carry it, rather than looping QStash against a state only a human can change.
          await markEventState(db, eventId, 'blocked_no_token');
          return ok({ refused: loaded.code });
        }
        return unavailable(loaded.code);
      }
      /**
       * L4, the volatile tail. Its own `system` block with no `cache_control`, which is what
       * makes the ancestor's trap structurally unavailable: it concatenates its closure
       * section onto the cached base prompt, so anything date-shaped added there invalidates
       * every entry, silently, and the bill roughly triples.
       */
      ready = {
        ctx: loaded.context,
        promptVolatile: renderVolatile({
          now, timezone, surface: RECEPTION_SURFACE, hours: loaded.context.hours, closures: loaded.context.closures,
          branches: loaded.context.branches,
        }),
      };
    }
    const { ctx, promptVolatile } = ready;

    // In-chat booking: before the spend guard and the model, so a booking step costs no
    // reservation and no model call. Messenger only, and only where this message is delivered.
    if (fx.bookingTurn !== undefined && provider === 'facebook_page' && deliverThis && catchUpMid === null) {
      const booking = await fx.bookingTurn({
        tenantId, channelId, conversationId, psid: message.senderId, mid: message.externalId, text: message.text,
        ...(message.quickReplyPayload === undefined ? {} : { quickReplyPayload: message.quickReplyPayload }),
        respelled: matchingText(message.text, ctx.spellings), hours: ctx.hours, closures: ctx.closures,
      });
      if (booking.handled) {
        fx.log('info', 'booking_turn', { tenantId, conversationId, detail: booking.detail });
        if (booking.outboundId !== null) {
          drafted.push(booking.outboundId);
          const traced = await traceAnswer(db, {
            tenantId, messageId: stored.value.messageId, answeredBy: 'deterministic',
            revisionId: ctx.revisionId, promptHash: ctx.contentHash,
          });
          if (!traced.ok) fx.log('error', 'trace_failed', { tenantId, conversationId, detail: traced.detail ?? '' });
          const held = await claim(db, { id: booking.outboundId, tenantId, now });
          if (held.outcome === 'unavailable') return unavailable('worker.claim_unavailable');
          if (held.outcome === 'claimed') {
            const delivered = await fx.deliver({
              tenantId, channelId, pageId, recipientId: message.senderId, outboundId: held.id,
              body: held.body, attempts: held.attempts, graphVersion,
              ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
              ...(booking.quickReplies.length === 0 ? {} : { quickReplies: booking.quickReplies }), // ascii-safe: element count
              ...(booking.linkButtonTitle === undefined ? {} : { linkButtonTitle: booking.linkButtonTitle }),
            });
            if (delivered.outcome === 'sent') sent.push(held.id);
            else if (delivered.outcome === 'failed' && delivered.retryable) {
              // The redelivery re-sends the stored body (without its buttons; it reads alone).
              fx.log('warn', 'send_retryable', { outboundId: held.id, failure: delivered.failure, booking: true });
              return unavailable(`worker.send_${delivered.failure}`);
            } else fx.log('error', 'booking_reply_not_sent', { outboundId: held.id, outcome: delivered.outcome });
          }
        }
        continue;
      }
      fx.log('info', 'booking_not_handled', { tenantId, reason: booking.reason });
    }

    /**
     * Serve the tenant's own reviewed hand-off line when the reply path cannot answer: a daily
     * cap refusal (D-160) or approved lines changed without a republish (`canned_stale`, D-163).
     * No model, nothing spent. Once per conversation per day. Under the reply's own key, so a
     * redelivery finds this message answered and never sends the line twice. For `canned_stale`
     * the row must also be the exact line the published prefix carries: an edited, unpublished
     * hand-off sentence is never sent.
     *
     * Returns `sent` (drafted and handed to Meta: the message is answered), `skipped` (nothing
     * sent, for the reason logged), or a job result to return (a 503 that QStash retries).
     */
    const serveHandoff = async (reason: 'ceiling' | 'canned_stale' | 'too_late', dedupKey = replyDedupKey(message.externalId)): Promise<'sent' | 'skipped' | JobResult> => {
      // The published bytes whenever the snapshot carries the canned section: a row edited
      // since the last publish keeps its old `reviewed_at`, so the stamp alone would send
      // unpublished words (D-163 review). A snapshot older than D-058 has no section to check,
      // except on `canned_stale`, which is only ever raised against a section.
      const handoff = ctx.canned.find((c) => c.kind === 'handoff' && c.reviewedAt !== null && c.body.trim() !== ''
        && ((reason !== 'canned_stale' && ctx.cannedHash === null) || publishedLine(ctx.promptStable, 'handoff', c.body)));
      const said = !deliverThis || handoff === undefined ? 'no'
        : await handoffSaidToday(db, { tenantId, conversationId, body: handoff.body, since: localDayStart(localDate, timezone) });
      // Unreadable sends the line: a repeat is better than a customer left with nothing.
      if (said === 'unreadable') fx.log('error', `${reason}_handoff_said_unreadable`, { tenantId, conversationId });
      if (!deliverThis) {
        fx.log('info', 'not_delivering', { tenantId, channelId, detail: `${reason} refusal` });
        return 'skipped';
      }
      if (handoff === undefined) {
        fx.log('warn', `${reason}_no_reply`, { tenantId, eventId, detail: 'no reviewed, published handoff row' });
        // Too late with no line to send (D-175): the customer got nothing, so a person is told.
        if (reason === 'too_late') {
          await fx.alertNeedsPerson({
            tenantId, conversationId, reason: 'handoff', provider, sent: 'no',
            thread: { channelId, pageId, psid: message.senderId, ...viaToken },
          });
        }
        return 'skipped';
      }
      if (said === 'yes') {
        // Once per conversation per day. Every later message until midnight would otherwise
        // get the same «I can't answer» line again; the person told the first time is enough.
        fx.log('info', `${reason}_handoff_already_said`, { tenantId, conversationId });
        return 'skipped';
      }
      const line = await draftOnce(db, {
        tenantId, kind: 'reply', dedupKey, body: handoff.body, channelId, conversationId,
      });
      if (!line.ok) {
        // A 503: the message is stored and unanswered, and the redelivery tries again.
        fx.log('error', `${reason}_handoff_draft_failed`, { tenantId, detail: line.detail });
        return unavailable(`worker.${reason}_handoff_draft_failed`);
      }
      // Counted as the entry's reply, so the event's `replied_at` says one was produced.
      drafted.push(line.row.id);
      // The customer's row says who answered it, as every answer does. Bookkeeping: a
      // failure is logged and never turns the reply into a retry.
      const traced = await traceAnswer(db, {
        tenantId, messageId: stored.value.messageId, answeredBy: 'canned',
        revisionId: ctx.revisionId, promptHash: ctx.contentHash,
      });
      if (!traced.ok) fx.log('error', 'trace_failed', { tenantId, conversationId, detail: traced.detail ?? '' });
      const held = await claim(db, { id: line.row.id, tenantId, now });
      if (held.outcome === 'unavailable') return unavailable('worker.claim_unavailable');
      if (held.outcome !== 'claimed') {
        fx.log('info', `${reason}_handoff_not_ours`, { tenantId, outcome: held.outcome });
        return 'sent';
      }
      const delivered = await fx.deliver({
        tenantId, channelId, pageId, recipientId: message.senderId, outboundId: held.id,
        body: held.body, attempts: held.attempts, graphVersion,
        ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
        ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
      });
      const sentLine: ReplySent = delivered.outcome === 'sent' ? 'yes'
        : delivered.outcome === 'failed' && !delivered.retryable ? 'no' : 'unknown';
      if (sentLine !== 'yes') fx.log('error', `${reason}_handoff_not_sent`, { tenantId, conversationId, outcome: delivered.outcome });
      // The line promises a colleague: a person is told, on every outcome, as the ordinary
      // hand-off path does (D-158); `once` a day, so the retry cannot page twice.
      await fx.alertNeedsPerson({
        tenantId, conversationId, reason: 'handoff', provider, sent: sentLine,
        thread: { channelId, pageId, psid: message.senderId, ...viaToken },
      });
      await fx.flagQuality({
        tenantId, conversationId, code: `${reason}_handoff`,
        detail: `${reason === 'ceiling' ? 'daily cap refused the model' : reason === 'too_late' ? 'the message was past the reply age limit' : 'approved lines changed, unsigned or missing'}; `
          + `hand-off line ${sentLine === 'yes' ? 'sent' : `not confirmed sent (${delivered.outcome})`}`,
      });
      if (delivered.outcome === 'failed' && delivered.retryable) {
        // A 503: the redelivery claims this `failed` row and re-sends its stored bytes
        // before it ever reaches the guard (#250), exactly as for a model reply.
        fx.log('warn', `${reason}_handoff_send_retryable`, { tenantId, failure: delivered.failure });
        return unavailable(`worker.send_${delivered.failure}`);
      }
      if (delivered.outcome === 'sent') sent.push(held.id);
      return 'sent';
    };

    // Too late to answer (above): the hand-off line, unless the customer is no longer
    // waiting on THIS message — a newer one of theirs is the one to answer, or we or a person
    // already replied after it. An unreadable check sends: a repeat is better than silence,
    // and `serveHandoff` says the line at most once per conversation per day.
    if (tooLate) {
      // A later message of this same entry is the one to serve (it is answered, or gets the line).
      const laterInEntry = messages.some((m) => m !== message && !isLike(m.text)
        && !Number.isNaN(m.sentAt.getTime()) && m.sentAt.getTime() > eventAt.getTime());
      const waiting = laterInEntry ? 'newer_message' as const
        : await stillWaiting(stored.value.messageId, conversationId, eventAt, message.senderId, messages.map((m) => m.externalId));
      if (waiting === true) {
        const served = await serveHandoff('too_late', afterStaleResume ? `${replyDedupKey(message.externalId)}:handoff` : replyDedupKey(message.externalId));
        if (typeof served !== 'string') return served;
      } else {
        fx.log('info', 'too_late_no_handoff', { tenantId, conversationId, reason: waiting });
      }
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

    // D-168: a like is answered by a fixed reply or not at all, and only when it is owed one
    // (`likeIsOwedReply`). Decided HERE, before the spend guard and the bubble, so a like left
    // unanswered costs no reservation, shows no «typing…» and never draws the cap's hand-off.
    if (isLike(message.text)
      && !(likeIsOwedReply(priorTurns) && likeRowFor(ctx.deterministic, priorTurns.length === 0))) {
      fx.log('info', 'like_not_answered', { tenantId, conversationId, externalId: message.externalId, reason: 'not_owed_reply' });
      continue;
    }

    // The chokepoint. Nothing downstream may re-implement any part of this.
    const guard = await withTenantRole(db, {
      tenantId, role: 'reception', surface: 'reception', channel: provider,
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
      // 403/429 are determinate. Retrying cannot change them, so ACK.
      await markEventState(db, eventId, refusal.status === 429 ? 'shed' : 'blocked_no_token');
      if (refusal.status === 429) {
        // The founder is paged once per brake episode. After the event is marked, so the
        // record is written first; the result is logged and never changes the ACK — a 503
        // here would make QStash deliver a message the brake will refuse again.
        const alerted = await fx.alertCeilingReached({ tenantId, timezone, channel: provider })
          .catch((e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`);
        fx.log(alerted.startsWith('failed') || alerted.startsWith('timed_out') || alerted.startsWith('recorded_undelivered')
          ? 'error' : 'info', 'ceiling_alert', { tenantId, eventId, outcome: alerted });

        // The customer gets the tenant's own reviewed hand-off line, the sentence the website
        // already serves here (founder, 2026-09-30, D-160). `serveHandoff` below. Never in
        // answer to a like (D-168): it would spend the day's one hand-off on a thumbs-up.
        if (!isLike(message.text)) {
          const served = await serveHandoff('ceiling');
          if (typeof served !== 'string') return served;
        }
      }
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
    //
    // THE REPLY NEVER WAITS FOR IT, AND A LATE BUBBLE IS CLEARED (D-124). A reply that
    // needs no model is ready ~150ms after this line and the bubble's own request takes
    // longer (measured live: 1.2s cold), so it can reach Meta AFTER the reply and hang
    // «typing…» under an answer already given, for up to twenty seconds. Waiting for it
    // before sending fixed that and cost every no-model reply the bubble's round trip — the
    // speed this same change bought. So the reply goes first; if its bubble had not landed
    // by then, `typing_off` follows once it does. A model reply takes seconds, so its bubble
    // has always landed and nothing extra is sent.
    // D-176: where this conversation stands with the bot's photo question
    // (`inbound/photoQuestion.ts`). Read only when the history ends on the question, so every
    // other message costs nothing here. Measured before the bubble: a price ask that crossed the
    // question gets no reply (`photo_question_pending`), so it must not be shown «typing…».
    // Unreadable reads as `answering` (the text is then an answer, which at worst hands off).
    const questionRead = await photoQuestionState(db, { tenantId, conversationId, canned: ctx.canned, priorTurns, eventAt, now });
    if (questionRead === 'unreadable') fx.log('error', 'photo_question_time_unreadable', { tenantId, conversationId });
    const photoQuestion: PhotoQuestionState | null = questionRead === 'unreadable' ? 'answering' : questionRead;
    // A picture with words after a question asked earlier in the hour, with something else said
    // since, goes to a person rather than being asked again (`photoPriceStep`, founder 2026-10-09).
    const picture = unseenMediaOf({
      text: message.text, attachments: message.attachments,
      sentPhoto: message.attachments.includes('image') && message.stickerIds.length === 0,
    }) !== null;
    let photoQuestionEarlier = false;
    if (picture && photoQuestion === null) {
      const questions = ctx.canned
        .filter((c) => (c.kind === PHOTO_PRICE_QUESTION_KIND || c.kind === REEL_PRICE_QUESTION_KIND) && c.reviewedAt !== null)
        .map((c) => c.body);
      const recent = await readRecentMediaQuestion(db, { tenantId, conversationId, questions, now });
      if (recent === 'unreadable') fx.log('error', 'photo_question_recent_unreadable', { tenantId, conversationId });
      // Unreadable: asked again, as before (a repeat is better than silence).
      photoQuestionEarlier = recent !== null && recent !== 'unreadable';
    }

    let typingSettled = false;
    const typing: Promise<void> | null = deliverThis && photoQuestion !== 'crossed'
      ? fx.showTyping({ tenantId, channelId, recipientId: message.senderId, pageId, ...viaToken })
        .catch((e: unknown) => {
          fx.log('info', 'typing_indicator_failed', {
            externalId: message.externalId, detail: e instanceof Error ? e.message : String(e),
          });
        })
        .finally(() => { typingSettled = true; })
      : null;

    const outcome = await fx.generateReply({
      tenantId, channelId, conversationId,
      inboundExternalId: message.externalId,
      reservation: guard.reservation,
      customerMessage: message.text,
      customerAttachments: message.attachments,
      // A sticker arrives declaring `image` (D-070), so the kinds cannot answer this; the
      // payload's sticker ids can. The kinds still go to the gate unchanged.
      customerSentPhoto: message.attachments.includes('image') && message.stickerIds.length === 0,
      history: priorTurns,
      eventAt,
      promptVolatile,
      ctx,
      // The history was read successfully or we would have 503'd above. `empty` is about
      // the turns BEFORE this one — the inbound row was stored a moment ago, so a first
      // message leaves priorTurns empty.
      historyEmpty: priorTurns.length === 0,
      photoQuestionState: photoQuestion,
      photoQuestionEarlier,
    });
    // Lapped the instant the call returns, and deliberately BEFORE the outcome is
    // branched on. Its first form lapped below the `!delivery.deliver` early-continue, so
    // a `shadow` tenant recorded every phase EXCEPT the model call — and shadow is Matrix,
    // the only tenant whose latency anybody is asking about. An instrument that omits the
    // dominant phase for the tenant being measured is worse than no instrument.
    clock.lap('generate');

    if (outcome.kind === 'retry') {
      fx.log('error', 'reception_retry', { detail: outcome.detail });
      // Carried to the exhaustion alert, so it can say `canned_stale` rather than a code
      // that means "something in handleReception" — the founder read that code 29 times
      // and it never once said what to do (republish).
      trace.detail = outcome.detail;
      if (isApprovedLinesRefusal(outcome.detail)) {
        // Approved lines changed without a republish, or a row unsigned or missing (D-163):
        // each refuses every reply the same way. Every reply stops until the
        // tenant is republished, so the founder is paged NOW, once per episode, rather than
        // by the exhausted alert minutes later; and the customer gets the published hand-off
        // line instead of silence. Only when it went out is the message ACKed: otherwise the
        // 503 stands and QStash retries, in case the republish lands meanwhile.
        const paged = await fx.alertCannedStale({ tenantId, channel: provider })
          .catch((e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`);
        fx.log(/^(failed|timed_out|recorded_undelivered)/u.test(paged) ? 'error' : 'info', 'canned_stale_alert', { tenantId, eventId, outcome: paged });
        // Read BEFORE the send, as for any reply: the refusal took milliseconds, so the
        // «typing…» bubble can land after the line and must then be cleared (D-124).
        const typingLate = typing !== null && !typingSettled;
        const served = await serveHandoff('canned_stale');
        if (typeof served !== 'string') return served;
        if (served === 'sent') {
          if (typingLate && typing !== null) {
            await settleWithin(typing, TYPING_WAIT_MS);
            await settleWithin(
              fx.showTyping({ tenantId, channelId, recipientId: message.senderId, pageId, ...viaToken, action: 'typing_off' }).catch(() => {}),
              TYPING_WAIT_MS,
            );
            fx.log('info', 'typing_cleared_after_reply', { externalId: message.externalId });
          }
          continue;
        }
      }
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
    //
    // Issued together with the claim (D-124): the trace is bookkeeping on the customer's
    // row and the claim is the step before the send, and neither reads the other. A shadow
    // channel has no claim, so it awaits the trace alone.
    const tracing = traceAnswer(db, {
      tenantId,
      messageId: stored.value.messageId,
      answeredBy: outcome.answeredBy,
      revisionId: ctx.revisionId,
      promptHash: ctx.contentHash,
    });

    if (outcome.refusal !== undefined) {
      fx.log('warn', 'answered_with_handoff', { code: outcome.refusal, conversationId });
    }

    // THE SALES SHADOW (D-127). After the draft, never before: the reply is decided and
    // stored, and this only reads it. Bounded, and it cannot reject (see the effect).
    let salesSettled = false;
    const selling = settleWithin(
      // `Promise.resolve().then` so even a synchronous throw lands in the `.catch`.
      Promise.resolve().then(() => fx.salesShadow({
        tenantId, conversationId, messageId: stored.value.messageId, outboundId: outcome.outboundId,
        customerMessage: message.text,
        customerSentPhoto: message.attachments.includes('image') && message.stickerIds.length === 0,
        history: priorTurns, refusal: outcome.refusal !== undefined,
        threadControl: threadState === 'unreadable' ? 'unreadable' : threadState.control,
        ctx,
        ...(provider === 'instagram' ? { channelLabel: 'Instagram' } : {}),
      })).catch(() => undefined).finally(() => { salesSettled = true; }),
      SALES_SHADOW_WAIT_MS,
    );

    // --- H14: claim the draft and put it on the wire. ---------------------
    //
    // Beside the claim: has a person replied since this message arrived (founder,
    // 2026-09-25)? Check 4 asked before generating, and the model takes seconds — a
    // receptionist who answers inside them is invisible to it. Read concurrently so it costs
    // the send nothing, and as late as the send path allows.
    const [traced, held, spoke] = await Promise.all([
      tracing,
      deliverThis ? claim(db, { id: outcome.outboundId, tenantId, now }) : Promise.resolve(null),
      deliverThis
        ? personRepliedSince(db, {
          tenantId, channelId, conversationId, psid: message.senderId, eventId, since: eventAt, ourAppId: metaAppId,
          automationTexts,
        }).catch((e: unknown) => ({ replied: 'unreadable' as const, detail: e instanceof Error ? e.message : String(e) }))
        : Promise.resolve(null),
      selling,
    ]);
    if (!salesSettled) fx.log('info', 'sales_shadow_late', { tenantId, conversationId, outboundId: outcome.outboundId });
    if (!traced.ok) {
      fx.log('error', 'trace_failed', {
        tenantId, conversationId, messageId: stored.value.messageId, detail: traced.detail ?? '',
      });
    }
    clock.lap('trace');
    if (held === null || !deliverThis) {
      // Generated and deliberately not sent. The row stays `draft`, so the day the
      // channel goes live it is claimable rather than lost.
      fx.log('info', 'not_delivering', { tenantId, channelId, detail: !deliverThis && !delivery.deliver ? delivery.detail : '' });
      continue;
    }
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

    if (spoke !== null && spoke.replied === true) {
      // A person answered while we generated. Ours is dropped — `refused`, which is
      // terminal, so no redelivery re-sends it (`findReplyFor` reads it as answered) — and
      // counted, because a reply the bot chose not to send is otherwise a quiet afternoon.
      const refused = await markRefused(db, { id: held.id, tenantId, reason: 'human_replied_before_send' });
      if (!refused.ok) {
        // Not sent either way: the row stays `sending`, which nothing re-claims (`CLAIMABLE`
        // is draft and failed), and a redelivery finds it and skips. So no retry — a 503
        // would only re-run the entry to reach the same place. Logged, because a row left
        // `sending` is a row whose true state the table no longer says.
        fx.log('error', 'human_replied_refuse_failed', { outboundId: held.id, detail: refused.detail });
      }
      fx.log('info', 'human_replied_before_send', { tenantId, conversationId, outboundId: held.id, via: spoke.via });
      await fx.flagQuality({
        tenantId, conversationId, code: 'human_replied_before_send',
        detail: `reply not sent: ${spoke.detail}`,
      });
      continue;
    }
    if (spoke !== null && spoke.replied === 'unreadable') {
      // Sent anyway, as check 4 does on an unreadable thread: a read failure must not mute a
      // tenant. Logged so a run of these is visible.
      fx.log('error', 'human_reply_check_unreadable', { tenantId, conversationId, detail: spoke.detail });
    }

    // Read BEFORE the send: the question is whether the bubble could still land after it.
    const typingLate = typing !== null && !typingSettled;

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
      ...(tokenChannelId === undefined ? {} : { tokenChannelId }),
      ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
    });

    if (typingLate && typing !== null) {
      // After the send, so it costs the customer nothing. Bounded, and swallowed: it is a
      // decoration, and the lambda must not hang on it.
      await settleWithin(typing, TYPING_WAIT_MS);
      await settleWithin(
        fx.showTyping({ tenantId, channelId, recipientId: message.senderId, pageId, ...viaToken, action: 'typing_off' }).catch(() => {}),
        TYPING_WAIT_MS,
      );
      fx.log('info', 'typing_cleared_after_reply', { externalId: message.externalId });
    }

    // A complaint, a request for a person, or the handoff line: a person is told (Дали F5,
    // K4). On EVERY outcome, a retryable failure included: a redelivery re-sends the stored
    // row (`resumeStoredReply`) without regenerating and never reaches here, so this is the
    // one place a person is told. An attempt that died between the draft and this line (a
    // killed lambda, a claim that could not be read) is not alerted by the resume: it cannot
    // tell a complaint from the stored row. `once` per day keeps it to one page.
    const needs: NeedsPersonReason | null = outcome.complaint === true ? 'complaint'
      : outcome.handedOff === true ? 'handoff' : null;
    if (needs !== null) {
      await fx.alertNeedsPerson({
        tenantId, conversationId, reason: needs, provider,
        thread: { channelId, pageId, psid: message.senderId, ...viaToken },
        sent: delivered.outcome === 'sent' ? 'yes' : delivered.outcome === 'failed' && !delivered.retryable ? 'no' : 'unknown',
      });
    }

    if (delivered.outcome === 'sent') {
      sent.push(held.id);
      if (outcome.mediaHandoff === true) {
        // The customer has been told a person will look. Now the thread is theirs, for the
        // tenant's takeover cooldown as after any staff reply, and the founder is told.
        await handOffAfterNotice({ conversationId, externalId: message.externalId, text: message.text });
      }
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

  // --- A send that reached Meta is the only proof the credential works. ------------
  //
  // Founder's call, 2026-09-21: a successful send clears `tenant_channels.status`, and
  // nothing else does. `haltChannelOutbound` has written `authorization_error` since
  // §3.4.4 with nothing writing it back, so Matrix carried the flag from 02:25 while
  // fourteen messages sent successfully after it — D-064's shape, inverted.
  //
  // Placed HERE, after both surfaces, because either can be the proof: a DM reply and a
  // public comment reply go out on the same page token. Counting them together also makes
  // this at most ONE statement per job rather than one per message.
  //
  // Gated on `channelStatus` so a healthy channel issues no statement at all — the read
  // was free, the write would not be, and this sits on the path whose latency is the whole
  // open question against the ancestor.
  if (channelStatus === CREDENTIAL_FAILURE_STATUS
      && (sent.length > 0 || (commentResult?.replied ?? 0) > 0)) {
    const recovered = await clearCredentialFailure(db, { tenantId, channelId });
    if (!recovered.ok) {
      // Never fatal. The customer has the message; bookkeeping cannot be allowed to undo
      // that or to fail the job — the same posture as `send_bookkeeping_failed` above.
      fx.log('error', 'channel_recovery_failed', { tenantId, channelId, detail: recovered.detail });
    } else if (recovered.cleared) {
      fx.log('info', 'channel_recovered', {
        tenantId, channelId, from: CREDENTIAL_FAILURE_STATUS,
        dmSends: sent.length, commentReplies: commentResult?.replied ?? 0,
      });
    }
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
  // The two sub-phases ride alongside the twelve. `context_load` is the largest database
  // phase and is two stages with completely different shapes; splitting it here is what
  // lets the next real turn say whether there is anything to win, instead of another
  // reasoned guess. Absent when the context never loaded — an unreadable split and a
  // split of zero are different facts (D-070).
  fx.log('info', 'reply_timing_ms', {
    eventId, tenantId, ...clock.phases,
    ...(contextTimings === null ? {} : {
      context_snapshot: contextTimings.snapshot,
      context_batch: contextTimings.batch,
    }),
  });
  await markEventState(db, eventId, 'processed', drafted.length > 0 ? now : undefined);
  return ok({
    eventId, drafted: drafted.length, sent: sent.length, stale: stale.length, skipped: skipSummary(skipped),
    notGenerated: notGenerated.length,
    ...(commentResult === null ? {} : { comments: commentResult }),
  });
}

/**
 * Has this conversation already been sent the hand-off line since `since` (D-160)? By body,
 * so a hand-off the model path served earlier that day counts too. `unreadable` is reported
 * to the caller, which logs it and sends.
 */
async function handoffSaidToday(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; body: string; since: Date },
): Promise<'yes' | 'no' | 'unreadable'> {
  const { data, error } = await db
    .from('outbound_messages')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('conversation_id', input.conversationId)
    .eq('kind', 'reply')
    .eq('body', input.body)
    .in('state', ['sending', 'sent', 'indeterminate'])
    .gte('created_at', input.since.toISOString())
    .limit(1);
  if (error) return 'unreadable';
  return Array.isArray(data) && data.length > 0 ? 'yes' : 'no';
}
