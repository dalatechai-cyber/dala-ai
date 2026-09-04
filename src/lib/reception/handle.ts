/**
 * The reception flow: everything between "the chokepoint said yes" and "there is a reply
 * row ready to send".
 *
 * Every part of this has been built and merged separately — the meter, the guard, the
 * compiler, the model call, the claim. **Nothing called any of them.** This is the
 * function that does, and it is deliberately the last piece rather than the first:
 * each step was provably correct on its own before anything could reach it.
 *
 * ## It takes its inputs, it does not fetch them
 *
 * No database reads happen here. The route loads the snapshot, the rules, the canned
 * lines and the tenant view, and hands them over; the model call arrives as a function.
 * That is what makes the decision logic testable in full — every branch below is a
 * question about *what to do*, and none of them is entangled with *how to find out*.
 *
 * ## The order is the design, again
 *
 *   stale? → match → canned lines reviewed? → short-circuit? → mark called → call →
 *   settle → guard → draft
 *
 * Three of those come **before** the model call and each can end the request for free:
 * a stale event, an unparseable matcher, an unreviewed canned line. The cheapest refusals
 * are first, and none of them costs a token.
 */
import type { CallOutcome, ReceptionRequest } from '../model/reception.ts';
import { isStale } from '../model/reception.ts';
import type { Usage } from '../spend/settle.ts';
import { matchRules, renderCannedSection, type CannedRow, type GateRule } from '../gate/match.ts';
import { outboundGuard, type TenantGuardView } from '../guard/outbound.ts';
import { capToSingleMessage } from '../mn/text.ts';

/** One Messenger send, in characters. */
export const MAX_REPLY_CHARS = 1900;

export type ReceptionDeps = {
  callModel: (req: ReceptionRequest) => Promise<CallOutcome>;
  /** Store the reply exactly once per dedup key. Returns the row id. */
  draft: (input: { body: string; answeredBy: 'model' | 'canned' }) => Promise<{ ok: true; id: string } | { ok: false; detail: string }>;
  /** Mark the reservation called, immediately before the provider call. */
  markCalled: () => Promise<boolean>;
  /** Record what was actually spent, with the real usage block. */
  settle: (usage: Usage, modelId: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Give an unused hold straight back. */
  release: () => Promise<void>;
  /** Record a guard refusal or a terminal model outcome for the Quality layer. */
  flag: (input: { code: string; detail: string; attempted?: string }) => Promise<void>;
};

export type ReceptionInput = {
  customerMessage: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  eventAt: Date;
  now: Date;
  /** The compiled, byte-stable prefix. */
  promptStable: string;
  /** L4, per request, never cached. */
  promptVolatile: string;
  modelId: string;
  cacheMode: 'off' | '5m' | '1h';
  timeoutMs: number;
  rules: readonly GateRule[];
  canned: readonly CannedRow[];
  tenantGuard: TenantGuardView;
  /** Label for the pinned-line section the gate's blocks point into. */
  cannedLabel: string;
};

export type ReceptionOutcome =
  /** A reply row exists and is ready for the send path. */
  | { kind: 'drafted'; outboundId: string; answeredBy: 'model' | 'canned'; refusal?: string }
  /** Could not determine something. The caller must 503 so QStash retries. */
  | { kind: 'retry'; detail: string }
  /** Determinate and unanswerable. ACK and stop; retrying cannot change it. */
  | { kind: 'dropped'; reason: string };

/** The tenant's pinned line for a kind, or null when it is not provisioned. */
function canned(rows: readonly CannedRow[], kind: string): string | null {
  const row = rows.find((r) => r.kind === kind);
  return row === undefined || row.reviewedAt === null ? null : row.body;
}

/**
 * Fall back to the tenant's handoff line.
 *
 * Used for every outcome where the model's own text must not be sent: a safety refusal, a
 * truncated reply, an empty one, or a guard refusal. **Never silence** — §5.7's ladder is
 * explicit that even a spent budget answers with something, and a customer who gets
 * nothing does not know whether anyone is there.
 *
 * If the handoff line itself is missing or unreviewed, that is a provisioning failure and
 * the request retries rather than inventing a sentence.
 */
async function handoff(
  deps: ReceptionDeps,
  input: ReceptionInput,
  reason: { code: string; detail: string; attempted?: string },
): Promise<ReceptionOutcome> {
  const line = canned(input.canned, 'handoff');
  if (line === null) {
    return { kind: 'retry', detail: `no reviewed handoff line: cannot answer ${reason.code}` };
  }
  await deps.flag(reason);
  const drafted = await deps.draft({ body: line, answeredBy: 'canned' });
  if (!drafted.ok) return { kind: 'retry', detail: drafted.detail };
  return { kind: 'drafted', outboundId: drafted.id, answeredBy: 'canned', refusal: reason.code };
}

export async function handleReception(
  deps: ReceptionDeps,
  input: ReceptionInput,
): Promise<ReceptionOutcome> {
  // ---- Free refusals, all three before a token is spent -------------------

  // 1. Older than the messaging window allows. Dropping costs nothing; generating a
  //    reply nobody can receive costs a full call.
  if (isStale(input.eventAt, input.now)) {
    await deps.release();
    return { kind: 'dropped', reason: 'stale_event' };
  }

  // 2. Which gates fired. An unparseable matcher refuses the whole match rather than
  //    being skipped — a silently disarmed refusal is the failure this platform keeps
  //    finding.
  const matched = matchRules(input.customerMessage, input.rules);
  if (!matched.ok) {
    await deps.release();
    return { kind: 'retry', detail: `matcher unusable: ${matched.detail}` };
  }

  // 3. Every pinned line has a native-speaker sign-off. A gate pointing at an unreviewed
  //    sentence is a check with no answer.
  const section = renderCannedSection(input.cannedLabel, input.canned);
  if (!section.ok) {
    await deps.release();
    return { kind: 'retry', detail: `canned_response_unreviewed: ${section.kinds.join(', ')}` };
  }

  // 4. The opt-in short-circuit: answer from a row, with no model call at all. Off by
  //    default per topic per tenant; only a measured precision run turns it on.
  if (matched.shortCircuitKind !== null) {
    const line = canned(input.canned, matched.shortCircuitKind);
    if (line === null) {
      await deps.release();
      return { kind: 'retry', detail: `short-circuit names ${matched.shortCircuitKind}, which is missing or unreviewed` };
    }
    await deps.release();   // nothing was spent, so the hold goes straight back
    const drafted = await deps.draft({ body: line, answeredBy: 'canned' });
    return drafted.ok
      ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'canned' }
      : { kind: 'retry', detail: drafted.detail };
  }

  // ---- The point of no return --------------------------------------------

  // The CHECK on spend_reservations requires provider_call_started_at for state 'called',
  // so a reservation cannot claim to have been called without recording when. On a
  // redelivery, a reservation already in 'called' says the provider may have been reached
  // even if we never saw the response.
  if (!(await deps.markCalled())) {
    await deps.release();
    return { kind: 'retry', detail: 'could not mark the reservation called' };
  }

  const result = await deps.callModel({
    modelId: input.modelId,
    promptStable: input.promptStable,
    promptVolatile: `${input.promptVolatile}\n${section.body}`.trim(),
    cacheMode: input.cacheMode,
    history: input.history,
    customerMessage: input.customerMessage,
    timeoutMs: input.timeoutMs,
  });

  // ---- Settle first. The money is spent whatever happens next. ------------

  if (result.kind === 'retryable') {
    // The reservation stays in 'called' rather than being released: we do not know
    // whether tokens were consumed, and releasing would give back a hold that may have
    // been spent. The expiry sweep is what reconciles it — an unknown is parked, not
    // guessed, exactly as `indeterminate` is on the outbound side.
    return { kind: 'retry', detail: `${result.reason}: ${result.detail}` };
  }

  if (result.usage !== undefined) {
    const settled = await deps.settle(result.usage, input.modelId);
    // A bookkeeping failure must NOT refuse the customer's reply: the money is already
    // spent and they are owed the answer. It alerts instead — `ledger_deadletter` exists
    // for exactly this.
    if (!settled.ok) await deps.flag({ code: 'ledger_deadletter', detail: settled.detail });
  }

  // ---- Terminal model outcomes: never send the model's own text -----------

  if (result.kind === 'terminal') {
    // `max_tokens` in particular may leave a truncated Mongolian half-sentence, and
    // `refusal` arrives as HTTP 200 with a plausible-looking body.
    return handoff(deps, input, { code: `model_${result.reason}`, detail: result.detail });
  }

  // ---- The guard, then the draft ------------------------------------------

  const guarded = outboundGuard(
    input.tenantGuard,
    {
      firedGates: matched.firedGates,
      refusedTopicBlocksPrice: matched.refusedTopicBlocksPrice,
      customerText: input.customerMessage,
    },
    result.text,
  );

  if (!guarded.ok) {
    // The full attempted reply goes to the Quality layer. It is never edited and never
    // sent — an edited reply is an unreviewed reply.
    return handoff(deps, input, { code: guarded.code, detail: guarded.detail, attempted: result.text });
  }

  // One atomic send, capped in characters. A reply with no sentence boundary in reach
  // returns null rather than a half-sentence, and falls back like any other failure.
  const closing = canned(input.canned, 'closing') ?? '';
  const capped = capToSingleMessage(result.text, MAX_REPLY_CHARS, closing);
  if (capped === null) {
    return handoff(deps, input, { code: 'outbound_length', detail: 'no sentence boundary within the cap', attempted: result.text });
  }

  const drafted = await deps.draft({ body: capped.text, answeredBy: 'model' });
  return drafted.ok
    ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'model' }
    : { kind: 'retry', detail: drafted.detail };
}
